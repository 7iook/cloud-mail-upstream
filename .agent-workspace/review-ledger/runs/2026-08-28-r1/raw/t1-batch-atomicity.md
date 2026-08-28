# T1 · 批量建分享的整单原子性

结论：NEEDS_CHANGES（P1 × 1）

## persists: F-0004 · 批后 `meta.changes` 只能发现部分提交，不能撤销它

- severity: P1
- anchor: `mail-worker/src/service/mail-share-service.js:1360`
- symbols: `createFromEmails`, `prepareShareInsertByEmails`, `prepareBindingInsertByEmails`, `prepareAccountInsert`, `prepareIdempotencyInsert`, `replayOrConflict`, `replayBatchFromLids`
- rule_source: `docs/specs/mail-share/requirements.md:69` 的 AC-SHARE-12 要求超限拒绝且不得留下部分写入；`docs/specs/mailbox-share-capability/requirements.md:57,68` 的 AC-CAP-03/14 分别要求整单拒绝不留部分 Binding、响应丢失后同键恢复而非盲建；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:101-106` 的 DC-P0-3 要求 account/share/binding 同批且 share 失败时 account 一并回滚。
- identity_scope: D1 batch zero-row INSERT vs all-or-nothing create
- failure_mode: `createFromEmails` 把 N 条 share 作为互相独立的条件 INSERT 放进 `db.batch()`，直到 batch 已返回后才在第 1360-1363 行检查 `shareRows.every(row.meta.changes)`。零行 INSERT 在 D1 中是成功语句，所以此时同批成功的 share、Binding、主 Binding 同步和幂等行已经提交，后续抛业务错误无法回滚。活跃分享限额本身就能制造这种部分命中：第 i 条绑定 `limit - (N - 1 - i)`；若预检后并发请求占掉部分余量，以 N=2、limit=5、batch 开始时已有 4 条为例，第一条检查 `4 < 4` 失败且不增加计数，第二条随即检查 `4 < 5` 成功。故 `790c550` 所写“share INSERT 零行只可能来自归属谓词”与当前 SQL 不符。另一路是有限 account 配额下，多条 `prepareAccountInsert` 复用同一个 `accountCount - (missingCount - 1)` 阈值：前一条成功增加 COUNT 后，后一条可零行，同样把后续 share 拆成部分成功。
- trigger: Owner 在 V2=false 下批量创建两条或更多单邮箱分享；活跃分享预检与 `db.batch()` 之间有另一个创建提交、只剩不足 N 个名额，或有限角色 account 配额恰好只允许整批全部进入而多条 account INSERT 顺序消费同一固定阈值。
- impact: 请求对 Owner 返回失败，但库中保留一部分 ACTIVE share/Binding（以及相应 account/幂等副作用），消耗活跃配额并产生 Owner 未拿到本次完整结果的授权。若首个 lid 已落库且 `prepareIdempotencyInsert` 也成功，批后 `replayOrConflict` 会读取记录中的完整 lid 清单，而 `replayBatchFromLids` 在 `mail-share-service.js:675-677` 因集合不全直接抛 `SHARE_NOT_FOUND`；同键重试继续得到 NOT_FOUND，AC-CAP-14 的恢复路径被截断。
- required_fix: 在 `createFromEmails` 的批次装配责任层恢复真正的整单原子强制点：先修正 share/account 条件谓词，使整个请求共享同一个“全批可进入”判定（不能让失败后的后续位次获得更宽阈值），并用真实 D1 已证明会失败的约束错误或等价原子写法，让任一预期 account/share 零命中在同一 batch 内触发回滚。不得继续依赖 batch 返回后的 `meta.changes` 做完整性保证；`RAISE()` 与 `1/0` 两种已证无效方案也不得复用。
- verify: 在 `mail-worker/test/mail-share-emails.spec.js` 增加真实 D1/Miniflare 集成用例：(1) N=2、limit=5，预检后注入并发占位使 batch 起点为 4，断言请求失败后本批新增 share/Binding/account/幂等行均为 0；(2) Owner 已有 1 个 account、role.accountCount=3、批量创建 2 个 missing 地址，断言两条全部成功，不能一条成功一条零行；(3) 带同一 Idempotency-Key 重试部分命中注入场景，断言不得落到 `SHARE_NOT_FOUND` 且库中零残留。修复后在真实 D1 复跑并保存逐表计数证据。审查时实跑 `pnpm exec vitest run test/mail-share-emails.spec.js` 为 27/27 通过，但该文件没有 `SHARE_LIMIT_EXCEEDED`、`shareIndexes` 或批后零残留断言，故现有绿灯未覆盖本触发链。
- risk_spread: `d1-batch-partial-write`：`createFromEmails` → `prepareShareInsertByEmails` / `prepareBindingInsertByEmails` / `prepareAccountInsert` → `mailbox-provision.js:235-243`，已确定零行不报错且批后检查无法撤销同批成功语句，达到 stop_when；`idempotent-replay-vs-partial-batch`：`replayOrConflict` → `replayFromIdempotency` → `replayBatchFromLids`，已确定部分提交且幂等行存在时落 `SHARE_NOT_FOUND`，达到 stop_when。未扩散到单条 `insertShareAndIdempotency` 或幂等保留期。

## 其余查证

- `prepareShareInsertByEmails` 的活跃限额谓词位于 `mail-worker/src/service/mail-share-service.js:853-861`，每条不同的限额绑定装配于 `:1288-1317`；上面的反例直接来自这两处当前代码，不依赖已删除哨兵。
- `prepareIdempotencyInsert` 在 `mail-worker/src/service/mail-share-service.js:1066-1082` 只以首个 lid 定位 share；部分批次中首个 lid 成功时会留下记录，随后精确 lid 集合检查在 `:675-677` 返回 `SHARE_NOT_FOUND`。
- 当前测试 `mail-worker/test/mail-share-emails.spec.js:205-228` 只钉正常批量全成功，`:243-260` 只钉 batch 前预校验零写入，`:376-389` 是成功后手工删一条再重放；没有制造 batch 内 share INSERT 零行并检查逐表零残留。
- `8a80014` 增加的 `vi` import 对应 `mail-vue/src/views/share/session.spec.js:186-195` 的 SecurityError spy；改前该测试会在执行到 `vi.spyOn` 时失败，现状 import 完整，本主题不形成 finding。
- `790c550` 的“真实 D1”结果只存在于 commit message；仓内 `docs/specs/mail-share/design.md:756-767` 的 T-02 Evidence 验证的是 `.transaction()`/`batch()` 基础能力，不含 `1/0` 哨兵命令、输出或逐表残留。该证据缺口已并入本 finding 的真实 D1 verify 要求，不另开同根 finding。
- 台账处置应为 reopen / `persists: F-0004`，不是终结该 finding 为 invalidated：失效的是 `0f4f52c + 8a80014` 的旧关闭判定。`.agent-workspace/review-ledger/ledger.jsonl:4` 的 `resolved` 与 `.agent-workspace/review-ledger/INDEX.md:10` 的 `P1=0` 均已不代表当前代码状态。
