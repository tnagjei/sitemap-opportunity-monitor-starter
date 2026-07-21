import assert from "node:assert/strict";
import test from "node:test";
import { findNewUrls, parseSitemapXml } from "../src/sitemap";

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
