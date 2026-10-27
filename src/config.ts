import type { Env, MonitoredSite, TrendKeywordConfig } from "./types";

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseSites(env: Env): MonitoredSite[] {
  let raw: unknown;
  try {
    raw = JSON.parse(env.MONITORED_SITEMAPS);
  } catch {
    throw new Error("MONITORED_SITEMAPS 不是合法 JSON");
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("MONITORED_SITEMAPS 至少需要一个监控对象");
  }

  const ids = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`第 ${index + 1} 个监控对象格式错误`);
    }
    const candidate = item as Record<string, unknown>;
    const id = String(candidate.id ?? "").trim();
    const name = String(candidate.name ?? "").trim();
    const url = String(candidate.url ?? "").trim();
    const pathPrefix = String(candidate.pathPrefix ?? "").trim() || undefined;
    const focusPathPrefix = String(candidate.focusPathPrefix ?? "").trim() || undefined;
    const analyzeLinkedSite = candidate.analyzeLinkedSite === true;
    const primaryLanguage = candidate.primaryLanguage
      ? String(candidate.primaryLanguage).trim().toLowerCase()
      : undefined;
    if (primaryLanguage && primaryLanguage !== "all" && !/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(primaryLanguage)) {
      throw new Error(`监控对象 ${id} 的 primaryLanguage 不合法: ${primaryLanguage}`);
    }

    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(id)) {
      throw new Error(`监控对象 id 不合法: ${id || "空"}`);
    }
    if (ids.has(id)) {
      throw new Error(`监控对象 id 重复: ${id}`);
    }
    ids.add(id);

    if (!name) throw new Error(`监控对象 ${id} 缺少 name`);
    const parsedUrl = new URL(url);
    if (!/^https?:$/.test(parsedUrl.protocol)) {
      throw new Error(`监控对象 ${id} 的 URL 必须是 HTTP 或 HTTPS`);
    }
    if (pathPrefix) {
      const parsedPrefix = new URL(pathPrefix);
      if (!/^https?:$/.test(parsedPrefix.protocol)) {
        throw new Error(`监控对象 ${id} 的 pathPrefix 必须是 HTTP 或 HTTPS`);
      }
    }
    if (focusPathPrefix && !/^https?:\/\//.test(focusPathPrefix)) {
      throw new Error(`监控对象 ${id} 的 focusPathPrefix 必须是 HTTP 或 HTTPS`);
    }
    return { id, name, url: parsedUrl.toString(), pathPrefix, focusPathPrefix, analyzeLinkedSite, primaryLanguage };
  });
}

export function parseTrendKeywords(env: Env): TrendKeywordConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(env.TRENDS_KEYWORDS);
  } catch {
    throw new Error("TRENDS_KEYWORDS 不是合法 JSON");
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("TRENDS_KEYWORDS 至少需要一个关键词");
  }

  const normalizedKeywords = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`第 ${index + 1} 个关键词格式错误`);
    }
    const candidate = item as Record<string, unknown>;
    const keyword = String(candidate.keyword ?? "").trim();
    const geo = String(candidate.geo ?? "").trim();

    if (!keyword || keyword.length > 100) {
      throw new Error(`第 ${index + 1} 个关键词为空或超过 100 字符`);
    }
    // 去重口径要和快照键 trendKeywordKey 一致：同一个词可以按 geo 分开监控。
    const normalized = geo ? `${keyword.toLowerCase()}|${geo.toLowerCase()}` : keyword.toLowerCase();
    if (normalizedKeywords.has(normalized)) {
      throw new Error(`关键词重复: ${keyword}${geo ? `（geo=${geo}）` : ""}`);
    }
    normalizedKeywords.add(normalized);

    if (geo && !/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(geo)) {
      throw new Error(`关键词 ${keyword} 的 geo 不合法: ${geo}`);
    }
    return { keyword, geo: geo || undefined };
  });
}
