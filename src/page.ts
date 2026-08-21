import { buildKeywordCandidates, stripTags } from "./keywords";
import type { ExternalPageAnalysis, PageAnalysis } from "./types";

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
    const externalUrl = analyzeLinkedSite ? extractExternalUrl(html) : undefined;
    return {
      url,
      status: response.status,
      ...fields,
      keywords: buildKeywordCandidates(url, fields.title, fields.h1),
      external: externalUrl ? await analyzeExternalPage(externalUrl) : undefined,
    };
  } catch (error) {
    return {
      url,
      status: null,
      title: "",
      h1: "",
      description: "",
      keywords: buildKeywordCandidates(url, "", ""),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
