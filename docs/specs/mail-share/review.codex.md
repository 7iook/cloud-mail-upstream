> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。仍需 R+1 → 修完 spec 再跑下轮。

---

# 第 1 轮评审结论

## 总体判断

方案已经识别出资源级授权、字段投影、匿名前端隔离、安全渲染等关键边界，整体方向优于复用全局 `/public/*` 令牌。

但当前仍有三处会直接影响授权正确性的架构缺口：

1. Share Session 只有接口名称，没有完整安全契约。
2. 持久化状态与动态过期状态互相矛盾。
3. 邮件范围校验被错误地表述为投影函数的前置条件，缺少不可绕过的数据访问边界。

在这三点明确前，不建议进入实现阶段。

---

## 一、架构级问题

### A1 · Share Session 是核心授权凭据，但生命周期与安全模型缺失

**定位锚点：** design.md「Visitor 侧（公开，精确路径）：」

- **问题：** 文档只定义 `/share/session` 返回 `sessionToken`，未定义其格式、签发者、有效期、存储方式、传输位置、续期、撤销、重放策略及服务端如何由它恢复 `ShareContext`。
- **问题根因：** 把“避免重复发送 `sec`”直接跳到了“新增 Session Token”，却没有完成第二种 bearer credential 的威胁建模。
- **业务影响：** 链接已销毁后可能仍被旧会话使用；或者实现方各自选择 Cookie、Header、查询参数，形成不一致行为。
- **架构影响：** `share-auth-service` 无法成为真正唯一的授权入口；日志、缓存、CSRF/CORS、会话泄漏边界均无法验证。
- **修改建议：** 明确 Session 的签发与验证模型、绝对有效期、与 Share 生命周期的关系、承载位置、缓存策略、密钥轮换及失败响应。说明 Session 是否有服务端状态；若无状态，必须定义签名载荷与逐请求回源检查；若有状态，补数据模型和清理策略。
- **优先级：P0**

### A2 · `EXPIRED` 同时被设计成持久状态和动态计算状态，状态机不闭合

**定位锚点：** design.md「## Data Models」

- **问题：** 表中状态为 `ACTIVE/EXPIRED/REVOKED`，但 AC-LIFE-01 明确过期不依赖任务改写状态；同时 AC-LIFE-08 又要求 Owner 列表展示 `EXPIRED`。文档没有定义谁、何时把 `ACTIVE` 改成 `EXPIRED`。
- **问题根因：** 将“授权是否有效”“持久化生命周期状态”“管理端展示状态”混成了一个字段。
- **业务影响：** 同一记录可能在 Visitor 侧已经过期，在 Owner 列表仍显示 ACTIVE；重新生成、清理和活跃数量统计也可能得出不同结果。
- **架构影响：** 状态机没有合法迁移表；`regenerate` 是原行换密钥、销毁旧行再建新行，还是重新激活过期行均未定义。
- **修改建议：** 选定单一模型：要么只持久化可操作状态并计算 `effectiveStatus`，要么明确原子状态迁移与触发者。补充创建、自然过期、撤销、重新生成、清理的状态迁移表，并统一 `SHARE_DISABLED` 与 Visitor `SHARE_UNAVAILABLE` 的适用边界。
- **优先级：P0**

### A3 · Visible Window 校验没有落在不可绕过的数据访问边界

**定位锚点：** design.md「### `shareMailService.project(emailRow) -> VisitorMailDTO` (待建)」

- **问题：** `project()` 的前置条件称 `emailRow` 已由 `shareAuthService` 确认在 Visible Window 内，但 `shareAuthService.resolve()` 只解析分享记录，不接收或查询邮件，事实上无法完成该确认。
- **问题根因：** 将授权上下文校验、邮件范围查询和 DTO 投影三个职责通过调用约定隐式串联，没有形成强制查询契约。
- **业务影响：** 任一调用方若先按裸 `emailId` 取行再投影，就可能泄漏其他邮箱或窗口外邮件。
- **架构影响：** 核心数据隔离依赖“调用者记得先检查”，与“唯一授权入口”和反腐层声明矛盾。
- **修改建议：** 定义不可绕过的 scoped repository/query contract，在同一查询条件内绑定 `account_id`、窗口下界、删除状态及必要的当前归属条件；列表、详情、长轮询只能消费该契约。投影函数只负责字段白名单，不承担范围授权。
- **优先级：P0**

### A4 · 一次性 Secret 与重试语义冲突，创建和重新生成缺少幂等契约

**定位锚点：** requirements.md「### Requirement 1: 创建分享链接」

- **问题：** `sec` 只返回一次，但创建响应丢失时，客户端无法判断是否已创建，也无法重新取得该 Secret；直接重试会产生孤儿分享。重新生成若先让旧链接失效、响应随后丢失，Owner 也拿不到新链接。
- **问题根因：** 只设计了成功路径，没有把网络重试与“Secret 不可再次读取”一起建模。
- **业务影响：** 重复分享、无法管理的有效授权、短暂断网后旧链接失效但新链接不可得。
- **架构影响：** 活跃数量上限的“检查后插入”、撤销与重新生成也缺少原子条件更新，存在并发越限或重复迁移。
- **修改建议：** 明确创建和重新生成的幂等键、重放结果、响应丢失恢复方式及事务边界；数量上限应与创建原子完成，状态操作采用条件更新并规定重复请求结果。
- **优先级：P1**

### A5 · 匿名读模型无分页和容量边界，长轮询成本可被合法链接无限放大

**定位锚点：** requirements.md「### Requirement 4: 新邮件实时出现」

- **问题：** `/share/mails` 没有分页、排序、批量上限；`/share/wait` 没有请求游标格式、批量返回规则、断线重连和多封并发到达语义。每位访问者每秒查询 D1，且没有有效会话并发预算。
- **问题根因：** 只估算了单连接延迟，没有建立“单链接多访问者 × 每秒查询 × 25 秒”的容量模型。
- **业务影响：** 邮件量大时首屏响应不可控；同一合法链接被多人打开即可消耗大量查询；多封同时到达可能遗漏或重复展示。
- **架构影响：** O(1) 索引点查不等于总体成本有界，当前方案缺少稳定读模型契约。
- **修改建议：** 定义稳定排序、分页上限、游标推进、批量返回和断线恢复；给出单链接并发与总体查询预算。这里属于长连接资源保护，不是对普通读接口随意限流。
- **优先级：P1**

### A6 · 仅按公开 `lid` 锁定失败尝试，会形成针对有效分享的拒绝服务

**定位锚点：** requirements.md「### Requirement 9: 滥用防护（本期最小）」

- **问题：** `lid` 明确不是秘密且位于 URL 路径，攻击者取得 `lid` 后可故意提交错误 `sec`，耗尽该 `lid` 的失败额度，使真实 Visitor 被拒绝。
- **问题根因：** 把枚举防护直接实现成资源级失败锁定，没有分析防护机制自身的滥用路径。
- **业务影响：** 有效分享可被第三方低成本阻断，验证码转交场景直接停摆。
- **架构影响：** 失败计数还没有表结构、原子更新、TTL、恢复窗口和成功后处理规则；“不使用 KV”并不是完整设计。
- **修改建议：** 重构失败预算维度，确保单个匿名来源不能永久锁死资源；补计数存储、时间窗、原子性、恢复和可观测性。由于文档已指出 IP 来源不可靠，需明确可信边缘信息或其他实际可行的组合维度。
- **优先级：P1**

### A7 · 匿名页面仍落在同一 SPA 启动链，不能仅靠“路由不进 layout”证明隔离

**定位锚点：** design.md「## Architecture & Layering」

- **问题：** `/s/<lid>` 仍走 SPA fallback。虽然分享组件不导入登录态 layout/Dexie，但没有证明主入口、全局插件、配置加载、监控或未来分析脚本不会在路由判断前执行并读取 fragment。
- **问题根因：** 将组件树隔离等同于运行时与供应链隔离。
- **业务影响：** `sec` 可能被全局初始化代码、错误上报或浏览器历史保留；匿名页面也可能因登录态初始化失败而白屏。
- **架构影响：** “不得加载任何第三方脚本”目前只有构建产物人工检查，缺少可持续边界。
- **修改建议：** 明确匿名 bootstrap 的隔离方式或给出同入口下可验证的导入/运行时约束；客户端读取 `sec` 后应立即清除 fragment，并明确 CSP、监控和错误上报策略。
- **优先级：P1**

### A8 · 多租户与权限模型没有形成领域契约

**定位锚点：** design.md「Owner 侧（JWT + perm `share:*`）：」

- **问题：** 文档同时使用 Owner `user_id`、account 所有权和新权限 `share:*`，但没有定义三者关系，也没有权限注册、默认授予、租户隔离或管理员代管规则。
- **问题根因：** 把现有 `userId` 等同于完整租户边界，并把一个待建权限字符串当成已成立前提。
- **业务影响：** 普通用户可能无法使用功能，或跨租户管理员获得超出预期的分享能力。
- **架构影响：** Owner API、列表查询、account 转移和功能开关缺少统一授权策略。
- **修改建议：** 需实现方核实系统是否存在独立 tenant 概念；随后定义 User、Tenant、Account、Permission 的不变量，并补路由权限注册和 account 转移后的处理规则。
- **优先级：P1**

---

## 二、普通功能与需求问题

### F1 · OTP 合并规则互相矛盾，且排除条件被写成不可兑现的绝对性质

**定位锚点：** requirements.md「### Requirement 5: 验证码识别与展示」

- **问题：**
  - design.md 决定“确定性打分器与 LLM 取并集、确定性优先”，AC-OTP-06 却规定只在确定性结果为空时使用 LLM。
  - P-OTP-01 要求对任意输入绝不把年份、订单号等识别为验证码，但数字 `2026` 在不同上下文中既可能是年份，也可能是真实验证码。
  - 打分器只输入 `subject/text`，没有定义 HTML-only 邮件如何获得文本。
- **问题根因：** 将启发式识别目标写成了可证明的分类不变量，且未先定义产品层面的误报/漏报策略。
- **业务影响：** Visitor 可能看到错误验证码，或者已有 LLM 正确结果被较弱的确定性候选遮蔽。
- **架构影响：** 两条抽取链没有统一候选模型、归一化、去重和决胜规则。
- **修改建议：** 统一双路合并策略；定义支持的字符集、长度、上下文证据、冲突处理和 HTML 文本来源。把不可能保证的“绝不误判”改为可测试的样本集与业务阈值。
- **优先级：P1**

### F2 · SafeMailRenderer 的安全契约仍是黑名单拼接，未达到“任意 HTML 安全”的验收强度

**定位锚点：** requirements.md「### Requirement 6: 正文安全渲染（双模式）」

- **问题：** 元素黑名单和 CSS 子串过滤没有定义完整的允许元素/属性集合、URL 规范化、`srcset`/媒体资源、CSS 转义等处理；“沙箱化上下文”也没有说明具体承载机制和通信边界。
- **问题根因：** 验收性质声称覆盖任意 HTML，但设计仍以列举危险字符串为主。
- **业务影响：** 邮件发信人控制的内容可能绕过过滤，或者安全策略过严导致正文不可用。
- **架构影响：** 全站统一渲染器一旦策略错误，会同时影响登录态和分享页，爆炸半径扩大。
- **修改建议：** 将契约改成默认拒绝的元素、属性和协议正向允许模型；明确沙箱载体、是否允许同源、链接打开、远程资源解锁及净化失败降级。库版本与配置应成为单一安全策略。
- **优先级：P1**

### F3 · “严格最小集”与预留字段、访问指标及附加管理信息不一致

**定位锚点：** requirements.md「本 charter 的范围是**严格最小集**」

- **问题：** 方案仍预留 `password_hash/max_views/current_views/otp_only/allow_html/allow_attachments` 等本期不用字段，并新增 `name/remark/access_count/last_access_at/otpConfidence`，但没有逐项给出真实用户场景和缺失影响。
- **问题根因：** 将未来可能需要、接口看起来完整或方便统计，直接转化成了当前模型字段。
- **业务影响：** 增加迁移、写放大、隐私解释和维护成本；尤其访问计数会把纯读操作变成持续写操作。
- **架构影响：** 未来能力在尚无语义时提前固化，形成错误 schema 和第二轮兼容负担。
- **修改建议：**
  - 预留未来字段判为 **D 技术洁癖**，本期删除。
  - `access_count/last_access_at`、`name/remark`、置信度展示需补具体角色、业务操作、缺失损失及 A/B/C/D 分类；无法回答则移出本期。
  - SafeMailRenderer 属 **B 稳定性/安全保护**，功能开关与创建上限也可归 B；应保留但写清业务目的。
- **优先级：P1**

---

## 三、值得保留的设计

- 资源级 capability 与全局机器令牌分离，限界上下文方向正确。
- `lid + sec-verifier` 拆分避免将完整 bearer secret 建索引，方向合理。
- Visitor DTO 使用固定白名单而不是直接返回邮件行，符合最小披露原则。
- 过期判定不依赖清理任务、附件明确不进入首版，均有效缩小了风险面。
- 验收矩阵覆盖面较好，但必须在上述核心契约收敛后再作为实现依据。

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: design.md
    anchor: "Visitor 侧（公开，精确路径）："
    action: replace_section
    intent: 补全 Share Session 的签发、承载、验证、过期、撤销、重放、存储和密钥轮换契约
    rationale_short: 核心匿名授权凭据只有接口名称而无安全生命周期
  - issue_id: A2
    severity: P0
    target_file: design.md
    anchor: "## Data Models"
    action: replace_section
    intent: 统一持久状态、动态过期状态与管理端展示状态，并给出完整状态迁移表
    rationale_short: EXPIRED 无写入机制却同时被当成持久状态和有效性判定
  - issue_id: A3
    severity: P0
    target_file: design.md
    anchor: "### `shareMailService.project(emailRow) -> VisitorMailDTO` (待建)"
    action: replace_section
    intent: 将账户与可见窗口约束下沉为不可绕过的 scoped repository 查询契约
    rationale_short: 授权服务无法证明传入投影函数的邮件已落在可见窗口
  - issue_id: A4
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 1: 创建分享链接"
    action: append_after
    intent: 补充创建、重新生成、撤销和活跃数量限制的幂等及原子并发语义
    rationale_short: 一次性 secret 与网络重试会产生孤儿授权或不可恢复的新链接
  - issue_id: A5
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 4: 新邮件实时出现"
    action: replace_section
    intent: 定义分页、稳定排序、游标批量推进、断线恢复及长轮询容量预算
    rationale_short: 当前匿名读模型和每秒 D1 查询成本均无上界
  - issue_id: A6
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 9: 滥用防护（本期最小）"
    action: replace_section
    intent: 重构失败预算维度并补齐计数存储、时间窗、恢复和原子更新规则
    rationale_short: 按公开 lid 锁定会让攻击者拒绝真实访问者
  - issue_id: A7
    severity: P1
    target_file: design.md
    anchor: "## Architecture & Layering"
    action: append_after
    intent: 建立匿名 bootstrap 的运行时隔离、fragment 清除、CSP 和监控边界
    rationale_short: 不进入登录态 layout 不能证明同一 SPA 启动链不会读取或外传 secret
  - issue_id: A8
    severity: P1
    target_file: design.md
    anchor: "Owner 侧（JWT + perm `share:*`）："
    action: insert_before
    intent: 明确 User、Tenant、Account 与 share 权限关系及权限注册和转移规则
    rationale_short: 当前只有 user_id 假设，无法证明多租户和角色权限隔离
  - issue_id: F1
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 5: 验证码识别与展示"
    action: replace_section
    intent: 统一确定性与 LLM 候选合并策略并改写不可兑现的绝对排除性质
    rationale_short: 双路优先级互相矛盾且启发式分类被错误写成全称不变量
  - issue_id: F2
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 6: 正文安全渲染（双模式）"
    action: replace_section
    intent: 改为默认拒绝的元素属性协议允许模型并明确沙箱载体与失败边界
    rationale_short: 黑名单和字符串过滤不足以支撑任意 HTML 安全承诺
  - issue_id: F3
    severity: P1
    target_file: requirements.md
    anchor: "本 charter 的范围是**严格最小集**"
    action: replace_section
    intent: 删除本期不用的预留字段并为访问指标和附加管理信息补业务场景与分类
    rationale_short: 技术预留和无业务依据字段违背严格最小集
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 8
one_line: 授权会话、状态机和邮件范围查询边界尚未闭合，需先修正三项 P0 并收敛并发、容量与安全契约。
