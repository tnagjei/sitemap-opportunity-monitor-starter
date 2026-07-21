import type { Env, MonitoredSite } from "./types";

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
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
    return { id, name, url: parsedUrl.toString() };
  });
}
