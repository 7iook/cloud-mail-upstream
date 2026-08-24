# T-12 验证工件第 1 轮评审

- Reviewer model: GPT-5.6 Sol (`gpt-5.6-sol`)
- Template: `artifact-verification`
- Review boundary: 仅审 `exec-t12-note.md` 的证据与内部一致性；未核查源码、Git 或外部日志。

## 总评

工件对服务层写路径给出了较强的红绿证据：多邮箱绑定、跨租户/已删除邮箱整单拒绝、写入时并发删除、V2 栅栏、幂等重放、秘密不回放及负向约束均有对应测试和数据库终态断言。并发删除用例还做了反证探针，能证明关键断言不是恒绿。

但这仍不足以证明“owner 在一次请求中创建并收到响应”的真实入口闭环。工件明确承认 HTTP/API 集成只覆盖旧单邮箱载荷；新载荷透传、新响应字段、V2 拒绝以及 `Idempotency-Key` 重放均以服务测试或代码形状推理代替真实入口证据。T-12 虽不包含 visitor UI，owner create 的 API 入口仍在本切片目标内，因此当前只能判为“局部完成但链路未闭环”。

## 目标—证据追踪矩阵

| 原始目标/约束 | 工件给出的直接证据 | 评审结论 |
|---|---|---|
| 一次请求绑定多个自有邮箱并返回 `shareType + bindings` | 服务级 create 用例断言 1 share、2 bindings、响应与库内 binding 对齐 | 服务层已证；真实 owner HTTP 请求与外部响应未证 |
| 混入他人或已删除邮箱后零行 | 普通失败用例、batch 前删除用例、零残留断言及反证探针 | 强证据 |
| V2=false 保留旧单邮箱创建并拒绝 multi/AuthKey/有限配额 | 服务级旧载荷、参数化拒绝及零残留断言 | 服务层已证；真实 API 栅栏上下文未证 |
| 丢失响应后重放不建第二条且不返回 `sec/authKey` | 服务级同 key 重放，断言同 share、单行及秘密缺失 | 幂等核心已证；HTTP header→API→响应链未证 |
| 无 `share_type`、无孤儿 binding、日志无 AuthKey、生产 flag 不开启 | schema 扫描、限额落空终态、日志截获、`wrangler.toml?raw` 护栏 | 对仓库内约束有直接证据 |

## 端到端消费链证据

1. **owner 的真实入口请求 → API 解析/鉴权/幂等头提取：缺失。** 工件只以 `{...body, idempotencyKey}` 会透传来推导新载荷可达服务；既有 HTTP 集成明确只跑旧单值载荷。
2. **API → `mailShareService.create`：部分成立。** 旧路径集成存在，新多邮箱、V2 受限意图和重放输入没有真实入口调用证据。
3. **服务归一化/权限校验 → D1 原子写入：证据充分。** 数据库行数、binding 内容、并发删除和 insertShare 落空均有终态断言。
4. **服务响应组装 → API 外部响应：前半段成立、后半段缺失。** 服务返回体检查了 `shareType/bindings` 和秘密抑制，但没有证明路由层最终原样序列化给 owner。
5. **visitor 消费链：不在 T-12 范围。** AuthKey 校验留给 T-08、visitor UI 留给后续任务，不构成本轮缺陷。

## 失败与边界场景结果

- 覆盖了跨租户、软删除、预检后并发删除、空集合、非法 ID、50/51 边界、配置下界、限额竞争、乱序/重复 accountIds、同 key 冲突及 insertShare 落空。
- 并发删除反证探针把归属谓词改成恒真后用例确实转红，是本报告最强的失效链证据。
- V2=false 的四类拒绝和旧载荷放行均有服务级终态证据。
- 未覆盖真实 API 层的多邮箱请求、V2 拒绝、幂等 header 重放与最终响应形状。

## 副作用/回归证据

- 工件报告目标 spec 连跑、全量 worker 测试以及既有并发限额、schema、旧指纹与事件信封护栏均通过。
- 无 `share_type`、无 AuthKey 日志明文、生产配置未启 flag 均有专项断言。
- 证据归属仍不够稳定：正文从未提交的 `9b98dec` 脏工作树、并行 T-07 导致的 264→265 变化，跳到 Update Log 中已入库的 `b6f5a28` 与 289 条测试；没有一张最终权威快照把实现、日志和结果绑定在一起。
- 工件自己承认旧 0-binding 行会被重放为 `bindings: []` 且 `shareType: single`，同时又称 0 binding 表示撤销路径；这是本次 replay 投影带来的未裁决历史数据语义。

## 评审意见

### A1 · P0 · 新能力没有真实 owner API 入口到外部响应的闭环证据

- **问题：** 所有新目标子句的核心证明都停在 `mailShareService.create`；“API 面与集成”只证明旧单邮箱载荷可经 HTTP 工作。多邮箱 body、feature flag 上下文、`Idempotency-Key` 以及 `shareType/bindings`/秘密抑制的外部响应没有端到端执行证据。
- **问题根因：** 报告把 API 的展开透传这一代码形状和全量测试绿，当成新数据形状及重放行为已被真实入口消费的替代证据。
- **业务影响：** 路由解析、鉴权上下文、header 提取或响应封装任一处若丢字段，owner 仍无法完成原始业务操作，服务单测却会全部通过。
- **架构影响：** producer（HTTP owner request）到 consumer（create service），以及 service response 到 API response 的两个边界没有契约锁，last-mile 断裂无法被当前证据发现。
- **修改建议：** 从真实 owner API 入口执行至少一条多邮箱成功请求、一条 V2=false 受限请求及一组相同 `Idempotency-Key` 的重放请求；断言 HTTP 响应、数据库终态、第二次无 `sec/authKey`，并把每一跳证据补入报告。无需扩展到 visitor UI。

### E1 · P1 · 最终测试证据未绑定唯一、可复现的实现快照

- **问题：** 顶部仍称改动未提交且 HEAD 为 `9b98dec`，绿灯数据又受并行 T-07 影响而在 264/265 间变化，Update Log 最后才出现 `b6f5a28` 与 289 条测试。报告没有明确哪一个快照是完成判决的唯一依据。
- **问题根因：** 执行过程记录和最终验收记录混在同一组结论中，没有在入库后重建权威证据基线。
- **业务影响：** 后续审阅者无法确认日志、测试数量和被交付实现完全对应，可能把在不同工作树上得到的绿灯归给最终版本。
- **架构影响：** 无代码架构影响，但削弱发布审计与回归定位能力。
- **修改建议：** 在最终绿灯段明确唯一 tested commit/tree、工作树状态、对应命令和稳定计数；将并行写者造成的中间计数仅保留为过程记录，并标明红/绿日志分别绑定的快照。

### H1 · P1 · 旧 0-binding 行的 replay 投影存在内部语义冲突

- **问题：** 遗留风险称 0-binding 行会返回 `bindings: []` 与 `shareType: single`，同段又称 AC-CAP-02 把 0 binding 定义为撤销路径；报告以“实际影响极小、留给 T-15”结束，没有证明 replay 对历史行是安全且契约一致的。
- **问题根因：** `shareType` 从 binding 数量派生时只设计了 single/multi 两值，却让 replay 消费可能处于撤销/未回填状态的历史记录。
- **业务影响：** 跨部署或异常迁移窗口中的 owner 重放可能得到语义上仍可用的 `single` 响应，掩盖已撤销或数据不完整状态。
- **架构影响：** 同一持久化状态在 replay 与后续 list 投影之间可能出现两个真相，形成历史数据兼容债务。
- **修改建议：** 在 T-12 replay 边界明确 0-binding 行的处理契约并增加历史行用例；若该状态必须由 T-15 裁决，则当前 replay 应采用不会误报可用分享的安全行为，并在本报告给出明确交接门禁。

## 业务现实校验

- 多邮箱 owner create 是明确的 A 类业务刚需。
- 幂等重放、零残留、V2 栅栏和秘密不回放属于 B 类稳定性/安全保护。
- `shareType` 由 binding 派生而不新增列、复用既有 API 透传与 pepper，未呈现为技术洁癖驱动的新模块或第二真源。

## 未验证或证据不足项

- 新多邮箱能力经真实 owner HTTP/API 入口到最终响应的完整链路。
- V2=false 与幂等重放在真实 API header/config 上下文中的行为。
- `b6f5a28` 是否为报告中全部绿灯证据对应的唯一干净快照。
- 历史 0-binding 行的 replay 安全语义及与后续 list 投影的一致性。

## 完成判决

**局部完成但链路未闭环。** 服务写路径证据强，且覆盖了原目标最关键的数据一致性失败链；但真实 owner API 入口/外部响应尚未被执行证明，当前不能据此宣告原始目标真实完成。

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: exec-t12-note.md
    anchor: "**API 面与集成**"
    action: append_after
    intent: 补充真实 owner API 入口的多邮箱成功、V2=false 拒绝和同 Idempotency-Key 重放证据，并串联外部响应与数据库终态
    rationale_short: 现有 HTTP 证据仅覆盖旧单邮箱载荷，无法证明新能力的入口和响应闭环
  - issue_id: E1
    severity: P1
    target_file: exec-t12-note.md
    anchor: "## 绿"
    action: replace_section
    intent: 建立绑定唯一最终 commit 或 tree 的权威绿灯记录，区分并行写者造成的中间计数和最终验收结果
    rationale_short: 当前多个 HEAD 和测试总数混用，证据无法稳定归属于最终实现
  - issue_id: H1
    severity: P1
    target_file: exec-t12-note.md
    anchor: "**`replayFromIdempotency` 现在必然返回 `bindings: []`"
    action: replace_section
    intent: 裁定并验证历史 0-binding 行的 replay 安全语义，确保不会把撤销或未回填状态投影为可用 single 分享
    rationale_short: 报告同时定义 0 binding 为撤销路径并返回 single，存在消费语义冲突
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 1
p1_count: 2
one_line: 服务写路径证据充分，但真实 owner API 闭环未证，且最终证据快照与历史 0-binding replay 语义仍需收口。
