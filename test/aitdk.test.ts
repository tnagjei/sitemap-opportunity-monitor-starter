import assert from "node:assert/strict";
import test from "node:test";
import {
  approveAitdkBatch,
  assessTraffic,
  createAitdkBatch,
  enqueueAitdkBatch,
  processAitdkQueue,
} from "../src/aitdk";

function memoryKv() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => {
      const value = values.get(key);
      return value ? JSON.parse(value) : null;
    },
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace & { values: Map<string, string> };
}

test("20 个以内自动批准，超过 20 个等待批准且不丢 URL", () => {
  const small = createAitdkBatch("pmkg", Array.from({ length: 20 }, (_, index) => `https://pmkg.test/${index}`), new Date("2026-08-24T00:00:00Z"));
  const large = createAitdkBatch("pmkg", Array.from({ length: 21 }, (_, index) => `https://pmkg.test/${index}`), new Date("2026-08-24T00:00:00Z"));

  assert.equal(small.status, "approved");
  assert.equal(small.estimatedCredits, 40);
  assert.equal(large.status, "pending_approval");
  assert.equal(large.estimatedCredits, 42);
  assert.equal(large.urls.length, 21);
});

test("按注册时间、访问量和流量来源筛选并排除品牌词", () => {
  const assessment = assessTraffic(
    "exampletool.com",
    {
      SiteName: "ExampleTool",
      Engagments: { Visits: "12000" },
      TrafficSources: { Search: 0.35, Direct: 0.4 },
      DateData: { registration: "2026-02-01T00:00:00Z" },
      TopKeywords: [
        { Name: "exampletool", Volume: 1000 },
        { Name: "remove image watermark", Volume: 500 },
      ],
    },
    new Date("2026-08-24T00:00:00Z"),
  );

  assert.equal(assessment.qualified, true);
  assert.deepEqual(assessment.nonBrandKeywords, [{ name: "remove image watermark", volume: 500 }]);
});

test("同日批次合并全部 URL，超过 20 个后需要批准", async () => {
  const kv = memoryKv();
  await enqueueAitdkBatch(kv, "pmkg", Array.from({ length: 15 }, (_, index) => `https://pmkg.test/${index}`), new Date("2026-08-24T01:00:00Z"));
  const batch = await enqueueAitdkBatch(kv, "pmkg", Array.from({ length: 10 }, (_, index) => `https://pmkg.test/${index + 15}`), new Date("2026-08-24T02:00:00Z"));

  assert.equal(batch.urls.length, 25);
  assert.equal(batch.status, "pending_approval");
  assert.equal(batch.estimatedCredits, 50);

  const approved = await approveAitdkBatch(kv, batch.id);
  assert.equal(approved.status, "approved");
});

test("队列对重复域名只调用一次 Traffic API 并缓存 30 天", async () => {
  const kv = memoryKv();
  await enqueueAitdkBatch(kv, "pmkg", ["https://pmkg.test/1", "https://pmkg.test/2"], new Date("2026-08-24T00:00:00Z"));
  const originalFetch = globalThis.fetch;
  let trafficCalls = 0;
  const encoded = encodeURIComponent(btoa("https://www.exampletool.com/"));
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://pmkg.test/")) {
      return new Response(`<a href="https://www.pmkg.net/go/?url=${encoded}">官网</a>`, {
        headers: { "content-type": "text/html" },
      });
    }
    trafficCalls += 1;
    return Response.json({
      code: "ok",
      data: {
        costCredits: 2,
        remainingCredits: 98,
        SiteName: "ExampleTool",
        Engagments: { Visits: "12000" },
        TrafficSources: { Search: 0.35, Direct: 0.4 },
        DateData: { registration: "2026-02-01T00:00:00Z" },
        TopKeywords: [{ Name: "remove image watermark", Volume: 500 }],
      },
    });
  };

  try {
    const summary = await processAitdkQueue(kv, "secret", 20, new Date("2026-08-24T03:00:00Z"));
    assert.equal(trafficCalls, 1);
    assert.equal(summary.queriedCount, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.results.length, 2);
    assert.equal(summary.batchStatus, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
