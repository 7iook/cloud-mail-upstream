# Scope · 2026-08-27-r1

repo: /workspace
mode: cursor | range: multi-ref cursor + completion-signal | form: B
cursor_eligible: false (空轮不推进游标)
commits: 0 | files: 0 | +0 -0
判定: 无新提交

## 完成信号 / 范围

### skipped: in-progress (游标冻结)

- skipped: origin/cursor/git-5c8a in-progress · HEAD 331c92133474 · age 5.88h < 6h · PR#6 OPEN draft=True
- skipped: origin/cursor/git-e148 in-progress · HEAD c0a4a45dc594 · age 6.0h < 6h · PR#5 OPEN draft=True

### complete · 无未审提交

- cursor/git-7d43 HEAD 12cec61a0d4a · new-ref merge-base 12cec61a0d4a..12cec61a0d4a · commits=0 · reasons=['silent 43.47h >=6h']
- main HEAD 12cec61a0d4a · 12cec61a0d4a..12cec61a0d4a · commits=0 · reasons=['silent 43.47h >=6h']
- origin HEAD 12cec61a0d4a · 12cec61a0d4a..12cec61a0d4a · commits=0 · reasons=['silent 43.47h >=6h']
- origin/cursor/mailbox-share-capability-dcb6 HEAD f99459d69904 · f99459d69904..f99459d69904 · commits=0 · reasons=['PR#3 merged', 'silent 57.54h >=6h']
- origin/cursor/mailbox-share-capability-spec-4743 HEAD e120a0403872 · e120a0403872..e120a0403872 · commits=0 · reasons=['PR#2 merged', 'silent 68.26h >=6h']
- origin/cursor/setup-cloud-agent-env-3558 HEAD 6985f0ef0942 · 6985f0ef0942..6985f0ef0942 · commits=0 · reasons=['PR#1 merged', 'silent 71.06h >=6h']
- origin/cursor/share-link-fullchain-8a38 HEAD 9b6eb8072fe7 · 9b6eb8072fe7..9b6eb8072fe7 · commits=0 · reasons=['silent 17.08h >=6h']
- origin/main HEAD 12cec61a0d4a · 12cec61a0d4a..12cec61a0d4a · commits=0 · reasons=['silent 43.47h >=6h']

## 提交

(空 · 本范围内无提交)

## 目录 rollup(按 churn 降序)

(空)

## 判据源(仓库自有规范 · SUB 必须实际打开读)

- docs/specs/mail-share/design.md   (仓库存在的 design 规范)
- docs/specs/mailbox-share-capability/design.md   (仓库存在的 design 规范)
- docs/architecture/ADR-mail-share-capability-boundary.md
- docs/architecture/ADR-mailbox-share-capability-extension.md
- docs/architecture/ADR-share-credential-recoverability.md
- (仓库根无 AGENTS.md / CLAUDE.md / ARCHITECTURE_RULES.md)

## 机械闸门(已由 pre-commit / CI 自动校验 · 禁重复人工审)

- ci-workflow: deploy-cloudflare.yml
- (无 lefthook.yml / .pre-commit-config.yaml / .githooks/)

## 台账 carryover(历史未闭合条目)

- F-0008 · P2 · open · age 1d · mail-worker/src/service/mailbox-provision.js:52
    其他入口仍可能对 c.env.domain 做 includes 子串匹配
- F-0009 · P2 · open · age 1d · mail-worker/src/service/mailbox-provision.js:102
    前缀黑名单改为大小写不敏感，设置页拒绝集收严且无 AC
- F-0010 · P2 · open · age 1d · mail-worker/src/service/mailbox-provision.js:5
    mailbox-provision → user-service → account-service 间接环风险
- F-0012 · P2 · open · age 1d · mail-vue/src/views/share-admin/index.vue:1
    列表 status=ACTIVE 服务端筛选 vs 本地翻 EXPIRED 卡片同屏
- F-0013 · P2 · open · age 1d · mail-vue/src/views/share-admin/use-share-clock.js:1
    每行 ShareRowActions 各自 useShareClock → N 个 setInterval + 监听
- F-0014 · P2 · open · age 1d · mail-vue/src/views/email/ShareIndicator.vue:1
    ShareIndicator 自建 visibility/focus 监听只在 onUnmounted 摘，keep-alive deactivate 残留
- F-0020 · P2 · open · age 1d · docs/specs/mail-share/design.md:6
    front-matter 仍 converged / shipped_commit null，正文已记 shipped 后整改
- F-0021 · P2 · open · age 1d · docs/architecture/ADR-mail-share-capability-boundary.md:1
    P4 推翻三轮安全性质未 amend Accepted ADR
- F-0023 · P2 · open · age 1d · mail-vue/src/views/share-admin/ShareCreateWizard.vue:1
    「我已保存」按钮语义像确认已复制，实际再走创建/清结果
- F-0024 · P2 · open · age 1d · mail-vue/src/views/share-admin/ShareCreateWizard.vue:1
    创建错误提示远离 emails 输入
- F-0025 · P2 · open · age 1d · mail-vue/src/views/email/ShareDialog.vue:1
    ShareDialog 状态非徽章，与管理列表不一致
- F-0026 · P2 · open · age 1d · mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1
    EXPIRED 抽屉与行操作可做动作不一致
- F-0027 · P2 · open · age 1d · mail-vue/src/views/share/index.vue:1
    390 视口 header 横向溢出约 8px
- F-0029 · P2 · open · age 1d · mail-vue/src/views/share/index.vue:1
    终态卡只 text-align 未在视口垂直居中
- F-0030 · suggestion · open · age 1d · mail-worker/src/service/mail-share-service.js:817
    注释声称同 batch 可见刚插入的 account；T-02 只证回滚与不得消费前序结果
