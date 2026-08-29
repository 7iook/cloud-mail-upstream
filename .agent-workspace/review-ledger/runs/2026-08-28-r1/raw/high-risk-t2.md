# T2 · high-risk 独立审查

## 1. verdict

`NEEDS_CHANGES`：1 条 P1 数据完整性/配额谓词分歧，1 条 P2 稳定错误码分歧。

## 2. findings

### T2-F1 · 多地址恰好填满配额时，同一 guard 的后续 INSERT 会否掉已通过预检的请求

- severity: P1
- anchor: `mail-worker/src/service/mailbox-provision.js:242`
- symbols: `accountQuotaPredicateBinds`, `accountQuotaPredicateSql`, `prepareAccountInsert`, `createFromEmails`
- rule_source: `mail-worker/src/service/mailbox-provision.js:79-80` 要求全量预校验通过后才进入写入、任一项不过整单零 INSERT；同文件 `:150-153` 的预检接受 `owned + missing.length <= accountCount`。`docs/specs/mailbox-share-capability/requirements.md:55` 要求 `emails[]` find-or-create 创建对应分享，`docs/specs/mailbox-share-capability/design.md:136` 指定 D1 跨行原子靠同一 `batch()` 与单语句条件写。
- identity_scope: `MailboxProvision/AccountQuotaPredicateEquivalence`
- failure_mode: `accountQuotaPredicateBinds` 为全部缺失地址返回同一个上界 `accountCount - (missingCount - 1)`，`createFromEmails` 又在 `mail-worker/src/service/mail-share-service.js:1279-1285` 把同一 guard 逐条挂到 account INSERT。SQLite/D1 事务内后续语句可见本事务前序写入；当 `owned = accountCount - missingCount` 时首条命中，第二条重算 `COUNT(*)` 后不再满足同一 `< bound`，于是预检“整批可建”与写入谓词“只建第一条”分歧。
- trigger: 普通非管理员一次用 `emails[]` 提交至少两个尚未建号的地址，且这些地址恰好填满其角色 `accountCount` 余量；例如 `owned=1, missing=2, accountCount=3`。
- impact: 合法请求被报错，同时 batch 已提交前部副作用；V2=false 可留下第一条 account/share/binding（以及有 key 时的幂等行），Owner 没拿到对应明文凭据，且孤行继续消耗账号/活跃分享配额。V2=true 至少留下前部 account。现有批后检查不能回滚这些提交。
- required_fix: 在最早的 account 写入责任层让配额条件对整组候选只求值一次，例如用一条 set-based `INSERT ... SELECT` 原子写入全部缺失 account，或让计数显式排除本批候选并保证所有逐条谓词共享同一批前状态；不得用批后删除补偿。增加“多地址恰好填满配额”用例，断言全成功；再注入并发占走余量，断言整批零 account/share/binding/idempotency 残留。
- verify: 在 D1 测试环境预置 `owned=1, accountCount=3`，以同一请求创建两个 missing 地址；修复后两条 account 与对应分享全部创建。再在预检与 batch 间插入一条同用户 account；修复后请求稳定拒绝，四张相关表均零本请求残留。
- risk_spread: `account-quota-predicate-equivalence`；origin=`accountQuotaPredicateBinds/accountQuotaPredicateSql`；hop1=`createFromEmails → prepareAccountInsert.guardSql`；stop=`已找到预检与第二条 INSERT 的确定分歧，停止继续追踪 batch 下游`。

### T2-F2 · 第二次角色查询的缺失分支绕过分享错误码适配

- severity: P2
- anchor: `mail-worker/src/service/mail-share-service.js:1267`
- symbols: `createFromEmails`, `resolveNonAdminAccountQuota`, `planShareMailboxes`, `ProvisionDenied`, `PROVISION_TO_SHARE_ERROR`
- rule_source: `docs/specs/mailbox-share-capability/requirements.md:55` 与 `docs/specs/mailbox-share-capability/design.md:436` 明定账号侧不可用（含配额/角色域名权限）对分享创建统一为 `SHARE_ACCOUNT_FORBIDDEN`；`mail-worker/src/service/mailbox-provision.js:215` 又声明 `resolveNonAdminAccountQuota` 的 role 缺失与 `planMailboxProvision` 使用同一 fail-closed 规则。
- identity_scope: `MailShareCreate/MissingRoleStableError`
- failure_mode: 首次 `planShareMailboxes` 会在 `mail-worker/src/service/mail-share-service.js:1152-1158` 把 `ProvisionDenied(QUOTA_EXCEEDED)` 适配成 `BizError('SHARE_ACCOUNT_FORBIDDEN')`；随后 `createFromEmails` 直接调用会再次读取 user/role 的 `resolveNonAdminAccountQuota`，却不在该适配器内。若 role 在两次读取之间变为缺失，原始 `ProvisionDenied` 穿过 `withShare`，最终由全局错误处理输出 `{code:500,message:'QUOTA_EXCEEDED'}`。
- trigger: 第一次 plan 读到有效 role，随后在第二次 `userService.selectById + roleService.selectById` 前角色状态发生变化，使 `resolveNonAdminAccountQuota` 的 `!roleRow` 分支命中。
- impact: 写入仍 fail-closed，但同一“缺角色”事实因时序不同暴露两种对外协议；分享创建泄露内部机器原因并被客户端当成未知 500，而不是按规范展示“账号不可用”。现有测试只覆盖 role 从请求开始就缺失的首次 plan 分支。
- required_fix: 在分享入口的最早适配层保证 provision 的全部读取都位于同一个 `ProvisionDenied → PROVISION_TO_SHARE_ERROR` 边界内；优先让 `planMailboxProvision` 一次返回后续 guard 所需的 quota 快照，消除第二次 user/role 往返。补两次读取间 role 消失的测试，固定 `SHARE_ACCOUNT_FORBIDDEN` 与零写入。
- verify: 用 DB/proxy 在首次 plan 完成后、`resolveNonAdminAccountQuota` 查询前使第二次 role 查询返回空；调用 `mailShareService.create`，期望捕获 `BizError` 且 message 恰为 `SHARE_ACCOUNT_FORBIDDEN`，account/share/binding/idempotency 均无新增。
- risk_spread: `missing-role-fail-closed-blast-radius`；origin=`planMailboxProvision/resolveNonAdminAccountQuota !roleRow`；hop1=`mail-share-service create`；hop2=`mail-share-api withShare → 用户可见 envelope`；stop=`设置页与分享创建的正常缺角色码及二次读取竞态码均已确认，停止展开 role/permission 体系`。

## 3. account quota predicate equivalence

令 `L=accountCount`、`O=owned`、`M=missingCount`：

| 边界 | 预检 `O + M > L` | 首条谓词 `O < L-(M-1)` | 实际结果 |
|---|---|---|---|
| `M=1, O=L-1` | 接受 | 接受（bind 上界 `L`） | 对齐，写后恰为 `L` |
| `M=1, O=L` | 拒绝 | 拒绝 | 对齐 |
| `M=2, O=L-2` | 接受 | 首条接受；第二条看到 `O+1=L-1`，而上界仍为 `L-1`，拒绝 | 分歧，见 T2-F1 |

静态代数只证明**第一条**谓词等价：`O < L-M+1 ⇔ O+M <= L`。它不能证明把同一谓词重复执行 M 次仍等价。

## 4. missing-role fail-closed blast radius

| 入口/时序 | 翻译链 | 对外结果 |
|---|---|---|
| 设置页 `accountService.add`，首次 plan 即缺 role | `planMailboxProvision → toAddError` | `BizError(t('accountLimit'), 403)`；用户看到“添加邮箱数量到达限制” |
| 分享 `emails[]`，首次 plan 即缺 role | `planMailboxProvision → planShareMailboxes` | `SHARE_ACCOUNT_FORBIDDEN` |
| 分享首次 plan 有 role、第二次 quota 读取缺 role | `resolveNonAdminAccountQuota` 直接抛 `ProvisionDenied`，绕过 `planShareMailboxes` | envelope `code=500, message=QUOTA_EXCEEDED`，见 T2-F2 |

因此历史 F-0002 的“稳态缺 role fail-closed”不重开；本轮 finding 是新增第二次查询造成的时序分叉。

## 5. risk_spread

- `account-quota-predicate-equivalence`：只跨到 `mail-share-service.js` 的 `prepareAccountInsert.guardSql` 拼接与逐条复用点；找到第二条 INSERT 分歧后停止。
- `missing-role-fail-closed-blast-radius`：只追到设置页 `accountService.add`、分享 `create` 及各自用户可见错误 envelope；对外码确认后停止。
- 未检查 F-0008/F-0009/F-0010，也未扩展到 role/permission 整体、T1 幂等重放或其它 batch 完整性问题。

## 6. verification

- 运行 `pnpm test -- mail-share-emails.spec.js`：退出码 `0`；该脚本实际执行 worker 全套，`25 files / 868 tests` 全绿。现有 no-role 用例只覆盖首次 plan；现有批量成功用例使用默认无限账号配额，未覆盖 T2-F1。
- 用内存 SQLite 执行与当前 guard 同形的逐条事务写入：`O=2,M=1,L=3 → changes=[1]`；`O=3,M=1,L=3 → changes=[0]`；`O=1,M=2,L=3 → changes=[1,0]`。第三组复现预检接受但部分 INSERT。
- 静态错误链已逐段实读：`mailbox-provision.js:139-153,217-243`、`account-service.js:19-38,61-65`、`mail-share-service.js:1135-1159,1266-1271`、`mail-share-api.js:49-58`、`hono/hono.js:9-28`。

## 7. stop_when

- `account-quota-predicate-equivalence`：单地址指定边界对齐；多地址恰好填满时已找到确定分歧，命中 stop_when。
- `missing-role-fail-closed-blast-radius`：设置页稳态缺 role → 本地化 `accountLimit/403`；分享稳态缺 role → `SHARE_ACCOUNT_FORBIDDEN`；分享第二次读取缺 role → `QUOTA_EXCEEDED/500`，两入口对外码已确认，命中 stop_when。
- 审查到此停止。
