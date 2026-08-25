import { googleTrendsUrl } from "./keywords";
import type { AitdkBatch, AitdkQueueSummary } from "./aitdk";
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
  if (item.external) {
    lines.push(`关联官网：${item.external.url}`);
    lines.push(`关联官网状态码：${item.external.status ?? "未知"}`);
    if (item.external.title) lines.push(`关联官网 Title：${item.external.title}`);
    if (item.external.h1) lines.push(`关联官网 H1：${item.external.h1}`);
    if (item.external.description) lines.push(`关联官网 Description：${item.external.description.slice(0, 240)}`);
    if (item.external.error) lines.push(`关联官网异常：${item.external.error}`);
  }
  if (item.products?.length) {
    const shownProducts = item.products.slice(0, 10);
    lines.push(`公开产品（${item.products.length} 个）：`);
    for (const product of shownProducts) {
      lines.push(`• ${product.name}：${product.price}`);
      lines.push(`  产品页：${product.url}`);
    }
    if (item.products.length > shownProducts.length) {
      lines.push(`另有 ${item.products.length - shownProducts.length} 个产品未展开。`);
    }
  }

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

export async function notifyDailyMonitorStarted(webhook: string, date: string, siteCount: number): Promise<void> {
  await sendText(
    webhook,
    `【Sitemap 每日监控开始】\n日期：${date}\n已创建 ${siteCount} 个站点的逐站扫描队列，每 5 分钟处理一个。`,
  );
}

export async function notifyDailyMonitorCompleted(
  webhook: string,
  date: string,
  completedCount: number,
  failedCount: number,
): Promise<void> {
  await sendText(
    webhook,
    `【Sitemap 每日监控完成】\n日期：${date}\n成功：${completedCount} 个站点\n失败：${failedCount} 个站点`,
  );
}

export async function notifyAitdkBatch(webhook: string, batch: AitdkBatch): Promise<void> {
  const approval = batch.status === "pending_approval"
    ? `需要批准。在 Codex 回复：批准 AITDK 批次 ${batch.id}`
    : "20 个以内，已自动批准。";
  await sendText(
    webhook,
    [
      "【AITDK 待验证批次】",
      `批次 ID：${batch.id}`,
      `待验证条目：${batch.urls.length}`,
      `预计最多消耗：${batch.estimatedCredits} 积分`,
      approval,
    ].join("\n"),
  );
}

export async function notifyAitdkResults(webhook: string, summary: AitdkQueueSummary): Promise<void> {
  if (!summary.batchId || summary.results.length === 0) return;
  const lines = [
    "【AITDK 流量验证】",
    `批次 ID：${summary.batchId}`,
    `本轮实际查询：${summary.queriedCount}`,
    `缓存或跳过：${summary.skippedCount}`,
    `失败：${summary.failedCount}`,
    `批次剩余：${summary.remainingUrls}`,
  ];
  for (const result of summary.results) {
    lines.push("", result.domain ? `域名：${result.domain}` : `目录页：${result.listingUrl}`);
    if (result.error) {
      lines.push(`状态：${result.error}`);
      continue;
    }
    if (result.cached) lines.push("状态：使用 30 天缓存，未扣积分");
    if (result.assessment) {
      const assessment = result.assessment;
      const percent = (value: number | null | undefined) => value === null || value === undefined
        ? "未提供"
        : `${(value * 100).toFixed(1)}%`;
      const sourceLabels: Record<string, string> = {
        direct: "直接访问",
        search: "搜索",
        search_organic: "自然搜索",
        search_paid: "付费搜索",
        social: "社交",
        social_organic: "自然社交",
        social_paid: "付费社交",
        referrals: "引荐",
        paid_referrals: "付费引荐",
        mail: "邮件",
        gen_ai: "AI 助手",
        affiliate: "联盟",
        other: "其他",
      };
      lines.push(`网站标题：${assessment.title || "未提供（API未返回）"}`);
      lines.push(`网站描述：${assessment.description || "未提供（API未返回）"}`);
      lines.push(`报告月份：${assessment.reportingMonth || "未提供（API未返回）"}`);
      lines.push(`月访问量：${assessment.visits}`);
      lines.push(`全球排名：${assessment.globalRank ?? "未提供（API未返回）"}`);
      lines.push(`国家排名：${assessment.countryRank ? `${assessment.countryRank.country} #${assessment.countryRank.rank}` : "未提供（API未返回）"}`);
      lines.push(`跳出率：${percent(assessment.bounceRate)}`);
      lines.push(`每次访问页数：${assessment.pagesPerVisit ?? "未提供（API未返回）"}`);
      lines.push(`平均停留：${assessment.timeOnSiteSeconds === null ? "未提供（API未返回）" : `${assessment.timeOnSiteSeconds} 秒`}`);
      lines.push(`注册时间：${assessment.registrationDate || "未提供（RDAP API 未返回）"}`);
      if (assessment.registrationError) lines.push(`注册查询异常：${assessment.registrationError}`);
      lines.push(`流量筛选：${assessment.qualified ? "符合条件" : "不符合条件"}`);
      lines.push(`流量来源：${Object.entries(sourceLabels).map(([key, label]) => `${label} ${percent(assessment.trafficSources[key])}`).join("、")}`);
      lines.push(`3 个月趋势：${assessment.monthlyVisits.length ? assessment.monthlyVisits.map((item) => `${item.month}：${item.visits}`).join("、") : "未提供（API未返回）"}`);
      lines.push(`主要国家：${assessment.topRegions.length ? assessment.topRegions.slice(0, 10).map((item) => `${item.name}（${item.country}，${percent(item.share)}）`).join("、") : "未提供（API未返回）"}`);
      lines.push(`关键词：${assessment.topKeywords.length ? assessment.topKeywords.slice(0, 10).map((item) => `${item.name}（搜索量 ${item.volume}，CPC $${item.cpc}，价值 $${item.estimatedValue}）`).join("、") : "未提供（API未返回）"}`);
      lines.push(`非品牌关键词：${assessment.nonBrandKeywords.length ? assessment.nonBrandKeywords.slice(0, 10).map((item) => item.name).join("、") : "未提供（API未返回）"}`);
      lines.push(`AI 流量：${assessment.aiTraffic?.trends.length ? assessment.aiTraffic.trends.map((trend) => `${trend.name}（${trend.history.slice(-3).map((item) => `${item.date}：${percent(item.value)}`).join("、")}）`).join("；") : "未提供（API未返回）"}`);
    }
    if (result.costCredits !== undefined) lines.push(`本次消耗：${result.costCredits} 积分`);
  }
  await sendText(webhook, lines.join("\n"));
}

export async function notifyError(webhook: string, siteName: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sendText(webhook, `【Sitemap 监控失败】\n站点：${siteName}\n错误：${message.slice(0, 2000)}`);
}
