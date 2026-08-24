# Recon 报告 · 邮箱能力分享(单/多邮箱聚合 + 授权密钥 + Share Session 配额)vs 既有 Mail Share 后端

- 模式:**Mode R · 现实侦察**
- 日期:2026-08-24 · 仓库 `/workspace` · HEAD `7d7fdf1`(detached)
- 侦察对象:`mail-worker` 既有 Mail Share 实现(v3_1 已上线形态,含 17 个 spec 测试文件)
- 目标领域模型:`Mailbox → MailboxShare → ShareMailboxBinding → ShareSession → ShareAccessEvent`
- 红线遵守:本报告只做调查与拆分,未写任何业务代码,未产出 spec 三件套。

---

## 1. 现有 Schema 表与列(file:line 锚点)

### `mail_share`(DDL:`mail-worker/src/init/init.js:39-57` · drizzle 实体:`mail-worker/src/entity/mail-share.js:4-21`)

| 列 | 类型/默认 | 锚点(entity) | 与新模型字段的对应 |
|---|---|---|---|
| `share_id` | INTEGER PK AUTOINCREMENT | mail-share.js:5 | = `share_id` ✅ |
| `lid` | TEXT NOT NULL,UNIQUE 索引 | mail-share.js:6;init.js:73 | 公开定位半(token 的 lookup-id) |
| `sec_hmac` | TEXT NOT NULL | mail-share.js:7 | ≈ `token_hash`(HMAC-SHA256(sec, PEPPER[kid]),强于裸 hash)✅ |
| `pepper_kid` | TEXT NOT NULL | mail-share.js:8 | 新模型无对应;密钥轮换设施,应保留 |
| `user_id` | INTEGER NOT NULL | mail-share.js:9 | Owner |
| `account_id` | INTEGER NOT NULL | mail-share.js:10 | **单邮箱绑定,内嵌于主表**——多邮箱 Binding 的替换点 |
| `name` / `remark` | TEXT DEFAULT '' | mail-share.js:11-12 | Owner 侧元数据 |
| `status` | TEXT DEFAULT 'ACTIVE' | mail-share.js:13 | 持久化仅 `ACTIVE`/`REVOKED`;`EXPIRED` 为实时计算(share-auth-service.js:25-33) |
| `window_start_email_id` | INTEGER DEFAULT 0 | mail-share.js:14 | ≈ `only_messages_after_created`(创建时原子快照 `MAX(email_id)`,mail-share-service.js:195;**恒开启,非可选布尔**) |
| `expires_at` | TEXT NOT NULL | mail-share.js:15 | = `expires_at` ✅ |
| `delete_at` | TEXT NOT NULL | mail-share.js:16 | 物理清理时刻(新模型无对应,应保留) |
| `access_count` | INTEGER DEFAULT 0 | mail-share.js:17 | ≈ `used_sessions` 的雏形(建 Session 时 +1,share-auth-service.js:236-241)——**无上限闸门** |
| `last_access_at` | TEXT | mail-share.js:18 | 审计聚合值 |
| `revoked_at` | TEXT | mail-share.js:19 | = `revoked_at` ✅ |
| `create_time` | TEXT DEFAULT CURRENT_TIMESTAMP | mail-share.js:20 | = `created_at` ✅ |

### `share_idempotency`(DDL:init.js:60-70 · 实体:mail-share.js:23-32)

创建幂等专用:`UNIQUE(user_id, idempotency_key, operation)`(init.js:77),24h TTL 清理(mail-share-cleanup-service.js:6,12)。与新模型正交,原样保留。

### 索引(init.js:72-79)

`UNIQUE(lid)` · `(user_id,status)` · `(account_id,status)` · `(delete_at)` · `UNIQUE(user_id,idempotency_key,operation)` · **`idx_email_account_id_email_id ON email(account_id,email_id)`**(分享读路径专用,AC-RT-04)。

### 不存在的表

全仓 grep 证实:**无 `share_session` 表、无 `share_mailbox_binding`、无 `share_access_event`、无 `max_views`/`max_sessions`/`auth_key`/`message_limit` 任何列**。`auto_refresh` 仅存在于全局 `setting` 表(setting.js:8,登录态邮箱列表刷新配置,与分享无关——**命名冲突预警**)。

---

## 2. 现有 API 路由:Owner vs Visitor

### Owner 侧(JWT + `share:manage` 精确匹配,`mail-worker/src/api/mail-share-api.js`)

| Method + Path | 锚点 | 语义 |
|---|---|---|
| `POST /mailShare/create` | mail-share-api.js:23-28 | 创建(支持 `Idempotency-Key` 头);入参 `{accountId, durationSeconds, name?, remark?}` |
| `GET /mailShare/list` | mail-share-api.js:30-33 | 本人全部分享 + JOIN account 取邮箱地址(mail-share-service.js:354-364) |
| `DELETE /mailShare/revoke` | mail-share-api.js:35-38 | 条件 UPDATE `status='REVOKED'`(mail-share-service.js:133-140) |

**没有 update/edit 端点**——设计明确不做 regenerate(design.md「后续 regenerate 约定」),新需求的 auth_key/quota 修改能力全部缺位。

### Visitor 侧(匿名,精确路径豁免 JWT,`mail-worker/src/api/share-api.js`)

| Method + Path | 锚点 | 限流 |
|---|---|---|
| `POST /share/session` | share-api.js:54-58 | `SHARE_SESSION_RATE_LIMITER` 10/60s(wrangler.toml:12-15) |
| `GET /share/mails?cursor=&limit=` | share-api.js:60-69 | `SHARE_READ_RATE_LIMITER` 100/60s(wrangler.toml:17-20) |
| `GET /share/mail?mailId=` | share-api.js:71-79 | 同上 |
| `GET /share/attachment?mailId=&attachmentId=` | share-api.js:81-88 | 同上 |

路由注册:`hono/webs.js:23-24`(side-effect import)。

---

## 3. 现有 Session 模型

- **Token 形态**:`s1.<kid>.<payloadB64>.<sigB64>` 四段无状态 HMAC-SHA256 令牌(非 JWT),payload = `{shareId, lid, iat, exp, kid}`(share-auth-service.js:155-180)。承载于 `Authorization: Bearer`(share-api.js:40-44)。
- **TTL**:`exp = min(share.expires_at, iat + SHARE_SESSION_TTL)`,默认 **900s(15 分钟)**(share-auth-service.js:12,163-166);只减不续,过期须重新提交 `lid`+`sec`。
- **存储**:**服务端零存储**。无 session 表、无 KV;撤销由每请求回源查 `mail_share` 行实现(share-auth-service.js:282-287:验签 → 查行 → 比对 lid → `effectiveStatus` → account 存活)。
- **计数语义**:`establishSession` 成功后 `access_count++` + `last_access_at`(share-auth-service.js:236-241,259-266)。**已经是"每次建立 Session 计 1",不是 HTTP 读请求 visit_count++**——与新需求的计数口径天然一致。但它是**事后统计**(fire-and-forget,失败不阻断,AC-LIFE-14),**不是准入闸门**:没有 max 上限、没有原子条件递增、不改变状态。
- **失败语义**:一切 Visitor 侧失败统一 `SHARE_UNAVAILABLE` 不可区分(P-AUTH-01);429 为独立运输层错误(share-rate-limit.js:48-53)。

---

## 4. 鉴权/安全边界

- **豁免清单**:仅 4 条 Visitor 路由以**精确 method+path** 进入 `excludeExact`(security.js:23-29),`/share-evil` 类前缀攻击被 AC-LEAK-06 测试钉死。
- **Owner 权限**:`requirePermsExact`(security.js:71-75)+ `premKey['share:manage']`(security.js:103)三条 `/mailShare/*` 精确匹配;缺权限返回 `SHARE_FORBIDDEN` 403(security.js:163-166);admin 邮箱账号绕过(security.js:163)。perm 种子行 `share:manage` 于 v3_1DB 幂等插入(init.js:90-107)。
- **反腐层**:Visitor 永不进入登录态 `email-service`;唯一授权入口 `share-auth-service`,唯一范围查询 `share-scoped-email-repository`(ADR「Decision」3,design.md:126)。附件走受控端点逐请求校验(share-attachment-service.js:126-161),不下发 `/oss/` 直链。
- **级联撤销**:account 软删/硬删/按用户物理删均挂钩 `revokeByAccountId(s)`(account-service.js:159,184,250 → mail-share-service.js:394-415)。
- **功能开关**:`SHARE_ENABLED` env + 管理后台 `setting.share`(share-auth-service.js:35-47);关闭时 Visitor 全线 `SHARE_UNAVAILABLE`,重开恢复(临时冻结语义)。
- **ADR 边界裁决**:`docs/architecture/ADR-mail-share-capability-boundary.md`(Status: Proposed)确立"资源级 capability,不复用全局 `/public/*` token"。新需求(多邮箱、auth_key、Session 配额)**全部落在该边界内侧**,是扩展而非违反;但 ADR 曾拒绝的「通用 ResourceGrant 抽象」(ADR:80-87)因 YAGNI 被否——多邮箱 Binding 不构成第二 grant 类型,不触发重开该裁决。

---

## 5. 邮件查询 Scoping 与 OTP(email.code)复用

- **范围封闭性**(share-scoped-email-repository.js:60-68,P-SCOPE-01):恒含 `account_id = ctx.accountId AND account_id > 0 AND email_id > windowStartEmailId AND is_del = NORMAL AND status != SAVING`,`email_id ASC`,limit ≤ 50(:44-50)。`account_id > 0` 排除历史脏行;`status != SAVING` 排除两阶段写入中间态。
- **多邮箱适配点**:查询形状是 `eq(email.accountId, scope.accountId)` 单值等值——多邮箱聚合需改为 `inArray` + 每 account 独立 window 下界(window 快照是 per-account 的 `MAX(email_id)`,聚合时**不能共用一个标量**)。游标 `email_id` 全局单调(email.js:4 PK AUTOINCREMENT),跨邮箱聚合分页**天然可用同一游标**,这是重大利好。
- **OTP**:`email.code` 由摄取链同批写入(design.md 核实清单:`email/email.js:95-131`,AI 失败为空串 `''`),分享投影链**只读转发**(share-mail-service.js:60 `code: emailRow.code`,P-OTP-03 单一真源)。新需求的 `otp_extraction_enabled` 只需在投影处按 share 配置**条件性剔除该字段**,零摄取链改动。
- **附件**:投影含受控 `downloadUrl`(share-mail-service.js:36-44);下载逐请求三重校验 att 归属 + scoped repo 复查(share-attachment-service.js:136-153)。多邮箱下 `shareContext.accountId` 单值假设(:139)需同步改造。

---

## 6. 映射:既有概念 → 新领域对象

| 新领域对象 | 既有概念 | 结论 |
|---|---|---|
| `Mailbox` | `account` 实体(user_id 单归属 SSOT) | **复用**,零改动 |
| `MailboxShare` | `mail_share` 行 | **扩展**:加 `share_type`、配额、auth、otp、refresh 列;`sec_hmac`+`pepper_kid` 优于裸 `token_hash`,保留现设计 |
| `ShareMailboxBinding` | `mail_share.account_id` 单列 + `window_start_email_id` 单列 | **新建表**:`(share_id, account_id, window_start_email_id)`;单邮箱旧行迁移期回填 |
| `ShareSession` | 无状态 HMAC token(零服务端存储)+ `access_count` 聚合 | **架构决策点**(见 §7/§10):落库 session 行,或最小改造为 `mail_share` 上的原子条件 `used_sessions++` |
| `ShareAccessEvent` | 仅 `access_count`/`last_access_at` 聚合值 | **新建表**(append-only 审计流) |
| `only_messages_after_created` | `window_start_email_id` 快照(恒开启) | **复用 + 降级为可选**:布尔关闭 = 下界取 0 |
| `ACCESS_LIMIT_REACHED` | 无 | **扩展 `effectiveStatus` 计算**(share-auth-service.js:25-33 加一分支:`used_sessions >= max_sessions`),沿用「EXPIRED 不落库」既有模式,**不建议**作为持久化状态 |
| `auth_key` | 无(`sec` 是链接自带凭据,非用户输入口令) | **新建**:`auth_key_hash` 复用 `digestShareSecret` 同款 HMAC+pepper 设施(share-auth-service.js:86-89),`establishSession` 加第二因子 |
| `auto_refresh`/`refresh_interval` | 客户端固定 3s 轮询(design.md Decision 3);`setting.auto_refresh` 为无关全局配置 | **新建 per-share 配置列**,下发给前端轮询 composable;**注意与 setting 列重名** |
| `message_limit` | 无(仅分页 cap 50) | **新建列** + repository 查询语义(见 §10 决策 4) |
| Visit counting via Session | `establishSession` 时 `access_count++` | **语义已一致**,只差原子闸门化 |

**架构/前提挑战(强制回答)**:用户表述的 Y 是「按新领域模型五对象重建」;真问题 X 是「一条链接可授权多个邮箱 + 可加口令 + 可限次」。既有架构(capability URL + 无状态 session + scoped repository)**没有坏**,五对象中三个(Mailbox/MailboxShare/计数口径)已存在或半存在;**不需要推倒重建 bounded context,增量扩展即可**。唯一真正的架构级张力是 `ShareSession` 落不落库(见雾清单 Q1)——落库会推翻 design.md A1「无服务端 session 表」的显式裁决,须用户/主 AI 拍板,不得由执行者顺手改。

**业务现实核查(§0.17)**:`ShareAccessEvent` 独立表——①真场景:Owner 查看「谁在什么时候用过我的链接」;②缺失影响:Owner 已能看到 `access_count`/`last_access_at` 聚合,缺的是明细;③既有覆盖:部分覆盖;④分类:**B(稳定保护/审计)偏 C**,非 A 类必做——若用户只要"次数配额",聚合计数 + 原子闸门即可满足,事件表可后置。**建议向用户确认**(雾清单 Q6),勿默认纳入首批工作包。

---

## 7. Gap 清单(逐项)

| # | 新需求 | 现状 | 缺口大小 |
|---|---|---|---|
| G1 | 多邮箱 Binding | `account_id` 单列内嵌(mail-share.js:10);创建时单 account 归属校验(mail-share-service.js:104-110);repo 单值等值查询(repo:62);附件校验单值(share-attachment-service.js:139);级联撤销按 account_id 直查(mail-share-service.js:413) | **大**:表 + 创建/校验/查询/附件/撤销/列表 JOIN 六处改造;token payload 与 ShareContext 形状同步变 |
| G2 | `auth_key`(可选口令) | 无;`establishSession(lid, sec)` 双参(share-auth-service.js:243) | **中**:加列 ×2 + 建 Session 第二因子 + 错误不可区分性保持(P-AUTH-01) |
| G3 | `max_sessions`/`used_sessions` 配额 | `access_count` 事后统计,无闸门(share-auth-service.js:236-241) | **中**:D1 单语句条件 UPDATE 原子性已被 T-02 验证可行(design.md:90,`transaction.spec.js`);把统计改成 `UPDATE ... SET used_sessions=used_sessions+1 WHERE used_sessions < max_sessions RETURNING`,失败即拒发 token |
| G4 | `message_limit` | 无(仅每页 cap 50,repo:7) | **小-中**:取决于语义裁决(全窗 Top-N or 滚动),影响游标分页正确性 |
| G5 | `auto_refresh`/`refresh_interval` per-share | 客户端硬编码 3s(design.md Decision 3);与 `setting.auto_refresh`(setting.js:8)重名 | **小**:两列 + session 响应体下发 |
| G6 | `ACCESS_LIMIT_REACHED` 状态 | `effectiveStatus` 仅三态(share-auth-service.js:25-33) | **小**:计算函数加分支 + Owner 列表投影(mail-share-service.js:122) |
| G7 | `ShareAccessEvent` | 无表,仅聚合计数 | **中**:新表 + 写入点 + 清理级联(cleanup-service)+ Owner 查询端点;业务必要性待确认(§6) |
| G8 | Share 编辑端点(改 auth_key/配额/refresh) | 无 update API(§2) | **中**:新 Owner 端点 + 权限 + 幂等考量 |
| G9 | `share_type`(SINGLE/MULTI 统一) | 隐含恒 SINGLE | **小**:列 + 默认值回填 |
| G10 | `only_messages_after_created` 可选化 | 恒开启快照 | **小**:布尔列,关闭时 binding 行下界写 0 |

---

## 8. 迁移/兼容风险:就地演进 vs 新表

**结论:主表就地加列(v3_2DB)+ 三张新表(binding 必建;session/event 待裁决),不建 `mail_share_v2` 平行表。**

支持就地演进的事实:
- 所有读路径都是**显式列名 SELECT**(mail-share-service.js:354-358;drizzle 实体列枚举),加列零破坏。
- 迁移链已有幂等模式(`CREATE TABLE IF NOT EXISTS` + try/catch ALTER,init.js:5-34 注册链,新增 `v3_2DB` 挂 init.js:32 之后即可)。
- Session token 是无状态的,payload 含 `shareId`+`lid`,`resolveSession` 从行上派生一切(share-auth-service.js:282-295)——**旧 token 在新代码下天然可验**,只要 ShareContext 构建兼容单邮箱行。
- `mail-share.schema.spec.js` 已存在 DDL-实体一致性测试,漂移会被抓。

风险与对策:
| 风险 | 说明 | 对策 |
|---|---|---|
| R1 双 SSOT | `account_id` 列 vs binding 表并存期,两处真源 | 迁移内同步回填 binding 行;读路径一次性切到 binding;`account_id` 列保留只读(或置 0)并在 schema spec 里钉死语义 |
| R2 半迁移态 | init.js 迁移器 try/catch 吞异常(design.md 核实清单「迁移器部分失败」) | v3_2DB 每语句幂等 + 新表用 `IF NOT EXISTS`;回填用 `INSERT ... SELECT ... WHERE NOT EXISTS` |
| R3 级联撤销漏点 | `revokeByAccountIds` 现按 `account_id IN (...)` 直查主表(mail-share-service.js:412-413);多邮箱后须经 binding JOIN,漏改则删邮箱不再撤销聚合分享 | 列入工作包验收;`account-delete-share.spec.js` 已有测试基线可扩展 |
| R4 清理守恒 | 无外键无级联(design.md:350);cleanup 现删 2 表(cleanup-service.js:26-27),新表须显式加入 | binding/session/event 全部按 `share_id` 显式清理 |
| R5 计数语义变更 | `access_count`(纯统计)与 `used_sessions`(闸门)若合并为一列,历史值直接变成配额消耗,旧 ACTIVE 链接可能瞬间 ACCESS_LIMIT_REACHED | **分两列**或迁移时 `max_sessions` 默认 NULL=不限;旧行不设限 |
| R6 测试面 | 17 个 spec 钉死现语义(tests 列表见 `mail-worker/test/`),多为行为契约 | 扩展而非改断言;单邮箱行为必须全绿保持 |
| R7 token 版本 | 若 session 落库,token 须携带 session_id → 版本升 `s2`,`verifyToken` 双版本窗口(现 `parts[0] !== TOKEN_VER` 直接拒,share-auth-service.js:187) | 参照既有 kid 双密钥窗口模式 |
| R8 状态列自由文本 | `status` TEXT 无 CHECK;若把 ACCESS_LIMIT_REACHED 落库会引入第四持久态,与「EXPIRED 不落库」原则冲突 | 建议保持计算态(§6),持久态仍仅 ACTIVE/REVOKED |

---

## 9. 并行拆分提案(供主 AI 产 tasks.md 参考)

| WP | 范围(文件) | 目标 | 依赖 | 可并行 | 建议执行者数 |
|---|---|---|---|---|---|
| WP0 决策收口 | 雾清单 §10 | 用户裁决 6 问,锁定 session 落库与 message_limit 语义 | — | — | 主 AI+用户 |
| WP1 Schema+实体 | `init.js`(v3_2DB)、`entity/mail-share.js`、`mail-share.schema.spec.js`、`v3-2-db.spec.js`(新) | 主表加列 + binding(+session/event 视裁决)+ 索引 + 回填 | WP0 | 否(其余全依赖它) | 1 |
| WP2 Session 配额+auth_key | `share-auth-service.js`、`share-api.js`(session 端点)、`share-auth-service.spec.js` | 原子 `used_sessions` 闸门、ACCESS_LIMIT_REACHED 计算、auth_key 第二因子、token 兼容 | WP1 | 与 WP3/WP4 并行 | 1 |
| WP3 多邮箱读路径 | `share-scoped-email-repository.js`、`share-mail-service.js`、`share-attachment-service.js` + 对应 spec | inArray + per-account window、聚合游标、message_limit、otp 开关投影、附件多邮箱校验 | WP1(+WP2 的 ShareContext 形状约定,可用接口契约先行解耦) | 与 WP2/WP4 并行 | 1 |
| WP4 Owner 管理面 | `mail-share-service.js`、`mail-share-api.js`、`security.js`(若加端点)、对应 spec | create 收新字段(多 accountId 归属校验、配额、auth_key)、update 端点、list 投影新状态 | WP1 | 与 WP2/WP3 并行 | 1 |
| WP5 级联+清理+审计 | `mail-share-cleanup-service.js`、`account-service.js` 挂钩、`share-access-event`(若做)、`account-delete-share.spec.js` | binding JOIN 撤销、新表清理守恒、事件写入/查询 | WP1;撤销部分与 WP4 有共享文件 | 半并行 | 1 |
| WP6 集成回归 | `share-integration.spec.js`、`security-share.spec.js`、e2e | 单邮箱旧行为全绿 + 多邮箱/配额/口令端到端 | WP2-5 | 否(收口) | 1 |

**风险交叉区(须串行或精确分界)**:① `share-auth-service.js` 是 WP2 主场但 WP3 消费其 ShareContext——先冻结 ShareContext 接口契约再并行;② `mail-share-service.js` 同时被 WP4(create/update)与 WP5(revokeByAccountIds)触碰——建议 WP5 撤销部分并入 WP4 或严格函数级分界;③ `init.js` v3_2DB 单点,只允许 WP1 写。串行链:WP0 → WP1 → {WP2‖WP3‖WP4} → WP5 收尾 → WP6。

---

## 10. 雾清单(必须问用户的业务决策)

1. **访问次数用完之后,这条链接是永久作废,还是过一段时间又能用?** 比如设了"最多 3 次访问":第 4 个人打开时直接判死;那么如果同一个人刷新页面重新进入,算不算又用掉一次?(这决定 Session 要不要在服务端记账落库,是本次最大的架构分叉)
2. **同一个访客在有效期内反复打开,消耗几次配额?** 完全按"每次建立会话计一次",还是"同一个人 15 分钟内只算一次"?
3. **授权密钥是谁输入的、长什么样?** 是 Owner 创建时自己设一串口令、访客打开链接后需要手动输入才能看邮件?输错几次有没有惩罚(锁定/冷却)?
4. **"最多展示 N 封邮件"数的是什么?** 是"这条分享总共只让看最新 N 封"(新邮件来了顶掉旧的?还是看满 N 封就不再更新?),多邮箱聚合时 N 是每个邮箱各 N 封还是全部加起来 N 封?
5. **多邮箱聚合页里,访客能不能看出每封邮件来自哪个邮箱?** 邮箱地址对访客是明示、脱敏(如 `a***@x.com`)还是完全隐藏?
6. **要不要给 Owner 看"访问明细流水"(每次访问的时间/来源)?** 还是只要"用了几次/最后一次什么时候"两个数字就够?明细涉及存访客 IP,有隐私与存储成本。
7. **已经发出去的旧分享链接,升级后要不要原样继续可用?**(建议:是;若否,迁移可大幅简化)
8. **关掉"验证码提取"开关时,访客是只看不到验证码角标,还是连邮件正文也不给看(纯验证码模式的反面)?**

---

## 附:证据锚点索引(工具+查询)

- Read 全文:`entity/mail-share.js`、`api/mail-share-api.js`、`api/share-api.js`、`service/mail-share-service.js`、`service/share-auth-service.js`、`service/share-mail-service.js`、`service/share-scoped-email-repository.js`、`service/share-attachment-service.js`、`service/mail-share-cleanup-service.js`、`security/share-rate-limit.js`、`entity/email.js`、`docs/specs/mail-share/design.md`、`docs/architecture/ADR-mail-share-capability-boundary.md`
- Grep:`mail_share|share_idempotency`(init.js 命中 39-79)、`share`(security.js 命中 23-29/71-75/103/145-166;webs.js 23-24)、`max_views|share_session|auth_key|message_limit|auto_refresh`(仅 setting.auto_refresh 命中,无其余)、`revokeByAccountId`(account-service.js 159/184/250)、`SHARE_`(wrangler.toml 12-20;index.js 39)
- 测试清单:`mail-worker/test/` 17 个 spec(ls 输出),含 schema/一致性/集成/e2e 基线
