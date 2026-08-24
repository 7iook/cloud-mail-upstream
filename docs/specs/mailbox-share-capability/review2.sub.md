# 第 2 轮评审结论（反向验证与替代方案）

实际评审模型：GPT-5.6 Sol

## 简短摘要

R1 原四项 P0 中，`access_count` 物理重命名、`share_type` 双真源、掩码契约自相矛盾三项已在当前正文中闭合；R1-A4 仅把数据库 UPDATE 定成线性化点，却仍承诺“签发时绝不产生即死 token、绝不白耗配额”，该承诺在 UPDATE 与离线签 token 之间遭遇并发撤销时仍不可实现，故继续列 P0。

总体方向无需领域重建：`mail_share` + Binding 唯一真源、无状态短期 token、scoped repository 可以保留。当前更合理的是**局部重构**，先修正滚动发布契约、per-binding 游标协议和线性化语义，再进入实现；此时直接沿用现状会出现“测试全绿但旧链接/多邮箱未读/并发撤销仍失败”的路径，而立即建设服务端 Session/独立服务又明显过重。

## P0 · 必须调整

### A1 · Binding 切换不是 expand-only，滚动发布会形成新旧授权双轨

- **文档锚点**：`design.md` → `### 迁移 v3_2DB · 旧行回填` → `迁移后不再写 mail_share.account_id(新建行写 0)`
- **问题**：正文用保留 `access_count` 物理列证明旧 Worker 可回滚，却同时让新代码立即停止维护 `mail_share.account_id`。滚动发布期间，旧 Worker 读取新建分享会看到 `account_id=0`；读取已移除原 Binding 的旧分享仍会按陈旧 `account_id` 授权；旧 Worker 在一次性回填之后新建的分享又可能没有 Binding，直到迁移再次运行。
- **问题根因**：把“列仍存在”误当成“旧版语义仍兼容”，并隐含假设迁移、全部 Worker 切换、回滚是一个原子动作。
- **业务影响**：既可能让新分享在部分实例不可用，也可能让已移除邮箱继续被旧实例读取，直接破坏旧链接兼容和授权即时收窄。
- **架构影响**：`mail_share.account_id` 与 Binding 在兼容窗口内仍是两个可执行授权源，当前方案没有记录级版本、部署栅栏或双读写阶段来决定谁可服务哪类行。
- **修改建议（intent）**：定义可验证的分阶段发布与回滚协议，使旧实例不能按陈旧主表字段服务 Binding 已切换的记录，并覆盖“旧实例晚写、新实例读取”“Binding 移除后旧实例读取”“回滚读取新建多邮箱分享”三条路径。
- **优先级**：P0

### A2 · 单个 `sinceEmailId` 无法表达文档要求的 per-binding 消费水位

- **文档锚点**：`design.md` → `### Status 游标协议(R1-A7 · AC-OTP-09)`
- **问题**：API 只接收一个全局 `sinceEmailId`，但协议又要求“消费某 Binding 后只推进该 Binding 游标，未拉取的 Binding 游标不动”。`email_id` 全局单调只解决排序，不会把多个邮箱的消费进度合并成一个标量。
- **问题根因**：把全局事件顺序与每个 Binding 的已读/已消费水位混为一谈。
- **业务影响**：用当前 Tab 的高水位请求会漏掉其他 Tab 尚未消费的较小 ID 邮件；用最小水位请求则会持续重复计算已消费邮箱。多邮箱角标与自动刷新可以在单邮箱测试全绿时仍然失真。
- **架构影响**：StatusEndpoint 的请求模型无法实现其自身状态机，客户端与服务端必然各自补一套隐含规则。
- **修改建议（intent）**：在“请求携带 per-binding 水位”与“单一全局轮询水位、客户端独立累计每 Binding 未读”之间作出唯一裁决，并同步 API、AC、前端存储恢复和 Binding 增删语义。
- **优先级**：P0

### A3 · R1-A4 的 UPDATE 只定义了授权线性化点，无法保证响应时 token 仍可用

- **文档锚点**：`design.md` → `shareAuthService.establishSession` → `- **流程(单一线性化点,R1-A4)**`
- **问题**：流程是条件 UPDATE 成功后才 `issueToken`。若 UPDATE 提交后、签 token 或返回响应前发生 revoke、reset/disable 或删空 Binding，该请求仍会计数并返回一个回源即失败的 token。数据库条件只能证明 UPDATE 时刻有效，不能证明后续签发/响应时刻仍有效。
- **问题根因**：一方面选择无状态 token 和数据库 UPDATE 为线性化点，另一方面又要求跨越该点之后的并发状态变化也不得使本次结果失效；两者无法同时成立。
- **业务影响**：并发时仍会出现“接口成功但访客进不去且名额已消耗”，即 R1-A4 要消除的原失败链。
- **架构影响**：测试若只覆盖“状态变化发生在 UPDATE 之前”会全绿，却没有证明 UPDATE→状态变化→签发这一交错；严格的“响应时可用”若不可放宽，则需要服务端 grant/session 记录及不同事务边界，已超出当前无状态模型。
- **修改建议（intent）**：明确业务不变量究竟是“在 UPDATE 线性化时合法并计数”还是“响应时仍保证可用”；前者应删除不可实现的更强承诺并验收所有交错，后者应重新评估服务端 grant/session 边界，而不是继续在条件 UPDATE 上叠加措辞。
- **优先级**：P0

## P1 · 重要调整

### A4 · 迁移回填默认所有旧 `account_id` 都完整有效

- **文档锚点**：`design.md` → `### 迁移 v3_2DB · 旧行回填` → `-- 每条存量 mail_share 行幂等回填恰一条 Binding(AC-BIND-09)`
- **问题**：回填 SQL 不校验 account 是否存在、未删除、仍归原 Owner，却把每条旧行都升级成可执行 Binding；运行时新增 Binding 反而要求这些条件。
- **问题根因**：把历史数据完整性当作迁移前提，没有定义画像、异常分类和安全失败策略。
- **业务影响**：脏旧行可在新模型中继续 ACTIVE，甚至在 cleanup 前暴露已删除邮箱的邮件；单纯断言“每行恰一 Binding”仍会全绿。
- **架构影响**：Binding 作为唯一授权真源后，迁移把历史缺陷正式固化为新领域事实。
- **修改建议（intent）**：为回填增加迁移前数据画像与无效旧行的撤销、隔离或人工处置策略，并把 account 存活、归属和零非法 Binding 纳入迁移门禁。
- **优先级**：P1

### A5 · 旧观测计数缺少启用配额时的基线

- **文档锚点**：`requirements.md` → `AC-EDGE-09`
- **问题**：文档称历史 `access_count` “不追溯为配额消耗”，但只验收 `max_sessions=NULL`。Owner 后续给迁移旧分享设置 `max_sessions` 时，保留的历史计数会立即参与 `used_sessions >= max_sessions`，可能当场触顶。
- **问题根因**：把历史观测累计值直接升级为执行配额，却没有定义配额启用纪元或基线。
- **业务影响**：管理页成功保存一个看似新的配额后，旧分享可能立即不可建立 Session；现有迁移测试与新建分享测试仍可全部通过。
- **架构影响**：同一物理值在启用配额前后承担不同业务语义，缺少可审计的切换边界。
- **修改建议（intent）**：裁决旧分享首次启用配额时历史计数是否计入；若不计入，建立明确基线或重置策略，并增加“迁移旧行后从 NULL 更新为有限值”的验收。
- **优先级**：P1

### A6 · 128-bit 服务端生成 Key 上再建失败状态表，未证明解决真实风险

- **文档锚点**：`design.md` → `### mail_share_auth_fail(新表 · AuthKey 失败计数/短窗锁定,R1-A6)`
- **问题**：AuthKey 是 128-bit CSPRNG，在线穷举本身不可行，且已有 IP 边缘限流；新增 per-share+IP 状态表、原子 UPSERT、cleanup 和 IP 哈希轮换，并不能阻止分布式来源，只重复限制单一出口。
- **问题根因**：没有区分“防猜中高熵凭据”与“控制恶意请求成本”，把常见密码锁定机制直接套到机器生成 capability 上。
- **业务影响**：共享 NAT 下合法访客会被他人失败牵连，而真正的分布式流量仍由边缘限流承担；运维多出一套状态和清理故障面。
- **架构影响**：为未量化威胁引入第二套限流真源，跨越 auth、D1 状态和 cleanup 三个边界。
- **修改建议（intent）**：用具体滥用场景和缺失影响重新判定该表的业务分类；若目标只是请求成本保护，优先收敛到既有边缘限流，若保留则明确其独有威胁、可信 IP 来源与不可由现有设施覆盖的证据。
- **优先级**：P1

### A7 · 掩码矛盾已修复，但当前能力只能算展示偏好，不能算隐私边界

- **文档锚点**：`design.md` → `- **Decision 14 · 脱敏**`
- **问题**：系统字段被掩码，但发件人、主题和正文允许原样出现绑定地址。这样可以保持邮件保真，却无法满足“隐藏邮箱身份”的隐私目标；当前文档仍把该项放在“权限与安全边界”中。
- **问题根因**：R1 通过收窄 property 消除了不可实现冲突，但没有重新裁决原始“脱敏”究竟是 UI 降噪还是保密能力。
- **业务影响**：字段级测试会全绿，访客仍可能从真实邮件内容看到完整地址；Owner 若按安全开关理解会得到错误承诺。
- **架构影响**：展示投影与内容保密是不同领域能力；后者需要快照/内容改写及明确保真取舍，不能由 `maskAddress` 承担。
- **修改建议（intent）**：将该配置明确归类为展示偏好并从安全保证中移出，或在确有隐私业务需求时单独定义内容脱敏产品边界、可接受的信息损失和验证目标。
- **优先级**：P1

## P2 · 次要问题

### F1 · AuthKey 字段不变量遗漏 `auth_key_kid`

- **文档锚点**：`design.md` → `### AuthKey 状态机(R1-A5)` → `- **字段不变量**`
- **问题**：只约束 enabled 与 hash，未约束 enabled 状态必须存在可解析的 `auth_key_kid`；hash 非空但 kid 为空仍会形成无法校验的启用态。
- **修改建议（intent）**：把 kid 纳入状态不变量、迁移检查和异常恢复验收。
- **优先级**：P2

### F2 · 结构化日志清单无法支撑正文宣称的五类诊断

- **文档锚点**：`design.md` → `### 结构化观测(R1-F3 · 不新增事件表)` → `运营方据此区分`
- **问题**：固定事件只有 quota/auth/lock/cv/cascade，没有迁移失败、孤儿发现/清理或通用系统故障事件，也没有请求关联字段，却宣称可区分“配额/锁定/撤销/孤儿/系统故障”。
- **修改建议（intent）**：使可观测事件、关联字段和文档声称的诊断能力一一对应，或收窄可诊断范围。
- **优先级**：P2

## 三条路径对比

| 路径 | 收益 | 成本与风险 | 结论 |
|---|---|---|---|
| 沿用现状 | 最少文档调整；可直接拆 tasks | 滚动发布双轨授权、游标契约不可表达、并发签发承诺不可实现；最容易“局部全绿、最终目标失败” | 停止进入实现 |
| 局部重构 | 保留既有 capability、Binding、无状态 token 与 scoped repository；修正发布阶段、游标请求模型、配额基线和线性化语义 | API/迁移/验收矩阵需要重排，但不引入新服务 | **推荐** |
| 领域重构 | 服务端 Session/Grant ledger 可提供逐次审计、响应级配额补偿与更强状态保证；独立内容快照可做真正脱敏 | 新真源、存储清理、token 双版本、迁移与运营复杂度显著增加 | 仅当“响应时绝不即死/可退还名额”或“内容级隐私”是不可放宽业务目标时采用 |

## 全绿但未达成原始目标的路径

1. 迁移测试只在“回填完成后全部请求由新代码处理”环境运行：全部通过，但真实滚动窗口中的旧 Worker 仍可按陈旧 `account_id` 授权。
2. Status 测试让所有 Binding 共用同一水位或只操作当前 Tab：全部通过，但真实用户先读 A、未读 B 时，单标量无法保留 B 的独立水位。
3. 并发测试只把 revoke/reset 安排在条件 UPDATE 之前：全部通过，但 UPDATE 成功后、`issueToken` 前发生状态变化仍返回即死 token 并消耗名额。
4. 迁移测试只断言旧行 `max_sessions=NULL`：全部通过，但 Owner 日后首次设置有限配额时历史观测计数会被追溯执行。
5. 掩码 property 只枚举系统投影字段：全部通过，但正文或发件人仍可暴露完整绑定地址；若原始目标是隐私而非展示，这不算完成。

## 保留、调整与停止项

- **保留**：Binding 作为邮箱归属唯一真源、`share_type` 实时派生、`access_count` 物理列保留、scoped repository 作为范围强制点、无状态短 TTL token。
- **调整**：Binding 的分阶段切换与回滚、Status per-binding 水位模型、并发线性化承诺、旧计数配额基线、迁移数据门禁、掩码能力分类。
- **暂停继续开发**：当前单标量 StatusEndpoint；在威胁证据不足前的 `mail_share_auth_fail` 状态表；无法由无状态模型兑现的“响应时绝不即死且不白耗配额”验收措辞。

## Patch Plan

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: design.md
    anchor: "迁移后不再写 `mail_share.account_id`(新建行写 0)"
    action: replace_section
    intent: 定义 Binding 切换的分阶段发布、旧实例服务栅栏与回滚协议，并覆盖旧实例晚写和陈旧授权路径
    rationale_short: 保留旧列不等于旧版授权语义兼容
  - issue_id: A2
    severity: P0
    target_file: design.md
    anchor: "### Status 游标协议(R1-A7 · AC-OTP-09)"
    action: replace_section
    intent: 在 per-binding 请求水位与全局轮询水位加客户端累计之间作唯一裁决并统一端到端契约
    rationale_short: 单个 sinceEmailId 无法表达每个 Binding 独立推进的消费进度
  - issue_id: A3
    severity: P0
    target_file: design.md
    anchor: "- **流程(单一线性化点,R1-A4)**"
    action: replace_section
    intent: 将并发保证收敛到 UPDATE 线性化时刻，或在坚持响应时可用保证时重新评估服务端 grant/session 边界
    rationale_short: UPDATE 后仍可能并发失效，条件 SQL 无法保证签发或响应时 token 可用
  - issue_id: A4
    severity: P1
    target_file: design.md
    anchor: "-- 每条存量 mail_share 行幂等回填恰一条 Binding(AC-BIND-09)"
    action: insert_before
    intent: 增加旧 account 引用的数据画像门禁和无效行安全处置策略
    rationale_short: 无条件回填会把历史脏引用固化为新授权真源
  - issue_id: A5
    severity: P1
    target_file: requirements.md
    anchor: "- [AC-EDGE-09]"
    action: append_after
    intent: 裁决迁移旧分享首次启用有限配额时的历史计数基线并增加对应验收
    rationale_short: max_sessions 从 NULL 改为有限值会让历史观测计数被追溯执行
  - issue_id: A6
    severity: P1
    target_file: design.md
    anchor: "### `mail_share_auth_fail`(新表 · AuthKey 失败计数/短窗锁定,R1-A6)"
    action: replace_section
    intent: 以真实滥用场景验证失败状态表相对既有边缘限流的独有价值，无独有价值则删除该状态边界
    rationale_short: 128-bit 随机 Key 不可在线穷举，新增表未阻止分布式流量且重复单 IP 限制
  - issue_id: A7
    severity: P1
    target_file: design.md
    anchor: "- **Decision 14 · 脱敏**"
    action: replace_section
    intent: 明确掩码是展示偏好还是内容隐私保证，并让安全边界、产品文案和验收目标一致
    rationale_short: 系统字段掩码无法阻止原始邮件内容暴露绑定地址
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 4
p2_count: 2
critical_count: 3
important_count: 4
minor_count: 2
ready_to_merge: false
one_line: 建议保留现有领域边界并做局部重构，但滚动发布授权双轨、Status 游标不可表达及 R1-A4 未闭合三项 P0 使当前 spec 不应进入实现。
