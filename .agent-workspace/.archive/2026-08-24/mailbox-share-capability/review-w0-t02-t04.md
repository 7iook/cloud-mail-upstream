# Independent Review · mailbox-share-capability W0 T-02 / T-03 / T-04

- 日期：2026-08-24
- 分支：`cursor/mailbox-share-capability-dcb6`
- 分支 HEAD：`3834456d8c8468582af0f9202880d384b4b715aa`
- 实现提交：`e878760cbc9bfc3e1ea5466bb0aa651a5794ba08`
- 审查范围：`4f72418..e878760`
- 事实校正：`e878760` 的直接父提交是 `bf1eaf9`，不是派单所述的 `4f72418`；本报告仍按指定区间审查。
- requested_verdict：`CHANGES_REQUIRED`
- P0 / P1 / P2：`3 / 2 / 1`
- 生产 `SHARE_CAPABILITY_V2`：**仓库配置保持关闭**。`wrangler.toml` 无活动赋值，代码仅显式接受 `true`/`1`，缺省为 false；本次提交没有静默启用生产。

## Strengths

- `mail-worker/src/service/mail-share-service.js:275-289`：`syncPrimaryAccountId` 是可加入 D1 batch 的单条条件 UPDATE，以最小 `binding_id` 选主 Binding；无可用 Binding 时 `EXISTS` 使其零变更，不写 0。
- `mail-worker/src/service/mail-share-service.js:54-68`、`mail-worker/wrangler.toml:58-60`：V2 栅栏只读环境变量，采用显式真值白名单；生产 TOML 只有注释，未覆盖 Dashboard 配置。
- `mail-worker/test/setup.js:27-126`：新增工厂只执行 INSERT，没有复制建表 DDL；三套历史基线只记录在注释，没有钉死总用例数。
- `mail-worker/test/mail-share-service.spec.js:463-559`：双写助手覆盖最小 Binding、删除主 Binding、空 Binding、batch 组合和 v3_2DB 形状种子行。
- `mail-worker/src/init/init.js`、`mail-worker/src/service/share-auth-service.js`、`mail-worker/src/security/security.js`：指定禁止修改的生产文件在目标区间内零差异。

## Verification Evidence

| 检查 | 命令 | 结果 |
|---|---|---|
| 提交范围 | `git show --stat --oneline e878760 && git diff --name-status 4f72418..e878760` | `EXIT=0`；10 个文件，生产代码仅改 `mail-share-service.js` |
| 提交/证据 hash | `git rev-list --parents -n 1 e878760 && git rev-parse 4f72418^{commit} e878760^{commit} 3834456^{commit}` | `EXIT=0`；三 hash 均解析，直接父为 `bf1eaf9` |
| T-02/T-03 定向测试 | `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/mail-share.schema.spec.js` | `EXIT=0`；2 files / 54 tests |
| worker 全量基线（隔离 worktree `e878760`） | `pnpm --dir mail-worker test` | `EXIT=0`；17 files / 180 tests |
| vue 全量基线（隔离 worktree `e878760`） | `pnpm --dir mail-vue test` | `EXIT=0`；17 files / 95 tests |
| E2E 基线（隔离 worktree `e878760`） | `node tests/e2e/run.mjs` | `EXIT=0`；13 passed |
| 禁改文件 | `git diff --name-only 4f72418..e878760 -- mail-worker/src/init/init.js mail-worker/src/service/share-auth-service.js mail-worker/src/security/security.js` + 空输出断言 | `EXIT=0`；空输出 |
| seed-only | `! rg -n "CREATE\\s+TABLE\|ALTER\\s+TABLE" mail-worker/test/setup.js` | `EXIT=0` |
| 生产栅栏配置 | Node 扫描 `wrangler.toml` 活动 `SHARE_CAPABILITY_V2 =` 行 | `EXIT=0`；`{"activeAssignments":[]}` |
| 鉴权读取现状 | `rg` 计数 `share-auth-service.js` / `share-scoped-email-repository.js` 的既定模式 | `EXIT=0`；4 / 0 |
| whitespace gate | `git diff --check 4f72418..e878760` | `EXIT=2`；`review-t01.md:23-30` 尾随空格 |

说明：主工作区在审查过程中出现了其他执行者未提交的 W1 测试改动；该工作区的 worker 失败结果已排除。本报告的三套基线均以 `/tmp/review-e878760` 中的 detached `e878760` 重跑。第一次在隔离 worktree 运行 worker 时因尚无 `mail-worker/dist` 以 `EXIT=1` 终止且未执行测试；E2E 构建资产后，同一目标提交重跑为 17/180、`EXIT=0`。

## 7-Phase Check

### Phase 1 · Spec Conformance — FAIL

T-02 的 SQL 行为、T-03 的缺省关闭与常量、T-04 的 seed-only/注释基线均有直接证据；但 T-04 明确要求的非数字 ID 拒绝被 JavaScript 强制类型转换绕过，见 P0-3。本波次只是地基，不应被当作原始用户成功态已完整交付。

### Phase 2 · Task-Ledger Evidence Gate — FAIL

`tasks.md` 存在，且 T-02/T-03/T-04 的多个已勾选子项没有四要素 Evidence，见 P0-1。`e878760` hash 本身可解析。

### Phase 3 · Code Quality — FAIL

双写和配置读取各有单一实现，但新增生产公开符号尚无生产消费者；日志 helper 还允许调用字段覆盖固定事件名，见 P0-2、P1-2。未发现硬编码密钥、宽泛吞异常或第二套持久化实现。

### Phase 4 · Domain-Model Consistency — not applicable

仓库不存在 `docs/domain/*-model.md`；本次数据模型权威来源为已读取的 requirements/design/ADR。

### Phase 5 · Upstream Root Cause — PASS WITH DIRECTIONS

各问题的修复点均可落在最早责任层：ID 类型约束放在 seed 工厂入口，固定事件不可覆盖放在日志 choke point，鉴权读取围栏放在守护测试，生产接线放在实际写入口。

### Phase 6 · Whole-Path Completeness — FAIL

Codegraph namespace仅提供被评审规则禁止的 `codegraph_explore`，没有 `sync`/`callers`，故按规则回退到：

```text
$ for symbol in SHARE_BINDING_LIMIT SHARE_V2_INTENT SHARE_EVENT assertCapabilityV2 logShareEvent syncPrimaryAccountId; do git grep -n -w "$symbol" -- mail-worker/src mail-worker/test || true; done
mail-worker/src/service/mail-share-service.js:16:export const SHARE_BINDING_LIMIT = 50;
mail-worker/test/mail-share-service.spec.js:6:	SHARE_BINDING_LIMIT,
mail-worker/test/mail-share-service.spec.js:558:		expect(SHARE_BINDING_LIMIT).toBe(50);
mail-worker/src/service/mail-share-service.js:19:export const SHARE_V2_INTENT = {
mail-worker/src/service/mail-share-service.js:62:// `intent` 取 SHARE_V2_INTENT 之一,标记是四条受限写入路径中的哪一条;判定与 intent 无关,
mail-worker/test/mail-share-service.spec.js:8:	SHARE_V2_INTENT,
mail-worker/test/mail-share-service.spec.js:596:		expect(SHARE_V2_INTENT).toEqual({
mail-worker/test/mail-share-service.spec.js:602:		expect(Object.values(SHARE_V2_INTENT).sort()).toEqual([...GATED_INTENTS].sort());
mail-worker/test/mail-share-service.spec.js:628:		const err = catchBizSync(() => assertCapabilityV2(c, SHARE_V2_INTENT.MULTI_CREATE));
mail-worker/src/service/mail-share-service.js:27:export const SHARE_EVENT = {
mail-worker/test/mail-share-service.spec.js:7:	SHARE_EVENT,
mail-worker/test/mail-share-service.spec.js:635:		expect(SHARE_EVENT).toEqual({
mail-worker/test/mail-share-service.spec.js:650:			logShareEvent(SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId: 42, reason: 'quota_exhausted' });
mail-worker/test/mail-share-service.spec.js:651:			logShareEvent(SHARE_EVENT.SYSTEM_ERROR, {});
mail-worker/src/service/mail-share-service.js:64:export function assertCapabilityV2(c, intent) {
mail-worker/test/mail-share-service.spec.js:9:	assertCapabilityV2,
mail-worker/test/mail-share-service.spec.js:606:		const err = catchBizSync(() => assertCapabilityV2({ env: {} }, intent));
mail-worker/test/mail-share-service.spec.js:613:			const err = catchBizSync(() => assertCapabilityV2(ctx({ SHARE_CAPABILITY_V2: flag }), intent));
mail-worker/test/mail-share-service.spec.js:620:			expect(assertCapabilityV2(ctx({ SHARE_CAPABILITY_V2: flag }), intent)).toBeUndefined();
mail-worker/test/mail-share-service.spec.js:628:		const err = catchBizSync(() => assertCapabilityV2(c, SHARE_V2_INTENT.MULTI_CREATE));
mail-worker/src/service/mail-share-service.js:73:export function logShareEvent(event, fields = {}) {
mail-worker/test/mail-share-service.spec.js:10:	logShareEvent,
mail-worker/test/mail-share-service.spec.js:650:			logShareEvent(SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId: 42, reason: 'quota_exhausted' });
mail-worker/test/mail-share-service.spec.js:651:			logShareEvent(SHARE_EVENT.SYSTEM_ERROR, {});
mail-worker/src/service/mail-share-service.js:275:export function syncPrimaryAccountId(c, shareId) {
mail-worker/test/mail-share-service.spec.js:11:	syncPrimaryAccountId
mail-worker/test/mail-share-service.spec.js:471:		await syncPrimaryAccountId(ctx(), created.shareId).run();
mail-worker/test/mail-share-service.spec.js:483:		await syncPrimaryAccountId(ctx(), created.shareId).run();
mail-worker/test/mail-share-service.spec.js:493:		const applied = await syncPrimaryAccountId(ctx(), created.shareId).run();
mail-worker/test/mail-share-service.spec.js:519:		const statement = syncPrimaryAccountId({ env: shareEnv({ db }) }, created.shareId);
mail-worker/test/mail-share-service.spec.js:544:		await syncPrimaryAccountId(ctx(), share.shareId).run();
EXIT=0
```

所有新增生产公开符号都只有定义、注释或测试消费者。任务文本虽把实际接线延后到 T-12/T-13/T-15/T-16/T-18，但当前交付仍未通过生产接线门禁。`seedShareRow`/`seedBindingRow` 位于测试目录且是测试专用工厂，不按生产能力要求消费者。

派单提供了带负面条件的用户成功态并指向权威 specs；本波次没有单独 completion report 作为审查对象，因此 §0.16 completion-report 问答与 link table 不适用。

### Phase 7 · Business Reality / YAGNI — PASS

双写、V2 发布栅栏、Binding 上限、结构化事件与 seed 工厂均直接对应滚动发布安全和已列业务验收，没有新增平行表、服务端 Session、`share_type` 持久化或纯技术对称性能力。

## Issues

### P0 · Must Fix

1. `docs/specs/mailbox-share-capability/tasks.md:57-87`
   - **What**：T-02.1/T-02.2/T-03.1/T-03.2 的 Evidence 没有可复跑命令与 `→ EXIT=<code>`；T-04.1 还缺 AC；T-04.2 缺 `files: path:lines`。
   - **Why**：这些条目已标 `[x]`，但不满足每项 commit + verify/EXIT + files:lines + AC 的机械证据门禁，完成声明不可审计。
   - **How**：为每个已勾选子项补齐四个字段及本轮真实复跑结果；无法给出证据的条目恢复为未完成。

2. `mail-worker/src/service/mail-share-service.js:15-82,271-289`
   - **What**：`SHARE_BINDING_LIMIT`、`SHARE_V2_INTENT`、`SHARE_EVENT`、`assertCapabilityV2`、`logShareEvent`、`syncPrimaryAccountId` 均无生产调用点，只有测试消费者。
   - **Why**：当前生产路径不会执行双写 helper、能力栅栏或统一日志出口，绿色单测只能证明孤立函数行为，不能证明交付已接线。
   - **How**：将这些符号与 T-12/T-13/T-15/T-16/T-18 的真实写路径/异常路径在同一可审查交付中接通，或在接线前不要把相应任务标为完成。

3. `mail-worker/test/setup.js:99-100,116-119`
   - **What**：ID 校验使用强制转换式 `value > 0`，会接受非数字形状，如 `"1e3"`、`"1.5"`、`true`、`Infinity`。
   - **Why**：这违反派单要求的 `userId/accountId` 非数字必须抛错，并允许测试夹具静默把错误类型写进 SQLite 数字亲和列，掩盖调用方缺陷。
   - **How**：在两个 seed 工厂入口用 `Number.isSafeInteger(value) && value > 0` 校验相关 ID，并新增上述反例测试。

验证反例：

```text
$ node -e "for (const v of ['1e3','1.5',true,Infinity]) console.log(String(v), 'passes=', v > 0)"
1e3 passes= true
1.5 passes= true
true passes= true
Infinity passes= true
EXIT=0
```

### P1 · Should Fix

1. `mail-worker/test/mail-share.schema.spec.js:20-24,142-151`
   - **What**：鉴权读取围栏只匹配四种文本形式，新增 `row?.accountId`、`row['accountId']`、解构或新 SQL alias 时计数仍可保持 4/0。
   - **Why**：AC-BIND-01 的安全回归可绕过测试而继续绿，无法可靠保证鉴权路径“不增长新读取”。
   - **How**：改为 AST 属性访问检查，或对白名单行逐一锁定并拒绝目标文件中所有其他 `accountId/account_id` 读取形式。

2. `mail-worker/src/service/mail-share-service.js:73-81`
   - **What**：`...rest` 位于固定 `event` 之后，`fields.event` 可以覆盖第一个参数传入的固定事件名。
   - **Why**：事件 taxonomy 不再稳定，告警消费者可能漏掉本应属于 `share.system.error` 等固定类别的事件。
   - **How**：先展开诊断字段再写入 canonical `event/requestId/shareId/ts`，或显式从 fields 中剔除保留键，并加覆盖反例测试。

验证反例：

```text
{"event":"overridden","requestId":null,"shareId":null,"ts":"fixed"}
```

### P2 · Nice to Have

1. `.agent-workspace/.archive/2026-08-24/mailbox-share-capability/review-t01.md:23-30`
   - **What**：新增报告的六行含尾随空格。
   - **Why**：`git diff --check 4f72418..e878760` 以 `EXIT=2` 失败，污染通用提交质量门禁。
   - **How**：删除这些行尾空格并让 `git diff --check` 返回 0。

## VERDICT
status: NEEDS_CHANGES
critical_count: 3
important_count: 2
minor_count: 1
ready_to_merge: NO
one_line: T-02/T-03 核心 helper 的孤立行为与生产默认关闭已验证，但证据台账、生产接线和 seed ID 类型约束仍阻断合并。
