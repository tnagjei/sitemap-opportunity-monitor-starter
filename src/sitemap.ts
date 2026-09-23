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
    const isRoot = sitemapUrl === rootUrl;

    let xml: string;
    let parsed: ParsedSitemap;
    try {
      xml = await fetchSitemap(sitemapUrl);
      parsed = parseSitemapXml(xml);
    } catch (error) {
      if (isRoot) throw error;
      console.error("跳过无法获取或解析的子 Sitemap", sitemapUrl, error instanceof Error ? error.message : String(error));
      continue;
    }

    if (parsed.kind === "index") {
      for (const child of parsed.locations) {
        if (!visited.has(child)) queue.push(child);
      }
      continue;
    }

    if (parsed.kind === "urlset") {
      for (const pageUrl of parsed.locations) pageUrls.add(new URL(pageUrl).toString());
      continue;
    }

    if (isRoot) {
      throw new Error(`无法识别 Sitemap XML 类型: ${sitemapUrl}`);
    }
    console.error("跳过无法识别的子 Sitemap", sitemapUrl);
  }

  return Array.from(pageUrls).sort();
}

export function findNewUrls(current: string[], previous: string[]): string[] {
  const oldSet = new Set(previous);
  return current.filter((url) => !oldSet.has(url));
}

export function filterUrlsByPrefix(urls: string[], prefix: string): string[] {
  return urls.filter((url) => {
    if (!url.startsWith(prefix)) return false;
    // ponytail: PMKG needs its numeric detail-page rule; add configurable matchers only when another source needs one.
    return prefix !== "https://www.pmkg.net/sites/" || /^https?:\/\/[^/]+\/sites\/\d+\.html(?:$|[?#])/.test(url);
  });
}

export const NON_ENGLISH_LANGS = new Set([
  "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "es", "eu", "fa", "fi", "fil", "fr",
  "gl", "he", "hi", "hr", "hu", "id", "it", "iw", "ja", "ko", "mr", "ms", "nb", "nl",
  "nn", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th",
  "tl", "tr", "uk", "ur", "vi", "zh",
]);

export function parseLangPrefix(segment: string): { isLang: boolean; isEnglish: boolean; lang: string } | null {
  const lower = segment.toLowerCase();
  if (lower === "en" || /^en(-[a-z0-9]{2,4})?$/i.test(lower)) {
    return { isLang: true, isEnglish: true, lang: lower };
  }
  const base = lower.split("-")[0] ?? "";
  if (NON_ENGLISH_LANGS.has(lower) || NON_ENGLISH_LANGS.has(base)) {
    return { isLang: true, isEnglish: false, lang: lower };
  }
  return null;
}

export interface UrlLanguageInfo {
  url: string;
  isNonEnglish: boolean;
  lang?: string;
  normalizedKey: string;
}

export function extractUrlLanguage(url: string): UrlLanguageInfo {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const firstPart = parts[0];
    const langInfo = firstPart ? parseLangPrefix(firstPart) : null;

    if (!langInfo) {
      const normalizedPath = "/" + parts.join("/");
      return {
        url,
        isNonEnglish: false,
        normalizedKey: parsed.origin + (normalizedPath.replace(/\/+$/, "") || "/"),
      };
    }

    const remainingParts = langInfo.isLang ? parts.slice(1) : parts;
    const normalizedPath = "/" + remainingParts.join("/");
    return {
      url,
      isNonEnglish: !langInfo.isEnglish,
      lang: langInfo.lang,
      normalizedKey: parsed.origin + (normalizedPath.replace(/\/+$/, "") || "/"),
    };
  } catch {
    return {
      url,
      isNonEnglish: false,
      normalizedKey: url,
    };
  }
}

export const LANG_NAMES: Record<string, string> = {
  de: "德语",
  es: "西班牙语",
  fr: "法语",
  it: "意大利语",
  pt: "葡萄牙语",
  nl: "荷兰语",
  pl: "波兰语",
  sv: "瑞典语",
  da: "丹麦语",
  fi: "芬兰语",
  ja: "日语",
  ko: "韩语",
  zh: "中文",
  ar: "阿拉伯语",
  ru: "俄语",
  vi: "越南语",
  id: "印尼语",
  th: "泰语",
  hi: "印地语",
  tr: "土耳其语",
  en: "英语",
};

export function getLanguageName(lang?: string): string {
  if (!lang) return "未知语言";
  const base = lang.toLowerCase().split("-")[0] ?? "";
  return LANG_NAMES[base] || lang;
}

export function detectSitePrimaryLanguage(sampleUrls: string[]): {
  primaryLanguage: string;
  isPureMinorityLanguageSite: boolean;
} {
  if (sampleUrls.length === 0) {
    return { primaryLanguage: "en", isPureMinorityLanguageSite: false };
  }

  let hasEnglish = false;
  const langCounts = new Map<string, number>();

  for (const url of sampleUrls) {
    const info = extractUrlLanguage(url);
    if (!info.isNonEnglish) {
      hasEnglish = true;
    } else if (info.lang) {
      const base = info.lang.split("-")[0] ?? info.lang;
      langCounts.set(base, (langCounts.get(base) ?? 0) + 1);
    }
  }

  if (hasEnglish) {
    return { primaryLanguage: "en", isPureMinorityLanguageSite: false };
  }

  let dominantLang = "en";
  let maxCount = 0;
  for (const [lang, count] of langCounts) {
    if (count > maxCount) {
      maxCount = count;
      dominantLang = lang;
    }
  }

  return {
    primaryLanguage: dominantLang,
    isPureMinorityLanguageSite: dominantLang !== "en",
  };
}

export interface PartitionOptions {
  targetLang?: string;
  allUrls?: string[];
}

export interface PartitionedUrls {
  englishUrls: string[];
  skippedNonEnglishUrls: string[];
  variantsByUrl: Map<string, string[]>;
  unmatchedNonEnglishUrls: string[];
  primaryLanguage: string;
  isPureMinorityLanguageSite?: boolean;
}

export function partitionLanguageUrls(urls: string[], options?: PartitionOptions): PartitionedUrls {
  const targetLangConfig = options?.targetLang?.toLowerCase();

  if (targetLangConfig === "all") {
    return {
      englishUrls: [...urls],
      skippedNonEnglishUrls: [],
      variantsByUrl: new Map(),
      unmatchedNonEnglishUrls: [],
      primaryLanguage: "all",
      isPureMinorityLanguageSite: false,
    };
  }

  let resolvedLang = targetLangConfig && targetLangConfig !== "auto" ? targetLangConfig : undefined;
  let isPureMinority = false;

  if (!resolvedLang) {
    const detectScope = options?.allUrls && options.allUrls.length > 0 ? options.allUrls : urls;
    const detected = detectSitePrimaryLanguage(detectScope);
    resolvedLang = detected.primaryLanguage;
    isPureMinority = detected.isPureMinorityLanguageSite;
  } else {
    isPureMinority = resolvedLang !== "en";
  }

  const englishUrls: string[] = [];
  const skippedNonEnglishUrls: string[] = [];
  const variantsByUrl = new Map<string, string[]>();
  const unmatchedNonEnglishUrls: string[] = [];
  const keyToTargetUrl = new Map<string, string>();

  const infos = urls.map(extractUrlLanguage);

  for (const info of infos) {
    const isTarget = resolvedLang === "en"
      ? !info.isNonEnglish
      : (info.lang === resolvedLang || (info.lang && info.lang.split("-")[0] === resolvedLang));

    if (isTarget) {
      englishUrls.push(info.url);
      keyToTargetUrl.set(info.normalizedKey, info.url);
      if (!variantsByUrl.has(info.url)) {
        variantsByUrl.set(info.url, []);
      }
    }
  }

  for (const info of infos) {
    const isTarget = resolvedLang === "en"
      ? !info.isNonEnglish
      : (info.lang === resolvedLang || (info.lang && info.lang.split("-")[0] === resolvedLang));

    if (!isTarget) {
      skippedNonEnglishUrls.push(info.url);
      const targetUrl = keyToTargetUrl.get(info.normalizedKey);
      if (targetUrl && info.lang) {
        const variants = variantsByUrl.get(targetUrl) ?? [];
        if (!variants.includes(info.lang)) variants.push(info.lang);
        variantsByUrl.set(targetUrl, variants);
      } else {
        unmatchedNonEnglishUrls.push(info.url);
      }
    }
  }

  return {
    englishUrls,
    skippedNonEnglishUrls,
    variantsByUrl,
    unmatchedNonEnglishUrls,
    primaryLanguage: resolvedLang,
    isPureMinorityLanguageSite: isPureMinority,
  };
}
