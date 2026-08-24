# exec-t08-note · 第 1 轮工件评审

- reviewer_model: `GPT-5.6 Sol`
- template: `artifact-verification`
- review_scope: 仅审 `exec-t08-note.md` 自身呈现的证据与内部一致性；未核查源码、Git 或外部日志

## 结论摘要

`exec-t08-note.md` 对 AuthKey 校验、`credentials_version`、集合化 ShareContext 和 session 响应给出了较完整的实现落点与测试名称，且正确把访客 UI/复制 OTP 的最终接线留给 T-26，没有把总目标冒充为本任务已经端到端完成。

但当前报告不能作为 T-08 完成凭证：主体仍断言全量测试失败、围栏 P0 未收口、改动未提交，末尾 Update Log 却断言这些事项已经修复、提交并全部复跑成功；同时报告没有把最终 commit 上的证据重新汇总为一份 T-08 范围完成判决。以下结论只否定报告的证明力，不等同于判定实现必然有缺陷。

## 目标—证据追踪矩阵

| 目标/范围 | 文档内证据 | 评审判断 |
|---|---|---|
| AuthKey 开启时，无 Key/错 Key 拒绝且不耗配额；关闭时忽略来件 Key | T-08.1 对照表、AuthKey 9 条测试、HTTP 用例摘要、79/79 定向测试摘要 | 功能证据较强，但最终 commit 上是否仍为该结果被相互冲突的运行状态削弱 |
| `cv` 写入 token，凭据版本变化后旧 token 失效，旧 token 无 `cv` 按 0 | `credentials_version` 4 条测试及 0→1→2 摘要 | scoped 行为有直接测试描述；真实 reset 接口不属于 T-08，文档对此边界说明清楚 |
| ShareContext 集合化、稳定排序、冻结、兼容 shim、扩展 session 响应 | 生产落点、ShareContext/session 9 条测试、单/双 binding 响应测试名称 | backend producer 证据存在，但缺少一份完整的输入→输出→消费边界证据汇总 |
| 达到 `max_sessions`、过期、撤销后不能开启新 session | 已签发 session 在配额满后可 replay；正确 Key 下过期/撤销拒绝；顺序说明 | 没有明确列出“新 idempotency key 在配额满后被拒绝”的最终证据；需实现方核实并补入报告 |
| 访客查看窗口内邮件并复制 OTP | 报告明确访客页仍未消费新字段，归 T-26 | 正确判为总目标尚未端到端完成；不应据此否定 T-08 backend slice |
| 最终 commit 回归无副作用 | 主体为 288/289、EXIT=1；Update Log 为 289/289、EXIT=0，另称 Vue 95/95 | 证据自相矛盾，当前无法采信为完成证明 |

## 端到端消费链证据

文档描述出的 scoped 链路是：

`POST session(body.authKey)` → `share-api.js` 传入 options → `matchSec` → `loadLiveBindings` → AuthKey 校验 → KV replay/配额 → 签发含 `cv` 的 token 与扩展响应 → 后续 `resolveSession` 回源比对 `cv` → `buildShareContext` → 既有 repository 暂由 shim 消费。

前半段有 HTTP 用例和 service 用例摘要；`cv` 与 ShareContext 有 service 测试摘要。断点在最终消费边界：报告说明既有 repository 仍读两个 shim，却没有展示一次真实 resolve/consumer 调用的输入、输出和窗口约束结果。T-26 UI 不在本任务范围内，但报告仍应明确 T-08 的终点究竟是 `resolveSession` 返回值还是某个 backend consumer，并以一条贯穿该终点的证据证明 producer/consumer 接线，而不是只列源码落点。

## 失败与边界场景结果

- 已覆盖：缺失/错误 AuthKey、AuthKey 关闭、错误 sec 的不可区分信封、旧 token 无 `cv`、`cv` 变化、换 IP、KV 写失败、配额 UPDATE 失败、AuthKey 在 replay 之前、全死 binding、过期/撤销且 Key 正确、attachment 在 `ACCESS_LIMIT_REACHED` 下继续下载。
- 已解释但需形成明确决策：过期/撤销且 Key 错误先返回 `SHARE_AUTH_REQUIRED`。该结果仍阻止新 session，且文档说明了与既有顺序裁决的关系；仅凭本工件无证据判定其错误。
- 证据不足：配额已满时使用新的 idempotency key 必须拒绝新 session。文档只明确展示了旧 session replay 仍成功。
- 并发/乱序方面只给出“另一执行者改动未触碰”的工作树说明，未给出 AuthKey/`cv` 同时变化或并发建 session 的 scoped 结果；若这些已有上游不变式覆盖，应在最终矩阵中引用而非默认由全量测试代替。

## 副作用/回归证据

- 定向三 spec 的 79/79 摘要支持本任务局部回归。
- 主体明确记录全量 288/289 且 EXIT=1，并把 R-T08-1 标成未收口 P0。
- Update Log 又称 commit `5a81065` 已包含围栏修复、全量 289/289 EXIT=0、Vue 95/95 EXIT=0。
- Header、§1、§5、§6 与 Update Log 没有统一“历史运行”与“最终运行”的语义，因此读者无法判断哪些状态是当前 authoritative evidence。报告需要保留红期历史，但必须把最终状态放到唯一、明确的完成快照中。

## 未验证或证据不足项

1. commit `5a81065` 上最终定向、全量和 Vue 结果是否确为 Update Log 所述；本评审按规则未读取外部日志，需实现方用报告内一致的最终命令摘要确认。
2. R-T08-1 是否已经从“遗留 P0”转为关闭状态；当前正文同时声称未解决与已解决。
3. 配额已满时，不同 idempotency key 的请求不会启动新 session。
4. T-08 backend slice 的最终消费边界，以及集合化 bindings/窗口字段确实由该边界的正确消费者接收。
5. 总目标的访客 UI、窗口内邮件展示和 OTP 复制仍属于 T-26；这不是 T-08 缺陷，但意味着本文只能判定 scoped slice，不能判定原始用户目标真实完成。

## 主要问题

### A1 · P0 · 当前状态的权威证据互相冲突

- 问题：Header 与主体称白名单外围栏仍失败、全量 EXIT=1、改动未提交；Update Log 称同一围栏已修、commit 已入库、全量与 Vue 均 EXIT=0。
- 问题根因：报告以追加日志更新结果，却没有把原有“当前状态”陈述标成历史快照，也没有生成统一的最终验证摘要。
- 业务影响：发布/合并判断可能分别得到“必须阻断”和“可以放行”两个相反结论。
- 架构影响：验证报告失去单一事实来源，后续任务无法可靠继承 T-08 的基线。
- 修改建议：保留红→绿历史，但将 Header、全量结果、R-T08-1、并发/提交状态统一为明确的最终 commit 快照；已关闭风险标记为 closed，并给出最终命令、计数、EXIT 与对应 commit。

### A2 · P1 · 缺少 T-08 scoped 的最终完成判决和完整矩阵

- 问题：报告有 “T-08.1 逐项对照”，却没有在最终修复状态下逐项覆盖 AuthKey、`cv`、ShareContext producer/consumer、session response、配额/生命周期回归，也没有明确写出“真实完成 / 局部完成但链路未闭环 / 未解决”的判决。
- 问题根因：主体聚焦施工记录与测试清单，Update Log 只补运行数字，没有把证据重新收束到任务边界。
- 业务影响：读者无法区分“实现看起来齐全”“T-08 backend slice 已证实完成”和“原始访客目标已完成”。
- 架构影响：T-26 等下游不能知道哪些 backend 契约已冻结、哪些仍需补证。
- 修改建议：增加最终目标—证据矩阵和完成判决，明确 T-08 slice 是否完成、总目标为何仍待 T-26，并把每项证据绑定到最终 commit 的实际测试结果。

### A3 · P1 · ShareContext 只证明了产出，未证明 scoped 消费边界

- 问题：报告列出 `buildShareContext` 形状和 9 条相关测试，但只说明 repository “仍读”兼容 shim，没有展示一条从 session resolve 到正确 backend consumer 的完整行为证据。
- 问题根因：把源码落点与单元测试集合当成 producer→consumer 接线证明。
- 业务影响：即使对象形状正确，下游仍可能只消费首个 binding、忽略窗口或接错字段；最终用户问题会被推迟到 T-26 才暴露。
- 架构影响：集合化 SSOT 是否真正越过旧标量 shim 边界不清楚。
- 修改建议：明确 T-08 的最后一个 in-scope consumer；补一条在该边界观察单/多 binding、排序、窗口字段和冻结形状的集成证据。不要要求本任务补访客 UI。

### A4 · P1 · “达到 max_sessions 后不能开启新 session”缺少正面证据

- 问题：现有摘要证明配额满后已签发 session 可 replay，却没有明确证明新的 idempotency key 会被拒绝且不签发新 token。
- 问题根因：验证集中在 T-07 replay 保持可用，没有把原始目标中的反向分支纳入最终追踪矩阵。
- 业务影响：若配额守卫被顺序调整绕过，分享者设置的 session 上限可能失效。
- 架构影响：replay 例外与新建 session 配额守卫之间的状态机边界未被报告锁定。
- 修改建议：引用已有覆盖或补充一条最终 commit 上的行为证据，成对证明“同 idempotency replay 成功、不同 idempotency 新建失败”；若此项完全由上游任务负责，也要注明对应不变式和回归证据。

## 完成判决

**局部完成但验证链路未闭环。** 文档呈现的实现与定向测试足以支持“T-08 很可能已完成”的判断，也正确声明 T-26 才负责访客 UI；但当前状态矛盾、缺少 scoped 最终判决、消费边界和 max-sessions 新建拒绝证据，使该工件尚不能证明 T-08 已真实完成。

```yaml
patch_plan:
  - issue_id: A1
    severity: P0
    target_file: exec-t08-note.md
    anchor: "### 全量"
    action: replace_section
    intent: 统一最终 commit 上的定向、全量、Vue 结果，并把失败运行明确标为修复前历史证据
    rationale_short: 主体 EXIT=1 与 Update Log EXIT=0 相互冲突，无法形成权威完成凭证
  - issue_id: A2
    severity: P1
    target_file: exec-t08-note.md
    anchor: "T-08.1 逐项对照:"
    action: replace_section
    intent: 形成覆盖 AuthKey、cv、ShareContext、session 响应及生命周期回归的最终目标证据矩阵与 scoped 完成判决
    rationale_short: 当前施工清单未区分 T-08 slice 完成与原始访客目标完成
  - issue_id: A3
    severity: P1
    target_file: exec-t08-note.md
    anchor: "`share-scoped-email-repository.js:25-26` 仍读这两个标量,本波零改动。"
    action: append_after
    intent: 明确 T-08 最后一个 in-scope consumer，并补充 ShareContext 到该消费边界的行为证据
    rationale_short: producer 形状与测试计数不能单独证明集合化上下文已被正确消费者接收
  - issue_id: A4
    severity: P1
    target_file: exec-t08-note.md
    anchor: "`serves an already-issued keyed session after max_sessions is reached`"
    action: append_after
    intent: 成对记录配额满后旧 idempotency replay 成功与新 idempotency session 建立失败的证据
    rationale_short: 原始目标要求达到 max_sessions 后不得开启新 session，当前只显式证明 replay 分支
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 1
p1_count: 3
one_line: T-08 实现证据较强，但报告的最终状态自相矛盾且缺少 scoped 消费闭环与新 session 配额证据，尚不能作为完成凭证。
