# 第 1 轮评审结论（req-arch）

评审范围仅限 `design.md` 与 `requirements.md`。成功状态包含可由未登录用户执行的端到端结果与一次性验证路径，因此不触发“缺失用户可验证成功状态”红线；但下列 P0 会使该成功状态在迁移、绑定变更或脱敏场景中不可可靠成立。

## 架构级问题

### A1 · 破坏性列重命名没有兼容发布与回滚路径

- **锚点**：`design.md` → `### mail_share 新增/变更列(v3_2DB · 就地演进)` → `ALTER TABLE mail_share RENAME COLUMN access_count TO used_sessions`
- **问题**：方案一面声明“加列零破坏”，一面直接重命名现有列；旧版本 Worker、在途实例及回滚版本仍会读取/写入 `access_count`，迁移后会立即失配。文档没有规定停机窗口、版本栅栏、双版本兼容期或回滚步骤。
- **问题根因**：把业务语义改名与物理 schema 改名合并成一次不可逆 contract 变更，缺少 expand→migrate→contract 的发布模型。
- **业务影响**：发布或回滚窗口内，既有单邮箱链接、Session 建立和 Owner 管理接口可能整体 5xx，直接破坏“旧链接继续有效”的成功状态。
- **架构影响**：数据库 schema 不再兼容前后两个应用版本，发布原子性被错误地寄托在应用部署与 D1 迁移恰好同步。
- **修改建议（intent）**：明确采用可回滚的兼容迁移方向，或给出能够证明无旧实例并可安全回滚的发布栅栏；同时覆盖迁移中断、旧版本访问和回滚演练。
- **优先级**：P0

### A2 · `share_type` 是无维护闭环的派生双真源

- **锚点**：`design.md` → `## Decision(s)` → `Decision 1 · 统一模型`
- **问题**：`share_type` 按 Binding 数写入并被 Session/前端用于单、多邮箱分支，但 Binding 增删、account 级联删除和迁移章节均未要求同步重算该列。一个单邮箱分享新增 Binding 后仍可能保持 `single`，多邮箱分享删至一个后仍可能保持 `multi`。
- **问题根因**：把可由 Binding 集合推导的类型持久化，却没有定义跨所有写路径成立的数据库级或服务级不变量。
- **业务影响**：访客页可能走错渲染分支，新增邮箱不可见或出现错误 Tab，核心多邮箱成功状态失败。
- **架构影响**：`mail_share.share_type` 与 `mail_share_binding` 成为竞争真源；后续新增任何 Binding 写路径都必须承担易遗漏的联动更新。
- **修改建议（intent）**：消除派生列，或定义并验收覆盖创建、增删、级联、迁移及失败回滚的原子维护不变量与修复机制。
- **优先级**：P0

### A3 · 掩码安全属性与“发件人不掩码/正文原样展示”不可同时满足

- **锚点**：`design.md` → `### P-MASK-01: 掩码封闭性与幂等`
- **问题**：P-MASK-01 要求任何 Visitor 响应的任何字段都不得出现绑定邮箱完整地址；AC-MAIL-08 又要求发件人地址默认不掩码，邮件主题/正文也按原内容展示。自发邮件、转发头或正文包含绑定地址时，两条规范必然冲突。
- **问题根因**：没有区分系统生成的绑定邮箱元数据与用户邮件内容，却对整个响应声明了全局非出现性。
- **业务影响**：要么实现泄露完整地址、违反安全承诺，要么修改邮件内容、破坏邮件查看与验证码场景；验收测试无法对两者同时给出正确结果。
- **架构影响**：安全边界和投影职责不可实现，property test 只能通过规避真实数据或错误删改内容。
- **修改建议（intent）**：限定脱敏保证覆盖的字段与数据来源，并明确发件人、收件人、邮件头、主题、正文中命中绑定地址时的产品策略，使安全属性与邮件保真目标可共同验收。
- **优先级**：P0

### A4 · Session 授权判定与配额消耗之间存在未闭合竞态

- **锚点**：`design.md` → `### mailShareService.consumeSessionQuota(c, shareId) -> boolean`
- **问题**：文档先读取并校验状态、AuthKey、Binding 与 `credentials_version`，随后配额 UPDATE 的条件只约束 `share_id/max_sessions/used_sessions`。在两步之间发生撤销、过期、Key 重置、版本递增或 Binding 删空时，UPDATE 仍可命中并继续返回“成功签发”，与 establishSession 的五项同时成立后置条件冲突。
- **问题根因**：只闭合了“配额不超发”的并发条件，没有把授权快照版本和生命周期条件纳入同一个线性化点。
- **业务影响**：用户可能得到立即不可用却已消耗配额的 Session；并发撤销/重置时接口可假成功，配额被无效请求吃掉。
- **架构影响**：授权、凭据版本和配额三个状态机缺少共同提交边界，形式化后置条件无法由所列 SQL 保证。
- **修改建议（intent）**：定义 Session 建立的单一线性化点，使配额写同时验证当前生命周期、凭据版本及必要的授权快照；补充撤销、过期、重置和删空 Binding 与建立 Session 并发的验收矩阵。
- **优先级**：P0

### A5 · AuthKey 生命周期没有完整状态机

- **锚点**：`design.md` → `### Owner 面 /mailShare/*` → `POST /mailShare/resetAuthKey`
- **问题**：需求称 AuthKey 可生成、修改、重置且默认可选，但 API 只提供创建时启用和“重置并强制启用”；update 不允许启用/停用，文档也未定义停用后 hash/kid、失败计数、锁定状态和既有 Session 的处理。`auth_key_enabled` 与 hash/kid 还可能形成不一致组合。
- **问题根因**：把 AuthKey 当作若干可空字段，而非具有启用、禁用、重置和异常恢复迁移的凭据状态机。
- **业务影响**：Owner 一旦启用便无法按文档承诺关闭；异常行可能永久要求一个无法验证的 Key。
- **架构影响**：认证策略和凭据材料存在非法组合，API、数据模型与 `credentials_version` 失效规则不闭合。
- **修改建议（intent）**：定义完整的启用/停用/重置状态迁移、字段不变量、版本递增规则及每种迁移对既有 Session 的影响，并让管理 API 与 AC 对齐。
- **优先级**：P1

### A6 · per-share 锁定可被持链者持续用于全局拒绝服务

- **锚点**：`requirements.md` → `AC-AUTH-05`
- **问题**：任何持有 `lid+sec` 的访问者都可对 share 维度累计失败并锁住所有合法访问者；窗口结束后可再次触发。IP 边缘限流不能阻止分布式来源，且阈值、窗口滚动、成功后清零和旧计数回收仅是“建议”，没有确定语义。
- **问题根因**：把攻击来源隔离与共享凭据保护合并成全局 share 锁，未定义抗滥用的状态转移。
- **业务影响**：共享链接的任一接收者或泄露者都可反复阻断全部用户，验证码时效场景尤其容易失效。
- **架构影响**：稳定性保护本身成为 DoS 放大器，且不同实现可能产生永久高失败计数或即时重锁。
- **修改建议（intent）**：明确失败窗口状态机、成功/到期重置规则和限流维度，并证明保护措施不会让单一或分布式来源无限续锁整个分享。
- **优先级**：P1

### A7 · StatusEndpoint 的游标与可见范围契约不足

- **锚点**：`design.md` → `### Visitor 面 /share/*` → `GET /share/mailboxes/status`
- **问题**：`sinceEmailId` 缺省值、由谁推进、何时提交、跨 Tab 未读语义、Binding 增删后的游标处理均未定义；`latestEmailId/newCount` 是否应用 window、`message_limit`、删除态与中间态过滤也未明确。
- **问题根因**：只确定了“单请求代替 N 请求”的运输形态，没有定义状态同步协议。
- **业务影响**：新邮件角标可能漏报、重复报，或暴露 Visitor 可见集之外邮件的数量/存在性。
- **架构影响**：Status 与 mails 可能形成两个范围模型，违背 scoped repository 作为唯一范围强制点的边界。
- **修改建议（intent）**：定义游标所有权、推进时机、缺省/重连/Binding 变更语义及与 VisibleWindow、message_limit 完全一致的范围规则，并加入协议级 AC。
- **优先级**：P1

### A8 · Owner 与管理员的授权范围互相矛盾

- **锚点**：`requirements.md` → `Requirement 6(R6): Owner/Admin 管理面` → `AC-ADMIN-02`
- **问题**：R6 用户故事允许“邮箱所有者或持 share:manage 的管理员”管理，Owner 定义及 AC-ADMIN-02 又限定所有接口只返回本人分享。文档没有说明管理员是否可跨用户审计/处置，还是 `share:manage` 仅为本人操作的路由权限。
- **问题根因**：角色名称、资源所有权与权限能力没有形成明确授权矩阵。
- **业务影响**：管理员可能看不到需要处置的分享，或实现方误把 `share:manage` 解释为跨租户能力而造成越权。
- **架构影响**：列表、详情、更新、撤销、删除的 tenant predicate 无统一依据。
- **修改建议（intent）**：确定管理员与 Owner 的资源范围，形成覆盖全部 Owner 端点的角色×操作×资源归属矩阵，并统一成功/隐藏错误语义。
- **优先级**：P1

### A9 · 无外键模型下，Binding 新增与 account 删除缺少并发一致性协议

- **锚点**：`design.md` → `## Architecture & Layering` → `D1 约束`
- **问题**：新增 Binding 先做批量归属校验再写入，account 删除则另一路径删除 Binding；在无外键、无事务前提下，两者并发可在删除完成后插入指向已删 account 的孤儿 Binding。现有 AC 只分别验证正常添加与正常删除。
- **问题根因**：跨聚合不变量依赖应用层多步检查，但没有共同线性化条件或事后修复机制。
- **业务影响**：分享可显示不存在的邮箱、出现空内容或直到清理前保持错误 ACTIVE 状态。
- **架构影响**：`mail_share_binding` 的引用完整性并未被“显式清理”完整保证。
- **修改建议（intent）**：定义 account 有效性校验与 Binding 写入/删除竞争时的原子条件、顺序或补偿，并增加并发验收。
- **优先级**：P1

## 普通功能与可运维性问题

### F1 · AuthKey 强度与传达格式不可验收

- **锚点**：`requirements.md` → `AC-CAP-05`
- **问题**：只规定服务端 CSPRNG，没有最小熵、长度、字符集、大小写、展示分组或输入规范。
- **问题根因**：将“随机生成”误当作完整凭据规格。
- **业务影响**：实现可能产生难输入、被前端规范化破坏或强度不足的 Key。
- **架构影响**：不同客户端和后端实现无法共享稳定契约。
- **修改建议（intent）**：补充可测试的 Key 熵与编码/规范化契约，同时保持一次性明文返回边界。
- **优先级**：P2

### F2 · 管理列表的分页边界与稳定排序缺失

- **锚点**：`design.md` → `### Owner 面 /mailShare/*` → `GET /mailShare/list`
- **问题**：新增 `page?/size?` 却保留无参全量，未规定默认值、最大 size、稳定排序和同时间游标/页码行为。
- **问题根因**：为兼容旧调用保留了无界读路径，却没有生产数据量约束。
- **业务影响**：分享量增长后可能出现超大响应、重复/漏项和管理页抖动。
- **架构影响**：列表 API 无稳定性能契约。
- **修改建议（intent）**：定义兼容期、默认与上限、稳定排序键及分页一致性。
- **优先级**：P2

### F3 · 核心状态机缺少生产观测信号

- **锚点**：`design.md` → `Decision 17 · ShareAccessEvent`
- **问题**：延期 AccessEvent 可以接受，但文档只保留 `used_sessions/last_access_at`，没有规定迁移失败、配额拒绝、AuthKey 失败/锁定、凭据版本拒绝、Binding 级联异常的指标或结构化日志。
- **问题根因**：把“不建审计事件表”等同于“不需要状态机观测契约”。
- **业务影响**：用户反馈无法进入或迁移异常时，运营方难以区分配额、锁定、撤销、数据孤儿和系统故障。
- **架构影响**：关键授权与迁移不变量无法在生产中验证，回滚判据缺失。
- **修改建议（intent）**：在不新增事件表的前提下，定义无凭据泄露的指标、错误分类、请求关联和发布门槛。
- **优先级**：P2

## 业务现实校验

- 多邮箱 Binding、Session 累计配额、可选 AuthKey、统一状态轮询分别有明确 Owner/Visitor 场景和缺失影响，分类为 A（业务刚需）或 B（稳定性保护），不是仅因接口不对称而新增。
- 独立管理页由集中查看、收窄授权与撤销的真实操作支撑；Owner 的 get/update/bindings/delete/resetAuthKey 是该流程的消费者，不判为 D。
- ShareAccessEvent 已延期，避免为当前成功状态引入第二套事件真源；本轮不要求恢复该表。

## Patch Plan

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: design.md
    anchor: "ALTER TABLE mail_share RENAME COLUMN access_count TO used_sessions;"
    action: replace_section
    intent: 明确可兼容前后应用版本且可回滚的 schema 演进与发布栅栏，并覆盖迁移中断和回滚验证
    rationale_short: 破坏性重命名会使旧实例和回滚版本失配
  - issue_id: A2
    severity: P0
    target_file: design.md
    anchor: "- **Decision 1 · 统一模型**"
    action: replace_section
    intent: 消除 share_type 派生双真源，或建立覆盖所有 Binding 变更路径的原子维护不变量
    rationale_short: Binding 数变化后持久化类型可能失真并驱动错误前端分支
  - issue_id: A3
    severity: P0
    target_file: design.md
    anchor: "### P-MASK-01: 掩码封闭性与幂等"
    action: replace_section
    intent: 划定脱敏保证的数据来源和字段范围，并裁决邮件内容及发件人命中绑定地址时的行为
    rationale_short: 全响应地址不出现与发件人及正文原样展示不可同时满足
  - issue_id: A4
    severity: P0
    target_file: design.md
    anchor: "### `mailShareService.consumeSessionQuota(c, shareId) -> boolean`"
    action: replace_section
    intent: 为授权状态、凭据版本与配额消耗定义共同线性化点及并发验收矩阵
    rationale_short: 当前条件 UPDATE 只闭合配额竞态而未闭合授权竞态
  - issue_id: A5
    severity: P1
    target_file: design.md
    anchor: "| `POST /mailShare/resetAuthKey` |"
    action: append_after
    intent: 定义 AuthKey 启用停用重置状态机、字段不变量、版本规则和既有 Session 影响
    rationale_short: API 与可选凭据承诺不一致且允许非法字段组合
  - issue_id: A6
    severity: P1
    target_file: requirements.md
    anchor: "- [AC-AUTH-05]"
    action: replace_section
    intent: 明确失败窗口和复位语义、限流维度，并约束单一或分布式来源不能持续全局锁定分享
    rationale_short: per-share 锁定可被持链者反复用作拒绝服务
  - issue_id: A7
    severity: P1
    target_file: design.md
    anchor: "| `GET /share/mailboxes/status` | 新建 |"
    action: append_after
    intent: 定义状态游标推进与恢复协议，并使计数严格复用 VisibleWindow 和 message_limit 范围
    rationale_short: 未定义游标和范围会造成漏报重复报或侧信道
  - issue_id: A8
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 6(R6): Owner/Admin 管理面"
    action: append_after
    intent: 建立管理员与 Owner 覆盖全部管理端点的角色资源授权矩阵
    rationale_short: 管理员能力与仅本人资源约束互相矛盾
  - issue_id: A9
    severity: P1
    target_file: design.md
    anchor: "- **D1 约束**"
    action: append_after
    intent: 定义 Binding 新增与 account 删除竞争时的原子顺序或补偿，并增加并发验收
    rationale_short: 无外键和多步校验会产生删除后插入的孤儿 Binding
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 4
p1_count: 5
critical_count: 4
important_count: 5
minor_count: 3
ready_to_merge: false
one_line: 迁移兼容、派生类型一致性、脱敏契约和 Session 建立线性化四项 P0 未闭合，当前不可进入实现。
