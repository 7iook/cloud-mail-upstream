# Recon · W0/T-01 可执行修改范围与 T-02/T-03/T-04 拆分建议

> Mode R(reality recon)。侦察产物,不含业务代码。
> 分支 `cursor/mailbox-share-capability-dcb6` · 基线 commit `e120a04` · 侦察时刻工作树见 §2 A8(已发生漂移)。
> 权威口径:`docs/specs/mailbox-share-capability/{tasks.md,design.md}`(converged,不改宪章)。本报告只做「文档 vs 代码」对账与拆分,任何需要改契约的地方一律进 §7 上报,不自行裁决。

---

## 0. 侦察当时的可复现证据

| 证据 | 命令 / 锚点 | 结果 |
|---|---|---|
| worker 基线 | `pnpm --dir mail-worker test`(06:14,`v3-2-db.spec.js` 尚未参与统计) | `Test Files 16 passed (16) / Tests 138 passed (138)` |
| vue 基线 | `pnpm --dir mail-vue test`(06:16) | `Test Files 17 passed (17) / Tests 95 passed (95)` |
| E2E 基线 | 未跑 | `unverified`(需 `node tests/e2e/run.mjs`,本次侦察未执行) |
| T-01 红灯 | `npx vitest run test/v3-2-db.spec.js` | `Test Files 1 failed (1) / Tests 12 failed (12)`,失败因 `TypeError: dbInit.v3_2DB is not a function` |
| 工作树 | `git status --short` | ` M docs/.../tasks.md` · `?? .agent-workspace/.../session-ledger.md` · `?? mail-worker/test/v3-2-db.spec.js` |

---

## 1. 计划假设清单(可能被现实推翻的点)

从 tasks.md:34-57(T-01..T-04)、design.md:138-231(Data Models + 迁移/发布协议)与派发交底中提取:

- A1 `init.js` 注册链止于 `v3_1DB`,无 `v3_2DB`。
- A2 `entity/mail-share.js` 有 17 列,无 binding 实体。
- A3 `test/v3-1-db.spec.js` 是迁移测试可照抄的范式。
- A4 `test/setup.js` 已打 `/api/init`,T-01 注册后每个 worker spec 都会跑到 v3_2DB。
- A5 `isDel.NORMAL = 0`。
- A6 `SHARE_CAPABILITY_V2` 在 `wrangler.toml` / `wrangler-vitest.toml` 均不存在。
- A7 冲突 owner:`init.js` 仅 T-01;`mail-share-service.js` 留给 T-02/T-03。
- A8(交底未含)T-01 尚未开工,HEAD 无任何实现。

---

## 2. 现实核实(plan vs reality)

| # | 判定 | 证据锚点 | 说明 |
|---|---|---|---|
| A1 | **match** | `mail-worker/src/init/init.js:31-32`(`v3_0DB` → `v3_1DB` 后即 `settingService.refresh`,init.js:33) | 追加点确为 init.js:32 之后、:33 之前 |
| A2 | **deviation** | `mail-worker/src/entity/mail-share.js:5-20` 实为 **16 列**;DDL `init.js:39-56` 同为 16 列 | 交底的「17 列」多算一列。T-01.3 加 11 列后应为 **27 列**;`test/mail-share.schema.spec.js:20-37 / 41-58` 用 `toEqual` 钉死全量列表,加列即红 → 该 spec 是 T-01 的**强制同批修改项**,不是可选项 |
| A3 | **match(且比交底更有用)** | `test/v3-1-db.spec.js:5-18`(`tableNames`/`indexExists` 局部助手)、`:58 / :72 / :94`(`await dbInit.v3_1DB({ env })` 直呼迁移方法) | 「测试直接调用迁移方法」这一既有先例,正是 §5 交错时序注入的落点 |
| A4 | **match** | `test/setup.js:12` `SELF.fetch('/api/init/<secret>')`;`vitest.config.js:16-20` `setupFiles: ['./test/setup.js']` + `singleWorker: true` | setupFiles 每个 spec 文件执行一次 → T-01 落地后 v3_2DB 每轮跑 16(→17)次;实测 `setup 14.03s` 会小幅上升 |
| A5 | **match** | `mail-worker/src/const/entity-const.js:147-150` | `isDel = { DELETE: 1, NORMAL: 0 }` |
| A6 | **match,且比交底更严重** | `mail-worker/wrangler.toml:51-57` `[vars]` 段**全是注释、零真实变量**;所有 `SHARE_*` 只存在于 `wrangler-vitest.toml:34-39` 与 `tests/e2e/wrangler-e2e.toml` | 生产 `SHARE_*` 走 dashboard/secret,不走 `wrangler.toml`。T-03.2「在 wrangler.toml 声明 SHARE_CAPABILITY_V2」会成为该文件第一条真实变量,且与 `keep_vars = true`(wrangler.toml:4)+ 发布激活协议(design.md:220)相互作用 → 见 §7 R5 |
| A7 | **match,但漏了 spec 文件层的冲突** | tasks.md:20-26 冲突表只列**源文件**;实际 T-02.1 与 T-03.1 都写 `test/mail-share-service.spec.js`(tasks.md:43,49),T-01.3 与 T-02.1 都写 `test/mail-share.schema.spec.js`(tasks.md:39,43) | 测试文件同样是单 owner 热区 → 见 §9 |
| A8 | **deviation:工作树已前移** | 未跟踪文件 `mail-worker/test/v3-2-db.spec.js`(367 行 / 12 用例),实测 12/12 红,报错 `dbInit.v3_2DB is not a function` | **T-01.1(红)事实上已交付**。该 spec 已经把实现契约钉死(方法名、日志形状),后续实现必须对齐而不是另起炉灶 → 见 §5 |

### A8 展开:已落盘红灯 spec 钉死的三条实现契约

1. **迁移方法必须拆成可单独调用的三步**:`v3-2-db.spec.js:279,291,302,313,322` 调 `dbInit.backfillShareBindings(c)`,`:280,294,314,323` 调 `dbInit.revokeInvalidShares(c)`。名字不对就红。
2. **`share.migrate.invalid_row` 必须以「`console.log` 第一参数 = 可 `JSON.parse` 的字符串」发出**,且含 `event` 与 `shareId` 字段(`v3-2-db.spec.js:79-90`、断言 `:216-218`)。
3. **DDL 断言精确到 `pragma_table_info` 的 `notnull` / `dflt_value`**(`v3-2-db.spec.js:97-150`),并断言 `share_type` 列不存在、`mail_share_auth_fail` 表不存在。

---

## 3. T-01 可写 / 禁写文件清单

**可写(且都必须写,少一个就红或漏 AC)**

| 文件 | 动作 | 依据 |
|---|---|---|
| `mail-worker/src/init/init.js` | 注册链 `:32` 后加 `await this.v3_2DB(c);`;新增 `v3_2DB` + 两个可单独调用的子步骤方法 | tasks.md:37;冲突表 tasks.md:22 单 owner |
| `mail-worker/src/entity/mail-share.js` | `mailShare` 加 11 列映射(16 → 27) | tasks.md:39;design.md:148-158 |
| `mail-worker/src/entity/mail-share-binding.js` | 新建 drizzle 实体,照 `mail-share.js:4-21` 形状 | tasks.md:39;design.md:166-172 |
| `mail-worker/test/mail-share.schema.spec.js` | **必须**扩 `columnMap`/`notNullMap` 的 `toEqual`,并新增 binding 表一致性断言 | 该文件 `:20-37`、`:41-58` 是全量等值断言,不改必红 |
| `mail-worker/test/v3-2-db.spec.js` | 已存在;仅在补 §5 缺口时增改 | tasks.md:35 |

**禁写(T-01 只读)**

- `mail-worker/src/service/mail-share-service.js`(T-02/T-03 owner)、`share-auth-service.js`(W1 owner)、`share-scoped-email-repository.js`、`share-mail-service.js`、`share-attachment-service.js`、`mail-share-cleanup-service.js`、`account-service.js`
- `mail-worker/src/security/security.js`(T-14/T-17 owner)、`mail-worker/src/api/**`
- `mail-worker/test/setup.js`(**T-04 owner**)、以及除上表两个之外的任何 `mail-worker/test/*.spec.js`
- `mail-worker/wrangler.toml` / `wrangler-vitest.toml`(**T-01 完全不需要动**:新列全部带 DDL 默认值,不读任何新环境变量)
- `mail-vue/**`、`tests/e2e/**`、`docs/specs/**`(tasks.md 的勾选与 Update Log 由主 AI 落)

**边界补充**:`init.js` 现有 import 仅 `setting-service` / `email-utils` / `entity-const`(init.js:1-3)。**不要**为了复用 `applyRevoke` 而 import service 层(层级倒置)——见 §6。

---

## 4. v3_2DB 测试如何预置 v3_1 形状旧行(setup.js 已建好 schema 的前提下)

**根本约束**:`test/setup.js:12` 在任何用例体之前跑完整条迁移链,T-01 落地后 **v3_2DB 已经执行过**。因此测试里拿不到「ALTER 之前」的物理表,只能构造**语义等价**的旧行。

**等价性论证(可直接写进 spec 注释)**:`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT x` 会把存量行填成 `x`;可空新列(`max_sessions` / `message_limit` / `auth_key_hash` / `auth_key_kid`)对存量行为 `NULL`。而「只写 16 个 v3_1 列的 INSERT」得到的行,新列取值与上述完全一致。故 **只 INSERT v3_1 列 == 一条真实的迁移前遗留行**。现有红灯 spec 已按此实现(`v3-2-db.spec.js:41-51`)。

**四条必须遵守的预置规则**

1. **唯一化标识 + 局部 seed**:高位 id 递增(`v3-2-db.spec.js:8-12` `930000+`)、`lid-v32-` 前缀(对齐既有 `t09-` / `t24-` 约定,见 `mail-share-service.spec.js:83-93` 的 cleanup)。账号 seed 用文件内局部助手(`v3-2-db.spec.js:26-38`),**不要**现在往 `setup.js` 加工厂(那是 T-04.1 的写权)。
2. **禁止对 `mail_share` 做全表计数断言**:回填 UPDATE 无 user 维度过滤(design.md:202-210),它会撤销**全表**任何 account 事实不成立的 ACTIVE 行。断言一律按 `share_id` / `lid` 定位。唯一允许的全表断言是「零非法 Binding」这种恒真不变量(`v3-2-db.spec.js:66-77`)。
3. **依赖 per-test 存储隔离,而不是依赖清理**:`vitest.config.js:5-9` 保留了默认 `isolatedStorage`(只显式设了 `singleWorker`),每个 `it` 的写入在用例结束后回滚,起点恒为「setup 完成态」。因此不要在用例间传递 seed 状态,也不需要 `afterEach` 删表。
4. **绝对不要用 DROP COLUMN 模拟迁移前状态**:违反 expand-only(design.md:144-145),而且会污染同文件后续用例共享的 schema。

**回归影响评估(给 T-01.2 的实测项)**:v3_2DB 的撤销 UPDATE 在每次 `/api/init` 时对全表生效,但 setup 早于所有 seed,init 时刻表内无 ACTIVE 行,故既有 138 用例预期不受影响;`share-integration.spec.js:236-255` 的明文扫表会自动把新表新列纳入扫描范围(是增益不是风险)。**该结论须由 T-01.2 的全量绿灯实测确认,不得只靠推理勾 `[x]`**。

---

## 5. 四种交错时序怎么测,又不制造第二份 SQL 真源

### 5.1 只有一种时序需要「接缝」

| 时序 | 是否需要接缝 | 做法 | 期望 |
|---|---|---|---|
| 旧写落在 INSERT **之前** | 否 | 先 seed 再跑迁移 | 合法行拿到 1 条 Binding;脏行 REVOKED |
| 旧写落在 INSERT 与 UPDATE **之间** | **是** | 见 5.2 | 合法「零 Binding」行**保持 ACTIVE**(R3-A2 核心),重跑 INSERT 被收编 |
| 旧写落在 UPDATE **之后** | 否 | 跑完整迁移 → seed → 断言未被动 → 再跑一遍收编 | 同上 |
| **任务重启后**的旧写 | 否 | `v3_2DB` 连调两次 | 幂等:Binding 不重复、`revoked_at` 稳定、`access_count` 原值 |

因为撤销谓词只看 account 事实(design.md:200-210),「INSERT 之前」和「INSERT 之后」的合法行都能被平凡地观察到;**唯独中间态**才能证明「无 Binding ≠ 脏行」这条 R3-A2 承诺。所以接缝只为这一条存在。

### 5.2 推荐做法:把 v3_2DB 拆成 orchestrator + 具名子步骤(init.js 内)

```
v3_2DB(c)  →  this.<ddl 步>(c)
           →  this.backfillShareBindings(c)     // design.md:190-198 那条 INSERT,原文一次
           →  this.revokeInvalidShares(c)       // design.md:202-210 那条 UPDATE,原文一次
```

- **SQL 仍只有一份**,住在 init.js;测试只调方法、只断言状态,不复述 SQL。
- **是既有仓库范式,不是发明**:`v1_2DB` 就是这么调子步骤的(`init.js:451-452` → 定义在 `:705` / `:730`);测试直呼迁移方法的先例在 `v3-1-db.spec.js:58`。
- **不构成对裁决 SQL 的偏离**:语句文本、谓词、执行顺序、幂等性全不变,注册链依旧只挂 `v3_2DB`。tasks.md:240 的门禁针对的是「两条幂等 SQL 的内容」,拆函数不触发它 —— 执行者**不需要**为此停下上报。
- **方法名已被红灯 spec 钉死**:必须是 `backfillShareBindings` / `revokeInvalidShares`(§2 A8)。

**备选(不推荐)**:传一个包了 `c.env.db.prepare` 的假 `c`,按语句序号或 SQL 子串在中间插入旧写。不改 init.js,但把测试耦合到语句顺序/文本和 D1 API 表面,脆。仅在拆函数被否决时启用。

**明确禁止**:把两条 SQL 抄进 spec 自己按序执行 —— 那就是第二份 SSOT,迁移改了测试还绿,正是要防的失效模式。

### 5.3 实现侧的两个附带结论

- **撤销语句需要 `RETURNING share_id, account_id, user_id`** 才能逐行打 `share.migrate.invalid_row`(design.md:201 要求该日志,而 :202-210 的 SQL 块没写 RETURNING)。谓词与效果不变,判定为**非偏离**;D1 里 UPDATE ... RETURNING 已有先例(`mail-share-service.js:134-139`)。此处记录备查。
- **日志常量归属**:仓库现无任何结构化 JSON 日志(grep `console.*JSON.stringify` 零命中;现行风格是 `console.error('msg', {fields})`,见 `mail-share-service.js:48`、`share-auth-service.js:262`)。而事件名常量按 tasks.md:51 归 T-03(落在 service 层)。**T-01 在 init.js 内联字面量字符串**,不要 import service 层常量,后续也不回填 —— 否则 init.js 单 owner 铁律被打破。

---

## 6. 重复实现与可复用件

**可直接复用(内部)**

| 能力 | 复用源 | 用法 |
|---|---|---|
| 迁移测试直呼方法 | `v3-1-db.spec.js:58/:72/:94` | §5.2 接缝驱动 |
| 幂等 DDL 模式 | `init.js:72-88`(索引 try/catch)、`:90-120`(`INSERT ... WHERE NOT EXISTS`) | 11 条 ALTER 逐条 try/catch,与 design.md:143 一致 |
| drizzle 实体模板 | `entity/mail-share.js:4-21` | 新 binding 实体照抄;**无注册表要改**(`entity/orm.js:1-5` 只是 drizzle 工厂,实体各自 import) |
| 环境开关解析惯例 | `mail-share-service.js:19-31` / `share-auth-service.js:35-47` | T-03 的 `assertCapabilityV2` 照此形状(字符串 `'0'/'false'` 容错) |
| per-binding 窗口快照 idiom | `mail-share-service.js:195` `(SELECT COALESCE(MAX(email_id),0) FROM email WHERE account_id = ?)` | T-12/T-13 复用,非 T-01 |

**已存在的重复,现在**不**去合并**

- `tableNames`/`indexExists`(`v3-1-db.spec.js:5-18`)与 `objectExists`/`columnInfo`(`v3-2-db.spec.js:14-24`)近似重复。仓库 `test/` 无共享 helper 模块,spec 自包含是既有约定;新建 `test/helpers/` 会与 T-04 的 `setup.js` 工厂抢地盘。**保留局部副本**。
- 账号 seed 已有四份:`mail-share-service.spec.js:58`(`ensureAccount`)、`share-integration.spec.js:157`、`share-api.spec.js:91`、`v3-2-db.spec.js:26`。**合并权交给 T-04.1**(setup.js 工厂),T-01 不动。
- `applyRevoke`(`mail-share-service.js:133-140`)与迁移撤销 UPDATE 效果同构。**不要复用**:init.js 是零 service 依赖的迁移层(init.js:1-3),import service 会造成层级倒置。属于可接受的重复。

**外部开源**:未做外部检索,理由是本任务是既有手写迁移链上追加一节 expand-only DDL,引入 drizzle-kit / 迁移框架属于宪章已否决的架构变更(design.md:31 就地演进裁决),检索不会改变执行路径。如需外部证据请显式指派。

---

## 7. 架构/前提挑战 + 业务现实核验

**架构挑战:无。** T-01 是在一条已有 19 节(`init.js:14-32`)的迁移链尾追加 expand-only 一节,零 RENAME 零 DROP,方案经 R1–R3 三轮评审收敛。不存在「在错误架构上继续贴砖」的情形。

**业务现实核验(§0.17,针对 T-01 的新建物)**

| 新建物 | 真实场景 | 缺失影响 | 既有覆盖 | 分类 |
|---|---|---|---|---|
| `mail_share_binding` 表 | Owner 要把多个邮箱放进同一条分享链接给访客 | 无表则多邮箱能力整体不成立 | 无(主表 `account_id` 单值,`init.js:45`) | **A 业务关键** |
| `max_sessions` / `message_limit` / `only_messages_after_created` | 配额与可见窗口收敛 | 链接被无限转发/历史邮件全泄 | 无 | **A/B** |
| `auth_key_*` / `credentials_version` | 第二因子与凭据失效 | 泄链无法止血 | 无 | **A** |
| `otp_extraction_enabled` / `show_full_address` | 访客页展示策略 | 展示不可控 | 无 | **C 商业** |
| `auto_refresh` / `refresh_interval_ms` | 访客页轮询节流 | 与全局 `setting.auto_refresh` 语义邻近但作用域不同(分享级 vs 站点级) | `setting.auto_refresh` 仅站点级 | **C**,不阻塞 |

**零 D 类**,无「技术整齐度驱动」的新建。T-01 全量放行。

### 需要停下上报的风险(不自行改契约)

| # | 级别 | 风险 | 证据 | 需要的裁决 |
|---|---|---|---|---|
| **R1** | **P0** | T-02.1 的 grep 断言「鉴权/范围代码零读取 `mail_share.account_id`」在 W0 **不可能变绿**:`share-auth-service.js:223`(`row.accountId > 0`)、`:257`、`:287`、`:290` 今天就在读该列,而消除这些读取是 T-08 的 ShareContext 集合化 | tasks.md:43 vs share-auth-service.js:222-294 | 二选一:① 断言收窄为「不新增读取 + 允许清单固定这 4 处,直至 T-08」;② 整条断言移交 T-08。**执行者不得顺手改 share-auth-service**(W1 单 owner) |
| **R2** | P1 | T-03.1 字面要求「四路策略写入一律 `SHARE_INVALID_CONFIG`」,但四条写入路径在 W0 尚不存在(create 多邮箱=T-12、bindings=T-13、AuthKey=T-16、maxSessions=T-15) | tasks.md:49 vs :51 自述「实际接线在 T-12/T-13/T-15/T-16」 | 确认可执行读法 =「按 intent 单测门控助手 + 记录待接线清单」。tasks.md 自身已埋伏笔,判定为**读法澄清而非契约变更** |
| **R3** | P1 | 回填 INSERT 无 `ms.status = 'ACTIVE'` 过滤 → 一条已 REVOKED 但 `account_id` 仍合法的分享,会在任何一次 init 重跑时被塞进一条 Binding(design.md:190-198) | design.md:190-198;读路径全部先过 ACTIVE 闸门(`share-auth-service.js:222-226`)故**当前无越权** | **T-01 保持 SQL 原样不加过滤**(加了就是偏离裁决 SQL,触发 tasks.md:240 门禁)。是否加 `status` 过滤 / 是否由 T-18 cleanup 补偿清除,请用户裁决 |
| **R4** | P2 | 撤销语句加 `RETURNING` 以支撑逐行日志 | design.md:201 要日志 vs :202-210 SQL 无 RETURNING | 已判定非偏离(§5.3),仅备案 |
| **R5** | P1 | T-03.2 要在 `wrangler.toml` 声明 `SHARE_CAPABILITY_V2`,但该文件 `[vars]`(:51-57)历来全注释,所有 `SHARE_*` 走 dashboard;`keep_vars = true`(:4)只保护 dashboard 变量不被删,**toml 里写死的变量每次 deploy 仍会覆盖同名值** → 一旦按 design.md:220 在 dashboard 把 V2 打开,下次 deploy 会被 toml 的 `"false"` 打回去 | wrangler.toml:4,51-57;wrangler-vitest.toml:34-39 | 请用户在「toml 声明(注释形式,与既有 `SHARE_*` 一致)」与「toml 硬声明 false」之间裁决;这直接影响 V2 激活协议的可操作性 |
| **R6** | P2 | 基线数字漂移:T-04.1 记录的 worker 基线 16 文件/138(tasks.md:55)在 T-01 落地后为 **17 文件/150**(新增 12 用例) | 实测 §0 | 非契约变更,但 T-04 台账须按新数记「只增不减」 |
| **R7** | P2 | 交底称实体 17 列,实为 16 列 | entity/mail-share.js:5-20 | 仅口径修正:目标列数 27 |

---

## 8. 链路完整性扫描(T-01 切片)+ 领域模型对账

### 8.1 端到端链路(节点 | 生产者 | 消费者 | 状态)

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| `/api/init/<secret>` | `src/api/init-api.js:4-5` | `src/init/init.js:6` | ✅ 完整 |
| 迁移注册 | `init.js:32` 之后 → to-build | `init.js:6-35` 链 | ⛔ 断:`v3_2DB` 未注册 |
| 11 列 ALTER | to-build(`v3_2DB` ddl 步) | `entity/mail-share.js:5-20`(to-extend);`share-auth-service.js:250,282` 的 `select()` 展开列 | ⛔ 断:实体未加列 |
| `mail_share_binding` 表 | to-build | T-01 内无运行时消费者(消费者是 T-10 集合化查询 / T-12 create / T-18 级联) | ✅ 本波次预期无消费者,已确认不是「建了没接」 |
| 回填 Binding 行 | to-build `backfillShareBindings` | `v3-2-db.spec.js:59-64` 断言;运行时消费在 W2 | ✅ |
| `REVOKED` 置位 | to-build `revokeInvalidShares` | `share-auth-service.js:222-226` ACTIVE 闸门 | ✅ |
| `share.migrate.invalid_row` 日志 | to-build(init.js 内联字面量) | `v3-2-db.spec.js:79-90,216-218`;生产侧告警消费者是 design.md:220 的部署前置 | ✅(告警接入属部署动作,不在 T-01) |
| schema-实体一致性 | to-extend `test/mail-share.schema.spec.js:20-58` | CI | ⛔ 断:不改必红 |

### 8.2 成功态出处(下游前置条件,原文可查)

- `assertShareActive` 要求 `row.accountId > 0`(`share-auth-service.js:222-226`)—— 这就是 design.md:219「双写禁止写 0」在代码里的**既有强制点**,T-02 不必新造判据。
- 读路径范围条件消费的是内存态 `ShareContext.accountId`(`share-scoped-email-repository.js:60-68`),不是主表列 —— 故 R1 的 grep 断言实际只指向 `share-auth-service.js` 一个文件。

### 8.3 领域模型对账

仓库无 `docs/domain/`;本子系统的模型 SSOT 是 `design.md:138-231`(Data Models + 迁移/发布协议),已 converged。逐项对账结果:T-01 的 11 列 / binding 表 / 两条 SQL 与 design.md:143-211 **[match]**,零 model-change。**建议不要另建 `docs/domain/mail-share-model.md`** —— 会与 design.md 形成第二份模型真源,正是本 charter 一路在消灭的东西。若主 AI 仍需独立模型文档,应在 W6 收口时由 design.md 派生,而非现在并行维护。

---

## 9. T-01 之后 T-02 / T-03 / T-04 的拆分建议

### 9.1 文件归属

| 任务 | 写:源码 | 写:测试 | 写:配置 | 只读依赖 |
|---|---|---|---|---|
| T-02 双写契约 | `src/service/mail-share-service.js`(`syncPrimaryAccountId`) | `test/mail-share.schema.spec.js`、`test/mail-share-service.spec.js` | — | `share-auth-service.js`、`share-scoped-email-repository.js`(grep 断言对象) |
| T-03 V2 栅栏 | `src/service/mail-share-service.js`(`assertCapabilityV2` + `SHARE_BINDING_LIMIT` + 事件名常量) | `test/mail-share-service.spec.js` | `wrangler.toml`(见 R5);`wrangler-vitest.toml` 非必需(spec 用 `ctx({...})` 覆盖 env,见 `mail-share-service.spec.js:16-32`) | — |
| T-04 测试基建 | — | `test/setup.js` | — | 全量三套 |

### 9.2 冲突判定

- **T-02 ∩ T-03 = 双重冲突**:同写 `src/service/mail-share-service.js` **且**同写 `test/mail-share-service.spec.js`。**必须串行 T-02 → T-03,同一执行者**,不可并行、不建 worktree(worktree 解决不了同文件冲突,只会把冲突推迟到合并)。
- **T-04.1 文件不相交**(只碰 `test/setup.js`),理论可并行。但两个执行者在**同一工作树**并行时,任一方跑 `pnpm test` 会读到对方半成品文件 —— vitest 的 cacheDir 已按 pid 隔离(`vitest.config.js:8`),进程不打架,**但源文件会串味**。
- **T-04.2 是全量三套回归**,必须排在最后,无并行空间。

### 9.3 建议(默认方案:不并行)

| 顺序 | 工作包 | 目标 | 依赖 | 可并行 | worktree | 建议 AI 数 |
|---|---|---|---|---|---|---|
| 1 | T-02 | `syncPrimaryAccountId` 助手 + 双写不变量断言(R1 收窄后) | T-01 落盘 | 否 | 否 | 1 |
| 2 | T-03 | `assertCapabilityV2(c, intent)` + 常量 + 事件名 | T-02(同文件) | 否 | 否 | 同一枚 |
| 3 | T-04.1 | setup.js seed 工厂(**不建表**) | T-01 | 与 1–2 理论可并行 | 并行才需要 | 同一枚 |
| 4 | T-04.2 | 三套全量绿 + 新基线 17/150、17/95、E2E 13 | 1–3 | 否 | 否 | 同一枚 |

**结论:W0 剩余部分派 1 枚执行者串行跑完,并行收益为负。** 三个包合计改动面 = 1 个源文件 + 3 个测试文件,而 T-02/T-03 强耦合于同一文件、T-04.2 天然收口;拆两枚只换来一次合并冲突和一次基线重跑。若主 AI 仍要并行,唯一安全切法是「T-04.1 单独 worktree」,且 T-04.1 必须在 T-03 合并后重跑一次全量。

**两条硬约束交给 T-04 执行者**

1. `test/setup.js` **不得**创建 `mail_share_binding` 表 —— DDL 由 `init.js` 独占(tasks.md:22),setup.js 建表就是第二份 SSOT,会掩盖「迁移没注册」这类真故障。tasks.md:55 的「binding 表建表」措辞在 T-01 落地后应读作「仅 seed 工厂」。
2. `setup.js` 里 `/api/init` 必须保持为**第一个也是唯一的 schema 动作**;新增内容只能是**函数工厂**,不能是模块级立即执行的 INSERT(否则会踩到 §4 规则 2 的全表撤销语义)。

---

## Update Log

- 2026-08-24 · plan-reality-recon(Mode R):首次落盘。核实 8 条计划假设 → 5 match / 3 deviation(实体 16 列非 17、wrangler.toml 零真实变量、工作树已出现红灯 `v3-2-db.spec.js`)。实测基线 worker 16/138 绿、vue 17/95 绿、T-01 红灯 12/12。交错时序方案:init.js 内 orchestrator + `backfillShareBindings`/`revokeInvalidShares` 具名子步骤(既有 `v1_2DB` 范式,非偏离裁决 SQL),单一 SQL 真源。拆分结论:W0 剩余 T-02→T-03→T-04 单执行者串行,并行收益为负。7 条风险中 R1(T-02 grep 断言在 W0 不可能变绿)、R3(回填不过滤 status)、R5(wrangler.toml 声明会覆盖 dashboard 的 V2 开关)需用户/主 AI 裁决,本报告不自行改契约。E2E 基线 `unverified`。
