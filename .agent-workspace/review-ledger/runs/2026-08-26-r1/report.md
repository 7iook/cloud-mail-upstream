## RUN
run: 2026-08-26-r1 | form: B | range: origin/main..origin/cursor/share-link-fullchain-8a38 (8) + leftover 6985f0e | commits: 9 | themes: 8
findings: P0=0 P1=0 P2=3 suggestion=0 | carryover: 0 | overdue: 0 | resolved_this_run: P0=2 P1=7
skipped: none
models: recon=claude-opus-5-thinking-high-fast | reviewer=gpt-5.6-sol-xhigh-fast | converge=claude-opus-5-thinking-high-fast | subagent_type=generalPurpose
completion: share-link-fullchain-8a38 silent>=6h (open PR #4) · mailbox-share-* pr-merged · setup-cloud-agent-env-3558 pr-merged leftover byte-identical · main/--since=yesterday empty

## FIX-BATCHES
### B1 · emails 批量 D1 整单原子 + 重放完整性 · order 1 · depends_on: -
findings: F-0001
root: mail-worker/src/service/mail-share-service.js `createFromEmails` / `prepareShareInsertByEmails`
why-together: 同根因;只改 replay 会被 0 行 INSERT 再次绕过

### B2 · 访客页去掉 ElMessage · order 2 · depends_on: -
findings: F-0002
root: mail-vue/src/views/share/index.vue `onPolledMails` / ShareOtpCard.copyCode

### B3 · gone 文档限流 + 专用头 + 拦截器收窄 + 清标 · order 3 · depends_on: -
findings: F-0003, F-0004
root: share-document-gone.js `nativeGoneResponse` + request/share.js 拦截器 + session.js

### B4 · Visitor gone 优先于功能关/cv · order 4 · depends_on: B3
findings: F-0005
root: share-auth-service.js `establishSession` / `resolveSession`

### B5 · 详情 writable 回到服务端快照 · order 5 · depends_on: -
findings: F-0006
root: ShareDetailDrawer.vue `writable`

### B6 · spec 路径与 gone 错误码表对齐代码 · order 6 · depends_on: B5
findings: F-0007
root: docs/specs/mail-share/design.md:754 及 SHARE_UNAVAILABLE 表

### B7 · OTP 链接 44px 与溢出 · order 7 · depends_on: B2
findings: F-0008
root: ShareOtpCard.vue `.share-otp-url`

### B8 · 角色邮箱配额写侧断言 · order 8 · depends_on: B1
findings: F-0009
root: mailbox-provision.js / createFromEmails batch RAISE

## OPEN-P0
(无)

## OPEN-P1
(无)

## OPEN-P2
### F-0010 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-worker/src/service/mailbox-provision.js:98
symbols: planMailboxProvision, emailPrefixFilter
rule:    搬家等价自述
theme:   T3 · emails 建分享
commits: fabe6e841109dfb84b8b4da651c7caa03a5d7db4
report:  reviewer:T3, reviewer:high-risk-T3
related:
risk:    provision-invariant-parity
failure: 前缀黑名单改为大小写不敏感
trigger: filter=spam 添加 SPAM@domain
impact:  旧可添加地址突然失败
fix:     产品裁决后再改
verify:  unverified: 需产品裁决

### F-0011 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/share-admin/use-share-clock.js:1
symbols: useShareClock
rule:    T2 定时器数量
theme:   T2 · Owner live 过期
commits: b36581046fcf40d6d2476facfed78f05f3115d93
report:  reviewer:T2
related: F-0006
risk:    clock-instance-leak
failure: 每行一个 1s interval
trigger: 列表 20 行
impact:  时钟放大 / 潜在泄漏
fix:     模块单例或父级一只时钟
verify:  unverified: 本轮不修

### F-0012 · P2 · open · age 0d · seen 1x · batch -
anchor:  tests/e2e/specs/owner-share-lifecycle.spec.js:1
symbols: owner-share-lifecycle, waitForTimeout
rule:    VERIFY 五条成功状态; CI 不跑 e2e
theme:   T6 · Owner E2E
commits: 37062220afc2be6dd4002a74c0dc8f20f03578f6
report:  reviewer:T6
related:
risk:    e2e-seed-ssot
failure: 固定 500ms 否定断言;无 CI 闸门
trigger: 慢机器 / persist 累积撞限额
impact:  三主题唯一浏览器证据不稳定
fix:     locator 否定断言;清理或提高 limit
verify:  unverified: 本轮不改 e2e 基础设施

## SUGGESTION
(无)

## RESOLVED
### F-0001 · P0 · resolved · batch B1
close:   verify: pnpm -C mail-worker exec vitest run test/mail-share-emails.spec.js → EXIT=0
note:    整单归属断言 + 幂等/replay 全 lid;D1 禁止普通 SQL RAISE,改 1/0 映射 SHARE_ACCOUNT_FORBIDDEN

### F-0002 · P0 · resolved · batch B2
close:   verify: pnpm -C mail-vue exec vitest run src/views/share/index.spec.js → EXIT=0
note:    访客页去掉 ElMessage;页内 [data-share-new-mail];toast.not.toHaveBeenCalled

### F-0003 · P1 · resolved · batch B3
close:   verify: pnpm -C mail-worker exec vitest run test/share-document-gone.spec.js → EXIT=0
note:    D1 前 SHARE_READ_RATE_LIMITER;gone 响应安全头 + X-CloudMail-Share-Gone

### F-0004 · P1 · resolved · batch B3
close:   verify: pnpm -C mail-vue exec vitest run src/request/share.spec.js src/views/share/session.spec.js src/views/share/index.spec.js → EXIT=0
note:    仅 404+专用头 → ShareGoneError;enterReady 后 clearShareGone

### F-0005 · P1 · resolved · batch B4
close:   verify: pnpm -C mail-worker exec vitest run test/share-auth-service.spec.js → EXIT=0
note:    missing/REVOKED 先于 isShareDisabled 与 cv mismatch

### F-0006 · P1 · resolved · batch B5
close:   verify: pnpm -C mail-vue exec vitest run src/views/share-admin/ShareDetailDrawer.spec.js → EXIT=0
note:    writable 用 effectiveStatus;徽章仍 liveStatus

### F-0007 · P1 · resolved · batch B6
close:   verify: rg views/share/status.js docs/specs/mail-share/design.md 无命中
note:    SSOT 路径 share-admin/status.js;gone → SHARE_DESTROYED / 裸 404

### F-0008 · P1 · resolved · batch B7
close:   verify: rg min-height ShareOtpCard.vue 命中 44px
note:    .share-otp-url min-height:44px; overflow-wrap; OTP/页头防溢出

### F-0009 · P1 · resolved · batch B8
close:   verify: pnpm -C mail-worker exec vitest run test/mail-share-emails.spec.js → EXIT=0
note:    account INSERT 写侧配额谓词;p2-quota-race 零行

## WAIVED
(无)

## DROPPED
- reviewer:cross-theme | CROSS-03 中间提交 gone 无人接管 | 丢弃:非 HEAD 运行时缺陷
- reviewer:T3 | Free 计划 50 query | 丢弃:仓库无该承诺
- reviewer:high-risk-T3 | 其它入口 c.env.domain.includes | 丢弃:决策卡本轮只保证分享路径
- reviewer:T3 | BINDING_LIMIT=50 复用 | 丢弃:有意为之,记债不改行为
- reviewer:T8 | leftover 环境配置 | 丢弃:与 main 字节等价
- reviewer:T4 | 关窗确认删除 | 丢弃:ADR 覆盖 sec 可取回,锚点无缺陷

## THEMES
T1 gone-404 → F-0003,F-0004,F-0005
T2 live-expiry → F-0006,F-0011
T3 emails-provision → F-0001,F-0009,F-0010
T4 close-confirm → (none)
T5 visitor-ui → F-0002,F-0008
T6 owner-e2e → F-0012
T7 spec-writeback → F-0007
T8 leftover-env → (none)
coupling: E1 T1--contract-->T5; E5 T2--ssot-->T7; E6 T3--ssot-->T7
