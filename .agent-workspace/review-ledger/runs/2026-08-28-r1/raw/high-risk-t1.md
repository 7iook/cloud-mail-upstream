# T1 · high-risk 独立审查

## 1. verdict

`NEEDS_CHANGES`：1 条 P1 数据完整性 finding。D1 `batch()` 中零行条件 INSERT 是成功语句，不触发回滚；当前批后 `meta.changes` 检查只能发现部分提交，不能撤销。带同一 `Idempotency-Key` 时，错误码取决于首个 lid 是否幸存：首 lid 幸存则稳定落 `SHARE_NOT_FOUND`，首 lid 未落库而后缀分享幸存则落 `SHARE_LIMIT_EXCEEDED`。

## 2. findings

### persists: F-0004 · 批后完整性检查无法兑现整单提交/回滚

- severity: P1
- anchor: `mail-worker/src/service/mail-share-service.js:1360`
- symbols: `createFromEmails`, `prepareShareInsertByEmails`, `prepareBindingInsertByEmails`, `prepareAccountInsert`, `prepareIdempotencyInsert`, `replayOrConflict`, `replayBatchFromLids`
- rule_source: `docs/specs/mail-share/requirements.md:69` 的 AC-SHARE-12 要求超限拒绝且不得留下部分写入；`docs/specs/mailbox-share-capability/requirements.md:55,57,68` 的 AC-CAP-01/03/14 要求 `emails[]` 创建对应分享、整单拒绝不留部分 Binding、响应丢失后同键恢复而非盲建；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:101-106` 的 DC-P0-3 要求 account/share/binding 同批，share 失败时 account 一并回滚。Cloudflare D1 官方 `batch()` 契约又明确：语句顺序执行；只有语句失败才中止并回滚整批；成功结果允许 `success=true, meta.changes=0`。
- identity_scope: `D1 batch zero-row INSERT vs all-or-nothing create`
- failure_mode: `createFromEmails` 把多条 account/share/binding/sync/idempotency 语句送入一次 `db.batch()`，却直到该 Promise 已成功返回后才在 `:1360-1363` 检查各 share 的 `meta.changes`。条件 INSERT 零行不是 SQL 失败，因此其它成功语句已经提交，随后 `:1364-1373` 的重放消歧或 `throw BizError` 没有事务句柄可回滚。当前代码有两条确定的部分命中链：(1) 活跃分享限额的每条 share 阈值在 `:1316` 随 index 变宽；N=2、limit=5、batch 起点已有 4 条时，第一条判断 `4 < 4` 为零行，第二条判断 `4 < 5` 成功，后缀 share/binding 留库；(2) account 配额把同一个 `accountCount-(missingCount-1)` 阈值复用于每条 account INSERT，`owned=1, missing=2, accountCount=3` 时变化数为 `[1,0]`，继而第一条 share/binding 成功、第二条零行，首 lid 对应的幂等行也成功写入。
- trigger: V2=false 下 Owner 一次创建至少两条单邮箱分享；预检与 batch 之间的并发提交使活跃分享余量不足整批，或普通非管理员提交两个待建地址且恰好填满 account 配额。
- impact: 请求返回失败，但库中残留本批的一部分 account、ACTIVE share、Binding 和/或幂等行；Owner 没收到该部分分享的本次完整创建结果，却已消耗账号/活跃分享配额。首 lid 幸存时，幂等行记录完整 lid 清单，`replayBatchFromLids` 因集合不全抛 `SHARE_NOT_FOUND`，同键重试无法恢复或重新执行。
- required_fix: 在最早的批次装配责任层把判定改为请求级、批内稳定的全有或全无条件：account 配额与活跃分享配额均须排除本批自身候选，或改为 set-based 写入，使所有预期写入共同依赖同一个不会被本批前序语句改变的判定；最终结果只能是全批写入、全批零写入，或真实 SQL 错误触发 D1 回滚。不得继续用 batch 返回后的 `meta.changes` 当回滚机制，也不得复用已证无效的触发器外 `RAISE()` 或 `1/0` 哨兵。
- verify: 增加真实 D1/Miniflare 集成用例：(1) `owned=1, missing=2, accountCount=3` 应两条全成功；再注入并发占位后应稳定拒绝且本批 account/share/binding/idempotency 全为 0；(2) N=2、limit=2，预检后并发占一席，断言目标批零 share/Binding 残留；(3) 两种场景都携带同一 `Idempotency-Key` 重试，断言不得因部分 lid 集合落 `SHARE_NOT_FOUND`。修复后保存各表前后计数与每条 D1Result 的 `success/meta.changes`。
- risk_spread: `d1-batch-partial-write`：`createFromEmails` → `prepareShareInsertByEmails` / `prepareBindingInsertByEmails` / `prepareAccountInsert` → `mailbox-provision.js:235-243`，已用 Miniflare 定点复现零行前后的成功写入留库，命中 stop_when；`idempotent-replay-vs-partial-batch`：`replayOrConflict` → `replayFromIdempotency` → `replayBatchFromLids`，已确认首 lid 幸存时首请求及同键重试均为 `SHARE_NOT_FOUND`，首 lid 未落库时为 `SHARE_LIMIT_EXCEEDED`，命中 stop_when。

## 3. D1 batch 零行后的提交事实

- Cloudflare D1 官方文档：`batch()` 顺序、非并发执行，整批仅在某条语句 **fails** 时 abort/rollback；官方成功返回示例明确包含 `success: true` 与 `meta.changes: 0` 的组合。零行是“成功但未改行”，不是 rollback 信号。
- 仓内 `mail-worker/test/transaction.spec.js:62-79,184-202` 证明真实语句错误会回滚前序 INSERT；`:98-103` 证明条件写零命中返回 `success=true / changes=0`。
- 隔离 Miniflare 复现直接调用当前 `mailShareService.create`：account 配额链在零行前留下 1 account，并在零行后留下 1 share、1 Binding、1 idempotency；活跃限额链在第一条 share 零行后仍提交第二条 share 与 Binding。故答案是：零行前后的其它成功语句都会留库。

## 4. `meta.changes` 的事务边界

`db.batch(statements)` 在 `mail-share-service.js:1337` resolve 时事务已经结束。`:1360-1363` 读取的是已提交结果的诊断元数据；`:1364-1373` 只能选择返回值或错误码。此处没有可调用的 rollback，也没有可恢复的交互式事务；批后抛异常不会逆转数据库提交。只有 batch 内语句本身抛错，才会进入 `:1338` 的 catch 并由 D1 回滚整批。

## 5. 同一 Idempotency-Key 的确定错误码

| 部分提交形状 | 幂等行 | 首次调用批后路径 | 同键重试 |
|---|---|---|---|
| 首 lid/share 成功，后续 lid 缺失（account 配额 `[1,0]`） | `prepareIdempotencyInsert` 以首 lid 命中，写入包含全部 lids 的记录 | `replayBatchFromLids` 在 `:675-677` 发现集合不全，`SHARE_NOT_FOUND` | 请求开头 `:1197-1201` 读同一记录，再次 `SHARE_NOT_FOUND` |
| 首 lid 未落库，后缀 share 成功（活跃限额 `[0,1]`） | 以首 lid 的 `INSERT ... SELECT` 零行，无幂等记录 | 重放为空，最终 `SHARE_LIMIT_EXCEEDED` | 残留后缀 share 已占满限额，预检返回 `SHARE_LIMIT_EXCEEDED` |

因此“同键重放落哪个码”不是单一答案，而由哪一条部分幸存决定；最危险的首 lid 幸存链会把当前首次请求本身就翻成 `SHARE_NOT_FOUND`，随后同键永久卡在同一码。

## 6. verification

- `pnpm exec vitest run test/transaction.spec.js test/mail-share-emails.spec.js`：退出码 0，`2 files / 37 tests` 全绿。现有 `mail-share-emails.spec.js:376-389` 只覆盖“完整成功后手工删掉一条再重放”，未制造 batch 内零行；`:303-319` 只覆盖 batch 前已满额的单地址。
- 隔离复现 `/tmp/lens-t1-repro-20260828/test/partial-batch-replay.spec.js`：`2 tests` 全绿。用例一断言首次与同键重试均为 `SHARE_NOT_FOUND`，并断言残留 account=1（不含原有 owner account）、share=1、Binding=1、idempotency=1；用例二断言第一条 share 零行后仍残留后缀 share=1、Binding=1，错误码为 `SHARE_LIMIT_EXCEEDED`。
- 复现副本与当前仓库的 `mail-share-service.js`、`mailbox-provision.js` SHA-256 分别完全相同；未修改业务文件。
- SQLite 同形谓词探针输出：`active_limit_changes=[0,1]` 且后缀行持久化；`account_quota_changes=[1,0]` 且首 account 持久化。

## 7. stop_when

- `d1-batch-partial-write`：已确定零行 INSERT 不失败，且同批零行之前与之后的成功语句均留库；达到 stop_when。
- `idempotent-replay-vs-partial-batch`：已确定首 lid 幸存 → `SHARE_NOT_FOUND`，首 lid 未落库而后缀幸存 → `SHARE_LIMIT_EXCEEDED`；达到 stop_when。
- 审查到此停止；未扩到单条 `insertShareAndIdempotency`、`share_idempotency` 表结构/TTL、其它写入口或安全攻防面。
