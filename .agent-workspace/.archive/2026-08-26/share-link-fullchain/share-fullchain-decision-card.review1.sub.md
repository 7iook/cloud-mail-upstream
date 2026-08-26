# 第 1 轮评审结论 · 分享链接全链路整改决策卡

## 原始用户目标与可观察成功状态

| 目标 | 文档给出的最终可观察结果 | 评审结论 |
|---|---|---|
| P1 Owner 看到实时过期态 | 刷新、回到页面或停留跨过期时刻后，所有 Owner 展示面都显示 EXPIRED | 目标与负向条件清楚，但五个展示面的时钟与刷新接线没有逐面闭合，存在只修部分消费者的风险 |
| P2 用完整邮箱批量创建分享 | 无需先走账号注册即可输入一个或多个完整邮箱；未知域名友好失败且零写入 | 目标清楚，但批量成功仍受 V2 feature flag 限制；后台建 account 的权限边界、原子性与并发语义未定，当前方案不能保证生产闭环 |
| P3 关闭结果区不再二次确认 | 创建成功后关闭即离开，结果区内保留 AuthKey 一次性警告 | 链路短且闭合，未发现阻断问题 |
| P4 销毁链接呈现原生 404 | 直接导航及访客 API 对 missing/revoked 返回 HTTP 404 空 body，不再渲染业务 unavailable 页 | 路由方向成立，但计划证据只验证 HTTP 响应，尚不能证明真实浏览器最终可见结果；DB fail-open 又缺少可观测性 |
| P5 访客页按设计卡收码 | OTP、空箱、桌面/移动布局按设计卡呈现且 `data-share-*` 不变 | 目标有来源和 UI 卡，但最终任务没有把真实浏览器视觉/交互验收设为必做 |

总体上，五条目标、来源和负向条件比普通决策卡完整；当前首个偏离点集中在 P2 写边界及生产可达性，而不是 UI 或字段是否存在。

## 端到端 Goal→Outcome 链路表

| 目标/跳点 | producer | artifact | consumer | result | failure |
|---|---|---|---|---|---|
| P1 权威快照 | Worker list | `expiresAt`、`effectiveStatus` | Owner 前端 | 浏览器拿到服务端快照 | API 错误走既有错误态 |
| P1 实时覆盖 | `useShareClock` / `liveEffectiveStatus` | 响应式 `nowMs` 与展示态 | 五个 Owner 展示面 | 刷新、再激活、停页跨时刻均显示 EXPIRED | 文档只明确 email/ShareIndicator 的刷新调用；其余消费者可能继续读取快照 |
| P2 输入与传输 | ShareCreateWizard / `createMailShare` | 标准化 `emails[]` | Worker create | 完整邮箱到达后端 | 批量请求可能被既有 V2 栅栏挡住，文档未给生产启用前提或用户失败行为 |
| P2 account 解析 | `ensureOwnedMailboxes` | 新建或复用的 accountIds | 现有 share insert | 用户无需先做账号注册即可得到分享链接 | account 写策略与既有 `account-service.add` 分叉；并发、后续 share 失败可留下孤儿 account |
| P3 关闭 | `onOpenChange` | 无 confirm 的关闭动作 | Owner | 结果区立即关闭 | 旧 W15 若未同步会制造错误消费者；文档已列出修改 |
| P4 文档入口 | Worker gone 检查 | HTTP 404 空 body | 浏览器导航 | 不出现业务 HTML | 原始 HTTP 断言不能单独证明支持浏览器中的最终呈现；DB 异常会 fail-open 到 SPA |
| P4 已打开页面 | 访客 API / `ShareGoneError` | 404、单次 reload | 当前 SPA 与 Worker 文档入口 | 销毁后最终落到文档 404 | DB 抖动时 reload 可能再次得到 SPA，且卡片明确“不新开监控” |
| P5 视觉 | UI 设计卡与 scoped CSS | token、布局、OTP 卡 | 真实浏览器中的访客 | 可读、可复制、移动端可操作 | 仅单测或钩子不变不能证明视觉与交互结果，最终任务仍是条件式验证 |

## 断链、孤儿产出与错误消费者清单

### DC-P0-1 · P2 批量目标被未声明的 V2 生产前提截断

- **问题**：原始成功状态无条件要求批量完整邮箱创建，但接口契约规定 `emails.length > 1` 继续走既有 V2 栅栏，注册清单也明确 multi 仍依赖 `SHARE_CAPABILITY_V2`。典型生产场景却直接假定两个邮箱成功，未描述 flag 关闭时的失败行为、目标环境启用条件或发布顺序。
- **问题根因**：决策卡把“复用现有栅栏”当成接线完成，没有把 feature flag 作为 Goal→Outcome 的真实中间消费者和生产可达条件。
- **业务影响**：目标部署若未启用 V2，用户最核心的批量操作仍不可用，代码全部存在也属于假完成。
- **架构影响**：公开 API 契约与部署配置形成隐含双重真源，成功语义随环境漂移。
- **修改建议**：开工前明确 P2 批量在所有目标生产环境的 flag 策略、启用顺序、关闭时稳定错误和前端提示；若用户目标要求默认可用，则调整栅栏边界。当前 flag 实际状态与发布机制标注「需实现方核实」。
- **优先级**：P0。

### DC-P0-2 · P2 在分享域复制 account 创建策略并绕过既有控制

- **问题**：方案让 `mail-share-service.js` 直接用 SQL find-or-create account，同时明确不走 `account-service.add`、`addEmail` 与 Turnstile。角色域名权限和配额虽被列出，但没有权威业务来源说明 `addEmail` 仅限制“设置页入口”而非 account 创建能力，也没有证明新路径覆盖既有创建不变量。
- **问题根因**：循环 import 被当作跨域策略复制的理由；没有把公共 mailbox provisioning 能力下沉为两条入口共享的单一写策略。
- **业务影响**：若 `addEmail` 是管理员停用账号创建的全局控制，分享向导会成为绕过入口；若遗漏删除态、黑名单、审计等既有规则，还会产生不可收信或越权 account。控制语义「需实现方核实」。
- **架构影响**：account 创建出现第二写路径和第二真源，后续规则变更容易只更新一侧；这正是不变量可被旁路绕过的边界问题。
- **修改建议**：先确认 `addEmail`、Turnstile 及既有 account 创建校验各自的业务边界；将双方必须共享的授权、域名、配额、唯一性和审计规则收口到无循环依赖的领域服务/仓储边界，分享入口只表达其经批准的差异，不直接复制 SQL 规则。
- **优先级**：P0。

### DC-P0-3 · P2 多步写入没有原子、并发与补偿契约

- **问题**：文档先 find-or-create 一个或多个 account，再“走现有 insert / 指纹”，但未定义这些写入是否处于同一事务，也未定义两个 Owner 并发抢同一邮箱、同一 Owner 重试、批量中途配额/唯一约束失败时的行为。
- **问题根因**：链路把 accountIds 当作无副作用的解析产物，遗漏了它本身是持久化写入；“未知域名零写入”只覆盖预校验分支，没有覆盖 account 已建而 share/binding 失败的首个偏离点。
- **业务影响**：失败请求可能残留用户未要求的 account、形成半批次结果，或把数据库唯一冲突泄露成不稳定错误；重试还可能产生不同指纹结果。
- **架构影响**：P2 的整单语义、幂等真源和 account/share 一致性没有成立，后续靠前端重试无法修复。
- **修改建议**：明确全量预校验、事务边界、竞态安全的查建/归属判定、稳定冲突映射、失败回滚或补偿，以及规范化后指纹的重试语义；底层是否支持跨这些写入的事务标注「需实现方核实」。
- **优先级**：P0。

### DC-P1-1 · P1 的共享状态函数尚未形成五个真实消费者的接线清单

- **问题**：卡片宣称五处展示统一走 `liveEffectiveStatus`，但刷新契约只明确 email 页 `onActivated` 调 `shareIndicator.refresh()`；没有逐面说明谁持有/驱动 `nowMs`、谁在 visibility/focus 回源、详情与行操作如何避免继续消费旧 `row.effectiveStatus`。
- **问题根因**：把共享函数“存在”当成所有模板、computed 和动作判断已经消费它。
- **业务影响**：收件箱徽章可能修好，而管理页、详情或操作按钮仍停留在 ACTIVE，重现用户要求“排查所有展示面”所禁止的局部修复。
- **架构影响**：Owner 展示 SSOT 仍可能分裂为 live 状态与 API 快照两套消费者。
- **修改建议**：在链路表/注册清单逐一列出五个面对应的状态读取、时钟订阅、回源触发与测试断言，并明确时钟生命周期和监听清理；具体组件现状「需实现方核实」。
- **优先级**：P1。

### DC-P1-2 · P4 的计划证据停在 HTTP 中间态，未验最终浏览器结果

- **问题**：最终 sink 是用户在地址栏打开销毁 URL 后看到浏览器原生 404，但 e2e 姿势只断言 wrangler GET 的状态；HTTP 404 空 body、无业务 HTML与目标浏览器最终呈现是否一致尚未被真实导航证明，路径变体/HEAD/已打开页 reload 也没有一条统一的浏览器验收。
- **问题根因**：把协议层响应当成用户可观察完成，而模板要求验证真实消费者消费后的结果。
- **业务影响**：可能得到状态正确但仍是空白、SPA 残留或自定义文案的页面，P4 从用户视角仍失败。
- **架构影响**：Worker 契约可成立，但浏览器消费者闭环没有证据闸门。
- **修改建议**：把支持浏览器真实导航验收设为必做：覆盖 missing/revoked、直接打开与已打开页撤销后的 reload，断言状态/空 body/无业务 DOM并记录最终可见结果；浏览器对空 404 的实际呈现标注「需实现方核实」。
- **优先级**：P1。

### DC-P1-3 · P4 fail-open 是有意降级，但注册清单明确不提供可观测性

- **问题**：DB 异常时文档入口 fail-open 到 assets，意味着销毁链接会暂时重新渲染 SPA；注册清单却写“监控不新开”，没有日志、指标或告警说明。
- **问题根因**：把 404 成功态“不计 5xx”与 gone 查询失败的异常态混为一谈。
- **业务影响**：生产中 P4 负向条件被破坏时无人知晓，且无法区分正常 404 与 DB 检查失效。
- **架构影响**：降级策略可以保护活链接，但缺少观察和止损闭环，无法验证其副作用是否可接受。
- **修改建议**：保留经确认的 fail-open 取舍，同时为 gone 检查异常定义不泄露 lid 的结构化日志/指标、阈值告警和恢复验证；是否复用现有 DB 错误监控标注「需实现方核实」。
- **优先级**：P1。

### DC-P1-4 · 最终验证任务仍以“能跑则”收尾

- **问题**：任务清单只要求 vue/worker vitest，并把 visitor e2e 写成“能跑则”；P1 的真实 keep-alive/刷新、P2 从向导到分享结果及友好错误、P3 无二次弹窗、P4 浏览器原生结果、P5 移动/桌面视觉都没有不可跳过的最终 sink 验收。
- **问题根因**：测试边界详细列了局部 Red，但没有把总成功状态转成发布前的端到端通过条件及无法执行时的替代证据。
- **业务影响**：单测全绿仍可能交付原 bug、flag 不可达、错误文案未消费或视觉未落地。
- **架构影响**：开工闸门有任务，却没有完成闸门，producer→consumer 链在验证层再次断开。
- **修改建议**：把五条用户成功状态各映射到至少一项真实入口到最终 sink 的必做验收；环境确实不可用时必须记录阻塞与等价人工证据，不能把 e2e 静默跳过。
- **优先级**：P1。

## 生产业务场景推演

1. **典型批量创建**：Owner 粘贴两个已配置域名邮箱。当前方案在代码入口可达，但若 `SHARE_CAPABILITY_V2` 未启用，会在分享写入前停止；这与文档宣称的成功场景冲突，属于 DC-P0-1。
2. **复杂权限与事务**：第一个邮箱不存在、第二个邮箱归属他人或在并发中被另一 Owner 创建。文档没有说明第一个 account 是否回滚、冲突如何稳定映射，也没有证明新 SQL 路径服从既有账号创建策略，触发 DC-P0-2/DC-P0-3。
3. **长驻 Owner 页面**：收件箱徽章通过 tick 翻为 EXPIRED，但管理页详情仍持有旧 row。若各面没有明确订阅同一 `nowMs`，用户会同时看到 ACTIVE 与 EXPIRED，触发 DC-P1-1。
4. **销毁后的真实导航**：已打开访客页收到 API 404 后 reload；正常 DB 下 Worker 应返回空 404。若 DB 恰好抖动则 fail-open 到 SPA，而当前没有监控；即使状态断言通过，也还需目标浏览器确认最终呈现，触发 DC-P1-2/DC-P1-3。
5. **回归与视觉**：P3 的短链路可由真实关闭动作直接验收；P5 必须在桌面与移动视口操作 OTP、空箱和 Tab。若只跑单测/钩子测试，无法证明用户结果，触发 DC-P1-4。

## 架构判决

**调整边界。** MailShare、Owner 计算态和 Visitor Worker 短接的总体方向成立，不需要拆新分享服务，也不应把 EXPIRED 写成持久状态。但 P2 不能以循环依赖为由在分享域复制 account 创建规则；应先收口共享 provisioning 写边界，并明确事务、并发及 V2 生产可达性。P4 的 fail-open 可作为有意可用性取舍，但必须补最终浏览器验收与异常可观测性。

## 开工前必核与注册清单

- [ ] P2 批量在目标生产环境的 `SHARE_CAPABILITY_V2` 前提、发布顺序、关闭行为与用户提示已定；实际配置需实现方核实。
- [ ] `addEmail`、Turnstile、域名权限、配额、删除态、黑名单、审计的权威业务边界已确认；共享 account provisioning 只有一套不变量。
- [ ] account 查建、share/binding 写入、批量失败、并发抢占和重试指纹有明确事务/补偿契约。
- [ ] 五个 P1 展示面均登记真实状态 consumer、时钟 producer、回源触发和回归测试，不再直接消费旧快照。
- [ ] Worker 文档路由顺序、API 错误映射、SPA reload 都已注册；gone 查询异常有日志/指标/告警。
- [ ] P2 稳定错误码确实由前端 i18n 消费并在真实向导显示；权限与 feature flag 不是隐含部署条件。
- [ ] 五条成功状态都有不可静默跳过的真实入口→最终 sink 验收，特别是浏览器 P4 和桌面/移动 P5。
- [ ] shipped spec dated changelog 与实际 API/行为同一发布波次落地，旧测试不再充当错误消费者。

## 落地决定

**调整方案后开发。** 先解决 3 个 P0：P2 批量生产可达性、account 创建边界、原子/并发契约；随后将 4 个 P1 纳入接线和完成闸门。P3 可保留既定方向，但不应绕过整卡开工闸门单独宣称全链路完成。

```yaml
patch_plan:
  - issue_id: DC-P0-1
    severity: P0
    target_file: share-fullchain-decision-card.md
    anchor: "`emails.length > 1` 计入 multi，走既有 V2 栅栏（扩展 `hasFenceIntent`）。"
    action: append_after
    intent: 明确批量邮箱在目标生产环境的 feature flag 前提、发布顺序、关闭时稳定失败与前端提示
    rationale_short: 用户要求批量默认可用，但当前链路可能被未声明的 V2 配置截断
  - issue_id: DC-P0-2
    severity: P0
    target_file: share-fullchain-decision-card.md
    anchor: "服务端 `ensureOwnedMailboxes`（放在 `mail-share-service.js` 用 SQL，**不**从 `account-service.add` 调，避免循环 import，也避免 Turnstile / `addEmail` 开关）："
    action: replace_section
    intent: 核实既有账号创建控制的业务边界并将共享授权、校验、唯一性与审计收口到无循环依赖的单一 provisioning 边界
    rationale_short: 分享域直接复制 SQL 并绕过既有控制会形成 account 创建第二写路径
  - issue_id: DC-P0-3
    severity: P0
    target_file: share-fullchain-decision-card.md
    anchor: "解析成 accountIds 之后再走现有 insert / 指纹。**禁止**把空 `emails: []` 编进指纹。仅 emails、无 accountIds 的请求在 resolve 成单个 account 且默认值对齐时仍可走 `legacyCompatibleBody`。"
    action: append_after
    intent: 定义全量预校验、事务边界、并发查建、稳定冲突、失败回滚或补偿及重试指纹语义
    rationale_short: account 与 share 多步写入当前不能保证整单一致或无孤儿副作用
  - issue_id: DC-P1-1
    severity: P1
    target_file: share-fullchain-decision-card.md
    anchor: "刷新触发：`onActivated`、`visibilitychange`、`window focus`；email 页 `onActivated` 调 `shareIndicator.refresh()`。"
    action: append_after
    intent: 逐一登记五个 Owner 展示面的状态 consumer、时钟 producer、回源触发、监听生命周期和测试
    rationale_short: 共享函数存在不等于所有展示与动作消费者已接线
  - issue_id: DC-P1-2
    severity: P1
    target_file: share-fullchain-decision-card.md
    anchor: "e2e 姿势：wrangler `:8788` 上 GET 已撤销 lid → 404；EXPIRED 仍 unavailable SPA。`visitor-headers.spec.js` 必须改打**活链接**（未知 lid 不再 200）。"
    action: append_after
    intent: 增加目标浏览器真实导航与已打开页撤销后的最终可见结果验收
    rationale_short: HTTP 状态和空 body 只是中间证据，不能证明浏览器消费者结果
  - issue_id: DC-P1-3
    severity: P1
    target_file: share-fullchain-decision-card.md
    anchor: "| 监控 | 不新开；404 是成功态不是 5xx |"
    action: replace_section
    intent: 区分正常 gone 404 与 gone 查询异常，为 fail-open 增加可复用的日志、指标和告警闭环
    rationale_short: DB 检查失败会恢复 SPA 且当前不可观测
  - issue_id: DC-P1-4
    severity: P1
    target_file: share-fullchain-decision-card.md
    anchor: "- [ ] VERIFY vue vitest + worker vitest；能跑则 e2e visitor 拆分用例"
    action: replace_section
    intent: 将 P1 至 P5 各自的真实入口到最终 sink 验收设为必做并规定环境不可用时的替代证据
    rationale_short: 条件式 e2e 允许局部测试绿后静默结束
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 3
p1_count: 4
one_line: 总体方向成立，但 P2 的生产可达性、account 创建边界和多步写一致性尚未闭合，必须调整方案后开发。
