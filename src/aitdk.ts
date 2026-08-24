import { extractCreemExternalUrl, extractExternalUrl } from "./page";

export type AitdkBatchStatus = "approved" | "pending_approval" | "completed";

export interface AitdkBatch {
  id: string;
  siteId: string;
  createdAt: string;
  status: AitdkBatchStatus;
  urls: string[];
  estimatedCredits: number;
  processedCount: number;
  queriedCount: number;
  skippedCount: number;
  failedCount: number;
  attempts: Record<string, number>;
}

export interface TrafficData {
  domain?: string;
  title?: string | null;
  description?: string | null;
  overview?: {
    global_rank?: number | null;
    country_rank?: { country: string; rank: number } | null;
    visits?: number | null;
    bounce_rate?: number | null;
    pages_per_visit?: number | null;
    time_on_site_seconds?: number | null;
    month?: string | null;
  };
  monthly_visits?: Array<{ month: string; visits: number }>;
  traffic_sources?: Record<string, number | null>;
  top_keywords?: Array<{ name: string; volume: number; cpc: number; estimated_value: number }>;
  top_regions?: Array<{ country: string; name: string; share: number }>;
  ai_traffic?: {
    trends: Array<{ name: string; history: Array<{ date: string; value: number }> }>;
  } | null;
  registrationDate?: string;
  registrationError?: string;
}

export interface TrafficAssessment {
  qualified: boolean;
  title: string;
  description: string;
  visits: number;
  globalRank: number | null;
  countryRank: { country: string; rank: number } | null;
  bounceRate: number | null;
  pagesPerVisit: number | null;
  timeOnSiteSeconds: number | null;
  reportingMonth: string;
  searchShare: number;
  directShare: number;
  trafficSources: Record<string, number | null>;
  monthlyVisits: Array<{ month: string; visits: number }>;
  topKeywords: Array<{ name: string; volume: number; cpc: number; estimatedValue: number }>;
  registrationDate: string;
  registrationError?: string;
  nonBrandKeywords: Array<{ name: string; volume: number; cpc: number; estimatedValue: number }>;
  topRegions: Array<{ country: string; name: string; share: number }>;
  aiTraffic: TrafficData["ai_traffic"];
}

export interface AitdkProcessedResult {
  listingUrl: string;
  domain?: string;
  cached: boolean;
  assessment?: TrafficAssessment;
  costCredits?: number;
  error?: string;
}

export interface AitdkQueueSummary {
  batchId?: string;
  batchStatus?: AitdkBatchStatus;
  queriedCount: number;
  skippedCount: number;
  failedCount: number;
  remainingUrls: number;
  results: AitdkProcessedResult[];
}

const BATCH_PREFIX = "aitdk:batch:";
const CACHE_PREFIX = "aitdk:tabapi:domain:";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export function createAitdkBatch(siteId: string, urls: string[], now = new Date()): AitdkBatch {
  const uniqueUrls = [...new Set(urls)];
  const date = new Date(now.getTime() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  return {
    id: `${siteId}-${date}`,
    siteId,
    createdAt: now.toISOString(),
    status: uniqueUrls.length <= 20 ? "approved" : "pending_approval",
    urls: uniqueUrls,
    estimatedCredits: uniqueUrls.length * 4,
    processedCount: 0,
    queriedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    attempts: {},
  };
}

function normalizedTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.[a-z0-9-]+$/, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

export function assessTraffic(domain: string, data: TrafficData, now = new Date()): TrafficAssessment {
  const visits = Number(data.overview?.visits ?? 0);
  const searchShare = Number(data.traffic_sources?.search ?? 0);
  const directShare = Number(data.traffic_sources?.direct ?? 0);
  const registrationDate = data.registrationDate ?? "";
  const registeredAt = Date.parse(registrationDate);
  const ageDays = Number.isFinite(registeredAt) ? (now.getTime() - registeredAt) / 86_400_000 : Number.POSITIVE_INFINITY;
  const brandTokens = new Set([...normalizedTokens(domain), ...normalizedTokens(data.title ?? "")]);
  const topKeywords = (data.top_keywords ?? []).map((item) => ({
    name: item.name.trim(),
    volume: Number(item.volume ?? 0),
    cpc: Number(item.cpc ?? 0),
    estimatedValue: Number(item.estimated_value ?? 0),
  }));
  const nonBrandKeywords = topKeywords
    .filter((item) => {
      if (!item.name) return false;
      const keyword = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
      return ![...brandTokens].some((token) => keyword.includes(token));
    });

  return {
    qualified: ageDays >= 0 && ageDays <= 365 && visits >= 3_000 && searchShare >= 0.2 && directShare >= 0.2,
    title: data.title ?? "",
    description: data.description ?? "",
    visits,
    globalRank: data.overview?.global_rank ?? null,
    countryRank: data.overview?.country_rank ?? null,
    bounceRate: data.overview?.bounce_rate ?? null,
    pagesPerVisit: data.overview?.pages_per_visit ?? null,
    timeOnSiteSeconds: data.overview?.time_on_site_seconds ?? null,
    reportingMonth: data.overview?.month ?? "",
    searchShare,
    directShare,
    trafficSources: data.traffic_sources ?? {},
    monthlyVisits: data.monthly_visits ?? [],
    topKeywords,
    registrationDate,
    registrationError: data.registrationError,
    nonBrandKeywords,
    topRegions: data.top_regions ?? [],
    aiTraffic: data.ai_traffic ?? null,
  };
}

function batchKey(id: string): string {
  return `${BATCH_PREFIX}${id}`;
}

export async function enqueueAitdkBatch(
  kv: KVNamespace,
  siteId: string,
  urls: string[],
  now = new Date(),
): Promise<AitdkBatch> {
  const incoming = createAitdkBatch(siteId, urls, now);
  const existing = await kv.get<AitdkBatch>(batchKey(incoming.id), "json");
  if (!existing) {
    await kv.put(batchKey(incoming.id), JSON.stringify(incoming));
    return incoming;
  }

  const mergedUrls = [...new Set([...existing.urls, ...incoming.urls])];
  const merged: AitdkBatch = {
    ...existing,
    status: mergedUrls.length <= 20 ? "approved" : "pending_approval",
    urls: mergedUrls,
    estimatedCredits: mergedUrls.length * 4,
  };
  await kv.put(batchKey(merged.id), JSON.stringify(merged));
  return merged;
}

export async function approveAitdkBatch(kv: KVNamespace, id: string): Promise<AitdkBatch> {
  const batch = await kv.get<AitdkBatch>(batchKey(id), "json");
  if (!batch) throw new Error(`AITDK 批次不存在: ${id}`);
  const approved = { ...batch, status: "approved" as const };
  await kv.put(batchKey(id), JSON.stringify(approved));
  return approved;
}

function normalizeDomain(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

async function discoverListingDomain(siteId: string, listingUrl: string): Promise<string | undefined> {
  const response = await fetch(listingUrl, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SitemapOpportunityMonitor/1.0)" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`目录详情页请求失败 ${response.status}`);
  const html = await response.text();
  const externalUrl = siteId === "creem"
    ? extractCreemExternalUrl(html)
    : extractExternalUrl(html);
  return externalUrl ? normalizeDomain(externalUrl) : undefined;
}

async function queryTraffic(apiKey: string, domain: string): Promise<{
  data: TrafficData;
  costCredits: number;
}> {
  const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  const endpoint = new URL(`https://tabapi.com/api/v1/domains/${encodeURIComponent(domain)}/traffic`);
  endpoint.searchParams.set("months", "3");
  const response = await fetch(endpoint, {
    headers,
  });
  const data = (await response.json()) as TrafficData & {
    error?: { code?: string; message?: string };
    message?: string;
  };
  if (!response.ok || !data.overview) {
    throw new Error(`TabAPI Traffic 失败 ${response.status}: ${data.error?.message ?? data.message ?? data.error?.code ?? "未知错误"}`);
  }

  let costCredits = data.monthly_visits?.length ?? 3;
  try {
    const rdapResponse = await fetch(`https://tabapi.com/api/v1/domains/${encodeURIComponent(domain)}/rdap`, { headers });
    const rdap = await rdapResponse.json().catch(() => ({})) as {
      events?: Array<{ eventAction?: string; eventDate?: string }>;
      error?: { code?: string; message?: string };
      message?: string;
    };
    if (rdapResponse.ok) {
      data.registrationDate = rdap.events?.find((event) => event.eventAction === "registration")?.eventDate ?? "";
      costCredits += 1;
    } else {
      data.registrationError = `TabAPI RDAP 失败 ${rdapResponse.status}: ${rdap.error?.message ?? rdap.message ?? rdap.error?.code ?? "未知错误"}`;
    }
  } catch (error) {
    data.registrationError = `TabAPI RDAP 请求失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { data, costCredits };
}

export async function processAitdkQueue(
  kv: KVNamespace,
  apiKey: string,
  limit = 20,
  now = new Date(),
): Promise<AitdkQueueSummary> {
  const listed = await kv.list({ prefix: BATCH_PREFIX });
  let batch: AitdkBatch | null = null;
  for (const key of listed.keys) {
    const candidate = await kv.get<AitdkBatch>(key.name, "json");
    if (candidate?.status === "approved" && candidate.urls.length > 0) {
      batch = candidate;
      break;
    }
  }

  if (!batch) {
    return { queriedCount: 0, skippedCount: 0, failedCount: 0, remainingUrls: 0, results: [] };
  }

  const selected = batch.urls.slice(0, limit);
  const remaining = batch.urls.slice(limit);
  const retryUrls: string[] = [];
  const results: AitdkProcessedResult[] = [];
  let queriedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const listingUrl of selected) {
    try {
      const domain = await discoverListingDomain(batch.siteId, listingUrl);
      if (!domain) {
        skippedCount += 1;
        results.push({ listingUrl, cached: false, error: "未提取到外部域名" });
        continue;
      }

      const cacheKey = `${CACHE_PREFIX}${encodeURIComponent(domain)}`;
      const cached = await kv.get<{ assessment: TrafficAssessment }>(cacheKey, "json");
      if (cached) {
        skippedCount += 1;
        results.push({ listingUrl, domain, cached: true, assessment: cached.assessment });
        continue;
      }

      const traffic = await queryTraffic(apiKey, domain);
      const assessment = assessTraffic(domain, traffic.data, now);
      await kv.put(
        cacheKey,
        JSON.stringify({ checkedAt: now.toISOString(), assessment, data: traffic.data }),
        { expirationTtl: CACHE_TTL_SECONDS },
      );
      queriedCount += 1;
      results.push({
        listingUrl,
        domain,
        cached: false,
        assessment,
        costCredits: traffic.costCredits,
      });
    } catch (error) {
      const attempts = (batch.attempts[listingUrl] ?? 0) + 1;
      batch.attempts[listingUrl] = attempts;
      const message = error instanceof Error ? error.message : String(error);
      if (attempts < 3) retryUrls.push(listingUrl);
      else failedCount += 1;
      results.push({ listingUrl, cached: false, error: `${message}（第 ${attempts} 次）` });
    }
  }

  batch.urls = [...remaining, ...retryUrls];
  batch.processedCount += selected.length - retryUrls.length;
  batch.queriedCount += queriedCount;
  batch.skippedCount += skippedCount;
  batch.failedCount += failedCount;
  if (batch.urls.length === 0) batch.status = "completed";
  await kv.put(batchKey(batch.id), JSON.stringify(batch));

  return {
    batchId: batch.id,
    batchStatus: batch.status,
    queriedCount,
    skippedCount,
    failedCount,
    remainingUrls: batch.urls.length,
    results,
  };
}
