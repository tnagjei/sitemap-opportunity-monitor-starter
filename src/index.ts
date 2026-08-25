import { approveAitdkBatch } from "./aitdk";
import { runAitdkMonitor, runNextScheduledJob, startDailyMonitor } from "./runner";
import type { Env } from "./types";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
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

    if (request.method === "POST" && url.pathname === "/run") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return json(await startDailyMonitor(env));
    }

    if (request.method === "POST" && url.pathname === "/run-next") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return json(await runNextScheduledJob(env));
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
    ctx.waitUntil(controller.cron === "0 21 * * *" ? startDailyMonitor(env) : runNextScheduledJob(env));
  },
} satisfies ExportedHandler<Env>;
