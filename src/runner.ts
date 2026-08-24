import { parsePositiveInt, parseSites } from "./config";
import { enqueueAitdkBatch, processAitdkQueue } from "./aitdk";
import { notifyAitdkBatch, notifyAitdkResults, notifyError, notifyNoNewPages, notifySiteResult } from "./feishu";
import { analyzePage } from "./page";
import { collectPageUrls, filterUrlsByPrefix, findNewUrls } from "./sitemap";
import type { Env, SiteRunResult, Snapshot } from "./types";

function snapshotKey(siteId: string): string {
  return `snapshot:${siteId}`;
}

async function analyzeSequentially(urls: string[], analyzeLinkedSite = false) {
  const results = [];
  for (const url of urls) results.push(await analyzePage(url, analyzeLinkedSite));
  return results;
}

export async function runMonitor(env: Env): Promise<Record<string, unknown>> {
  const sites = parseSites(env);
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

      const selected = newUrls.slice(0, maxNewPages);
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
    } catch (error) {
      summary.push({ site: site.id, error: error instanceof Error ? error.message : String(error) });
      try {
        await notifyError(env.FEISHU_WEBHOOK, site.name, error);
      } catch (notifyFailure) {
        console.error("监控失败且飞书通知失败", site.id, notifyFailure);
      }
    }
  }

  return { ranAt: new Date().toISOString(), results: summary };
}

export async function runAitdkMonitor(env: Env): Promise<Record<string, unknown>> {
  try {
    const apiKey = env.TABAPI_API_KEY ?? env.SITEDATA_API_KEY;
    if (!apiKey) throw new Error("缺少 TABAPI_API_KEY");
    const limit = parsePositiveInt(env.MAX_AITDK_DOMAINS_PER_RUN, 20);
    const summary = await processAitdkQueue(env.SNAPSHOTS, apiKey, limit);
    await notifyAitdkResults(env.FEISHU_WEBHOOK, summary);
    return { ranAt: new Date().toISOString(), ...summary };
  } catch (error) {
    await notifyError(env.FEISHU_WEBHOOK, "AITDK 流量验证", error);
    return { ranAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
  }
}
