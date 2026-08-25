# Requirements · mail-share

## Introduction

给邮箱所有者一种把「某个邮箱在一段时间内收到的邮件」临时授权给一个未登录的人查看的能力，而不必交出邮箱账号密码。核心场景是把登录验证码转交给他人：所有者创建一条不可猜的链接，访问者打开即可看到授权范围内的邮件与自动识别出的验证码，链接到期或被销毁后立即不可用。

本 charter 的范围是**严格最小集**（用户 2026-08-16 裁决，R2 方案收缩 2026-08-17 修订，R3 定稿 2026-08-17）：分享链接、有效期、随时销毁、验证码展示与一键复制（复用既有 `email.code`）、新邮件客户端增量轮询（默认 3 秒）、仅可见创建后的邮件、分享管理列表、正文双模式渲染（纯文本 / 沙箱 iframe 完整 HTML 可切换）、附件经 ShareAuthService 受控下载端点（**不**下发公开 `/oss/<key>` 直链）。访问密码、访问次数上限、阅后即焚、发件人与主题过滤、二维码、Webhook、IP 白名单、设备绑定、确定性 OTP 打分器、`PUT /mailShare/regenerate`、服务端 25 秒长轮询均**不在本期**。

**本期保留的管理字段及其业务场景**（用户 R1 裁决 · F3）：

| 字段 | 角色 | 业务场景 | 缺失损失 | 分类 |
|---|---|---|---|---|
| `name` | Owner | 管理列表中区分「给同事 A 的链接」与「给客服 B 的链接」 | Owner 只能凭创建时间辨认，易误关仍在使用的分享 | A 业务必需 |
| `remark` | Owner | 记录用途或接收方，便于日后审计自己开过哪些授权 | 无法回忆链接用途，增加误操作风险 | A 业务必需 |
| `access_count` | Owner | 列表展示「持链者是否成功建立过 Share Session」 | Owner 无法判断链接是否曾被打开过（不等于收件人已阅读） | B 管理可观测 |
| `last_access_at` | Owner | 列表展示「最后一次成功建立 Share Session 的时间」 | Owner 无法判断链接最近是否仍被访问（不等于收件人已阅读） | B 管理可观测 |

以上字段仅 Owner 可见；Visitor 侧不返回。**语义边界（R2-A5 · 用户 R2 裁决）**：二者只表示「某次持链者成功建立过 Session」，**不是**「收件人已阅读 / 已交付 / 已复制验证码」的证明；链接转发、自动化访问、重复刷新均会写入。写入时机为 Share Session **建立成功时**（见 AC-LIFE-10），**不是**每次轮询，故不构成读路径写放大。

## Success State (§0.16 · MANDATORY · sourced)

NOT「新增了 `/s/:token` 路由且接口返回 200」，
BUT「一个从未登录本系统的人，只凭所有者给他的一条链接，就能在浏览器里看到该邮箱在授权时间窗内收到的邮件和其中的验证码，并把验证码复制走；链接到期或被所有者销毁后，同一条链接立即不再显示任何邮件内容」。

Must NOT happen：
- 访问者看到授权范围之外的任何邮件（其他邮箱、其他用户、创建分享之前的历史邮件）。
- 访问者获得任何写能力（删除、发信、标记已读、改设置、改分享本身）。
- 分享链接的秘密部分出现在服务端访问日志、`Referer` 头或 CDN 缓存中。
- 邮件发信人可控的内容在分享页或登录态详情页中获得脚本执行能力。

Source：用户原话（2026-08-16 需求书第一节场景 1-6、第五十一节「Share Minimum Required Information」）+ 用户 R1 三项裁决（正文双模式 / 严格最小集）+ 用户 R2 方案收缩（完整 HTML 沙箱渲染 / 附件提供 / 登录态渲染器一并交付 / 不做 OTP 打分器）。

Verified once by：在一个全新的浏览器上下文（无 localStorage、无 IndexedDB、未登录）中依次访问有效链接、随机 token、已过期链接、已销毁链接；期间从外部向该邮箱真实投递一封含验证码的邮件，观察它在不刷新页面的情况下出现在页面上。非单元测试。

## Glossary

- **MailShare**：一条分享授权记录。D1 表 `mail_share`，一行 = 一位所有者对一个邮箱（`account`）在一个时间窗内的一次只读授权。
- **Owner**：创建 MailShare 的登录用户，即 `mail_share.user_id`，取自 `mail-worker/src/security/user-context.js:5-7` 的 `c.get('user').userId`。
- **Visitor**：持有分享链接的未登录访问者。无 JWT，无 `user` 上下文。
- **Share Lookup Id (`lid`)**：分享链接中用于定位记录的公开半，128-bit CSPRNG，base64url，明文存于 `mail_share.lid` 并建唯一索引。它不是秘密。
- **Share Secret (`sec`)**：分享链接中的秘密半，256-bit CSPRNG，base64url。**只以 `HMAC-SHA256(sec, PEPPER[kid])` 存库**，并记录 **`pepper_kid`** 标识所用 PEPPER 版本；明文仅在创建时返回一次。PEPPER 轮换采用与 Session 签名密钥相同的 **`kid` + 新旧双 key 验证窗口**（默认 ≤7 天）；轮换期间须能验证旧 PEPPER 签名的存量链接，**不得**因正常轮换使全部存量链接瞬间失效。密钥丢失或紧急吊销行为见 design.md「Share Secret 密钥生命周期」。
- **Share URL**：`https://<host>/s/<lid>#<sec>`。`sec` 位于 URL fragment，浏览器不会将其发往服务器。
- **Share Session**：Visitor 用 `lid` + `sec` 换取的短期凭据，用于后续拉取邮件列表与轮询新邮件，避免 `sec` 反复出现在请求中。`sessionToken` 以 **`share:session:<lid>`** 为键写入 `sessionStorage`（见 AC-VISIT-12、AC-VISIT-13）；清理契约见 AC-VISIT-14~15。令牌无状态、带绝对 `exp`，默认 **15 分钟**（`SHARE_SESSION_TTL`，只减不续），且每次请求回源重算 Share `effectiveStatus`（AC-LIFE-01）。
- **OTP**：邮件中的一次性验证码。现有链路把 LLM 抽取结果存于 `email.code`（`mail-worker/src/entity/email.js:10`）；分享页**只读**该字段，不在投影链重新推断。
- **Safe Mail Renderer**：全站唯一的邮件正文安全渲染器。用沙箱 iframe（`sandbox` 不含 `allow-scripts` / `allow-same-origin`）+ `srcdoc` 内层 CSP `script-src 'none'` 原样承载邮件 HTML，取代现有 `mail-vue/src/components/shadow-html/index.vue:33` 的裸 `shadowRoot.innerHTML` 写入。登录态详情页与分享页共用。
- **Share Status（持久化）**：MailShare 的可操作生命周期状态，**仅持久化** `ACTIVE` / `REVOKED` 两值。
- **Effective Status（计算态）**：Owner 列表与 Visitor 鉴权统一使用的展示/判定状态。若持久化状态为 `REVOKED` → `REVOKED`；否则若 `expires_at ≤ 当前时间` → `EXPIRED`；否则 → `ACTIVE`。过期**不**写入数据库（AC-LIFE-01）。
- **Visible Window**：Visitor 可见的邮件时间范围，由 `mail_share.window_start_email_id` 界定（仅创建之后收到的邮件）。

## Requirements

### Requirement 1: 创建分享链接

**User Story:** As an 邮箱所有者, I want 为我的某个邮箱生成一条带有效期的分享链接, so that 我可以把收验证码的能力临时交给别人而不交出账号密码。

#### Acceptance Criteria (EARS)

- [AC-SHARE-01] WHEN Owner 对自己名下的一个 `account` 请求创建分享, THE MailShareService SHALL 创建一条 `mail_share` 记录并在响应中返回完整 Share URL。
- [AC-SHARE-02] THE MailShareService SHALL 用 CSPRNG 生成 `lid`（128 bits）与 `sec`（256 bits），二者相互独立。
- [AC-SHARE-03] THE MailShareService SHALL 将 `sec` 的 `HMAC-SHA256(sec, PEPPER[pepper_kid])` 摘要存入 `mail_share.sec_hmac`，并 SHALL 记录所用 `pepper_kid`；且 SHALL NOT 将 `sec` 明文写入任何数据库列、日志或响应之外的位置。
- [AC-SHARE-04] THE MailShareService SHALL 在响应中返回 `sec` 明文恰好一次；后续任何查询接口 SHALL NOT 再返回 `sec` 或可据以重建 `sec` 的数据。
- [AC-SHARE-05] IF 请求中的 `accountId` 不属于当前 Owner, THEN THE MailShareService SHALL 拒绝创建并返回业务错误码 `SHARE_ACCOUNT_FORBIDDEN`。
- [AC-SHARE-06] THE MailShareService SHALL 在**单条 SQL 语句**内读取该邮箱当前最大 `email_id` 并插入 `mail_share` 行（`INSERT ... SELECT COALESCE(MAX(email_id), 0) ...`），以**该语句执行顺序**作为 Visible Window 的唯一线性化切点，并把该 `email_id` 记入 `window_start_email_id`。（T-02 证实：D1 拒绝 drizzle `.transaction()` 的 SQL `BEGIN`；单语句隐式事务即可。）
- [AC-SHARE-07] WHERE 管理员配置了最大有效期, IF 请求的有效期超过该上限, THEN THE MailShareService SHALL 拒绝创建并返回业务错误码 `SHARE_DURATION_EXCEEDED`。
- [AC-SHARE-08] THE MailShareService SHALL 为每条 MailShare 记录 `expires_at`，其值等于创建时刻加所选有效期。
- [AC-SHARE-09] WHERE Owner 提交了分享名称或备注, THE MailShareService SHALL 存储该值并仅向 Owner 返回。
- [AC-SHARE-10] THE MailShareService SHALL 允许同一个 `account` 同时存在多条 MailShare 记录。
- [AC-SHARE-11] WHEN Owner 在 `POST /mailShare/create` 请求中携带 `Idempotency-Key` 请求头, THE MailShareService SHALL 在 24 小时窗口内对同一 Owner + 同一 Key + 等价请求体（`accountId`、`durationSeconds`、`name`、`remark` 均相同）返回相同 `shareId` 与 `lid`；**仅首次**响应含 `sec` 明文，重放响应 SHALL 含 `idempotentReplay: true` 且 SHALL NOT 再返回 `sec`。
- [AC-SHARE-12] WHERE 管理员配置了单 Owner 活跃分享上限, THE MailShareService SHALL 用**单条条件 INSERT** 完成「计数当前 `effectiveStatus=ACTIVE` 的记录 + 条件插入」（`WHERE (SELECT COUNT(*) ...) < limit`）；IF 计数已达上限 THEN SHALL 返回 `SHARE_LIMIT_EXCEEDED` 且 SHALL NOT 留下部分写入；调用方以 `RETURNING` 行数 **和/或** `meta.changes` 区分已应用与未应用。
- [AC-SHARE-13] WHEN Owner 在 `POST /mailShare/regenerate` 携带 `Idempotency-Key`, THE MailShareService SHALL 在 24 小时窗口内对同一 Owner + 同一 Key + 同一 `shareId` 返回相同的新 `lid`；**仅首次**响应含新 `sec`；重放响应含 `idempotentReplay: true` 且 SHALL NOT 再返回 `sec`。IF 同一 Key 用于**另一条** `shareId`, THEN SHALL 返回 `SHARE_IDEMPOTENCY_CONFLICT`（AC-SHARE-14 同款）。`operation` 是 `share_idempotency` 唯一键的一部分，所以同一把 Key 在 `create` 与 `regenerate` 两个写入口之间互不重放。（T-20a 落地；动词由 R2 的 `PUT` 改为 `POST`，理由见 design.md）
- [AC-SHARE-14] IF 同一 Owner 在 24 小时窗口内对同一 `Idempotency-Key` 提交**不等价**请求体（规范化请求指纹不同），THEN THE MailShareService SHALL 返回稳定业务错误码 `SHARE_IDEMPOTENCY_CONFLICT`，SHALL NOT 返回先前成功响应。
- [AC-SHARE-15] WHEN `POST /mailShare/create` 成功写入 Share 行, THE MailShareService SHALL 用 **`c.env.db.batch()`** 将 Share 行与对应 `share_idempotency` 行**原子提交**；IF batch 中任一语句失败 THEN 整个 batch SHALL 回滚，SHALL NOT 留下孤儿 Share 或孤儿幂等记录。batch 内语句**不得**消费同 batch 中前序语句的结果——两语句共用的值（如 `lid`）须在 JS 中预先计算并分别绑定。（T-02 证实：drizzle `.transaction()` 在本运行时不可用；`batch()` 可回滚。）
- [AC-SHARE-16] THE MailShareService SHALL **不**采用 `create_time` + `email_id` 复合游标退路——AC-SHARE-06 的单语句 `INSERT ... SELECT MAX(email_id) ...` 已提供唯一线性化切点，**无需**复合游标；复合游标语义**保留为文档退路，本期不实施**。（T-02 修正：此前「D1/drizzle `.transaction()` 已确认可用」为**错误**——API 存在但运行时 D1 拒绝 SQL `BEGIN`，回调从未执行；见 `mail-worker/test/transaction.spec.js`。）

**幂等与并发语义（A4 · R2-A4 收敛 · R3-A4 定稿）**：定位为**重复操作检测**，**不是**可恢复幂等——`sec` 不可再次读取是安全不变量，幂等重放**不得**重复下发 `sec`；`sec` 丢失即丢失，同一条 `sec` 再也取不回来；但 Owner 不必 revoke + create 重配一遍，**`POST /mailShare/regenerate` 就地换一条新 `lid`+`sec`**（AC-LIFE-05：有效期与可见窗口原样保留）。**规范化请求指纹**：对 `accountId`、`durationSeconds`、`name`、`remark` 做稳定 JSON 规范化（键排序、空字符串与缺省等价）后 SHA-256，存入 `share_idempotency.request_fingerprint`；同 Key 仅当指纹匹配时视为等价重放。幂等记录**单一真源**为独立表 `share_idempotency`（见 design.md），**不在** `mail_share` 行上重复存储。**清理顺序**：24 小时到期先删幂等行，再按 `delete_at` 删 Share 行；清理任务失败 SHALL 可安全重试。活跃数量上限不得采用「先 SELECT COUNT 再 INSERT」的两步模式。

### Requirement 2: Visitor 访问分享

**User Story:** As a 未登录的访问者, I want 打开别人给我的链接就能看到授权范围内的邮件, so that 我不必注册或登录就能拿到我需要的验证码。

#### Acceptance Criteria (EARS)

- [AC-VISIT-01] WHEN 浏览器请求 `/s/<lid>`, THE MailShareApp SHALL 返回一个不含任何邮件内容的落地页。
- [AC-VISIT-02] THE MailShareApp SHALL 在落地页阶段 SHALL NOT 产生任何持久状态变更。
- [AC-VISIT-03] WHEN Visitor 提交 `lid` 与 `sec` 请求建立 Share Session, THE ShareAuthService SHALL 用 `HMAC-SHA256(sec, PEPPER[pepper_kid])` 与 `mail_share.sec_hmac` 做常量时间比较，并 SHALL 在 PEPPER 轮换窗口内尝试当前与上一 `pepper_kid`。
- [AC-VISIT-04] IF `lid` 不存在、或 `sec` 摘要不匹配、或 `effectiveStatus` 不是 `ACTIVE`, THEN THE ShareAuthService SHALL 返回同一个不可区分的错误码 `SHARE_UNAVAILABLE`。
- [AC-VISIT-11] WHILE Share Session 有效, THE ShareMailService SHALL 通过 `Authorization: Bearer <sessionToken>` 请求头承载会话凭据；SHALL NOT 在查询参数或请求体中重复发送 `sec`。
- [AC-VISIT-05] WHILE Share Session 有效, THE ShareMailService SHALL 只返回同时满足以下**全部**条件的邮件：`account_id` 等于 `mail_share.account_id`（**且** `mail_share.account_id > 0`）、`email_id` 大于 `mail_share.window_start_email_id`、`is_del = NORMAL`（`0`）、`status != SAVING`（排除收件两阶段写入中间态；`is_del` 列同时承担用户删除与收件未完成两种语义，见 design.md）。
- [AC-VISIT-16] WHILE 邮件处于收件保存中间态（`status = SAVING` 或 `is_del != NORMAL`）, THE ShareMailService SHALL NOT 将其返回于列表或详情；即使其 `email_id` 落在 Visible Window 内亦 SHALL 排除。
- [AC-VISIT-06] THE ShareMailService SHALL 只返回 design.md 中列明的白名单字段，SHALL NOT 返回 `user_id`、`account_id`、`is_del`、`status` 等内部字段。
- [AC-VISIT-07] WHEN Visitor 请求邮件列表或邮件详情, THE ShareAuthService SHALL 在每次请求时重新计算 `effectiveStatus`，SHALL NOT 依赖建立 Share Session 时的判定结果。
- [AC-VISIT-08] THE ShareMailService SHALL 拒绝一切写操作请求，包括删除邮件、标记已读、发送邮件、修改邮箱与修改 MailShare 自身。
- [AC-VISIT-09] IF Visitor 请求的 `emailId` 不在 Visible Window 内, THEN THE ShareMailService SHALL 返回 `SHARE_UNAVAILABLE`，SHALL NOT 返回该邮件是否存在的信息。
- [AC-VISIT-10] THE MailShareApp SHALL 在分享页 SHALL NOT 加载任何第三方来源的脚本。
- [AC-VISIT-12] WHEN Share Session 建立成功, THE MailShareApp SHALL 将 `sessionToken` 写入 `sessionStorage` 键 **`share:session:<lid>`**；刷新同一标签页且仍停留在分享路由 SHALL 可凭该 token 恢复会话（fragment 已在首次读取后清除，刷新只能靠该 token）；关闭标签页后 SHALL 失效；SHALL NOT 跨 tab 共享；fragment 中的 `sec` 读取后 SHALL 立即清除（见 design.md Fragment 清除段）。token 受绝对 TTL 约束（默认 15 分钟）；TTL 内刷新可恢复，TTL 后须再次提交 `lid`+`sec` 重建会话。
- [AC-VISIT-13] THE MailShareApp SHALL 按 `lid` 隔离 `sessionStorage` 键；WHEN 同一 tab 先后打开不同 `lid` 的分享链接, THE MailShareApp SHALL NOT 误用另一 `lid` 的 token，并 SHALL 清除已不再使用的旧 `lid` 存储项。
- [AC-VISIT-14] THE MailShareApp SHALL 在以下时机清除当前 `lid` 的 `share:session:<lid>`：**(a)** `POST /share/session` 鉴权失败；**(b)** 任意分享 API 返回 `SHARE_UNAVAILABLE`（含 Share 已撤销或已过期）；**(c)** Visitor 显式退出。清理属于**安全契约**（同源页面脚本可读 `sessionStorage`），不是纯 UX 细节。
- [AC-VISIT-15] WHEN Visitor **离开分享路由**（Vue 路由 `name !== 'share'`，含导航至 `/login`、layout 内页面), THE MailShareApp SHALL **立即清除**当前 `lid` 的 `share:session:<lid>`；理由：分享凭据不得在同 tab 的其他同源页面继续暴露；若需再次访问须重新打开含 `#<sec>` 的完整链接（fragment 已在首次读取后清除）。本条由 SPA 路由守卫兑现。硬导航（地址栏输入、外链、任何非 SPA 跳转）不跑该守卫，token 可能残留于同 tab `sessionStorage`，直至 Session TTL 或关 tab（见下方已知限制）。

**已知限制（AC-VISIT-12 与 AC-VISIT-15 冲突 · 用户 2026-08-17 裁决）**：AC-VISIT-15 要求离开分享上下文即销毁 token；AC-VISIT-12 要求分享路由内刷新仍能恢复会话。`pagehide` 不能用来补硬导航清理——它在刷新时也会触发，而刷新时 fragment 已经清掉，只剩 `sessionStorage` 里的 token 能让 AC-VISIT-12 成立。两则 AC 在 `sessionStorage` 方案下无法同时被干净满足。本期接受该残留暴露：仅同 tab、同源，且被 Session 绝对 TTL（默认 15 分钟）封顶；token 只授予访问者已经用完整链接换到的只读能力，不含写权限。过期 token **不得**用来续期。Share 行仍为 `ACTIVE` 时，访问者可再次 `POST /share/session` 提交 `lid`+`sec` 建立新会话（页面内存中保留的 `sec`，或重新打开含 `#<sec>` 的原链接）；该路径 SHALL NOT 因 fragment 已从 URL 清除而死结。

### Requirement 3: 生命周期与状态

**User Story:** As an 邮箱所有者, I want 链接到期或我主动销毁后立刻失效, so that 我能确定别人不会在我预期之外继续读我的邮件。

#### Acceptance Criteria (EARS)

- [AC-LIFE-01] THE ShareAuthService SHALL 在每次访问时以服务端当前时间与 `mail_share.expires_at` 比较判定是否过期，SHALL NOT 依赖定时任务改写状态。
- [AC-LIFE-02] WHEN Owner 请求销毁一条 MailShare, THE MailShareService SHALL 将 `status` 置为 `REVOKED` 并记录 `revoked_at`。
- [AC-LIFE-03] WHEN 一条 MailShare 被销毁后再次被访问, THE ShareAuthService SHALL 返回 `SHARE_UNAVAILABLE`。
- [AC-LIFE-04] IF 一条 MailShare 已被销毁, THEN THE MailShareService SHALL 拒绝对其做任何状态变更，包括延长有效期与重新启用。
- [AC-LIFE-05] WHEN Owner 对 `effectiveStatus=ACTIVE` 的 MailShare 请求重新生成链接, THE MailShareService SHALL 生成新的 `lid` 与 `sec` 并使旧链接立即失效；SHALL **保持**原 `expires_at` 与 `window_start_email_id`（Visible Window）不变；且 SHALL 将 `credentials_version` 加一，使在途 Visitor Session 当场失效。（T-20a 落地，见 design.md「regenerate 约定」）
- [AC-LIFE-11] IF MailShare 的 `effectiveStatus` 为 `EXPIRED` 或 `REVOKED`, THEN THE MailShareService SHALL 拒绝 `regenerate` 并返回 `SHARE_NOT_FOUND`（与他人/不存在共用同一个码，存在性探针保持封闭）；过期授权 SHALL NOT 通过只换 `lid`/`sec` 原地复活，Owner 须新建一条授权。（T-20a 落地）
- [AC-LIFE-06] THE MailShareService SHALL 区分 `expires_at`（链接失效时刻）与 `delete_at`（记录物理清除时刻），且 `delete_at` SHALL 晚于 `expires_at`。
- [AC-LIFE-07] WHEN 定时任务运行, THE MailShareCleanupTask SHALL 只删除 `delete_at` 早于当前时间的记录。
- [AC-LIFE-08] WHILE 一条 MailShare 的 `effectiveStatus` 为 `EXPIRED` 或 `REVOKED` 且尚未到 `delete_at`, THE MailShareService SHALL 仍向 Owner 展示该记录及其 `effectiveStatus`（含由 `expires_at` 实时计算出的 `EXPIRED`）。
- [AC-LIFE-09] IF MailShare 指向的 `account` 已被删除, THEN THE ShareAuthService SHALL 返回 `SHARE_UNAVAILABLE`。
- [AC-LIFE-12] WHEN MailShare 指向的 `account` **转移所有者**（`account.user_id` 变更）, THE MailShareService SHALL **永久撤销**所有指向该 `account_id` 的 MailShare（写入 `status='REVOKED'` 与 `revoked_at`），SHALL NOT 仅在访问时动态拒绝而保留 `ACTIVE` 行。**注**：仓内**当前不存在** Account 转移能力——本条为未来新增转移入口时的必挂钩点；**本期**撤销挂钩实现于 account **软删与硬删**路径（与 AC-LIFE-09 协同）。
- [AC-LIFE-13] WHERE 管理员关闭了分享功能, THE MailShareService SHALL 将其视为**临时冻结**：关闭期间 Visitor 访问返回 `SHARE_UNAVAILABLE`；**重新开启后**，此前 `effectiveStatus=ACTIVE` 的 MailShare SHALL **恢复可用**，SHALL NOT 被视同永久销毁（Owner 须知晓：关停不等于终止授权，只是暂停）。
- [AC-LIFE-14] WHEN Share Session 建立成功, IF 更新 `access_count` 或 `last_access_at` 失败, THEN THE ShareAuthService SHALL **仍**返回有效 `sessionToken`；统计字段写入失败 SHALL NOT 阻断合法 Session 建立。 — superseded by docs/specs/mailbox-share-capability/requirements.md AC-SESS-11（配额闸门引入后不再成立；KV 写失败 fail-open 见该 charter AC-SESS-10）
- [AC-LIFE-10] WHEN Share Session 建立成功, THE ShareAuthService SHALL 尝试更新 `last_access_at` 与 `access_count`（语义见 Introduction 管理字段表；**不是**每次轮询或每次读邮件）；写入失败的处理见 AC-LIFE-14。

### Requirement 4: 新邮件实时出现

**User Story:** As a 持有分享链接的访问者, I want 分享期间新到的验证码自动出现在页面上, so that 我不必反复手动刷新页面。

#### 读模型契约（A5 · R3-A3 定稿）

- **稳定排序**：邮件按 `email_id` 升序；`email_id` 在同一 `account` 内单调递增且唯一。
- **分页**：`GET /share/mails?cursor=<emailId>&limit=<n>`；`cursor` 为上一页最后一条的 `mailId`（对外即 `email_id`）；`limit` 默认 20、上限 50；首屏无 `cursor` 时返回窗口内最早的 `limit` 条。
- **游标语义（R3-F1）**：`cursor` 表示「Visitor 已确认的最大 `email_id`」。重复请求同一 `cursor` SHALL 保证**稳定排序、不重复、不跳过**；**不**承诺动态邮件集合的内容恒等（新邮件到达后同一 `cursor` 可能返回更多行）。
- **批量返回**：单次 `GET /share/mails` 若有多封新邮件，SHALL 按 `email_id` 升序返回**全部**新邮件（上限 20 条/批），游标推进至本批最大 `email_id`。
- **断线重连**：客户端保存最后已知游标；重连后用该游标调用 `GET /share/mails`，SHALL NOT 重复展示已确认邮件。
- **客户端增量轮询（本期基线）**：**参照**仓内增量游标思路（`mail-vue/src/views/email/index.vue:76-131`），**但须新建** composable（带 `onUnmounted` 取消、`visibilitychange`/`document.hidden` 后台暂停、429 退避——既有内联 `while(true)` 无卸载清理且卸载后循环仍跑）：前台每 **3 秒**调用 `GET /share/mails?cursor=<lastKnown>`；后台暂停；收到 HTTP **429** 时读取 `Retry-After` 并按退避策略等待（见 AC-ABUSE-09）。**不**实施服务端 `/share/wait` 长轮询。
- **后续升级项（服务端长轮询）**：仅当需要**稳定亚秒级**延迟、或生产实测证明 3 秒轮询不满足业务时再引入 `GET /share/wait`；届时须补并发容量模型、指数退避+jitter、Worker 重启与 429/5xx 降级契约（见 design.md Decision 3）。

#### Acceptance Criteria (EARS)

- [AC-RT-01] {status: deprecated, by: R3-A3} ~~WHILE Share Session 有效且页面处于前台, THE SharePollingEndpoint SHALL 在收到请求后最多保持 25 秒等待新邮件。~~（本期改客户端 3 秒增量轮询，见 AC-RT-14）
- [AC-RT-02] {status: deprecated, by: R3-A3} ~~WHEN Visible Window 内出现 `email_id` 大于 Visitor 已知游标的邮件, THE SharePollingEndpoint SHALL 立即返回该邮件。~~（服务端 wait 本期不做）
- [AC-RT-03] {status: deprecated, by: R3-A3} ~~IF 等待窗口内没有新邮件, THEN THE SharePollingEndpoint SHALL 返回空结果并携带当前游标。~~（服务端 wait 本期不做）
- [AC-RT-04] THE ShareMailService SHALL 在 `GET /share/mails` 查询中使用 `account_id` 与 `email_id` 上的索引，SHALL NOT 执行全表扫描。
- [AC-RT-05] WHILE 页面处于后台, THE ShareView SHALL 暂停轮询。
- [AC-RT-06] {status: deprecated, by: R3-A3} ~~IF Share 的 `effectiveStatus` 在轮询期间变为非 `ACTIVE`, THEN THE SharePollingEndpoint SHALL 返回 `SHARE_UNAVAILABLE` 并终止本次等待。~~（改由 AC-RT-16：客户端轮询收到 `SHARE_UNAVAILABLE` 后停止）
- [AC-RT-07] {status: deprecated, by: R3-A3} ~~THE SharePollingEndpoint SHALL 在响应中设置 `Cache-Control: no-store`。~~（改由 AC-LEAK-02 覆盖分享接口）
- [AC-RT-08] THE ShareMailService SHALL 对 `GET /share/mails` 强制执行 `limit` 上限 50；超出请求值的 `limit` SHALL 截断为 50。
- [AC-RT-09] THE ShareMailService SHALL 按 `email_id` 升序返回列表；对同一 `cursor` 的重复请求 SHALL 保证稳定排序、不重复、不跳过；SHALL NOT 承诺返回内容集合恒等。
- [AC-RT-10] {status: deprecated, by: R3-A3} ~~THE SharePollingEndpoint SHALL 在请求与响应中使用数值型 `cursor`（=`email_id`）；空结果时响应中的 `cursor` SHALL 等于请求中的游标或窗口内当前最大已知值。~~（游标语义改由列表接口 AC-RT-09/12/14 定义）
- [AC-RT-11] {status: deprecated, by: R3-A3} ~~WHEN 等待期间到达多封邮件, THE SharePollingEndpoint SHALL 在单次响应中返回按 `email_id` 升序排列的全部新邮件（最多 20 条）。~~（改由 AC-RT-14 批量返回语义）
- [AC-RT-12] WHEN Visitor 断线后携带上次响应中的 `cursor` 重连, THE ShareMailService SHALL 只返回该游标之后的新邮件，SHALL NOT 重复返回已确认邮件。
- [AC-RT-13] {status: deprecated, by: R2-A3} ~~IF 单条 MailShare 的 in-flight `/share/wait` 连接数已达 5, THEN THE SharePollingEndpoint SHALL 拒绝新连接并返回 `SHARE_UNAVAILABLE`。~~（Workers 无共享内存，精确 in-flight 上限不可执行）
- [AC-RT-14] WHILE Share Session 有效且页面处于前台, THE ShareView SHALL 每 **3 秒**调用 `GET /share/mails?cursor=<lastKnown>` 拉取新邮件；IF 返回新邮件 THEN SHALL 更新本地游标并展示。
- [AC-RT-15] WHEN 客户端轮询收到 HTTP **429**, THE ShareView SHALL 读取 `Retry-After` 响应头并按其指示等待后再重试；SHALL NOT 将 429 当作 `SHARE_UNAVAILABLE`。
- [AC-RT-16] IF 轮询期间 Share 的 `effectiveStatus` 变为非 `ACTIVE`, THEN THE ShareMailService SHALL 返回 `SHARE_UNAVAILABLE`；THE ShareView SHALL 停止轮询并展示链接不可用。

### Requirement 5: 验证码展示

**User Story:** As a 持有分享链接的访问者, I want 页面直接把验证码显著地展示出来并让我一键复制, so that 我不必在邮件正文里找它。

#### 策略（R2-A1 · 用户 R2 方案收缩）

本期**不做**确定性 OTP 打分器、候选模型、置信度阈值或 HTML 转文本再推断。分享投影链**只读**邮件域既有权威结果 `email.code`（LLM 抽取，字段已存在于 `email` 表）：非空则在分享页顶部展示并提供一键复制；为空则不展示验证码区块。若未来样本证明需增强识别，应把统一抽取/归一化移到**邮件摄取链**，使所有消费者读同一结果——**不在** Share 投影时重新推断（改进版事项）。

> **2026-08-25 后续：上面那句「改进版事项」已经兑现。** 用户报告识别不可靠（`email.code` 由单次 LLM 调用产出，提示词硬编码「≤8 字符无空白」，且失败即空、无任何兜底），并追加了「验证链接」这一新字段的需求。增强按本段自己指定的方向落在**邮件摄取链**：确定性提取优先、AI 补位，两个字段（码与链接）各自独立求解，结果落 `email.code` 与 `email.verify_link` 两列。
>
> **本段的收缩结论继续有效，一个字未改**：分享投影链仍然只读邮件行上的既有结果，不重新推断（Decision 6 / 不变量 P-OTP-03）。变的只是"那个结果由谁、在哪一层、用什么方式算出来"。被废弃的 AC-OTP-01~05/10~13 保持废弃状态——它们描述的是**在投影层**打分，那个位置至今仍是错的。
>
> 摄取链侧的新验收标准见 **Requirement 5.1**；决策与权衡见 `.agent-workspace/.archive/2026-08-25/share-extract/share-extract-decision-card.md`。

#### Acceptance Criteria (EARS)

- [AC-OTP-01] {status: deprecated, by: R2-A1} ~~WHEN 一封邮件进入 Visible Window, THE DeterministicOtpScorer SHALL 从邮件主题与正文中产出零个或多个候选码，每个候选码带一个 0 到 1 之间的置信度。~~（用户 R2 裁决：本期不做确定性打分器）
- [AC-OTP-02] {status: deprecated, by: R2-A1} ~~THE DeterministicOtpScorer SHALL 对与验证码关键词邻近的候选码提高评分，关键词表 SHALL 同时包含中文与英文词条。~~
- [AC-OTP-03] {status: deprecated, by: R2-A1} ~~THE DeterministicOtpScorer SHALL 对标注排除样本集中的 token 降低置信度至阈值以下。~~
- [AC-OTP-04] {status: deprecated, by: R2-A1} ~~WHERE 邮件文本包含 `@<domain> #<code>` 形式的域绑定行, THE DeterministicOtpScorer SHALL 直接采用其中的码并赋予最高置信度。~~
- [AC-OTP-05] {status: deprecated, by: R2-A1} ~~WHERE 确定性最高分候选的 `confidence ≥ OTP_CONFIDENCE_THRESHOLD`, THE ShareMailService SHALL 返回该候选及其置信度与来源 `deterministic`。~~
- [AC-OTP-06] {status: deprecated, by: R1-F1} ~~IF DeterministicOtpScorer 未产出任何候选码而 `email.code` 非空, THEN THE ShareMailService SHALL 返回 `email.code` 并标记其来源为 LLM 抽取。~~（已由 AC-OTP-14 取代）
- [AC-OTP-07] THE ShareView SHALL 在展示验证码的同时展示该验证码所属邮件的发件人显示名与发件地址。
- [AC-OTP-08] WHEN Visitor 触发复制验证码, THE CopyComposable SHALL 使用 Clipboard API 写入剪贴板。
- [AC-OTP-09] IF Clipboard API 不可用, THEN THE CopyComposable SHALL 提供一个可供手动选中复制的降级路径，SHALL NOT 只提示复制失败。
- [AC-OTP-10] {status: deprecated, by: R2-A1} ~~THE DeterministicOtpScorer SHALL 在不调用任何外部服务的前提下完成打分。~~
- [AC-OTP-11] {status: deprecated, by: R2-A1} ~~WHERE 确定性最高分 `confidence < OTP_CONFIDENCE_THRESHOLD` 且 `email.code` 非空且归一化后与确定性候选不一致, THE ShareView SHALL 同时展示两个候选并分别标注来源 `deterministic` 与 `llm`。~~（用户 R2 裁决：不做双路合并）
- [AC-OTP-12] {status: deprecated, by: R2-A1} ~~WHERE `email.text` 为空且 `email.content` 含 HTML, THE ShareMailService SHALL 在调用打分器前从 HTML 剥离标签得到纯文本输入。~~
- [AC-OTP-13] {status: deprecated, by: R2-A1} ~~WHERE 确定性候选与 `email.code` 归一化后相同, THE ShareMailService SHALL 只返回一个验证码并标注来源 `deterministic`。~~
- [AC-OTP-14] WHERE `email.code` 非空（**空字符串 `''` 视为无验证码**，列定义 `text notNull default ''`，非 null）, THE ShareMailService SHALL 在 Visitor DTO 中原样返回该值；THE ShareView SHALL 在页面顶部展示并提供一键复制。
- [AC-OTP-15] WHERE `email.code` 为空字符串, THE ShareView SHALL NOT 展示验证码区块；THE ShareMailService SHALL NOT 在分享投影链中重新推断或打分。

### Requirement 5.1: 邮件内容提取（摄取链 · 2026-08-25）

**User Story:** As a 持有分享链接的访问者, I want 我点开的那一封邮件里的验证码或验证链接被直接呈现出来, so that 我不用在正文里翻找，也不会被上一封邮件的结果误导。

#### 策略

提取落在**邮件摄取链**（Requirement 5 策略段自己指定的方向），产出 `email.code` 与 `email.verify_link` 两个独立字段；分享投影链继续只读、不推断（Decision 6 / P-OTP-03 不变）。

顺序是**确定性优先、AI 补位**，不是反过来。三条依据：Workers AI 免费额度 10,000 neurons/天且**账户级共享**，逐封调用不可持续；防注入要求 AI 输出必须能在原文逐字回验，而回验依赖确定性候选集，所以确定性层无论如何都得存在；确定性层零成本、零注入面。

**链接提取的风险归属**：邮件正文由发件人控制，页面把其中一条链接挑出来放大展示这个动作本身构成背书——与是否用 AI 无关，纯规则提取一样会挑中攻击者放的链接。因此缓解落在**展示层**（AC-EXT-15），而不是靠约束 AI。

#### Acceptance Criteria (EARS)

- [AC-EXT-01] THE ExtractionPipeline SHALL 支持三种模式：`CLOSE`（完全不提取，**保持列默认值语义**）、`RULE_ONLY`（只跑确定性层）、`OPEN`（确定性优先 + AI 补位）；WHERE 模式为 `RULE_ONLY`, THE ExtractionPipeline SHALL NOT 发起任何 `env.ai` 调用。
- [AC-EXT-02] WHERE 确定性层对某字段已产出高置信结果, THE ExtractionPipeline SHALL NOT 就该字段调用 AI；AI 结果 SHALL 只填空或替换低置信结果，SHALL NOT 覆盖高置信的确定性结果。
- [AC-EXT-03] WHERE 邮件带 `One-Time-Code` 头, THE ExtractionPipeline SHALL 采纳其中的码并视该**字段**为已完成，SHALL NOT 因此终止链接字段的提取。
- [AC-EXT-04] THE ExtractionPipeline SHALL 对邮件主题与正文**各自独立**扫描候选码，SHALL NOT 将两者拼接后统一扫描（拼接会让主题中的关键词落入正文首个候选的邻域）；WHERE 两者均产出高置信结果, THE ExtractionPipeline SHALL 采用正文的结果。
- [AC-EXT-05] THE DeterministicExtractor SHALL 接受长度 4 到 8 的候选码，包含纯数字、字母数字混合与含单个连字符的形态；候选 SHALL 至少包含一个数字。
- [AC-EXT-06] WHERE 候选码邻域内同时存在正向与负向关键词, THE DeterministicExtractor SHALL 按**距离就近**仲裁归属，SHALL NOT 用加权求和（否则「验证码 918273。客服电话 555-…」中的合法码会被判死）。
- [AC-EXT-07] THE DeterministicExtractor SHALL 只接受 `http` 与 `https` 协议的链接候选。
- [AC-EXT-08] WHERE 调用 AI 补位, THE ExtractionPipeline SHALL 令其在既有候选中作选择：链接 SHALL 以候选下标形式返回且越界即丢弃，验证码 SHALL 能在归一化正文中逐字找到否则丢弃。
- [AC-EXT-09] IF AI 调用超过时限未返回, THEN THE ExtractionPipeline SHALL 放弃该结果并以确定性结果完成落库，SHALL NOT 阻塞邮件入库。
- [AC-EXT-10] THE ExtractionPipeline SHALL 区分并计数以下失败：AI 未绑定、额度耗尽、超时、返回非法 JSON、越界下标、逐字回验失败；SHALL NOT 将它们合并为单一「提取失败」。指标 SHALL NOT 含邮件正文。
- [AC-EXT-11] IF 写入 `verify_link` 列失败（迁移尚未执行）, THEN THE 摄取链 SHALL 降级为不带该列重写一次，SHALL NOT 因提取结果而丢弃邮件本身。
- [AC-EXT-12] WHERE `otpExtractionEnabled` 为 false, THE ShareMailService SHALL 在 Visitor DTO 中**同时省略** `code` 与 `link` 两个键（不是 null 占位）。
- [AC-EXT-13] THE ShareOtpCard SHALL 只呈现**当前选中邮件**的提取结果，SHALL NOT 在当前邮件无结果时回退展示其它邮件的结果。
- [AC-EXT-14] WHERE 验证码与验证链接任一非空, THE ShareOtpCard SHALL 展示对应区块；WHERE 两者皆空, THE ShareOtpCard SHALL 展示「未识别到验证码 / 验证链接」。
- [AC-EXT-15] WHERE 展示验证链接, THE ShareOtpCard SHALL 只渲染 `http`/`https` 协议的链接、SHALL 将完整 URL 作为可见文本、SHALL 以 `target="_blank"` 与 `rel="noopener noreferrer"` 打开，且措辞 SHALL 只陈述来源不作安全断言。

#### 已知边界（不是缺陷，是本轮取舍）

- **不回溯**：提取在收信时执行，功能上线前收到的邮件其 `verify_link` 恒空，UI 显示「未识别」。不做一次性回填，也不做读时惰性补算——后者会把 AI 调用搬到不受信任的访客请求路径上。
- **纯字母口令不支持**：候选要求至少含一个数字，否则正文里每个 4-8 字母英文单词都会成为候选。
- **指标无导出通道**：AC-EXT-10 的分类计数目前是进程内计数器，isolate 回收即清零。`unverified: 无落盘/上报链路`——「运维侧能分辨 AI 挂了」这一目标只做到了分类，未做到可观测。

### Requirement 6: 正文安全渲染（双模式）

**User Story:** As a 系统, I want 任何来自发信人的 HTML 在隔离沙箱中原样展示, so that 发信人无法在本站取得脚本执行能力，而访问者仍能看到完整邮件排版。

**产品定位（用户 R2 方案收缩）**：临时域名邮箱本身防护价值有限；同类临时邮箱产品均直接渲染完整 HTML 邮件。本期用**沙箱 iframe 原样承载**整封邮件 HTML，**删除** R1 的正向允许模型（元素/属性/协议白名单 + CSS 声明过滤 + URL 规范化 + srcset 处理）——它们比沙箱更复杂且破坏排版，在本产品定位下收益不成立。

#### 沙箱渲染模型

**载体**：`<iframe sandbox srcdoc="...">`，`sandbox` **不含** `allow-scripts` 与 `allow-same-origin`。浏览器在此组合下强制禁止 iframe 内脚本执行，且 iframe 文档无法访问父页面 cookie / localStorage / DOM。

**第二道闸门**：`srcdoc` 注入的 HTML 文档内设置 `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`（或等价 HTTP 头），作为脚本禁行的硬约束。Safari/WebKit 历史 bug：若未来需向 frame 传递事件而必须加 `allow-scripts`，**真正的脚本闸门退化为内层 CSP `script-src 'none'`**（须在实现与验收中验证）。

**原样展示**：不对邮件 HTML 做 DOMPurify 式正向白名单净化；**远程图片、表格、内联样式按邮件原样在 iframe 内渲染**（与「完整展示」定位一致；同类临时邮箱产品皆如此）。

**CSP 分层（R3-A2 · T-21 修正）**：分享页**外层** CSP（`mail-vue/public/_headers` 作用于 `/s/*` 主文档）约束分享壳本身。**关键修正**：`srcdoc` iframe **继承父文档 CSP**（CSP3 §7.8），故外层 `img-src 'self'` 会**阻断** iframe 内远程邮件图片——与 AC-SEC-23「默认加载远程图片」冲突。T-21 已将外层 `img`/`style`/`font`/`media` 放宽为 `http:`/`https:`（见 design.md 匿名 Bootstrap CSP 行）。内层 `srcdoc` 文档仍 SHALL 设置 CSP `script-src 'none'` 作为脚本第二闸门；远程资源加载的**已知代价**：发件方可借远程资源感知 Visitor IP、访问时间与 User-Agent。**unverified**：`run_worker_first = true` 下 `_headers` 是否作用于 Worker 经 `env.assets.fetch` 返回的响应——须真实部署确认（AC-LEAK-02~04）。

**iframe 高度（R3-A2 · 用户 R3 裁决）**：首期**放弃 iframe 自动高度**——在禁止 `allow-scripts` 与 `allow-same-origin` 时，`ResizeObserver`/`postMessage` 均不可行。**绝不为自动高度往 frame 内加脚本**。采用**固定合理高度 + iframe 内层滚动**展示完整正文。

**链接行为**：iframe 内外链 SHALL 使用 `target="_blank"` + `rel="noopener noreferrer"`（可在注入前对 `<a>` 做最小改写）。`target="_blank"` 能否在新标签打开 SHALL **逐浏览器验证**并记录所需 sandbox 能力（若缺 `allow-popups` 等则须在验收矩阵中固定组合）。

**降级**：若 iframe/`srcdoc` 注入失败，降级为纯文本（渲染 `text` 列），**绝不**降级为向主文档写入裸 HTML。

**交付边界（R2-A7 · 用户 R2 裁决）**：`SafeMailRenderer` 替换 `shadow-html/index.vue` 的裸 `innerHTML`，**登录态邮件详情页与分享页本期一并交付**（用户选择：沙箱方案增量小，不再拆独立前置）。回归验证范围：登录态正文排版、远程资源加载、分享页附件受控下载（**不**复用公开 `/oss/` 直链）。

#### Acceptance Criteria (EARS)

- [AC-SEC-01] THE SafeMailRenderer SHALL 默认以纯文本模式渲染邮件正文。
- [AC-SEC-02] WHERE Visitor 或登录用户显式切换到 HTML 模式, THE SafeMailRenderer SHALL 在沙箱 iframe 中**原样**渲染邮件 HTML（不经正向白名单净化）。
- [AC-SEC-03] {status: deprecated, by: R2+用户收缩} ~~THE SafeMailRenderer SHALL 用字符串输入方式调用净化库，SHALL NOT 使用原地净化模式。~~
- [AC-SEC-04] {status: deprecated, by: R2+用户收缩} ~~THE SafeMailRenderer SHALL 仅允许 design.md 列明的元素正向集合通过。~~
- [AC-SEC-05] {status: deprecated, by: R2+用户收缩} ~~THE SafeMailRenderer SHALL 移除全部事件处理器属性。~~
- [AC-SEC-06] {status: deprecated, by: R2+用户收缩} ~~THE SafeMailRenderer SHALL 在 URL 规范化后仅允许 `http`、`https`、`mailto` 协议。~~
- [AC-SEC-07] THE SafeMailRenderer SHALL 为 iframe 内外部链接设置 `target="_blank"` 与 `rel="noopener noreferrer"`。
- [AC-SEC-08] {status: deprecated, by: R2+用户收缩} ~~THE SafeMailRenderer SHALL 默认阻断远程图片加载。~~（原样展示邮件 HTML，含远程资源）
- [AC-SEC-09] THE SafeMailRenderer SHALL 在 `sandbox` **不含** `allow-scripts` 与 `allow-same-origin` 的 iframe 中渲染 HTML。
- [AC-SEC-10] THE SafeMailRenderer SHALL 被登录态邮件详情与分享页共同使用；登录态详情页 SHALL 替换现有 `shadow-html` 裸写入路径。
- [AC-SEC-11] {status: deprecated, by: R2+用户收缩} ~~THE ShareMailService SHALL NOT 在响应中返回附件元数据或附件访问地址。~~（用户 R2 裁决：本期提供附件；R3 改受控端点 AC-SEC-20/21）
- [AC-SEC-12] {status: deprecated, by: R2+用户收缩} ~~THE SafeMailRenderer SHALL 对内联 `style` 属性做属性级白名单过滤。~~
- [AC-SEC-13] {status: deprecated, by: R2+用户收缩} ~~THE SafeMailRenderer SHALL 对 `srcset` 中每个候选 URL 独立执行协议白名单校验。~~
- [AC-SEC-14] IF iframe/`srcdoc` 注入失败, THEN THE SafeMailRenderer SHALL 降级为纯文本渲染，SHALL NOT 回退到向主文档写入未隔离 HTML。
- [AC-SEC-15] THE SafeMailRenderer SHALL 通过 `srcdoc` 注入 iframe 内容，SHALL NOT 使用 `document.write` 或直接 `innerHTML` 写入主文档。
- [AC-SEC-16] THE SafeMailRenderer SHALL 在 `srcdoc` 文档内设置 CSP `script-src 'none'` 作为脚本禁行的第二道闸门。
- [AC-SEC-17] {status: deprecated, by: R3-A2} ~~THE SafeMailRenderer SHALL 实现 iframe 高度自适应，使完整邮件正文可见而无需手动滚动内层固定高度框。~~（禁止 frame 内脚本时自动高度不可实现；改 AC-SEC-22 固定高度+内层滚动）
- [AC-SEC-18] {status: deprecated, by: R3-A1} ~~THE ShareMailService SHALL 在 Visitor 邮件详情 DTO 中返回附件元数据（`filename`、`size`、`downloadUrl`），`downloadUrl` SHALL 复用登录态页面使用的既有公开直链（`/oss/<key>` 形态，无签名、无过期、不经分享后端鉴权）。~~（公开直链破坏临时授权边界；改 AC-SEC-20 受控端点）
- [AC-SEC-19] {status: deprecated, by: R3-A1} ~~THE ShareView SHALL 为每封含附件邮件展示附件列表并提供下载；**已知代价**：附件直链**不**随 MailShare 到期而失效——持有者可在分享失效后继续下载已知 URL（与登录态相同暴露面，不新增租户隔离突破）。~~（与核心契约冲突；改 AC-SEC-20/21）
- [AC-SEC-20] THE ShareMailService SHALL 在 Visitor 邮件详情 DTO 中返回附件元数据（`attachmentId`、`filename`、`size`）；`downloadUrl` SHALL 指向 **`GET /share/attachment?mailId=&attachmentId=`** 受控端点，SHALL NOT 返回公开 `/oss/<key>` 直链。
- [AC-SEC-21] WHEN Visitor 请求 `GET /share/attachment`, THE ShareAuthService SHALL 逐请求校验 Share Session 与 `effectiveStatus`；IF Share 已过期、已撤销或 account 已失效 THEN SHALL 拒绝下载；THE Worker SHALL 经对象读取封装（`r2-service` / `kv-obj-service` / `s3-service`）回传字节，**且须先归一化**各后端不一致的返回类型（KV/S3 返 `Response`，R2 返 `R2Object`，见 `r2-service.js:43-56`），SHALL NOT 让浏览器直连对象存储。**本端点只保证分享侧授权边界自洽**；既有 `/oss/*` 公开直链缺陷**不在本期修复**（见 design.md 既有缺陷 #1）。
- [AC-SEC-24] WHERE 邮件 `text` 为空且 `content` 含 HTML, THE SafeMailRenderer 在**默认纯文本模式**下 SHALL 直接呈现沙箱 iframe 渲染 HTML，并在 UI 中说明「该邮件无纯文本版本」；SHALL NOT 呈现空白页。
- [AC-SEC-22] THE SafeMailRenderer SHALL 为 HTML 模式 iframe 使用**固定高度 + 内层滚动**，SHALL NOT 依赖 `postMessage`/`ResizeObserver` 自动高度。
- [AC-SEC-23] THE SafeMailRenderer SHALL 在 iframe 内**默认加载**邮件 HTML 中的远程图片与样式；THE 文档 SHALL 明示发件方可借远程资源感知 Visitor 访问行为（IP、时间、UA）。

### Requirement 7: Owner 管理与可见性

**User Story:** As an 邮箱所有者, I want 看到我创建过的分享及其状态并随时关掉, so that 我不会忘记自己还开着哪些授权。

#### Acceptance Criteria (EARS)

- [AC-MGMT-01] WHEN Owner 请求分享列表, THE MailShareService SHALL 只返回 `user_id` 等于该 Owner 的记录。
- [AC-MGMT-02] THE MailShareService SHALL 在列表中返回邮箱地址、名称、状态、创建时刻、失效时刻、访问计数与最后访问时刻。
- [AC-MGMT-03] THE MailShareService SHALL 按 `user_id` 与 `status` 上的索引查询分享列表。
- [AC-MGMT-04] WHEN Owner 在邮箱界面查看, THE ShareIndicator SHALL 展示该邮箱当前处于 `effectiveStatus=ACTIVE` 的分享数量。
- [AC-MGMT-05] WHEN Owner 请求销毁分享, THE ShareDialog SHALL 先要求一次确认。
- [AC-MGMT-06] THE ShareDialog SHALL 在创建分享前提示「任何拿到此链接的人都可能查看你授权范围内的邮件」。
- [AC-MGMT-07] IF Owner 请求的 MailShare 不属于该 Owner, THEN THE MailShareService SHALL 返回 `SHARE_NOT_FOUND`。
- [AC-MGMT-08] {status: deprecated, by: R3-perm} ~~IF 当前用户角色缺少 `share:create` / `share:query` / `share:revoke` 中任一权限, THEN THE MailShareService SHALL 拒绝对应操作并返回业务错误码 `SHARE_FORBIDDEN`。~~（三份权限合并为单一 `share:manage`，见 AC-MGMT-09）
- [AC-MGMT-09] IF 当前用户角色缺少 `share:manage` 权限, THEN THE MailShareService SHALL 拒绝创建、列表与销毁等全部 Owner 分享操作并返回 `SHARE_FORBIDDEN`。

### Requirement 8: 传输与缓存隔离

**User Story:** As a 系统, I want 分享链接的秘密与邮件内容不落到日志、缓存与第三方, so that 授权不会在我不知情的情况下扩散。

#### Acceptance Criteria (EARS)

- [AC-LEAK-01] THE ShareUrlBuilder SHALL 把 `sec` 放在 URL fragment 中，SHALL NOT 放在路径段或查询参数中。
- [AC-LEAK-02] THE MailShareApp SHALL 为分享页与分享接口响应设置 `Cache-Control: no-store`。（**unverified**：`run_worker_first = true` 且响应经 `env.assets.fetch` 时，Cloudflare 文档警告 `_headers` **可能不**作用于 Worker 生成的响应——须真实部署确认；见 design.md CSP 段。）
- [AC-LEAK-03] THE MailShareApp SHALL 为分享页设置 `Referrer-Policy: no-referrer`。（**unverified**：同上 `_headers` 在 Worker-first 部署下的应用时机。）
- [AC-LEAK-04] THE MailShareApp SHALL 为分享页设置 `X-Robots-Tag: noindex, nofollow`。（**unverified**：同上 `_headers` 在 Worker-first 部署下的应用时机。）
- [AC-LEAK-05] THE ShareAuthService SHALL NOT 将 `sec`、Share Session 凭据或邮件正文写入日志。
- [AC-LEAK-06] WHERE 分享接口位于 `/api` 之下, THE SecurityMiddleware SHALL 以精确前缀而非宽泛前缀匹配放行分享路径。

### Requirement 9: 滥用防护（本期最小）

**User Story:** As a 系统管理员, I want 分享接口不能被用来枚举 token 或无限创建, so that 这个功能不会成为攻击面。

**设计原则（A6 · R2-A6 收敛）**：`sec` 为 256-bit CSPRNG，暴力破解本就不可行。**禁止**按公开 `lid` 锁定失败次数——攻击者持有 `lid` 后可故意输错 `sec` 耗尽额度，对真实 Visitor 造成 DoS。本期滥用防护依赖 **Cloudflare 边缘限速**（Rate Limiting rules / WAF）做粗粒度保护，**不在 D1 自建**来源计数表与全局指标告警链。继续禁止 Workers KV 做失败计数（KV 60s 传播且否定结果亦缓存）。

**已核实的平台约束（边缘限速）**：
- `period` 只能是 **10** 或 **60** 秒。
- 计数按 Cloudflare 地点（PoP）独立维护，官方自述为 **eventually consistent** 的非精确计数，不能当作精确租约或全局配额。

#### Acceptance Criteria (EARS)

- [AC-ABUSE-01] {status: deprecated, by: R1-A6} ~~THE ShareAuthService SHALL 对以同一 `lid` 建立 Share Session 的失败尝试计数并在超过阈值后拒绝后续尝试。~~（按 `lid` 锁定可被第三方 DoS，见用户 R1 裁决）
- [AC-ABUSE-02] THE MailShareService SHALL 限制单个 Owner 同时处于 `effectiveStatus=ACTIVE` 的 MailShare 数量；计数与插入在同一条件 INSERT 内原子完成（AC-SHARE-12）。
- [AC-ABUSE-03] WHERE 管理员关闭了分享功能, THE MailShareService SHALL 拒绝创建新的 MailShare 并返回 `SHARE_DISABLED`；既有链接的 Visitor 访问 SHALL 返回 `SHARE_UNAVAILABLE`（不可区分其他失败）；**重新开启后**旧链接恢复可用（临时冻结语义，见 AC-LIFE-13）。
- [AC-ABUSE-04] THE ShareAuthService SHALL NOT 使用 Workers KV 作为失败计数或限速的存储。
- [AC-ABUSE-05] {status: deprecated, by: R2-A6} ~~THE ShareAuthService SHALL 按请求来源对 `POST /share/session` 实施 D1 滑动窗口限速。~~（改为 Cloudflare 边缘限速，见 AC-ABUSE-08）
- [AC-ABUSE-06] {status: deprecated, by: R2-A6} ~~THE ShareAuthService SHALL 将全局失败次数写入 D1 表 `share_auth_metrics`。~~
- [AC-ABUSE-07] {status: deprecated, by: R2-A6} ~~THE ShareAuthService SHALL 在验证成功后重置该来源失败计数。~~
- [AC-ABUSE-08] THE 部署配置 SHALL 在 Cloudflare 边缘对 `POST /share/session`（及必要时 Owner 写接口）配置 Rate Limiting 规则；超限时 SHALL 返回 HTTP **429** 且 SHALL 携带 **`Retry-After`** 响应头。
- [AC-ABUSE-09] WHEN Visitor 或 Owner 客户端收到 HTTP 429, THE 客户端 SHALL 将其视为**独立的、可恢复的运输层错误**，按 `Retry-After` 指示退避后重试；SHALL NOT 映射为 `SHARE_UNAVAILABLE` 或当作链接永久失效。
