import assert from "node:assert/strict";
import test from "node:test";
import {
  computeTrendStats,
  detectDoubling,
  fetchNidCookie,
  fetchTrendSeries,
  parseTrendSeries,
  stripTrendsGuard,
  TRENDS_TIME_RANGE,
} from "../src/trends";
import { parseTrendKeywords } from "../src/config";
import type { Env } from "../src/types";

const GUARD = ")]}',\n"; // 测试夹具用的带逗号形式
const LIVE_GUARD = ")]}'\n"; // 线上实际返回的形式（无逗号）

const DAY = 86_400;
// 用测试启动时刻当作“现在”，把最后一个数据点放在今天（未走完的那天）。
const NOW_MS = Date.now();
const TODAY_START = Math.floor(NOW_MS / 1000 / DAY) * DAY;

function daySeriesToText(
  values: number[],
  endDayOffsetFromToday: number,
  hasData: boolean[] = values.map(() => true),
): string {
  const start = TODAY_START + (endDayOffsetFromToday - (values.length - 1)) * DAY;
  const timeline = values.map((value, index) => ({
    time: String(start + index * DAY),
    value: [value],
    hasData: [hasData[index]],
  }));
  return `${GUARD}${JSON.stringify({ default: { timelineData: timeline } })}`;
}

/** 最后一个点是今天（不完整），剔除后只剩前面的完整日。 */
function dailySeries(values: number[]): string {
  return daySeriesToText(values, 0);
}

test("stripTrendsGuard 去掉带逗号与不带逗号两种前缀", () => {
  assert.equal(stripTrendsGuard(`${GUARD}{"a":1}`), `{"a":1}`);
  assert.equal(stripTrendsGuard(`${LIVE_GUARD}{"a":1}`), `{"a":1}`);
  assert.equal(stripTrendsGuard(`{"a":1}`), `{"a":1}`);
});

test("parseTrendSeries 解析日级数据并剔除不完整当天", () => {
  const series = parseTrendSeries(dailySeries([5, 6, 7]), NOW_MS);
  assert.equal(series.resolution, "hourly"); // only 2 remaining points, < 14 days span
  assert.equal(series.points.length, 2);
  assert.deepEqual(series.points.map((point) => point.value), [5, 6]);
});

test("parseTrendSeries 在 Google 已过滤今天时不会多剔掉昨天", () => {
  const nowMs = TODAY_START * 1000 + 3600_000;
  const values = [8, 9, 0];
  const series = parseTrendSeries(daySeriesToText(values, 0, [true, true, false]), nowMs);
  // 今天是 hasData=false，本来就会被跳过；昨天必须留下。
  assert.deepEqual(series.points.map((point) => point.value), [8, 9]);
  assert.deepEqual(series.points.map((point) => point.time), [
    String(TODAY_START - 2 * DAY),
    String(TODAY_START - DAY),
  ]);
});

test("parseTrendSeries 优先按 isPartial 剔除未走完的当天", () => {
  const nowMs = TODAY_START * 1000 + 3600_000;
  const payload = {
    default: {
      timelineData: [
        { time: String(TODAY_START - 2 * DAY), value: [8], hasData: [true] },
        { time: String(TODAY_START - DAY), value: [9], hasData: [true] },
        // 时间戳故意错位，确认 isPartial 自己就能拦住这个点。
        { time: String(TODAY_START - DAY), value: [1], hasData: [true], isPartial: true },
      ],
    },
  };
  const series = parseTrendSeries(`${GUARD}${JSON.stringify(payload)}`, nowMs);
  assert.deepEqual(series.points.map((point) => point.value), [8, 9]);
});

test("parseTrendSeries 跳过 value 缺失的点，hasData false 的天按 0 计入", () => {
  const payload = {
    default: {
      timelineData: [
        { time: "100", value: [4], hasData: [true] },
        { time: "200", value: [null], hasData: [true] },
        { time: "300", value: [9], hasData: [false] },
        { time: "400", value: [8], hasData: [true] },
        { time: "500", value: [7], hasData: [true] },
      ],
    },
  };
  const series = parseTrendSeries(`${GUARD}${JSON.stringify(payload)}`);
  // 时间戳远早于今天，不额外剔除。hasData=false 的 9 变成 0，保住天数。
  assert.deepEqual(series.points.map((point) => point.value), [4, 0, 8, 7]);
});

test("稀疏长尾词：多数天没有搜索量时仍能算出完整周均值", () => {
  // 线上 Stairs Sort 的真实形状：32 天里只有 13 天有数据，其余 hasData=false。
  const raw = [
    ...Array(17).fill(0), // 更早的日子没有搜索量
    0, 0, 6, 6, 6, 6, 6, // prev7：7 天里有 2 天为 0
    12, 12, 12, 12, 12, 12, 12, // last7
    0, // 今天未走完，必须剔除
  ];
  const hasData = raw.map((value) => value > 0);
  const series = parseTrendSeries(daySeriesToText(raw, 0, hasData), NOW_MS);
  assert.equal(series.points.length, 31); // 天数保住了，没有因为稀疏塌缩到 14 天以下
  const stats = computeTrendStats(series);
  assert.equal(stats.last7Mean, 12);
  assert.ok(Math.abs(stats.prev7Mean - 30 / 7) < 1e-9); // 0 天照常参与平均
  assert.equal(detectDoubling(stats, { noiseFloor: 3, doublingFactor: 2 }).status, "doubled");
});

test("computeTrendStats 计算近 7 天与前 7 天均值", () => {
  // 22 raw days = 14 low + 8 high; after trimming the partial day: prev7 = low, last7 = high
  const series = parseTrendSeries(dailySeries([...Array(14).fill(2), ...Array(8).fill(10)]), NOW_MS);
  const stats = computeTrendStats(series);
  assert.equal(stats.prev7Mean, 2);
  assert.equal(stats.last7Mean, 10);
});

test("computeTrendStats 数据不足 14 天时抛错", () => {
  const series = parseTrendSeries(dailySeries(Array(14).fill(5)), NOW_MS); // 13 after day trim
  assert.throws(() => computeTrendStats(series), /不足 14 天/);
});

test("detectDoubling 达到倍数且上周均值达到噪声下限时告警", () => {
  const result = detectDoubling({ last7Mean: 10, prev7Mean: 5 }, { noiseFloor: 3, doublingFactor: 2 });
  assert.equal(result.status, "doubled");
  assert.equal(result.multiple, 2);
});

test("detectDoubling 低于 2 倍不告警", () => {
  const result = detectDoubling({ last7Mean: 9.4, prev7Mean: 5 }, { noiseFloor: 3, doublingFactor: 2 });
  assert.equal(result.status, "unchanged");
});

test("detectDoubling 上周均值低于噪声下限时即使 100 倍也不告警", () => {
  const result = detectDoubling({ last7Mean: 10, prev7Mean: 1 }, { noiseFloor: 3, doublingFactor: 2 });
  assert.equal(result.status, "unchanged");
  assert.equal(result.multiple, null);
});

function trendsExploreResponse(): string {
  return `${GUARD}${JSON.stringify({
    // 线上接口的 request 是对象，不是字符串。
    widgets: [
      {
        request: { time: TRENDS_TIME_RANGE, resolution: "DAY", comparisonItem: [] },
        token: "tok123",
        type: "LINE",
        id: "TIMESERIES",
      },
    ],
  })}`;
}

function mockTrendsFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://trends.google.com/") {
      return new Response("ok", { headers: { "set-cookie": "NID=abc123; Path=/; Domain=.google.com" } });
    }
    if (url.includes("/trends/api/explore")) {
      assert.equal((init?.headers as Record<string, string>).cookie, "NID=abc123");
      return new Response(trendsExploreResponse());
    }
    if (url.includes("/trends/api/widgetdata/multiline")) {
      return new Response(dailySeries([...Array(14).fill(2), ...Array(8).fill(10)]));
    }
    throw new Error(`意外的请求: ${url}`);
  };
  return { calls };
}

test("fetchNidCookie 提取 NID cookie", async () => {
  const originalFetch = globalThis.fetch;
  try {
    mockTrendsFetch();
    assert.equal(await fetchNidCookie(), "NID=abc123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchNidCookie 无 NID 时返回空串", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("ok");
    assert.equal(await fetchNidCookie(), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTrendSeries 走 explore→multiline 两步并带上 cookie", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { calls } = mockTrendsFetch();
    const series = await fetchTrendSeries("pdf to word", undefined, "NID=abc123");
    assert.equal(calls.length, 2);
    assert.match(calls[0] ?? "", /\/trends\/api\/explore/);
    assert.match(String(calls[0]), /keyword%22%3A%22pdf\+to\+word/);
    // 回归点：Google 只接受预设区间，自定义天数（today 60-d）会直接 400。
    const exploreReq = new URL(calls[0] ?? "").searchParams.get("req") ?? "";
    assert.match(TRENDS_TIME_RANGE, /^(now|today) /);
    assert.equal(JSON.parse(exploreReq).comparisonItem[0].time, TRENDS_TIME_RANGE);
    assert.match(calls[1] ?? "", /\/trends\/api\/widgetdata\/multiline.*token=tok123/);
    // 回归点：request 是对象时必须序列化成 JSON，否则会变成 [object Object] 并 400。
    const multilineReq = new URL(calls[1] ?? "").searchParams.get("req") ?? "";
    assert.equal(JSON.parse(multilineReq).resolution, "DAY");
    assert.equal(series.points.length, 21); // 22 days minus partial today
    assert.equal(series.resolution, "daily");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTrendSeries 429 后重试一次成功", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let exploreCalls = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/trends/api/explore")) {
        exploreCalls += 1;
        if (exploreCalls === 1) return new Response("rate limited", { status: 429 });
        return new Response(trendsExploreResponse());
      }
      if (url.includes("/trends/api/widgetdata/multiline")) {
        return new Response(dailySeries([...Array(14).fill(2), ...Array(8).fill(10)]));
      }
      throw new Error(`意外的请求: ${url}`);
    };
    const series = await fetchTrendSeries("kw", undefined, "", 1);
    assert.equal(series.points.length, 21);
    assert.equal(exploreCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTrendSeries 重试仍 429 时抛错", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    await assert.rejects(() => fetchTrendSeries("kw", undefined, "", 1), /已重试一次/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseTrendKeywords 校验合法配置", () => {
  const env = {
    TRENDS_KEYWORDS: JSON.stringify([
      { keyword: "pdf to word" },
      { keyword: "背景移除", geo: "CN" },
    ]),
  } as unknown as Env;
  const parsed = parseTrendKeywords(env);
  assert.deepEqual(parsed, [
    { keyword: "pdf to word", geo: undefined },
    { keyword: "背景移除", geo: "CN" },
  ]);
});

test("parseTrendKeywords 拒绝重复、空值与非法 geo", () => {
  const env = {
    TRENDS_KEYWORDS: JSON.stringify([{ keyword: "same" }, { keyword: "SAME" }]),
  } as unknown as Env;
  assert.throws(() => parseTrendKeywords(env), /重复/);

  const empty = { TRENDS_KEYWORDS: JSON.stringify([{ keyword: "  " }]) } as unknown as Env;
  assert.throws(() => parseTrendKeywords(empty), /为空或超过/);

  const badGeo = { TRENDS_KEYWORDS: JSON.stringify([{ keyword: "ok", geo: "usa!" }]) } as unknown as Env;
  assert.throws(() => parseTrendKeywords(badGeo), /geo 不合法/);
});

test("parseTrendKeywords 拒绝非 JSON 与空数组", () => {
  assert.throws(() => parseTrendKeywords({ TRENDS_KEYWORDS: "not json" } as unknown as Env), /不是合法 JSON/);
  assert.throws(() => parseTrendKeywords({ TRENDS_KEYWORDS: "[]" } as unknown as Env), /至少需要一个关键词/);
});
