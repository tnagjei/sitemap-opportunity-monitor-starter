import assert from "node:assert/strict";
import test from "node:test";
import { renderReportPage } from "../src/report";
import type { SiteReport } from "../src/types";

test("日报页渲染新增页面并转义 HTML", () => {
  const report: SiteReport = {
    siteId: "aihotwords",
    siteName: "AI Hot Words",
    siteUrl: "https://aihotwords.com/sitemap.xml",
    order: 0,
    date: "2026-11-04",
    scannedAt: "2026-11-04T01:05:00.000Z",
    totalUrls: 1128,
    omittedCount: 0,
    skippedNonEnglishCount: 0,
    analyses: [{
      url: "https://aihotwords.com/t/bad",
      slug: "bad",
      keyword: 'x <script>alert("1")</script>',
      focus: true,
      status: 200,
      title: "",
      h1: "",
      description: "",
      keywords: [],
    }],
  };

  const html = renderReportPage([report]);
  assert.match(html, /AI Hot Words/);
  assert.match(html, /2026-11-04 · 存量 1128 · 新增 1/);
  assert.match(html, /class="tag focus">重点/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("没有数据时给出等待提示", () => {
  assert.match(renderReportPage([]), /还没有数据/);
});
