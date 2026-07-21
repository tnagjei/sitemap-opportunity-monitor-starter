import assert from "node:assert/strict";
import test from "node:test";
import { extractPageFields } from "../src/page";

test("提取 title、h1 和 description", () => {
  const html = `<!doctype html><html><head><title>Free Tool &amp; Maker</title><meta content="Make things quickly" name="description"></head><body><h1><span>Free</span> Tool Maker</h1></body></html>`;
  assert.deepEqual(extractPageFields(html), {
    title: "Free Tool & Maker",
    h1: "Free Tool Maker",
    description: "Make things quickly",
  });
});
