import assert from "node:assert/strict";
import test from "node:test";
import { collectPageUrls, findNewUrls, filterUrlsByPrefix, parseSitemapXml, extractUrlLanguage, parseLangPrefix, partitionLanguageUrls } from "../src/sitemap";

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

test("解析多语言路径与英文归一化", () => {
  assert.equal(parseLangPrefix("pt")?.isEnglish, false);
  assert.equal(parseLangPrefix("pt")?.lang, "pt");
  assert.equal(parseLangPrefix("de")?.isEnglish, false);
  assert.equal(parseLangPrefix("en")?.isEnglish, true);
  assert.equal(parseLangPrefix("en-US")?.isEnglish, true);
  assert.equal(parseLangPrefix("blog"), null);
  assert.equal(parseLangPrefix("square-crop"), null);

  const ptInfo = extractUrlLanguage("https://imagy.app/pt/ai-camera-angle-changer/");
  assert.equal(ptInfo.isNonEnglish, true);
  assert.equal(ptInfo.lang, "pt");
  assert.equal(ptInfo.normalizedKey, "https://imagy.app/ai-camera-angle-changer");

  const enInfo = extractUrlLanguage("https://imagy.app/ai-camera-angle-changer/");
  assert.equal(enInfo.isNonEnglish, false);
  assert.equal(enInfo.normalizedKey, "https://imagy.app/ai-camera-angle-changer");

  const enPrefixedInfo = extractUrlLanguage("https://imagy.app/en/ai-camera-angle-changer/");
  assert.equal(enPrefixedInfo.isNonEnglish, false);
  assert.equal(enPrefixedInfo.normalizedKey, "https://imagy.app/ai-camera-angle-changer");
});

test("partitionLanguageUrls 只保留英文并将非英文归并在对应英文页面上", () => {
  const urls = [
    "https://imagy.app/ai-camera-angle-changer/",
    "https://imagy.app/pt/ai-camera-angle-changer/",
    "https://imagy.app/de/ai-camera-angle-changer/",
    "https://imagy.app/es/ai-camera-angle-changer/",
    "https://imagy.app/other-tool/",
    "https://imagy.app/fr/unmatched-tool/",
  ];
  const result = partitionLanguageUrls(urls);

  assert.deepEqual(result.englishUrls, [
    "https://imagy.app/ai-camera-angle-changer/",
    "https://imagy.app/other-tool/",
  ]);
  assert.deepEqual(result.skippedNonEnglishUrls, [
    "https://imagy.app/pt/ai-camera-angle-changer/",
    "https://imagy.app/de/ai-camera-angle-changer/",
    "https://imagy.app/es/ai-camera-angle-changer/",
    "https://imagy.app/fr/unmatched-tool/",
  ]);
  assert.deepEqual(
    result.variantsByUrl.get("https://imagy.app/ai-camera-angle-changer/"),
    ["pt", "de", "es"],
  );
  assert.deepEqual(result.unmatchedNonEnglishUrls, [
    "https://imagy.app/fr/unmatched-tool/",
  ]);
});


test("纯小语种站点自动识别主语种与显式配置支持", () => {
  // 1. 自动识别纯德语站点
  const germanSiteAllUrls = [
    "https://example.de/de/tool-1",
    "https://example.de/de/tool-2",
    "https://example.de/fr/tool-2",
  ];
  const newUrls = [
    "https://example.de/de/tool-3",
    "https://example.de/fr/tool-3",
  ];
  const resAuto = partitionLanguageUrls(newUrls, { allUrls: germanSiteAllUrls });
  assert.equal(resAuto.isPureMinorityLanguageSite, true);
  assert.equal(resAuto.primaryLanguage, "de");
  assert.deepEqual(resAuto.englishUrls, ["https://example.de/de/tool-3"]);
  assert.deepEqual(resAuto.skippedNonEnglishUrls, ["https://example.de/fr/tool-3"]);
  assert.deepEqual(resAuto.variantsByUrl.get("https://example.de/de/tool-3"), ["fr"]);

  // 2. 显式配置 targetLang 为 all
  const resAll = partitionLanguageUrls(newUrls, { targetLang: "all" });
  assert.equal(resAll.primaryLanguage, "all");
  assert.deepEqual(resAll.englishUrls, newUrls);
  assert.equal(resAll.skippedNonEnglishUrls.length, 0);

  // 3. 显式配置 targetLang 为指定小语种
  const resExplicit = partitionLanguageUrls(newUrls, { targetLang: "fr" });
  assert.equal(resExplicit.primaryLanguage, "fr");
  assert.deepEqual(resExplicit.englishUrls, ["https://example.de/fr/tool-3"]);
  assert.deepEqual(resExplicit.skippedNonEnglishUrls, ["https://example.de/de/tool-3"]);
});

