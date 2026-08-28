# T2 · 建号配额谓词独立审查

## verdict

`NEEDS_CHANGES`：3 条 P1 新 finding；F-0008 / F-0009 / F-0010 均 `persists`。F-0002 已验证保持关闭，不重报。

## findings

### T2-Q1 · 同一配额阈值复用于每条 account INSERT，合法的整单刚好占满配额时从第二条起静默零写入

- severity: P1
- anchor: `mail-worker/src/service/mailbox-provision.js:242`
- symbols: `accountQuotaPredicateBinds`, `accountQuotaPredicateSql`, `prepareAccountInsert`, `createFromEmails`
- rule_source: `mail-worker/src/service/mailbox-provision.js:150-153` 的预检契约是 `owned + missing.length <= accountCount`；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:101-106` 要求整批 account/share/binding 同批提交、失败零残留；`docs/specs/mailbox-share-capability/requirements.md:55` 的 AC-CAP-01 要求 `emails[]` 创建对应行。
- identity_scope: `EmailsCreate/AccountQuotaPredicateSetEquivalence`
- failure_mode: `accountQuotaPredicateBinds` 把阈值固定为 `accountCount - (missingCount - 1)`，`createFromEmails` 又把同一组 binds 传给每条缺失邮箱的 INSERT。第一条成功后，下一条 `COUNT(*)` 能读到本 batch 已插入的 account；在 `owned + missingCount = accountCount` 边界，第一条满足 `< threshold`，第二条恰等于 threshold 而零变更。零行不是语句错误，后续可用邮箱对应的 share/binding 仍提交。
- trigger: `accountCount=3`、Owner 已有 1 个 account、一次提交 2 个均缺失的地址；预检 `1+2>3` 为 false，绑定阈值为 2，两个 INSERT 的结果依次为 `[1 行, 0 行]`。
- impact: 一个按预检与角色配额均合法的批量请求返回错误；已成功的 account 及其 share/binding 留在库中但链接未交付。携带幂等键时还会提交只记录部分 lids 的状态，重放路径转成 `SHARE_NOT_FOUND`。
- required_fix: 在 `mailbox-provision` 责任层把缺失邮箱集合做成一次集合级配额判定/写入，使判定基于稳定的 batch 前 account 集合；所有依赖写入含幂等行须共同依赖该集合级成功，或由真实语句错误触发整批回滚。禁止继续把同一动态 `COUNT(*) < threshold` 谓词逐条复用。
- verify: 本轮实跑 SQLite 同形谓词边界矩阵，结果为 `missing=1, owned=limit-1 → [true]`、`missing=1, owned=limit → [false]`、`missing=2, owned=limit-2 → [true,false]`。修复验收须在 D1 用例中固定最后一组为两条均写入，并断言 account/share/binding/幂等记录全有或全无。
- risk_spread: `account-quota-predicate-equivalence`；origin=`accountQuotaPredicateBinds/accountQuotaPredicateSql`；hop1=`prepareAccountInsert guardSql`；已在多条 INSERT 的首个分歧边界命中 stop_when。

### T2-Q2 · 设置页建号仍只做预检，新增原子配额谓词没有进入第二个共享写入口

- severity: P1
- anchor: `mail-worker/src/service/mailbox-provision.js:189`
- symbols: `provisionMailbox`, `planMailboxProvision`, `prepareAccountInsert`, `accountService.add`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:96-100` 把角色配额列为设置页与分享创建共同的建号不变量；`mail-worker/src/service/mailbox-provision.js:10-18` 声明两个写入口都必须经本模块且差异只在包装层；`mail-worker/src/service/account-service.js:15-18` 再次声明配额属于共享不变量。
- identity_scope: `SettingsAdd/AtomicRoleAccountQuota`
- failure_mode: `provisionMailbox` 在 `planMailboxProvision` 完成先读计数后，调用 `prepareAccountInsert` 时未传任何 quota `guardSql/guardBinds`。两次 `/account/add` 可各自在 `owned=limit-1` 时通过预检，随后以两个不同邮箱分别执行无条件 INSERT，最终计数为 `limit+1`。
- trigger: 角色 `accountCount=3`、Owner 已有 2 个 account，两条不同地址的设置页添加请求在各自最后一次预检后再依次落库。
- impact: `accountCount` 对设置页入口仍可被并发超发；本提交只封住分享入口，建号配额没有成为两个入口共同的原子不变量。
- required_fix: 由 `mailbox-provision` 自身生成并强制应用 account 配额谓词，`provisionMailbox` 与分享 batch 只消费不可省略的同一写契约；零变更须在本层翻成 `ProvisionDenied(QUOTA_EXCEEDED)`，调用方仅负责既有错误映射。
- verify: 本轮按当前“两个预检后无条件写”顺序实跑内存 SQLite，输出 `{"limit":3,"preA":2,"preB":2,"final":4}`。修复验收须并发同步两次 `accountService.add` 的计数读取，断言恰一条成功、终值为 3、另一条仍映射设置页 `accountLimit` 403。
- risk_spread: `account-quota-predicate-equivalence`；origin=`mailbox-provision` 配额谓词；hop1=`provisionMailbox → prepareAccountInsert`；在第二写入口未注入 guard 处命中 stop_when。

### T2-Q3 · UNIQUE 整批重试沿用第一次 plan 的 missingCount，重试 guard 与新 plan 脱节

- severity: P1
- anchor: `mail-worker/src/service/mail-share-service.js:1273`
- symbols: `accountGuardSql`, `accountGuardBinds`, `plan`, `planShareMailboxes`, `attempt`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:104-106` 规定同主抢注后复读并整批重试一次；`mail-worker/src/service/mailbox-provision.js:150-153` 规定谓词须与当前 `missing.length` 等价。
- identity_scope: `EmailsCreate/RetryQuotaGuardSnapshot`
- failure_mode: guard SQL/binds 在 `for (attempt...)` 外按第一次 `plan.missing.length` 构造；UNIQUE 后 `mail-worker/src/service/mail-share-service.js:1353` 只替换 `plan`，不重建 guard。若抢注把缺失集合从 3 条缩成 2 条，重试仍使用三条时的更低阈值，第二条重试 INSERT 静默零变更。
- trigger: `accountCount=10`、Owner 原有 6 个 account、提交 `[A,B,C]`；并发同主先建 A，且 A 是本批第一条，首次 INSERT 在 `7 < 8` 下真正撞 UNIQUE；复读得到 `owned=7, missing=[B,C]`，预检允许最终 9 个，但重试仍绑定阈值 8，结果为 `[B 成功,C 零行]`。
- impact: UNIQUE 恢复路径在配额尚有两个名额时仍返回错误，并提交部分 account/share/binding；该路径违反“同主复用后整批重试”的明确恢复契约。
- required_fix: 每次 attempt 都须从当前 plan 重新生成集合级配额写契约；UNIQUE 复读改变 `missing/reused` 后，不得复用任何依赖旧 missingCount、旧角色限额或旧用户角色的 guard。
- verify: 本轮边界矩阵用 `owned=7, missing=2, boundMissing=3, limit=10` 实跑得到 `precheck=true, threshold=8, changes=[true,false]`。修复验收须在 D1 中注入“三地址首地址被同主抢注”，断言第二次 attempt 两个剩余地址均成功且最终只产生请求要求的完整集合。
- risk_spread: `account-quota-predicate-equivalence`；origin=`accountQuotaPredicateBinds`；hop1=`createFromEmails` 的 guard 装配与 `prepareAccountInsert`；已在复读后 missing 集合改变处命中 stop_when。

### persists: F-0008 · configuredDomains 与其余 env.domain 读取点仍为两套匹配语义

- severity: P2
- anchor: `mail-worker/src/service/mailbox-provision.js:52`
- symbols: `configuredDomains`, `userService.add`, `loginService`, `publicService`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:35-38` 要求 JSON 字符串/数组统一解析后精确匹配；历史台账 F-0008 保持 open。
- identity_scope: `DomainConfig/ExactConfiguredDomainSet`
- failure_mode: provision 入口使用解析后数组精确匹配；`mail-worker/src/service/user-service.js:309`、`login-service.js:64`、`public-service.js:107` 仍直接对原始 `c.env.domain` 调 `.includes`。
- trigger: `c.env.domain='["example.com"]'` 时，旧入口提交域名 `xample.co`。
- impact: 旧入口把 JSON 文本子串当成已配置域名，域名准入集合继续分叉。
- required_fix: 所有建 user/account 的域名读点消费同一个精确解析器；不得保留原始字符串 `.includes`。
- verify: 本轮逐一读到上述三个当前调用点；0f4f52c 未改这些调用点，F-0008 继续 open。
- risk_spread: none；本轮仅做历史 carryover 回归确认，不新增跨 diff 结论。

### persists: F-0009 · 前缀黑名单仍未经契约授权改为大小写不敏感

- severity: P2
- anchor: `mail-worker/src/service/mailbox-provision.js:102`
- symbols: `planMailboxProvision`, `emailPrefixFilter`
- rule_source: 迁移前设置页基线为大小写敏感 `getName(email).includes(content)`；决策卡只批准下沉共同不变量，未批准扩大前缀拒绝集；历史台账 F-0009 保持 open。
- identity_scope: `SettingsAdd/PrefixFilterRejectionSet`
- failure_mode: 当前实现同时 lowercase prefix 与 token，使仅大小写不同的前缀从允许变成拒绝。
- trigger: `emailPrefixFilter=['spam']`，设置页提交 `SPAMbox@example.com`。
- impact: 既有设置页拒绝一条基线允许的地址，且仓库没有 AC 固定该收严。
- required_fix: 恢复设置页既有大小写语义；若产品决定收严，先将新拒绝集写入契约并补两个入口的混合大小写矩阵。
- verify: 当前行仍含 `prefix.toLowerCase().includes(String(token).toLowerCase())`；0f4f52c 未触及该行，F-0009 继续 open。
- risk_spread: none。

### persists: F-0010 · mailbox-provision 仍经 user-service 回到 account-service

- severity: P2
- anchor: `mail-worker/src/service/mailbox-provision.js:6`
- symbols: `mailbox-provision`, `userService`, `accountService`, `mailShareService`
- rule_source: `mail-worker/src/service/mailbox-provision.js:14-15` 明文禁止反向依赖 account/mail-share；决策卡 `:96` 要求新模块位于二者下层；历史台账 F-0010 保持 open。
- identity_scope: `MailboxProvision/ServiceImportDAG`
- failure_mode: 当前静态图仍为 `mailbox-provision → user-service → account-service → mailbox-provision`；`account-service → mail-share-service → mailbox-provision` 也在同一强连通分量。
- trigger: Worker 冷启动评估该服务强连通分量。
- impact: 声明的无环下层边界未成立，模块顶层导出读取继续受循环求值顺序约束。
- required_fix: 把 provision 所需 user/role 读取下沉到不依赖 account/share 的叶子 repository/policy，或显式注入读取器；不得用 import 排序遮蔽环。
- verify: 本轮实读 `user-service.js:2`、`account-service.js:12-13` 与本锚点；0f4f52c 只增加既有 `mail-share-service → mailbox-provision` 边上的导入符号，没有切断 SCC，F-0010 继续 open。
- risk_spread: none；新增 export 未产生新图边，保留既有 finding。

## 已查证但不成 finding

- F-0002 不重开：`planMailboxProvision` 在 `mailbox-provision.js:147-149`、`resolveNonAdminAccountQuota` 在 `:225-228` 均对缺 role 拒绝；分享入口经 `mail-share-service.js:1147` 映射为 `SHARE_ACCOUNT_FORBIDDEN`，设置页经 `account-service.js:27` 映射为 `accountLimit` 403。
- `missingCount=1` 的两个边界成立：`owned=limit-1` 时谓词写入一行，`owned=limit` 时零行，与预检一致。
- admin 与 `accountCount<=0` 的 null 出口沿用迁移前语义：迁移前设置页同样只在 `roleRow.accountCount > 0` 时施加数量上限；不报新 finding。
- `planShareMailboxes` 与 `resolveNonAdminAccountQuota` 对 missing 请求确实重复读取 user/role；仓库没有该路径的往返数或延迟契约，本轮不把性能重复报为 finding。
- 新增三个 export 增加了 `mail-share-service` 对 provision 内部策略符号的耦合，但 import 图边在提交前已存在；此事实并入 F-0010，不另开同义 finding。

## verification

- 实跑：`pnpm exec vitest run test/mail-share-emails.spec.js test/transaction.spec.js`，退出码 0，2 files / 37 tests passed。现有 quota 用例只覆盖单缺失且已满时拒绝；批量用例使用默认上限 10 且远离边界；UNIQUE 用例只有一个缺失地址，所以未命中三条新 finding。
- 实跑：Node 22 `node:sqlite` 同形 SQL 边界矩阵，输出：
  `[{limit:3,owned:2,missing:1,changes:[true]},{limit:3,owned:3,missing:1,changes:[false]},{limit:3,owned:1,missing:2,changes:[true,false]},{limit:10,owned:7,missing:2,boundMissing:3,changes:[true,false]}]`。
- `account-quota-predicate-equivalence`：已取得三个指定边界及批量/重试分歧，停止扩散。
- `missing-role-fail-closed-blast-radius`：已确认分享与设置页两条入口对外拒绝形态，停止扩散。
- 未改业务代码。
