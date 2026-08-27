# T3 · 完整邮箱地址创建分享

## Finding 1

- severity: P1
- anchor: `mail-worker/src/service/mail-share-service.js:1342`
- symbols: `createFromEmails`, `prepareShareInsertByEmails`, `shareRows`
- rule_source: `docs/specs/mail-share/requirements.md:69`（AC-SHARE-12：命中上限须零部分写入）、`docs/specs/mailbox-share-capability/requirements.md:57,67`（AC-CAP-03/13：整单拒绝、不得部分写入）、`.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:101-106`（DC-P0-3：N 条单分享同一 batch、失败整批回滚）；`mail-worker/test/transaction.spec.js:98-103` 已证明条件 DML 零命中仍是成功语句，不会触发 batch 回滚。
- identity_scope: `MailShareService.create(emails[])` 在 `SHARE_CAPABILITY_V2=false` 时的一次 Owner 批量创建命令。
- failure_mode: 每个 group 独立执行条件 INSERT，任一语句零命中不会回滚，而 `shareRows.every(...)` 直到 `db.batch()` 已提交后才检查，因此同一命令能落下部分 share/binding。
- trigger: 以 `N=2`、活跃上限 `L` 为例，预检后并发请求把基数推到 `L-1`，第 0 条使用阈值 `L-1` 而零命中，第 1 条使用放宽后的阈值 `L` 并成功，随后本请求抛 `SHARE_LIMIT_EXCEEDED`。
- impact: 调用方收到失败且拿不到该条分享的 `sec`，数据库却保留一条 ACTIVE share 及 binding，并消耗活跃配额；同样的后提交检查也无法收回归属竞态下已成功的其他 group。
- required_fix: 把 N 条 share 的限额/归属判定收敛为一个能控制整组写入的事务内原子门闩（例如一次 set-based 条件 INSERT），或让任一前置失败在 batch 内产生真正的 SQL 异常以回滚全部 account/share/binding，禁止继续依赖 batch 返回后的 JS 补判。
- verify: `unverified: 当前只读工作树的 mail-worker 未安装 vitest（实际执行定向命令 exit 127），且现有 mail-share-emails.spec.js 没有“预检后注入一条 ACTIVE share、断言零残留”的竞态用例。`
- risk_spread: none

## Finding 2

- severity: P1
- anchor: `mail-worker/src/service/mail-share-service.js:1256`
- symbols: `createFromEmails`, `planMailboxProvision`, `prepareAccountInsert`, `accountGuardSql`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:96-104` 将角色 account 配额列为两个建号入口共享的不变量，并要求 account INSERT 进入同一事务；`mail-worker/test/mail-share-emails.spec.js:303-319` 固定了 `role.account_count` 达限即拒绝且零 account 写入的契约。
- identity_scope: `MailboxProvision / Owner × role.accountCount` 的账号归属配额。
- failure_mode: `planMailboxProvision` 只在 batch 外执行 `owned + missing.length` 预检，而注入 `prepareAccountInsert` 的唯一 guard 只统计 ACTIVE share，事务内没有 account 配额谓词。
- trigger: Owner 只剩一个 account 名额时，两个不同新地址的并发 create 都在任一写入前完成 plan，二者均通过；随后两个 batch 串行插入各自的不同地址，UNIQUE 也不会冲突。
- impact: 最终正常 account 数超过角色 `accountCount`，两个请求都能同时创建对应分享，直接绕过管理员配置的账号数量策略。
- required_fix: 在建号 SSOT 中提供一次性写入整个 `missing` 集合的事务内配额门闩，并让配额不足中止同批全部 account/share/binding；不得用写后重数或清理补偿替代授权前置。
- verify: `unverified: 当前只读工作树的 mail-worker 定向测试无法启动（vitest 缺失，exit 127），现有配额用例只覆盖串行达限，没有两个不同地址共享最后一个名额的并发回归。`
- risk_spread:
  - name: `account 写路径的授权与配额闸门`
  - origin: `mail-worker/src/service/mail-share-service.js:createFromEmails`
  - hops: `createFromEmails → planMailboxProvision / prepareAccountInsert`
  - surfaces: `mail-worker/src/service/mailbox-provision.js`、`mail-worker/src/service/account-service.js`
  - stop: 已确认设置页与分享入口共用同一串行配额预检，但分享 batch 的写谓词只含 ACTIVE share 余量，不含 `role.accountCount`。

## Finding 3

- severity: P2
- anchor: `mail-worker/src/service/mail-share-service.js:672`
- symbols: `prepareIdempotencyInsert`, `batchReplayLids`, `replayBatchFromLids`
- rule_source: `docs/specs/mailbox-share-capability/design.md:300` 规定 V2=false 批量重放按幂等行的完整 lid 清单返回 `{shares, idempotentReplay}`；`docs/specs/mailbox-share-capability/requirements.md:63,68`（AC-CAP-09/14）要求等价重放返回原成功结果的 shareId/lid 集合且不再下发明文。
- identity_scope: 一条 `share_idempotency(create)` 对应的 V2=false 批量创建结果集合。
- failure_mode: 幂等行的标量 `share_id` 只指向首条分享、`response_fingerprint` 才保存全部 lids，而重放只检查查询结果是否完全为空，不检查回读集合与 lids 清单等长。
- trigger: 两地址批量创建后，在 24 小时幂等窗口内物理删除其中一条非首分享，再以同一 Key 重试原请求。
- impact: 服务返回 `idempotentReplay: true` 却只列剩余子集；若删除的是首分享，标量关联的幂等行被删除而其余成员仍在，同 Key 会被当作全新创建，产生重复分享。
- required_fix: 将批量幂等结果建模为可完整关联 N 条 share 的关系，并让删除、清理与重放共同维护“集合恰好等于首次结果”的基数不变量；不得只在 `replayBatchFromLids` 末端补一个 UI 提示或吞掉缺失成员。
- verify: `unverified: mail-worker 测试运行器在该只读工作树缺失；现有重放测试只覆盖所有成员仍存在的 happy path，没有“删除首项/非首项后同 Key 重放”用例。`
- risk_spread: none

## Finding 4

- severity: suggestion
- anchor: `mail-worker/src/service/mail-share-service.js:817`
- symbols: `prepareShareInsertByEmails`, `prepareBindingInsertByEmails`, `createFromEmails`
- rule_source: `docs/specs/mail-share/design.md:669-671` 与 `docs/specs/mail-share/requirements.md:72` 的 T-02 只固定 batch 回滚和“不得消费前序语句结果”；T3 的具名风险预算要求另行确认同 batch 后序 SQL 对前序 INSERT 的行可见性。
- identity_scope: 生产 Cloudflare D1 上 `account INSERT → share/binding SELECT account` 的同 batch 行可见性契约。
- failure_mode: 代码把“后序语句可见前序新增 account 行”作为创建未注册邮箱的硬前提，但仓内证据只有 Miniflare 配置下的间接用例，`transaction.spec.js` 没有该行可见性断言，也没有 remote D1 产物。
- trigger: 发布验收仅以本地 `@cloudflare/vitest-pool-workers`/Miniflare 结果替代 remote D1 语义取证。
- impact: 当前证据不能证明生产运行时兑现“不预注册即可创建”的核心持久化链路；本条不主张已存在生产行为差异，只记录证据缺口。
- required_fix: 增加一次 remote D1 集成探针，显式在同一 `db.batch()` 先 INSERT account、后以邮箱 SELECT 该行并写依赖表，同时验证成功可见与后序报错整批回滚，保存可复跑命令和结果。
- verify: `unverified: 本环境没有可安全使用的 remote D1 测试 binding，且 mail-worker 本地依赖未安装；无法在只读审查中补造该证据。`
- risk_spread:
  - name: `D1 batch 语句间行可见性`
  - origin: `mail-worker/src/service/mail-share-service.js:prepareShareInsertByEmails`
  - hops: `prepareShareInsertByEmails → mail-share-emails.spec.js / transaction.spec.js / design.md T-02`
  - surfaces: `mail-worker/test/mail-share-emails.spec.js`、`mail-worker/test/transaction.spec.js`、`docs/specs/mail-share/design.md`
  - stop: 已确认 emails happy path 是 Miniflare 间接证据，T-02 没有显式行可见性用例，仓内未找到 remote D1 证据。

## 本轮测试证据

- `mail-vue`: `npm test -- --run src/views/share-admin/presets.spec.js src/views/share-admin/ShareCreateWizard.spec.js`，46 tests passed，exit 0。
- `mail-worker`: `npm test -- --run test/mail-share-emails.spec.js test/transaction.spec.js`，因 `vitest: not found` 退出 127；未安装依赖，按 read-only 约束未执行安装。
