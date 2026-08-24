import assert from "node:assert/strict";
import test from "node:test";
import { notifyAitdkResults, notifySiteResult } from "../src/feishu";
import type { SiteRunResult } from "../src/types";

test("Creem 新商店通知包含官网、产品和价格", async () => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentText = JSON.parse(String(init?.body)).content.text;
    return Response.json({ code: 0 });
  };

  const result = {
    site: {
      id: "creem",
      name: "Creem 新公开商店",
      url: "https://www.creem.io/sitemap.xml",
    },
    baselineCreated: false,
    totalUrls: 323,
    newUrls: ["https://www.creem.io/stores/reply-fast"],
    analyses: [{
      url: "https://www.creem.io/stores/reply-fast",
      status: 200,
      title: "Reply Fast",
      h1: "Reply Fast",
      description: "Browse products from Reply Fast",
      keywords: ["reply fast"],
      external: {
        url: "https://replyfast.example/",
        status: 200,
        title: "Reply Fast",
        h1: "Reply Fast",
        description: "",
      },
      products: [
        { name: "Starter", price: "$9.00", url: "https://creem.io/product/prod_123" },
      ],
    }],
    omittedCount: 0,
  } satisfies SiteRunResult;

  try {
    await notifySiteResult("https://example.com/webhook", result);
    assert.match(sentText, /关联官网：https:\/\/replyfast\.example\//);
    assert.match(sentText, /公开产品（1 个）/);
    assert.match(sentText, /Starter：\$9\.00/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AITDK 通知列出 TabAPI 国家、趋势、来源和关键词", async () => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentText = JSON.parse(String(init?.body)).content.text;
    return Response.json({ code: 0 });
  };

  try {
    await notifyAitdkResults("https://example.com/webhook", {
      batchId: "creem-2026-08-24",
      batchStatus: "completed",
      queriedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      remainingUrls: 0,
      results: [{
        listingUrl: "https://creem.io/stores/example",
        domain: "example.com",
        cached: false,
        costCredits: 3,
        assessment: {
          qualified: true,
          title: "Example",
          description: "Example description",
          visits: 12_000,
          globalRank: 120_000,
          countryRank: { country: "US", rank: 40_000 },
          bounceRate: 0.42,
          pagesPerVisit: 2.3,
          timeOnSiteSeconds: 95,
          reportingMonth: "2026-07",
          registrationDate: "2026-02-01T00:00:00Z",
          searchShare: 0.35,
          directShare: 0.4,
          trafficSources: { direct: 0.4, search: 0.35, gen_ai: 0.03 },
          monthlyVisits: [{ month: "2026-07", visits: 12_000 }],
          topKeywords: [{ name: "watermark remover", volume: 500, cpc: 2.4, estimatedValue: 600 }],
          nonBrandKeywords: [{ name: "watermark remover", volume: 500, cpc: 2.4, estimatedValue: 600 }],
          topRegions: [{ country: "US", name: "United States", share: 0.45 }],
          aiTraffic: { trends: [{ name: "ChatGPT", history: [{ date: "2026-07-01", value: 0.03 }] }] },
        },
      }],
    });

    assert.match(sentText, /国家排名：US #40000/);
    assert.match(sentText, /注册时间：2026-02-01T00:00:00Z/);
    assert.match(sentText, /主要国家：United States（US，45\.0%）/);
    assert.match(sentText, /3 个月趋势：2026-07：12000/);
    assert.match(sentText, /AI 流量：ChatGPT（2026-07-01：3\.0%）/);
    assert.match(sentText, /watermark remover（搜索量 500，CPC \$2\.4，价值 \$600）/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
