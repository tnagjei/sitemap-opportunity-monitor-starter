import { buildKeywordCandidates, slugKeyword, stripTags, urlSlug } from "./keywords";
import type { ExternalPageAnalysis, PageAnalysis, StoreProduct } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function firstMatch(html: string, pattern: RegExp): string {
  return stripTags(pattern.exec(html)?.[1] ?? "");
}

function extractMetaDescription(html: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/\bname\s*=\s*["']description["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([\s\S]*?)["']/i.exec(tag)?.[1] ?? "";
    if (content) return stripTags(content);
  }
  return "";
}

export function extractPageFields(html: string): {
  title: string;
  h1: string;
  description: string;
} {
  return {
    title: firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i),
    h1: firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i),
    description: extractMetaDescription(html),
  };
}

export function extractExternalUrl(html: string): string | undefined {
  const encoded = /href=["']https?:\/\/www\.pmkg\.net\/go\/\?url=([^&"']+)/i.exec(html)?.[1];
  if (!encoded) return undefined;

  try {
    const decoded = atob(decodeURIComponent(encoded));
    return /^https?:\/\//i.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function extractCreemExternalUrl(html: string): string | undefined {
  const h1End = html.search(/<\/h1>/i);
  if (h1End < 0) return undefined;
  const productStart = html.search(/href=["']https?:\/\/(?:www\.)?creem\.io\/product\//i);
  const header = html.slice(h1End, productStart > h1End ? productStart : h1End + 5_000);

  for (const match of header.matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1] ?? "";
    if (!/\btarget=["']_blank["']/i.test(attributes)) continue;
    const href = /\bhref=["'](https?:\/\/[^"']+)["']/i.exec(attributes)?.[1];
    if (!href) continue;
    try {
      const url = new URL(href);
      if (url.hostname === "creem.io" || url.hostname.endsWith(".creem.io")) continue;
      return url.toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

export function extractCreemProducts(html: string): StoreProduct[] {
  const products: StoreProduct[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*href=["'](https?:\/\/(?:www\.)?creem\.io\/product\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(pattern)) {
    const url = match[1] ?? "";
    const body = match[2] ?? "";
    if (!url || seen.has(url)) continue;
    const name = firstMatch(body, /<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const price = firstMatch(body, />\s*Price\s*<\/span>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i);
    if (!name) continue;
    seen.add(url);
    products.push({ name, price: price || "未提供（页面未解析到）", url });
  }

  return products;
}

async function analyzeExternalPage(url: string): Promise<ExternalPageAnalysis> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      return { url, status: response.status, title: "", h1: "", description: "", error: `页面请求失败 ${response.status}` };
    }
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return { url, status: response.status, title: "", h1: "", description: "", error: `不是 HTML 页面: ${contentType || "未知类型"}` };
    }
    return { url, status: response.status, ...extractPageFields(await response.text()) };
  } catch (error) {
    return { url, status: null, title: "", h1: "", description: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function analyzePage(url: string, analyzeLinkedSite = false): Promise<PageAnalysis> {
  const slug = urlSlug(url);
  const keyword = slugKeyword(url);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      return {
        url,
        slug,
        keyword,
        status: response.status,
        title: "",
        h1: "",
        description: "",
        keywords: buildKeywordCandidates(url, "", ""),
        error: `页面请求失败 ${response.status}`,
      };
    }

    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return {
        url,
        slug,
        keyword,
        status: response.status,
        title: "",
        h1: "",
        description: "",
        keywords: buildKeywordCandidates(url, "", ""),
        error: `不是 HTML 页面: ${contentType || "未知类型"}`,
      };
    }

    const html = await response.text();
    const fields = extractPageFields(html);
    const parsedUrl = new URL(url);
    const isCreemStore =
      (parsedUrl.hostname === "creem.io" || parsedUrl.hostname === "www.creem.io") &&
      parsedUrl.pathname.startsWith("/stores/");
    const externalUrl = analyzeLinkedSite
      ? isCreemStore
        ? extractCreemExternalUrl(html)
        : extractExternalUrl(html)
      : undefined;
    return {
      url,
      slug,
      keyword,
      status: response.status,
      ...fields,
      keywords: buildKeywordCandidates(url, fields.title, fields.h1),
      external: externalUrl ? await analyzeExternalPage(externalUrl) : undefined,
      products: isCreemStore ? extractCreemProducts(html) : undefined,
    };
  } catch (error) {
    return {
      url,
      slug,
      keyword,
      status: null,
      title: "",
      h1: "",
      description: "",
      keywords: buildKeywordCandidates(url, "", ""),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
