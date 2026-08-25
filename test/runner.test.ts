import assert from "node:assert/strict";
import test from "node:test";
import { runMonitor, runNextScheduledJob, startDailyMonitor } from "../src/runner";
import type { Env } from "../src/types";

test("每日任务创建一次队列并立即发送开始通知", async () => {
  const originalFetch = globalThis.fetch;
  const values = new Map<string, string>();
  const notifications: string[] = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    notifications.push(JSON.parse(String(init?.body)).content.text);
    return Response.json({ code: 0 });
  };
  const env = {
    SNAPSHOTS: {
      get: async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
    FEISHU_WEBHOOK: "https://example.com/webhook",
    MONITORED_SITEMAPS: JSON.stringify([
      { id: "first", name: "First", url: "https://first.test/sitemap.xml" },
      { id: "second", name: "Second", url: "https://second.test/sitemap.xml" },
    ]),
  } as unknown as Env;
  const now = new Date("2026-08-24T21:00:00.000Z");

  try {
    await startDailyMonitor(env, now);
    await startDailyMonitor(env, now);
    const queue = JSON.parse(values.get("monitor:daily:2026-08-25") ?? "{}");
    assert.deepEqual(queue.remainingSiteIds, ["first", "second"]);
    assert.equal(queue.startNotified, true);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0] ?? "", /2 个站点/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("每次调度只处理队列中的一个站点", async () => {
  const originalFetch = globalThis.fetch;
  const values = new Map<string, string>([
    ["monitor:daily:2026-08-25", JSON.stringify({
      id: "2026-08-25",
      createdAt: "2026-08-24T21:00:00.000Z",
      updatedAt: "2026-08-24T21:00:00.000Z",
      status: "active",
      startNotified: true,
      remainingSiteIds: ["first", "second"],
      completedSiteIds: [],
      failedSites: {},
      attempts: {},
    })],
  ]);
  const fetched: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(`<urlset><url><loc>${url.replace("/sitemap.xml", "/page")}</loc></url></urlset>`);
    }
    return Response.json({ code: 0 });
  };
  const env = {
    SNAPSHOTS: {
      get: async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
    FEISHU_WEBHOOK: "https://example.com/webhook",
    MONITORED_SITEMAPS: JSON.stringify([
      { id: "first", name: "First", url: "https://first.test/sitemap.xml" },
      { id: "second", name: "Second", url: "https://second.test/sitemap.xml" },
    ]),
  } as unknown as Env;

  try {
    const result = await runNextScheduledJob(env, new Date("2026-08-24T21:05:00.000Z"));
    const queue = JSON.parse(values.get("monitor:daily:2026-08-25") ?? "{}");
    assert.equal(result.job, "site-monitor");
    assert.equal(result.site, "first");
    assert.deepEqual(queue.remainingSiteIds, ["second"]);
    assert.deepEqual(queue.completedSiteIds, ["first"]);
    assert.equal(fetched.includes("https://second.test/sitemap.xml"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("站点扫描失败时保留队列，第三次失败后记录并继续", async () => {
  const originalFetch = globalThis.fetch;
  const values = new Map<string, string>([
    ["monitor:daily:2026-08-25", JSON.stringify({
      id: "2026-08-25",
      createdAt: "2026-08-24T21:00:00.000Z",
      updatedAt: "2026-08-24T21:00:00.000Z",
      status: "active",
      startNotified: true,
      remainingSiteIds: ["broken"],
      completedSiteIds: [],
      failedSites: {},
      attempts: {},
    })],
  ]);
  globalThis.fetch = async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/sitemap.xml")) throw new Error("network down");
    return Response.json({ code: 0 });
  };
  const env = {
    SNAPSHOTS: {
      get: async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
    FEISHU_WEBHOOK: "https://example.com/webhook",
    MONITORED_SITEMAPS: JSON.stringify([
      { id: "broken", name: "Broken", url: "https://broken.test/sitemap.xml" },
    ]),
  } as unknown as Env;

  try {
    await runNextScheduledJob(env, new Date("2026-08-24T21:05:00.000Z"));
    const firstAttempt = JSON.parse(values.get("monitor:daily:2026-08-25") ?? "{}");
    assert.deepEqual(firstAttempt.remainingSiteIds, ["broken"]);
    assert.equal(firstAttempt.attempts.broken, 1);

    await runNextScheduledJob(env, new Date("2026-08-24T21:10:00.000Z"));
    await runNextScheduledJob(env, new Date("2026-08-24T21:15:00.000Z"));
    const finalQueue = JSON.parse(values.get("monitor:daily:2026-08-25") ?? "{}");
    assert.deepEqual(finalQueue.remainingSiteIds, []);
    assert.equal(finalQueue.attempts.broken, 3);
    assert.equal(finalQueue.failedSites.broken, "network down");
    assert.equal(finalQueue.status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test("PMKG 新增超过页面分析上限时全部进入 AITDK 批次并写入快照", async () => {
  const originalFetch = globalThis.fetch;
  const analyzedListings: string[] = [];
  const values = new Map<string, string>([
    ["snapshot:pmkg", JSON.stringify({
      sitemapUrl: "https://pmkg.test/sitemap.xml",
      scannedAt: "2026-08-23T00:00:00.000Z",
      urls: ["https://www.pmkg.net/sites/1.html"],
    })],
  ]);
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://pmkg.test/sitemap.xml") {
      return new Response(
        "<urlset>" +
          Array.from({ length: 18 }, (_, index) => index + 1)
            .map((id) => `<url><loc>https://www.pmkg.net/sites/${id}.html</loc></url>`)
            .join("") +
          "</urlset>",
      );
    }
    if (url.startsWith("https://www.pmkg.net/sites/")) {
      analyzedListings.push(url);
      return new Response("<title>PMKG</title><h1>PMKG</h1>", {
        headers: { "content-type": "text/html" },
      });
    }
    return Response.json({ code: 0 });
  };

  const env = {
    SNAPSHOTS: {
      get: async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
    FEISHU_WEBHOOK: "https://example.com/webhook",
    MAX_NEW_PAGES: "20",
    MONITORED_SITEMAPS: JSON.stringify([
      {
        id: "pmkg",
        name: "PMKG",
        url: "https://pmkg.test/sitemap.xml",
        pathPrefix: "https://www.pmkg.net/sites/",
        analyzeLinkedSite: true,
      },
    ]),
  } as unknown as Env;

  try {
    await runMonitor(env);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(analyzedListings.length, 15);
    assert.equal(JSON.parse(values.get(`aitdk:batch:pmkg-${today}`) ?? "{}").urls.length, 17);
    assert.equal(JSON.parse(values.get("snapshot:pmkg") ?? "{}").urls.length, 18);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Creem 新商店全部进入 AITDK 批次并写入快照", async () => {
  const originalFetch = globalThis.fetch;
  const values = new Map<string, string>([
    ["snapshot:creem", JSON.stringify({
      sitemapUrl: "https://creem.test/sitemap.xml",
      scannedAt: "2026-08-23T00:00:00.000Z",
      urls: ["https://www.creem.io/stores/old"],
    })],
  ]);
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://creem.test/sitemap.xml") {
      return new Response(
        "<urlset>" +
          ["old", "a", "b", "c"].map((slug) => `<url><loc>https://www.creem.io/stores/${slug}</loc></url>`).join("") +
          "</urlset>",
      );
    }
    if (url.startsWith("https://www.creem.io/stores/")) {
      return new Response(`<title>Creem Store</title><h1>Creem Store</h1>`, {
        headers: { "content-type": "text/html" },
      });
    }
    return Response.json({ code: 0 });
  };

  const env = {
    SNAPSHOTS: {
      get: async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
    FEISHU_WEBHOOK: "https://example.com/webhook",
    MAX_NEW_PAGES: "1",
    MONITORED_SITEMAPS: JSON.stringify([
      {
        id: "creem",
        name: "Creem",
        url: "https://creem.test/sitemap.xml",
        pathPrefix: "https://www.creem.io/stores/",
        analyzeLinkedSite: true,
      },
    ]),
  } as unknown as Env;

  try {
    await runMonitor(env);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(JSON.parse(values.get(`aitdk:batch:creem-${today}`) ?? "{}").urls.length, 3);
    assert.equal(JSON.parse(values.get("snapshot:creem") ?? "{}").urls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
