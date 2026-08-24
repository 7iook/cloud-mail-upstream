# ADR: Mailbox Share 能力扩展 —— 多邮箱 Binding、Session 配额闸门与可选认证 Key

## Status

Proposed(stub · 随 `docs/specs/mailbox-share-capability/` charter 落盘,实现验收后补全并转 Accepted)

## Context

`ADR-mail-share-capability-boundary.md` 确立了 Mail Share 的资源级 capability 授权边界:`/s/<lid>#<sec>` capability URL、无状态短期 Session token、`share-auth-service` 唯一授权入口、`share-scoped-email-repository` 唯一范围查询,不复用全局 `/public/*` token。该边界已实现并稳定(三套测试全绿)。

新需求(用户 2026-08-24 需求书)在**该边界内侧**做三项边界定义级变更:

1. **数据模型 1:1 → 1:N**:一条分享可绑定多个邮箱(`mail_share.account_id` 单列 → `mail_share_binding` 表,per-binding `window_start_email_id` 快照)。
2. **计数语义:观测 → 执行**:`access_count` **语义**升级为 `used_sessions` 配额(`max_sessions` 累计建立次数上限,原子条件 UPDATE 闸门;触顶为计算态 `ACCESS_LIMIT_REACHED`,不落库)。物理列名保留 `access_count`,expand-only 不 RENAME(R1 评审 A1:重命名会使旧版本 Worker/回滚版本失配);领域/API/DTO 称 `used_sessions`/`usedSessions`。`share_type` 同理不落库,由 Binding 计数实时派生(R1 评审 A2)。
3. **授权通道:capability → capability + 可选 credential**:新增可选 AuthKey 第二因子(只存 `auth_key_hash`,复用 HMAC+PEPPER 设施);重置经 `credentials_version` 使旧 Session 立即失效。

其中 2、3 显式推翻 mail-share R1-R3(2026-08-16/17)「访问密码/次数上限不做」的用户裁决——这是产品方向变更,由用户 2026-08-24 重新拍板;旧 ADR 与旧 charter 原文不改,审计链各自保留。

## Decision

**就地扩展既有边界,不重建**:

- `mail_share` 表就地加列(v3_2DB)+ 新建 `mail_share_binding` 表;存量单邮箱行迁移回填恰一条 Binding,旧链接继续有效。
- **累计 Session 配额**用单条原子条件 UPDATE 实现,**不建服务端 Session 表**(维持旧 ADR「无状态 token」裁决;并发上限才需要落库,本裁决为累计上限)。
- **可选 auth_key** 作为 establishSession 的第二因子;错误暴露面最小化(仅 `lid`+`sec` 通过者可见 `SHARE_AUTH_REQUIRED`,其余保持不可区分 `SHARE_UNAVAILABLE`);暴破防护 = IP 边缘限流 + per-share 原子失败计数短窗锁定,禁止按 lid 永久锁死。
- 旧 ADR 曾拒绝的「通用 ResourceGrant 抽象」维持拒绝:多邮箱 Binding 不构成第二种 grant 类型,不触发重开该裁决。

细节契约见 `docs/specs/mailbox-share-capability/design.md`(Decision 1-19)。

## Consequences

### 正面

- 单/多邮箱统一模型,一套鉴权/范围/清理链;旧链接零迁移成本继续可用。
- 配额与认证均为行上原子状态,零新增存储服务、token 版本保持 `s1`,回退面小。
- 授权面可按场景收窄(N 封可见集、配额、Key),泄露一条链接的影响进一步受限。

### 代价

- `mail_share.account_id`/`window_start_email_id` 降级为迁移遗留只读列,双真源风险须由 schema 测试与读路径一次性切换封死。
- 级联撤销、清理任务、附件校验等六处单值假设须同步改造,漏改即越权或孤儿行(spec 已列 AC 钉死)。
- AuthKey 引入人可传达的低熵凭据,暴破面大于纯 capability URL;锁定机制成为新的可用性/安全权衡点。
- 推翻旧裁决产生两份并存 charter(mail-share / mailbox-share-capability),supersede 时点留待发布观察期后由用户裁定。

## References

- 前继 ADR:`docs/architecture/ADR-mail-share-capability-boundary.md`
- Charter:`docs/specs/mailbox-share-capability/{requirements,design}.md`
- Recon:`.agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-{backend,frontend,crosscut}.md`
