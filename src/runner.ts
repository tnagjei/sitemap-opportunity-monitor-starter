import { parsePositiveInt, parseSites } from "./config";
import { enqueueAitdkBatch, processAitdkQueue } from "./aitdk";
import {
  notifyAitdkBatch,
  notifyAitdkResults,
  notifyDailyMonitorCompleted,
  notifyDailyMonitorStarted,
  notifyError,
  notifyNoNewPages,
  notifySiteResult,
} from "./feishu";
import { analyzePage } from "./page";
import { collectPageUrls, filterUrlsByPrefix, findNewUrls } from "./sitemap";
import type { DailyMonitorQueue, Env, SiteRunResult, Snapshot } from "./types";

const DAILY_QUEUE_PREFIX = "monitor:daily:";
const QUEUE_TTL_SECONDS = 8 * 24 * 60 * 60;
const MAX_SITE_ATTEMPTS = 3;

function snapshotKey(siteId: string): string {
  return `snapshot:${siteId}`;
}

function chinaDate(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function dailyQueueKey(date: string): string {
  return `${DAILY_QUEUE_PREFIX}${date}`;
}

async function saveDailyQueue(kv: KVNamespace, queue: DailyMonitorQueue): Promise<void> {
  await kv.put(dailyQueueKey(queue.id), JSON.stringify(queue), { expirationTtl: QUEUE_TTL_SECONDS });
}

async function analyzeSequentially(urls: string[], analyzeLinkedSite = false) {
  const results = [];
  for (const url of urls) results.push(await analyzePage(url, analyzeLinkedSite));
  return results;
}

export async function runMonitor(env: Env, siteIds?: string[]): Promise<Record<string, unknown>> {
  const requestedSiteIds = siteIds ? new Set(siteIds) : undefined;
  const sites = requestedSiteIds
    ? parseSites(env).filter((site) => requestedSiteIds.has(site.id))
    : parseSites(env);
  const maxNewPages = parsePositiveInt(env.MAX_NEW_PAGES, 20);
  const maxSitemaps = parsePositiveInt(env.MAX_SITEMAPS_PER_SITE, 50);
  const summary: Record<string, unknown>[] = [];

  for (const site of sites) {
    try {
      const collectedUrls = await collectPageUrls(site.url, maxSitemaps);
      const currentUrls = site.pathPrefix ? filterUrlsByPrefix(collectedUrls, site.pathPrefix) : collectedUrls;
      const previous = await env.SNAPSHOTS.get<Snapshot>(snapshotKey(site.id), "json");

      if (!previous) {
        await notifyNoNewPages(env.FEISHU_WEBHOOK, site.name, site.url, currentUrls.length);
        const baseline: Snapshot = {
          sitemapUrl: site.url,
          scannedAt: new Date().toISOString(),
          urls: currentUrls,
        };
        await env.SNAPSHOTS.put(snapshotKey(site.id), JSON.stringify(baseline));
        summary.push({ site: site.id, baselineCreated: true, totalUrls: currentUrls.length });
        continue;
      }

      const newUrls = findNewUrls(currentUrls, previous.urls);
      if (newUrls.length === 0) {
        await notifyNoNewPages(env.FEISHU_WEBHOOK, site.name, site.url, currentUrls.length);
        const snapshot: Snapshot = {
          sitemapUrl: site.url,
          scannedAt: new Date().toISOString(),
          urls: currentUrls,
        };
        await env.SNAPSHOTS.put(snapshotKey(site.id), JSON.stringify(snapshot));
        summary.push({ site: site.id, baselineCreated: false, totalUrls: currentUrls.length, newUrls: 0 });
        continue;
      }

      const usesAitdk = site.id === "pmkg" || site.id === "creem";
      const aitdkBatch = usesAitdk
        ? await enqueueAitdkBatch(env.SNAPSHOTS, site.id, newUrls)
        : undefined;
      if (aitdkBatch) await notifyAitdkBatch(env.FEISHU_WEBHOOK, aitdkBatch);

      const analysisLimit = site.id === "pmkg" ? Math.min(maxNewPages, 15) : maxNewPages;
      const selected = newUrls.slice(0, analysisLimit);
      const analyses = await analyzeSequentially(selected, site.analyzeLinkedSite);
      const result: SiteRunResult = {
        site,
        baselineCreated: false,
        totalUrls: currentUrls.length,
        newUrls,
        analyses,
        omittedCount: Math.max(0, newUrls.length - selected.length),
      };

      // 先通知，后更新快照。通知失败时，下一次仍会重试这些新增网址。
      await notifySiteResult(env.FEISHU_WEBHOOK, result);

      const selectedSet = new Set(selected);
      const newSet = new Set(newUrls);
      const snapshot: Snapshot = {
        sitemapUrl: site.url,
        scannedAt: new Date().toISOString(),
        urls: usesAitdk
          ? currentUrls
          : currentUrls.filter((url) => !newSet.has(url) || selectedSet.has(url)),
      };
      await env.SNAPSHOTS.put(snapshotKey(site.id), JSON.stringify(snapshot));
      summary.push({
        site: site.id,
        baselineCreated: false,
        totalUrls: currentUrls.length,
        newUrls: newUrls.length,
        remainingUrls: result.omittedCount,
        ...(aitdkBatch ? { aitdkBatch: aitdkBatch.id, aitdkStatus: aitdkBatch.status } : {}),
      });
      console.log(JSON.stringify({ event: "site_monitor_completed", site: site.id, newUrls: newUrls.length }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.push({ site: site.id, error: message });
      console.error(JSON.stringify({ event: "site_monitor_failed", site: site.id, error: message }));
      try {
        await notifyError(env.FEISHU_WEBHOOK, site.name, error);
      } catch (notifyFailure) {
        console.error("监控失败且飞书通知失败", site.id, notifyFailure);
      }
    }
  }

  return { ranAt: new Date().toISOString(), results: summary };
}

export async function startDailyMonitor(env: Env, now = new Date()): Promise<DailyMonitorQueue> {
  const date = chinaDate(now);
  const key = dailyQueueKey(date);
  const existing = await env.SNAPSHOTS.get<DailyMonitorQueue>(key, "json");
  if (existing) {
    if (!existing.startNotified) {
      await notifyDailyMonitorStarted(env.FEISHU_WEBHOOK, date, existing.remainingSiteIds.length);
      existing.startNotified = true;
      existing.updatedAt = now.toISOString();
      await saveDailyQueue(env.SNAPSHOTS, existing);
    }
    return existing;
  }

  const queue: DailyMonitorQueue = {
    id: date,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
    startNotified: false,
    remainingSiteIds: parseSites(env).map((site) => site.id),
    completedSiteIds: [],
    failedSites: {},
    attempts: {},
  };
  await saveDailyQueue(env.SNAPSHOTS, queue);
  await notifyDailyMonitorStarted(env.FEISHU_WEBHOOK, date, queue.remainingSiteIds.length);
  queue.startNotified = true;
  queue.updatedAt = new Date().toISOString();
  await saveDailyQueue(env.SNAPSHOTS, queue);
  console.log(JSON.stringify({ event: "daily_monitor_started", date, sites: queue.remainingSiteIds.length }));
  return queue;
}

export async function runNextScheduledJob(env: Env, now = new Date()): Promise<Record<string, unknown>> {
  const date = chinaDate(now);
  const queue = await env.SNAPSHOTS.get<DailyMonitorQueue>(dailyQueueKey(date), "json");
  if (!queue || queue.status === "completed") {
    return { job: "aitdk", ...await runAitdkMonitor(env) };
  }

  if (!queue.startNotified) {
    await notifyDailyMonitorStarted(env.FEISHU_WEBHOOK, date, queue.remainingSiteIds.length);
    queue.startNotified = true;
    queue.updatedAt = now.toISOString();
    await saveDailyQueue(env.SNAPSHOTS, queue);
  }

  const siteId = queue.remainingSiteIds[0];
  if (siteId) {
    const result = await runMonitor(env, [siteId]);
    const siteResult = (result.results as Array<Record<string, unknown>>)[0];
    const error = typeof siteResult?.error === "string" ? siteResult.error : "";
    if (error) {
      const attempts = (queue.attempts[siteId] ?? 0) + 1;
      queue.attempts[siteId] = attempts;
      if (attempts >= MAX_SITE_ATTEMPTS) {
        queue.failedSites[siteId] = error;
        queue.remainingSiteIds.shift();
      }
    } else {
      queue.completedSiteIds.push(siteId);
      queue.remainingSiteIds.shift();
    }
    queue.updatedAt = now.toISOString();
    await saveDailyQueue(env.SNAPSHOTS, queue);
    console.log(JSON.stringify({
      event: error ? "daily_site_retry" : "daily_site_completed",
      date,
      site: siteId,
      attempt: queue.attempts[siteId] ?? 1,
      remaining: queue.remainingSiteIds.length,
    }));
  }

  if (queue.remainingSiteIds.length === 0) {
    await notifyDailyMonitorCompleted(
      env.FEISHU_WEBHOOK,
      date,
      queue.completedSiteIds.length,
      Object.keys(queue.failedSites).length,
    );
    queue.status = "completed";
    queue.updatedAt = new Date().toISOString();
    await saveDailyQueue(env.SNAPSHOTS, queue);
    console.log(JSON.stringify({ event: "daily_monitor_completed", date }));
  }

  return {
    job: "site-monitor",
    site: siteId,
    status: queue.status,
    remainingSites: queue.remainingSiteIds.length,
    completedSites: queue.completedSiteIds.length,
    failedSites: Object.keys(queue.failedSites).length,
  };
}

export async function runAitdkMonitor(env: Env): Promise<Record<string, unknown>> {
  try {
    const apiKey = env.TABAPI_API_KEY ?? env.SITEDATA_API_KEY;
    if (!apiKey) throw new Error("缺少 TABAPI_API_KEY");
    const limit = parsePositiveInt(env.MAX_AITDK_DOMAINS_PER_RUN, 15);
    const summary = await processAitdkQueue(env.SNAPSHOTS, apiKey, limit);
    await notifyAitdkResults(env.FEISHU_WEBHOOK, summary);
    console.log(JSON.stringify({ event: "aitdk_queue_processed", ...summary, results: undefined }));
    return { ranAt: new Date().toISOString(), ...summary };
  } catch (error) {
    await notifyError(env.FEISHU_WEBHOOK, "AITDK 流量验证", error);
    return { ranAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
  }
}
