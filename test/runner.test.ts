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

test("新增网址超过上限时只把已通知的网址写入快照", async () => {
  const originalFetch = globalThis.fetch;
  let savedSnapshot = "";
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://example.com/sitemap.xml") {
      return new Response(
        "<urlset>" +
          ["old", "a", "b", "c"].map((slug) => `<url><loc>https://example.com/${slug}</loc></url>`).join("") +
          "</urlset>",
      );
    }
    if (url === "https://example.com/webhook") return Response.json({ code: 0 });
    return new Response(`<title>${url}</title><h1>${url}</h1>`, {
      headers: { "content-type": "text/html" },
    });
  };

  const env = {
    SNAPSHOTS: {
      get: async () => ({
        sitemapUrl: "https://example.com/sitemap.xml",
        scannedAt: "2026-08-12T00:00:00.000Z",
        urls: ["https://example.com/old"],
      }),
      put: async (_key: string, value: string) => {
        savedSnapshot = value;
      },
    },
    FEISHU_WEBHOOK: "https://example.com/webhook",
    MAX_NEW_PAGES: "2",
    MONITORED_SITEMAPS: JSON.stringify([
      { id: "example", name: "Example", url: "https://example.com/sitemap.xml" },
    ]),
  } as unknown as Env;

  try {
    const result = await runMonitor(env);
    assert.deepEqual(JSON.parse(savedSnapshot).urls, [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/old",
    ]);
    assert.deepEqual(result.results, [{
      site: "example",
      baselineCreated: false,
      totalUrls: 4,
      newUrls: 3,
      remainingUrls: 1,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
