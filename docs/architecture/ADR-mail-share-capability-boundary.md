# ADR: Mail Share 资源级 Capability 授权边界

## Status

Proposed

## Context

Mail Share 需要让未登录 Visitor 凭不可猜链接只读授权时间窗内的邮件。实现此能力必须回答：**匿名读路径的授权真源是什么？**

### 现状：全局 `/public/*` 机器令牌

仓内已存在一套「公开 API」机制，但它是**管理员级全局凭据**，不是资源级授权：

| 事实 | 锚点 |
|---|---|
| `/public/*` 在 security 中间件 `exclude` 白名单内，跳过 JWT | `security.js:104-111` |
| 鉴权方式为单一全局 KV 键 `KvConst.PUBLIC_KEY`，可被 `genToken` 覆盖 | `public-service.js:167-169` |
| 公开路由含**可写**端点 `POST /public/addUser` | `public-api.js:15-17` |

该机制的设计目标是**运维/集成**（批量建用户等），凭据一旦泄露即获得全局写能力；且**无法承载 per-link 可变状态**（过期、撤销、访问计数、Visible Window 下界）。

### Mail Share 的需求约束

- 每条分享须独立过期、销毁、窗口边界与统计（`mail_share` 行 + `window_start_email_id`）。
- Visitor 只读，零写能力；秘密半 `sec` 不得进服务端日志（fragment 方案）。
- 附件须经受控端点 `GET /share/attachment`，不可下发永久有效的 `/oss/<key>` 直链（见 spec AC-SEC-20/21）。

若在 `/public/*` 上加参数或子路径扩展，仍共享同一全局 token 命名空间，无法隔离「一条链接 ↔ 一行授权记录」，且与含可写端点的管理员凭据混在同一信任域——**边界不可接受**。

## Decision

**确立独立的资源级 capability 授权边界**，不复用既有全局 `/public/*` token。

具体方案（详见 `docs/specs/mail-share/design.md` Decision 1–2）：

1. **Token 形态**：`/s/<lid>#<sec>`——`lid` 明文唯一索引定位 `mail_share` 行；`sec` 只存 `HMAC-SHA256(sec, PEPPER[kid])`；`sec` 放 URL fragment。
   > ⚠️ 2026-08-25：本条「`sec` **只**存 HMAC」已被 [ADR-share-credential-recoverability](ADR-share-credential-recoverability.md) **部分取代**——上线后新建的分享会**额外**存一份 AES-GCM 密文以支持 Owner 重复查看链接；HMAC 校验路径本身不变，AuthKey 的不可恢复性完全不变。Token 形态、fragment 方案、per-link 授权边界均不受影响。
2. **Session 层**：Visitor 用 `POST /share/session` 换取短期 Bearer `sessionToken`；后续读路径只经 `share-auth-service` 验签 + 回源查库。
3. **读模型隔离**：Visitor 永不进入登录态 `email-service`；范围查询只经 `shareScopedEmailRepository`。
4. **公开路径**：分享 API 挂在精确枚举的 `/share/*`、`/mailShare/*` 路径集合下（security 中间件须从 `startsWith` 改为精确匹配），**不**扩展 `/public/*`。

## Consequences

### 正面

- 每条链接的授权状态可独立撤销、过期、审计；泄露面限于单行 `mail_share` 范围。
- 与登录态 JWT、`/public/*` 管理员 token 三者信任域分离，避免「一个 token 打全站」。
- 附件、邮件列表、Session 共用同一 `ShareAuthService` 授权入口（P-ATT-01、P-SCOPE-01）。

### 代价

- **新建完整 bounded context**：`mail_share` / `share_idempotency` 表、6+ service、2 组 API、前端匿名基建（独立 axios、分享路由、SafeMailRenderer、轮询 composable）。
- **security.js 行为变更**：`exclude` 从前缀匹配改为精确集合——**影响所有请求**，须单列回归（见 tasks T-05）。
- **不可无痛回退**：一旦 Owner 创建分享并发出链接，撤回 Decision 须迁移存量 `mail_share` 行与 Visitor 会话语义；故本 ADR 在实现完成并稳定运行前保持 Proposed，验收后转 Accepted。
- **运维新增密钥**：`SHARE_SEC_PEPPER`、`SHARE_SESSION_SIGNING_KEY` 及 `kid` 双 key 轮换窗口——仓内**无**可复用 PEPPER/JWT-kid 设施（`jwt-utils.js:17-20`）。

### 撤销门槛

若未来证明必须合并到 `/public/*`，需同时解决：(1) per-link 状态落库与全局 token 的映射；(2) 隔离可写 `addUser`；(3) 迁移存量分享链接与 Session。成本高于维持独立边界，**不建议**。

## Alternatives considered

### 1. 复用全局 `/public/*` token

在 `/public/share/*` 下挂分享 API，用同一 `PUBLIC_KEY` 鉴权。

**拒绝理由**：
- 全局 token 含写能力（`addUser`）；泄露即管理员级 compromise，非 per-link 泄露。
- 无法在 token 字符串中编码「哪一行 `mail_share`、哪条 Visible Window」——仍须额外参数，参数与全局 token 组合无 SSOT。
- 与 spec Success State「链接到期/销毁后立即不可用」冲突——全局 token 无 per-link 生命周期。

### 2. 无状态 HMAC 签名 URL（不含 DB 行）

类似 Laravel signed URL / Django reset token：URL 自包含 expiry + accountId + HMAC。

**拒绝理由**：
- 分享须承载**可变状态**：Owner 随时 revoke、管理员关功能开关（临时冻结）、account 删除须永久撤销——无状态 URL 无法在 Owner 操作后失效（除非维护全局 revocation 列表，实质仍落库）。
- Visible Window 下界须在**创建时刻**原子快照 `email_id`（AC-SHARE-06），签名 URL 无法在创建后随邮箱继续收信而自动推进窗口。

### 3. 通用 ResourceGrant 抽象

引入 `resource_grant` 表 + 统一授权中间件，Mail Share 作为第一种 grant 类型。

**拒绝理由（本期）**：
- 当前**唯一**业务场景是 Mail Share；抽象层无第二消费者，违反 YAGNI。
- 增加迁移、API 与测试面，延迟交付。
- 若未来出现第二种资源分享（如日历、文件），可再提取；Mail Share 的 `mail_share` 表即 первый concrete grant。

## References

- Spec: `docs/specs/mail-share/design.md` Decision 1, 8
- Spec: `docs/specs/mail-share/requirements.md` Success State
- Recon: `public-service.js:167-169`, `security.js:104-111`, `public-api.js:15-17`
