import { approveAitdkBatch } from "./aitdk";
import { runAitdkMonitor, runMonitor, runNextScheduledJob, runTrendsMonitor, startDailyMonitor } from "./runner";
import { loadSiteReports, renderReportPage } from "./report";
import type { Env } from "./types";

const TRENDS_LAST_SUCCESS_KEY = "trends:weekly:last-success";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export function scheduledJobAt(date: Date): "daily" | "trends" | "site-monitor" {
  const slot = new Date(Math.floor(date.getTime() / (5 * 60_000)) * 5 * 60_000);
  if (slot.getUTCHours() === 21 && slot.getUTCMinutes() === 0) return "daily";
  if (slot.getUTCDay() === 1 && slot.getUTCHours() === 13 && slot.getUTCMinutes() === 0) return "trends";
  return "site-monitor";
}

export async function runWeeklyTrendsMonitor(env: Env, now: Date) {
  const week = now.toISOString().slice(0, 10);
  if (await env.SNAPSHOTS.get(TRENDS_LAST_SUCCESS_KEY) === week) {
    console.log(JSON.stringify({ event: "trends_monitor_skipped", week, reason: "already_completed" }));
    return { skipped: true as const, week };
  }
  const report = await runTrendsMonitor(env, now);
  if (!report.error) await env.SNAPSHOTS.put(TRENDS_LAST_SUCCESS_KEY, week);
  return report;
}

function authorized(request: Request, env: Env): boolean {
  if (!env.MANUAL_RUN_SECRET) return false;
  return request.headers.get("authorization") === `Bearer ${env.MANUAL_RUN_SECRET}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "sitemap-opportunity-monitor" });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/report")) {
      const html = renderReportPage(await loadSiteReports(env.SNAPSHOTS));
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return json(await startDailyMonitor(env));
    }

    if (request.method === "POST" && url.pathname === "/run-next") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return json(await runNextScheduledJob(env));
    }

    if (request.method === "POST" && url.pathname === "/run-site") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => null) as { siteId?: string } | null;
      const siteId = body?.siteId?.trim() ?? "";
      if (!siteId) return json({ ok: false, error: "Invalid siteId" }, 400);
      return json(await runMonitor(env, [siteId]));
    }

    if (request.method === "POST" && url.pathname === "/trends/run") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return json(await runTrendsMonitor(env));
    }

    if (request.method === "POST" && url.pathname === "/aitdk/run") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return json(await runAitdkMonitor(env));
    }

    if (request.method === "POST" && url.pathname === "/aitdk/approve") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      const body = await request.json().catch(() => null) as { batchId?: string } | null;
      const batchId = body?.batchId?.trim() ?? "";
      if (!/^[a-z0-9_-]+$/i.test(batchId)) return json({ ok: false, error: "Invalid batchId" }, 400);
      try {
        return json({ ok: true, batch: await approveAitdkBatch(env.SNAPSHOTS, batchId) });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 404);
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const scheduledAt = new Date(controller.scheduledTime);
    const job = scheduledJobAt(scheduledAt);
    console.log(JSON.stringify({ event: "cron_job_started", job, scheduledAt: scheduledAt.toISOString() }));
    ctx.waitUntil(
      job === "daily"
        ? startDailyMonitor(env, scheduledAt)
        : job === "trends"
          ? runWeeklyTrendsMonitor(env, scheduledAt)
          : runNextScheduledJob(env, scheduledAt),
    );
  },
} satisfies ExportedHandler<Env>;
