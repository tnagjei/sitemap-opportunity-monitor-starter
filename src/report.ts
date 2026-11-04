import type { MonitoredSite, PageAnalysis, SiteReport } from "./types";

const REPORT_PREFIX = "report:";
const REPORT_TTL_SECONDS = 30 * 24 * 60 * 60;

export function reportKey(siteId: string): string {
  return `${REPORT_PREFIX}${siteId}`;
}

interface ReportInput {
  order: number;
  date: string;
  totalUrls: number;
  analyses: PageAnalysis[];
  omittedCount: number;
  skippedNonEnglishCount: number;
  error?: string;
}

export async function saveSiteReport(
  kv: KVNamespace,
  site: MonitoredSite,
  input: ReportInput,
): Promise<void> {
  const report: SiteReport = {
    siteId: site.id,
    siteName: site.name,
    siteUrl: site.url,
    order: input.order,
    date: input.date,
    scannedAt: new Date().toISOString(),
    totalUrls: input.totalUrls,
    analyses: input.analyses,
    omittedCount: input.omittedCount,
    skippedNonEnglishCount: input.skippedNonEnglishCount,
    focusPathPrefix: site.focusPathPrefix,
    error: input.error,
  };
  await kv.put(reportKey(site.id), JSON.stringify(report), { expirationTtl: REPORT_TTL_SECONDS });
}

export async function loadSiteReports(kv: KVNamespace): Promise<SiteReport[]> {
  const list = await kv.list({ prefix: REPORT_PREFIX });
  if (list.keys.length === 0) return [];
  const reports = await Promise.all(
    list.keys.map((key) => kv.get<SiteReport>(key.name, "json")),
  );
  return reports
    .filter((item): item is SiteReport => Boolean(item))
    .sort((a, b) => a.order - b.order);
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderAnalysis(item: PageAnalysis): string {
  const tags = [
    item.focus ? '<span class="tag focus">重点</span>' : "",
    item.status !== null ? `<span class="tag">${item.status}</span>` : "",
  ].join("");
  const description = item.description
    ? `<p class="desc">${esc(item.description.slice(0, 200))}</p>`
    : "";
  const error = item.error ? `<p class="err">${esc(item.error)}</p>` : "";
  const trends = `https://trends.google.com/trends/explore?date=today%201-m&q=${encodeURIComponent(item.keyword)}`;
  return `<li class="item">
  <div class="item-head">
    <a class="keyword" href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.keyword)}</a>
    ${tags}
  </div>
  <p class="url">${esc(item.url)}</p>
  ${description}${error}
  <p class="links"><a href="${esc(trends)}" target="_blank" rel="noreferrer">Google Trends</a></p>
</li>`;
}

export function renderReportPage(reports: SiteReport[]): string {
  const updated = reports.length
    ? reports.map((item) => item.scannedAt).sort().at(-1)!.slice(0, 16).replace("T", " ")
    : "";
  const sections = reports.map((report) => {
    const body = report.error
      ? `<p class="err">抓取失败：${esc(report.error)}</p>`
      : report.analyses.length > 0
        ? `<ul class="items">${report.analyses.map(renderAnalysis).join("")}</ul>`
        : '<p class="empty">今日无新增。</p>';
    return `<section class="site">
  <header class="site-head">
    <h2>${esc(report.siteName)}</h2>
    <p class="meta">${esc(report.date)} · 存量 ${report.totalUrls} · 新增 ${report.analyses.length}${report.omittedCount ? ` · 另有 ${report.omittedCount} 个未展开` : ""}</p>
  </header>
  ${body}
</section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sitemap 机会日报</title>
<style>
:root{--ink:#16181d;--muted:#6a7280;--line:#e4e6ea;--bg:#fbfbfc;--accent:#0f766e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:28px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:14px;margin:0 0 36px}
.site{border-top:1px solid var(--line);padding:26px 0 6px}
.site-head h2{font-size:19px;margin:0 0 4px}
.meta{color:var(--muted);font-size:13px;margin:0 0 14px;font-variant-numeric:tabular-nums}
.items{list-style:none;margin:0;padding:0}
.item{padding:14px 0;border-top:1px dashed var(--line)}
.item:first-child{border-top:0}
.item-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.keyword{font-size:17px;font-weight:600;color:var(--accent);text-decoration:none}
.keyword:hover{text-decoration:underline}
.tag{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 7px;color:var(--muted)}
.tag.focus{border-color:var(--accent);color:var(--accent)}
.url{font-size:12px;color:var(--muted);word-break:break-all;margin:4px 0}
.desc{margin:6px 0 0;font-size:14px;color:#3b414b}
.links{margin:6px 0 0;font-size:13px}
.links a{color:var(--muted)}
.empty{color:var(--muted);font-size:14px;margin:0 0 10px}
.err{color:#b42318;font-size:14px;margin:6px 0}
@media (prefers-color-scheme:dark){:root{--ink:#e8eaee;--muted:#9aa3b2;--line:#2a2f39;--bg:#12151a;--accent:#5eead4}.desc{color:#c3c9d4}}
</style>
</head>
<body>
<main>
<h1>Sitemap 机会日报</h1>
<p class="sub">${updated ? `最近更新 ${esc(updated)} · ` : ""}${reports.length} 个站点</p>
${sections || '<p class="empty">还没有数据，等第一次定时任务跑完。</p>'}
</main>
</body>
</html>`;
}
