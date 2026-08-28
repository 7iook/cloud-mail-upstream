# Report · 2026-08-28-r1

## RUN
run: 2026-08-28-r1 | range: 9b6eb80..083c87f (origin/main) | commits: 10 | themes: 9
findings: P0=0 P1=5 P2=23 suggestion=1 | new=13 | persist=11 | dropped=3 | overdue: 0
models: recon=claude-opus-5-thinking-high-fast · reviewer=gpt-5.6-sol-xhigh-fast · converge/fix=claude-opus-5-thinking-high-fast
form: B | skipped: cursor/git-8934 in-progress | complete: origin/main silent>=19h

## FIX-BATCHES

### B1 · D1 整单原子 + 配额谓词 · order 1 · depends_on: -
findings: F-0004, F-78412ce3, F-89dcf76e, F-570b7d4c
root: mail-worker/src/service/mail-share-service.js `createFromEmails` + mailbox-provision.js 谓词
why-together: 同一次 batch 装配；单独修 F-0004 会被错误配额谓词再次拆单
files: mail-share-service.js, mailbox-provision.js, mail-share-emails.spec.js

### B2 · 向导 unknownResult 跨重建与恢复态 · order 2 · depends_on: -
findings: F-420feb8d, F-e87370ba, F-92520298
root: ShareCreateWizard.vue unknownResult
why-together: 同状态机；持久化、NOT_FOUND 处理、首屏层级必须一起改
files: ShareCreateWizard.vue, ShareCreateWizard.spec.js

### B3 · 文档读配额 / 大小写头 / e2e 限流器 · order 3 · depends_on: -
findings: 见 OPEN-P2 T3/T8
root: SHARE_READ_RATE_LIMITER + _headers /s/*
why-together: 同一公开文档入口

### B4 · 访客页播报/横幅/OTP 溢出 · order 4 · depends_on: -
findings: 见 OPEN-P2 T4/T5
root: views/share/index.vue + ShareOtpCard.vue

### B5 · share chunk 去掉 Element Plus · order 5 · depends_on: -
root: components/safe-mail/index.vue

## OPEN-P0

(none)

## OPEN-P1

### F-0004 · P1 · persists · age 2d · seen 2x · batch B1
anchor:  mail-worker/src/service/mail-share-service.js:1360
symbols: createFromEmails, prepareShareInsertByEmails, prepareAccountInsert
rule:    docs/specs/mail-share/requirements.md AC-SHARE-12 / AC-CAP-13 整单拒绝 SHALL NOT 部分写入
theme:   T1 · 批量整单原子
commits: 0f4f52c, 790c550, 8a80014, fabe6e8
report:  reviewer:CROSS, reviewer:T1, reviewer:T3, reviewer:T9, reviewer:high-risk-T1
related: F-0003, F-0030, F-570b7d4c, F-78412ce3
risk:    d1-batch-partial-write · createFromEmails → hops 2 · stop: 零行不回滚已确认
failure: 条件 INSERT 零命中不报错；shareRows.every 在 db.batch 已提交后才检查
trigger: batch 内部分 share INSERT 因归属计数/限额谓词 0 行，其余语句成功
impact:  部分分享/账号落库，整单拒绝语义被打破
fix:     batch 末加 RAISE(ABORT) 完整性哨兵，使零命中变成语句错误从而回滚整批
verify:  cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0

### F-420feb8d · P1 · open · age 0d · seen 1x · batch B2
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:489
symbols: unknownResult, idempotencyKey, openDialog
rule:    docs/specs/mailbox-share-capability/requirements.md AC-CAP-14
theme:   T6 · 向导幂等
commits: 0f4f52c
report:  reviewer:T6
related: F-0005
risk:    wizard-idempotency-key-lifecycle · origin unknownResult → hops 1 · stop: 已枚举重建出口
failure: unknownResult 与 idempotencyKey 只活在组件实例；刷新/卸载后重新生成 key 并轮换
trigger: create 已达服务端但响应丢失后 Owner 刷新或离开分享管理再回来按原表单重建
impact:  新键绕过重放，盲建第二条活动分享
fix:     发出请求前持久化 pending create 上下文（key+body），重建后恢复；确定成功或可证未创建后才清除
verify:  cd mail-vue && pnpm exec vitest run src/views/share-admin/ShareCreateWizard.spec.js → EXIT=0

### F-570b7d4c · P1 · open · age 0d · seen 1x · batch B1
anchor:  mail-worker/src/service/mail-share-service.js:1273
symbols: createFromEmails, accountGuardSql, planShareMailboxes
rule:    docs/specs/mailbox-share-capability/requirements.md AC-CAP-01 配额与写入同批
theme:   T2 · 建号配额谓词
commits: 0f4f52c
report:  reviewer:T2
related: F-0004, F-78412ce3, F-89dcf76e
risk:    none
failure: accountGuardSql/binds 在 retry 环外按第一次 plan.missing.length 构造；UNIQUE 后只换 plan 不重建 guard
trigger: account UNIQUE 撞车后重试，missing 集合从 3 缩成 2
impact:  重试用过时更低阈值，后续 account INSERT 静默零行并与 F-0004 叠加
fix:     每次 attempt 按当前 plan 重建配额 guard
verify:  cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0

### F-78412ce3 · P1 · open · age 0d · seen 1x · batch B1
anchor:  mail-worker/src/service/mailbox-provision.js:242
symbols: accountQuotaPredicateBinds, accountQuotaPredicateSql, prepareAccountInsert
rule:    docs/specs/mailbox-share-capability/requirements.md AC-CAP-01 · mailbox-provision.js 预检 owned+missing<=accountCount
theme:   T2 · 建号配额谓词
commits: 0f4f52c
report:  reviewer:T2, reviewer:high-risk-T2
related: F-0004, F-570b7d4c, F-89dcf76e
risk:    account-quota-predicate-equivalence · origin accountQuotaPredicateBinds → hops 1 · stop: 已找到第二条分歧
failure: 同一 accountCount-(missingCount-1) 阈值复用于每条 account INSERT；整单刚好填满配额时第二条零行
trigger: 非管理员 emails[] 一次提交至少两个 missing 地址且恰好填满 role.accountCount 余量
impact:  合法请求失败且前部 account/share/binding 已提交，Owner 拿不到凭证
fix:     整组缺失地址的配额条件只按批前状态求值一次（set-based INSERT 或共享批前 COUNT）
verify:  cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0；补 owned=1 missing=2 accountCount=3 全成功用例

### F-89dcf76e · P1 · open · age 0d · seen 1x · batch B1
anchor:  mail-worker/src/service/mailbox-provision.js:189
symbols: provisionMailbox, prepareAccountInsert
rule:    决策卡 DC-P0-2 建号不变量唯一居所 · mailbox-provision 预检+写入须同批
theme:   T2 · 建号配额谓词
commits: 0f4f52c
report:  reviewer:T2
related: F-0004, F-570b7d4c, F-78412ce3
risk:    none
failure: 设置页 provisionMailbox 只预检后无条件 INSERT，新增原子配额谓词未进入第二个共享写入口
trigger: 两次 /account/add 各自在 owned=limit-1 时通过预检后并发写入
impact:  用户邮箱数顶穿 role.accountCount
fix:     provisionMailbox 走与 createFromEmails 同一套 accountQuotaPredicate
verify:  cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0；补设置页并发占满配额用例

## OPEN-P2

### F-0008 · P2 · persists · age 2d · seen 2x · batch -
anchor:  mail-worker/src/service/mailbox-provision.js:52
symbols: configuredDomains
rule:    决策卡 configuredDomains 精确匹配、禁子串 · 全仓 env.domain 口径
theme:   T2 · mailbox-provision SSOT
commits: 0f4f52c, fabe6e8
report:  reviewer:T2, reviewer:high-risk-T2
related: 
risk:    none
failure: 其他入口仍可能对 c.env.domain 做 includes 子串匹配
trigger: dashboard 把 domain 配成 JSON 字符串后走未改道入口
impact:  子串误命中或大小写拒绝集与分享入口不一致
fix:     全仓 env.domain 读点改走 configuredDomains；本轮只扫未改调用点，不在本轮扫全仓改道
verify:  unverified: 本轮不改其余入口，留 OPEN

### F-0009 · P2 · persists · age 2d · seen 2x · batch -
anchor:  mail-worker/src/service/mailbox-provision.js:102
symbols: emailPrefixFilter
rule:    改前 account-service.add 前缀匹配大小写敏感
theme:   T2 · mailbox-provision SSOT
commits: 0f4f52c, fabe6e8
report:  reviewer:T2
related: 
risk:    none
failure: 前缀黑名单改为大小写不敏感，设置页拒绝集收严且无 AC
trigger: 前缀含被禁 token 的大小写变体
impact:  原先能注册的地址被拒
fix:     若有意统一则在设置页/分享测试钉不敏感语义；否则恢复敏感匹配
verify:  unverified: 行为差异已确认，产品意图未裁，留 OPEN

### F-0010 · P2 · persists · age 2d · seen 2x · batch -
anchor:  mail-worker/src/service/mailbox-provision.js:6
symbols: userService, roleService
rule:    mailbox-provision.js 模块头禁反向 import account-service/mail-share-service
theme:   T2 · mailbox-provision SSOT
commits: 0f4f52c, fabe6e8
report:  reviewer:T2
related: 
risk:    none
failure: mailbox-provision → user-service → account-service 间接环风险
trigger: 冷启动循环依赖导致未定义导出
impact:  建号路径运行时崩
fix:     切断 user-service 对 account-service 的边或改为延迟加载；本轮不改无关模块
verify:  unverified: 环未在本轮跑冷启动复现，留 OPEN

### F-0012 · P2 · open · age 2d · seen 1x · batch -
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

### F-0013 · P2 · open · age 2d · seen 1x · batch -
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

### F-0014 · P2 · open · age 2d · seen 1x · batch -
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

### F-0020 · P2 · persists · age 2d · seen 2x · batch -
anchor:  docs/specs/mail-share/design.md:6
symbols: status, shipped_commit
rule:    charter front-matter 与正文 Update Log 生命周期一致
theme:   T7 · spec 回写
commits: 0f4f52c, 82f330e
report:  reviewer:T7
related: 
risk:    none
failure: front-matter 仍 converged / shipped_commit null，正文已记 shipped 后整改
trigger: 工具按 front-matter 过滤 shipped spec
impact:  本轮修订对自动化不可见
fix:     同步 last_updated / shipped_commit 或标明 post-ship patch
verify:  unverified: 改 front-matter 影响 charter 生命周期工具，本轮不擅自改 status，留 OPEN

### F-0021 · P2 · persists · age 2d · seen 2x · batch -
anchor:  docs/architecture/ADR-mailbox-share-capability-extension.md:26
symbols: P-AUTH-01, Visitor failure partition
rule:    mail-share/design.md Decision 8 ADR 门槛（边界定义型且难以反转）
theme:   T7 · spec 回写
commits: 0f4f52c, 82f330e
report:  reviewer:T7
related: 
risk:    none
failure: P4 推翻三轮安全性质未 amend Accepted ADR
trigger: 只读 ADR 的后续设计
impact:  ADR 与 shipped 行为长期分叉
fix:     另开 ADR amend 轮；本轮不改 Accepted ADR 正文
verify:  unverified: ADR 修订需独立决策，留 OPEN

### F-0023 · P2 · persists · age 2d · seen 2x · batch -
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:98
symbols: acknowledgeSecret
rule:    ui-designer T4 信息层级
theme:   T4 · 向导关窗去确认
commits: 0f4f52c, fabe6e8
report:  reviewer:T6, reviewer:ui-T4, reviewer:ui-T6
related: 
risk:    none
failure: 「我已保存」按钮语义像确认已复制，实际再走创建/清结果
trigger: Owner 在结果区点该按钮
impact:  误以为保存动作，实际丢掉结果面板
fix:     文案改为「关闭」或仅关闭不重建
verify:  unverified: 文案产品选择，留 OPEN

### F-0024 · P2 · persists · age 2d · seen 2x · batch -
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:349
symbols: formError
rule:    ui-designer T4 错误靠近输入
theme:   T4 · 向导关窗去确认
commits: 0f4f52c, fabe6e8
report:  reviewer:T6, reviewer:ui-T4, reviewer:ui-T6
related: 
risk:    none
failure: 创建错误提示远离 emails 输入
trigger: 粘贴非法地址提交
impact:  Owner 找不到该改哪一栏
fix:     错误锚定到 emails 字段
verify:  unverified: 本轮不改布局，留 OPEN

### F-0025 · P2 · open · age 2d · seen 1x · batch -
anchor:  mail-vue/src/views/email/ShareDialog.vue:1
symbols: ShareDialog, liveEffectiveStatus
rule:    ui-designer T5 状态应用徽章而非纯文本
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:ui-T5
related: 
risk:    none
failure: ShareDialog 状态非徽章，与管理列表不一致
trigger: 从收件箱打开快捷分享对话框
impact:  五面状态视觉不统一
fix:     Dialog 复用与列表相同的状态徽章
verify:  unverified: 纯视觉一致性，留 OPEN

### F-0026 · P2 · open · age 2d · seen 1x · batch -
anchor:  mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1
symbols: ShareDetailDrawer, ShareRowActions
rule:    ui-designer T5 过期行操作一致性
theme:   T5 · liveEffectiveStatus
commits: b365810
report:  reviewer:ui-T5
related: 
risk:    none
failure: EXPIRED 抽屉与行操作可做动作不一致
trigger: 打开已本地翻 EXPIRED 的详情
impact:  同一状态两条交互
fix:     抽屉操作集与行操作对齐（过期仍可 revoke）
verify:  unverified: 本轮不改抽屉操作集，留 OPEN

### F-0027 · P2 · persists · age 2d · seen 2x · batch -
anchor:  mail-vue/src/views/share/index.vue:1220
symbols: .share-top
rule:    visitor-share-ui-design.md 390 视口
theme:   T6 · 访客收码页视觉
commits: 083c87f, 0f4f52c, e309ad4
report:  reviewer:T4, reviewer:T5, reviewer:ui-T4, reviewer:ui-T5, reviewer:ui-T6
related: 
risk:    none
failure: 390 视口 header 横向溢出约 8px
trigger: 窄屏打开访客页
impact:  出现横向滚动条
fix:     header 允许换行或缩小 padding
verify:  unverified: 无浏览器截图像素证据本轮未复测，留 OPEN

### F-0029 · P2 · persists · age 2d · seen 2x · batch -
anchor:  mail-vue/src/views/share/index.vue:1207
symbols: .share-card
rule:    visitor-share-ui-design.md 终态卡视口居中
theme:   T6 · 访客收码页视觉
commits: 083c87f, 0f4f52c, e309ad4
report:  reviewer:T4, reviewer:T5, reviewer:ui-T4, reviewer:ui-T5, reviewer:ui-T6
related: 
risk:    none
failure: 终态卡只 text-align 未在视口垂直居中
trigger: unavailable/timedout/exited
impact:  窄屏终态贴顶，不像设计卡
fix:     终态壳 min-height + flex 居中
verify:  unverified: 纯视觉，留 OPEN

### F-0f510dbd · P2 · open · age 0d · seen 1x · batch B3
anchor:  mail-vue/src/router/index.js:70
symbols: alias, SHARE_DOC_PATH
rule:    p4-destroyed-entrypoints.md #1/#2 · mail-vue/public/_headers /s/*
theme:   T3 · gone 文档入口
commits: 0f4f52c, 1da171f
report:  reviewer:T3
related: 
risk:    case-insensitive-share-path · origin SHARE_DOC_PATH → hops 1 · stop: 已枚举 /s/ 判定点
failure: Vue alias 保留地址栏 /S/；_headers 只声明 /s/*，活文档大写路径缺 no-store/no-referrer/noindex/CSP
trigger: 访客打开仍有效的 /S/<lid>
impact:  与小写路径缓存/泄露策略不一致，lid 可进 Referer
fix:     _headers 覆盖大小写分享路径，或把 /S/ 规范重定向到 /s/
verify:  python3 -c "t=open('mail-vue/public/_headers').read(); assert '/S/' in t or '/s/' in t.lower()" → EXIT=0

### F-1e2784c9 · P2 · open · age 0d · seen 1x · batch B5
anchor:  mail-vue/src/components/safe-mail/index.vue:5
symbols: SafeMailRenderer, ElButton, ElAlert
rule:    visitor-share-ui-design.md:45 · 决策卡:266 不引入 Element Plus 到 share chunk
theme:   T5 · 页内播报
commits: 083c87f
report:  reviewer:T5
related: 
risk:    element-plus-in-share-chunk · origin SafeMailRenderer → hops 2 · stop: 产物层已含 EP
failure: 删掉三处 ElMessage 后 share 路由仍经 SafeMailRenderer 拉取 el-button/el-alert
trigger: 访客加载 /s/:lid 异步路由
impact:  硬约束声称的去依赖未完成
fix:     为匿名 share 拆出无 UI 框架的邮件渲染外壳，并把 Element Plus 特征加入 assert-share-chunk FORBIDDEN
verify:  pnpm -C mail-vue build 后 share chunk 闭包无 el-* → EXIT=0

### F-3e800473 · P2 · open · age 0d · seen 1x · batch B4
anchor:  mail-vue/src/views/share/index.vue:1183
symbols: data-share-code-from, ShareOtpCard
rule:    visitor-share-ui-design.md 卡片不得被外部文本撑破视口
theme:   T4 · SPA 退场与溢出
commits: 0f4f52c
report:  reviewer:ui-T4
related: F-0028
risk:    none
failure: overflow-wrap 未覆盖 OTP 卡内无 class 的发件人行，超长 token 被 shell 裁切
trigger: 无空格超长发件人 + 390 视口
impact:  访客看不全验证码对应的来源身份
fix:     OTP 发件人行 overflow-wrap:anywhere
verify:  cd mail-vue && pnpm exec vitest run src/views/share/ShareOtpCard.spec.js → EXIT=0

### F-618c6bfa · P2 · open · age 0d · seen 1x · batch B4
anchor:  mail-vue/src/views/share/index.vue:130
symbols: newMailNotice, copyAllAttempt, copyAttempt, role=status
rule:    W3C WCAG 2.2 Technique ARIA22 · visitor-share-ui-design.md 可访问提示
theme:   T5 · 页内播报
commits: 083c87f
report:  reviewer:T5
related: 
risk:    none
failure: 三处 v-if 与 role=status 同节点挂载；首次前无 live region，重复靠换 key 重建
trigger: 读屏访客首次/再次复制或收到新邮件
impact:  可能听不到复制成功与新邮件到达
fix:     预先挂载空的稳定 role=status 容器，只更新内容
verify:  cd mail-vue && pnpm exec vitest run src/views/share/index.spec.js src/views/share/ShareOtpCard.spec.js → EXIT=0

### F-6d14486f · P2 · open · age 0d · seen 1x · batch B3
anchor:  mail-worker/src/security/share-document-gone.js:69
symbols: enforceShareRateLimitOnRequest, SHARE_READ_RATE_LIMITER
rule:    docs/specs/mail-share/design.md P-TRANS-01 · AC-ABUSE-08
theme:   T3 · gone 文档入口
commits: 1da171f
report:  reviewer:T3, reviewer:high-risk-T3, reviewer:CROSS, reviewer:ui-T3
related: 
risk:    share-read-quota-contention · origin share-document-gone.js → hops 2 · stop: 最坏请求数已算出
failure: 文档 GET 与四个访客读 API 共用 100/60s 桶；桶耗尽后刷新得到空 body 429，SPA 未加载无法退避
trigger: 多 Binding 访客页轮询+刷新，或 gone reload 撞上已耗尽的读桶
impact:  可恢复的运输层限制被体验成链接失效
fix:     文档入口与 API 分桶，或文档 429 提供可恢复形态且配额覆盖合法轮询
verify:  cd mail-worker && pnpm exec vitest run test/share-document-gone.spec.js test/share-rate-limit.spec.js → EXIT=0

### F-92520298 · P2 · open · age 0d · seen 1x · batch B2
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:344
symbols: unknownResult, wizard-unknown
rule:    docs/specs/mailbox-share-capability/requirements.md AC-CAP-14 用户可见恢复流程
theme:   T6 · 向导幂等
commits: 0f4f52c
report:  reviewer:ui-T6
related: 
risk:    none
failure: unknown 告警在整张冻结表单之后；重开滚回顶部，首屏只见置灰新建表单
trigger: 运输失败后关窗再开，390 视口
impact:  Owner 看不到「可能已建好、用同一把钥匙重试」
fix:     unknown 态把恢复说明与重试按钮放到首屏/标题区
verify:  cd mail-vue && pnpm exec vitest run src/views/share-admin/ShareCreateWizard.spec.js → EXIT=0

### F-bbdc807b · P2 · open · age 0d · seen 1x · batch B3
anchor:  tests/e2e/wrangler-e2e.toml:17
symbols: SHARE_READ_RATE_LIMITER, [[ratelimits]]
rule:    mail-worker/wrangler.toml SHARE_READ_RATE_LIMITER · shareLimiterAllows 缺绑定 fail-open
theme:   T8 · merge 回归
commits: 1da171f
report:  reviewer:T8
related: 
risk:    none
failure: e2e 未绑定 SHARE_READ_RATE_LIMITER，gone 404 用例只覆盖 fail-open
trigger: 跑 visitor-unavailable / visitor-revoke-live
impact:  生产文档 429 分支无 e2e 回归
fix:     e2e wrangler 绑定与生产同名读限流器，并覆盖放行时 gone 仍 404
verify:  grep -n SHARE_READ_RATE_LIMITER tests/e2e/wrangler-e2e.toml → 期望有匹配

### F-e87370ba · P2 · open · age 0d · seen 1x · batch B2
anchor:  mail-vue/src/views/share-admin/ShareCreateWizard.vue:754
symbols: isBusinessError, unknownResult, SHARE_NOT_FOUND
rule:    docs/specs/mailbox-share-capability/requirements.md AC-CAP-14
theme:   T6 · 向导幂等
commits: 0f4f52c
report:  reviewer:T6
related: F-0004
risk:    wizard-idempotency-key-lifecycle · origin submit catch → hops 1 · stop: 错误映射已确认
failure: 同键恢复收到 SHARE_NOT_FOUND 被当成确定失败，清 unknownResult 并解锁表单
trigger: 运输层失败后同 key 重试，服务端因 lid 集合不全返回 SHARE_NOT_FOUND
impact:  Owner 按通用失败提示新建，可能再为残留邮箱建分享
fix:     从 unknownResult 恢复时收到 SHARE_NOT_FOUND 不得转入可安全新建态
verify:  cd mail-vue && pnpm exec vitest run src/views/share-admin/ShareCreateWizard.spec.js → EXIT=0

### F-f22137e9 · P2 · open · age 0d · seen 1x · batch B4
anchor:  mail-vue/src/views/share/index.vue:640
symbols: selectTab, announceNewMail, clearNewMailNotice
rule:    index.vue:143-149 消息必须归属当前 Binding
theme:   T5 · 页内播报
commits: 083c87f
report:  reviewer:T5
related: 
risk:    none
failure: selectTab 不调用 clearNewMailNotice，旧 Tab 横幅挂到新 Tab
trigger: Binding A 到件后 6 秒内切到 Binding B
impact:  访客在错误邮箱里找新邮件
fix:     setActiveBinding 在 Binding 变化时清提示与计时器
verify:  cd mail-vue && pnpm exec vitest run src/views/share/index.spec.js → EXIT=0

## SUGGESTION

### F-0030 · suggestion · persists · age 2d · seen 2x · batch -
anchor:  mail-worker/src/service/mail-share-service.js:817
symbols: prepareShareInsertByEmails, db.batch
rule:    docs/specs/mail-share/design.md T-02 未证 batch 内行可见性
theme:   T3 · emails[] 创建分享
commits: 790c550, fabe6e8
report:  reviewer:T1, reviewer:T3
related: F-0003, F-0004
risk:    none
failure: 注释声称同 batch 可见刚插入的 account；T-02 只证回滚与不得消费前序结果
trigger: 真 D1 上 create emails[] 需建号
impact:  若不可见则 share INSERT 零行（与 F-0004 叠加）
fix:     用真 D1 或 miniflare 对照实验钉可见性；无证据保持 suggestion
verify:  unverified: 无 remote D1 对照实验

## RESOLVED

(none this review phase; fix batches pending)

## WAIVED

(none)

## DROPPED

- reviewer:high-risk-T2 | T2-F2 两次 role 读取间角色消失导致 QUOTA_EXCEEDED/500 | 丢弃:deferred: 同请求内 role 被删的竞态无产品场景；稳态缺 role 已由 F-0002 resolved 覆盖
- reviewer:T9 | T9-F1 台账 F-0004 关闭失效 | 丢弃:不是独立产品缺陷；并入 persists F-0004 的台账处置
- reviewer:T5 | T5-F1 原报 P1 | 丢弃:severity 降为 P2：影响辅助技术播报，不是数据完整性/配额穿透；仍作为新 P2 入库

## THEMES

T1 → F-0004 persists
T2 → F-78412ce3, F-89dcf76e, F-570b7d4c + F-0008/0009/0010 persists
T3 → 文档配额 P2 + /S/ headers P2
T4 → F-0027/0029 persists + OTP from overflow P2
T5 → live-region P2 + EP chunk P2 + tab banner P2 + F-0027/0029
T6 → remount P1 + NOT_FOUND P2 + first-screen P2 + F-0023/0024
T7 → F-0020/0021 persists
T8 → e2e limiter P2
T9 → 并入 F-0004 台账 reopen
CROSS → F-0004 + 文档配额（已去重）
耦合边: T1--ordering-->T2 · T1--contract-change-->T6 · T3--contract-change-->T5 · T5--shared-ssot-->T3
