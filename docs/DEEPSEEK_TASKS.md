# 给 DeepSeek 的分步任务

不要一次把全部任务发给 DeepSeek。每一步完成并通过 `npm run check` 后，再进行下一步。

## 第 1 步：理解并验证现有项目

复制下面内容给 DeepSeek：

```text
先不要修改功能。阅读 AGENTS.md、docs/IMPLEMENTATION_SPEC.md 和 src 目录。执行 npm install，再执行 npm run check。若失败，只修复导致检查失败的问题，不添加新功能。最后告诉我：失败原因、改了哪些文件、三个检查是否全部通过。
```

验收：

- `npm run typecheck` 通过。
- `npm test` 通过。
- `wrangler deploy --dry-run` 通过。

## 第 2 步：建立 Cloudflare 资源

由你本人执行，不让 DeepSeek 猜账号信息：

```bash
npx wrangler login
npx wrangler kv namespace create SNAPSHOTS
```

把返回的 KV id 替换 `wrangler.jsonc` 里的全零 id。

然后设置秘密：

```bash
npx wrangler secret put FEISHU_WEBHOOK
npx wrangler secret put MANUAL_RUN_SECRET
```

## 第 3 步：本地测试

复制给 DeepSeek：

```text
指导我启动本地 Worker，并分别测试 /health 和带 Bearer 密钥的 POST /run。不要修改业务范围。发现运行错误就定位并修复，修复后重新执行 npm run check。给我可直接复制的 macOS 命令。
```

## 第 4 步：增强错误处理

复制给 DeepSeek：

```text
审查 Sitemap 抓取、页面抓取、KV 写入和飞书通知的失败路径。只修复会导致漏报、错误覆盖快照或整个任务中断的问题。为每个修复增加最小测试。不要新增后台、数据库、AI 或外部关键词接口。完成后运行 npm run check。
```

## 第 5 步：真实部署

复制给 DeepSeek：

```text
检查 wrangler.jsonc 中的 KV id、Cron、变量格式和 Secret 使用方式。确认没有把任何秘密写进仓库后执行部署。部署完成后测试 /health，再指导我手动触发一次 /run。不得展示 Secret 的真实值。
```

## 第 6 步：第二个竞争对手

只需要编辑 `wrangler.jsonc` 中 `MONITORED_SITEMAPS` 的 JSON 数组，新增唯一 id、名称和 Sitemap URL，然后重新部署。

## 暂时禁止 DeepSeek 做的事

- 改成 Python。
- 改用 D1。
- 加 React、Next.js 或管理后台。
- 添加账号系统。
- 接入大模型分析。
- 抓 Google Trends 数据。
- 重写整个项目。
