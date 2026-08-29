# Scope · 2026-08-28-r1

repo: /workspace
mode: cursor | range: 9b6eb8072fe73c93518e872037702a2e8e54056b..083c87f2d2ccc8c459adfd45fc31a43afc63256f | ref: origin/main (083c87f2d2ccc8c459adfd45fc31a43afc63256f)
effective_since: None | effective_until: None | merge_policy: include-first-parent-churn | cursor_eligible: True
range_note: multi-ref + 完成信号 · origin/main silent>=19.01h · 入选切片 9b6eb80..HEAD（12cec61..9b6eb80 已在 2026-08-26-r1 审过，不当新工作重审）
commits: 10 | files: 104 | +15582 -898
form: B (pwsh 不可用且 collect-scope 无 .py, 主 AI 等价采集)
instance: cursor-cursor/git-8934-4271-d83a
models: recon=claude-opus-5-thinking-high-fast · reviewer=gpt-5.6-sol-xhigh-fast · converge/fix=claude-opus-5-thinking-high-fast

## 多 ref 完成信号

- origin/main / main / origin · completed(silent 19.01h >=6h) · 本轮入选切片 9b6eb80..HEAD (10 commits)
- cursor/git-8934 · skipped: in-progress （本轮交付分支 · unique vs main = 0 · 游标冻结）
- origin/cursor/share-link-fullchain-8a38 · completed(PR#4 merged + deleted) · cursor==9b6eb80 · unique=0
- origin/cursor/git-e148 · completed(PR#5 merged + deleted) · 昨日 skipped in-progress · 工作已在 main
- origin/cursor/git-5c8a · completed(PR#6 closed + deleted) · 昨日 skipped in-progress · 331c921 重写为 790c550/1da171f/083c87f
- origin/cursor/git-7d43 · completed(PR#7 merged + deleted) · 空轮台账
- origin/cursor/mailbox-share-capability-dcb6 · completed(PR#3 merged + deleted) · unique=0
- origin/cursor/mailbox-share-capability-spec-4743 · completed(PR#2 merged + deleted) · unique=0
- origin/cursor/setup-cloud-agent-env-3558 · completed(PR#1 merged + deleted) · cursor sha 本地缺失
- open PRs: 无

## 提交

### f6670e0 · +3793 -0
subject: docs(review): bootstrap 2026-08-26-r1 git-review-sweep 台账
author_date: 2026-08-26 19:57:45 +0000 | author: Cursor Agent
files:
  .agent-workspace/review-ledger/INDEX.md  [+20 -0]
  .agent-workspace/review-ledger/ledger.jsonl  [+30 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/artifacts/ui-t6-desktop-1280.webp  [+0 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/artifacts/ui-t6-mobile-390.webp  [+0 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/decisions.json  [+929 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/cross-theme.md  [+63 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/high-risk-t1.md  [+56 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/high-risk-t2.md  [+85 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/high-risk-t3.md  [+73 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t1-share-gone-404.md  [+24 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t2-mailbox-provision.md  [+61 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t3-emails-create.md  [+72 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t4-wizard-close-confirm.md  [+26 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t5-live-expired-status.md  [+43 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t6-visitor-otp-visual.md  [+23 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t7-spec-backfill.md  [+87 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t8-owner-e2e.md  [+20 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t9-decision-card.md  [+51 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/ui-t4.md  [+40 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/ui-t5.md  [+53 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/ui-t6.md  [+71 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/report.md  [+538 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/reviewer-l0-l1.md  [+47 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/scope.json  [+731 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/scope.md  [+183 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/themes.md  [+441 -0]
  .agent-workspace/review-ledger/state.json  [+20 -0]
  .agent-workspace/review-ledger/waivers.md  [+3 -0]
  .gitignore  [+3 -0]

### 864358d · +4749 -511
subject: merge: 纳入 share-link-fullchain 以便落地审查修复
author_date: 2026-08-26 19:57:54 +0000 | author: Cursor Agent
files:
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md  [+24 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/prompt.round1.sub.txt  [+644 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-expired-status-rca.md  [+71 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md  [+421 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.review1.sub.md  [+177 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md  [+52 -0]
  docs/specs/mail-share/design.md  [+11 -0]
  docs/specs/mail-share/requirements.md  [+3 -3]
  docs/specs/mailbox-share-capability/design.md  [+7 -1]
  docs/specs/mailbox-share-capability/requirements.md  [+3 -3]
  mail-vue/src/composables/useSharePolling.js  [+4 -1]
  mail-vue/src/composables/useSharePolling.spec.js  [+20 -1]
  mail-vue/src/i18n/en.js  [+11 -2]
  mail-vue/src/i18n/zh.js  [+11 -2]
  mail-vue/src/request/mail-share.js  [+9 -3]
  mail-vue/src/request/share.js  [+19 -0]
  mail-vue/src/request/share.spec.js  [+47 -0]
  mail-vue/src/views/email/ShareDialog.spec.js  [+21 -3]
  mail-vue/src/views/email/ShareDialog.vue  [+5 -3]
  mail-vue/src/views/email/ShareIndicator.spec.js  [+86 -0]
  mail-vue/src/views/email/ShareIndicator.vue  [+22 -2]
  mail-vue/src/views/email/index.vue  [+5 -1]
  mail-vue/src/views/share-admin/ShareCreateWizard.spec.js  [+193 -75]
  mail-vue/src/views/share-admin/ShareCreateWizard.vue  [+153 -136]
  mail-vue/src/views/share-admin/ShareDetailDrawer.spec.js  [+32 -9]
  mail-vue/src/views/share-admin/ShareDetailDrawer.vue  [+8 -4]
  mail-vue/src/views/share-admin/ShareRowActions.spec.js  [+19 -0]
  mail-vue/src/views/share-admin/ShareRowActions.vue  [+8 -3]
  mail-vue/src/views/share-admin/index.spec.js  [+25 -3]
  mail-vue/src/views/share-admin/index.vue  [+22 -4]
  mail-vue/src/views/share-admin/presets.js  [+45 -0]
  mail-vue/src/views/share-admin/presets.spec.js  [+7 -1]
  mail-vue/src/views/share-admin/status.js  [+26 -0]
  mail-vue/src/views/share-admin/status.spec.js  [+48 -0]
  mail-vue/src/views/share-admin/use-share-clock.js  [+55 -0]
  mail-vue/src/views/share-admin/use-share-clock.spec.js  [+75 -0]
  mail-vue/src/views/share/ShareOtpCard.vue  [+36 -11]
  mail-vue/src/views/share/index.spec.js  [+105 -5]
  mail-vue/src/views/share/index.vue  [+255 -54]
  mail-vue/src/views/share/session.js  [+37 -0]
  mail-vue/src/views/share/session.spec.js  [+17 -0]
  mail-worker/src/api/share-api.js  [+6 -0]
  mail-worker/src/index.js  [+8 -0]
  mail-worker/src/security/share-document-gone.js  [+59 -0]
  mail-worker/src/service/account-service.js  [+40 -45]
  mail-worker/src/service/mail-share-service.js  [+474 -18]
  mail-worker/src/service/mailbox-provision.js  [+210 -0]
  mail-worker/src/service/share-auth-service.js  [+26 -2]
  mail-worker/test/account-delete-share.spec.js  [+9 -6]
  mail-worker/test/mail-share-emails.spec.js  [+518 -0]
  mail-worker/test/mail-share-service.spec.js  [+8 -2]
  mail-worker/test/share-api.spec.js  [+19 -9]
  mail-worker/test/share-auth-service.spec.js  [+34 -18]
  mail-worker/test/share-document-gone.spec.js  [+271 -0]
  mail-worker/test/share-integration.spec.js  [+38 -10]
  mail-worker/test/share-rate-limit.spec.js  [+21 -3]
  mail-worker/test/share-status.spec.js  [+14 -4]
  tests/e2e/harness/worker-entry.js  [+11 -0]
  tests/e2e/specs/owner-share-lifecycle.spec.js  [+73 -0]
  tests/e2e/specs/visitor-attachment.spec.js  [+12 -3]
  tests/e2e/specs/visitor-headers.spec.js  [+5 -2]
  tests/e2e/specs/visitor-revoke-live.spec.js  [+26 -42]
  tests/e2e/specs/visitor-unavailable.spec.js  [+28 -17]

### 0f4f52c · +268 -45
subject: fix(share): 落地 git-review-sweep 2026-08-26-r1 P1 批次
author_date: 2026-08-26 20:02:20 +0000 | author: Cursor Agent
files:
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md  [+5 -4]
  docs/specs/mail-share/design.md  [+6 -6]
  docs/specs/mailbox-share-capability/requirements.md  [+1 -1]
  mail-vue/src/init/init.js  [+1 -1]
  mail-vue/src/init/init.spec.js  [+6 -0]
  mail-vue/src/router/index.js  [+1 -0]
  mail-vue/src/router/index.spec.js  [+8 -0]
  mail-vue/src/views/share-admin/ShareCreateWizard.spec.js  [+20 -0]
  mail-vue/src/views/share-admin/ShareCreateWizard.vue  [+4 -2]
  mail-vue/src/views/share/index.spec.js  [+16 -0]
  mail-vue/src/views/share/index.vue  [+20 -1]
  mail-vue/src/views/share/session.js  [+34 -13]
  mail-vue/src/views/share/session.spec.js  [+12 -0]
  mail-worker/src/security/share-document-gone.js  [+1 -1]
  mail-worker/src/service/mail-share-service.js  [+51 -10]
  mail-worker/src/service/mailbox-provision.js  [+40 -6]
  mail-worker/test/mail-share-emails.spec.js  [+34 -0]
  mail-worker/test/share-document-gone.spec.js  [+8 -0]

### 8a80014 · +6 -5
subject: fix(share): D1 完整性哨兵改用 1/0 替代 RAISE
author_date: 2026-08-26 20:05:39 +0000 | author: Cursor Agent
files:
  mail-vue/src/views/share/session.spec.js  [+1 -1]
  mail-worker/src/service/mail-share-service.js  [+5 -4]

### c0a4a45 · +320 -242
subject: docs(review): 回写 2026-08-26-r1 FIX-BATCHES 关闭台账
author_date: 2026-08-26 20:07:12 +0000 | author: Cursor Agent
files:
  .agent-workspace/review-ledger/INDEX.md  [+2 -1]
  .agent-workspace/review-ledger/ledger.jsonl  [+15 -15]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/decisions.json  [+62 -1]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/report.md  [+241 -225]

### 7cafb35 · +4937 -0
subject: docs(review): git-review-sweep 2026-08-27-r1 空轮台账
author_date: 2026-08-27 02:09:20 +0000 | author: Cursor Agent
files:
  .agent-workspace/review-ledger/INDEX.md  [+20 -0]
  .agent-workspace/review-ledger/ledger.jsonl  [+30 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/artifacts/ui-t6-desktop-1280.webp  [+0 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/artifacts/ui-t6-mobile-390.webp  [+0 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/decisions.json  [+990 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/cross-theme.md  [+63 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/high-risk-t1.md  [+56 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/high-risk-t2.md  [+85 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/high-risk-t3.md  [+73 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t1-share-gone-404.md  [+24 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t2-mailbox-provision.md  [+61 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t3-emails-create.md  [+72 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t4-wizard-close-confirm.md  [+26 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t5-live-expired-status.md  [+43 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t6-visitor-otp-visual.md  [+23 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t7-spec-backfill.md  [+87 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t8-owner-e2e.md  [+20 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/t9-decision-card.md  [+51 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/ui-t4.md  [+40 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/ui-t5.md  [+53 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/raw/ui-t6.md  [+71 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/report.md  [+554 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/reviewer-l0-l1.md  [+47 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/scope.json  [+731 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/scope.md  [+183 -0]
  .agent-workspace/review-ledger/runs/2026-08-26-r1/themes.md  [+441 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/decisions.json  [+12 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/phase0-refs.json  [+380 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/report.md  [+292 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/scope.json  [+299 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/scope.md  [+80 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/themes.md  [+5 -0]
  .agent-workspace/review-ledger/state.json  [+19 -0]
  .agent-workspace/review-ledger/waivers.md  [+3 -0]
  .gitignore  [+3 -0]

### c0ede67 · +1084 -18
subject: merge: 纳入 2026-08-27-r1 空轮台账
author_date: 2026-08-27 14:08:00 +0800 | author: 7
files:
  .agent-workspace/review-ledger/INDEX.md  [+5 -6]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/decisions.json  [+12 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/phase0-refs.json  [+380 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/report.md  [+292 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/scope.json  [+299 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/scope.md  [+80 -0]
  .agent-workspace/review-ledger/runs/2026-08-27-r1/themes.md  [+5 -0]
  .agent-workspace/review-ledger/state.json  [+11 -12]

### 790c550 · +4 -28
subject: fix(share): 删除从未生效的批量创建完整性哨兵
author_date: 2026-08-27 15:17:00 +0800 | author: 7
files:
  mail-worker/src/service/mail-share-service.js  [+4 -28]

### 1da171f · +232 -18
subject: fix(share): 销毁分享的文档 404 接入限流并补齐防泄露响应头
author_date: 2026-08-27 15:17:16 +0800 | author: 7
files:
  mail-worker/src/security/share-document-gone.js  [+29 -1]
  mail-worker/src/security/share-rate-limit.js  [+46 -16]
  mail-worker/test/share-document-gone.spec.js  [+83 -0]
  mail-worker/test/share-rate-limit.spec.js  [+74 -1]

### 083c87f · +189 -31
subject: refactor(share): 访客页提示改为页内可播报,去掉 Element Plus
author_date: 2026-08-27 15:17:31 +0800 | author: 7
files:
  mail-vue/src/views/share/ShareOtpCard.spec.js  [+41 -0]
  mail-vue/src/views/share/ShareOtpCard.vue  [+9 -6]
  mail-vue/src/views/share/index.spec.js  [+61 -11]
  mail-vue/src/views/share/index.vue  [+78 -14]

## 目录 rollup

- .agent-workspace/  files=40  +11522 -264
- mail-worker/  files=17  +2130 -184
- mail-vue/  files=36  +1738 -372
- tests/  files=6  +155 -64
- docs/  files=4  +31 -14
- .gitignore/  files=1  +6 -0

## 判据源

- docs/specs/mail-share/design.md  (仓库存在的 design 规范)
- docs/specs/mail-share/requirements.md  (仓库存在的 AC 规范)
- docs/specs/mailbox-share-capability/design.md  (仓库存在的 design 规范)
- docs/specs/mailbox-share-capability/requirements.md  (仓库存在的 AC 规范)
- docs/architecture/ADR-mail-share-capability-boundary.md  (ADR)
- docs/architecture/ADR-mailbox-share-capability-extension.md  (ADR)
- docs/architecture/ADR-share-credential-recoverability.md  (ADR)
- .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md  (本轮修复批次所依据的决策卡)

仓库根不存在: AGENTS.md, ARCHITECTURE_RULES.md, CLAUDE.md, lefthook.yml, .pre-commit-config.yaml, .githooks/

## 机械闸门

- ci-workflow: `.github/workflows/deploy-cloudflare.yml`（仅部署，无 lint/test 闸门）
- 无 lefthook / pre-commit / .githooks
- 这些已覆盖的判据不要重复人工审：无（部署工作流不校验本轮代码正确性）

## 台账 carryover（open）

- F-0008 · P2 · age 2d · mail-worker/src/service/mailbox-provision.js:52 · 其他入口仍可能对 c.env.domain 做 includes 子串匹配
- F-0009 · P2 · age 2d · mail-worker/src/service/mailbox-provision.js:102 · 前缀黑名单改为大小写不敏感，设置页拒绝集收严且无 AC
- F-0010 · P2 · age 2d · mail-worker/src/service/mailbox-provision.js:5 · mailbox-provision → user-service → account-service 间接环风险
- F-0012 · P2 · age 2d · mail-vue/src/views/share-admin/index.vue:1 · 列表 status=ACTIVE 服务端筛选 vs 本地翻 EXPIRED 卡片同屏
- F-0013 · P2 · age 2d · mail-vue/src/views/share-admin/use-share-clock.js:1 · 每行 ShareRowActions 各自 useShareClock → N 个 setInterval + 监听
- F-0014 · P2 · age 2d · mail-vue/src/views/email/ShareIndicator.vue:1 · ShareIndicator 自建 visibility/focus 监听只在 onUnmounted 摘，keep-alive deactivate 残留
- F-0020 · P2 · age 2d · docs/specs/mail-share/design.md:6 · front-matter 仍 converged / shipped_commit null，正文已记 shipped 后整改
- F-0021 · P2 · age 2d · docs/architecture/ADR-mail-share-capability-boundary.md:1 · P4 推翻三轮安全性质未 amend Accepted ADR
- F-0023 · P2 · age 2d · mail-vue/src/views/share-admin/ShareCreateWizard.vue:1 · 「我已保存」按钮语义像确认已复制，实际再走创建/清结果
- F-0024 · P2 · age 2d · mail-vue/src/views/share-admin/ShareCreateWizard.vue:1 · 创建错误提示远离 emails 输入
- F-0025 · P2 · age 2d · mail-vue/src/views/email/ShareDialog.vue:1 · ShareDialog 状态非徽章，与管理列表不一致
- F-0026 · P2 · age 2d · mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1 · EXPIRED 抽屉与行操作可做动作不一致
- F-0027 · P2 · age 2d · mail-vue/src/views/share/index.vue:1 · 390 视口 header 横向溢出约 8px
- F-0029 · P2 · age 2d · mail-vue/src/views/share/index.vue:1 · 终态卡只 text-align 未在视口垂直居中
- F-0030 · suggestion · age 2d · mail-worker/src/service/mail-share-service.js:817 · 注释声称同 batch 可见刚插入的 account；T-02 只证回滚与不得消费前序结果

## 已审不重开

以下 sha 已在 2026-08-26-r1 对 share-link-fullchain 审过，现已 merge 进 main。聚类时标 already-reviewed，只在后续修复触及同一文件时做回归确认，不要当新功能重审：
1288ac85, b3658104, fabe6e84, d602ec66, e309ad4a, 82f330e7, 37062220, 9b6eb807

