# T-01 独立审查

- review scope: `e120a04..4f72418` 的 5 个用户指定文件，以及 `tasks.md` T-01、`design.md` Data Models/两条迁移 SQL
- reviewed branch: `cursor/mailbox-share-capability-dcb6`
- implementation commit: `4f724189abbae6b13d0af834c7c520b68734d814`
- verdict: `CHANGES_REQUIRED`
- p0_count: 2

实现行为本身与 T-01 成功态一致，18 个定向测试也全部通过；但任务台账 Evidence 格式和新增生产符号 wiring 两个强制门禁未通过。

### Strengths

- `mail-worker/src/init/init.js:33`：`v3_2DB` 已接到真实初始化链，不是仅测试可达。
- `mail-worker/src/init/init.js:93-123`：两条 SQL 与 `design.md:185-210` 一致；回填和撤销都依据 account 存在、`is_del=NORMAL`、`user_id` 归属事实，撤销没有把“无 Binding”当脏数据判据。
- `mail-worker/src/init/init.js:113-123`：只更新 `status`、`revoked_at`，未改 `access_count`；`WHERE status='ACTIVE'` 使重复运行保持原 `revoked_at`。
- `mail-worker/test/v3-2-db.spec.js:168-365`：覆盖合法旧行、三类脏行、重复运行、四种旧 Worker 晚写交错和 `access_count` 守恒。
- `mail-worker/src/entity/mail-share.js:21-31`、`mail-worker/src/entity/mail-share-binding.js:4-9`：Drizzle 映射与 Data Models 的 11 列和 Binding 表一致。

### Issues

#### Critical (Must Fix · blocks merge)

1. `docs/specs/mailbox-share-capability/tasks.md:34-48`  
   **What**：T-01/T-01.1/T-01.2/T-01.3 虽有 commit、verify、files、AC，但 verify 没有规定的 `→ EXIT=<code>`，files 也没有 `path:lines` 锚点。  
   **Why**：已勾选任务不满足 Task-Ledger Evidence Gate，无法从台账机械复核声明与具体实现行。  
   **How**：为每个 `[x]` Evidence 补齐实际命令和 `EXIT=0`（红测则记录实际非零码），并把 files 改成真实 `path:start-end` 锚点。

2. `mail-worker/src/entity/mail-share-binding.js:4`  
   **What**：新增公开符号 `mailShareBinding` 在该交付的生产源码中只有定义，没有生产消费者；唯一消费位于 schema 测试。  
   **Why**：迁移表虽真实落地，但 ORM 映射目前是未接线代码，测试 import 不能证明生产路径会使用该唯一模型。  
   **How**：将首个真实 Binding 生产读写路径与该实体同批交付，或把该导出延后到首个生产消费者所在任务；不要增加无意义 import 伪造接线。

#### Important (Should Fix · quality impact)

无。

#### Minor (Nice to Have)

无。

## 两条 SQL 谓词核对

- 回填：`JOIN account` 同时要求 `a.account_id = ms.account_id`、`a.is_del = isDel.NORMAL`、`a.user_id = ms.user_id`；`NOT EXISTS` 只负责按 share 保证幂等，不参与“账户是否合法”的判断。结论：匹配 design。
- 撤销：`status='ACTIVE' AND NOT EXISTS(valid account facts)`，有效 account 子查询包含相同三项事实；没有查询 `mail_share_binding`。结论：匹配 design，合法零 Binding 晚写不会被撤销。
- 负面约束：限定生产 diff 中没有新增 `share_type`、`DROP`、`RENAME`、`mail_share_auth_fail` 或 `SHARE_CAPABILITY_V2=true`；`access_count` 未出现在迁移写集合中。

## 7-Phase Check

1. **Spec Conformance — PASS**：成功态、负面约束、实体/DDL 和两条指定 SQL 均匹配。
2. **Task-Ledger Evidence Gate — FAIL**：见 Critical #1；`4f72418` 本身可解析。
3. **Code Quality — PASS（有剩余风险）**：迁移职责集中在 `v3_2DB`，没有平行实现或硬编码秘密。
4. **Domain-Model Consistency — not applicable**：用户限定的权威范围没有 `docs/domain/*-model.md`；已在 Phase 1 对照 `design.md` Data Models。
5. **Upstream Root Cause — PASS**：脏数据在迁移门禁按 account 事实处理，没有下游 null 特判。
6. **Whole-Path Completeness — FAIL**：`v3_2DB`、`backfillShareBindings`、`revokeInvalidShares` 均有生产调用；`mailShareBinding` 无生产消费者，见 Critical #2。用户给出的 success/negative contract 未漂移，指定的文件锚点均存在。
7. **Business Reality / YAGNI — PASS**：新增列和 Binding 模型均由 Data Models/T-01 明确要求；未新增失败锁定表、持久化 `share_type` 或其他平行能力。

## Wiring probe（原始输出）

当前 codegraph namespace 只有被 review 规则禁止的 `codegraph_explore`，没有 `sync/callers`，因此按回退协议执行：

```text
$ git grep -n -E "v3_2DB|backfillShareBindings|revokeInvalidShares|mailShareBinding" 4f72418 -- "mail-worker/src"
4f72418:mail-worker/src/entity/mail-share-binding.js:4:export const mailShareBinding = sqliteTable('mail_share_binding', {
4f72418:mail-worker/src/init/init.js:33:		await this.v3_2DB(c);
4f72418:mail-worker/src/init/init.js:38:	async v3_2DB(c) {
4f72418:mail-worker/src/init/init.js:87:		await this.backfillShareBindings(c);
4f72418:mail-worker/src/init/init.js:88:		await this.revokeInvalidShares(c);
4f72418:mail-worker/src/init/init.js:91:	// v3_2DB 迁移门禁之一（design.md「迁移 v3_2DB · 旧行回填」唯一 SQL 真源）：
4f72418:mail-worker/src/init/init.js:93:	async backfillShareBindings(c) {
4f72418:mail-worker/src/init/init.js:108:	// v3_2DB 迁移门禁之二（同上唯一 SQL 真源）：判据只取 account 事实（不存在 / 已删 / 归属不符），
4f72418:mail-worker/src/init/init.js:111:	async revokeInvalidShares(c) {
4f72418:mail-worker/src/init/init.js:129:				migration: 'v3_2DB',
```

## Verification evidence

```text
$ pnpm --dir mail-worker exec vitest run test/v3-2-db.spec.js test/mail-share.schema.spec.js
✓ test/v3-2-db.spec.js (12 tests)
✓ test/mail-share.schema.spec.js (6 tests)
Test Files  2 passed (2)
Tests  18 passed (18)
EXIT=0
```

```text
$ git rev-parse --verify 4f72418^{commit}
4f724189abbae6b13d0af834c7c520b68734d814
EXIT=0

$ git diff --check e120a04..4f72418 -- <5 authoritative files>
EXIT=0

$ <added-production-lines negative gate>
no forbidden production additions
EXIT=0
```

## Leftover risks

- `mail-worker/src/init/init.js:54-59` 对 11 条 `ALTER TABLE` 捕获所有异常并继续；这是 design 指定的既有幂等模式，但会把非“duplicate column”的 D1 故障也降为 warning，可能留下部分 schema。定向测试没有注入此类故障。
- `mail-worker/test/v3-2-db.spec.js:350-364` 的“回填后 account 再删除”场景只断言 share 被撤销，没有断言旧 Binding 被删除；该级联/清理职责按任务清单明确留给 T-18，不属于本次 v3_1-shaped 迁移验收，但 T-18 完成前仍是阶段性风险。
- 定向测试 stderr 暴露了既有迁移对 `auto_refresh_time` 的 `no such column` warning；不在 T-01 diff 内，不计本次 finding，但进一步证明宽泛 catch 的观测风险。

## VERDICT
status: NEEDS_CHANGES
critical_count: 2
important_count: 0
minor_count: 0
ready_to_merge: NO
one_line: T-01 运行行为和 SQL 设计均通过，但 Evidence 格式与 `mailShareBinding` 生产接线两个强制门禁阻止合并。
