import type { TrendKeywordConfig } from "./types";

const TRENDS_HOST = "https://trends.google.com";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
export const TRENDS_SPACING_MS = 1_500;
export const TRENDS_RETRY_DELAY_MS = 30_000;

/**
 * Google 只接受预设区间（now 7-d / today 1-m / today 3-m / today 12-m）。
 * 自定义日数（如 today 60-d）会返回 HTTP 400。近 30 天足以覆盖周环比需要的 14 天。
 */
export const TRENDS_TIME_RANGE = "today 1-m";

/** 线上前缀是 ")]}'" 后直接换行；带逗号的形式只在部分接口出现，两种都要剥离。 */
const guardPattern = /^\)\]\}',?\s*/;

/**
 * Google 对没有任何搜索量的长尾词会返回 HTTP 200 但 timelineData 为空，
 * 这是"查不到数据"而不是"取数失败"，调用方需要区别对待。
 */
export class TrendNoDataError extends Error {
  constructor(keyword: string) {
    super(`Google Trends 未返回可用数据点: ${keyword}`);
    this.name = "TrendNoDataError";
  }
}

interface ExploreTokenResponse {
  widgets?: Array<{
    // 线上接口这里返回的是对象，不是字符串；两者都兼容。
    request: string | Record<string, unknown>;
    token: string;
    type: string;
    id: string;
  }>;
}

interface MultilineResponse {
  default?: {
    timelineData?: Array<{
      time: string;
      value?: number[] | null;
      hasData?: boolean[] | null;
      isPartial?: boolean;
    }>;
  };
}

export interface TrendSeriesPoint {
  time: string; // Unix seconds
  value: number; // 0-100 relative interest
}

export interface TrendSeries {
  points: TrendSeriesPoint[];
  resolution: "daily" | "hourly";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip the `)]}',` XSS-guard prefix the unofficial Trends endpoints prepend to JSON. */
export function stripTrendsGuard(text: string): string {
  return text.replace(guardPattern, "");
}

export function parseTrendSeries(text: string, nowMs = Date.now(), keyword = ""): TrendSeries {
  const payload = JSON.parse(stripTrendsGuard(text)) as MultilineResponse;
  const timelineData = payload.default?.timelineData ?? [];
  // 今天这一天还没走完，不能计入周环比。按时间戳剔除，避免在 Google 已把今天标成
  // hasData=false 时又白剔掉昨天这个完整日。
  // ponytail: 日边界按 UTC 对齐（请求里 tz=0），换时区需要同步改这里。
  const todayStartSeconds = Math.floor(nowMs / 1000 / 86_400) * 86_400;
  const points: TrendSeriesPoint[] = [];
  for (const entry of timelineData) {
    const value = entry.value?.[0];
    if (value === null || value === undefined) continue;
    // Google 自己会标记还没走完的当天；没有该字段时按 UTC 日边界兜底。
    if (entry.isPartial === true) continue;
    if (Number(entry.time) >= todayStartSeconds) continue;
    // hasData=false 表示那天没有搜索量（长尾词很常见），按 0 计入。
    // 直接跳过会把周均值算成"只统计有流量的天"，既会让稀疏词假翻倍，也会因为凑不满 14 天整轮失败。
    points.push({ time: entry.time, value: entry.hasData?.[0] === false ? 0 : value });
  }
  if (points.length === 0) {
    throw new TrendNoDataError(keyword);
  }
  const first = points[0]!.time;
  const last = points[points.length - 1]!.time;
  const resolution: TrendSeries["resolution"] =
    Number(last) - Number(first) >= 10 * 86400 ? "daily" : "hourly";
  return { points, resolution };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Weekly stats over the trailing daily series. The series is assumed to end at
 * the last complete day: last7 = [t-7, t-1], prev7 = [t-14, t-8].
 */
export function computeTrendStats(series: TrendSeries): {
  last7Mean: number;
  prev7Mean: number;
} {
  const values = series.points.map((point) => point.value);
  if (values.length < 14) {
    throw new Error("Google Trends 数据不足 14 天，无法计算周环比");
  }
  return {
    last7Mean: mean(values.slice(-7)),
    prev7Mean: mean(values.slice(-14, -7)),
  };
}

export interface DoublingThresholds {
  noiseFloor: number;
  doublingFactor: number;
}

export interface DoublingEvaluation {
  status: "doubled" | "unchanged";
  multiple: number | null;
  last7Mean: number;
  prev7Mean: number;
}

export function detectDoubling(
  stats: { last7Mean: number; prev7Mean: number },
  thresholds: DoublingThresholds,
): DoublingEvaluation {
  const { last7Mean, prev7Mean } = stats;
  if (prev7Mean < thresholds.noiseFloor) {
    return { status: "unchanged", multiple: null, last7Mean, prev7Mean };
  }
  const multiple = last7Mean / prev7Mean;
  return {
    status: multiple >= thresholds.doublingFactor ? "doubled" : "unchanged",
    multiple,
    last7Mean,
    prev7Mean,
  };
}

async function fetchTrendsText(url: string, cookie: string, retryDelayMs: number): Promise<string> {
  const headers: Record<string, string> = {
    "user-agent": BROWSER_USER_AGENT,
    accept: "application/json, text/plain, */*",
  };
  if (cookie) headers.cookie = cookie;

  const response = await fetch(url, { headers, redirect: "follow" });
  if (response.status === 429 && retryDelayMs >= 0) {
    await sleep(retryDelayMs);
    const retry = await fetch(url, { headers, redirect: "follow" });
    if (!retry.ok) {
      throw new Error(`Google Trends 请求失败 ${retry.status}（已重试一次）: ${url}`);
    }
    return retry.text();
  }
  if (!response.ok) {
    throw new Error(`Google Trends 请求失败 ${response.status}: ${url}`);
  }
  return response.text();
}

/** Visit the Trends homepage first so Google issues an NID cookie for later API calls. */
export async function fetchNidCookie(): Promise<string> {
  const response = await fetch(`${TRENDS_HOST}/`, {
    headers: { "user-agent": BROWSER_USER_AGENT },
    redirect: "follow",
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/NID=[^;]+/);
  return match ? match[0] : "";
}

export async function fetchTrendSeries(
  keyword: string,
  geo: string | undefined,
  cookie: string,
  retryDelayMs = TRENDS_RETRY_DELAY_MS,
): Promise<TrendSeries> {
  const explorePayload = {
    comparisonItem: [{ keyword, geo: geo ?? "", time: TRENDS_TIME_RANGE }],
    category: 0,
    property: "",
  };
  const exploreUrl = new URL(`${TRENDS_HOST}/trends/api/explore`);
  exploreUrl.searchParams.set("hl", "en-US");
  exploreUrl.searchParams.set("tz", "0");
  exploreUrl.searchParams.set("req", JSON.stringify(explorePayload));

  const exploreText = await fetchTrendsText(exploreUrl.toString(), cookie, retryDelayMs);
  const explore = JSON.parse(stripTrendsGuard(exploreText)) as ExploreTokenResponse;
  const widget = explore.widgets?.find((item) => item.id === "TIMESERIES");
  if (!widget) {
    throw new Error(`Google Trends explore 未返回 TIMESERIES 组件: ${keyword}`);
  }

  const multilineUrl = new URL(`${TRENDS_HOST}/trends/api/widgetdata/multiline`);
  multilineUrl.searchParams.set("hl", "en-US");
  multilineUrl.searchParams.set("tz", "0");
  const widgetRequest = typeof widget.request === "string" ? widget.request : JSON.stringify(widget.request);
  multilineUrl.searchParams.set("req", widgetRequest);
  multilineUrl.searchParams.set("token", widget.token);

  const multilineText = await fetchTrendsText(multilineUrl.toString(), cookie, retryDelayMs);
  return parseTrendSeries(multilineText, Date.now(), keyword);
}

export interface TrendKeywordStats {
  keyword: string;
  geo?: string;
  last7Mean: number;
  prev7Mean: number;
  multiple: number | null;
  status: "doubled" | "unchanged";
}

export function evaluateTrendKeyword(
  config: TrendKeywordConfig,
  series: TrendSeries,
  thresholds: DoublingThresholds,
): TrendKeywordStats {
  const detection = detectDoubling(computeTrendStats(series), thresholds);
  return {
    keyword: config.keyword,
    geo: config.geo,
    last7Mean: detection.last7Mean,
    prev7Mean: detection.prev7Mean,
    multiple: detection.multiple,
    status: detection.status,
  };
}
