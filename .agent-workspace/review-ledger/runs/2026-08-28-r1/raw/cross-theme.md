# Cross-theme review · 2026-08-28-r1

- lens：仅审 `themes.md` 文末 11 条具名耦合边；未重审单主题内部，未重复 mechanical gates
- 结论：`NEEDS_CHANGES`（P1 × 1，P2 × 1）

## Finding 1

- theme: `CROSS · T1×T2`
- persists: `F-0004`
- severity: `P1`
- anchor: `mail-worker/src/service/mail-share-service.js:1331`
- symbols: `createFromEmails`, `accountGuardSql`, `prepareAccountInsert`, `prepareShareInsertByEmails`, `shareRows`
- rule_source: `docs/specs/mailbox-share-capability/design.md:300` 规定 `emails[]` 任一地址不过则整单拒绝，并规定 V2=false 时同一请求分流为 N 条单分享；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:414-415` 把建号不变量收归 `mailbox-provision.js`，并要求多步写入在同一 D1 batch 中保持原子。
- identity_scope: V2=false 批量创建中，T2 的 account 配额谓词拒绝与 T1 的 N 条单分享整单提交边界。
- failure_mode: T2 把并发配额复核实现为 account `INSERT ... SELECT ... WHERE` 的零行结果；T1 却在 `mail-share-service.js:1331-1334` 假定 account 竞态只会触发 `UNIQUE` 错误并回滚。对于同时包含“已归属复用地址”和“待建新地址”的 V2=false 请求，配额在预检后被另一请求占满时，新地址的 account/share/binding 全部零行，但复用地址对应的 share、binding 与主 Binding 同步已经成功；零行不是 batch 错误，`db.batch()` 正常提交，直到 `shareRows.every(...)` 的批后检查才发现失败。带幂等键时，若第一条复用地址已落库，幂等行也会落库，随后精确 lid 集合重放转成 `SHARE_NOT_FOUND`，同样不会撤销已提交的分享。
- trigger: 非管理员只剩一个 account 名额；请求 A 预检通过，载荷依次含一个本人现有地址和一个新地址；请求 B 在 A 的预检与 batch 之间占满最后名额；A 在默认 V2=false 下执行 batch。
- impact: A 向 Owner 返回失败（有幂等键时可为 `SHARE_NOT_FOUND`，无键时为账号侧拒绝），数据库却留下第一枚地址的活动分享；该分享的 `sec`/URL 没有交付给 Owner，形成未知活动授权，并违反整单拒绝、零部分写入契约。
- required_fix: 在 `mailbox-provision` 的建号 SSOT 层提供可被批量 consumer 原子消费的配额写契约，使配额拒绝要么以 D1 支持的真实语句错误终止整个 batch，要么令同一 create 的全部 account/share/binding/幂等写入共同依赖一个不可部分提交的判定；不得在 batch 已提交后靠删除已落库分享补偿。
- verify: 增加真实 D1 集成用例：角色 account 上限为 2，Owner 已有地址 A；`batchProbe.beforeBatch` 为同一 Owner 插入竞争地址 C 占满名额；随后以 V2=false 创建 `[A, B]`。期望请求拒绝，且 A/B 对应新增 `mail_share`、`mail_share_binding`、`share_idempotency` 均为 0。当前 `mail-worker/test/mail-share-emails.spec.js:303-319` 只覆盖“执行前已经满额”的单新地址，`:436-474` 只覆盖会抛 `UNIQUE` 的抢注，不覆盖“配额谓词零行 + 复用组成功”的交错。
- risk_spread: `d1-batch-partial-write` · origin `mail-worker/src/service/mail-share-service.js:createFromEmails` → hop 1 `prepareAccountInsert` / `accountQuotaPredicateSql` → hop 2 `prepareShareInsertByEmails` / `prepareBindingInsertByEmails`；surfaces 仅 `mail-worker/src/service/` 与 `mail-worker/test/mail-share-emails.spec.js`；已在确认“配额零行不回滚复用组”后停止。

## Finding 2

- theme: `CROSS · T3×T5`
- severity: `P2`
- anchor: `mail-worker/src/security/share-document-gone.js:69`
- symbols: `shareDocumentIfGone`, `enforceShareRateLimitOnRequest`, `SHARE_READ_RATE_LIMITER`, `pollTick`, `useSharePolling`
- rule_source: `docs/specs/mail-share/design.md:584-588` 的 P-TRANS-01 要求任何 429 都是可恢复运输层错误，客户端须读取 `Retry-After` 后退避，不得当成永久失效；同文件 `:451-452` 把前台 3 秒轮询和 429 退避列为验收契约。
- identity_scope: `/s/:lid` 顶层文档导航与已加载 Visitor SPA 四个读 API 对同一 IP 读配额的共享消费及 429 恢复责任。
- failure_mode: 文档入口在 assets 之前消费 `SHARE_READ_RATE_LIMITER`，并在拒绝时直接返回空 body 429；同一 binding 也保护 `/share/mails`、`/share/mailboxes/status`、`/share/mail`、`/share/attachment`。SPA 的 `ShareRateLimitedError` 与退避逻辑只有页面已加载后才能运行；一旦 API 流量先耗尽共享桶，下一次浏览器刷新或 gone 退场 reload 在文档层被截断，SPA 根本不会加载，因而不存在能执行 P-TRANS-01 退避的客户端。
- trigger: 单个合法 50-Binding 分享在一个 60 秒窗口内可产生：文档打开 1 次 + 初始 catch-up 最多 40 页 + 20 个 3 秒 poll tick × 每 tick 2 个请求 + 其余 49 个 Tab 首次读取，共 130 次，超过 `wrangler.toml:20` 的 100/60s；随后刷新页面。共享 NAT 下多个正常访客会更早触发同一路径。
- impact: 活链接被展示为空白 429 文档，页面内“请稍候/按 Retry-After 重试”的恢复状态不可达；对 Visitor 而言它与终态页面同样没有业务 DOM，只能自行猜测何时再次导航，违反“429 可恢复且由客户端退避”的契约。
- required_fix: 在文档入口这一最早责任层定义可消费的限流恢复协议：文档探测配额不得与 SPA API 轮询共用同一 namespace，并且顶层 429 必须由无需既有 SPA 的最小恢复文档或等价浏览器层机制读取 `Retry-After` 后重试；不能把修复放进当前不会被加载的 Visitor SPA。
- verify: 新增文档导航集成/E2E：先用同一 `CF-Connecting-IP` 消耗 API 读配额，再导航到一条活的 `/s/:lid`；断言 API 配额不会截断文档入口，或顶层 429 会按 `Retry-After` 自动恢复并最终加载该活分享，而不是停在空 body。静态计数已实算为 `1 + 40 + 20×2 + 49 = 130 > 100`。
- risk_spread: `share-read-quota-contention` · origin `share-document-gone.js` 的新增配额消费 → hop 1 `share-rate-limit.js` / `share-api.js` 共用 `SHARE_READ_RATE_LIMITER` → hop 2 `useSharePolling` 的 3000ms 调度及 L2 具名 T5 页面 consumer `index.vue:pollTick`；已得到单 Visitor 上界 130 vs 100 后停止，未展开 session/reveal limiter。

## 逐边核验

1. `T1 --ordering--> T2`：Finding 1。T2 的配额零行不是 T1 注释所声称的 `UNIQUE` 错误，混合复用/新建批次会部分提交。
2. `T1 --same-file--> T2`：Finding 1 已覆盖当前 statements 装配的跨契约失配，不重复报。另查到 `accountQuotaPredicateBinds()` 在 `missingCount > 1` 时把同一阈值施加给每条顺序 account INSERT，第一条成功后后续条目即零行；这属于 T2 自身谓词等价性，转 T2 主题 reviewer。
3. `T1 --contract-change--> T6`：服务端精确 lid 集合返回 `SHARE_NOT_FOUND`、向导把它降成普通创建失败的风险落在 T6 状态机消费层；转 T6 主题 reviewer（当前 `raw/t6-wizard-idempotency.md` T6-F2），本 Lens 不重复。
4. `T1 --shared-ssot--> T9`：F-0004 失效关闭与 `P1=0` 快照是 T9 台账生命周期问题；转 T9 主题 reviewer（当前 `raw/t9-ledger.md` T9-F1）。Finding 1 仅保留原运行时 identity 的 `persists: F-0004`，不复制台账 finding。
5. `T2 --contract-change--> T7`：无独立 finding。`docs/specs/mailbox-share-capability/design.md:300` 已给出 provision SSOT、任一地址不过则整单拒绝、V2=false 批量分流，决策卡 `:414-415` 已给出 batch 原子结果；因此不是“下一轮完全无判据”。当前违反这些结果契约的是 Finding 1 的实现组合。admin 与 `accountCount<=0` 豁免是否应改属于 T2 单主题产品语义，不在 cross 重审。
6. `T3 --contract-change--> T5`：Finding 2。文档层空 body 429 发生时，唯一会处理 `ShareRateLimitedError` 的 SPA 尚未加载。
7. `T5 --shared-ssot--> T3`：Finding 2。同一读桶的单 Visitor 具名最坏请求数为 130，超过 100/60s。
8. `T4 --ordering--> T3`：限流截断 reload 的部分并入 Finding 2，不另报。`SHARE_DOC_PATH` 已用 `/i` 覆盖 `/S/`，router alias 与匿名初始化也大小写一致；`markShareGone` 写失败直接 blank、生产不 reload 的问题只落在 T4 自身退场策略，转 T4 主题 reviewer。
9. `T4 --same-file--> T5`：本边无 finding。`exitShare`、`resetMailbox`、`onUnmounted` 均清理新邮件计时器（`mail-vue/src/views/share/index.vue:982-1007,1147-1149`）；gone 出口同步进入 reload/blank，没有可跨 lid 继续显示横幅的页面。
10. `T7 --shared-ssot--> T3`：无额外“响应形状未登记” finding。P-TRANS-01（`docs/specs/mail-share/design.md:584-588`）只约束状态、`Retry-After` 与退避，并未承诺 JSON body；真正缺口是顶层文档没有可执行退避的 consumer，已由 Finding 2 覆盖。
11. `T8 --ordering--> T1 / T2 / T3 / T4`：本边无 finding。实跑 `git diff --exit-code 9b6eb807 864358d -- . ':(exclude).agent-workspace/review-ledger/**' ':(exclude).gitignore'` 退出 0；两端差异仅 review-ledger 文件与 `.gitignore`，未发现 merge 夹带业务手改。

## 验证说明

本轮按 read-only 约束只做静态契约取证，未运行可能写缓存的项目测试。已实际执行 merge 保真 diff（退出 0）及共享配额上界计算，后者输出 `total: 130, limit: 100`。
