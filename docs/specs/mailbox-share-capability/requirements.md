# Requirements · mailbox-share-capability

## Introduction

在已交付的 mail-share 单邮箱严格最小集(`docs/specs/mail-share/`,status: converged,已实现并全绿)之上,把「单邮箱、单窗口、纯观测计数」的分享扩展为**邮箱访问能力分享**:管理员或邮箱所有者可以把一个或多个邮箱通过一条不可猜链接临时交给外部用户,用于注册网站、接收验证码、查看最新邮件。本 charter 不是「单封邮件快照」——分享对象是邮箱在授权窗口内的**持续收信能力视图**,不是某封邮件的静态副本。

扩展的三条主轴:① 多邮箱 Binding(一条链接聚合 N 个邮箱);② Session 配额闸门(`max_sessions` 累计建立次数上限,`access_count` 语义升级为 `used_sessions`);③ 可选认证 Key(链接之外的第二因子,重置即令旧 Session 失效)。全部在既有 capability URL(`/s/<lid>#<sec>`)+ 无状态 Session token(`s1.`)+ `share-scoped-email-repository` 反腐层边界**内侧**就地演进,不推倒重建(见 `## Decision Record` D2 与 `docs/architecture/ADR-mailbox-share-capability-extension.md`)。

**与旧裁决的关系**:访问密码、访问次数上限、重置密钥曾在 mail-share R1-R3(2026-08-16/17)被用户裁决明确排除出严格最小集。本 charter 依据用户 2026-08-24 需求书**显式推翻**上述排除——这是产品方向变更,不是执行者擅自扩权;旧 charter 原文不改,审计链保留在两份文档各自的 Decision Record 中。

## Success State (§0.16 · MANDATORY · sourced)

NOT「加了多邮箱表和 API」,
BUT「管理员/邮箱所有者可以把一个或多个邮箱通过一条不可猜链接临时交给外部用户,用于注册网站、接收验证码、查看最新邮件;外部用户打开链接(可选输入认证 Key)后进入专属页面,在配置允许范围内等待并复制验证码;达到 Session 上限、过期或撤销后,新访客无法再建立访问,且不得获得任何写能力或越权邮箱」。

Must NOT happen:
- URL 暴露 mailbox_id/真实邮箱作鉴权。
- 公开接口复用管理员权限。
- 前端限制 N 但 API 可查全部。
- 通过改参数越出绑定邮箱。
- HTTP 轮询误消耗访问次数。

Source:用户 2026-08-24 需求书。

Verified once by:未登录干净浏览器打开单邮箱与多邮箱链接各一条;投递含验证码邮件;观察自动刷新与 OTP 复制;耗尽 max_sessions 后新隐身窗口无法进入;旧 Session 在 TTL 内仍可读;撤销后立即不可读。

## Glossary

- **MailboxShare**:一条分享授权记录,D1 表 `mail_share` 一行(就地演进,`mail-worker/src/entity/mail-share.js:4-21`)。承载生命周期、Session 配额、认证 Key、展示配置;不再直接承载邮箱归属(归属移交 Binding)。`share_type`(`single`|`multi`)为**实时派生值,不落库**:由现存 Binding 计数派生(恰 1 → `single`,>1 → `multi`,0 → 已进入撤销路径),Binding 表是唯一真源。
- **Binding(ShareMailboxBinding)**:MailboxShare 与一个邮箱(`account`)的绑定关系,新表 `mail_share_binding` 一行,含该邮箱独立的 `window_start_email_id` 快照。一条 MailboxShare 拥有 1..N 条 Binding;旧单邮箱行由迁移回填恰一条 Binding(须通过迁移门禁,见 AC-BIND-11)。
- **主 Binding**:某分享现存 Binding 中 `binding_id` 最小的一条(创建时的第一个邮箱)。滚动发布 Expand 阶段,新代码把 `mail_share.account_id` 双写为主 Binding 的 `account_id`(禁止写 0),保证旧 Worker 在兼容窗口内仍能按主表列服务单邮箱语义(R2-A1,见 AC-LIFE-10)。
- **Owner**:创建 MailboxShare 的登录用户(`mail_share.user_id`),须持 `share:manage` 权限(`mail-worker/src/security/security.js:103`)。
- **Visitor**:持分享链接的未登录访问者,无 JWT、无 `user` 上下文。
- **ShareSession**:Visitor 用 `lid`+`sec`(及可选 AuthKey)换取的短期无状态凭据,即 `s1.<kid>.<payload>.<sig>` HMAC token(`mail-worker/src/service/share-auth-service.js:155-180`),绝对 TTL 默认 15 分钟(`SHARE_SESSION_TTL`),只减不续;服务端不落 Session 行。
- **AuthKey**:可选第二因子口令,独立于链接 fragment 中的 `sec`;服务端只存 `auth_key_hash`(复用 `digestShareSecret` 的 HMAC+PEPPER 设施,`share-auth-service.js:86-89`),明文仅在生成/重置时向 Owner 返回一次。
- **credentials_version**:`mail_share` 行上的单调递增整数。AuthKey 被重置或修改时 +1;ShareSession token 携带签发时的版本号,回源比对不一致即失效。
- **used_sessions**:该 MailboxShare 累计成功建立 ShareSession 的次数,是配额消耗量,不是 HTTP 请求计数。物理载体为既有 `access_count` 列(`mail-share.js:17`),**expand-only:物理列名不改**——应用层读写 `access_count` 列,领域/API/DTO 一律称 `used_sessions`/`usedSessions`;旧版本 Worker 读旧列名保持兼容,无需版本栅栏。
- **max_sessions**:`used_sessions` 的累计上限(非并发上限);NULL 表示不限(存量旧行默认不限)。
- **EffectiveStatus(计算态)**:Owner 列表与 Visitor 鉴权统一使用的判定状态,取值 `ACTIVE`|`EXPIRED`|`REVOKED`|`ACCESS_LIMIT_REACHED`,每次访问实时计算(扩展 `share-auth-service.js:25-33`),不落库;持久化状态仅 `ACTIVE`|`REVOKED`。
- **VisibleWindow**:某条 Binding 下 Visitor 可见的邮件集合下界。`only_messages_after_created=true` 时为该 Binding 的 `window_start_email_id`(创建/加入时刻的 `MAX(email_id)` 原子快照);为 false 时下界取 0(仍受 message_limit 约束)。
- **message_limit**:每条 Binding 各自可见的最近 N 封上限(按 `email_id` DESC 取最新 N),服务端强制;N=1 合法;NULL 表示不限。
- **OTP**:邮件中的一次性验证码,摄取链写入 `email.code`(`mail-worker/src/email/email.js:95-131`);分享投影只读该字段,永不重新推断。
- **StatusEndpoint**:多邮箱统一状态端点(`GET /share/mailboxes/status`),一次请求返回各 Binding 可见集内的最新邮件水位(`latestEmailId`,无邮件为 null;可选 `latestReceivedAt`),替代 N 路并行轮询;**不接受任何游标参数**,hasNew/角标由客户端本地 per-binding 水位比较得出(R2-A2,见 AC-OTP-09)。
- **SafeMailRenderer**:全站唯一邮件正文安全渲染器(`mail-vue/src/components/safe-mail/index.vue`),沙箱 iframe、无脚本执行,单/多邮箱访客页共用。
- **地址脱敏(Masking)**:**展示偏好,非安全/隐私边界**(R2-A7)——Visitor 侧对**系统生成的绑定邮箱身份字段**(session/status/list/detail 投影中的 mailbox address)的默认掩码展示(如 `a***@x.com`);Owner 可设 `show_full_address` 关闭掩码。掩码契约**不**覆盖用户邮件内容:发件人地址默认不掩码,主题/正文不承诺不出现绑定地址,命中绑定地址的内容不改写(SafeMailRenderer 原样渲染)——因此它不构成「隐藏邮箱身份」的保密能力,不得以安全开关口径向 Owner 呈现。

## Requirements

### Requirement 1(R1): 创建单/多邮箱分享

**User Story:** As an 邮箱所有者, I want 一次为一个或多个自己的邮箱创建分享链接并配置配额/认证/展示策略, so that 我可以按场景(注册网站、验证码池、临时邮箱)把收信能力临时交给外部用户。

#### Acceptance Criteria (EARS)

- [AC-CAP-01] WHEN Owner 携带一个或多个 `accountId` 请求创建分享, THE MailShareService SHALL 创建一条 `mail_share` 行与每个邮箱各一条 `mail_share_binding` 行,并返回完整 Share URL(`/s/<lid>#<sec>`)。
- [AC-CAP-02] THE MailShareService SHALL 将 `share_type` 作为实时派生值(**不持久化**):由现存 Binding 计数派生,恰一条 → `single`,多于一条 → `multi`,0 条 → 分享已进入撤销路径;Owner/Visitor 响应中的 `shareType` SHALL 每次由 Binding 计数计算,单/多邮箱 SHALL 共用同一 `mail_share` + `mail_share_binding` 数据模型,`mail_share_binding` SHALL 为该类型的唯一真源。
- [AC-CAP-03] IF 请求中任一 `accountId` 不属于当前 Owner 或已被删除, THEN THE MailShareService SHALL 拒绝创建整条分享并返回 `SHARE_ACCOUNT_FORBIDDEN`,SHALL NOT 留下部分 Binding。
- [AC-CAP-04] THE MailShareService SHALL 沿用 mail-share 的凭据规格:CSPRNG 生成 `lid`(128-bit)与 `sec`(256-bit),`sec` 只以 `HMAC-SHA256(sec, PEPPER[pepper_kid])` 存库且明文仅创建响应返回一次。
- [AC-CAP-05] WHERE Owner 在创建时启用 AuthKey, THE MailShareService SHALL 服务端生成 AuthKey(规格:128-bit CSPRNG,base64url 编码,定长 22 字符可测),只存 `auth_key_hash` 与 `auth_key_kid`,并在创建响应中返回 AuthKey 明文恰好一次;前端展示 MAY 分组呈现,但校验侧规范化 SHALL 仅 trim(不去分隔符、不改大小写)。
- [AC-CAP-06] WHERE Owner 提交了 `maxSessions`、`messageLimit`、`onlyMessagesAfterCreated`、`otpExtractionEnabled`、`autoRefresh`、`refreshIntervalMs`、`showFullAddress` 配置, THE MailShareService SHALL 校验取值域后随行存储;IF `refreshIntervalMs` 小于 3000, THEN THE MailShareService SHALL 拒绝并返回 `SHARE_INVALID_CONFIG`。
- [AC-CAP-07] WHEN `onlyMessagesAfterCreated` 为 true 且分享创建, THE MailShareService SHALL 在单条 SQL 语句内为每条 Binding 原子快照该邮箱当前 `MAX(email_id)` 写入 `window_start_email_id`(沿用 `mail-share-service.js:187-218` 的单语句条件写模式;D1 无 `BEGIN`,跨行用 `c.env.db.batch()`)。
- [AC-CAP-08] WHEN `onlyMessagesAfterCreated` 为 false 且分享创建, THE MailShareService SHALL 将每条 Binding 的 `window_start_email_id` 写 0。
- [AC-CAP-09] WHEN Owner 在 `POST /mailShare/create` 携带 `Idempotency-Key`, THE MailShareService SHALL 沿用 `share_idempotency` 重复操作检测语义(等价请求体重放返回同 `shareId`/`lid` 且不再返回 `sec`/AuthKey 明文);请求指纹 SHALL 纳入全部新配置字段与排序后的 `accountId` 集合。
- [AC-CAP-10] THE MailShareService SHALL 继续接受旧 ShareDialog 的单邮箱 create 载荷形状(单个 `accountId`、无新配置字段),按全部配置默认值创建恰一条 Binding(响应 `shareType` 派生为 `single`)。
- [AC-CAP-11] WHERE 管理员通过环境变量配置了活跃分享数量上限或最大有效期(`SHARE_ACTIVE_LIMIT`/`SHARE_MAX_DURATION_SECONDS`), THE MailShareService SHALL 沿用既有上限校验并返回既有错误码(`SHARE_LIMIT_EXCEEDED`/`SHARE_DURATION_EXCEEDED`)。
- [AC-CAP-12] WHERE 前端提供创建预设(单邮箱验证码/临时邮箱/多邮箱验证码池/自定义), THE 前端创建向导 SHALL 仅做表单预填,SHALL NOT 要求服务端预设存储;预设落库不在本期。
- [AC-CAP-13] THE MailShareService SHALL 强制每分享 Binding 数量上限为常量 `SHARE_BINDING_LIMIT`(=50,R3-A5):WHEN create 或 bindings 变更将使该分享现存 Binding 数超过该上限, THE MailShareService SHALL 拒绝整单并返回 `SHARE_BINDING_LIMIT_EXCEEDED`,SHALL NOT 部分写入。
- [AC-CAP-14] WHEN create 提交成功但首次响应丢失(Owner 未获得 `sec`/AuthKey 明文), THE 幂等重放 SHALL 仅返回 `shareId`/`lid` 而不重放明文(AC-CAP-09 安全边界不变,R3-A6);THE 管理 UI SHALL 依据重放结果引导 Owner 对该分享执行 revoke/delete 后重新 create 取得新链接;THE 前端 SHALL NOT 在结果未知时更换 `Idempotency-Key` 盲目重复创建。

### Requirement 2(R2): Binding 与聚合管理

**User Story:** As an 邮箱所有者, I want 在分享创建后增删其绑定的邮箱, so that 聚合分享可以随业务调整而不必销毁重建。

#### Acceptance Criteria (EARS)

- [AC-BIND-01] THE MailShareService SHALL 以 `mail_share_binding` 表为分享↔邮箱归属的唯一真源;新代码的一切鉴权与范围判定 SHALL NOT 读取 `mail_share.account_id`;该列在 Expand 阶段 SHALL 作为双写目标维护(= 主 Binding 的 `account_id`,禁止写 0,见 AC-LIFE-10),Contract 阶段停止双写后降为遗留字段。
- [AC-BIND-02] WHEN Owner 向 `effectiveStatus=ACTIVE` 的分享添加自己名下的邮箱, THE MailShareService SHALL 新建 Binding 行,且 WHERE `only_messages_after_created=true` SHALL 以加入时刻的 `MAX(email_id)` 原子快照该 Binding 的 `window_start_email_id`。
- [AC-BIND-03] WHEN Owner 从分享移除一个 Binding, THE MailShareService SHALL 删除该 Binding 行;下一次 Visitor 拉取 SHALL 不再包含该邮箱的任何邮件。
- [AC-BIND-04] IF Owner 移除了分享的全部 Binding, THEN THE MailShareService SHALL 将该分享置为 `REVOKED` 并记录 `revoked_at`。
- [AC-BIND-05] WHEN 某个 `account` 被删除(软删或硬删), THE MailShareService SHALL 从所有分享中剔除该邮箱对应的 Binding;WHERE 剔除后该分享仍有剩余 Binding, THE MailShareService SHALL 保持分享 `ACTIVE` 且剩余邮箱继续可见。
- [AC-BIND-06] IF 某个 `account` 被删除后分享剩余 Binding 数为 0, THEN THE MailShareService SHALL 撤销该分享(等同 AC-BIND-04)。
- [AC-BIND-07] THE MailShareService SHALL 在同一分享内禁止重复绑定同一 `accountId`(表级 `UNIQUE(share_id, account_id)`);IF 重复添加, THEN THE MailShareService SHALL 返回 `SHARE_BINDING_DUPLICATE`。
- [AC-BIND-08] WHEN Binding 集合发生增删, THE ShareMailService SHALL 使变更在 Visitor 的下一次列表/状态请求即刻生效,SHALL NOT 依赖 Session 重建或缓存过期。
- [AC-BIND-09] THE 迁移任务(v3_2DB) SHALL 为每条**通过迁移门禁(AC-BIND-11)**的存量 `mail_share` 行幂等回填恰一条 Binding(`INSERT ... SELECT ... WHERE NOT EXISTS`),携带原行的 `account_id` 与 `window_start_email_id`,使旧单邮箱链接在新读路径下继续有效。
- [AC-BIND-10] THE MailShareService SHALL 以单条 `INSERT ... SELECT` 条件写新增 Binding:仅当目标 `account` 行仍存在、`is_del=NORMAL` 且 `user_id` 等于 Owner 时插入;IF 条件不成立(含与 account 删除并发), THEN THE MailShareService SHALL 返回 `SHARE_ACCOUNT_FORBIDDEN`;WHEN account 删除与 Binding 写入并发仍产生孤儿 Binding, THE 级联与定时清理路径 SHALL 补偿剔除之。
- [AC-BIND-11] THE 迁移任务(v3_2DB)回填 SQL SHALL JOIN `account` 表并要求 account 行存在、`is_del=NORMAL` 且 `account.user_id = mail_share.user_id`(与 AC-BIND-10 运行时条件同源);THE 无效行处置 UPDATE SHALL 以 account 事实为显式判据——`status='ACTIVE' AND (account 不存在 OR is_del != NORMAL OR user_id 不匹配)`——SHALL NOT 以「无 Binding」作为脏数据判据(R3-A2):迁移窗口内旧 Worker 在回填 INSERT 之后新写的 account 合法行虽暂无 Binding,SHALL NOT 被置 REVOKED,SHALL 由发布收尾重跑幂等回填收编;IF 存量行不满足 account 门禁(不存在/已删/归属不符), THEN THE 迁移任务 SHALL 将该行置为 `REVOKED`(记录 `revoked_at`)且 SHALL NOT 为其回填 Binding;迁移完成后 SHALL 零非法 Binding(每条回填 Binding 的 account 均存活且归属正确,R2-A4 迁移门禁);迁移测试 SHALL 覆盖旧写发生在回填 INSERT 之前/INSERT 与 UPDATE 之间/UPDATE 之后与任务重启后的全部交错时序。
- [AC-BIND-12] THE `PUT /mailShare/bindings` 批量变更 SHALL 为全有或全无的原子命令(同一 `c.env.db.batch()` 提交):IF 任一 add/remove 项校验失败, THEN THE MailShareService SHALL 使整单失败且零残留变更;remove SHALL 以 `binding_id + share_id + 当前 Owner(user_id)` 三重资源谓词定位目标,IF 任一 `bindingId` 不属于该分享或该 Owner, THEN THE MailShareService SHALL 返回 `SHARE_BINDING_FORBIDDEN` 且整单失败(SHALL NOT 泄露该 bindingId 是否存在于他人分享);WHILE `SHARE_CAPABILITY_V2=false`, 使现存 Binding 数由 1 变为大于 1 的变更 SHALL 被拒绝(AC-LIFE-11,R3-A4)。

### Requirement 3(R3): Visitor 认证与 Session

**User Story:** As a 未登录的访问者, I want 打开链接(必要时输入认证 Key)即进入专属页面, so that 我能在授权范围内等待并复制验证码,而我的会话行为不会被误计为多次访问。

#### Acceptance Criteria (EARS)

- [AC-SESS-01] WHEN Visitor 提交 `lid`+`sec` 建立 ShareSession, THE ShareAuthService SHALL 以「读快照取 `credentials_version` 并完成 `sec`(及 AuthKey)校验 → 幂等重放缓存查询(AC-SESS-10,命中即返回缓存 token、零配额消耗、零 UPDATE)→ 未命中才单条原子条件 UPDATE → RETURNING 非空才 issueToken」为处理次序,条件 UPDATE 为配额消耗的**单一线性化点**,该 UPDATE 的 WHERE SHALL 同时包含:`status='ACTIVE'`、`expires_at > now`、`credentials_version = :expectedCv`、配额条件(`access_count < max_sessions`,`max_sessions IS NULL` 时豁免配额项;物理列 `access_count` 承载领域量 `used_sessions`);IF RETURNING 为空, THEN THE ShareAuthService SHALL 拒绝签发且零配额消耗;THE 配额的成功口径 SHALL 为「客户端可恢复地获得凭据」(R3-A3 产品裁决)——服务端 UPDATE 已提交但响应丢失的请求 SHALL 可经同一 `Idempotency-Key` 重放恢复,SHALL NOT 再次消耗配额。
- [AC-SESS-02] THE ShareAuthService SHALL 以「成功建立 ShareSession」为唯一的配额消耗事件;轮询、列表/详情/附件读取、页面刷新 SHALL NOT 改变 `used_sessions`。
- [AC-SESS-03] WHEN Visitor 在同一 tab 内刷新且 `sessionStorage` 键 `share:session:<lid>` 中的 token 仍在 TTL 内, THE 访客页 SHALL 凭该 token 恢复会话,SHALL NOT 新建 Session、SHALL NOT 消耗配额。
- [AC-SESS-04] WHEN Visitor 在无恢复凭据的新 tab/新浏览器打开同一链接, THE 访客页 SHALL 重新建立 Session 并消耗一次配额。
- [AC-SESS-05] THE ShareAuthService SHALL 为 sessionToken 设置绝对过期 `exp = min(share.expires_at, iat + SHARE_SESSION_TTL)`(默认 900 秒),SHALL NOT 提供任何续期路径。
- [AC-SESS-06] WHILE 一枚已签发的 sessionToken 未到自身 `exp` 且分享未被撤销、未过期、credentials_version 未变更, THE ShareAuthService SHALL 继续接受该 token 的读请求,即使 `used_sessions` 已达 `max_sessions`。
- [AC-SESS-07] WHEN `used_sessions` 达到 `max_sessions`, THE ShareAuthService SHALL 使后续 `POST /share/session` 一律失败,新访客 SHALL 无法建立访问。
- [AC-SESS-08] WHILE Visitor 的网络出口 IP 发生变化且 sessionToken 有效, THE ShareAuthService SHALL 继续接受该 token(token 自绑定),SHALL NOT 要求新建 Session。
- [AC-SESS-09] WHEN Session 建立成功, THE ShareAuthService SHALL 在响应中下发 `shareType`、绑定邮箱清单(经掩码策略处理)、`expiresAt` 与展示配置(`autoRefresh`/`refreshIntervalMs`/`otpExtractionEnabled`/`messageLimit`);统计字段(`last_access_at`)写入失败 SHALL NOT 阻断签发(沿用 fire-and-forget 语义)。
- [AC-SESS-10] WHEN Visitor 在 `POST /share/session` 携带 `Idempotency-Key`(客户端 SHALL 在发请求**前**生成并写入 sessionStorage), THE ShareAuthService SHALL 在成功签发后把 sessionToken 短存于 KV 键 `share:est:<lid>:<key>`,TTL = min(120 秒, token 剩余寿命);WHEN 同一 `Idempotency-Key` 重放命中缓存, THE ShareAuthService SHALL 返回缓存 token 且 SHALL NOT 再消耗配额、SHALL NOT 再执行条件 UPDATE;WHERE 请求无 key、key 未命中或缓存已过期, THE ShareAuthService SHALL 走 AC-SESS-01 正常条件 UPDATE;THE 访客页 SHALL 在超时/响应丢失后以同一 `Idempotency-Key` 重试,SHALL NOT 换 key 盲重试;IF KV 不可用, THEN THE ShareAuthService SHALL 仍正常签发(fail-open,该次无重放保护)并记 `share.system.error` 结构化日志(文档化风险,R3-A3);E2E SHALL 覆盖 `max_sessions=1` 下响应丢失后同 key 重试成功且 `used_sessions` 恒为 1。
- [AC-SESS-11] WHEN 配额条件 UPDATE 的 RETURNING 为空,或该语句本身抛错, THE ShareAuthService SHALL 拒绝签发 `sessionToken` 且 SHALL NOT 增加 `access_count`。本条取代旧 charter `mail-share` AC-LIFE-14 对配额闸门的适用(统计写失败仍签发);KV 写失败的 fail-open 仍由 AC-SESS-10 管辖。
- [AC-AUTH-01] WHERE 分享启用了 AuthKey, WHEN Visitor 提交的 `lid`+`sec` 匹配但未携带或携带错误 AuthKey, THE ShareAuthService SHALL 返回 `SHARE_AUTH_REQUIRED` 且 SHALL NOT 签发 token、SHALL NOT 消耗配额。
- [AC-AUTH-02] {revised: 2026-08-26, by: share-fullchain P4} THE ShareAuthService SHALL 仅在 `lid`+`sec` 校验通过后才暴露 `SHARE_AUTH_REQUIRED`;**`lid` 不存在与已撤销(gone)SHALL 返回浏览器原生 HTTP 404 空 body(`SHARE_DESTROYED` 内部码,见 mail-share AC-VISIT-04 修订)**;`sec` 错误、过期、配额触顶等其余 Visitor 失败 SHALL 统一返回不可区分的 `SHARE_UNAVAILABLE`。~~原文:含「lid 不存在、撤销」在内一切失败统一 `SHARE_UNAVAILABLE`~~——gone 一支被用户 P4 指令有意推翻。
- [AC-AUTH-03] THE ShareAuthService SHALL 以 `HMAC-SHA256(authKey, PEPPER[auth_key_kid])` 常量时间比较校验 AuthKey,SHALL NOT 存储或记录 AuthKey 明文。
- [AC-AUTH-04] WHEN Owner 重置或修改 AuthKey, THE MailShareService SHALL 将 `credentials_version` 加一;THE ShareAuthService SHALL 在每次 `resolveSession` 时比对 token 内版本号与行上 `credentials_version`,不一致 SHALL 立即拒绝(旧 Session 立即失效)。
- [AC-AUTH-05] THE ShareAuthService SHALL **仅**依赖既有 IP 边缘限流(AC-AUTH-06)作为 AuthKey 请求成本约束,SHALL NOT 维护任何 per-share 或 per-`(shareId, IP)` 失败计数、锁定状态或对应存储表(R2-A6:AuthKey 为 128-bit 服务端 CSPRNG 生成凭据,在线穷举不可行,「防猜中」不需要锁定机制);任一来源的 AuthKey 校验失败 SHALL NOT 影响其他访客的可用性,SHALL NOT 将分享置为不可用。
- [AC-AUTH-06] THE ShareAuthService SHALL 对 `POST /share/session` 沿用既有 IP 边缘限流(`SHARE_SESSION_RATE_LIMITER`),429 响应 SHALL 保持独立运输层语义,SHALL NOT 映射为 `SHARE_UNAVAILABLE`、SHALL NOT 消耗配额。
- [AC-AUTH-07] THE AuthKey SHALL 遵循状态机:`disabled`(默认,`auth_key_hash` IS NULL)→ `enable`(生成 hash,不加 `credentials_version`——既有 Session 建立时本无 Key 要求,不追溯失效)→ `reset`(换 hash,`credentials_version` 加一)→ `disable`(清空 hash,`credentials_version` 加一,旧 Session 失效);THE MailShareService SHALL 维持不变量 `auth_key_enabled=1` IFF `auth_key_hash IS NOT NULL`(禁止不一致组合);`PUT /mailShare/update` SHALL NOT 直接修改 `auth_key_hash`。
- [AC-AUTH-08] WHEN Owner 通过 `POST /mailShare/resetAuthKey` 提交 `action='disable'`, THE MailShareService SHALL 清空 `auth_key_hash`/`auth_key_kid`、置 `auth_key_enabled=0`、`credentials_version` 加一(既有 Session 立即失效);此后 Visitor 建立 Session SHALL 不再要求 AuthKey。

### Requirement 4(R4): 邮件可见范围与 message_limit

**User Story:** As an 邮箱所有者, I want 精确控制访客能看到每个邮箱的哪些、多少封邮件, so that 授权面永远不大于我的意图。

#### Acceptance Criteria (EARS)

- [AC-MAIL-01] WHILE ShareSession 有效, THE ShareScopedEmailRepository SHALL 只返回 `account_id` 属于该分享现存 Binding 集合的邮件(集合化 `inArray`,替换单值等值 `share-scoped-email-repository.js:60-68`),并保持 `account_id > 0`、`is_del = NORMAL`、`status != SAVING` 全部既有排除条件。
- [AC-MAIL-02] WHILE ShareSession 有效, THE ShareScopedEmailRepository SHALL 对每条 Binding 独立应用其 `window_start_email_id` 下界,SHALL NOT 用单一标量下界跨邮箱共用。
- [AC-MAIL-03] WHERE 分享配置了 `message_limit = N`, THE ShareMailService SHALL 将每条 Binding 的可见集限定为其 VisibleWindow 内按 `email_id` DESC 的最新 N 封;N=1 SHALL 为合法配置。
- [AC-MAIL-04] WHEN 新邮件到达使某 Binding 的最新 N 封集合滚动, THE ShareMailService SHALL 使最旧一封滚出可见集,后续列表与详情请求 SHALL NOT 再返回它。
- [AC-MAIL-05] WHEN Visitor 请求邮件详情或附件, THE ShareMailService/ShareAttachmentService SHALL 重新校验该邮件属于某条现存 Binding 的可见集(含 message_limit 截断),越界 SHALL 返回 `SHARE_UNAVAILABLE`;服务端 SHALL 为唯一强制点,SHALL NOT 依赖前端截断。
- [AC-MAIL-06] IF Visitor 篡改 `mailId`、`attachmentId`、`bindingId` 或任何查询参数指向绑定集合之外的邮箱/邮件, THEN THE ShareMailService SHALL 返回 `SHARE_UNAVAILABLE`,SHALL NOT 泄露目标是否存在。
- [AC-MAIL-07] THE ShareMailService SHALL 只返回白名单投影字段(扩展 `share-mail-service.js:46-63`,新增 Binding 标识与掩码后邮箱地址),SHALL NOT 返回 `user_id`、`account_id` 原始值、`is_del`、`status` 等内部字段。
- [AC-MAIL-08] WHERE `show_full_address=false`(默认), THE ShareMailService SHALL 对**系统生成的绑定邮箱身份字段**(session/status/list/detail 投影中的 mailbox address)以掩码形式(如 `a***@x.com`)返回;WHERE Owner 设置 `show_full_address=true`, THE ShareMailService SHALL 返回完整地址。掩码契约 SHALL NOT 承诺主题/正文/发件人字段中不出现绑定地址:发件人地址 SHALL 默认不掩码,命中绑定地址的主题/正文内容 SHALL NOT 被改写(SafeMailRenderer 原样渲染)。
- [AC-MAIL-09] WHERE `only_messages_after_created=false`, THE ShareScopedEmailRepository SHALL 以下界 0 查询历史邮件,可见集仍 SHALL 受 `message_limit` 约束。

### Requirement 5(R5): OTP 展示与自动刷新

**User Story:** As a 访问者, I want 页面自动刷新并醒目展示最新验证码且能一键复制, so that 我不用手动刷新就能在验证码时效内完成注册。

#### Acceptance Criteria (EARS)

- [AC-OTP-01] WHERE `otp_extraction_enabled=true`, THE ShareMailService SHALL 在投影中原样转发 `email.code`(只读单一真源),SHALL NOT 在分享链重新推断验证码。
- [AC-OTP-02] WHERE `otp_extraction_enabled=false`, THE ShareMailService SHALL 从 Visitor 投影中剔除 `code` 字段;访客页 SHALL 不渲染 OTP 高亮区;摄取链行为 SHALL NOT 因该开关改变。
- [AC-OTP-03] IF 某封邮件的 `email.code` 为空串(提取失败或未命中白名单), THEN THE 访客页 SHALL 仍完整展示该邮件的主题与正文,SHALL NOT 因缺验证码而隐藏邮件。
- [AC-OTP-04] WHEN 含验证码的新邮件进入可见集, THE 访客页 SHALL 在 OTP 高亮区展示最新验证码并提供一键复制(沿用三级复制降级 `useCopyWithFallback`)。
- [AC-OTP-05] WHERE `auto_refresh=true`(默认), THE 访客页 SHALL 以 `refresh_interval_ms`(默认 3000)为间隔轮询新邮件;WHERE `auto_refresh=false`, THE 访客页 SHALL 只提供手动刷新。
- [AC-OTP-06] THE MailShareService SHALL 在服务端强制 `refresh_interval_ms >= 3000`;IF 存量数据或请求给出更小值, THEN THE 下发给访客的配置 SHALL 被钳制为 3000。
- [AC-OTP-07] WHILE 多邮箱分享的访客页在轮询, THE 访客页 SHALL 每个轮询周期只向统一 StatusEndpoint 发起一次请求获知各 Binding 的最新水位并在本地比较得出新邮件标志,SHALL NOT 对 N 个邮箱发起 N 路并行轮询。
- [AC-OTP-08] WHEN 轮询收到 HTTP 429, THE 访客页 SHALL 按 `Retry-After` 退避后继续,SHALL NOT 视为死链、SHALL NOT 重建 Session。
- [AC-OTP-09] THE StatusEndpoint SHALL NOT 接受 `sinceEmailId` 或任何游标参数(R2-A2:单个全局标量无法表达 per-binding 消费水位);THE StatusEndpoint SHALL 始终返回每条 Binding 在其 VisibleWindow ∩ `message_limit` ∩ 既有排除条件(`is_del=NORMAL`、`status != SAVING`)内的 `latestEmailId`(无可见邮件时为 null)与可选 `latestReceivedAt`,SHALL NOT 反映可见集之外邮件的数量或存在性(禁止侧信道);hasNew/新邮件角标 SHALL 由客户端以本地 per-binding 水位比较得出(sessionStorage 按 `lid` 存 `{bindingId: watermark}` map),消费某 Binding 的 mails 后只推进该 Binding 的本地水位;WHEN Binding 集合增删或本地水位丢失, THE 访客页 SHALL 以本次返回的 per-binding `latestEmailId` 重建水位基准(首帧不渲染角标),已删 Binding 的水位 SHALL 被丢弃。

### Requirement 6(R6): Owner/Admin 管理面

**User Story:** As an 邮箱所有者(持 `share:manage` 路由权限), I want 一个独立管理页集中查看、编辑、撤销、删除我本人的分享, so that 我能审计并随时收窄已发出的授权。

> **授权矩阵(本期裁决)**:`share:manage` 仅为「操作本人分享」的路由级权限,全部 Owner 端点的资源谓词恒为 `user_id = 当前用户`;跨用户的管理员审计/处置不在本期。`security.js:163` 既有的 `c.env.admin` 邮箱豁免仅为运维超级账号的路由豁免,资源谓词不变,不构成跨租户产品能力。

#### Acceptance Criteria (EARS)

- [AC-ADMIN-01] THE 管理模块 SHALL 以独立路由页面(layout 内,权限 meta 沿用 `share:manage`)提供分享列表:名称、类型(单/多)、绑定邮箱、effectiveStatus、`used_sessions/max_sessions`、`expires_at`、`last_access_at`。
- [AC-ADMIN-02] THE MailShareService SHALL 提供 `GET /mailShare/get` 单条详情(含 Binding 清单与全部配置),仅返回本人分享;他人 `shareId` SHALL 返回 `SHARE_NOT_FOUND`。
- [AC-ADMIN-03] WHEN Owner 通过 `PUT /mailShare/update` 修改 `name`/`remark`/`max_sessions`/`message_limit`/`otp_extraction_enabled`/`auto_refresh`/`refresh_interval_ms`/`show_full_address`, THE MailShareService SHALL 校验后落库;变更 SHALL 于 Visitor 下一次请求生效(`max_sessions` 首次从 NULL 设为有限值的计数基线见 AC-EDGE-14)。
- [AC-ADMIN-04] IF Owner 将 `max_sessions` 下调至不大于当前 `used_sessions`, THEN THE MailShareService SHALL 接受该值,且分享的 effectiveStatus SHALL 即刻计算为 `ACCESS_LIMIT_REACHED`(已建立 Session 在自身 TTL 内不受影响)。
- [AC-ADMIN-05] WHEN Owner 通过 `POST /mailShare/resetAuthKey` 提交 `action='enable'|'reset'`, THE MailShareService SHALL 服务端生成新 Key、只存新 hash,并在响应中返回新 Key 明文恰好一次;`reset` SHALL 使 `credentials_version` 加一(旧 Session 立即失效),`enable` 不加(见 AC-AUTH-07);`action='disable'` 行为见 AC-AUTH-08。
- [AC-ADMIN-06] WHEN Owner 请求撤销(`DELETE /mailShare/revoke`), THE MailShareService SHALL 置 `status='REVOKED'` 并记录 `revoked_at`;撤销后 SHALL 不可重新启用。
- [AC-ADMIN-07] WHEN Owner 请求物理删除(`DELETE /mailShare/delete`), THE MailShareService SHALL 删除 `mail_share` 行及其全部 Binding 行与关联幂等行,SHALL NOT 留下孤儿子表行。
- [AC-ADMIN-08] THE 既有 ShareDialog(`mail-vue/src/views/email/ShareDialog.vue`) SHALL 继续可用为快捷创建入口,调用升级后的 create 契约;完整管理能力 SHALL 位于新建管理模块,SHALL NOT 塞回对话框。
- [AC-ADMIN-09] WHILE 分享 `effectiveStatus` 为 `EXPIRED`/`REVOKED`/`ACCESS_LIMIT_REACHED` 且未到 `delete_at`, THE 管理列表 SHALL 仍展示该行及其计算态,供 Owner 审计。
- [AC-ADMIN-10] IF 用户缺少 `share:manage` 权限, THEN THE Security 中间件 SHALL 对全部 `/mailShare/*` 端点返回 `SHARE_FORBIDDEN`。

### Requirement 7(R7): 安全边界

**User Story:** As a 平台运营者, I want 分享面上的每个公开接口都被限定在最小授权范围内, so that 泄露一条链接的影响面永远不超过这条链接本身。

#### Acceptance Criteria (EARS)

- [AC-SEC-01] THE 分享 URL SHALL 只含 `lid` 与 fragment 中的 `sec`,SHALL NOT 含 `mailbox_id`、`account_id`、真实邮箱地址或任何可据以鉴权的资源标识。
- [AC-SEC-02] THE Visitor 侧全部端点 SHALL 经 `share-auth-service` 无状态 token 鉴权 + 回源校验,SHALL NOT 复用登录态 JWT、`share:manage` 权限或 `/public/*` 全局 token。
- [AC-SEC-03] THE Security 中间件 SHALL 以精确 method+path 白名单(扩展 `security.js:23-29` `excludeExact`)豁免新公开端点,SHALL NOT 引入前缀通配豁免。
- [AC-SEC-04] THE ShareMailService SHALL 拒绝一切写操作(删邮件、标已读、发信、改邮箱、改分享自身);Visitor 面 SHALL 只存在读端点。
- [AC-SEC-05] THE ShareAttachmentService SHALL 继续经受控端点逐请求校验附件归属(扩展多 Binding 校验 `share-attachment-service.js:126-161`),SHALL NOT 下发 `/oss/<key>` 直链。
- [AC-SEC-06] THE 访客页(单/多邮箱) SHALL 保持匿名 chunk 隔离:不引入登录态 axios、layout、Dexie 或 `websiteConfig`(守护测试 `mail-vue/src/views/share/assert-share-chunk.js` 扩展覆盖新页面)。
- [AC-SEC-07] WHEN Visitor 离开分享路由或收到 `SHARE_UNAVAILABLE`, THE 访客页 SHALL 清除对应 `share:session:<lid>` 存储(沿用 mail-share 旧 charter 的 VISIT-14/15 清理契约,含多邮箱路由)。{amended: 2026-08-26, by: share-fullchain P4} 收到 gone(HTTP 404 → `ShareGoneError`)同样 SHALL 先清除 `share:session:<lid>` 与 `share:est-key:<lid>` 再离开页面(reload/清空文档)。
- [AC-SEC-08] THE ShareAuthService SHALL 对 AuthKey 与 `sec` 的一切比较使用常量时间比较;配额等一切服务端状态变更 SHALL 以单条原子条件写实现,SHALL NOT 采用先读后写两步。
- [AC-SEC-09] THE MailShareApp SHALL NOT 将 `sec`、AuthKey 明文或 sessionToken 写入服务端日志、URL 查询串或 `Referer` 可见位置。
- [AC-SEC-10] IF 请求路径形如 `/share-evil` 等前缀近似路径, THEN THE Security 中间件 SHALL 不予豁免(精确匹配封闭性,沿用 mail-share 旧 charter 的 LEAK-06 基线)。

### Requirement 8(R8): 生命周期(过期/撤销/配额/级联)

**User Story:** As an 邮箱所有者, I want 链接在到期、撤销、配额耗尽、邮箱删除时按明确规则失效, so that 我能确定授权终点在哪里。

#### Acceptance Criteria (EARS)

- [AC-LIFE-01] THE MailShareService SHALL 只持久化 `ACTIVE`|`REVOKED` 两个状态;`EXPIRED` 与 `ACCESS_LIMIT_REACHED` SHALL 为每次访问实时计算的派生态,SHALL NOT 落库。
- [AC-LIFE-02] THE ShareAuthService SHALL 按优先级计算 effectiveStatus:`REVOKED`(持久) > `EXPIRED`(`expires_at <= now`) > `ACCESS_LIMIT_REACHED`(`max_sessions IS NOT NULL AND used_sessions >= max_sessions`) > `ACTIVE`。
- [AC-LIFE-03] WHEN 分享被撤销, THE ShareAuthService SHALL 使一切既有 sessionToken 的下一次请求即刻失败(每请求回源判定),Visitor SHALL 立即不可读。
- [AC-LIFE-04] WHILE 分享 `effectiveStatus=ACCESS_LIMIT_REACHED`, THE ShareAuthService SHALL 拒绝新建 Session,同时 SHALL 继续服务 TTL 内既有 Session 的读请求。
- [AC-LIFE-05] WHEN 分享过期(`expires_at <= now`), THE ShareAuthService SHALL 同时拒绝新建 Session 与既有 token 读请求(token `exp` 不晚于 `expires_at`,双重封顶)。
- [AC-LIFE-06] WHEN 定时清理任务运行, THE MailShareCleanupTask SHALL 在删除到期 `mail_share` 行的同一批次删除其全部 `mail_share_binding` 行(扩展 `mail-share-cleanup-service.js:26-27`),SHALL NOT 留下孤儿 Binding。
- [AC-LIFE-07] WHERE 管理员关闭分享功能(`SHARE_ENABLED`), THE ShareAuthService SHALL 视为临时冻结:Visitor 全线 `SHARE_UNAVAILABLE`,重开后此前 `ACTIVE` 分享恢复可用。
- [AC-LIFE-08] THE 存量单邮箱分享链接 SHALL 在迁移(Binding 回填)后继续有效:旧 token 可验、旧 `/s/<lid>#<sec>` 可建新 Session、行为与迁移前一致(`max_sessions=NULL` 不限、配置取默认值)。
- [AC-LIFE-09] WHEN account 删除触发级联, THE MailShareService SHALL 经 Binding JOIN 定位受影响分享(替换 `mail-share-service.js:394-415` 的主表 `account_id` 直查),按 AC-BIND-05/06 语义处置。
- [AC-LIFE-10] THE 发布协议(R2-A1 发布栅栏 · R3-A1 升级为全能力栅栏) SHALL 分阶段消解滚动发布双轨:(Expand)新代码 SHALL 将 `mail_share.account_id` 双写为主 Binding 的 `account_id`(SHALL NOT 写 0),并 SHALL 将 `mail_share.window_start_email_id` 双写为主 Binding 快照(`only_messages_after_created=true` 时为该 Binding 的 `MAX(email_id)`,false 时为 0),以免兼容窗口内旧 Worker 读到默认 0 而越权放出创建前邮件;新建分享与增删 Binding 后 SHALL 同步更新这两列;全部新策略能力 SHALL 受 `SHARE_CAPABILITY_V2`(默认 false,取代 R2 的 `SHARE_MULTI_ENABLED`)统一门控(能力清单与激活前置见 AC-LIFE-11);新代码读路径 SHALL 只信 Binding,旧 Worker 仍可按主表 `account_id` 读旧语义;(Contract,后续版本)确认无旧 Worker 在途后才 SHALL 停止双写;回滚预案 = 关闭 `SHARE_CAPABILITY_V2`,单邮箱分享因双写 SHALL 在旧 Worker 下保持可用。四条路径验收:① 旧实例晚写(旧 Worker 新建行无 Binding)→ 发布收尾重跑幂等回填后旧链接在新代码下有效;② Binding 移除后旧实例读取 → 双写使主表列同步为剩余主 Binding(删空则 REVOKED,旧 Worker 读 status 即拒),不按已移除邮箱授权;③ 回滚读取 → V2 开启前无 multi 行、无 AuthKey、无有限配额,异常回滚(已开 V2 后关闭)时旧 Worker 按主 Binding 提供单邮箱降级视图,不越权;④ 滚动窗口随机路由 → 开关 false 期间 SHALL 不存在任何旧 Worker 无法执行的已写入策略(AC-LIFE-11 拒绝写入),故 SHALL NOT 出现「新代码启用 AuthKey/有限配额/多 Binding,请求落旧 Worker 被绕过」的策略降级路径。

- [AC-LIFE-11] THE MailShareService 与前端 SHALL 以 `SHARE_CAPABILITY_V2`(环境变量,默认 false)为全部新策略能力的唯一激活栅栏(R3-A1):WHILE 开关为 false, THE MailShareService SHALL 拒绝(`SHARE_INVALID_CONFIG`)一切旧 Worker 无法执行的策略写入——① create 携带 `accountIds.length > 1`;② `PUT /mailShare/bindings` 使现存 Binding 数大于 1 的变更;③ 启用 AuthKey(create `authKeyEnabled=true` 或 resetAuthKey `action='enable'`);④ 将 `max_sessions` 设为非 NULL 有限值(create 或 update);⑤ 将 `message_limit` 设为非 NULL(旧 Worker 不认识该列,写入有限 N 会在随机路由下放出超出 N 的邮件)——此时系统行为 SHALL 等同旧 mail-share 单邮箱语义(双写仍进行),Visitor 侧依赖新策略字段的前端功能 SHALL 以「能力未激活」提示降级、SHALL NOT 报错死链;WHEN 开关置 true, THE 发布负责人 SHALL 已确认全部激活前置:迁移完成、最终回填重跑完成、无旧 Worker 在途、关键日志事件已有告警消费者(R3-A7 发布门槛);已按 V2 写入的策略 SHALL NOT 因开关回退被静默改写,回退后按 AC-LIFE-10 路径③降级语义处置。

### Requirement 9(R9): 异常与极端场景

**User Story:** As a 平台运营者, I want 边界与异常场景有确定行为, so that 极端输入不产生越权、误计费或不可判定状态。

#### Acceptance Criteria (EARS)

- [AC-EDGE-01] WHEN 同一 Visitor 在 TTL 内以同一 sessionToken 高频轮询, THE ShareAuthService SHALL 保持 `used_sessions` 不变(轮询零配额消耗;仅受 429 边缘限流约束)。
- [AC-EDGE-02] WHEN 第 `max_sessions` 次 Session 建立成功后立即有并发的第 `max_sessions+1` 次建立请求, THE ShareAuthService SHALL 凭单条原子条件 UPDATE 保证恰好 `max_sessions` 次成功,SHALL NOT 出现超发。
- [AC-EDGE-03] {revised: 2026-08-26, by: share-fullchain P4} WHEN Visitor 正在浏览时 Owner 撤销分享, THE 访客页 SHALL 在下一次轮询/请求收到 **HTTP 404(gone)** 后停止轮询、清除会话存储、写入 `share:gone:<lid>` 记账并 **reload 一次**;reload 的文档请求 SHALL 被 worker 文档拦截答以浏览器原生 404(不经 worker 的开发环境 SHALL 清空文档兜底,禁止 reload 循环)。~~原文:收到 `SHARE_UNAVAILABLE` 后展示不可用态~~——撤销一支被用户 P4 指令有意推翻;非撤销的不可用(过期/冻结等)仍按原文展示 SPA 不可用态。
- [AC-EDGE-04] WHEN Visitor 正在浏览多邮箱分享时其中一个邮箱被 Owner 移除或删除, THE 访客页 SHALL 在下一次拉取后不再展示该邮箱及其邮件,剩余邮箱 SHALL 不受影响。
- [AC-EDGE-05] WHEN Owner 重置 AuthKey 时有 Visitor 正持有效 Session, THE ShareAuthService SHALL 使该 Session 的下一次请求因 `credentials_version` 不匹配而失败;Visitor 重新进入 SHALL 需要新 AuthKey 且消耗新配额。
- [AC-EDGE-06] IF `message_limit=1` 且窗口内恰有一封邮件, THEN THE ShareMailService SHALL 返回恰这一封;WHEN 更新的邮件到达, THE ShareMailService SHALL 只返回新的一封。
- [AC-EDGE-07] IF 分享创建后其邮箱从未收到新邮件, THEN THE 访客页 SHALL 展示空列表与等待态,SHALL NOT 报错或泄露历史邮件。
- [AC-EDGE-08] IF Visitor 提交的 `bindingId` 属于其他分享, THEN THE ShareMailService SHALL 返回 `SHARE_UNAVAILABLE`,SHALL NOT 泄露该 Binding 是否存在。
- [AC-EDGE-09] WHEN 迁移后旧行 `access_count` 列已有历史值(承载领域量 `used_sessions`)且 `max_sessions=NULL`, THE ShareAuthService SHALL 不对其施加配额判定(历史统计不追溯为配额消耗)。
- [AC-EDGE-10] IF `SHARE_SESSION_TTL` 大于分享剩余有效期, THEN THE ShareAuthService SHALL 以 `expires_at` 截短 token `exp`(`exp = min(expires_at, iat + TTL)`)。
- [AC-EDGE-11] WHEN StatusEndpoint 与 mails 端点在同一轮询周期被调用, THE ShareAuthService SHALL 均按读请求处理(零配额消耗、同一 token、同一范围校验)。
- [AC-EDGE-12] IF Visitor 携带错误 AuthKey 尝试建立 Session, THEN THE ShareAuthService SHALL 返回 `SHARE_AUTH_REQUIRED` 且 SHALL NOT 消耗配额、SHALL NOT 触发任何锁定或失败计数(R2-A6);WHEN 请求被 IP 边缘限流拦截, THE 响应 SHALL 保持独立的 HTTP 429 运输层语义(不映射业务码、不消耗配额,同 AC-AUTH-06)。
- [AC-EDGE-13] WHEN Session 建立请求与 revoke、到期、`resetAuthKey`(reset/disable)或删空 Binding 并发,且状态变更提交于条件 UPDATE **之前**, THE ShareAuthService SHALL 凭单一线性化点(AC-SESS-01)正确拒绝签发:零配额消耗、无超发;IF 状态变更提交于条件 UPDATE 成功**之后**、issueToken/响应返回之前(已知极窄 TOCTOU 窗口,R2-A3), THEN 该次已签发 token 的首次回源请求 SHALL 失败(`SHARE_UNAVAILABLE`),且已消耗的名额 SHALL NOT 退还——此为文档化的既定行为,SHALL NOT 被解释为「响应时保证可用」类承诺;THE 系统 SHALL NOT 为消除该窗口引入服务端 Session/Grant 存储。

- [AC-EDGE-14] WHEN Owner 首次将某分享的 `max_sessions` 从 NULL 更新为有限值, THE MailShareService SHALL 默认按 `resetUsedSessions=true` 处理:将物理列 `access_count` 置 0(历史观测计数不追溯为配额消耗,建立配额纪元基线,R2-A5);WHERE Owner 显式提交 `resetUsedSessions=false`, THE MailShareService SHALL 保留现有计数(可能立即 `ACCESS_LIMIT_REACHED`,属 Owner 显式选择,SHALL 原样接受)。

## Decision Record(2026-08-24 · 用户裁决,勿再列为雾区)

| # | 裁决 | 内容 |
|---|---|---|
| D1 | 统一模型 | 单/多邮箱共用 `MailboxShare` + `ShareMailboxBinding`;`share_type`=`single`\|`multi` |
| D2 | 复用既有 | `lid`+`sec` fragment、HMAC pepper、无状态 Session token(`s1.`)、`share-auth-service`、`share-scoped-email-repository`、`useSharePolling`、SafeMailRenderer、`share:manage`;就地演进 `mail_share` + 新 binding 表,不推倒重建 |
| D3 | 新旧关系 | 新 slug `mailbox-share-capability`,`related_specs: [docs/specs/mail-share]`;旧单邮箱链接继续有效(迁移回填 Binding);旧 `ShareDialog` 可继续调 create(升级 payload);完整管理模块新建;发布后不立刻 supersede。**R2-A1**:滚动发布走 Expand(双写主 Binding)→ Contract 分阶段协议;**R3-A1**:门控升级为 `SHARE_CAPABILITY_V2` 全能力发布栅栏(取代 `SHARE_MULTI_ENABLED`,覆盖 multi/1→N/AuthKey 启用/有限配额,见 AC-LIFE-10/11 与 design「迁移/发布协议」) |
| D4 | Session 计数 | 建立 Session 计 1(既有 `access_count` 语义升级为 `used_sessions`);轮询/刷新/同 tab sessionStorage 恢复不计;新 tab 无恢复凭据则新建并计数 |
| D5 | max_sessions | 累计建立次数上限(非并发)。触顶 → effectiveStatus `ACCESS_LIMIT_REACHED`(计算态,不落库)。已建立 Session 在自身 TTL 内可继续用,禁止新建。**R2-A5**:首次从 NULL 设为有限值时默认 `resetUsedSessions=true`(`access_count` 置 0);显式 false 保留计数(见 AC-EDGE-14) |
| D6 | Session TTL | 默认 15min(`SHARE_SESSION_TTL`),绝对、不续期;上限受 `expires_at` 约束 |
| D7 | IP 变化 | 不新建 Session(token 绑定) |
| D8 | 认证 Key | 可选第二因子(默认关);独立于 fragment `sec`;只存 `auth_key_hash`(复用 digest+pepper);生成/修改/重置;重置或修改后 bump `credentials_version`,旧 Session 立即失效 |
| D9 | 暴力防护 | **R2-A6 定稿(推翻 R1-A6 的锁定方案)**:仅依赖既有 IP 边缘限流;删除 `mail_share_auth_fail` 失败计数/锁定表——AuthKey 为 128-bit 服务端 CSPRNG 凭据,在线穷举不可行,per-share 锁定属未量化威胁下的运维负担且会牵连共享 NAT 合法访客(见 AC-AUTH-05/AC-EDGE-12) |
| D10 | message_limit | 每绑定邮箱各自最近 N 封(DESC),N=1 合法;服务端强制 |
| D11 | only_messages_after_created | true → per-binding `window_start_email_id` 快照;false → 下界 0(仍受 N 限制) |
| D12 | otp_extraction_enabled | 仅控制访客投影是否返回/展示 `code`(不改摄取链);提取失败仍展示邮件 |
| D13 | auto_refresh / refresh_interval | 写入 share 配置下发访客;默认开、默认 3000ms;服务端强制下限 ≥3000 |
| D14 | 邮箱脱敏 | **展示偏好,非安全边界(R2-A7)**:访客默认掩码系统投影中的绑定邮箱地址;Owner 可设 `show_full_address`;发件人默认不掩码;不承诺主题/正文不出现绑定地址 |
| D15 | 聚合增删邮箱 | 立即影响下次拉取;删光绑定则撤销分享;某个 account 被删 → 剔除该 Binding,剩余继续;若剩 0 → 撤销 |
| D16 | 实时 | 继续客户端轮询;多邮箱用统一 status 端点(一次请求返回各 Binding `latestEmailId` 水位,hasNew 由客户端本地比较,R2-A2),禁止 N 路并行轮询 |
| D17 | ShareAccessEvent | 本期不做独立事件表(deferred);保留 `used_sessions`/`last_access_at` |
| D18 | 预设 | Phase1 前端常用预设(单邮箱验证码/临时邮箱/多邮箱验证码池/自定义),不落 DB;环境变量上限保留 |
| D19 | 状态机 | 持久化 `ACTIVE`\|`REVOKED`;计算态 `ACTIVE`\|`EXPIRED`\|`REVOKED`\|`ACCESS_LIMIT_REACHED` |
| D20 | ADR | 需要后继 ADR(多邮箱 Binding + Session 配额闸门 + auth_key),Proposed stub:`docs/architecture/ADR-mailbox-share-capability-extension.md` |

## Update Log

- 2026-08-24 · executor(规格撰写执行者):Mode 1 CREATE 首次落盘。基于三份 recon(`.agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-{backend,frontend,crosscut}.md`)与用户 2026-08-24 需求书 20 条裁决;Success State 逐字来自主调度器交付契约;本步不写 tasks.md。
- 2026-08-24 · executor(R1 修订执行者)消化第 1 轮异构评审 `review.sub.md`(过筛:全采纳):
  - R1 · A1 → 采纳(物理列保留 `access_count` 名,expand-only 不 RENAME;领域/AC 继续称 `used_sessions`,改 Glossary、AC-SESS-01、AC-EDGE-09)
  - R1 · A2 → 采纳(`share_type` 不落库,由 Binding 计数实时派生;改 Glossary MailboxShare 与 AC-CAP-02,Binding 表为唯一真源)
  - R1 · A3 → 采纳(掩码契约收窄为系统生成的绑定邮箱身份字段;主题/正文/发件人不承诺、命中内容不改写;改 Glossary 地址脱敏与 AC-MAIL-08)
  - R1 · A4 → 采纳(AC-SESS-01 重写为单一线性化点:条件 UPDATE 含 `status='ACTIVE'`+`expires_at>now`+`credentials_version`;新增 AC-EDGE-13 并发矩阵)
  - R1 · A5 → 采纳(AuthKey 状态机 disabled→enable→reset→disable;新增 AC-AUTH-07/08,改 AC-ADMIN-05 支持 action 参数)
  - R1 · A6 → 采纳(锁定 scope 收窄为 `(shareId, IP)`,10 次/5 分钟滚动、成功清零;改 AC-AUTH-05、AC-EDGE-12,标注 D9)
  - R1 · A7 → 采纳(Status 游标协议:sinceEmailId 缺省 0、客户端持有推进、计数限 VisibleWindow ∩ message_limit、禁止侧信道;新增 AC-OTP-09)
  - R1 · A8 → 采纳(R6 用户故事收窄为本人分享;`share:manage` 为路由级权限,`c.env.admin` 豁免仅运维超级账号,补授权矩阵说明)
  - R1 · A9 → 采纳(Binding INSERT 单语句条件写含 account 存活/归属条件,失败 `SHARE_ACCOUNT_FORBIDDEN`,清理路径补偿孤儿;新增 AC-BIND-10)
  - R1 · F1 → 采纳(AuthKey 规格 128-bit CSPRNG、base64url、22 字符定长可测,校验仅 trim;改 AC-CAP-05)
  - R1 · F2 → 采纳(list 分页契约落在 design.md API 表;requirements 无对应 AC 需改)
  - R1 · F3 → 采纳(结构化日志事件清单落在 design.md;requirements 无对应 AC 需改)
- 2026-08-24 · executor(R2 修订执行者)消化第 2 轮异构评审 `review2.sub.md`(主 AI 过筛:P0/P1 全采纳、P2 轻量):
  - R2 · A1 → 采纳(滚动发布分阶段协议:Expand 双写 `mail_share.account_id`=主 Binding、禁止写 0,`SHARE_MULTI_ENABLED` 门控,读路径只信 Binding,Contract 后停双写;改 Glossary 增「主 Binding」、AC-BIND-01,新增 AC-LIFE-10 含三条路径验收,标注 D3)
  - R2 · A2 → 采纳(唯一裁决:StatusEndpoint 不接受 sinceEmailId,始终返回 per-binding `latestEmailId`(可 null)+可选 `latestReceivedAt`,hasNew 由客户端本地水位比较、sessionStorage 按 lid 存 map,全局轮询单次;重写 AC-OTP-09、改 AC-OTP-07、Glossary StatusEndpoint、D16)
  - R2 · A3 → 采纳(线性化承诺收敛:条件 UPDATE 成功时刻为配额与授权线性化点,UPDATE→issueToken 并发失效属已知极窄 TOCTOU、token 回源失败且名额不退还;删「响应时保证可用/绝不即死」措辞;重写 AC-EDGE-13,不引入服务端 Session 表)
  - R2 · A4 → 采纳(回填 SQL JOIN account 且 `is_del=NORMAL` 且 `user_id` 匹配;不满足旧行迁移时直接 REVOKED 不建 Binding;新增迁移门禁 AC-BIND-11,改 AC-BIND-09)
  - R2 · A5 → 采纳(首次将 `max_sessions` 从 NULL 设为有限值默认 `resetUsedSessions=true` 置 0 计数,显式 false 保留计数可能立即触顶;新增 AC-EDGE-14,改 AC-ADMIN-03,标注 D5)
  - R2 · A6 → 采纳(删除 `mail_share_auth_fail` 表与全部相关契约;AuthKey 暴力防护仅依赖既有 IP 边缘限流;重写 AC-AUTH-05 为「无锁定状态」、AC-EDGE-12 为「错误 Key 不消耗配额 + 429 独立」;改 AC-SEC-08 去锁定措辞,D9 重写)
  - R2 · A7 → 采纳(脱敏归类为展示偏好、非安全/隐私边界;改 Glossary 地址脱敏与 D14;design 侧移入 UI/投影节)
  - R2 · F1 → 采纳(不变量收紧:enabled ⇒ hash 非空且 `auth_key_kid` 非空;落 design AuthKey 状态机与 AC-AUTH-07 验证行)
  - R2 · F2 → 采纳(日志事件补 `share.migrate.invalid_row`/`share.system.error`,每条带 requestId/shareId 无凭据;落 design 结构化观测节,requirements 无对应 AC 需改)
  - AC 总数 99 → 102(+AC-BIND-11、+AC-LIFE-10、+AC-EDGE-14)。
- 2026-08-24 · executor(R3 修订执行者)消化第 3 轮异构评审 `review3.sub.md`(主 AI 过筛裁决:3 P0 + 4 P1 采纳;P2-F1/F2 不在本轮指令内,未动):
  - R3 · A1 → 采纳(`SHARE_MULTI_ENABLED` 升级为 `SHARE_CAPABILITY_V2` 全能力发布栅栏,默认 false;false 时拒绝 multi 创建/bindings 使绑定数>1/AuthKey 启用/有限 `max_sessions` 四路策略写入,行为等同旧单邮箱、双写仍进行,Visitor 侧前端以「能力未激活」降级;激活前置=迁移完成+最终回填+无旧 Worker+告警消费者就绪;改写 AC-LIFE-10 为四条路径验收,新增 AC-LIFE-11,标注 D3)
  - R3 · A2 → 采纳(迁移无效行判定改为显式 account 事实谓词 `ACTIVE AND (account 不存在 OR is_del!=NORMAL OR user_id 不匹配)`,禁止以「无 Binding」判脏;回填 INSERT 与 UPDATE 之间旧 Worker 新写的合法无 Binding 行不误 REVOKED,由幂等回填重跑收编;改写 AC-BIND-11 并补交错时序测试要求)
  - R3 · A3 → 采纳(裁决配额成功口径=「客户端可恢复地获得凭据」;`POST /share/session` 支持 `Idempotency-Key`,成功后 sessionToken 短存 KV `share:est:<lid>:<key>`(TTL=min(120s, token 剩余寿命)),同 key 重放返回缓存 token 不再消耗配额;KV 不可用 fail-open 签发、无重放保护、记 `share.system.error`、文档标风险;改 AC-SESS-01 叙述,新增 AC-SESS-10)
  - R3 · A4 → 采纳(bindings 批量变更全有或全无原子命令;remove 以 `binding_id+share_id+owner` 三重谓词;跨分享/跨租户 bindingId 混入 → 整单 `SHARE_BINDING_FORBIDDEN`;1→N 受 V2 开关约束;新增 AC-BIND-12)
  - R3 · A5 → 采纳(每分享 Binding 上限常量 `SHARE_BINDING_LIMIT`=50,超限整单 `SHARE_BINDING_LIMIT_EXCEEDED`;新增 AC-CAP-13)
  - R3 · A6 → 采纳(create 响应丢失恢复:幂等重放仅返回 shareId/lid 无明文 → UI 引导 Owner revoke/delete 后重新 create,禁止换 `Idempotency-Key` 盲建;新增 AC-CAP-14)
  - R3 · A7 → 采纳(「启用 `SHARE_CAPABILITY_V2` 前关键日志事件必须已有告警消费者」纳入发布门槛一句话,落 AC-LIFE-11 与 design 结构化观测节;完整 Runbook 不在本期)
  - AC 总数 102 → 108(+AC-LIFE-11、+AC-SESS-10、+AC-BIND-12、+AC-CAP-13、+AC-CAP-14、+AC-SESS-11)。
