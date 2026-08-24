import assert from "node:assert/strict";
import test from "node:test";
import { collectPageUrls, findNewUrls, filterUrlsByPrefix, parseSitemapXml } from "../src/sitemap";

const INDEX_XML = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://a.com/one.xml</loc></sitemap><sitemap><loc>https://a.com/bad.xml</loc></sitemap></sitemapindex>`;
const URLSET_XML = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.com/page</loc></url></urlset>`;
const CHALLENGE_HTML = `<html><body>Please wait while your request is being verified...</body></html>`;

function mockFetch(routes: Record<string, Response>): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    const response = routes[url];
    if (response) return response;
    return new Response("Not found", { status: 404 });
  };
  (globalThis as { __originalFetch?: typeof fetch }).__originalFetch = originalFetch;
}

function restoreFetch(): void {
  const originalFetch = (globalThis as { __originalFetch?: typeof fetch }).__originalFetch;
  if (originalFetch) globalThis.fetch = originalFetch;
}

test("解析普通 urlset", () => {
  const parsed = parseSitemapXml(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.com/a</loc></url><url><loc>https://a.com/b?x=1&amp;y=2</loc></url></urlset>`);
  assert.equal(parsed.kind, "urlset");
  assert.deepEqual(parsed.locations, ["https://a.com/a", "https://a.com/b?x=1&y=2"]);
});

test("解析 sitemap index", () => {
  const parsed = parseSitemapXml(`<sitemapindex><sitemap><loc>https://a.com/one.xml</loc></sitemap><sitemap><loc>https://a.com/two.xml</loc></sitemap></sitemapindex>`);
  assert.equal(parsed.kind, "index");
  assert.deepEqual(parsed.locations, ["https://a.com/one.xml", "https://a.com/two.xml"]);
});

test("只返回新增网址", () => {
  assert.deepEqual(findNewUrls(["a", "b", "c"], ["a", "c"]), ["b"]);
});

test("只保留 PMKG 站点详情页", () => {
  assert.deepEqual(
    filterUrlsByPrefix(
      [
        "https://www.pmkg.net/sites/7817.html",
        "https://www.pmkg.net/sitetag/ai/",
        "https://www.pmkg.net/sites/not-a-number.html",
      ],
      "https://www.pmkg.net/sites/",
    ),
    ["https://www.pmkg.net/sites/7817.html"],
  );
});

test("按通用网址前缀保留 Creem 商店详情页", () => {
  assert.deepEqual(
    filterUrlsByPrefix(
      [
        "https://www.creem.io/stores",
        "https://www.creem.io/stores/reply-fast",
        "https://www.creem.io/product/prod_123",
      ],
      "https://www.creem.io/stores/",
    ),
    ["https://www.creem.io/stores/reply-fast"],
  );
});

test("规范化 Sitemap 中含空格的网址", async () => {
  mockFetch({
    "https://a.com/sitemap.xml": new Response(
      "<urlset><url><loc>https://a.com/stores/xapi korea</loc></url></urlset>",
      { status: 200, headers: { "content-type": "application/xml" } },
    ),
  });
  try {
    assert.deepEqual(await collectPageUrls("https://a.com/sitemap.xml"), [
      "https://a.com/stores/xapi%20korea",
    ]);
  } finally {
    restoreFetch();
  }
});

test("子 Sitemap 返回验证页时跳过并继续收集", async () => {
  mockFetch({
    "https://a.com/index.xml": new Response(INDEX_XML, { status: 200, headers: { "content-type": "application/xml" } }),
    "https://a.com/one.xml": new Response(URLSET_XML, { status: 200, headers: { "content-type": "application/xml" } }),
    "https://a.com/bad.xml": new Response(CHALLENGE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
  });
  try {
    const urls = await collectPageUrls("https://a.com/index.xml", 50);
    assert.deepEqual(urls, ["https://a.com/page"]);
  } finally {
    restoreFetch();
  }
});

test("根 Sitemap 无法解析时仍然抛错", async () => {
  mockFetch({
    "https://a.com/sitemap.xml": new Response(CHALLENGE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
  });
  try {
    await assert.rejects(() => collectPageUrls("https://a.com/sitemap.xml", 50), /无法识别 Sitemap XML 类型/);
  } finally {
    restoreFetch();
  }
});
