# Sitemap Opportunity Monitor

个人使用的竞争对手新页面关键词发现器。

## 它做什么

每天扫描配置的 Sitemap，找出新增页面，读取页面的 Title、H1 和 Description，生成候选关键词，并发送到飞书。第一轮只建立基线，不把全部历史网址当成新增。

## 当前默认监控

- PicMonkey
- `https://www.picmonkey.com/sitemap.xml`

## 你现在先做什么

1. 解压项目并在 OpenCode 中打开项目目录。
2. 确认 OpenCode 已连接 DeepSeek。
3. 把 `docs/DEEPSEEK_TASKS.md` 的“第 1 步”复制给 DeepSeek。
4. 第 1 步检查全部通过后，再创建 KV 和飞书机器人。

## 安装和自检

```bash
npm install
npm run check
```

## Cloudflare 配置

### 创建 KV

```bash
npx wrangler login
npx wrangler kv namespace create SNAPSHOTS
```

将返回的 id 写入 `wrangler.jsonc`。

### 设置秘密

```bash
npx wrangler secret put FEISHU_WEBHOOK
npx wrangler secret put MANUAL_RUN_SECRET
npx wrangler secret put TABAPI_API_KEY
```

秘密不能写进 `wrangler.jsonc`、源代码或 Git。
生产环境仍兼容旧名称 `SITEDATA_API_KEY`，不需要重新填写已有密钥。

### 部署

```bash
npm run deploy
```

## 定时设置

每天 `0 21 * * *` 扫描 Sitemap，对应中国标准时间 05:00。每 15 分钟处理一次已批准的 AITDK 队列；没有待处理批次时不会调用 Traffic API。

每周一 `0 13 * * 1` 扫描 Google Trends 关键词，对应中国标准时间周一 21:00。

## Google Trends 周监控

每周一扫描 `TRENDS_KEYWORDS` 里的关键词（默认全球，可按词指定 `geo`），取近 30 天日级兴趣值（Trends 的 `today 1-m` 区间）：

- 近 7 天均值 ≥ `TRENDS_DOUBLING_FACTOR` 倍（默认 2）的前 7 天均值，且前 7 天均值 ≥ `TRENDS_NOISE_FLOOR`（默认 3）时，飞书告警并附趋势链接。
- 首次运行只建立基线；后续新增的词先记基线，下周开始参与判定。
- 任一词取数失败则本次整体失败，不更新快照，下周自动重试；也可手动重跑：

```bash
curl -X POST \
  -H "Authorization: Bearer 你的手动执行密钥" \
  https://你的-worker.workers.dev/trends/run
```

数据来自 Google Trends 非官方接口，免费无密钥；20 个词每次约 40 个请求，429 时自动重试一次。编辑 `wrangler.jsonc` 中的 `TRENDS_KEYWORDS` 添加或删除词：

```json
[
  { "keyword": "pdf to word" },
  { "keyword": "背景移除", "geo": "CN" }
]
```

## PMKG、Creem 与 AITDK

- PMKG 或 Creem 当日新增不超过 20 条时自动批准 AITDK 查询。
- 超过 20 条时全部写入 KV，飞书发送批次 ID 和预计最多积分，不会自动调用收费接口。
- 在 Codex 明确批准批次后，队列每 15 分钟最多处理 20 条。
- 同一域名的成功结果缓存 30 天。
- TabAPI Traffic 查询 3 个月数据消耗 3 积分，RDAP 注册日期查询消耗 1 积分，每个新域名预计最多 4 积分。
- 重复域名、无外部域名和缓存命中不调用收费接口。

## 添加更多站点

编辑 `wrangler.jsonc` 中的 `MONITORED_SITEMAPS`：

```json
[
  {
    "id": "picmonkey",
    "name": "PicMonkey",
    "url": "https://www.picmonkey.com/sitemap.xml"
  },
  {
    "id": "example",
    "name": "Example",
    "url": "https://example.com/sitemap.xml"
  }
]
```

每个 `id` 必须唯一。

## 手动执行

```bash
curl -X POST \
  -H "Authorization: Bearer 你的手动执行密钥" \
  https://你的-worker.workers.dev/run
```

## 健康检查

```bash
curl https://你的-worker.workers.dev/health
```

## 已知限制

- Google Trends 使用非官方接口，Worker 数据中心 IP 可能被 429 限流；失败时不覆盖快照，可从本地网络手动执行 `/trends/run`。
- Trends 数值是相对搜索兴趣（0-100），不是绝对流量；"翻倍"指兴趣比值。
- 暂不支持直接 gzip 压缩 Sitemap。
- 动态渲染页面可能提取不到 H1。
- 候选关键词仍需人工检查搜索量、趋势、意图、竞争度和域名。
- 免费版是否足够必须用实际 Sitemap 规模验证。
