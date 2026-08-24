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

- `mail_share` 表就地加列(v3_2DB)+ 新建 `mail_share_binding` 表;存量单邮箱行经**迁移门禁**(JOIN account 校验存活/未删/归属,R2 评审 A4)回填恰一条 Binding,不满足门禁的脏旧行直接 REVOKED 不回填,旧有效链接继续可用。
- **滚动发布走 Expand/Contract 分阶段协议**(R2 评审 A1):Expand 阶段新代码双写 `mail_share.account_id` = 主 Binding 的 `account_id`(禁止写 0),多邮箱能力受 `SHARE_MULTI_ENABLED`(默认 false)门控,全量 Worker 升级并完成回填前不开启;新代码读路径只信 Binding;确认无旧 Worker 后方进入 Contract 停止双写。回滚 = 关 multi 开关,单邮箱因双写在旧 Worker 下仍可用。
- **累计 Session 配额**用单条原子条件 UPDATE 实现,**不建服务端 Session 表**(维持旧 ADR「无状态 token」裁决;并发上限才需要落库,本裁决为累计上限)。**线性化承诺收敛**(R2 评审 A3):以条件 UPDATE 成功时刻为配额与授权线性化点;UPDATE→签发之间的并发失效属已知极窄 TOCTOU,token 回源失败且名额不退还,不承诺「响应时仍可用」。
- **可选 auth_key** 作为 establishSession 的第二因子;错误暴露面最小化(仅 `lid`+`sec` 通过者可见 `SHARE_AUTH_REQUIRED`,其余保持不可区分 `SHARE_UNAVAILABLE`);暴破防护**仅**依赖既有 IP 边缘限流(R2 评审 A6:Key 为 128-bit 服务端 CSPRNG 凭据,在线穷举不可行,不建失败计数/锁定状态表)。
- 旧 ADR 曾拒绝的「通用 ResourceGrant 抽象」维持拒绝:多邮箱 Binding 不构成第二种 grant 类型,不触发重开该裁决。

细节契约见 `docs/specs/mailbox-share-capability/design.md`(Decision 1-19)。

## Consequences

### 正面

- 单/多邮箱统一模型,一套鉴权/范围/清理链;旧链接零迁移成本继续可用。
- 配额与认证均为行上原子状态,零新增存储服务、token 版本保持 `s1`,回退面小。
- 授权面可按场景收窄(N 封可见集、配额、Key),泄露一条链接的影响进一步受限。

### 代价

- `mail_share.account_id` 在 Expand 阶段是双写目标(鉴权零读取),Contract 后才降为遗留列;双真源风险由「读路径只信 Binding + 双写主 Binding + `SHARE_MULTI_ENABLED` 门控」的分阶段协议封闭(design「迁移/发布协议」),代价是兼容窗口内每次 Binding 变更多一次主表写。
- 级联撤销、清理任务、附件校验等六处单值假设须同步改造,漏改即越权或孤儿行(spec 已列 AC 钉死)。
- AuthKey 使凭据面从纯 capability URL 扩展为 URL+Key 两件套;因 Key 为服务端生成 128-bit 凭据,不引入锁定机制(R2 评审 A6),请求成本约束完全依赖边缘限流。
- 配额与授权只在条件 UPDATE 时刻线性化:UPDATE→签发间的极窄 TOCTOU 下 token 即死且名额不退还,属文档化接受的取舍(替代方案是服务端 Grant/Session 台账,被判定过重)。
- 推翻旧裁决产生两份并存 charter(mail-share / mailbox-share-capability),supersede 时点留待发布观察期后由用户裁定。

## References

- 前继 ADR:`docs/architecture/ADR-mail-share-capability-boundary.md`
- Charter:`docs/specs/mailbox-share-capability/{requirements,design}.md`
- Recon:`.agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-{backend,frontend,crosscut}.md`
