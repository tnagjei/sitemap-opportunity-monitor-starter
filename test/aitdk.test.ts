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

function trafficResponse() {
  return {
    domain: "exampletool.com",
    title: "ExampleTool",
    description: "Remove image watermarks",
    overview: {
      global_rank: 120_000,
      country_rank: { country: "US", rank: 40_000 },
      visits: 12_000,
      bounce_rate: 0.42,
      pages_per_visit: 2.3,
      time_on_site_seconds: 95,
      month: "2026-07",
    },
    monthly_visits: [
      { month: "2026-05", visits: 10_000 },
      { month: "2026-06", visits: 11_000 },
      { month: "2026-07", visits: 12_000 },
    ],
    traffic_sources: {
      direct: 0.4,
      search: 0.35,
      search_organic: 0.33,
      search_paid: 0.02,
      social: 0.1,
      social_organic: 0.09,
      social_paid: 0.01,
      referrals: 0.05,
      paid_referrals: 0.01,
      mail: 0.01,
      gen_ai: 0.03,
      affiliate: 0.02,
      other: 0.03,
    },
    top_keywords: [
      { name: "exampletool", volume: 1_000, cpc: 1.2, estimated_value: 300 },
      { name: "remove image watermark", volume: 500, cpc: 2.4, estimated_value: 600 },
    ],
    top_regions: [
      { country: "US", name: "United States", share: 0.45 },
      { country: "GB", name: "United Kingdom", share: 0.12 },
    ],
    ai_traffic: {
      trends: [{ name: "ChatGPT", history: [{ date: "2026-07-01", value: 0.03 }] }],
    },
  };
}

function rdapResponse() {
  return {
    events: [
      { eventAction: "registration", eventDate: "2026-02-01T00:00:00Z" },
      { eventAction: "expiration", eventDate: "2027-02-01T00:00:00Z" },
    ],
  };
}

test("20 个以内自动批准，超过 20 个等待批准且不丢 URL", () => {
  const small = createAitdkBatch("pmkg", Array.from({ length: 20 }, (_, index) => `https://pmkg.test/${index}`), new Date("2026-08-24T00:00:00Z"));
  const large = createAitdkBatch("pmkg", Array.from({ length: 21 }, (_, index) => `https://pmkg.test/${index}`), new Date("2026-08-24T00:00:00Z"));

  assert.equal(small.status, "approved");
  assert.equal(small.estimatedCredits, 80);
  assert.equal(large.status, "pending_approval");
  assert.equal(large.estimatedCredits, 84);
  assert.equal(large.urls.length, 21);
});

test("解析 TabAPI 全部 Traffic 字段并排除品牌词", () => {
  const assessment = assessTraffic(
    "exampletool.com",
    { ...trafficResponse(), registrationDate: "2026-02-01T00:00:00Z" },
    new Date("2026-08-24T00:00:00Z"),
  );

  assert.equal(assessment.qualified, true);
  assert.equal(assessment.registrationDate, "2026-02-01T00:00:00Z");
  assert.equal(assessment.countryRank?.country, "US");
  assert.equal(assessment.trafficSources.gen_ai, 0.03);
  assert.equal(assessment.topRegions[0]?.name, "United States");
  assert.equal(assessment.monthlyVisits.length, 3);
  assert.equal(assessment.aiTraffic?.trends[0]?.name, "ChatGPT");
  assert.deepEqual(assessment.nonBrandKeywords, [{
    name: "remove image watermark",
    volume: 500,
    cpc: 2.4,
    estimatedValue: 600,
  }]);
});

test("同日批次合并全部 URL，超过 20 个后需要批准", async () => {
  const kv = memoryKv();
  await enqueueAitdkBatch(kv, "pmkg", Array.from({ length: 15 }, (_, index) => `https://pmkg.test/${index}`), new Date("2026-08-24T01:00:00Z"));
  const batch = await enqueueAitdkBatch(kv, "pmkg", Array.from({ length: 10 }, (_, index) => `https://pmkg.test/${index + 15}`), new Date("2026-08-24T02:00:00Z"));

  assert.equal(batch.urls.length, 25);
  assert.equal(batch.status, "pending_approval");
  assert.equal(batch.estimatedCredits, 100);

  const approved = await approveAitdkBatch(kv, batch.id);
  assert.equal(approved.status, "approved");
});

test("队列对重复域名只调用一次 Traffic API 并缓存 30 天", async () => {
  const kv = memoryKv();
  await enqueueAitdkBatch(kv, "pmkg", ["https://pmkg.test/1", "https://pmkg.test/2"], new Date("2026-08-24T00:00:00Z"));
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  const encoded = encodeURIComponent(btoa("https://www.exampletool.com/"));
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://pmkg.test/")) {
      return new Response(`<a href="https://www.pmkg.net/go/?url=${encoded}">官网</a>`, {
        headers: { "content-type": "text/html" },
      });
    }
    apiCalls += 1;
    if (url.endsWith("/rdap")) return Response.json(rdapResponse());
    return Response.json(trafficResponse());
  };

  try {
    const summary = await processAitdkQueue(kv, "secret", 20, new Date("2026-08-24T03:00:00Z"));
    assert.equal(apiCalls, 2);
    assert.equal(summary.queriedCount, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.results.length, 2);
    assert.equal(summary.batchStatus, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Creem 批次从商店页提取官网后查询 Traffic API", async () => {
  const kv = memoryKv();
  await enqueueAitdkBatch(
    kv,
    "creem",
    ["https://www.creem.io/stores/example-tool"],
    new Date("2026-08-24T00:00:00Z"),
  );
  const originalFetch = globalThis.fetch;
  const queriedUrls: string[] = [];
  let authorization = "";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://www.creem.io/stores/example-tool") {
      return new Response(
        `<h1>Example Tool</h1><a href="https://www.exampletool.com/pricing" target="_blank">官网</a>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    queriedUrls.push(url);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (url.endsWith("/rdap")) return Response.json(rdapResponse());
    return Response.json(trafficResponse());
  };

  try {
    const summary = await processAitdkQueue(kv, "secret", 20, new Date("2026-08-24T03:00:00Z"));
    assert.deepEqual(queriedUrls, [
      "https://tabapi.com/api/v1/domains/exampletool.com/traffic?months=3",
      "https://tabapi.com/api/v1/domains/exampletool.com/rdap",
    ]);
    assert.equal(authorization, "Bearer secret");
    assert.equal(summary.queriedCount, 1);
    assert.equal(summary.results[0]?.costCredits, 4);
    assert.equal(summary.results[0]?.assessment?.registrationDate, "2026-02-01T00:00:00Z");
    assert.equal(summary.batchStatus, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RDAP 失败时保留已付费的 Traffic 结果且不重试", async () => {
  const kv = memoryKv();
  await enqueueAitdkBatch(kv, "creem", ["https://www.creem.io/stores/example-tool"], new Date("2026-08-24T00:00:00Z"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/stores/")) {
      return new Response(`<h1>Example</h1><a href="https://exampletool.com" target="_blank">官网</a>`);
    }
    if (url.endsWith("/rdap")) return Response.json({ error: { message: "no rdap" } }, { status: 422 });
    return Response.json(trafficResponse());
  };

  try {
    const summary = await processAitdkQueue(kv, "secret", 20, new Date("2026-08-24T03:00:00Z"));
    assert.equal(summary.batchStatus, "completed");
    assert.equal(summary.queriedCount, 1);
    assert.equal(summary.results[0]?.costCredits, 3);
    assert.match(summary.results[0]?.assessment?.registrationError ?? "", /no rdap/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
