import { extractExternalUrl } from "./page";

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
  SiteName?: string;
  Engagments?: { Visits?: string };
  TrafficSources?: { Search?: number; Direct?: number };
  DateData?: { registration?: string };
  TopKeywords?: Array<{ Name?: string; Volume?: number }>;
}

export interface TrafficAssessment {
  qualified: boolean;
  visits: number;
  searchShare: number;
  directShare: number;
  registrationDate: string;
  nonBrandKeywords: Array<{ name: string; volume: number }>;
}

export interface AitdkProcessedResult {
  listingUrl: string;
  domain?: string;
  cached: boolean;
  assessment?: TrafficAssessment;
  costCredits?: number;
  remainingCredits?: number;
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
const CACHE_PREFIX = "aitdk:domain:";
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
    estimatedCredits: uniqueUrls.length * 2,
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
  const visits = Number(data.Engagments?.Visits ?? 0);
  const searchShare = Number(data.TrafficSources?.Search ?? 0);
  const directShare = Number(data.TrafficSources?.Direct ?? 0);
  const registrationDate = data.DateData?.registration ?? "";
  const registeredAt = Date.parse(registrationDate);
  const ageDays = Number.isFinite(registeredAt) ? (now.getTime() - registeredAt) / 86_400_000 : Number.POSITIVE_INFINITY;
  const brandTokens = new Set([...normalizedTokens(domain), ...normalizedTokens(data.SiteName ?? "")]);
  const nonBrandKeywords = (data.TopKeywords ?? [])
    .map((item) => ({ name: item.Name?.trim() ?? "", volume: Number(item.Volume ?? 0) }))
    .filter((item) => {
      if (!item.name) return false;
      const keyword = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
      return ![...brandTokens].some((token) => keyword.includes(token));
    });

  return {
    qualified: ageDays >= 0 && ageDays <= 365 && visits >= 3_000 && searchShare >= 0.2 && directShare >= 0.2,
    visits,
    searchShare,
    directShare,
    registrationDate,
    nonBrandKeywords,
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
    estimatedCredits: mergedUrls.length * 2,
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

async function discoverPmkgDomain(listingUrl: string): Promise<string | undefined> {
  const response = await fetch(listingUrl, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SitemapOpportunityMonitor/1.0)" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`PMKG 详情页请求失败 ${response.status}`);
  const externalUrl = extractExternalUrl(await response.text());
  return externalUrl ? normalizeDomain(externalUrl) : undefined;
}

async function queryTraffic(apiKey: string, domain: string): Promise<{
  data: TrafficData;
  costCredits: number;
  remainingCredits: number;
}> {
  const endpoint = new URL("https://api-hub.sitedata.dev/api/v1/traffic");
  endpoint.searchParams.set("domain", domain);
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  const payload = (await response.json()) as {
    code?: string;
    message?: string;
    data?: TrafficData & { costCredits?: number; remainingCredits?: number };
  };
  if (!response.ok || payload.code !== "ok" || !payload.data) {
    throw new Error(`SiteData Traffic API 失败 ${response.status}: ${payload.message ?? payload.code ?? "未知错误"}`);
  }
  return {
    data: payload.data,
    costCredits: Number(payload.data.costCredits ?? 0),
    remainingCredits: Number(payload.data.remainingCredits ?? 0),
  };
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
      const domain = await discoverPmkgDomain(listingUrl);
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
        remainingCredits: traffic.remainingCredits,
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
