import { parsePositiveFloat, parsePositiveInt, parseSites, parseTrendKeywords } from "./config";
import { enqueueAitdkBatch, processAitdkQueue } from "./aitdk";
import {
  notifyAitdkBatch,
  notifyAitdkResults,
  notifyDailyMonitorCompleted,
  notifyDailyMonitorStarted,
  notifyError,
  notifyNoNewPages,
  notifySkippedLanguages,
  notifySiteResult,
  notifyTrendsError,
  notifyTrendsReport,
} from "./feishu";
import { analyzePage } from "./page";
import {
  evaluateTrendKeyword,
  fetchNidCookie,
  fetchTrendSeries,
  TrendNoDataError,
  TRENDS_RETRY_DELAY_MS,
  TRENDS_SPACING_MS,
} from "./trends";
import type { TrendKeywordStats } from "./trends";
import { collectPageUrls, filterUrlsByPrefix, findNewUrls, partitionLanguageUrls } from "./sitemap";
import type {
  DailyMonitorQueue,
  Env,
  TrendKeywordConfig,
  SiteRunResult,
  Snapshot,
  TrendKeywordEvaluation,
  TrendsReport,
  TrendsSnapshot,
} from "./types";

const DAILY_QUEUE_PREFIX = "monitor:daily:";
const TRENDS_SNAPSHOT_KEY = "trends:weekly:snapshot";
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

      const {
        englishUrls,
        skippedNonEnglishUrls,
        variantsByUrl,
        unmatchedNonEnglishUrls,
        primaryLanguage,
        isPureMinorityLanguageSite,
      } = partitionLanguageUrls(newUrls, {
        targetLang: site.primaryLanguage,
        allUrls: currentUrls,
      });

      if (englishUrls.length === 0) {
        await notifySkippedLanguages(
          env.FEISHU_WEBHOOK,
          site.name,
          site.url,
          currentUrls.length,
          skippedNonEnglishUrls,
        );
        const snapshot: Snapshot = {
          sitemapUrl: site.url,
          scannedAt: new Date().toISOString(),
          urls: currentUrls,
        };
        await env.SNAPSHOTS.put(snapshotKey(site.id), JSON.stringify(snapshot));
        summary.push({
          site: site.id,
          baselineCreated: false,
          totalUrls: currentUrls.length,
          newUrls: newUrls.length,
          remainingUrls: 0,
          skippedNonEnglishCount: skippedNonEnglishUrls.length,
        });
        console.log(JSON.stringify({
          event: "site_monitor_completed",
          site: site.id,
          newUrls: newUrls.length,
          skippedNonEnglishCount: skippedNonEnglishUrls.length,
        }));
        continue;
      }

      const usesAitdk = site.id === "pmkg" || site.id === "creem";
      const aitdkBatch = usesAitdk
        ? await enqueueAitdkBatch(env.SNAPSHOTS, site.id, englishUrls)
        : undefined;
      if (aitdkBatch) await notifyAitdkBatch(env.FEISHU_WEBHOOK, aitdkBatch);

      const analysisLimit = site.id === "pmkg" ? Math.min(maxNewPages, 15) : maxNewPages;
      const selected = englishUrls.slice(0, analysisLimit);
      const analyses = await analyzeSequentially(selected, site.analyzeLinkedSite);

      for (const analysis of analyses) {
        const variants = variantsByUrl.get(analysis.url);
        if (variants && variants.length > 0) {
          analysis.languageVariants = Array.from(new Set(variants)).sort();
        }
      }

      const result: SiteRunResult = {
        site,
        baselineCreated: false,
        totalUrls: currentUrls.length,
        newUrls,
        analyses,
        omittedCount: Math.max(0, englishUrls.length - selected.length),
        skippedNonEnglishCount: skippedNonEnglishUrls.length,
        unmatchedNonEnglishUrls: unmatchedNonEnglishUrls.length > 0 ? unmatchedNonEnglishUrls : undefined,
        primaryLanguage,
        isPureMinorityLanguageSite,
      };

      // 先通知，后更新快照。通知失败时，下一次仍会重试这些新增网址。
      await notifySiteResult(env.FEISHU_WEBHOOK, result);

      const selectedSet = new Set(selected);
      const skippedSet = new Set(skippedNonEnglishUrls);
      const newSet = new Set(newUrls);
      const snapshot: Snapshot = {
        sitemapUrl: site.url,
        scannedAt: new Date().toISOString(),
        urls: usesAitdk
          ? currentUrls
          : currentUrls.filter((url) => !newSet.has(url) || selectedSet.has(url) || skippedSet.has(url)),
      };
      await env.SNAPSHOTS.put(snapshotKey(site.id), JSON.stringify(snapshot));
      summary.push({
        site: site.id,
        baselineCreated: false,
        totalUrls: currentUrls.length,
        newUrls: newUrls.length,
        remainingUrls: result.omittedCount,
        ...(skippedNonEnglishUrls.length > 0 ? { skippedNonEnglishCount: skippedNonEnglishUrls.length } : {}),
        ...(aitdkBatch ? { aitdkBatch: aitdkBatch.id, aitdkStatus: aitdkBatch.status } : {}),
      });
      console.log(JSON.stringify({
        event: "site_monitor_completed",
        site: site.id,
        newUrls: newUrls.length,
        englishUrls: englishUrls.length,
        skippedNonEnglishCount: skippedNonEnglishUrls.length,
      }));
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

function trendKeywordKey(keyword: string, geo?: string): string {
  return geo ? `${keyword.toLowerCase()}|${geo.toLowerCase()}` : keyword.toLowerCase();
}

export async function runTrendsMonitor(env: Env, now = new Date()): Promise<TrendsReport> {
  try {
    const thresholds = {
      noiseFloor: parsePositiveFloat(env.TRENDS_NOISE_FLOOR, 3),
      doublingFactor: parsePositiveFloat(env.TRENDS_DOUBLING_FACTOR, 2),
    };
    const keywordConfigs = parseTrendKeywords(env);
    const retryDelayMs = parsePositiveInt(env.TRENDS_RETRY_DELAY_MS, TRENDS_RETRY_DELAY_MS);
    const previous = await env.SNAPSHOTS.get<TrendsSnapshot>(TRENDS_SNAPSHOT_KEY, "json");
    const baselineCreated = !previous;

    // 先取全部数据再决定通知内容。取数失败（限流、网络）整体失败并保留旧快照；
    // 但 Google 明确表示"查不到数据"的词只跳过，否则一个长尾词会让整周监控永远失败。
    const cookie = await fetchNidCookie().catch(() => "");
    const stats: TrendKeywordStats[] = [];
    const noData: TrendKeywordConfig[] = [];
    for (const [index, config] of keywordConfigs.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, TRENDS_SPACING_MS));
      try {
        const series = await fetchTrendSeries(config.keyword, config.geo, cookie, retryDelayMs);
        stats.push(evaluateTrendKeyword(config, series, thresholds));
      } catch (error) {
        if (error instanceof TrendNoDataError) {
          noData.push(config);
          continue;
        }
        throw error;
      }
    }

    const previousKeywords = previous?.keywords ?? {};
    const doubled: TrendKeywordEvaluation[] = [];
    const baselines: TrendKeywordEvaluation[] = [];
    const unchanged: TrendKeywordEvaluation[] = [];
    const snapshot: TrendsSnapshot = { scannedAt: now.toISOString(), keywords: {} };

    for (const item of stats) {
      const key = trendKeywordKey(item.keyword, item.geo);
      snapshot.keywords[key] = { last7Mean: item.last7Mean, prev7Mean: item.prev7Mean };
      const evaluation: TrendKeywordEvaluation = {
        keyword: item.keyword,
        geo: item.geo,
        last7Mean: item.last7Mean,
        prev7Mean: item.prev7Mean,
        multiple: item.multiple,
        status: "unchanged",
      };
      if (!(key in previousKeywords)) {
        evaluation.status = "baseline";
        baselines.push(evaluation);
      } else if (item.status === "doubled") {
        evaluation.status = "doubled";
        doubled.push(evaluation);
      } else {
        unchanged.push(evaluation);
      }
    }

    const report: TrendsReport = {
      ranAt: now.toISOString(),
      baselineCreated,
      keywordCount: keywordConfigs.length,
      doubled,
      baselines,
      unchanged,
      noData,
    };

    // 先通知后写快照：通知失败时快照保持不变，下次运行会重试同一批词。
    await notifyTrendsReport(env.FEISHU_WEBHOOK, report);
    await env.SNAPSHOTS.put(TRENDS_SNAPSHOT_KEY, JSON.stringify(snapshot));
    console.log(JSON.stringify({
      event: "trends_monitor_completed",
      baselineCreated,
      doubled: doubled.length,
      noData: noData.length,
    }));
    return report;
  } catch (error) {
    await notifyTrendsError(env.FEISHU_WEBHOOK, error);
    console.error(JSON.stringify({
      event: "trends_monitor_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      ranAt: now.toISOString(),
      baselineCreated: false,
      keywordCount: 0,
      doubled: [],
      baselines: [],
      unchanged: [],
      noData: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
