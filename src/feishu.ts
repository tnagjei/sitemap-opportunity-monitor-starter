import { googleTrendsUrl } from "./keywords";
import type { PageAnalysis, SiteRunResult } from "./types";

const MAX_MESSAGE_CHARS = 15_000;

function formatAnalysis(item: PageAnalysis, index: number): string {
  const lines = [
    `${index}. ${item.url}`,
    `状态码：${item.status ?? "未知"}`,
  ];
  if (item.title) lines.push(`Title：${item.title}`);
  if (item.h1) lines.push(`H1：${item.h1}`);
  if (item.description) lines.push(`Description：${item.description.slice(0, 240)}`);
  if (item.error) lines.push(`异常：${item.error}`);

  if (item.keywords.length > 0) {
    lines.push("候选关键词：");
    for (const keyword of item.keywords) {
      lines.push(`• ${keyword}`);
      lines.push(`  趋势：${googleTrendsUrl(keyword)}`);
    }
  }
  return lines.join("\n");
}

function buildMessages(result: SiteRunResult): string[] {
  const header = [
    `【${result.site.name} Sitemap 新页面】`,
    `Sitemap：${result.site.url}`,
    `当前页面总数：${result.totalUrls}`,
    `新增页面：${result.newUrls.length}`,
    result.omittedCount > 0 ? `本次仅分析前 ${result.analyses.length} 个，另有 ${result.omittedCount} 个未展开。` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const blocks = result.analyses.map(formatAnalysis);
  const messages: string[] = [];
  let current = header;

  for (const block of blocks) {
    const next = `${current}\n\n${block}`;
    if (next.length > MAX_MESSAGE_CHARS && current !== header) {
      messages.push(current);
      current = `【${result.site.name} 续】\n\n${block}`;
    } else {
      current = next;
    }
  }

  messages.push(current);
  return messages;
}

async function sendText(webhook: string, text: string): Promise<void> {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`飞书 Webhook 请求失败 ${response.status}: ${responseText.slice(0, 300)}`);
  }

  try {
    const payload = JSON.parse(responseText) as { code?: number; StatusCode?: number; msg?: string };
    const code = payload.code ?? payload.StatusCode ?? 0;
    if (code !== 0) throw new Error(`飞书返回错误 ${code}: ${payload.msg ?? responseText}`);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

export async function notifySiteResult(webhook: string, result: SiteRunResult): Promise<void> {
  for (const message of buildMessages(result)) {
    await sendText(webhook, message);
  }
}

export async function notifyNoNewPages(
  webhook: string,
  siteName: string,
  siteUrl: string,
  totalUrls: number,
): Promise<void> {
  const message = [
    `【${siteName} Sitemap 监控】`,
    `Sitemap：${siteUrl}`,
    `当前页面总数：${totalUrls}`,
    `今日无新增页面。`,
  ].join("\n");
  await sendText(webhook, message);
}

export async function notifyError(webhook: string, siteName: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sendText(webhook, `【Sitemap 监控失败】\n站点：${siteName}\n错误：${message.slice(0, 2000)}`);
}
