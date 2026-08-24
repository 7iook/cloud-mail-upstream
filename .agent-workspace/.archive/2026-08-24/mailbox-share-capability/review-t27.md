VERDICT APPROVED

# T-27 · W6 mailbox-share-capability E2E 新访客场景

## P0

无。`p0=0`。

## P1

无。`p1=0`。

## P2

- **P2-1（已知生产缺陷，非 T-27 阻塞项）· 浏览中撤销后倒计时残留。** `clearMailboxView()` 清除 session、establish key、mailbox 与邮件，但没有清 `expiresAt`；`showDeadShare()` 随后直接进入 `unavailable`，因此中途撤销页仍可能渲染 `[data-share-expires]`，与随机 lid 的死壳存在这一处差异。T-27 的撤销 spec 正确地只比较消息、body 与活体元素数量，没有把该残留固定为期望行为；修复点属于本任务禁止修改的生产 Vue 文件，故记录但不据此拒绝。证据：`mail-vue/src/views/share/index.vue:660-676`；`tests/e2e/specs/visitor-revoke-live.spec.js:40-55`。

## 审查结论

- **T-27.1 成立。** 两邮箱分享在从未登录的浏览器中真实建立 session，断言两个原生 Tab、唯一选中态与掩码标签；首个 status 水位写盘后才向第二邮箱走真实 `email()` 注入，随后断言空闲 Tab 角标、切换、实时 OTP、通过 `[data-share-copy]` 复制及 `data-share-copy-result="copied"`，再切回并确认角标已消费。最终 URL 被严格钉为 `/s/<lid>`，query/hash 为空且不含邮箱地址。`tests/e2e/specs/visitor-multi-mailbox.spec.js:7-63`；`tests/e2e/harness/worker-entry.js:215-274`。
- **T-27.2 配额成立。** `maxSessions=1` 下首访客进入后 `usedSessions=1`；独立 browser context 的第二访客进入 `unavailable`、无 session 凭据且计数仍为 1，首访客仍保持可用。`tests/e2e/specs/visitor-session-quota.spec.js:4-26`。丢响应场景在浏览器路由中先 `route.fetch()` 让 worker 提交，再 `route.abort('failed')`；两次浏览器可见 POST 使用同一非空 Idempotency-Key，最终存储 token 与首个已提交响应一致，`usedSessions` 仍为 1。`tests/e2e/fixtures/share.js:56-81`；`tests/e2e/specs/visitor-session-replay.spec.js:7-27`。
- **T-27.3 撤销与 AuthKey 成立。** 中途撤销在下一拍进入不可用态，后续超过一个轮询周期无 `/api/share/` 请求，session/establish key 被清而非凭据水位保留；其消息、body 与活体元素集合和随机 lid 死壳一致。`tests/e2e/specs/visitor-revoke-live.spec.js:6-55`。错误 AuthKey 保持可重试且 `usedSessions=0`，正确 AuthKey 随后进入 ready、建立 session 且只消费一次；所有捕获的 API URL、Referer 与 headers 均排除 `sec`/AuthKey，sessionToken 只允许出现在设计载体 `Authorization`。`tests/e2e/specs/visitor-authkey.spec.js:5-55`。
- **四路 V2 薄栅栏成立。** 默认关闭态下，多邮箱 create、1→N bindings、AuthKey enable、有限 maxSessions 均返回 `SHARE_INVALID_CONFIG`，并分别以总数、bindings、AuthKey 状态、maxSessions 后置条件证明没有落库；打开后同四路各得到成功信封。未扩测 `message_limit`，未构造第二 worker，符合 Fog-3/T27-FOUR。`tests/e2e/specs/capability-v2-fence.spec.js:10-68`。
- **Fog-1 接线符合锁定裁决。** `sessionTtlOverride` 与 `capabilityV2Override` 共用一个 `envWithOverrides()` Proxy，二者都为 `null` 时原样透传；`/seed` 同时复位，控制端 `setCapabilityV2(true/false)` 最终写入字符串 `'true'/'false'`。`tests/e2e/harness/worker-entry.js:20-44,189-212,291-304`；`tests/e2e/harness/control.js:98-108`。`tests/e2e/playwright.config.js:6-7` 仍为 `fullyParallel:false`、`workers:1`。
- **Fog-2 与负向边界符合裁决。** `git diff --stat 58767d3..190f704 -- mail-vue mail-worker/src mail-worker/wrangler.toml tests/e2e/wrangler-e2e.toml tests/e2e/run.mjs tests/e2e/playwright.config.js` → EXIT=0、空输出；因此 `isLostResponse` 及生产 Vue/worker/config 均未改。新增代码中无 `fulfill({status:599})`，丢响应只使用 `fetch()` 后 `abort('failed')`。`tests/e2e/fixtures/share.js:71-80`。
- **冻结基线与默认关闭成立。** 对指定 12 个旧 spec 执行 `git diff --stat 58767d3..190f704 -- <12 files>` → EXIT=0、空输出；实现只新增 6 个 spec，每个恰一条 `test()`。`git grep -n "SHARE_CAPABILITY_V2" 190f704 -- tests/e2e/wrangler-e2e.toml mail-worker/wrangler.toml` 仅命中 `mail-worker/wrangler.toml:58` 的注释声明，`wrangler-e2e.toml` 无该变量。新 spec 没有界面文案字面量断言；复制断言使用稳定 data 属性和数据源 OTP。`tests/e2e/specs/visitor-multi-mailbox.spec.js:43-47`。

## 测试证据

- E2E 前执行端口绑定探针：`python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',8788)); print('PORT_8788_FREE'); s.close()"` → EXIT=0，`PORT_8788_FREE`；未发现需按 PID 清理的 V2 强制 wrangler。
- `node tests/e2e/run.mjs` → EXIT=0，Chromium **19 passed / 0 skipped**；六个新 spec 与既有 13 条全部通过。
- `pnpm --dir mail-vue test -- --no-cache` → EXIT=0，**22 files / 250 passed**。
- `pnpm --dir mail-worker test -- --no-cache` → EXIT=0，**18 files / 626 passed**。
- `git diff --check 58767d3..190f704` → EXIT=0。

## Update Log

- 2026-08-24 · T-27 独立代码审查：APPROVED，`p0=0`、`p1=0`、`p2=1`；P2 为已知且超出 T-27 白名单的撤销后倒计时残留。
