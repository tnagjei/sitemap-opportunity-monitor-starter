import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index";
import { createAitdkBatch } from "../src/aitdk";
import type { Env } from "../src/types";

test("受保护接口批准指定 AITDK 批次", async () => {
  const batch = createAitdkBatch("pmkg", Array.from({ length: 21 }, (_, index) => `https://pmkg.test/${index}`), new Date("2026-08-24T00:00:00Z"));
  const values = new Map([[`aitdk:batch:${batch.id}`, JSON.stringify(batch)]]);
  const env = {
    SNAPSHOTS: {
      get: async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
    MANUAL_RUN_SECRET: "manual-secret",
  } as unknown as Env;

  const unauthorized = await worker.fetch(
    new Request("https://worker.test/aitdk/approve", {
      method: "POST",
      body: JSON.stringify({ batchId: batch.id }),
    }),
    env,
  );
  assert.equal(unauthorized.status, 401);

  const approved = await worker.fetch(
    new Request("https://worker.test/aitdk/approve", {
      method: "POST",
      headers: {
        authorization: "Bearer manual-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ batchId: batch.id }),
    }),
    env,
  );
  assert.equal(approved.status, 200);
  assert.equal(JSON.parse(values.get(`aitdk:batch:${batch.id}`) ?? "{}").status, "approved");
});

test("受保护接口手动处理 AITDK 队列", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("ok"));
  const env = {
    SNAPSHOTS: {
      list: async () => ({ keys: [] }),
    },
    FEISHU_WEBHOOK: "https://feishu.test/webhook",
    MANUAL_RUN_SECRET: "manual-secret",
    SITEDATA_API_KEY: "sitedata-secret",
  } as unknown as Env;

  const response = await worker.fetch(
    new Request("https://worker.test/aitdk/run", {
      method: "POST",
      headers: { authorization: "Bearer manual-secret" },
    }),
    env,
  );

  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.match(String(body.ranAt), /^2026-|^2027-/);
  assert.deepEqual({ ...body, ranAt: undefined }, {
    ranAt: undefined,
    queriedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    remainingUrls: 0,
    results: [],
  });
});
