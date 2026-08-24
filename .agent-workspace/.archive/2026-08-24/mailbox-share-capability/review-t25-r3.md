VERDICT APPROVED

# T-25 R3 · cached-tab hasNew refetch 复审

## P0

无。

## P1

无。

## P2

无。

## 复审结论

- R2 遗留 P1 已修复：`selectTab` 在切换 active Binding 前直接用 `hasNew(watermarks, bindingId, latestEmailId)` 保存目标 Tab 的新邮件状态；只有“已有缓存且无新邮件”才复用缓存，有新邮件时仍请求目标 Binding，合并返回页并按页内实际最大 `mailId` 推进水位。这里没有使用会因 active Tab 隐藏角标而失真的 `tabHasNew()`。`mail-vue/src/views/share/index.vue:417-437`
- AC-OTP-09 回归先访问 Binding 8002 缓存 mailId 52，再切回 Binding 0，让 status head 从 52 前进到 53；随后点击 8002，断言恰好调用一次 `listShareMails`、请求 Binding 8002、展示 mailId 53 对应邮件，并将水位推进到 53。该用例覆盖了 R2 指出的 cached 分支。`mail-vue/src/views/share/index.spec.js:972-1020`
- 无新邮件的缓存路径保持零请求：T25-TAB-LOAD 在缓存 Binding 8002 后再次点击同一 Tab，断言 `listShareMails` 未调用。`mail-vue/src/views/share/index.spec.js:707-733`
- 单实例轮询契约未改变：每个 tick 仍仅执行一次 status 请求和一次当前 Binding 的 mails 请求；本轮无需修改 `useSharePolling.js`。`mail-vue/src/views/share/index.vue:300-317`; `mail-vue/src/views/share/index.spec.js:736-759`
- 按要求维持 P1-4 HOLD，不重开空页语义；`SHARE_CAPABILITY_V2` 默认 false 不属于本轮变更。

## 测试证据

- `pnpm --dir mail-vue exec vitest run --no-cache src/views/share/index.spec.js src/views/share/status-watermark.spec.js src/composables/useSharePolling.spec.js src/request/share.spec.js src/views/share/share-chunk.spec.js` → 5 个测试文件通过，68 条测试通过。

## Update Log

- 2026-08-24 · 主 AI：R3 APPROVED p0=0。勾选 T-25。未勾选尾：T-26 → T-29。
