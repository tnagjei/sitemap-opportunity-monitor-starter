const USER_AGENT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export type SitemapKind = "index" | "urlset" | "unknown";

export interface ParsedSitemap {
  kind: SitemapKind;
  locations: string[];
}

export function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .trim();
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  const locations = Array.from(xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi))
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .filter(Boolean);

  const normalized = xml.toLowerCase();
  const kind: SitemapKind = normalized.includes("<sitemapindex")
    ? "index"
    : normalized.includes("<urlset")
      ? "urlset"
      : "unknown";

  return { kind, locations };
}

async function fetchSitemap(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/xml,text/xml,text/plain,*/*",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Sitemap 请求失败 ${response.status}: ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (url.endsWith(".gz") || contentType.includes("gzip")) {
    throw new Error(`暂不支持直接解析 gzip Sitemap: ${url}`);
  }

  return response.text();
}

export async function collectPageUrls(
  rootUrl: string,
  maxSitemaps = 50,
): Promise<string[]> {
  const queue = [rootUrl];
  const visited = new Set<string>();
  const pageUrls = new Set<string>();

  while (queue.length > 0) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    if (visited.size >= maxSitemaps) {
      throw new Error(`子 Sitemap 数量超过限制 ${maxSitemaps}`);
    }

    visited.add(sitemapUrl);
    const xml = await fetchSitemap(sitemapUrl);
    const parsed = parseSitemapXml(xml);

    if (parsed.kind === "index") {
      for (const child of parsed.locations) {
        if (!visited.has(child)) queue.push(child);
      }
      continue;
    }

    if (parsed.kind === "urlset") {
      for (const pageUrl of parsed.locations) pageUrls.add(pageUrl);
      continue;
    }

    throw new Error(`无法识别 Sitemap XML 类型: ${sitemapUrl}`);
  }

  return Array.from(pageUrls).sort();
}

export function findNewUrls(current: string[], previous: string[]): string[] {
  const oldSet = new Set(previous);
  return current.filter((url) => !oldSet.has(url));
}
