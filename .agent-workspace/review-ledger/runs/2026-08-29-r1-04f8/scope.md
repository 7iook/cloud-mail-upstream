# Scope · 2026-08-29-r1-04f8

repo: /workspace
mode: cursor | range: 083c87f2d2ccc8c459adfd45fc31a43afc63256f..4ea2efc1d0d385f63df322933a2154bf329f68c9 | ref: origin/cursor/git-8934
cursor_eligible: true （仅该新 ref；main 游标已被 2026-08-28-r1 推到 HEAD）
commits: 5 | files: 33 | +4897 -210
form: B (pwsh 不可用且 collect-scope 无 .py, 主 AI 等价采集)
worktree_for_review: /tmp/review-git-8934  (detached at reviewed HEAD 4ea2efc)
instance: cursor-cursor/git-e2cd-1636-04f8
models: recon=claude-opus-5-thinking-high-fast · reviewer=gpt-5.6-sol-xhigh-fast · converge/fix=claude-opus-5-thinking-high-fast

## 多 ref 完成信号

- origin/cursor/git-8934 · completed(silent 22.95h >=6h, PR#8 OPEN draft) · new-ref merge-base origin/main · unique=5 ← 本轮入选
- origin/main / main / origin · completed(silent 42.9h >=6h) · cursor 已由 2026-08-28-r1 推到 083c87f · unique=0（9b6eb80..083c87f 已审，不当新工作重审）
- cursor/git-e2cd · skipped: in-progress （本轮交付分支 · unique vs main = 0 · 游标冻结）
- origin/cursor/share-link-fullchain-8a38 · completed(PR#4 merged + deleted) · 已审
- origin/cursor/git-e148 · completed(PR#5 merged + deleted) · 已在 main
- origin/cursor/git-5c8a · completed(PR#6 closed + deleted) · 工作重写为 790c550/1da171f/083c87f，已由 2026-08-28-r1 审
- origin/cursor/git-7d43 · completed(PR#7 merged + deleted)
- origin/cursor/mailbox-share-capability-* / setup-cloud-agent-env-3558 · completed(PR merged + deleted)
- open PRs: #8 draft=cursor/git-8934

## 提交

### 4ea2efc · +30 -119
subject: docs(review): 关闭 2026-08-28-r1 B1/B2 七条 finding
author_date: 2026-08-28T03:16:45+00:00 | author: Cursor Agent
files:
  .agent-workspace/review-ledger/INDEX.md  [+4 -3]
  .agent-workspace/review-ledger/ledger.jsonl  [+7 -7]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/report.md  [+19 -109]

### 6ad2686 · +852 -67
subject: fix(share): 整单原子/配额谓词 + 向导 unknownResult 持久化
author_date: 2026-08-28T03:15:44+00:00 | author: Cursor Agent
files:
  mail-vue/src/views/share-admin/ShareCreateWizard.spec.js  [+184 -0]
  mail-vue/src/views/share-admin/ShareCreateWizard.vue  [+255 -25]
  mail-worker/src/service/mail-share-service.js  [+108 -33]
  mail-worker/src/service/mailbox-provision.js  [+31 -5]
  mail-worker/test/mail-share-emails.spec.js  [+274 -4]

### 200daa9 · +2212 -24
subject: docs(review): 2026-08-28-r1 归并台账与审查报告
author_date: 2026-08-28T02:59:21+00:00 | author: Cursor Agent
files:
  .agent-workspace/review-ledger/INDEX.md  [+5 -4]
  .agent-workspace/review-ledger/ledger.jsonl  [+24 -11]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/decisions.json  [+681 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/cross-theme.md  [+53 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/high-risk-t1.md  [+53 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/high-risk-t2.md  [+75 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/high-risk-t3.md  [+85 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t1-batch-atomicity.md  [+26 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t2-quota-predicate.md  [+108 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t3-gone-404-ratelimit.md  [+46 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t4-spa-gone-overflow.md  [+45 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t5-visitor-elmessage.md  [+86 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t6-wizard-idempotency.md  [+65 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t7-spec-writeback.md  [+47 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t8-merge-regression.md  [+35 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/t9-ledger.md  [+26 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/ui-t3.md  [+56 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/ui-t4.md  [+32 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/ui-t5.md  [+66 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/raw/ui-t6.md  [+80 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/report.md  [+506 -0]
  .agent-workspace/review-ledger/state.json  [+10 -9]
  .gitattributes  [+2 -0]

### d244fc2 · +1460 -0
subject: docs(review): 2026-08-28-r1 Phase 0 范围与 L0/L1
author_date: 2026-08-28T02:28:02+00:00 | author: Cursor Agent
files:
  .agent-workspace/review-ledger/runs/2026-08-28-r1/phase0-refs.json  [+443 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/reviewer-l0-l1.md  [+70 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/scope.json  [+652 -0]
  .agent-workspace/review-ledger/runs/2026-08-28-r1/scope.md  [+295 -0]

### ea1434c · +343 -0
subject: docs(review): 2026-08-28-r1 变更聚类侦察产出 themes
author_date: 2026-08-28T02:25:53+00:00 | author: Cursor Agent
files:
  .agent-workspace/review-ledger/runs/2026-08-28-r1/themes.md  [+343 -0]

## 目录 rollup(按 churn 降序)

- .agent-workspace/review-ledger: 27 files +4043 -143
- mail-vue/src: 2 files +439 -25
- mail-worker/test: 1 files +274 -4
- mail-worker/src: 2 files +139 -38
- .gitattributes: 1 files +2 -0

## 判据源(仓库自有规范 · SUB 必须实际打开读)

- .agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md   (存在)
- .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md   (存在)
- .agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md   (存在)
- docs/architecture/ADR-mail-share-capability-boundary.md   (存在)
- docs/architecture/ADR-mailbox-share-capability-extension.md   (存在)
- docs/architecture/ADR-share-credential-recoverability.md   (存在)
- docs/specs/mail-share/design.md   (存在)
- docs/specs/mail-share/requirements.md   (存在)
- docs/specs/mailbox-share-capability/design.md   (存在)
- docs/specs/mailbox-share-capability/requirements.md   (存在)
- (仓库根无 AGENTS.md / CLAUDE.md / ARCHITECTURE_RULES.md)

## 机械闸门(已由 pre-commit / CI 自动校验 · 禁重复人工审)

- ci-workflow: .github/workflows/deploy-cloudflare.yml
- (无 lefthook.yml / .pre-commit-config.yaml / .githooks/)

## 台账 carryover(历史未闭合条目 · 以 git-8934 上 2026-08-28-r1 台账为准)

- F-0008 · P2 · persists · opened 2026-08-26 · mail-worker/src/service/mailbox-provision.js:52
    其他入口仍可能对 c.env.domain 做 includes 子串匹配
- F-0009 · P2 · persists · opened 2026-08-26 · mail-worker/src/service/mailbox-provision.js:102
    前缀黑名单改为大小写不敏感，设置页拒绝集收严且无 AC
- F-0010 · P2 · persists · opened 2026-08-26 · mail-worker/src/service/mailbox-provision.js:6
    mailbox-provision → user-service → account-service 间接环风险
- F-0012 · P2 · open · opened 2026-08-26 · mail-vue/src/views/share-admin/index.vue:1
    列表 status=ACTIVE 服务端筛选 vs 本地翻 EXPIRED 卡片同屏
- F-0013 · P2 · open · opened 2026-08-26 · mail-vue/src/views/share-admin/use-share-clock.js:1
    每行 ShareRowActions 各自 useShareClock → N 个 setInterval + 监听
- F-0014 · P2 · open · opened 2026-08-26 · mail-vue/src/views/email/ShareIndicator.vue:1
    ShareIndicator 自建 visibility/focus 监听只在 onUnmounted 摘，keep-alive deactivate 残留
- F-0020 · P2 · persists · opened 2026-08-26 · docs/specs/mail-share/design.md:6
    front-matter 仍 converged / shipped_commit null，正文已记 shipped 后整改
- F-0021 · P2 · persists · opened 2026-08-26 · docs/architecture/ADR-mailbox-share-capability-extension.md:26
    P4 推翻三轮安全性质未 amend Accepted ADR
- F-0023 · P2 · persists · opened 2026-08-26 · mail-vue/src/views/share-admin/ShareCreateWizard.vue:98
    「我已保存」按钮语义像确认已复制，实际再走创建/清结果
- F-0024 · P2 · persists · opened 2026-08-26 · mail-vue/src/views/share-admin/ShareCreateWizard.vue:349
    创建错误提示远离 emails 输入
- F-0025 · P2 · open · opened 2026-08-26 · mail-vue/src/views/email/ShareDialog.vue:1
    ShareDialog 状态非徽章，与管理列表不一致
- F-0026 · P2 · open · opened 2026-08-26 · mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1
    EXPIRED 抽屉与行操作可做动作不一致
- F-0027 · P2 · persists · opened 2026-08-26 · mail-vue/src/views/share/index.vue:1220
    390 视口 header 横向溢出约 8px
- F-0029 · P2 · persists · opened 2026-08-26 · mail-vue/src/views/share/index.vue:1207
    终态卡只 text-align 未在视口垂直居中
- F-0030 · suggestion · persists · opened 2026-08-26 · mail-worker/src/service/mail-share-service.js:817
    注释声称同 batch 可见刚插入的 account；T-02 只证回滚与不得消费前序结果
- F-0f510dbd · P2 · open · opened 2026-08-28 · mail-vue/src/router/index.js:70
    Vue alias 保留地址栏 /S/；_headers 只声明 /s/*，活文档大写路径缺 no-store/no-referrer/noindex/CSP
- F-1e2784c9 · P2 · open · opened 2026-08-28 · mail-vue/src/components/safe-mail/index.vue:5
    删掉三处 ElMessage 后 share 路由仍经 SafeMailRenderer 拉取 el-button/el-alert
- F-3e800473 · P2 · open · opened 2026-08-28 · mail-vue/src/views/share/index.vue:1183
    overflow-wrap 未覆盖 OTP 卡内无 class 的发件人行，超长 token 被 shell 裁切
- F-618c6bfa · P2 · open · opened 2026-08-28 · mail-vue/src/views/share/index.vue:130
    三处 v-if 与 role=status 同节点挂载；首次前无 live region，重复靠换 key 重建
- F-6d14486f · P2 · open · opened 2026-08-28 · mail-worker/src/security/share-document-gone.js:69
    文档 GET 与四个访客读 API 共用 100/60s 桶；桶耗尽后刷新得到空 body 429，SPA 未加载无法退避
- F-bbdc807b · P2 · open · opened 2026-08-28 · tests/e2e/wrangler-e2e.toml:17
    e2e 未绑定 SHARE_READ_RATE_LIMITER，gone 404 用例只覆盖 fail-open
- F-f22137e9 · P2 · open · opened 2026-08-28 · mail-vue/src/views/share/index.vue:640
    selectTab 不调用 clearNewMailNotice，旧 Tab 横幅挂到新 Tab
