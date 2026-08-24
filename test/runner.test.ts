import assert from "node:assert/strict";
import test from "node:test";
import { runMonitor } from "../src/runner";
import type { Env } from "../src/types";

test("首次建立基线也发送无新增通知", async () => {
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    if (String(input) === "https://example.com/sitemap.xml") {
      return new Response("<urlset><url><loc>https://example.com/page</loc></url></urlset>");
    }
    events.push("notify");
    return Response.json({ code: 0 });
  };

  const env = {
    SNAPSHOTS: {
      get: async () => null,
      put: async () => {
        events.push("snapshot");
      },
    },
    FEISHU_WEBHOOK: "https://example.com/webhook",
    MONITORED_SITEMAPS: JSON.stringify([
      { id: "example", name: "Example", url: "https://example.com/sitemap.xml" },
    ]),
  } as unknown as Env;

  try {
    const result = await runMonitor(env);
    assert.deepEqual(events, ["notify", "snapshot"]);
    assert.deepEqual(result.results, [{ site: "example", baselineCreated: true, totalUrls: 1 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
