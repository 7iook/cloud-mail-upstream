# 跨切面侦察 · mailbox-share-capability(Mode R)

- 日期:2026-08-24 · 仓库:/workspace(detached @ 7d7fdf1 之上的 130043b)
- 任务:核实权限 / 账号-邮箱模型 / 邮件查询 / OTP / 限流 / 公开 API / 迁移 / 测试基线的真实状态,并对照既有 mail-share charter 评估「多邮箱分享」新需求的缺口与拆分前提。
- 结论先行:**mail-share 不只是规格——已完整实现、已提交、三套测试全绿**(worker 16 文件/138、vue 17 文件/95、E2E Chromium 13/13,均为本次亲跑)。新需求中 9 项里 1 项已覆盖、4 项部分可复用、4 项零覆盖且多项曾被用户裁决明确排除。建议**新开 superseding slug `mailbox-share-capability`**,不要原地改写已收敛的 mail-share charter。

---

## 0. 计划假设 vs 现实(最重要的偏差)

| 假设(派发语境) | 现实 | 证据 |
|---|---|---|
| mail-share 是「docs/specs 下的一份规格」 | **已实现并合入历史**:后端 7544d97、前端 0151e40、规格/E2E 9c78703、评审修复 ddbedbb、7d7fdf1 | `git log`;`mail-worker/src/api/share-api.js` 等 7 个 share 文件存在 |
| 测试基线状态未知 | **三套全部可跑且全绿**(比 tracker 记录的基线还多:E2E 13 vs 记录 10,四项 review finding 已在 ddbedbb 修复) | 本次亲跑,命令见 §7 |
| 「only_messages_after_created 可能已有」 | ✅ 已有,即 `window_start_email_id`,创建时单语句快照 | `mail-share-service.js:195` |
| share:manage 可能不存在 | ✅ 已存在:premKey 注册 + 精确路径门控 + v3_1DB 种子 | `security.js:103`、`init.js:90-120` |
| 功能开关走 setting 表 | ⚠️ `isShareDisabled` 读 `setting.share`,但 **entity/setting.js 无 share 列** —— DB 开关是死分支,实际只有环境变量 `SHARE_ENABLED` 生效 | `share-auth-service.js:35-47` vs `entity/setting.js`(grep 无 share) |

---

## 1. 账号归属模型锚点

- **User 1:N Account,`account.user_id` 是唯一归属真源**:`entity/account.js:10`(userId notNull)、`:13`(isDel 软删)。无 tenant、无一账号多用户。
- 创建即绑定:`account-service.js:92` `insert({email, userId, ...})`;数量上限走角色 `roleRow.accountCount`(`account-service.js:66-68`)。
- 列表恒定 `user_id + is_del=NORMAL` 过滤:`account-service.js:129-130`。
- 软删 `:161`、硬删 `:182-187`;**删除路径已挂 share 撤销钩子**:`mailShareService.revokeByAccountId(s)`(`mail-share-service.js:394-415`,T-13 已接线,测试 `account-delete-share.spec.js`)。
- 对新需求的含义:**多邮箱聚合分享的归属断言 = 全部 accountId 的 `user_id` 等于创建者**,现成模板是 `loadOwnedAccount`(`mail-share-service.js:104-110`),改成 IN 批量校验即可;撤销钩子须从「单 account」扩展为「命中聚合中任一 account 时的语义」(全撤 or 剔除该邮箱——雾区,见 §10)。

## 2. 权限注册方法 + 既有分享权限

注册一个新 perm 的完整链(已被 share:manage 走通一遍,照抄即可):
1. **中间件注册**:`security.js:71-75` `requirePermsExact`(method+path 精确)+ `:77-104` `premKey` 映射(`'share:manage': ['/mailShare/create','/mailShare/list','/mailShare/revoke']`)。精确匹配分支在 `:145-166`,缺权限抛 `SHARE_FORBIDDEN` 403;admin 邮箱豁免(`:163`)。
2. **DB 种子**:`init.js:90-120`(v3_1DB 内):固定 perm_id=37 优先 INSERT → 兜底自增 INSERT → `role_perm(role_id=1)` 绑默认角色,三段独立 try/catch,幂等。**后建自定义角色不会自动继承**(需管理员分配)。
3. 权限读取:`perm-service.userPermKeys` → `permKeyToPaths`(`security.js:194-205`)。
- 新需求若加 owner 端点(如 `/mailShare/presets`),沿用 `share:manage` 或新增 `share:admin`(管理员预设)均是 1 行 premKey + 1 段 v3_2DB 种子的事。

## 3. 可复用的邮件查询原语

- **登录态**:`email-service.list`(`:28-134`,含 latestEmail)与 `email-service.latest`(`:703-731`):`gt(email.emailId, cursor)` 增量游标 + `userId + accountId + isDel=NORMAL + account.isDel=NORMAL + type=RECEIVE`,`allReceive` 时跨全部邮箱——**这就是"多邮箱聚合列表"的既有先例形状**(单用户全邮箱聚合已存在于登录态)。
- **分享态(不可绕过的范围仓库)**:`share-scoped-email-repository.js:60-68` `visibleWindowConditions`:`account_id = ctx.accountId AND account_id > 0 AND email_id > windowStart AND is_del=NORMAL AND status != SAVING`;list 默认 20/上限 50、`email_id ASC`(`:72-92`)。**多邮箱聚合的最小改法 = ctx.accountId 单值 → 集合(inArray)+ 每邮箱各自 windowStart**;注意排序聚合后仍按 `email_id` 全局升序天然成立(AUTOINCREMENT 全局唯一)。
- **投影层**:`share-mail-service.project`(`:46-63`)白名单 DTO(mailId/sender/subject/text/content/receivedAt/code/attachments);聚合场景需**新增 mailbox 标识字段**(当前 DTO 不含收件邮箱)——这是投影白名单变更,有 property 测试 P-PROJ-01 盯着键集合,改时须同步。
- 已知陷阱(design 已记录):`email.is_del` 双语义(用户删除 + 收件未完成)、`account_id=0` 脏行、`selectById` 无 owner 条件(分享链禁用)。

## 4. OTP 链路锚点 + 失败行为

- **写入时机唯一**:收件时 `email/email.js:95` 调 `aiService.extractCode`,`:103` 同批 INSERT 进 `email.code`;**无 UPDATE 路径,失败永久为空串 `''`(非 null)**。
- **门控**:`ai-service.js:54-69` `shouldExtractCode`:全局设置 `aiCode=OPEN` 且(`aiCodeFilter` 为空 或 发件人邮箱/域命中白名单)。**配了白名单则名单外邮件 code 恒空**(运营陷阱,design 已标)。
- **提取**:`ai-service.js:5-52` 单次 LLM(`@cf/meta/llama-3.1-8b-instruct` 默认),JSON `{code}`,>8 字符或含空白即弃,异常 catch 返 `''`。
- 分享链**只读** `email.code`(P-OTP-03,投影 `share-mail-service.js:60`),不重新推断。
- **对新需求 `otp_extraction_enabled` 的硬约束**:提取发生在**摄取时且受全局设置控制**——per-share 开关只能控制「展示与否」(投影层裁剪 code 字段,改动极小);若用户预期「分享强制开启提取」,那是摄取链改造且**对已收邮件不可追溯**。必须在规格里二选一(见雾区 §10)。

## 5. 限流 / verify-record 底座(auth_key 暴破防护评估)

- **可复用**:`security/share-rate-limit.js` —— Cloudflare Workers Rate Limiting binding(`wrangler.toml:12,17` 两个 `[[ratelimits]]`),key 仅 `CF-Connecting-IP`,429+Retry-After 以 Response 直接返回(绕开 onError 改写 200),binding 缺失时 fail-open。已挂在匿名 `/share/*`。**auth_key 校验端点直接套同一中间件**。
- **不可复用**:`verify-record-service.js:54-86` 先读后写非原子、`clearRecord` 删整表、`req-utils.js:3-7` XFF 不拆逗号——design 已明确禁用为限流底座。
- **既有设计裁决(R1-A6)**:禁止按公开 `lid` 锁失败次数(第三方可 DoS 真实访客)。若新需求 auth_key 是**人可传达的低熵密钥**,暴破面实质变大,仅 IP 边缘限速(每 PoP 最终一致)不构成硬保证——需要新的失败计数设计(如 per-share 原子条件 UPDATE 失败计数,D1 单语句原子已被 T-02 验证可行),这是**推翻既有裁决的变更**,须用户拍板。
- 另一现成原子先例:`access_count` 原子自增(`share-auth-service.js:236-241` `sql\`count+1\``);max_sessions 若定义为「建立会话次数封顶」,单条**条件 UPDATE/INSERT** 即原子(同 `mail-share-service.js:197-200` 活跃上限的 `WHERE (SELECT COUNT ...) < limit` 模式)。

## 6. 公开 API vs JWT 路径 + 迁移模式

- **匿名精确放行**:`security.js:23-29` `excludeExact`(method+path 四个 `/share/*` 端点)——新增匿名端点 = 加一行;宽前缀 `excludePrefixes`(`:11-21`)保留 `/oss` 等旧语义,勿动。
- **JWT+perm**:`requirePermsExact`(`:71-75`)+ premKey;`/public/*` 全局 token(`:115-123`)与分享无关,勿复用。
- **迁移模式(v3_xDB)**:`init.js:31-32` 链尾注册 → `v3_1DB`(`:37-121`)即完整范本:`CREATE TABLE IF NOT EXISTS`(mail_share + share_idempotency)+ `CREATE INDEX IF NOT EXISTS` + try/catch 幂等种子。新表(如 `mail_share_account` 联结表 / preset 表)= 新增 `v3_2DB` 并在 `init()` 注册,同时补 schema 断言测试(范本 `test/v3-1-db.spec.js`、`mail-share.schema.spec.js`)。
- **已证实的 D1 约束**(勿再踩):drizzle `.transaction()` 不可用(BEGIN 被拒);跨表原子 = `c.env.db.batch()`;单语句 `INSERT...SELECT` 做快照/条件写(`transaction.spec.js` 10/10;`mail-share-service.js:187-218` 活跃范本)。

## 7. 测试 / E2E 基线状态(本次亲跑实测)

| 命令 | 结果 | 用时 |
|---|---|---|
| `pnpm --dir mail-worker test` | ✅ 16 files / 138 tests | 17s |
| `pnpm --dir mail-vue test` | ✅ 17 files / 95 tests | 14s |
| `node tests/e2e/run.mjs` | ✅ 13 passed(Chromium) | 28s |

- worker 侧关键 spec:`share-auth-service` / `share-scoped-email-repository`(毒行泄漏断言) / `mail-share-service`(并发上限/幂等/重放) / `security-share`(路由门控) / `share-rate-limit` / `account-delete-share` / `v3-1-db` / `share-integration`。
- vue 侧:`views/share/index.spec.js`(15 态)、`session.spec.js`、`share-chunk.spec.js`(依赖图门禁:share chunk 不得含 Dexie/layout/主 axios)、`useSharePolling.spec.js`、`useCopyWithFallback.spec.js`。
- E2E `tests/e2e/specs/` 12 个文件 13 场景:fresh-context / live-delivery(真投递轮询) / otp-copy / session-ttl / unavailable 不可区分 / headers / no-third-party / background-poll / attachment / website-config-fail。
- 已知噪音:全新库迁移链 stderr 恒有一行 `no such column: auto_refresh_time`(E-1,tracker 已登记,无害)。
- **新工作包可直接 TDD,零基建债**。

## 8. 缺口矩阵:新需求 → 既有覆盖

| # | 新需求 | 覆盖 | 证据与差距 |
|---|---|---|---|
| 1 | 多邮箱聚合 | ❌ 无 | `mail_share.account_id` 单值 NOT NULL(`entity/mail-share.js:10`);repo 单 account 条件(`share-scoped-email-repository.js:62`)。需联结表(1:N)+ ctx 集合化 + 投影加 mailbox 字段 + 撤销钩子语义扩展。登录态 `allReceive` 聚合(`email-service.js:703-731`)是查询形状先例 |
| 2 | 每链接 auth key | 🟡 部分 | 已有 per-link `sec`(256-bit,fragment,HMAC 存库,`share-auth-service.js:243-272`)。但「访问密码」被 R1 裁决**明确排除**(requirements.md:7);若 auth_key=另行传达的低熵口令,鉴权模型与暴破防护均要重设计(§5) |
| 3 | max sessions(非 visit_count++) | ❌ 无 | `access_count` 仅观测、原子自增(`share-auth-service.js:236-241`);`max_views` 列被 R1-F3 裁决**砍掉**(design.md:280)。封顶=条件 UPDATE 单语句原子(已验证可行但「本期不做」);若指「并发活跃会话数」则冲突于无状态 token 设计(无会话表),需状态模型变更 |
| 4 | message_limit N / latest 1 | 🟡 部分 | repo 有 limit 参数(默认20/上限50,`:44-50`)但非 per-share 配置;方向为 ASC 自窗口起,「latest 1」需 DESC 语义。加列 + repo 分支,改动小 |
| 5 | auto_refresh 间隔配置 | 🟡 部分 | 分享页固定 3s(`useSharePolling.js:9` POLL_INTERVAL_MS);登录态有先例 `setting.auto_refresh`(`entity/setting.js:8`)+ `email/index.vue:98-99`。per-share 列 + 前端读配置,注意下限护栏(429 退避已有) |
| 6 | only_messages_after_created | ✅ 已有 | `window_start_email_id` 创建时单语句快照(`mail-share-service.js:195`),repo 强制 `email_id > windowStart`。多邮箱化后需 per-account 快照 |
| 7 | otp_extraction_enabled 开关 | 🟡 部分 | code 摄取时写死(`email/email.js:95,103`),全局 aiCode+白名单门控(`ai-service.js:54-69`)。per-share「展示开关」=投影层裁剪,易;「提取开关」=摄取链改造且不可追溯,难。语义必须先定 |
| 8 | 邮箱地址脱敏 | ❌ 无 | 全仓无 masking 原语;`establishSession` 明文返回 `accountRow.email`(`share-auth-service.js:269`),投影明文返回 sender(`share-mail-service.js:54-55`)。纯新建(工具函数+投影接入),但脱敏对象/规则未定 |
| 9 | 管理员预设 | ❌ 无 | 现有管理旋钮全是环境变量(`SHARE_ACTIVE_LIMIT`/`SHARE_MAX_DURATION_SECONDS`/`SHARE_ENABLED`/`SHARE_RETENTION_SECONDS`,`mail-share-service.js:72-94`),无 DB 预设表/无后台 UI;且 `setting.share` 开关是死分支(§0)。预设=新表+admin 端点+前端设置页 |

**业务现实核查(§0.17)**:#2/#3 曾被用户在 R1 裁决中以真实理由排除(低熵锁定可被 DoS、字段无语义纯占位)。新需求重新引入它们**不是技术洁癖,而是产品方向变更**——但正因如此,必须由用户确认新场景(谁在什么场景需要 auth key 而不是不可猜链接?max sessions 防什么?),不可由执行 AI 默认照单全收。#8/#9 未见既有机制冲突,属净新增,分类建议 B(保护)/ C(商业)。

## 9. 建议:原地演进 vs 新 slug

**建议:新开 slug `mailbox-share-capability`,`related_specs: [docs/specs/mail-share]`,暂不设 supersedes;若新能力最终替换旧创建入口,发布时再把 mail-share 标 `superseded_by`。**

理由:
1. **mail-share 已收敛且已交付**(status: converged,3 轮评审,代码+测试全绿在 HEAD)。它是一份带完整裁决审计链(R1/R2/R3 用户裁决、有意推翻记录)的文档;原地改写会把「访问密码不做」「max_views 砍掉」等裁决与新需求的反向裁决搅在同一份文档里,摧毁审计价值。
2. **新需求改变的是边界而非参数**:1:1 account→1:N(数据模型)、fragment capability→auth_key credential(授权通道)、观测计数→配额执行(状态语义)。这正是 `ADR-mail-share-capability-boundary.md` 定义的边界层面的变更,应有后继 ADR,而后继 ADR 天然对应新 charter。
3. **实现层高度复用,规格层彼此独立**:share-auth-service 的 kid/pepper 轮换、scoped repository 形状、share-result 封装、rate-limit 中间件、v3_xDB 迁移与测试基建全部直接可用——新 slug 不等于重写代码,它约束的是需求与验收的记账归属。
4. 旧 mail_share 行与 `/s/<lid>` 链接在生产语义上继续有效;coexist-then-supersede 比 in-place 少一次强制迁移。

**并行拆分雏形**(供主 AI 产 tasks 时参考;真正的 tasks.md 由主派发者按模板产出):
- WP-A 数据模型+迁移 v3_2DB(联结表/新列/预设表)——单 owner,阻塞后续
- WP-B 授权链改造(auth_key 校验+max_sessions 条件写+暴破计数)——依赖 A
- WP-C 聚合查询+投影(repo 集合化、mailbox 字段、message_limit、masking)——依赖 A,与 B 并行
- WP-D owner/admin 端点+perm(presets、创建参数扩展)——依赖 A,与 B/C 并行
- WP-E 前端(创建对话框、ShareView 聚合展示、auto_refresh 配置)——依赖 B/C/D 契约
- 冲突热区:`security.js`(B/D 都碰)、`init.js`(仅 A)、`share-auth-service.js`(仅 B)——security.js 建议单 owner 或先后串行。

## 10. 雾区(必须用户裁决,主 AI 提问从这里选)

1. **auth_key 语义**:是链接之外另行传达的口令(双通道),还是替代 fragment sec?人可读低熵还是系统生成高熵?这决定暴破防护是否要推翻 R1-A6(不按 lid 锁)裁决。
2. **max_sessions 语义**:累计建立会话次数封顶,还是并发活跃会话数上限?触顶后链接死亡还是挤掉最旧会话?(后者要求放弃无状态 token,新建会话表。)
3. **多邮箱撤销语义**:聚合中某个 account 被删,整条分享死,还是剔除该邮箱继续活?
4. **message_limit / latest 1 的方向与滚动性**:整个聚合取最新 N,还是每邮箱最新 N?新邮件到达后列表滚动替换还是冻结?
5. **otp_extraction_enabled**:仅控制访客侧展示(易),还是要求分享强制提取(摄取链改造、不可追溯,且与全局 aiCodeFilter 冲突时谁赢)?
6. **脱敏对象与规则**:脱谁(被分享邮箱地址 / 发件人 / 正文中的地址)?规则(`a***@x.com`?)对 OTP 场景发件人可信度展示(AC-OTP-07)有直接冲突。
7. **新旧关系**:新能力上线后,旧单邮箱 mail-share 创建入口保留还是移除(决定 supersedes 时点与迁移策略)?
8. **admin presets 载体**:继续环境变量,还是落 DB+后台 UI?若落 DB,顺手把 `setting.share` 死分支修正为真列还是删除该分支?
9. **auto_refresh 下限与设定者**:owner 每链接可设还是仅管理员预设?最小值(≥3s?)由谁强制?

---
*证据方式:主 AI 亲读源码 + 本机亲跑三套测试;所有锚点为 2026-08-24 工作树实测。未验证项:生产部署下 `_headers` 应用时机(沿袭 mail-share 的 unverified 项,与本次新需求无新增交集)。*
