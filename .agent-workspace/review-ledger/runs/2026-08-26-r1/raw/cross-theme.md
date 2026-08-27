# Cross-theme review · 2026-08-26-r1

## Finding 1

- theme: `CROSS · T1×T6`
- severity: P1
- anchor: `mail-vue/src/views/share/index.vue:837`
- symbols: `recoverFromUnavailable`, `handleShareGone`, `isShareGone`
- rule_source: `docs/specs/mailbox-share-capability/requirements.md:210` 要求已打开页面收到 gone 后清凭据并 reload 一次；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:187-196` 把该 SPA 出口列为 P4 必做链路与验收。
- identity_scope: 已打开 Visitor SPA 的 gone 终局出口及其可独立回滚边界
- failure_mode: T1 提交 `d602ec6` 只提供 `ShareGoneError`、轮询停表和 session primitives，真正把 gone 从业务 unavailable 分支抢先导向 reload/blank 的 `handleShareGone` 及其五条测试却落在主题/subject 均为视觉改版的 `e309ad4`；按视觉主题回滚会一并删除 P4 出口。
- trigger: 因视觉回退而单独 revert `e309ad4`，同时保留 `d602ec6` 的 Worker 404 与请求层 `ShareGoneError`。
- impact: 首次建会话 404 会被旧 `fromSession` 分支画成业务 unavailable 页；轮询期 404 虽会停表，但页面继续停在原业务壳和旧邮件上，直接违反“销毁态不得出现任何业务 HTML”。
- required_fix: 把 P4 的页面接线及其回归测试归入一个与 P5 视觉可独立部署、可独立回滚的 T1 变更单元，并让视觉回滚方案显式保留该单元；不能靠回滚后再补一个下游判断兜底。
- verify: `cd /tmp/review-share-fullchain && ! git show d602ec6690e9671487ecd735c7fa640d41496bde:mail-vue/src/views/share/index.vue | rg -q 'function handleShareGone' && git show e309ad4a17c46dcfff896b9d967b322cca4389a7:mail-vue/src/views/share/index.vue | rg -q 'function handleShareGone'`，期望退出码 `0`。
- risk_spread: `origin=mail-vue/src/composables/useSharePolling.js:isShareGone 终局；hops=1；surfaces=mail-vue/src/views/share/index.vue + index.spec.js；stop=已定位 handleShareGone 与整组 P4 页面测试均首次出现于 e309ad4`

## Finding 2

- theme: `CROSS · T2×T3`
- severity: P1
- anchor: `mail-worker/src/service/mail-share-service.js:1266`
- symbols: `planMailboxProvision`, `prepareAccountInsert`, `createFromEmails`, `accountGuardSql`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:96-100` 将 account 配额列为两个入口共享的建号不变量；`mail-worker/test/mail-share-emails.spec.js:303-319` 固定了角色 account 配额拒绝契约。
- identity_scope: account 建号 SSOT 的角色配额不变量及其事务性写入边界
- failure_mode: producer 只在 `planMailboxProvision` 中以 `owned + missing.length` 做事务外预读；T3 consumer 随后的 account INSERT 注入的 `accountGuardSql` 只统计 `mail_share` 活跃数，完全不复核 account 数，因此“配额”并未随 SSOT 进入原子写边界。
- trigger: 角色只剩一个 account 名额时，两个不同邮箱的并发 `emails[]` create 都在任一 batch 提交前完成 plan，随后各自 batch 串行插入。
- impact: 两个请求都可成功建号并建分享，使 `account.user_id` 的存活行数超过 `role.account_count`；顺序配额测试仍全绿，无法守住该并发交错。
- required_fix: 让 mailbox-provision 这个真源同时提供事务性配额写契约（条件建号/可使整批失败的原子配额闸门），并要求设置页与分享两个 consumer 都复用它；不能只在 `createFromEmails` 外围再做一次 SELECT。
- verify: `cd /tmp/review-share-fullchain && rg -n 'owned \+ missing.length|accountGuardSql|SELECT COUNT\(\*\) FROM mail_share' mail-worker/src/service/mailbox-provision.js mail-worker/src/service/mail-share-service.js`，期望退出码 `0`；输出应同时显示配额只在 plan 预检、INSERT guard 只读取 `mail_share`。
- risk_spread: `origin=mail-worker/src/service/mailbox-provision.js:planMailboxProvision；hops=1；surfaces=mail-worker/src/service/mail-share-service.js:createFromEmails/prepareAccountInsert；stop=已确认 batch 内 account INSERT 无 role.account_count/account 行数谓词`

## Finding 3

- theme: `CROSS · T7×T1`
- severity: P2
- anchor: `docs/specs/mail-share/design.md:580`
- symbols: `P-AUTH-01`, `AC-VISIT-04`, `AC-LIFE-03`, `AC-AUTH-02`
- rule_source: `docs/specs/mail-share/requirements.md:86` 与 `docs/specs/mailbox-share-capability/requirements.md:107,210` 已把 gone 定义为 HTTP 404 空 body，并保留其余 unavailable 族内不可区分。
- identity_scope: 两份 shipped spec 共同维护的 Visitor gone/unavailable 失败分族契约
- failure_mode: T7 只改了 AC 行与文末 Update Log，正式性质段、错误表和 Traceability 仍把“不存在/已销毁/撤销”列入 `SHARE_UNAVAILABLE`：旧 charter 见 `design.md:192,197,366,411,414,426,580`，扩展 charter 见 `design.md:429,514,561,619`。
- trigger: 第三方消费者、后续实现者或 reviewer 从 Error Handling、Correctness Properties 或 Traceability 读取现行契约，而不是先读到文件末尾的 dated changelog。
- impact: 同一份判据源会同时要求裸 404 和 JSON `SHARE_UNAVAILABLE`；按正式 property/table 实现或验收会把 T1 的 P4 行为判错并重新引入业务 HTML，且无法形成唯一的第三方消费契约。
- required_fix: 在两份 shipped design 中同步修订正式失败表、稳定码说明、P-AUTH 性质和全部相关 Traceability 行，使其统一表达 gone/unavailable 两族；保留旧文本时必须明确标为 superseded，且 `SHARE_DESTROYED` 继续只作为内部码，不伪装成对外响应码。
- verify: `cd /tmp/review-share-fullchain && rg -n "销毁.*SHARE_UNAVAILABLE|已销毁.*完全相同|撤销.*SHARE_UNAVAILABLE|lid.*不存在.*SHARE_UNAVAILABLE" docs/specs/mail-share/design.md docs/specs/mailbox-share-capability/design.md`，期望退出码 `0`；当前会列出多条仍未 supersede 的冲突条款。
- risk_spread: `origin=docs/specs/mail-share/requirements.md:AC-VISIT-04/AC-LIFE-03；hops=1；surfaces=docs/specs/mail-share/design.md + docs/specs/mailbox-share-capability/{requirements,design}.md；stop=已枚举两份 design 中与 gone 分族冲突的性质段、错误表和矩阵行`

## 逐边核验

1. `T1 --ordering--> T6`：Finding 1。
2. `T1 --same-file--> T6`：与 Finding 1 同根；`index.vue:837` 的逻辑接线和 `index.vue:1157` 的“gone 不经过这里”视觉假设在同一视觉提交中，没有另报重复 finding。
3. `T2 --shared-ssot--> T3`：Finding 2；`mailbox-provision.js:147-150` 的配额预检没有进入 `mail-share-service.js:1256-1271` 的写 guard。
4. `T2 --contract-change--> 设置页注册路径`：该边的域名大小写、前缀黑名单大小写与既有 add 拒绝集变化均落在 T2 内部；请主 AI 转交 T2 主题 reviewer，不在 cross 报告重复。
5. `T3 --shared-ssot--> T1`：无独立 finding。T3 两个 Owner 码已登记在 capability Error Handling（`docs/specs/mailbox-share-capability/design.md:434-436`）且前端有穷举消费（`mail-vue/src/views/share-admin/presets.js:154-171`）；`SHARE_DESTROYED` 在 `mail-vue/src/request/share.js:17-24` 仅为裸 404 的客户端内部分类。共享 spec 的 gone 漂移已合并为 Finding 3。
6. `T3 --same-file--> T4`：本边无 finding。每个批量成员都由同一铸造点产生并写入 `secCipher/kekKid`（`mail-worker/src/service/mail-share-service.js:1221-1236`），逐 share 的 `revealSec` 可回读（`:2159-2193`），结果面也逐条渲染（`mail-vue/src/views/share-admin/ShareCreateWizard.vue:35-56`）；关闭不会造成链接不可恢复。
7. `T5 --contract-change--> T8`：本边无 finding。E2E 先钉 `ACTIVE`，随后在不执行 reload/导航/focus 操作的区间等待 `EXPIRED`（`tests/e2e/specs/owner-share-lifecycle.spec.js:60-64`）；`data-status` 直接消费 `useShareClock`（`mail-vue/src/views/share-admin/index.vue:42-55,142`），因此该断言确实要求 tick 生效。
8. `T3/T4 --ordering--> T8`：本边无 finding。该用例分别断言两条链接、无 MessageBox、结果区关闭和两条列表行（`tests/e2e/specs/owner-share-lifecycle.spec.js:30-43`）；任一 producer 回滚令消费测试失败是预期契约，不构成跨主题语义错配。
9. `T7 --shared-ssot--> T1/T3/T5`：Finding 3。另有 `docs/specs/mail-share/design.md:754` 把 T5 文件写成不存在的 `views/share/status.js`，这是 T7 内部锚点问题，请主 AI 转交 T7 主题 reviewer。
10. `T9 --ordering--> T1..T8`：与 Finding 1 同根，不重复报。任务账本在 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:399-402` 把 P4 只记到 `d602ec6`，但 SPA 出口及测试实际在 `e309ad4`；该 Evidence 缺口强化了同一回滚风险。

## 运行验证限制

尝试执行 `pnpm -C mail-worker test -- mail-share-emails.spec.js` 与 `pnpm -C mail-vue test -- src/views/share/index.spec.js`，均因该只读 worktree 无 `node_modules`、`vitest: not found` 退出 `1`；未安装依赖。上述 verify 均为已实际执行且退出 `0` 的静态契约检查。
