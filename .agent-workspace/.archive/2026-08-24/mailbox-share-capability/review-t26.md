VERDICT APPROVED

# T-26 · visitor authRequired + idempotent session + refresh policy + credential cleanup

## P0

无。`p0=0`。

## P1

无。

## P2

无。

## 审查结论

- AuthKey 主链闭合：bootstrap 收到 `SHARE_AUTH_REQUIRED` 后保留内存中的 `pageSecret` 并进入 `authRequired`；表单可输入并回车提交，成功后统一经 `enterReady` 写 token、清 establish key、应用配置，再由 `beginMailbox` 拉取最新邮件。错误 Key 留在同一可重试状态，429 只显示等待且不误报错 Key。`mail-vue/src/views/share/index.vue:39-77,637-658,772-807,902-959`
- `/share/session` 只有 `postSession` 一个出口；请求层只把非空 `authKey` 放 body、把 `Idempotency-Key` 放 header。`ensureEstablishKey` 在请求前用 `crypto.getRandomValues(new Uint8Array(16))` 生成 32 位 hex 并按 lid 存储；无响应只原地重放一次，两个 POST 使用同一个 key，成功后清除。`mail-vue/src/request/share.js:46-48,158-172`; `mail-vue/src/views/share/session.js:39-64`; `mail-vue/src/views/share/index.vue:622-647`
- 刷新策略完整消费：`applyShareConfig` 保留原字段并增加 `autoRefresh`、经恰好 `POLL_INTERVAL_MS` 下限钳制的 `refreshIntervalMs`、`expiresAt`；轮询器每次排程用 `toValue(intervalMs)` 读最新值，未增加 `autoStart` / `listStatus` / `mode`。`beginMailbox` 的正常与 429 两个 `polling.start()` 均受 `autoRefresh` 控制；关闭自动刷新时按钮一次点击复用 `pollTick`，执行一次 status + 一次 mails，并合并新邮件。`mail-vue/src/composables/useSharePolling.js:56-63,168-182,198-210`; `mail-vue/src/views/share/index.vue:112-127,409-425,587-603,835-879`
- Fog-3 按锁定裁决降级：存量 token 复活不重发 `/share/session`、不创建 establish key；默认 3000ms 自动轮询且不显示倒计时。`mail-vue/src/views/share/index.vue:902-959`; `mail-vue/src/views/share/index.spec.js:1396-1411`
- 三个清理点保持同一边界：`clearMailboxView`（含终态 SHARE_UNAVAILABLE）、`exitShare`、`onUnmounted` 都清 `share:session:<lid>` 与 `share:est-key:<lid>`，均不碰 `share:status:<lid>`；`clearOtherShareSessions` 仍只扫描 session 前缀。卸载使用 setup 生命周期内捕获的 `ownedLid`。`mail-vue/src/views/share/index.vue:660-689,810-825,969-980`; `mail-vue/src/views/share/session.js:66-78`
- 模板位置满足契约：auth 表单位于 `data-share-wait` 之后且在 `data-share-body` 外；非 ready 的空 `data-share-body` 保留；手动刷新位于 tabs `nav` 后、tabpanel 前；`data-share-expires` 已存在。新文案均使用 `tx(key, English fallback)`，未修改 i18n 文件。`mail-vue/src/views/share/index.vue:7-199`
- 凭据未进入 storage、URL 或日志：`authKeyInput` 只驻留内存，成功后置空；请求测试钉死 AuthKey 只在 body；视图测试覆盖错 Key、正确 Key及 `sec` 均不出现在 sessionStorage/URL/console。`mail-vue/src/views/share/index.vue:267-272,774-807`; `mail-vue/src/request/share.spec.js:257-300`; `mail-vue/src/views/share/index.spec.js:1132-1181`
- `index.spec.js` 的 T-26 标记前内容经机械比较：还原三处获准的 `expect.objectContaining({ idempotencyKey })` 调用形状并忽略新增分隔空行后，与 `5f3b10f` 字节内容一致；旧 22 条及 T-25/T-25.2 正文未改。
- 负向范围核对为空：`mail-worker/**`、`router/index.js`、`init.js`、`assert-share-chunk.js`、`status-watermark.js`、`ShareOtpCard.vue`、`mail-fields.js`、i18n、`mail-share.js`、`tests/e2e/**` 在 `5f3b10f..6e8bc10` 均无差异。`SHARE_CAPABILITY_V2` 生产配置仍仅保留注释声明、缺省为 false；vitest 配置仍显式为 `"false"`。

## 测试证据

- `pnpm --dir mail-vue exec vitest run --no-cache src/views/share/session.spec.js src/request/share.spec.js src/composables/useSharePolling.spec.js src/views/share/index.spec.js src/views/share/share-chunk.spec.js` → EXIT=0，5 个文件 / 88 条测试通过。
- `pnpm --dir mail-vue test --no-cache` → EXIT=0，22 个文件 / 250 条测试通过。
- `pnpm --dir mail-worker test --no-cache` → EXIT=0，18 个文件 / 626 条测试通过。
- `node tests/e2e/run.mjs` → EXIT=0，Chromium 13/13 通过。
- `git diff --check 5f3b10f..6e8bc10` → EXIT=0。

## Update Log

- 2026-08-24 · T-26 code review：APPROVED，p0=0。
