import assert from "node:assert/strict";
import test from "node:test";
import { buildKeywordCandidates, slugKeyword } from "../src/keywords";

test("从 slug 生成关键词", () => {
  const cases = [
    ["https://example.com/ai-image-maker", "ai image maker"],
    ["https://example.com/photo-editor-online", "photo editor online"],
    ["https://example.com/image_to_video_ai", "image to video ai"],
    ["https://example.com/free--logo--maker", "free logo maker"],
    ["https://example.com/keyword", "keyword"],
    ["https://example.com/ai-image-maker/?ref=test#section", "ai image maker"],
  ] as const;

  for (const [url, expected] of cases) {
    assert.equal(slugKeyword(url), expected);
  }
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
