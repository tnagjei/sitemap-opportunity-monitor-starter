# 实施规格

## 产品目标

每天扫描多个竞争对手 Sitemap，只在发现新增页面时，通过飞书发送：网址、状态码、Title、H1、Description、候选关键词和 Google Trends 快捷链接。

## 当前范围

- Cloudflare Workers TypeScript。
- Cron 每天执行一次。
- KV 保存每个站点的上一次完整网址列表。
- 支持普通 URL Sitemap 和 Sitemap Index 递归。
- 首次扫描建立基线，不发送大量历史页面。
- 每次最多分析 `MAX_NEW_PAGES` 个新增页面。
- 飞书自定义机器人 Webhook 通知。
- `/health` 健康检查。
- 受 Bearer 密钥保护的 `/run` 手动扫描接口。

## 明确不做

- 删除 URL 监控。
- lastmod 变化监控。
- 网页后台。
- Google Trends 自动抓取。
- 搜索量 API。
- AI 自动评估关键词。
- gzip Sitemap 解析。

## 数据正确性规则

1. Sitemap 抓取或解析失败时，不更新快照。
2. 有新增页面时，飞书发送成功后才更新快照。
3. 飞书失败时保留旧快照，下次重复提醒。
4. 每个站点通过唯一 id 隔离快照。
5. 第一轮没有旧快照时只建立基线。

## 已知边界

- 直接以 `.gz` 返回的压缩 Sitemap 暂不支持。
- 某些网页由 JavaScript 动态生成 H1，普通抓取可能拿不到。
- Title、H1 和 URL 只能产生候选关键词，不能证明存在搜索量。
- 大型 Sitemap 可能触及 Cloudflare 免费版 CPU 或 KV 单值限制，需要真实运行验证。
