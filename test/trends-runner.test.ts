import assert from "node:assert/strict";
import test from "node:test";
import { runTrendsMonitor } from "../src/runner";
import type { Env } from "../src/types";

const TRENDS_GUARD = ")]}',\n";

function trendsDailyPayload(lowValue: number, highValue: number): string {
  const values = [...Array(14).fill(lowValue), ...Array(8).fill(highValue)];
  // 最后一个点放在今天：取数后今天会被剔除，剩 21 个完整日。
  const todayStart = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
  const start = todayStart - (values.length - 1) * 86_400;
  const timeline = values.map((value, index) => ({
    time: String(start + index * 86_400),
    value: [value],
    hasData: [true],
  }));
  return `${TRENDS_GUARD}${JSON.stringify({ default: { timelineData: timeline } })}`;
}

function trendsEnv(values: Map<string, string>, keywords: Array<{ keyword: string; geo?: string }>): Env {
  return {
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
    TRENDS_KEYWORDS: JSON.stringify(keywords),
    TRENDS_NOISE_FLOOR: "3",
    TRENDS_DOUBLING_FACTOR: "2",
    TRENDS_RETRY_DELAY_MS: "1",
  } as unknown as Env;
}

const TREND_KEYWORDS = [{ keyword: "pdf to word" }, { keyword: "背景移除", geo: "CN" }];

type SeriesRange = { low: number; high: number };

/**
 * 探索请求的 req 参数里带关键词，据此决定该词的时间序列；
 * multiline 请求不含关键词，按 explore 的顺序排队返回。
 */
function mockTrendsFetch(
  sentTexts: string[],
  seriesByKeyword: Map<string, SeriesRange>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const pending: string[] = [];
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://trends.google.com/") {
      return new Response("ok", { headers: { "set-cookie": "NID=test-nid; Path=/" } });
    }
    if (url.includes("/trends/api/explore")) {
      const reqParam = new URL(url).searchParams.get("req") ?? "{}";
      const keyword = (JSON.parse(reqParam).comparisonItem?.[0]?.keyword as string | undefined) ?? "";
      const range = seriesByKeyword.get(keyword) ?? { low: 2, high: 10 };
      pending.push(trendsDailyPayload(range.low, range.high));
      return new Response(
        `${TRENDS_GUARD}${JSON.stringify({
          widgets: [{ request: "{}", token: "tok", type: "LINE", id: "TIMESERIES" }],
        })}`,
      );
    }
    if (url.includes("/trends/api/widgetdata/multiline")) {
      return new Response(pending.shift() ?? trendsDailyPayload(2, 10));
    }
    sentTexts.push(JSON.parse(String(init?.body)).content.text);
    return Response.json({ code: 0 });
  };
}

test("首次运行只建立基线，不发送翻倍告警", async () => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  const values = new Map<string, string>();
  globalThis.fetch = mockTrendsFetch(sentTexts, new Map([["pdf to word", { low: 2, high: 10 }], ["背景移除", { low: 2, high: 10 }]]));

  try {
    const report = await runTrendsMonitor(trendsEnv(values, TREND_KEYWORDS), new Date("2026-09-07T13:00:00.000Z"));
    assert.equal(report.baselineCreated, true);
    assert.equal(report.doubled.length, 0);
    assert.equal(report.baselines.length, 2);
    assert.match(sentTexts[0] ?? "", /基线/);
    assert.match(sentTexts[0] ?? "", /2 个关键词/);
    const snapshot = JSON.parse(values.get("trends:weekly:snapshot") ?? "{}");
    assert.equal(Object.keys(snapshot.keywords).length, 2);
    assert.equal(snapshot.keywords["pdf to word"].last7Mean, 10);
    assert.equal(snapshot.keywords["背景移除|cn"].last7Mean, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("翻倍词触发告警并附趋势链接，未翻倍词只汇总", async () => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  const values = new Map<string, string>();
  globalThis.fetch = mockTrendsFetch(sentTexts, new Map([["pdf to word", { low: 2, high: 10 }], ["背景移除", { low: 2, high: 10 }]]));

  try {
    await runTrendsMonitor(trendsEnv(values, TREND_KEYWORDS), new Date("2026-09-07T13:00:00.000Z"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const sentTextsSecond: string[] = [];
  globalThis.fetch = mockTrendsFetch(
    sentTextsSecond,
    new Map([["pdf to word", { low: 10, high: 25 }], ["背景移除", { low: 10, high: 10 }]]),
  );

  try {
    const report = await runTrendsMonitor(trendsEnv(values, TREND_KEYWORDS), new Date("2026-09-14T13:00:00.000Z"));
    assert.equal(report.baselineCreated, false);
    assert.equal(report.doubled.length, 1);
    assert.equal(report.doubled[0]?.keyword, "pdf to word");
    assert.equal(report.unchanged.length, 1);
    assert.equal(report.unchanged[0]?.keyword, "背景移除");

    const text = sentTextsSecond.join("\n");
    assert.match(text, /翻倍告警/);
    assert.match(text, /pdf to word/);
    assert.match(text, /2\.5 倍/);
    assert.match(text, /趋势：https:\/\/trends\.google\.com/);

    const snapshot = JSON.parse(values.get("trends:weekly:snapshot") ?? "{}");
    assert.equal(snapshot.keywords["pdf to word"].last7Mean, 25);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("新增词进入基线列表，不影响已有词判定", async () => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  const values = new Map<string, string>();
  const flat = new Map([["pdf to word", { low: 2, high: 10 }], ["背景移除", { low: 2, high: 10 }]]);
  globalThis.fetch = mockTrendsFetch(sentTexts, flat);

  try {
    await runTrendsMonitor(trendsEnv(values, TREND_KEYWORDS), new Date("2026-09-07T13:00:00.000Z"));
    const report = await runTrendsMonitor(
      trendsEnv(values, [...TREND_KEYWORDS, { keyword: "new keyword" }]),
      new Date("2026-09-14T13:00:00.000Z"),
    );
    assert.equal(report.baselines.length, 1);
    assert.equal(report.baselines[0]?.keyword, "new keyword");
    assert.equal(report.doubled.length, 0);
    assert.equal(report.unchanged.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("取数失败时发送错误通知且不覆盖旧快照", async () => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  const values = new Map<string, string>();
  globalThis.fetch = mockTrendsFetch(sentTexts, new Map([["pdf to word", { low: 2, high: 10 }], ["背景移除", { low: 2, high: 10 }]]));

  try {
    await runTrendsMonitor(trendsEnv(values, TREND_KEYWORDS), new Date("2026-09-07T13:00:00.000Z"));
  } finally {
    globalThis.fetch = originalFetch;
  }
  const snapshotBefore = values.get("trends:weekly:snapshot");

  const sentTextsSecond: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://trends.google.com")) return new Response("rate limited", { status: 429 });
    sentTextsSecond.push(JSON.parse(String(init?.body)).content.text);
    return Response.json({ code: 0 });
  };

  try {
    const report = await runTrendsMonitor(trendsEnv(values, TREND_KEYWORDS), new Date("2026-09-14T13:00:00.000Z"));
    assert.ok(report.error);
    assert.equal(values.get("trends:weekly:snapshot"), snapshotBefore);
    assert.match(sentTextsSecond.join("\n"), /Google Trends 周监控失败/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("上周均值低于噪声下限时不告警，即使倍数很大", async () => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  const values = new Map<string, string>();
  const quiet = new Map([["pdf to word", { low: 1, high: 10 }], ["背景移除", { low: 1, high: 10 }]]);
  globalThis.fetch = mockTrendsFetch(sentTexts, quiet);

  try {
    await runTrendsMonitor(trendsEnv(values, TREND_KEYWORDS), new Date("2026-09-07T13:00:00.000Z"));
    const report = await runTrendsMonitor(trendsEnv(values, TREND_KEYWORDS), new Date("2026-09-14T13:00:00.000Z"));
    assert.equal(report.doubled.length, 0);
    assert.equal(report.unchanged.length, 2);
    assert.equal(report.unchanged[0]?.multiple, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("稀疏长尾词只记基线，不会让整轮取数失败", async () => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  const values = new Map<string, string>();
  // 复刻线上 Stairs Sort：32 天里只有 13 天有数据，其余 hasData=false。
  const todayStart = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
  const raw = (() => {
    const days = 32;
    const firstActive = days - 13;
    const valuesAtDay: number[] = [];
    for (let day = 0; day < days; day += 1) {
      valuesAtDay.push(day >= firstActive ? 5 + (day % 3) * 4 : 0);
    }
    return valuesAtDay;
  })();
  const start = todayStart - (raw.length - 1) * 86_400;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://trends.google.com/") {
      return new Response("ok", { headers: { "set-cookie": "NID=test-nid; Path=/" } });
    }
    if (url.includes("/trends/api/explore")) {
      return new Response(
        `${TRENDS_GUARD}${JSON.stringify({
          widgets: [{ request: "{}", token: "tok", type: "LINE", id: "TIMESERIES" }],
        })}`,
      );
    }
    if (url.includes("/trends/api/widgetdata/multiline")) {
      const timeline = raw.map((value, index) => ({
        time: String(start + index * 86_400),
        value: [value],
        hasData: [value > 0],
      }));
      return new Response(`${TRENDS_GUARD}${JSON.stringify({ default: { timelineData: timeline } })}`);
    }
    sentTexts.push(JSON.parse(String(init?.body)).content.text);
    return Response.json({ code: 0 });
  };

  try {
    const report = await runTrendsMonitor(trendsEnv(values, [{ keyword: "Stairs Sort" }]));
    assert.equal(report.error, undefined);
    assert.equal(report.keywordCount, 1);
    assert.equal(report.baselines.length, 1);
    assert.equal(values.has("trends:weekly:snapshot"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
