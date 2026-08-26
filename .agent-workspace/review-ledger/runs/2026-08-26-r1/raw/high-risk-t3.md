# T3 · high-risk 独立审查

## 1. verdict

`NEEDS_CHANGES`：1 条 P1 account 配额并发绕过，1 条 P2 批量幂等重放完整性违例。

## 2. findings

### T3-F1 · account 配额只在事务外预检，并发 emails 创建可永久超额

- severity: P1
- anchor: `mail-worker/src/service/mail-share-service.js:1256`
- symbols: `createFromEmails`, `accountGuardSql`, `planMailboxProvision`, `prepareAccountInsert`, `countOwnedMailboxes`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:97` 把配额列为两个建号入口共同的共享不变量，`:102-104` 要求预校验后把 account/share/binding 写入同一 batch；`mailbox-provision.js:147-150` 将 `roleRow.accountCount` 定义为实际 account 上限。
- identity_scope: `MailboxProvision/RoleAccountQuotaAtomicity`
- failure_mode: `planMailboxProvision` 在 batch 外执行 `owned + missing.length`，但 batch 内注入 account INSERT 的 `accountGuardSql` 只检查活跃分享数，完全不复核 account 配额。
- trigger: 用户已有 1/2 个 account，两次并发 create 分别提交一个不同的新地址；两次 plan 都读到 1 并放行，随后两个串行 batch 都能 INSERT，最终得到 3/2 个 account（同理可由更多并发请求扩大超额）。
- impact: 普通 Owner 可绕过角色配置的 account 数量限制，留下超配额的持久 account、share 与 binding 行；现有 quota 用例只有串行“已满后拒绝”，不覆盖该交错。
- required_fix: 把角色 account 配额收敛为 `mailbox-provision` 的原子写侧不变量，并让一批 missing account 以单个全有或全无的条件写检查“当前 owned + 本批数量 ≤ 当前角色上限”；设置页与分享入口共用该写原语，不能只在 `createFromEmails` 再补一次 SELECT。
- verify: `cd /tmp/review-share-fullchain/mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js -t "keeps role account quota atomic under concurrent email creates"`，补入并发交错回归后期望退出码 `0`。
- risk_spread: `account 写路径的授权与配额闸门`；origin=`mail-share-service.createFromEmails`；hop1=`mailbox-provision.planMailboxProvision` 的事务外配额预检；hop2=`mailbox-provision.prepareAccountInsert` 的写侧谓词；surfaces=`mailbox-provision.js, role-service.js`；stop=`已定位分享入口可写集合在并发交错下大于角色配额允许集合`。

### T3-F2 · 批量幂等重放只检查“至少命中一条”，会把残缺批次当成功返回

- severity: P2
- anchor: `mail-worker/src/service/mail-share-service.js:672`
- symbols: `batchReplayLids`, `replayBatchFromLids`, `replayFromIdempotency`, `prepareIdempotencyInsert`
- rule_source: `docs/specs/mail-share/requirements.md:68` AC-SHARE-11 要求等价重放返回同一创建结果，`docs/specs/mailbox-share-capability/requirements.md:63` AC-CAP-09 要求沿用该重复操作检测语义；实现自身 `mail-share-service.js:661` 又明确声明批次任一行已不存在时应“整单 NOT_FOUND”。
- identity_scope: `MailShareCreateIdempotency/BatchReplayCompleteness`
- failure_mode: `replayBatchFromLids` 仅在查询结果总数为 0 时返回 `SHARE_NOT_FOUND`，没有验证 `byShare` 的 lid 集合与 `response_fingerprint.lids` 完全相等，因此缺一条仍返回 `idempotentReplay: true`。
- trigger: 一次 V2=false 的两地址创建留下 `{lids:[A,B]}`，之后数据库仅剩 A，再以原 Owner、原 Key、等价请求体重试。
- impact: 首次成功结果有两条分享，重放却以成功形状静默缩成一条；调用方无法区分“完整重放”和“批次已残缺”，与单条重放缺行即 `SHARE_NOT_FOUND` 的行为也不一致。
- required_fix: 在幂等命令层定义并强制批次成员的完整生命周期：重放前按去重后的 lid 集合做精确相等校验，缺任一成员整单 `SHARE_NOT_FOUND`；同时让批次成员与幂等记录的清理关联一致，不能由 UI 或响应组装层过滤缺失项。
- verify: `cd /tmp/review-share-fullchain/mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js -t "rejects partial replay when one batch member is missing"`，补入“创建两条→移除非首成员→同 Key 重放”回归后期望退出码 `0`。
- risk_spread: `none`

## 3. account 授权与配额 risk spread

- `addEmail` / `manyEmail` / Turnstile：设置页 `accountService.add` 检查、分享入口不检查；决策卡 `:98` 明确批准该差集，故不是 finding。
- 格式、配置域、前缀、存量行归属/删除态、角色域名权限与串行配额均经 `planMailboxProvision` 共用；分享入口额外允许复用自己的存量 account，这是 find-or-create 契约，不是新建授权扩大。
- 配额差集：串行达到上限会拒绝，但并发交错可越过上限，见 T3-F1。
- stop_when：已判明两入口可创建集合的显式差异均获决策卡授权；未获保护的并发配额差集已定位，停止外扩。

## 4. D1 batch 语句间行可见性

- `prepareShareInsertByEmails:824-857` 与 `prepareBindingInsertByEmails:897-912` 明确依赖同一 batch 中更早的 account INSERT 对后续 SELECT 可见。
- `mail-share-emails.spec.js:156-179` 使用 `cloudflare:test` 的 `env.db` 编写了“新 account 随即被 share/binding 引用”的 Miniflare 回归；`transaction.spec.js:184-229` 只证明 batch 回滚以及 JS 不能把前序结果绑定给后序语句，没有单独证明前序写入的行可见。
- unverified: 允许面内没有 Miniflare 之外的真 D1/remote 探针证据；本机定向 Vitest 又在收集前因 review root 无法解析 `@cloudflare/vitest-pool-workers` 而退出 `1`，所以本轮不能把该假设标成已实跑确认。
- stop_when：按主题约定记为 unverified 交回主 reviewer，未继续追 D1 全仓调用。

## 5. 幂等互认 risk spread

- 空 `emails: []` 与缺省 emails：都规范化为旧 account 形状，互为重放。
- 非空 emails 旁带残余 `accountId(s)`：在指纹前清为空集，同一 emails 请求互为重放。
- 单地址、自己的存量 account、默认配置：email modern + legacy accountId 两枚 accepted hash，两个入口双向互认；该地址首次尚不存在时先存 email modern，后续同 emails 重试因 accepted 仍含 modern 而重放。
- 单地址首次建号后改用 accountId 形状，或任一入口使用非默认配置：指纹不同，落 `SHARE_IDEMPOTENCY_CONFLICT`；决策卡 `:106` 只授权“单条且默认值”跨形状兼容。
- 多地址会先排序/去重；仅同一 emails 集合与配置互认，和 accountIds 形状冲突。N=1 写 `{lid}` 并走单条重放，N>1 写 `{lids}` 并走批量重放。
- 批量重放的集合完整性未闭合，见 T3-F2；除此之外组合已枚举并命中 stop_when。

## 6. V2 栅栏 risk spread

- 后端 `assertCreateBody` 不以 emails 数量拒绝；`createFromEmails:1200-1202` 仅在 V2=true 合并为一个 group，V2=false 恒按每个 email 建一个单元素 group，`prepareBindingInsertByEmails` 因而每条 share 只写一条 Binding。
- AuthKey、有限 `maxSessions`、有限 `messageLimit` 在 emails 单地址路径也仍经过 `assertCapabilityV2`；旧 accountIds 多 Binding 路径同样保留栅栏。
- 前端 `hasFenceIntent` 排除 emails，`degradeToInactive` 只清 AuthKey/两个配额字段、不缩减地址清单；与 V2=false 批量分流一致。
- stop_when：V2=false 下不存在由 emails 路径写出多 Binding 的分支，AC-LIFE-11 的写栅栏闭合，停止追踪。

## 7. verification + stop_when

- reviewed HEAD：`9b6eb8072fe73c93518e872037702a2e8e54056b`；`git status --short` 为空。
- 静态 SQL 复现：两次 plan 同见 `owned=1, limit=2` 后按当前仅含 share-limit guard 的 account INSERT 顺序执行，得到 `owned=3`，命令退出码 `0`。
- 静态 SQL 复现：幂等行记录 `[lid-a,lid-b]`、仅剩 `lid-a` 时，当前重放查询返回一条且满足“非空即成功”，命令退出码 `0`。
- 定向测试两次尝试均退出 `1`：review worktree 无本地依赖；复用 `/workspace/mail-worker/node_modules` 后，Vite 仍无法从 review root 加载 `@cloudflare/vitest-pool-workers`，测试未进入收集，未把仓内自报绿色数字作为证据。
- 四项 risk spread 均已命中各自 stop_when；未全仓漫游，未改业务代码，未执行 git commit。
