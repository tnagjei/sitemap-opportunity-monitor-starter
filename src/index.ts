import { runMonitor } from "./runner";
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
      return json(await runMonitor(env));
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMonitor(env));
  },
} satisfies ExportedHandler<Env>;
