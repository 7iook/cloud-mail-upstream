# Scope · 2026-08-26-r1

repo: /workspace
mode: cursor | range: 12cec61a0d4a1e7c99d1316b9ef9b75715c893b3..9b6eb8072fe73c93518e872037702a2e8e54056b | ref: origin/cursor/share-link-fullchain-8a38 (9b6eb8072fe73c93518e872037702a2e8e54056b)
effective_since: None | effective_until: None | merge_policy: include-first-parent-churn | cursor_eligible: True
range_note: 首轮无台账 · 多 ref 完成信号过滤 · 入选 origin/cursor/share-link-fullchain-8a38 (silent>=10h, new-to-ledger from merge-base origin/main)
commits: 8 | files: 63 | +4756 -518
form: B (pwsh 不可用, 主 AI 等价采集)
worktree_for_review: /tmp/review-share-fullchain  (detached at reviewed HEAD)

## 多 ref 完成信号

- cursor/git-e148 · skipped: identical-to-main
- main / origin/main · completed(silent>=36h) · first-round --since=yesterday → 0 commits
- origin · skipped: alias
- origin/cursor/mailbox-share-capability-dcb6 · completed(pr-merged #3) · unique=0
- origin/cursor/mailbox-share-capability-spec-4743 · completed(pr-merged #2) · unique=0
- origin/cursor/setup-cloud-agent-env-3558 · completed(pr-merged #1) · squash leftover, 不当新工作审
- origin/cursor/share-link-fullchain-8a38 · completed(silent>=10h, PR #4 still OPEN) · unique=8 ← 本轮入选
- skipped in-progress: (无)

## 提交

### 9b6eb80 · docs · +15 -7
subject: docs(share): 回写决策卡任务清单与独立复跑证据
author_date: 2026-08-26T09:02:08+00:00 | committer_date: 2026-08-26T09:02:08+00:00 | author: Cursor Agent
files:
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md  [+15 -7]

### 3706222 · test · +84 -0
subject: test(e2e): 补 Owner 创建/过期/关窗的浏览器验收
author_date: 2026-08-26T09:01:44+00:00 | committer_date: 2026-08-26T09:01:44+00:00 | author: Cursor Agent
files:
  tests/e2e/harness/worker-entry.js  [+11 -0]
  tests/e2e/specs/owner-share-lifecycle.spec.js  [+73 -0]

### 82f330e · docs · +24 -7
subject: docs(share): 回写 shipped spec 的 404 与 emails 契约
author_date: 2026-08-26T09:01:44+00:00 | committer_date: 2026-08-26T09:01:44+00:00 | author: Cursor Agent
files:
  docs/specs/mail-share/design.md  [+11 -0]
  docs/specs/mail-share/requirements.md  [+3 -3]
  docs/specs/mailbox-share-capability/design.md  [+7 -1]
  docs/specs/mailbox-share-capability/requirements.md  [+3 -3]

### e309ad4 · feat · +396 -70
subject: feat(share): 按设计卡重做访客收码页视觉
author_date: 2026-08-26T09:01:44+00:00 | committer_date: 2026-08-26T09:01:44+00:00 | author: Cursor Agent
files:
  mail-vue/src/views/share/ShareOtpCard.vue  [+36 -11]
  mail-vue/src/views/share/index.spec.js  [+105 -5]
  mail-vue/src/views/share/index.vue  [+255 -54]

### d602ec6 · fix · +720 -118
subject: fix(share): 销毁与不存在的分享返回原生 404
author_date: 2026-08-26T09:01:28+00:00 | committer_date: 2026-08-26T09:01:28+00:00 | author: Cursor Agent
files:
  mail-vue/src/composables/useSharePolling.js  [+4 -1]
  mail-vue/src/composables/useSharePolling.spec.js  [+20 -1]
  mail-vue/src/request/share.js  [+19 -0]
  mail-vue/src/request/share.spec.js  [+47 -0]
  mail-vue/src/views/share/session.js  [+37 -0]
  mail-vue/src/views/share/session.spec.js  [+17 -0]
  mail-worker/src/api/share-api.js  [+6 -0]
  mail-worker/src/index.js  [+8 -0]
  mail-worker/src/security/share-document-gone.js  [+59 -0]
  mail-worker/src/service/share-auth-service.js  [+26 -2]
  mail-worker/test/account-delete-share.spec.js  [+9 -6]
  mail-worker/test/share-api.spec.js  [+19 -9]
  mail-worker/test/share-auth-service.spec.js  [+34 -18]
  mail-worker/test/share-document-gone.spec.js  [+271 -0]
  mail-worker/test/share-integration.spec.js  [+38 -10]
  mail-worker/test/share-rate-limit.spec.js  [+21 -3]
  mail-worker/test/share-status.spec.js  [+14 -4]
  tests/e2e/specs/visitor-attachment.spec.js  [+12 -3]
  tests/e2e/specs/visitor-headers.spec.js  [+5 -2]
  tests/e2e/specs/visitor-revoke-live.spec.js  [+26 -42]
  tests/e2e/specs/visitor-unavailable.spec.js  [+28 -17]

### fabe6e8 · feat · +1679 -284
subject: feat(share): 完整邮箱创建分享并去掉关闭确认
author_date: 2026-08-26T09:01:20+00:00 | committer_date: 2026-08-26T09:01:20+00:00 | author: Cursor Agent
files:
  mail-vue/src/i18n/en.js  [+11 -2]
  mail-vue/src/i18n/zh.js  [+11 -2]
  mail-vue/src/request/mail-share.js  [+9 -3]
  mail-vue/src/views/share-admin/ShareCreateWizard.spec.js  [+193 -75]
  mail-vue/src/views/share-admin/ShareCreateWizard.vue  [+153 -136]
  mail-vue/src/views/share-admin/presets.js  [+45 -0]
  mail-vue/src/views/share-admin/presets.spec.js  [+7 -1]
  mail-worker/src/service/account-service.js  [+40 -45]
  mail-worker/src/service/mail-share-service.js  [+474 -18]
  mail-worker/src/service/mailbox-provision.js  [+210 -0]
  mail-worker/test/mail-share-emails.spec.js  [+518 -0]
  mail-worker/test/mail-share-service.spec.js  [+8 -2]

### b365810 · fix · +457 -32
subject: fix(share): Owner 过期状态按 expiresAt 实时覆盖
author_date: 2026-08-26T09:01:15+00:00 | committer_date: 2026-08-26T09:01:15+00:00 | author: Cursor Agent
files:
  mail-vue/src/views/email/ShareDialog.spec.js  [+21 -3]
  mail-vue/src/views/email/ShareDialog.vue  [+5 -3]
  mail-vue/src/views/email/ShareIndicator.spec.js  [+86 -0]
  mail-vue/src/views/email/ShareIndicator.vue  [+22 -2]
  mail-vue/src/views/email/index.vue  [+5 -1]
  mail-vue/src/views/share-admin/ShareDetailDrawer.spec.js  [+32 -9]
  mail-vue/src/views/share-admin/ShareDetailDrawer.vue  [+8 -4]
  mail-vue/src/views/share-admin/ShareRowActions.spec.js  [+19 -0]
  mail-vue/src/views/share-admin/ShareRowActions.vue  [+8 -3]
  mail-vue/src/views/share-admin/index.spec.js  [+25 -3]
  mail-vue/src/views/share-admin/index.vue  [+22 -4]
  mail-vue/src/views/share-admin/status.js  [+26 -0]
  mail-vue/src/views/share-admin/status.spec.js  [+48 -0]
  mail-vue/src/views/share-admin/use-share-clock.js  [+55 -0]
  mail-vue/src/views/share-admin/use-share-clock.spec.js  [+75 -0]

### 1288ac8 · docs · +1381 -0
subject: docs(share): 决策卡 Goal→Outcome 与 spec 审查改向
author_date: 2026-08-26T06:42:37+00:00 | committer_date: 2026-08-26T06:42:37+00:00 | author: Cursor Agent
files:
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md  [+24 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/prompt.round1.sub.txt  [+644 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-expired-status-rca.md  [+71 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md  [+413 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.review1.sub.md  [+177 -0]
  .agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md  [+52 -0]

## 目录 rollup(按 churn 降序)

- mail-vue/src/views  files=24 churn=1619
- .agent-workspace/.archive/2026-08-26  files=6 churn=1403
- mail-worker/src/service  files=4 churn=815
- mail-worker/test/mail-share-emails.spec.js  files=1 churn=518
- mail-worker/test/share-document-gone.spec.js  files=1 churn=271
- tests/e2e/specs  files=5 churn=208
- mail-vue/src/request  files=3 churn=78
- mail-worker/src/security  files=1 churn=59
- mail-worker/test/share-auth-service.spec.js  files=1 churn=52
- mail-worker/test/share-integration.spec.js  files=1 churn=48
- mail-worker/test/share-api.spec.js  files=1 churn=28
- mail-vue/src/composables  files=2 churn=26
- mail-vue/src/i18n  files=2 churn=26
- mail-worker/test/share-rate-limit.spec.js  files=1 churn=24
- mail-worker/test/share-status.spec.js  files=1 churn=18
- docs/specs/mail-share  files=2 churn=17
- mail-worker/test/account-delete-share.spec.js  files=1 churn=15
- docs/specs/mailbox-share-capability  files=2 churn=14
- tests/e2e/harness  files=1 churn=11
- mail-worker/test/mail-share-service.spec.js  files=1 churn=10
- mail-worker/src/index.js  files=1 churn=8
- mail-worker/src/api  files=1 churn=6

## 判据源(仓库自有规范 · SUB 必须实际打开读)

- docs/specs/mail-share/design.md   (改动路径沿途规范(Linux 大小写敏感未命中 DESIGN.md))
- docs/specs/mail-share/requirements.md   (改动路径沿途规范)
- docs/specs/mailbox-share-capability/design.md   (改动路径沿途规范)
- docs/specs/mailbox-share-capability/requirements.md   (改动路径沿途规范)
- .github/workflows/deploy-cloudflare.yml   (机械闸门源)

### ADR 清单(按主题相关性自行挑读,勿全读)
- docs/architecture/ADR-mail-share-capability-boundary.md  ADR: Mail Share 资源级 Capability 授权边界
- docs/architecture/ADR-mailbox-share-capability-extension.md  ADR: Mailbox Share 能力扩展 —— 多邮箱 Binding、Session 配额闸门与可选认证 Key
- docs/architecture/ADR-share-credential-recoverability.md  ADR: 分享凭据 `sec` 的可恢复性(部分取代「明文恰一次」不变量)

## 机械闸门(已由 pre-commit / CI 自动校验 · 禁重复人工审)

- ci-workflow: deploy-cloudflare.yml
  覆盖: push to main 且路径命中 mail-worker/** 或 mail-vue/** 时的 Cloudflare 部署。
  不覆盖: 单测/lint/类型/密钥扫描/架构闸门。仓库无 lefthook / pre-commit / .githooks。
  因此本轮审查不得把「CI 已测过正确性」当作已覆盖; 仅部署流水线本身不必人工复审。

## 台账 carryover(历史未闭合条目)

(无 · 本仓库首轮 bootstrap)

## 仓库规范缺口(Phase 0 扫描事实)

- 仓库根无 AGENTS.md / CLAUDE.md / ARCHITECTURE_RULES.md / DESIGN.md
- 改动路径沿途无嵌套 AGENTS.md / DESIGN.md(大写)
- 判据以 docs/specs/*/design.md + requirements.md + docs/architecture/ADR-*.md 为准
- production-antipatterns catalog 不是仓库条款; 无仓库条款时 reviewer 可引用可复现契约/测试后置条件/安全不变量, 否则降 suggestion

