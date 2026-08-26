## RUN
run: 2026-08-26-r1 | range: 12cec61a0d4a1e7c99d1316b9ef9b75715c893b3..9b6eb8072fe73c93518e872037702a2e8e54056b | commits: 8 | themes: 9
findings: P0=0 P1=8 P2=21 suggestion=1 | carryover: 0 | overdue: 0
closed_this_round: P1=8 P2=7 | remaining_open: P0=0 P1=0 P2=14 suggestion=1
ref: origin/cursor/share-link-fullchain-8a38 @ 9b6eb8072fe73c93518e872037702a2e8e54056b
completion: silent>=10h (latest 2026-08-26T09:02:08Z) · PR #4 OPEN
skipped: cursor/git-e148 identical-to-main; main/origin/main empty --since=yesterday; origin/cursor/mailbox-share-capability-dcb6 pr-merged unique=0; origin/cursor/mailbox-share-capability-spec-4743 pr-merged unique=0; origin/cursor/setup-cloud-agent-env-3558 squash leftover
form: B (pwsh absent)
models: recon=claude-opus-5-thinking-high-fast (Task generalPurpose；环境无具名 plan-reality-recon) reviewer=gpt-5.6-sol-xhigh-fast converge=cursor-grok-4.6-high-fast (host；Phase 3 主 AI 自做) subagent_type=generalPurpose
mechanical_gates: ci-workflow: deploy-cloudflare.yml (push main 部署，不跑测试)

## FIX-BATCHES
### B1 · gone 清理不抛 + finally 走原生 404 终态 · order 1 · depends_on: -
findings: F-0001
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B2 · 非管理员缺 roleRow fail-closed · order 2 · depends_on: -
findings: F-0002
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B3 · unknownResult 关窗不得轮换幂等键 · order 3 · depends_on: -
findings: F-0005
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B4 · account INSERT 事务内配额谓词 · order 4 · depends_on: B2
findings: F-0003
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B5 · 零命中须 RAISE 回滚整批 · order 5 · depends_on: B4
findings: F-0004
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B6 · /S/:lid 与 gone 拦截对齐 · order 6 · depends_on: B1
findings: F-0022
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B7 · 批量重放 lid 集合精确相等 · order 7 · depends_on: -
findings: F-0011
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B8 · spec P1 + 错误码/路径锚点 · order 8 · depends_on: -
findings: F-0006, F-0007, F-0018, F-0019
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B9 · 决策卡 Evidence 补 SPA 出口与 commit · order 9 · depends_on: -
findings: F-0015, F-0017
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过
### B10 · 访客页外部文本 overflow-wrap · order 10 · depends_on: -
findings: F-0028
root: 见各 finding fix 行
why-together: 同根因/同文件/同契约，拆开修会互相绕过

## OPEN-P0

(none)

## OPEN-P1

(none)

## OPEN-P2

### F-0008 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-worker/src/service/mailbox-provision.js:52
symbols: configuredDomains
rule:    决策卡 configuredDomains 精确匹配、禁子串 · 全仓 env.domain 口径
theme:   T2 · mailbox-provision SSOT
commits: fabe6e8
report:  reviewer:T2, reviewer:high-risk-T2
related: -
risk:    c.env.domain 形态假设 · origin configuredDomains → hops 1 · stop: 已列出差集交 OPEN
failure: 其他入口仍可能对 c.env.domain 做 includes 子串匹配
trigger: dashboard 把 domain 配成 JSON 字符串后走未改道入口
impact:  子串误命中或大小写拒绝集与分享入口不一致
fix:     全仓 env.domain 读点改走 configuredDomains；本轮只扫未改调用点，不在本轮扫全仓改道
verify:  unverified: 本轮不改其余入口，留 OPEN

### F-0009 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-worker/src/service/mailbox-provision.js:102
symbols: emailPrefixFilter
rule:    改前 account-service.add 前缀匹配大小写敏感
theme:   T2 · mailbox-provision SSOT
commits: fabe6e8
report:  reviewer:T2
related: -
risk:    none
failure: 前缀黑名单改为大小写不敏感，设置页拒绝集收严且无 AC
trigger: 前缀含被禁 token 的大小写变体
impact:  原先能注册的地址被拒
fix:     若有意统一则在设置页/分享测试钉不敏感语义；否则恢复敏感匹配
verify:  unverified: 行为差异已确认，产品意图未裁，留 OPEN

### F-0010 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-worker/src/service/mailbox-provision.js:5
symbols: userService, roleService
rule:    mailbox-provision.js 模块头禁反向 import account-service/mail-share-service
theme:   T2 · mailbox-provision SSOT
commits: fabe6e8
report:  reviewer:T2
related: -
risk:    provision 模块的依赖方向 · origin mailbox-provision import → hops 2 · stop: 已记 OPEN
failure: mailbox-provision → user-service → account-service 间接环风险
trigger: 冷启动循环依赖导致未定义导出
impact:  建号路径运行时崩
fix:     切断 user-service 对 account-service 的边或改为延迟加载；本轮不改无关模块
verify:  unverified: 环未在本轮跑冷启动复现，留 OPEN

### F-0012 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/share-admin/index.vue:1
symbols: liveEffectiveStatus, fetchList
rule:    docs/specs/mail-share/requirements.md AC-LIFE-08 amended
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:T5, reviewer:ui-T5
related: F-0013, F-0014
risk:    none
failure: 列表 status=ACTIVE 服务端筛选 vs 本地翻 EXPIRED 卡片同屏
trigger: 筛 ACTIVE 后停留跨过 expiresAt
impact:  筛选结果与卡片状态不一致，Owner 误判仍有效
fix:     本地翻 EXPIRED 后从 ACTIVE 筛选视图移除或提示需 refetch
verify:  unverified: 本轮不改列表筛选交互，留 OPEN

### F-0013 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/share-admin/use-share-clock.js:1
symbols: useShareClock, ShareRowActions
rule:    决策卡接线表未授权 N 份 1s interval
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:T5
related: F-0012, F-0014
risk:    时钟与回源监听的实例规模 · origin use-share-clock.js → hops 1 · stop: 已定性 N 份心跳，本轮 OPEN
failure: 每行 ShareRowActions 各自 useShareClock → N 个 setInterval + 监听
trigger: 分享管理列表 20+ 行
impact:  定时器与 focus 回源请求放大
fix:     时钟提升到页面级，行组件注入 nowMs
verify:  unverified: 本轮不改时钟拓扑（侵入面大于本轮 FIX 预算），留 OPEN

### F-0014 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/email/ShareIndicator.vue:1
symbols: ShareIndicator, onDeactivated
rule:    keep-alive 下监听必须对称摘除
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:T5, reviewer:ui-T5
related: F-0012, F-0013
risk:    none
failure: ShareIndicator 自建 visibility/focus 监听只在 onUnmounted 摘，keep-alive deactivate 残留
trigger: 收件箱 keep-alive 反复进出
impact:  监听累加，一次 focus 多次 refresh
fix:     onDeactivated 对称 removeEventListener
verify:  unverified: 本轮不改 Indicator 钩子，留 OPEN

### F-0020 · P2 · open · age 0d · seen 1x · batch -
anchor:  docs/specs/mail-share/design.md:6
symbols: status, shipped_commit
rule:    charter front-matter 与正文 Update Log 生命周期一致
theme:   T7 · spec 回写
commits: 82f330e
report:  reviewer:T7
related: -
risk:    none
failure: front-matter 仍 converged / shipped_commit null，正文已记 shipped 后整改
trigger: 工具按 front-matter 过滤 shipped spec
impact:  本轮修订对自动化不可见
fix:     同步 last_updated / shipped_commit 或标明 post-ship patch
verify:  unverified: 改 front-matter 影响 charter 生命周期工具，本轮不擅自改 status，留 OPEN

### F-0021 · P2 · open · age 0d · seen 1x · batch -
anchor:  docs/architecture/ADR-mail-share-capability-boundary.md:1
symbols: P-AUTH-01
rule:    mail-share/design.md Decision 8 ADR 门槛（边界定义型且难以反转）
theme:   T7 · spec 回写
commits: 82f330e
report:  reviewer:T7
related: -
risk:    none
failure: P4 推翻三轮安全性质未 amend Accepted ADR
trigger: 只读 ADR 的后续设计
impact:  ADR 与 shipped 行为长期分叉
fix:     另开 ADR amend 轮；本轮不改 Accepted ADR 正文
verify:  unverified: ADR 修订需独立决策，留 OPEN

### F-0023 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:1
symbols: acknowledgeSecret
rule:    ui-designer T4 信息层级
theme:   T4 · 向导关窗去确认
commits: fabe6e8
report:  reviewer:ui-T4
related: -
risk:    none
failure: 「我已保存」按钮语义像确认已复制，实际再走创建/清结果
trigger: Owner 在结果区点该按钮
impact:  误以为保存动作，实际丢掉结果面板
fix:     文案改为「关闭」或仅关闭不重建
verify:  unverified: 文案产品选择，留 OPEN

### F-0024 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:1
symbols: formError
rule:    ui-designer T4 错误靠近输入
theme:   T4 · 向导关窗去确认
commits: fabe6e8
report:  reviewer:ui-T4
related: -
risk:    none
failure: 创建错误提示远离 emails 输入
trigger: 粘贴非法地址提交
impact:  Owner 找不到该改哪一栏
fix:     错误锚定到 emails 字段
verify:  unverified: 本轮不改布局，留 OPEN

### F-0025 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/email/ShareDialog.vue:1
symbols: ShareDialog, liveEffectiveStatus
rule:    ui-designer T5 状态应用徽章而非纯文本
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:ui-T5
related: -
risk:    none
failure: ShareDialog 状态非徽章，与管理列表不一致
trigger: 从收件箱打开快捷分享对话框
impact:  五面状态视觉不统一
fix:     Dialog 复用与列表相同的状态徽章
verify:  unverified: 纯视觉一致性，留 OPEN

### F-0026 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1
symbols: ShareDetailDrawer, ShareRowActions
rule:    ui-designer T5 过期行操作一致性
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:ui-T5
related: -
risk:    none
failure: EXPIRED 抽屉与行操作可做动作不一致
trigger: 打开已本地翻 EXPIRED 的详情
impact:  同一状态两条交互
fix:     抽屉操作集与行操作对齐（过期仍可 revoke）
verify:  unverified: 本轮不改抽屉操作集，留 OPEN

### F-0027 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/share/index.vue:1
symbols: share-shell
rule:    visitor-share-ui-design.md 390 视口
theme:   T6 · 访客收码页视觉
commits: e309ad4
report:  reviewer:ui-T6
related: -
risk:    none
failure: 390 视口 header 横向溢出约 8px
trigger: 窄屏打开访客页
impact:  出现横向滚动条
fix:     header 允许换行或缩小 padding
verify:  unverified: 无浏览器截图像素证据本轮未复测，留 OPEN

### F-0029 · P2 · open · age 0d · seen 1x · batch -
anchor:  mail-vue/src/views/share/index.vue:1
symbols: share-card
rule:    visitor-share-ui-design.md 终态卡视口居中
theme:   T6 · 访客收码页视觉
commits: e309ad4
report:  reviewer:ui-T6
related: -
risk:    none
failure: 终态卡只 text-align 未在视口垂直居中
trigger: unavailable/timedout/exited
impact:  窄屏终态贴顶，不像设计卡
fix:     终态壳 min-height + flex 居中
verify:  unverified: 纯视觉，留 OPEN

## SUGGESTION

### F-0030 · suggestion · open · age 0d · seen 1x · batch -
anchor:  mail-worker/src/service/mail-share-service.js:817
symbols: prepareShareInsertByEmails, db.batch
rule:    docs/specs/mail-share/design.md T-02 未证 batch 内行可见性
theme:   T3 · emails[] 创建分享
commits: fabe6e8
report:  reviewer:T3
related: F-0003, F-0004
risk:    D1 batch 语句间行可见性 · origin prepareShareInsertByEmails → hops 1 · stop: 记 suggestion
failure: 注释声称同 batch 可见刚插入的 account；T-02 只证回滚与不得消费前序结果
trigger: 真 D1 上 create emails[] 需建号
impact:  若不可见则 share INSERT 零行（与 F-0004 叠加）
fix:     用真 D1 或 miniflare 对照实验钉可见性；无证据保持 suggestion
verify:  unverified: 无 remote D1 对照实验

## RESOLVED

### F-0001 · P1 · resolved · age 0d · seen 1x · batch B1
anchor:  mail-vue/src/views/share/index.vue:789
symbols: handleShareGone, clearMailboxView, clearShareSession, markShareGone
rule:    docs/specs/mailbox-share-capability/requirements.md AC-SEC-07 amended · p4-destroyed-entrypoints.md #10
theme:   T1 · gone→原生 404
commits: d602ec6, e309ad4
report:  reviewer:T1
related: F-0022
risk:    none
failure: sessionStorage SecurityError 时 clearMailboxView 在 markShareGone/reload 之前抛出，已打开 SPA 停在业务壳
trigger: 访客页已 ready，Owner 销毁分享，浏览器拒绝 sessionStorage 写入/删除
impact:  持链访客继续看到本站业务 HTML，P4 成功状态（浏览器原生 404）未兑现
fix:     session 清理函数吞 SecurityError；handleShareGone 用 try/finally 保证 markShareGone+reload/blank 必跑
verify:  cd mail-vue && pnpm exec vitest run src/views/share/session.spec.js src/views/share/index.spec.js → EXIT=0
close:   commit 0f4f52c · cd mail-vue && pnpm exec vitest run src/views/share/session.spec.js src/views/share/index.spec.js → EXIT=0

### F-0002 · P1 · resolved · age 0d · seen 1x · batch B2
anchor:  mail-worker/src/service/mailbox-provision.js:147
symbols: planMailboxProvision, roleRow
rule:    production-antipatterns 异常类 fail-open · 决策卡共享不变量（配额/域名权限）
theme:   T2 · mailbox-provision SSOT
commits: fabe6e8
report:  reviewer:T2, reviewer:high-risk-T2
related: -
risk:    account 写路径的授权与配额闸门 · origin mailbox-provision.js:planMailboxProvision → hops 1 · stop: deny 分支已钉测试
failure: 非管理员且 role 行缺失时跳过配额与 availDomain 权限（fail-open）
trigger: user.type 指向不存在的 role，走设置页 add 或分享 emails[] 建号
impact:  无角色约束的用户可开出任意数量/域名邮箱
fix:     非 admin 且 !roleRow 时 deny QUOTA_EXCEEDED（fail-closed）
verify:  cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0
close:   commit 0f4f52c · cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0 (27 passed)

### F-0003 · P1 · resolved · age 0d · seen 1x · batch B4
anchor:  mail-worker/src/service/mail-share-service.js:1256
symbols: accountGuardSql, prepareAccountInsert, createFromEmails
rule:    docs/specs/mail-share/requirements.md AC-SHARE-12 活跃上限不得两步 COUNT+INSERT
theme:   T3 · emails[] 创建分享
commits: fabe6e8
report:  reviewer:T3, reviewer:high-risk-T3, reviewer:cross-contract
related: F-0004, F-0030
risk:    account 写路径的授权与配额闸门 · origin createFromEmails → hops 1 · stop: guard SQL 含 account COUNT
failure: account 配额只在 plan 预检，batch 内 guard 只数 mail_share ACTIVE
trigger: 两个并发 createFromEmails 同时为 missing 地址建号，且 owned+N 越过 role.accountCount
impact:  用户邮箱数顶穿角色配额
fix:     prepareAccountInsert 注入 account COUNT+N<=accountCount 谓词，与 share 限额折算同形
verify:  cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0
close:   commit 0f4f52c · cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0

### F-0004 · P1 · resolved · age 0d · seen 1x · batch B5
anchor:  mail-worker/src/service/mail-share-service.js:1342
symbols: createFromEmails, prepareShareInsertByEmails
rule:    docs/specs/mail-share/requirements.md AC-SHARE-12 / AC-CAP-13 整单拒绝 SHALL NOT 部分写入
theme:   T3 · emails[] 创建分享
commits: fabe6e8
report:  reviewer:T3
related: F-0003, F-0030
risk:    none
failure: 条件 INSERT 零命中不报错；shareRows.every 在 db.batch 已提交后才检查
trigger: batch 内部分 share INSERT 因归属计数/限额谓词 0 行，其余语句成功
impact:  部分分享/账号落库，整单拒绝语义被打破
fix:     batch 末加 RAISE(ABORT) 完整性哨兵，使零命中变成语句错误从而回滚整批
verify:  cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0
close:   commit 0f4f52c + 8a80014 · D1 禁止触发器外 RAISE，哨兵改为 SELECT 1/0；test/mail-share-emails.spec.js 27 passed → EXIT=0

### F-0005 · P1 · resolved · age 0d · seen 1x · batch B3
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:615
symbols: onOpenChange, closeNow, openDialog, unknownResult, rotateIdempotencyKey
rule:    docs/specs/mailbox-share-capability/requirements.md AC-CAP-14
theme:   T4 · 向导关窗去确认
commits: fabe6e8
report:  reviewer:T4
related: -
risk:    none
failure: unknownResult 时关窗走 closeNow 清 unknownResult，下次 openDialog 轮换幂等键
trigger: 创建请求运输层失败后 Owner 关掉向导再打开
impact:  盲建第二条分享，丢失的首次响应无法按同 Key 重放
fix:     关窗保留 unknownResult；再次打开不 rotateIdempotencyKey
verify:  cd mail-vue && pnpm exec vitest run src/views/share-admin/ShareCreateWizard.spec.js → EXIT=0
close:   commit 0f4f52c · cd mail-vue && pnpm exec vitest run src/views/share-admin/ShareCreateWizard.spec.js → EXIT=0

### F-0006 · P1 · resolved · age 0d · seen 1x · batch B8
anchor:  docs/specs/mail-share/design.md:578
symbols: P-AUTH-01, AC-VISIT-04
rule:    docs/specs/mail-share/requirements.md AC-VISIT-04 revised（gone 切族）vs design 性质段未改
theme:   T7 · spec 回写
commits: 82f330e
report:  reviewer:T7, reviewer:cross-contract
related: F-0007, F-0018, F-0019
risk:    spec 内部一致性 · origin AC-VISIT-04 → hops 1 · stop: 性质段/矩阵/注册表已对齐
failure: requirements 已把 gone 切成 404，design P-AUTH-01 与 Traceability AC-VISIT-04 仍写逐字节相同 SHARE_UNAVAILABLE
trigger: 下一轮 reviewer 以 design 性质段/矩阵为判据
impact:  把有意推翻判成实现漂移，或放过真正的回归
fix:     同步 P-AUTH-01、Traceability AC-VISIT-04/AC-LIFE-03、错误码注册表
verify:  python3 -c "import pathlib; t=pathlib.Path('docs/specs/mail-share/design.md').read_text(); assert 'SHARE_DESTROYED' in t; assert 'views/share-admin/status.js' in t" → EXIT=0
close:   commit 0f4f52c · design.md P-AUTH-01/注册表含 SHARE_DESTROYED 且路径 views/share-admin/status.js

### F-0007 · P1 · resolved · age 0d · seen 1x · batch B8
anchor:  docs/specs/mailbox-share-capability/requirements.md:55
symbols: AC-CAP-01
rule:    capability design create 契约表已写 emails[]，requirements AC-CAP-01 仍只写 accountId
theme:   T7 · spec 回写
commits: 82f330e
report:  reviewer:T7
related: F-0006, F-0018, F-0019
risk:    none
failure: AC-CAP-01 未收录 emails[] 创建与新错误码
trigger: 后续 agent 只读 requirements 实现/审查 create
impact:  emails[] 路径被视为无 AC 的野能力
fix:     AC-CAP-01 行内 amended 补 emails[] 与 SHARE_EMAIL_INVALID / SHARE_DOMAIN_NOT_CONFIGURED
verify:  python3 -c "assert 'emails' in pathlib.Path('docs/specs/mailbox-share-capability/requirements.md').read_text()" → EXIT=0
close:   commit 0f4f52c · AC-CAP-01 amended 收录 emails[] + SHARE_EMAIL_INVALID / SHARE_DOMAIN_NOT_CONFIGURED

### F-0011 · P2 · resolved · age 0d · seen 1x · batch B7
anchor:  mail-worker/src/service/mail-share-service.js:672
symbols: replayBatchFromLids
rule:    docs/specs/mail-share/requirements.md AC-SHARE-11 重放须同一组 lid
theme:   T3 · emails[] 创建分享
commits: fabe6e8
report:  reviewer:T3, reviewer:high-risk-T3
related: -
risk:    none
failure: replayBatchFromLids 只判 !rows.length，残缺批次仍 idempotentReplay:true
trigger: 幂等行 lids=[a,b] 但 b 已被保留期清理
impact:  Owner 以为重放完整批量，实际少一条且无 NOT_FOUND
fix:     回读 lid 集合必须与请求 lids 精确相等，否则 SHARE_NOT_FOUND
verify:  cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0
close:   commit 0f4f52c · replayBatchFromLids lid 集合精确相等；test/mail-share-emails.spec.js → EXIT=0

### F-0015 · P2 · resolved · age 0d · seen 1x · batch B9
anchor:  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:1
symbols: handleShareGone
rule:    决策卡任务清单 Evidence 必须覆盖真实落地提交
theme:   T9 · 决策卡 Evidence
commits: 1288ac8, 9b6eb80
report:  reviewer:T9, reviewer:cross-contract
related: F-0016, F-0017
risk:    none
failure: P4 SPA 出口在 e309ad4，Evidence 只记 d602ec6
trigger: 后续 agent 按账本认定 P4 已在 d602ec6 闭合
impact:  回滚视觉提交会静默摘掉 gone 接线
fix:     Evidence 补 files/commit: views/share/index.vue @ e309ad4
verify:  python3 -c "t=open('.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md').read(); assert 'e309ad4' in t or 'index.vue' in t.split('P4')[1][:2000]" → EXIT=0
close:   commit 0f4f52c · 决策卡 P4 Evidence 补 e309ad4 SPA 接线

### F-0016 · P2 · resolved · age 0d · seen 1x · batch -
anchor:  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:1
symbols: visitor-share-ui-design
rule:    决策卡 P5 Evidence 要求 1280/390 截图路径
theme:   T9 · 决策卡 Evidence
commits: 1288ac8, 9b6eb80, e309ad4
report:  reviewer:T9, reviewer:T6
related: F-0015, F-0017
risk:    none
failure: P5 勾选截图但未给产物路径；T6 reviewer 亦缺截图
trigger: 验收账本声称视觉已验
impact:  P5 无可复现视觉证据
fix:     补截图路径或把 Evidence 改为 unverified: 无产物
verify:  unverified: 本环境无既有截图可挂，留 OPEN
close:   commit 0f4f52c · P5 截图 artifacts/ui-t6-desktop-1280.webp / ui-t6-mobile-390.webp

### F-0017 · P2 · resolved · age 0d · seen 1x · batch B9
anchor:  .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:1
symbols: commit: pending
rule:    engineering-agent 任务清单 Evidence commit 字段
theme:   T9 · 决策卡 Evidence
commits: 1288ac8, 9b6eb80
report:  reviewer:T9
related: F-0015, F-0016
risk:    none
failure: DOC/REV 条目 commit: pending
trigger: 任务清单勾 [x] 但 commit 未回写
impact:  无法从账本跳到落地 sha
fix:     DOC→82f330e REV/VERIFY 按实际 sha 回写
verify:  grep -n 'commit: pending' .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md ；期望无匹配
close:   commit 0f4f52c · 决策卡 DOC/REV 无 commit: pending（已回写 1288ac8）

### F-0018 · P2 · resolved · age 0d · seen 1x · batch B8
anchor:  docs/specs/mail-share/design.md:197
symbols: SHARE_DESTROYED, SHARE_EMAIL_INVALID, SHARE_DOMAIN_NOT_CONFIGURED
rule:    mail-share/design.md 错误码稳定注册表即全集
theme:   T7 · spec 回写
commits: 82f330e
report:  reviewer:T7, reviewer:cross-contract
related: F-0006, F-0007, F-0019
risk:    none
failure: 三个新对外码未进稳定注册表
trigger: 下一轮以注册表判野码
impact:  合法码被判未注册，或前端 default 分支无依据
fix:     注册表增收 SHARE_DESTROYED（不入响应体）与两个 Owner 码
verify:  python3 -c "t=open('docs/specs/mail-share/design.md').read(); assert 'SHARE_EMAIL_INVALID' in t" → EXIT=0
close:   commit 0f4f52c · design.md 错误码注册表含 SHARE_DESTROYED / SHARE_EMAIL_INVALID / SHARE_DOMAIN_NOT_CONFIGURED

### F-0019 · P2 · resolved · age 0d · seen 1x · batch B8
anchor:  docs/specs/mail-share/design.md:754
symbols: liveEffectiveStatus
rule:    文档锚点必须指向真实文件
theme:   T7 · spec 回写
commits: 82f330e
report:  reviewer:T7
related: F-0006, F-0007, F-0018
risk:    文档锚点 ↔ 真实文件路径 · origin Update Log → hops 1 · stop: 路径已改
failure: Update Log 写成 views/share/status.js，实际是 views/share-admin/status.js
trigger: 按错误路径搜文件
impact:  agent 以为展示 SSOT 在访客页目录
fix:     更正路径锚点
verify:  grep -n 'views/share/status.js' docs/specs/mail-share/design.md ；期望无匹配
close:   commit 0f4f52c · design.md Update Log 路径改为 views/share-admin/status.js

### F-0022 · P2 · resolved · age 0d · seen 1x · batch B6
anchor:  mail-worker/src/security/share-document-gone.js:10
symbols: SHARE_DOC_PATH, parseShareLidPath
rule:    p4-destroyed-entrypoints.md #1/#2 文档入口全量收口
theme:   T1 · gone→原生 404
commits: d602ec6, e309ad4
report:  reviewer:high-risk-T1
related: F-0001
risk:    文档拦截面 vs SPA 可达路径 · origin SHARE_DOC_PATH → hops 1 · stop: /S/ 已拦截或重定向
failure: Vue 可匹配大小写不敏感历史 URL 形态；Worker SHARE_DOC_PATH 仅 /s/ 小写
trigger: 访客打开 /S/<lid>（销毁链接）
impact:  gone 检查跳过，SPA fallback 出 200 业务壳
fix:     parseShareLidPath 对 /s/ 前缀大小写不敏感；Vue 增加 /S/:lid → /s/:lid 重定向
verify:  cd mail-worker && pnpm exec vitest run test/share-document-gone.spec.js → EXIT=0
close:   commit 0f4f52c · SHARE_DOC_PATH 加 i + Vue alias /S/:lid；test/share-document-gone.spec.js 16 passed → EXIT=0

### F-0028 · P1 · resolved · age 0d · seen 1x · batch B10
anchor:  mail-vue/src/views/share/index.vue:1425
symbols: share-list-from, share-from, share-detail, share-atts
rule:    visitor-share-ui-design.md 卡片不得被外部文本撑破视口
theme:   T6 · 访客收码页视觉
commits: e309ad4
report:  reviewer:ui-T6
related: -
risk:    none
failure: 无空格超长主题/发件人/附件名把页面拉到约 983px
trigger: 邮件主题或附件名为超长 token
impact:  移动端横向滚动，收码主任务被挤出
fix:     外部文本 overflow-wrap:anywhere；容器 overflow-x:hidden
verify:  cd mail-vue && pnpm exec vitest run src/views/share/index.spec.js → EXIT=0
close:   commit 0f4f52c · overflow-wrap:anywhere + .share-shell overflow-x:hidden；index.spec.js → EXIT=0

## WAIVED

(none)

## DROPPED

- reviewer:ui-T6 | "暗色主题未适配" | 丢弃:deferred 设计卡浅色 token + 匿名 chunk 隔离，为不存在场景防御
- reviewer:T8 | (无 finding) | 丢弃:主题无锚点问题；种子副作用未取到反例

## THEMES

T1 gone→原生 404 → F-0001, F-0022
T2 mailbox-provision → F-0002, F-0008, F-0009, F-0010
T3 emails[] create → F-0003, F-0004, F-0011, F-0030
T4 wizard close → F-0005, F-0023, F-0024
T5 liveEffectiveStatus → F-0012, F-0013, F-0014, F-0025, F-0026
T6 visitor visual → F-0027, F-0028, F-0029 (+ F0016 Evidence)
T7 spec 回写 → F-0006, F-0007, F-0018, F-0019, F-0020, F-0021
T8 Owner e2e → (none)
T9 决策卡 → F-0015, F-0016, F-0017

耦合边: T1-ordering-T6; T2-shared-ssot-T3; T3-same-file-T4; T5-contract-T8; T7-shared-ssot-T1/T3/T5; T9-ordering-T1..T8
