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
npx wrangler secret put SITEDATA_API_KEY
```

秘密不能写进 `wrangler.jsonc`、源代码或 Git。

### 部署

```bash
npm run deploy
```

## 定时设置

每天 `0 21 * * *` 扫描 Sitemap，对应中国标准时间 05:00。每 15 分钟处理一次已批准的 AITDK 队列；没有待处理批次时不会调用 Traffic API。

## PMKG 与 AITDK

- PMKG 当日新增不超过 20 条时自动批准 AITDK 查询。
- 超过 20 条时全部写入 KV，飞书发送批次 ID 和预计最多积分，不会自动调用收费接口。
- 在 Codex 明确批准批次后，队列每 15 分钟最多处理 20 条。
- 同一域名的成功结果缓存 30 天。
- Traffic API 每个实际查询预计消耗 2 积分；重复域名、无外部域名和缓存命中不调用。

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

- 暂不支持直接 gzip 压缩 Sitemap。
- 动态渲染页面可能提取不到 H1。
- 候选关键词仍需人工检查搜索量、趋势、意图、竞争度和域名。
- 免费版是否足够必须用实际 Sitemap 规模验证。
