import assert from "node:assert/strict";
import test from "node:test";
import { buildKeywordCandidates, slugKeyword } from "../src/keywords";

test("从 slug 生成关键词", () => {
  assert.equal(slugKeyword("https://example.com/tools/youtube-thumbnail-maker/"), "youtube thumbnail maker");
});

test("候选关键词去重", () => {
  assert.deepEqual(
    buildKeywordCandidates(
      "https://example.com/youtube-thumbnail-maker",
      "YouTube Thumbnail Maker | Example",
      "YouTube Thumbnail Maker",
    ),
    ["youtube thumbnail maker"],
  );
});
