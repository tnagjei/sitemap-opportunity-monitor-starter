import assert from "node:assert/strict";
import test from "node:test";
import { analyzePage, extractPageFields, extractExternalUrl } from "../src/page";

test("提取 title、h1 和 description", () => {
  const html = `<!doctype html><html><head><title>Free Tool &amp; Maker</title><meta content="Make things quickly" name="description"></head><body><h1><span>Free</span> Tool Maker</h1></body></html>`;
  assert.deepEqual(extractPageFields(html), {
    title: "Free Tool & Maker",
    h1: "Free Tool Maker",
    description: "Make things quickly",
  });
});

test("从 PMKG 跳转链接提取提交的网站", () => {
  const html = `<a href="https://www.pmkg.net/go/?url=aHR0cHM6Ly9leGFtcGxlLmNvbQ%3D%3D">主站</a><a href="https://www.pmkg.net/go/?url=aHR0cHM6Ly9kb2NzLmV4YW1wbGUuY29t">文档</a>`;
  assert.equal(extractExternalUrl(html), "https://example.com");
});

test("分析 PMKG 条目时补抓提交网站", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    if (String(input) === "https://www.pmkg.net/sites/1.html") {
      return new Response(
        `<title>PMKG 条目</title><h1>PMKG 条目</h1><a href="https://www.pmkg.net/go/?url=aHR0cHM6Ly9leGFtcGxlLmNvbQ%3D%3D">访问网站</a>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response("<title>Example</title><h1>Example home</h1>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  try {
    const result = await analyzePage("https://www.pmkg.net/sites/1.html", true);
    assert.deepEqual(result.external, {
      url: "https://example.com",
      status: 200,
      title: "Example",
      h1: "Example home",
      description: "",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
