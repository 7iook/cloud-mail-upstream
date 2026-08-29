# reviewer T2 · 向导 pending create 持久化

L0 通用内核 · L1 scope.md · L2 T2 review_focus
model: gpt-5.6-sol-xhigh-fast（Task 用量耗尽 · 主 AI 按 reviewer 模板代行）
read: ShareCreateWizard.vue:507-1010 · ShareCreateWizard.spec.js:389-538 · header/index.vue:247-261 · i18n/en.js:456-463 · i18n/zh.js:456-463
verify: cd mail-vue && pnpm exec vitest run src/views/share-admin/ShareCreateWizard.spec.js → EXIT=0 (41 passed)

## 查证

1. `writePendingCreate` 在 `submitting=true` / `createMailShare` 之前。飞单中卸组件再挂，spec 钉同一把钥匙。
2. replay 分支用 `pending.body` + `pending.key`，不用 `buildBody`。
3. remnant 只在 `replay && UNRESOLVED_REPLAY_CODES`。首次业务拒绝走 clearPendingCreate。
4. 关窗 `onOpenChange` → `closeNow` 不清 pending / unknownResult。F-0005 未回退。
5. 键 `mail-share:create-pending` 不含 userId。合入时 `clickLogout` 只摘 token，同标签换号会把上一任邮箱列表和幂等键交给下一个人。组件头注释声称 sessionStorage 避免这件事 —— 对 localStorage 跨标签成立，对同标签登出不成立。
6. remnant / pendingEmails / abandon 五键只在 `PENDING_COPY`（中文）。`tf()` 在 `te(key)` 为假时走兜底；en 语言包没有这些键 → 英文 UI 画出中文。T-28/T-29 写明 i18n 文件才是唯一写者。

## persist

- persists: F-0023, F-0024（向导结果钮文案 / 错误距离，本轮未改）

## findings

### F-8386f9a1 · P2 · open
anchor: mail-vue/src/i18n/en.js:456
symbols: shareCreateRemnantTitle, shareCreateRemnantHint, shareCreateRemnantGuidance, shareCreatePendingEmails, shareCreateAbandonPending, tf, PENDING_COPY
rule_source: ShareCreateWizard.vue §T-28/T-29 i18n SSOT
identity_scope: share wizard remnant i18n keys missing from locale SSOT
failure_mode: remnant 恢复文案未进 zh/en 语言包，英文 te() 为假
trigger: 英文界面进入 remnant 恢复态
impact: 英文 Owner 看到中文 PENDING_COPY，或日后删兜底后露出裸 key
required_fix: 五键写入 i18n/en.js 与 i18n/zh.js
verify: python3 -c "from pathlib import Path; e=Path('mail-vue/src/i18n/en.js').read_text(); z=Path('mail-vue/src/i18n/zh.js').read_text();
keys=('shareCreateRemnantTitle','shareCreateRemnantHint','shareCreateRemnantGuidance','shareCreatePendingEmails','shareCreateAbandonPending');
assert all(k in e and k in z for k in keys)" → EXIT=0
risk_spread: none

### F-cb2a6d21 · P2 · open
anchor: mail-vue/src/layout/header/index.vue:248
symbols: clickLogout, PENDING_CREATE_STORAGE_KEY, restorePendingCreate
rule_source: ShareCreateWizard.vue §sessionStorage shared-browser isolation
identity_scope: logout vs mail-share:create-pending sessionStorage
failure_mode: 登出不摘未决创建键
trigger: Owner A 运输层失败后登出，Owner B 同标签登录并打开向导
impact: B 看到 A 的邮箱列表并以 A 的幂等键重放
required_fix: clickLogout 在清 token 时 removeItem('mail-share:create-pending')
verify: grep -n "mail-share:create-pending" mail-vue/src/layout/header/index.vue → 命中
risk_spread: pending-create-storage · origin PENDING_CREATE_STORAGE_KEY → hops 1 · stop: logout 已摘键
