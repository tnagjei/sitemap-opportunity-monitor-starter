# Google Trends 关键词翻倍周监控实施计划

## 目标

每周一（中国标准时间 21:00）扫描 `TRENDS_KEYWORDS` 配置的关键词（约 20 个），从 Google Trends 免费非官方接口取近 30 天日级兴趣值（预设区间 `today 1-m`），比较近 7 天与前 7 天均值；当兴趣至少翻倍且上周均值达到噪声下限时，通过现有飞书 Webhook 发送一条汇总告警。首次运行只建立基线。

## 数据流

1. 从 `https://trends.google.com/trends/api/explore` 取 TIMESERIES 组件 token。
2. 用 token 请求 `https://trends.google.com/trends/api/widgetdata/multiline`，取日级时间序列。
3. 去掉 `)]}',` 防 XSS 前缀后解析 JSON；先访问 Trends 首页拿 NID cookie。
4. 每词独立请求（0-100 分辨率不被跨词归一化）；词间间隔 1.5 秒，429 重试一次（延迟 30 秒）。
5. 按时间戳剔除当天这个不完整的点（不是无脑剔除最后一个点，避免 Google 已过滤今天时多剔掉昨天），last7 = 近 7 天均值，prev7 = 前 7 天均值。
6. last7 ≥ 2 × prev7 且 prev7 ≥ 3 时判定翻倍；任何词取数失败则本次整体失败。

## 快照与告警边界

- 快照 `trends:weekly:snapshot` 每词记录 `{ last7Mean, prev7Mean }`。
- 先通知后写快照：飞书失败时快照不变，下次运行重试同一批词。
- 快照中不存在的词记为新词基线，只记录不告警，因此加词不会清掉整批词。
- 不监控删除页面与正文变化，不接付费接口，不引入数据库。

## 修改文件

- `src/trends.ts`（新增）：explore/multiline 取数、前缀剥离、周统计、翻倍判定。
- `src/config.ts`：`parseTrendKeywords` 校验词表、去重、geo 格式；`parsePositiveFloat`。
- `src/runner.ts`：`runTrendsMonitor`（基线、告警分桶、失败不动快照）。
- `src/feishu.ts`：`notifyTrendsReport`、`notifyTrendsError`。
- `src/index.ts`：`POST /trends/run` 手动端点；cron `0 13 * * 1` 路由。
- `src/types.ts`、`wrangler.jsonc`、`README.md`：类型、变量与文档。

## 验收

• 首次运行只发基线通知，快照写入每词均值。

• 翻倍词（含恰好 2 倍）触发告警并附 Trends 链接；1.9 倍不告警。

• prev7 低于噪声下限（如 0→10）不告警。

• 新增词只记基线，不影响已有词判定。

• 模拟 429 两次失败时，错误通知发出且旧快照原样保留。

• `npm run check` 通过。

## 风险

- 非官方接口对 Worker 数据中心 IP 可能持续 429；兜底是从本地网络手动执行 `/trends/run`，或等待官方 Trends API（仍需申请审核）开放。
- 区间只能用 Google 预设值。实测 `today 60-d` / `today 61-d` / `today 89-d` 返回 HTTP 400，`today 1-m` 与 `today 3-m` 返回 429（区间合法、仅被限流），所以固定用 `today 1-m`。改用非预设区间前必须先用 curl 验证。
- Trends 值为相对兴趣，不是绝对流量；"翻倍"指兴趣比值。
