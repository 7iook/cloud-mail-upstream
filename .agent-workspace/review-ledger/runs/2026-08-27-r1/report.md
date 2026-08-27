# Review Report · 2026-08-27-r1

## RUN

```
run: 2026-08-27-r1 | mode: cursor | range: multi-ref-empty | commits: 0 | themes: 0
form: B | recon: not-dispatched | reviewer: not-dispatched | converge: claude-opus-5-thinking-high-fast
findings: P0=0 P1=0 P2=14 suggestion=1 | carryover: 15 | overdue: 0 | new: 0
skipped: origin/cursor/git-5c8a in-progress; origin/cursor/git-e148 in-progress
ledger_source: origin/cursor/git-e148 (2026-08-26-r1) + 5c8a extra ref cursors for merged leftovers
```

## FIX-BATCHES

(无批次 · 空轮无新提交 · 跳过修复段)

## OPEN-P0

(无)

## OPEN-P1

(无)

## OPEN-P2

### F-0008 · P2 · open · age 1d · seen 1x
anchor:  mail-worker/src/service/mailbox-provision.js:52
symbols: configuredDomains
rule:    决策卡 configuredDomains 精确匹配、禁子串 · 全仓 env.domain 口径
identity:c.env.domain parse SSOT vs leftover includes
theme:   T2 · mailbox-provision SSOT
commits: fabe6e8
report:  reviewer:T2, reviewer:high-risk-T2
related: -
failure: 其他入口仍可能对 c.env.domain 做 includes 子串匹配
trigger: dashboard 把 domain 配成 JSON 字符串后走未改道入口
impact:  子串误命中或大小写拒绝集与分享入口不一致
fix:     全仓 env.domain 读点改走 configuredDomains；本轮只扫未改调用点，不在本轮扫全仓改道
verify:  unverified: 本轮不改其余入口，留 OPEN

### F-0009 · P2 · open · age 1d · seen 1x
anchor:  mail-worker/src/service/mailbox-provision.js:102
symbols: emailPrefixFilter
rule:    改前 account-service.add 前缀匹配大小写敏感
identity:emailPrefixFilter case folding change on settings add
theme:   T2 · mailbox-provision SSOT
commits: fabe6e8
report:  reviewer:T2
related: -
failure: 前缀黑名单改为大小写不敏感，设置页拒绝集收严且无 AC
trigger: 前缀含被禁 token 的大小写变体
impact:  原先能注册的地址被拒
fix:     若有意统一则在设置页/分享测试钉不敏感语义；否则恢复敏感匹配
verify:  unverified: 行为差异已确认，产品意图未裁，留 OPEN

### F-0010 · P2 · open · age 1d · seen 1x
anchor:  mail-worker/src/service/mailbox-provision.js:5
symbols: userService, roleService
rule:    mailbox-provision.js 模块头禁反向 import account-service/mail-share-service
identity:mailbox-provision import graph cycle via user-service
theme:   T2 · mailbox-provision SSOT
commits: fabe6e8
report:  reviewer:T2
related: -
failure: mailbox-provision → user-service → account-service 间接环风险
trigger: 冷启动循环依赖导致未定义导出
impact:  建号路径运行时崩
fix:     切断 user-service 对 account-service 的边或改为延迟加载；本轮不改无关模块
verify:  unverified: 环未在本轮跑冷启动复现，留 OPEN

### F-0012 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/share-admin/index.vue:1
symbols: liveEffectiveStatus, fetchList
rule:    docs/specs/mail-share/requirements.md AC-LIFE-08 amended
identity:share-admin list filter vs liveEffectiveStatus
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:T5, reviewer:ui-T5
related: F-0013, F-0014
failure: 列表 status=ACTIVE 服务端筛选 vs 本地翻 EXPIRED 卡片同屏
trigger: 筛 ACTIVE 后停留跨过 expiresAt
impact:  筛选结果与卡片状态不一致，Owner 误判仍有效
fix:     本地翻 EXPIRED 后从 ACTIVE 筛选视图移除或提示需 refetch
verify:  unverified: 本轮不改列表筛选交互，留 OPEN

### F-0013 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/share-admin/use-share-clock.js:1
symbols: useShareClock, ShareRowActions
rule:    决策卡接线表未授权 N 份 1s interval
identity:useShareClock instance fan-out on list rows
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:T5
related: F-0012, F-0014
failure: 每行 ShareRowActions 各自 useShareClock → N 个 setInterval + 监听
trigger: 分享管理列表 20+ 行
impact:  定时器与 focus 回源请求放大
fix:     时钟提升到页面级，行组件注入 nowMs
verify:  unverified: 本轮不改时钟拓扑（侵入面大于本轮 FIX 预算），留 OPEN

### F-0014 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/email/ShareIndicator.vue:1
symbols: ShareIndicator, onDeactivated
rule:    keep-alive 下监听必须对称摘除
identity:ShareIndicator keep-alive listener leak
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:T5, reviewer:ui-T5
related: F-0012, F-0013
failure: ShareIndicator 自建 visibility/focus 监听只在 onUnmounted 摘，keep-alive deactivate 残留
trigger: 收件箱 keep-alive 反复进出
impact:  监听累加，一次 focus 多次 refresh
fix:     onDeactivated 对称 removeEventListener
verify:  unverified: 本轮不改 Indicator 钩子，留 OPEN

### F-0020 · P2 · open · age 1d · seen 1x
anchor:  docs/specs/mail-share/design.md:6
symbols: status, shipped_commit
rule:    charter front-matter 与正文 Update Log 生命周期一致
identity:mail-share design front-matter vs shipped changelog
theme:   T7 · spec 回写
commits: 82f330e
report:  reviewer:T7
related: -
failure: front-matter 仍 converged / shipped_commit null，正文已记 shipped 后整改
trigger: 工具按 front-matter 过滤 shipped spec
impact:  本轮修订对自动化不可见
fix:     同步 last_updated / shipped_commit 或标明 post-ship patch
verify:  unverified: 改 front-matter 影响 charter 生命周期工具，本轮不擅自改 status，留 OPEN

### F-0021 · P2 · open · age 1d · seen 1x
anchor:  docs/architecture/ADR-mail-share-capability-boundary.md:1
symbols: P-AUTH-01
rule:    mail-share/design.md Decision 8 ADR 门槛（边界定义型且难以反转）
identity:P4 gone split vs Accepted ADR P-AUTH-01
theme:   T7 · spec 回写
commits: 82f330e
report:  reviewer:T7
related: -
failure: P4 推翻三轮安全性质未 amend Accepted ADR
trigger: 只读 ADR 的后续设计
impact:  ADR 与 shipped 行为长期分叉
fix:     另开 ADR amend 轮；本轮不改 Accepted ADR 正文
verify:  unverified: ADR 修订需独立决策，留 OPEN

### F-0023 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:1
symbols: acknowledgeSecret
rule:    ui-designer T4 信息层级
identity:wizard result acknowledge button copy vs action
theme:   T4 · 向导关窗去确认
commits: fabe6e8
report:  reviewer:ui-T4
related: -
failure: 「我已保存」按钮语义像确认已复制，实际再走创建/清结果
trigger: Owner 在结果区点该按钮
impact:  误以为保存动作，实际丢掉结果面板
fix:     文案改为「关闭」或仅关闭不重建
verify:  unverified: 文案产品选择，留 OPEN

### F-0024 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:1
symbols: formError
rule:    ui-designer T4 错误靠近输入
identity:wizard emails field error proximity
theme:   T4 · 向导关窗去确认
commits: fabe6e8
report:  reviewer:ui-T4
related: -
failure: 创建错误提示远离 emails 输入
trigger: 粘贴非法地址提交
impact:  Owner 找不到该改哪一栏
fix:     错误锚定到 emails 字段
verify:  unverified: 本轮不改布局，留 OPEN

### F-0025 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/email/ShareDialog.vue:1
symbols: ShareDialog, liveEffectiveStatus
rule:    ui-designer T5 状态应用徽章而非纯文本
identity:ShareDialog status presentation vs list badge
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:ui-T5
related: -
failure: ShareDialog 状态非徽章，与管理列表不一致
trigger: 从收件箱打开快捷分享对话框
impact:  五面状态视觉不统一
fix:     Dialog 复用与列表相同的状态徽章
verify:  unverified: 纯视觉一致性，留 OPEN

### F-0026 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1
symbols: ShareDetailDrawer, ShareRowActions
rule:    ui-designer T5 过期行操作一致性
identity:EXPIRED row vs drawer action parity
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:ui-T5
related: -
failure: EXPIRED 抽屉与行操作可做动作不一致
trigger: 打开已本地翻 EXPIRED 的详情
impact:  同一状态两条交互
fix:     抽屉操作集与行操作对齐（过期仍可 revoke）
verify:  unverified: 本轮不改抽屉操作集，留 OPEN

### F-0027 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/share/index.vue:1
symbols: share-shell
rule:    visitor-share-ui-design.md 390 视口
identity:share visitor header overflow at 390px
theme:   T6 · 访客收码页视觉
commits: e309ad4
report:  reviewer:ui-T6
related: -
failure: 390 视口 header 横向溢出约 8px
trigger: 窄屏打开访客页
impact:  出现横向滚动条
fix:     header 允许换行或缩小 padding
verify:  unverified: 无浏览器截图像素证据本轮未复测，留 OPEN

### F-0029 · P2 · open · age 1d · seen 1x
anchor:  mail-vue/src/views/share/index.vue:1
symbols: share-card
rule:    visitor-share-ui-design.md 终态卡视口居中
identity:share visitor terminal card viewport centering
theme:   T6 · 访客收码页视觉
commits: e309ad4
report:  reviewer:ui-T6
related: -
failure: 终态卡只 text-align 未在视口垂直居中
trigger: unavailable/timedout/exited
impact:  窄屏终态贴顶，不像设计卡
fix:     终态壳 min-height + flex 居中
verify:  unverified: 纯视觉，留 OPEN

## SUGGESTION

### F-0030 · suggestion · open · age 1d · seen 1x
anchor:  mail-worker/src/service/mail-share-service.js:817
symbols: prepareShareInsertByEmails, db.batch
rule:    docs/specs/mail-share/design.md T-02 未证 batch 内行可见性
identity:D1 batch intra-statement row visibility for new accounts
theme:   T3 · emails[] 创建分享
commits: fabe6e8
report:  reviewer:T3
related: F-0003, F-0004
failure: 注释声称同 batch 可见刚插入的 account；T-02 只证回滚与不得消费前序结果
trigger: 真 D1 上 create emails[] 需建号
impact:  若不可见则 share INSERT 零行（与 F-0004 叠加）
fix:     用真 D1 或 miniflare 对照实验钉可见性；无证据保持 suggestion
verify:  unverified: 无 remote D1 对照实验

## RESOLVED

(无 · 本轮未关闭条目)

## WAIVED

(无)

## DROPPED

(无 · 未派 SUB)

## THEMES

(空轮无新主题)

### aging 榜 (open/persists)

P0 (0) · 逾期阈值 3d
P1 (0) · 逾期阈值 14d
P2 (14) · 逾期阈值 60d · 全部 age 1d · 无逾期
  F-0008     1d  mail-worker/src/service/mailbox-provision.js:52
  F-0009     1d  mail-worker/src/service/mailbox-provision.js:102
  F-0010     1d  mail-worker/src/service/mailbox-provision.js:5
  F-0012     1d  mail-vue/src/views/share-admin/index.vue:1
  F-0013     1d  mail-vue/src/views/share-admin/use-share-clock.js:1
  F-0014     1d  mail-vue/src/views/email/ShareIndicator.vue:1
  F-0020     1d  docs/specs/mail-share/design.md:6
  F-0021     1d  docs/architecture/ADR-mail-share-capability-boundary.md:1
  F-0023     1d  mail-vue/src/views/share-admin/ShareCreateWizard.vue:1
  F-0024     1d  mail-vue/src/views/share-admin/ShareCreateWizard.vue:1
  F-0025     1d  mail-vue/src/views/email/ShareDialog.vue:1
  F-0026     1d  mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1
  F-0027     1d  mail-vue/src/views/share/index.vue:1
  F-0029     1d  mail-vue/src/views/share/index.vue:1
suggestion (1) · 不计逾期
  F-0030     1d  mail-worker/src/service/mail-share-service.js:817

open 留下原因: 上一轮 2026-08-26-r1 已审 share-link-fullchain；P2/suggestion 未进 FIX-BATCHES 必修批次，本轮无新完成单元，不扩修。
