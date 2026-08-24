import assert from "node:assert/strict";
import test from "node:test";
import { notifySiteResult } from "../src/feishu";
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
