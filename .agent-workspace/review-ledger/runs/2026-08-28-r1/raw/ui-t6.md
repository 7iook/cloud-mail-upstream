# UI-T6 · 创建向导 unknownResult 关窗重开

## 1. Lens

- 角色：UI/UX，只审视觉、信息层级与状态呈现。
- 对象：`mail-vue/src/views/share-admin/ShareCreateWizard.vue` 的 `unknownResult` 关窗重开态、邮箱错误归属与结果区动作语义。

## 2. Range

- 审查提交：`0f4f52c` 中 `ShareCreateWizard.vue` 的 scoped diff。
- 审查区间：`9b6eb8072fe73c93518e872037702a2e8e54056b..083c87f2d2ccc8c459adfd45fc31a43afc63256f`
- 不审：`Idempotency-Key` 生成、轮换、持久化或服务端重放实现的代码正确性。

## 3. Rule sources

- `docs/specs/mailbox-share-capability/requirements.md:68`（AC-CAP-14：首次响应丢失时须呈现恢复引导，禁止结果未知时盲建）
- `docs/specs/mailbox-share-capability/design.md:388-394`（创建向导的结果未知恢复流程）
- `docs/specs/mailbox-share-capability/design.md:425-444`（邮箱类错误的稳定分类与 Owner 反馈）
- `.agent-workspace/review-ledger/runs/2026-08-28-r1/reviewer-l0-l1.md:3-12,58-61`
- `.agent-workspace/review-ledger/runs/2026-08-28-r1/themes.md:191-214`

## 4. Conclusion

`NEEDS_CHANGES`：新增 1 条 P2。关窗重开后，向导把滚动位置复位到顶部，但“上次请求可能已经成功”及安全重试动作仍放在整张冻结表单之后；390×844 首屏只呈现“新建分享”和不可编辑表单，关键状态与唯一恢复动作均在视口外。`F-0023`、`F-0024` 仍可复现，仅记为 persists，不作为新问题。

## 5. Findings

### UI-T6-F1

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:344`
- symbols: `unknownResult`, `locked`, `wizard-unknown`, `wizard-retry`, `shareWizardTitle`
- rule_source: `requirements.md:68` 的 AC-CAP-14 要求管理 UI 依据响应丢失状态引导 Owner 安全恢复；`design.md:393` 将该状态定义为向导的“结果未知恢复”流程，而不是普通新建表单的字段错误。
- identity_scope: 同一组件实例中，create 运输失败后关窗再打开时的 unknownResult 首屏信息层级；不包含幂等键实现。
- failure_mode: 未知态仍渲染从通用风险提示、四张预设卡、邮箱/有效期/名称/备注到高级选项的整张表单，只把关键告警追加在表单末尾；对话框标题也始终为“新建分享”。重开时滚动容器回到顶部，因此“分享可能已经建好了”“不要改变本次提交”的解释和“用同一把钥匙重试”主动作同时落到首屏之外。Owner 首先看到的是一张原因不明地全部置灰的新建表单，而不是上一次请求的恢复态。
- trigger: 390×844 视口中提交 create 遇到运输失败，Owner 关闭向导，再点击“新建分享”重开。
- impact: Owner 在重开后的决策点看不到“上次可能已成功”与“必须重试原请求”，容易把冻结表单理解为界面失效而再次关闭；随后刷新、离页或另起一次创建时，产品最需要阻止的重复授权风险重新暴露。
- required_fix: 在 `locked` 状态的模板分支把 unknownResult 提升为独立恢复主视图：标题或首个内容块直接说明“上次创建结果未知、可能已成功”，展示本次邮箱摘要并明确“不要修改邮箱或重新创建”，让同请求重试动作无需滚动即可操作；完整冻结表单应折叠为只读摘要或退居次级详情，不要继续占据恢复说明之前的主层级。
- verify: 独立 Chromium 上挂载真实 SFC，以 390×844 填入 `owner@example.com`，拦截 create 为运输失败后执行“关闭→重开”。重开后实测 overlay `scrollTop=0`、可滚高度 `1200px`；`wizard-unknown` 位于 `y=991.03..1075.44`，`wizard-retry` 位于 `y=1091.44..1123.44`，两者均不与 844px 视口相交；标题仍为“新建分享”，邮箱输入确为 disabled。运输失败刚发生时因提交动作已把容器滚到底部，告警位于 `y=730.43..814.84` 可见，说明缺口专属于关窗重开的首屏层级。
- risk_spread: none

### persists: F-0023

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:98`
- symbols: `acknowledgeSecret`, `created-saved`
- rule_source: `docs/specs/mailbox-share-capability/design.md:300` 规定 create 成功结果承担链接与可选 AuthKey 的首次交付；既有 UI-T4 信息层级裁决要求完成动作的标签与状态迁移一致。
- identity_scope: `ShareCreateWizard` 成功结果区的完成动作与再次创建动作。
- failure_mode: 主按钮仍写“我已保存”，点击后只清掉结果并返回创建表单，不关闭对话框。
- trigger: Owner 复制结果后按主按钮结束任务。
- impact: “完成”实际进入再次创建流程，Owner 会怀疑刚才是否创建成功，或在没有明确新建意图时进入第二次创建。
- required_fix: 提供标签与行为一致的“完成并关闭”主动作；若保留“再创建一个”，应作为明确命名的独立次动作。
- verify: 第 98-100 行按钮仍绑定 `acknowledgeSecret`，第 632-634 行仍只执行 `created.value = null`；本轮 scoped diff 未改这两处，故 persists。
- risk_spread: none

### persists: F-0024

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:349`
- symbols: `formError`, `localError`, `wizard-error`, `wizard-emails`
- rule_source: `docs/specs/mailbox-share-capability/design.md:434-436` 要求向 Owner 区分邮箱格式、域名未配置与账号不可用；既有 UI-T4 裁决要求邮箱错误贴近输入并建立可访问关联。
- identity_scope: `ShareCreateWizard` 邮箱输入的空态、格式错误与服务端业务拒绝反馈。
- failure_mode: 邮箱类本地错误和服务端拒绝仍统一渲染在基本字段及高级选项之后；邮箱输入附近只有常规 hint，没有字段错误态或错误关联。
- trigger: Owner 空提交、粘贴非法地址，或收到域名未配置/邮箱不可用业务拒绝。
- impact: Owner 看到错误后还要回找应修改的字段；窄屏下输入与原因分处不同视口，错误容易被误认为属于其他配置。
- required_fix: 将邮箱类错误锚定到 `wizard-emails` 并建立持久字段错误态与可访问关联；仅将无法归属单一字段的失败留在底部全局告警。
- verify: 邮箱输入位于第 140-157 行，唯一错误槽仍位于第 349-351 行；390×844 的既有实测中邮箱框与底部错误无法同屏，本轮 scoped diff 未改这两处，故 persists。
- risk_spread: none

## 6. Verified with no finding

- unknownResult 文案本身没有缺信息：滚动到告警后可直接读到“分享可能已经建好了”“换一把会建出第二个分享”“表单已锁定，以免重试时改动了内容”，主按钮也明确写“用同一把钥匙重试”。锚点：`ShareCreateWizard.vue:344-365`、`mail-vue/src/i18n/zh.js:456-458`。新增 finding 只针对重开首屏的可发现性。
- 未知态下邮箱输入及其余控件均为 disabled，普通“创建分享”按钮被恢复按钮替换；在当前对话框内，Owner 不能修改邮箱后以普通新建动作提交。锚点：`ShareCreateWizard.vue:117-119,148,165-170,219-239,357-375,512-515`。
- 告警自身有加粗标题、warning 描边与底色，并非仅靠一行弱提示表达；当它进入视口时状态层级清楚。锚点：`ShareCreateWizard.vue:344-347,975-995`。
- `F-0023`、`F-0024` 的身份与上一轮一致，均按 persists 记录，没有因本轮再次读到而新开 finding。

## 7. Risk spread and exclusions

- risk_spread: none。视觉取证未跨出创建向导模板、既有 i18n 文案与该对话框的运行时布局。
- 按任务约束，未判断同键重试是否真正复用原 key、服务端是否幂等，也未把主审 T6 已登记的组件重建/`SHARE_NOT_FOUND` 正确性问题改写成 UI finding。
