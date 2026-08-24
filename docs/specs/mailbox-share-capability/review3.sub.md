# 第 3 轮评审结论（生产场景推演与开工前核验）

实际评审模型：GPT-5.6 Sol

## 简短摘要

当前稿已吸收 R1/R2 的主要架构修订，`mail_share` 就地演进、Binding 唯一真源、无状态短期 token 与 scoped repository 的总体方向可保留。但生产推演仍发现 3 个新的阻塞点：发布门控只覆盖 multi 创建而未覆盖 AuthKey/配额及 Binding 变更，旧 Worker 会成为策略降级入口；迁移 SQL 会把迁移窗口内旧 Worker 新建的合法零 Binding 行误撤销；`POST /share/session` 在扣减配额后响应丢失时没有幂等恢复，低配额分享可因一次超时永久耗尽。

因此不需要推倒领域模型，也不建议立即引入完整服务端 Session 权威表；应先补齐全能力发布栅栏、迁移竞态与最小会话签发幂等/恢复契约，再开始实现。落地决定为：**调整方案后开发**。

## 真实业务边界清单

### 本期必须实现

- 单/多邮箱 Binding 及租户归属强制，所有 Visitor 读路径继续以 scoped repository 为唯一范围边界。
- Session 累计配额、AuthKey 与 `credentials_version`，但其启用必须服从“所有消费者已具备新策略解释能力”的发布前置条件。
- Owner 创建、查看、更新、增删 Binding、撤销、删除及 AuthKey 生命周期的最小管理闭环。
- StatusEndpoint 单请求返回 per-binding 水位，前端本地维护水位；不得退回 N 路轮询。
- 存量数据安全迁移、旧实例并存、回滚、旧实例晚写和迁移中断恢复。
- Session/create 响应丢失、重复请求和部分成功后的确定恢复路径。
- Binding 数量上限、查询性能门槛、日志告警消费者与发布回滚判据。

### 可延后

- `ShareAccessEvent` 独立审计表；当前聚合计数与结构化日志足够，但上线前必须先接通日志消费与告警。
- 跨用户管理员审计/处置、预设落库、内容级邮箱地址隐私、Contract 阶段删除或停止维护遗留列。
- 更强的响应时刻 token 可用保证与配额自动退还；只有产品明确要求该保证时才评估完整 Grant/Session 权威存储。

### 不建议实现

- 持久化 `share_type`、N 路邮箱轮询、per-share AuthKey 失败锁定表。
- 为消除已明确接受的 revoke/reset 极窄 TOCTOU 而建设完整 Session 服务。
- 在没有真实内容保密需求时改写邮件主题、正文或发件人。

## 业务现实判决表（反 Solution-Jumping）

| 新建能力 / 接口 / 字段 | 真实场景 | 缺失影响 | 既有机制覆盖 | 分类与判决 |
|---|---|---|---|---|
| `mail_share_binding` 及 per-binding window | Owner 用一条链接分享多个自有邮箱，并独立限制历史窗口 | 无法表达多邮箱授权，或用主表单值造成错箱越权 | 旧 `account_id` 仅单值，不能覆盖 | A 刚需，本期必须 |
| `max_sessions` + `access_count` 配额闸门 | Owner 限制链接可建立的访问次数 | 泄露链接可无限建立新会话 | 既有计数只有观测无准入 | A 刚需，本期必须 |
| AuthKey 列与 `resetAuthKey` | Owner 将链接与第二凭据分渠道传递，并可换 Key | 单一链接泄露即获得访问 | `sec` 是链接自身 capability，不是独立因子 | A 刚需，本期必须 |
| `credentials_version` + token `cv` | reset/disable 后立即令旧 token 失效 | 旧 Session 持续到 TTL，Owner 无法立即收窄 | 每请求回源已存在，但缺凭据纪元 | B 稳定/安全保护，本期必须 |
| `message_limit` | 每邮箱只暴露最近 N 封 | 链接暴露超过 Owner 意图的历史邮件 | 分页 limit 不能限制详情/附件可达集合 | A 刚需，本期必须 |
| per-binding `window_start_email_id` | 新增邮箱时只从加入时刻开始分享 | 单一窗口会让不同加入时间的邮箱泄露历史 | 旧主表窗口仅单邮箱 | A 刚需，本期必须 |
| OTP 投影开关 | 不同分享决定是否突出显示已提取验证码 | 无法按分享用途控制验证码 UI | 摄取链已有 `email.code`，应复用 | A 刚需；只做投影，不建第二提取链 |
| auto-refresh / interval 字段 | Visitor 等待短时验证码时自动获知新邮件 | 手刷降低验证码场景可用性 | `useSharePolling` 已覆盖机制 | A 刚需；仅扩配置 |
| `show_full_address` | Owner 控制系统生成地址字段的显示样式 | 仅影响展示便利，不影响授权 | 投影层可覆盖 | D 技术/展示偏好；若非明确产品需求可延后，不得当安全能力 |
| `GET /share/mailboxes/status` | 多邮箱页面每拍一次获知各邮箱新邮件水位 | N 路轮询触发限流并放大成本 | 单邮箱轮询存在，但不支持聚合 | B 稳定性保护，本期必须 |
| `GET /mailShare/get` | 管理抽屉读取单条完整配置 | 只能从列表拼装，无法安全编辑 | list 摘要不足 | A 刚需，本期必须 |
| `PUT /mailShare/update` | Owner 收窄配额和展示配置 | 创建后无法调整授权面 | 无既有 update | A 刚需，本期必须 |
| `PUT /mailShare/bindings` | Owner 在不换链接的情况下增删邮箱 | 业务变化只能销毁重建并重新分发 | 无既有机制 | A 刚需，本期必须 |
| `DELETE /mailShare/delete` | Owner 清除已撤销/过期记录及关联数据 | 管理面长期积累无用记录 | cleanup 仅处理到期，不能替代主动删除 | A 刚需，但须原子清理 |
| 独立管理模块 | Owner 集中审计和收窄本人分享 | 仅对话框无法完成列表、编辑与撤销闭环 | ShareDialog 仅快捷创建 | A 刚需，本期最小实现 |
| `SHARE_MULTI_ENABLED` | 滚动发布期间防止旧 Worker 解释不了多邮箱 | 旧实例产生降级或陈旧授权 | 现有开关只覆盖 create，覆盖不足 | B 稳定性保护；应升级为全能力激活协议 |
| 结构化日志事件 | 迁移、配额、凭据和级联异常的生产定位 | 失败只能靠用户反馈，无法决定回滚 | Cloudflare 日志承载存在，但消费者未闭合 | B 稳定性保护，本期必须接通消费 |
| `ShareAccessEvent` 独立表 | 逐次审计、计费或商业报表 | 当前成功状态不依赖逐事件账本 | 聚合计数与日志已覆盖当前诊断 | C 商业能力，可延后 |
| `mail_share_auth_fail` | 尝试锁定高熵 AuthKey 猜测 | 对 128-bit 机器 Key 无可量化收益，且制造 NAT 连坐 | IP 边缘限流已覆盖请求成本 | D 技术洁癖，不建议实现 |

## 当前方案继续实施的风险

### P0-A1 · 发布栅栏只保护 multi create，旧 Worker 可绕过 AuthKey 与配额

- **锚点**：`design.md` → `### 迁移/发布协议(R2-A1 · 滚动发布双轨消解,AC-LIFE-10)`
- **问题**：兼容窗口明确允许旧 Worker 继续服务，但门控只规定 `accountIds.length > 1` 的 create。旧 Worker 不认识 `auth_key_enabled`、`credentials_version`、配额条件及新 Binding 读模型：新代码启用 AuthKey 后，请求若落到旧 Worker，可能只凭 `lid+sec` 建会话；新代码设置有限配额后，旧 Worker 仍按旧 `recordAccess` 语义继续签发；reset/disable 后旧 Worker 也不会按 `cv` 拒绝旧 token。另有 `PUT /mailShare/bindings` 可把单邮箱增成多邮箱，正文未要求它受 `SHARE_MULTI_ENABLED` 约束。
- **问题根因**：把发布兼容性缩窄为数据形状兼容和 multi create 门控，没有按“策略生产者→所有鉴权消费者”建立能力激活栅栏。
- **业务影响**：滚动发布期间第二因子和累计配额可被随机路由绕过，Binding 端点还可绕过 multi 创建门控；这是权限策略降级，不只是短时不可用。
- **架构影响**：同一分享由不同 Worker 得出不同授权结论，数据库字段虽兼容，安全语义并不兼容。
- **修改建议（intent）**：把门控扩展为整个新能力的激活协议，覆盖 create/update/resetAuthKey/bindings、Visitor 建会话与前端入口；只有迁移完成、回填复核完成且确认无旧 Worker 后才允许写入或启用旧版本不能执行的策略，并验收绑定 1→N 绕过、AuthKey 绕过、配额超发和旧 token 失效四条路径。
- **优先级**：P0

### P0-A2 · 迁移 SQL 会把迁移窗口内旧 Worker 新建的合法行误判为脏数据

- **锚点**：`design.md` → `### 迁移 v3_2DB · 旧行回填(R2-A4 迁移门禁)` → `-- 未通过门禁的旧行(account 不存在/已删/归属不符):直接 REVOKED,不建 Binding(AC-BIND-11)`
- **问题**：注释称第二条 UPDATE 只撤销 account 无效的旧行，实际谓词却是“ACTIVE 且不存在 Binding”。若旧 Worker 在 INSERT 回填之后、该 UPDATE 之前创建一条 account 完全合法的新分享，它尚无 Binding，仍会被置为终态 REVOKED。发布收尾重跑 INSERT 虽可补 Binding，却不会把终态 REVOKED 恢复为 ACTIVE。
- **问题根因**：用“暂无 Binding”替代“account 不存在/已删/归属错误”的事实判定，并假设两条迁移语句执行期间没有旧写入。
- **业务影响**：合法旧链接会在发布期间被永久撤销；测试若只覆盖迁移前预置数据和迁移后晚写，仍会全绿。
- **架构影响**：幂等重跑不能恢复该竞态，和正文“旧实例晚写最终可收编”的恢复承诺冲突。
- **修改建议（intent）**：让无效行处置直接按 account 存活与归属条件判定，或建立能排除并发旧写的迁移写栅栏；补充“旧写发生在回填 INSERT 与无效行 UPDATE 之间、之前、之后以及任务重启后”的交错测试，保证合法行可恢复且非法行绝不授权。
- **优先级**：P0

### P0-A3 · Session 扣额后响应丢失没有幂等恢复，单次超时可耗尽链接

- **锚点**：`requirements.md` → `AC-SESS-01`
- **问题**：当前线性化点是条件 UPDATE，随后才签 token 和返回响应。除了文档已接受的并发失效窗口，还存在更常见的网络超时、Worker 重启或响应丢失：服务端已将 `used_sessions+1`，Visitor 却没有 token；前端重试会再消耗一次。`max_sessions=1` 时一次响应丢失即可让合法访客永久无法进入。
- **问题根因**：将“服务端完成一次签发尝试”与“Visitor 获得可用 Session”视为同一事件，却没有请求幂等键、重放结果、补偿或明确的人工恢复契约。
- **业务影响**：弱网和边缘重启会直接耗尽低配额分享，表现为链接无故不可用；配额值也不再等于成功获得 Session 的次数。
- **架构影响**：当前 property 只证明并发不超发，不能证明失败恢复；盲目自动重试还会放大配额消耗。
- **修改建议（intent）**：由产品先裁决配额计“服务端提交的签发”还是“客户端可恢复地获得凭据”；若坚持后者，增加短期、最小化的 session-establish 幂等/结果重放机制，不必把它升级为 Session 授权真源；若接受前者，则必须提供明确的前端不重试策略、Owner 重置/恢复操作和低配额失败提示并纳入 E2E。
- **优先级**：P0

### P1-A4 · Binding 批量变更缺少租户范围与全有或全无契约

- **锚点**：`design.md` → `PUT /mailShare/bindings`
- **问题**：请求同时允许 `add accountIds[]` 与 `remove bindingIds[]`，但未规定 remove 必须以 `shareId + 当前 Owner` 共同约束、混入其他分享 bindingId 的错误语义、add/remove 重叠、部分无效、重复项及并发两次变更时是整单回滚还是部分成功。
- **问题根因**：只描述了正常增删结果，没有把批量命令视为租户作用域内的原子状态迁移。
- **业务影响**：不同实现可能静默忽略、部分成功或按裸 bindingId 删除；最坏可造成跨分享删除或主 Binding 双写失真。
- **架构影响**：API、服务与测试无法共享同一原子性和资源谓词。
- **修改建议（intent）**：定义 Binding 批量命令的 owner/share 资源谓词、全有或全无语义、冲突和不存在错误、1→N 门控及并发序列化/CAS 条件，并覆盖跨租户 bindingId 混入测试。
- **优先级**：P1

### P1-A5 · Binding 数量没有上限，统一 StatusEndpoint 仍是无界查询与响应

- **锚点**：`requirements.md` → `AC-CAP-01`
- **问题**：规范允许“一个或多个” accountId，却没有每分享 Binding 上限、请求体上限或生产规模基线。Status 每 3 秒返回全部 Binding 水位，Session 响应和 Owner get 也返回全部 Binding；大集合还会触及 SQL 参数数、D1 CPU、响应体和前端 Tab 渲染边界。
- **问题根因**：解决了请求数量随 N 线性增长，却没有约束单次查询和响应的 N。
- **业务影响**：极端账户可制造持续重查询、超时或 429，自身和共享 NAT 用户均受影响。
- **架构影响**：`IN` 查询、per-binding 最新水位和全量 DTO 没有可验证的容量契约。
- **修改建议（intent）**：用真实业务数据确认每分享最大 Binding 数并在写入端强制；同时给 status/session/get 设响应和查询预算、索引/EXPLAIN 门槛及接近上限的负载测试。若业务确需大 N，再评估分页或分组，不要先做无界抽象。
- **优先级**：P1

### P1-A6 · 创建接口的一次性秘密在响应丢失后没有可执行恢复流程

- **锚点**：`requirements.md` → `AC-CAP-09`
- **问题**：首次 create 返回 `sec`/AuthKey，幂等重放明确不再返回秘密。若提交成功但响应丢失，重放只能得到 shareId/lid，Owner 得到一条占用活跃额度但无法分发的分享；AuthKey 可 reset，`sec` 没有恢复路径。
- **问题根因**：一次性明文安全边界正确，但没有为“提交成功、秘密未送达”定义消费者恢复动作。
- **业务影响**：弱网下管理 UI 会出现创建成功但拿不到可用链接，重复点创建还会产生更多孤儿分享。
- **架构影响**：幂等性只避免重复写，没有保证最终业务结果可达。
- **修改建议（intent）**：保持不重放明文的安全边界，补充基于重放返回 shareId 的删除/撤销后重新创建流程、前端提示与自动化验收；明确禁止把未知结果当失败直接换新幂等键重复创建。
- **优先级**：P1

### P1-A7 · 结构化日志已有生产者，但没有告警、负责人和回滚消费者

- **锚点**：`design.md` → `Cloudflare 日志检索即消费端。`
- **问题**：文档定义了事件名与字段，但没有日志采集可用性、指标聚合、阈值、告警接收者、保留期或发布回滚判据。特别是迁移误撤销、invalid_row 激增、配额拒绝异常和 `share.system.error` 目前只能人工搜索。
- **问题根因**：把“日志可检索”视为“观测闭环”，缺少 producer→consumer→action 链。
- **业务影响**：迁移或授权策略异常可能持续到用户投诉后才被发现，分阶段发布无法据此决定继续或回滚。
- **架构影响**：Link table 的观测链停在中间产物，未到达值班/发布决策消费者。
- **修改建议（intent）**：为关键事件指定采集与聚合方式、阈值/基线、告警负责人和 Runbook 动作，并把迁移后 invalid_row、旧写未收编和系统错误率纳入启用新能力的硬门槛。
- **优先级**：P1

### P2-F1 · requirements 仍遗漏 `auth_key_kid` 状态不变量

- **锚点**：`requirements.md` → `AC-AUTH-07`
- **问题**：design 已修订为 enabled IFF hash 与 kid 均非空，但 requirement 仍写 enabled IFF hash 非空。两份文档会生成不同 schema/service 测试。
- **修改建议（intent）**：统一 requirements 与 design 的三字段不变量及异常恢复验收。
- **优先级**：P2

### P2-F2 · update 的“字段缺省”与“显式清空限制”未区分

- **锚点**：`design.md` → `PUT /mailShare/update`
- **问题**：`maxSessions?`、`messageLimit?` 同时承担可选 patch 字段和 NULL=不限的业务值，但未定义 omitted、null、0 的差异；`resetUsedSessions` 与 NULL→有限值的组合也可能因客户端序列化产生不同结果。
- **修改建议（intent）**：定义 PATCH 式三态输入、可清空字段、非法 0 及计数基线行为，保证前后端 DTO 一致。
- **优先级**：P2

## 消费者前置条件核验

| 产物 / 策略 | 直接消费者 | 开启前置条件 | 前置不满足时的确定行为 |
|---|---|---|---|
| Binding 授权真源 | 新 Worker、scoped repository、cleanup | schema 完成；有效旧行已回填；非法行已隔离；查询只返回存活且归属正确的 Binding | 新能力关闭并 fail closed，不回退到陈旧 Binding |
| Expand 期 `account_id` 双写 | 旧 Worker | 仅服务旧单邮箱语义；任何新安全策略尚未激活；双写与 Binding 变更原子 | 禁止写入旧 Worker 无法解释的配置 |
| AuthKey、`cv`、配额 | 所有 Session 建立与回源 Worker | 确认无旧 Worker；所有路由均执行新鉴权；前端已理解新错误码 | Owner UI 隐藏/禁用这些写操作，已有分享保持旧语义 |
| multi Binding | create、bindings API、Visitor UI、旧 Worker | create 与 1→N bindings 变更共用门控；全量 Worker 和前端均已升级 | 拒绝任何使 Binding 数大于 1 的变更 |
| StatusEndpoint | Visitor 前端、rate limiter、scoped repository | 端点已全量部署；索引与上限负载测试通过；前端 404/429 处理明确 | 不发布调用该端点的新前端，或受同一能力开关控制 |
| Session 配额结果 | Visitor bootstrap | 请求重试语义和响应丢失恢复已确定；客户端不会无界自动重试 | 明确失败并提供可执行恢复，不静默重复扣额 |
| create 一次性秘密 | Owner 管理 UI | 能识别未知提交结果；能凭重放 shareId 清理并重建 | 不直接换新幂等键重复创建 |
| 结构化日志 | 日志平台、值班人、发布负责人 | 字段真实可得；告警规则、阈值、保留期与 Runbook 生效 | 不开启新能力或迁移 Contract 阶段 |

## 推荐的更优实现方向

1. 保留当前领域边界，不建 `mail_share_v2`、持久化 `share_type` 或完整 Session 权威服务。
2. 先把 `SHARE_MULTI_ENABLED` 提升为新能力激活协议：数据库扩展和代码部署可以先完成，但 AuthKey、配额、Binding 1→N、Status 新前端等消费者只有在“迁移完成 + 最终回填完成 + 无旧 Worker + 观测就绪”后才开放。
3. 修正迁移判定，使“无效 account”与“尚未被回填”成为不同状态；迁移每个阶段可重入，并以旧写三种时序和任务重启验证恢复。
4. 将 Session timeout 问题与已接受的 revoke TOCTOU 分开处理。优先使用短 TTL、最小化的请求幂等/结果重放记录；它只负责一次签发结果去重，不成为每次读请求的 Session 授权真源。
5. 保持 create 秘密不重放，采用“识别未知结果 → 幂等查询到 shareId → 清理 → 新请求重建”的简单恢复流程。
6. 为 Binding 设业务上限，并用真实最大 N 验证 status 查询计划、响应大小、3 秒轮询 CPU 和共享 NAT 限流行为。
7. 将日志事件接到告警与发布 Runbook；Contract 阶段继续延后，待生产观察证明旧消费者退出后再做。

## 开工前代码核验清单

以下均为“需实现方核实”，本轮不以代码事实代替文档证据。

### 当前领域模型和数据库结构

- D1 的 `c.env.db.batch()` 是否保证整批原子提交，且并发 batch 的写入隔离是否足以序列化 Binding 删除、主 Binding 重算与 REVOKED 更新？
- 现有 `account.user_id`、`is_del` 的真实列名和值域是否与迁移 SQL 完全一致，历史上是否存在 NULL、归属漂移或重复映射？
- `email_id` 是否在所有数据源中全局单调、不会跨库重置，并能安全穿过后端、JSON 与前端数值类型？
- `email(account_id, email_id)` 等现有索引是否支持 per-binding latest 与最新 N 查询，最大 N 下的 `EXPLAIN` 和 CPU 基线是否达标？
- D1 的 SQL 变量数、batch 语句数、响应体和 Worker CPU 上限是否允许计划中的最大 Binding 数？
- 逐条 try/catch 的 ALTER 是否只忽略“列已存在”，而不会吞掉权限、容量或 schema 损坏等真实迁移失败？

### 现有接口、任务和事件链路

- 旧 Worker 是否确实会忽略 AuthKey、`cv` 和配额列并继续签发，从而证明全能力栅栏必须覆盖哪些版本？
- Worker 部署是原子替换还是会真实并存多个版本，如何可靠证明“无旧 Worker 在途”？
- `PUT /mailShare/bindings` 是否会在任何 1→N 路径检查同一个能力开关，remove 是否始终带 `shareId + ownerId` 资源谓词？
- cleanup 任务中途失败或 Worker 重启后是否可重入，Binding、share 与 idempotency 行会按何顺序恢复？
- `SHARE_SESSION_RATE_LIMITER` 与 `SHARE_READ_RATE_LIMITER` 是否为真实存在的两个绑定，fail-open 时的降级和日志是否可见？
- 请求上下文是否稳定提供 `requestId`，日志平台是否能按 requestId/shareId 聚合且不会记录凭据？

### 前后端既有能力与消费者

- axios/fetch 层是否会自动重试 `POST /share/session` 或 create，超时后当前 UI 会不会重复扣额或重复创建？
- 旧 ShareDialog 对 create 响应字段、错误码和幂等重放的假设是否与新契约兼容？
- Visitor 前端遇到旧 Worker 返回 404、未知错误码或新 token 被旧 Worker处理时当前行为是什么？
- `useSharePolling` 是否能在 status 失败、后台恢复、Binding 集合变化和手动刷新之间维持单实例且不重复启动 timer？
- 管理 UI 是否已有“结果未知、清理旧 share 后重建”的交互组件，还是需要最小新增？
- share chunk 守护测试是否覆盖新 AuthKey 输入、status 客户端和水位存储的全部依赖闭包？

### 测试、生产数据与失败恢复

- 生产用户拥有邮箱数、单分享预期 Binding P50/P95/P99/最大值分别是多少？
- 是否有迁移前真实数据画像：合法、已删、缺失、归属不符、零/负 accountId 各多少行？
- 迁移测试是否注入旧写发生在 INSERT 前、INSERT 与 UPDATE 之间、UPDATE 后、收尾重跑中和任务重启后的全部时序？
- 滚动发布测试是否让请求随机命中新旧 Worker，并覆盖 AuthKey 绕过、配额超发、reset 后旧 token、bindings 1→N 绕门控？
- Session E2E 是否能注入 UPDATE 已提交后的网络断开、响应丢失和 Worker 重启，并证明一次逻辑请求不会不可控地消耗多次？
- Binding 并发测试是否覆盖两个删除、add/remove 同时发生、跨租户 bindingId 混入和 account 删除竞态？
- 日志告警是否在预发布环境实际触发过，发布负责人能否依据阈值执行关闭能力开关与回滚？

## 必须由产品 / 业务 / 技术负责人确认的问题

1. `max_sessions` 计数的是“服务端成功提交一次签发”还是“Visitor 可恢复地拿到一个 token”？前者是否接受一次网络超时耗尽 `max_sessions=1`？
2. 是否允许发布期间短暂冻结 AuthKey、配额、Binding 1→N 和新管理 UI，直到确认无旧 Worker？若不允许，必须提供可证明安全的版本协商方案。
3. 单条分享真实需要支持的最大邮箱数是多少？没有业务数据前不得默认无上限。
4. Owner enable AuthKey 时，已经签发的旧 Session 继续有效是否符合安全预期；若要求立即失效，enable 也必须改变版本语义。
5. create 成功但一次性 `sec` 未送达时，产品是否接受“删除并重建”，以及 UI 是否必须自动引导完成？
6. account 删除竞态产生的孤儿 Binding 是否允许只靠定时清理最终收敛？若邮件行仍保留，授权读路径必须立即过滤失效 account，不能把最终一致性当权限撤销。
7. 上线门槛采用哪些量化指标：迁移 invalid_row 数、未回填行数、系统错误率、status 延迟和配额拒绝率的阈值分别是什么？

## 落地决定

**调整方案后开发**：总体领域边界可保留，但必须先关闭旧 Worker 策略降级、迁移误撤销和 Session 响应丢失扣额三条生产失败链。

## Patch Plan

```yaml
patch_plan:
  - issue_id: P0-A1
    severity: P0
    target_file: design.md
    anchor: "### 迁移/发布协议(R2-A1 · 滚动发布双轨消解,AC-LIFE-10)"
    action: replace_section
    intent: 将发布栅栏扩展到 AuthKey、credentials_version、配额、bindings 1→N、Status 前端及全部新策略写入口，并以无旧 Worker 和消费者就绪作为激活条件
    rationale_short: 旧 Worker 会忽略新安全策略并成为随机路由可达的降级入口
  - issue_id: P0-A2
    severity: P0
    target_file: design.md
    anchor: "-- 未通过门禁的旧行(account 不存在/已删/归属不符):直接 REVOKED,不建 Binding(AC-BIND-11)"
    action: replace_section
    intent: 让无效行处置按 account 存活与归属事实判定，并覆盖旧写夹在回填与撤销语句之间及迁移重启后的恢复
    rationale_short: 以零 Binding 判脏会永久误撤销迁移窗口内的合法旧写
  - issue_id: P0-A3
    severity: P0
    target_file: requirements.md
    anchor: "- [AC-SESS-01]"
    action: append_after
    intent: 裁决配额的成功口径并定义响应丢失、超时、重试和 Worker 重启下的幂等结果重放或明确恢复契约
    rationale_short: 条件 UPDATE 后响应丢失会让一次逻辑建会话消耗多个名额甚至直接耗尽链接
  - issue_id: P1-A4
    severity: P1
    target_file: design.md
    anchor: "| `PUT /mailShare/bindings` | 新建 |"
    action: append_after
    intent: 定义 owner/share 双重资源谓词、批量全有或全无、冲突错误、1→N 门控与并发变更语义
    rationale_short: 裸 bindingId 与未定义部分成功会造成跨分享删除或主 Binding 失真
  - issue_id: P1-A5
    severity: P1
    target_file: requirements.md
    anchor: "- [AC-CAP-01]"
    action: append_after
    intent: 依据真实业务规模设定并强制每分享 Binding 上限，同时规定 status、session、get 的查询和响应预算
    rationale_short: 当前全量 Binding 协议在极端 N 下仍是无界查询与无界响应
  - issue_id: P1-A6
    severity: P1
    target_file: requirements.md
    anchor: "- [AC-CAP-09]"
    action: append_after
    intent: 保持秘密不重放，并定义未知提交结果下基于 shareId 清理后重新创建的前端与接口恢复流程
    rationale_short: 首次响应丢失会留下无法分发且占用额度的分享
  - issue_id: P1-A7
    severity: P1
    target_file: design.md
    anchor: "Cloudflare 日志检索即消费端。"
    action: replace_section
    intent: 补齐日志采集、指标阈值、告警负责人、保留期、Runbook 与新能力启用和回滚门槛
    rationale_short: 可检索日志不是 producer 到发布决策消费者的完整观测闭环
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 4
p2_count: 2
one_line: 当前架构可保留，但全能力发布栅栏、迁移旧写竞态和 Session 响应丢失扣额三项 P0 未闭合，需调整方案后再开发。
