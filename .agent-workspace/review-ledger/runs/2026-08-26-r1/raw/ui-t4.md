# T4 · 创建结果区关闭与凭据交付视觉验收

## Findings

### UI-T4-F1

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:98`
- symbols: `acknowledgeSecret`, `onOpenChange`, `created-saved`, `wizard-close`
- rule_source: `docs/specs/mailbox-share-capability/design.md:300` 规定 create 成功结果承担链接与可选 AuthKey 的首次交付；`docs/specs/mailbox-share-capability/requirements.md:59` 的 AC-CAP-05 又把 AuthKey 明文限定为恰好一次。
- identity_scope: `ShareCreateWizard` 成功结果区的完成动作与再次创建动作
- failure_mode: 结果区唯一的全宽主按钮写着“我已保存”，点击后却不完成或关闭，而是清掉结果并回到空白创建表单；真正退出仍要点低强调的“取消”，但已成功创建的分享已无可取消。
- trigger: Owner 复制链接/AuthKey 后按视觉层级选择主按钮结束任务。
- impact: 页面把“完成”导向“再创建一个”，把“退出”命名成“取消”；用户会怀疑刚才是否创建成功，或在无明确意图时进入第二次创建流程。
- required_fix: 将结果区动作重排为明确的“完成并关闭”主动作与“再创建一个”次动作，并让行为与标签一致；不要只改其中一个按钮文案而保留相反的状态迁移。
- verify: `unverified: 1280×900 浏览器实测中，点击全宽“我已保存”后对话框仍在、结果区消失且空白表单重新出现；现有 111 项 wizard/detail Vitest 全绿，但测试正把该按钮当作继续创建入口，没有视觉语义断言。`
- risk_spread: none

### UI-T4-F2

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:349`
- symbols: `formError`, `localError`, `wizard-error`, `wizard-emails`
- rule_source: `docs/specs/mailbox-share-capability/design.md:434-436` 的 Error Handling 表要求把邮箱格式、域名未配置和账号不可用分别反馈给 Owner，其中域名未配置须呈现友好提示。
- identity_scope: `ShareCreateWizard` 邮箱输入的空态、格式错误与服务端业务拒绝反馈
- failure_mode: 所有错误都集中渲染在“高级选项”之后的表单底部，没有贴近邮箱输入或给字段错误态；1280×900 实测空邮箱提示与输入框相距约 364px，390×844 重排后两者无法同屏。
- trigger: Owner 空提交、粘贴非法地址，或提交后收到未配置域名/邮箱不可用错误。
- impact: 用户先在页底看到错误，再回滚寻找需要修改的字段；移动端还会把原因与输入分到两个视口，错误容易被误认为来自中间的有效期、名称或高级设置。
- required_fix: 按错误归属把邮箱类错误放回邮箱字段并建立持久的字段错误状态/可访问关联；仅把无法归属单一字段的创建失败保留为底部全局告警，避免继续用一个全局槽承载全部错误。
- verify: `unverified: 本地浏览器测得桌面邮箱框 y=457.9、错误 y=821.6；390×844 下邮箱框 y=607.9、错误 y=971.6。现有组件测试只断言错误字符串存在，不覆盖字段与提示的视口共现。`
- risk_spread: none

## 已查证且无 finding

- AuthKey 一次性告警仍一眼可辨：结果区内有独立的整行描边警告块，明确写出“只显示这一次、关闭后无法再查看”，390px 视口下告警、明文输入和 44px 复制按钮均完整可见：`mail-vue/src/views/share-admin/ShareCreateWizard.vue:77-95`、`:987-993`。
- 关闭结果区本身已无二次确认；标题栏关闭和页脚关闭都会直接退出，AuthKey 告警不再错误地由确认框承担：`mail-vue/src/views/share-admin/ShareCreateWizard.vue:615-627`。
- 关闭后“拿到链接”仍有可发现闭环：成功提示明说可从详情重看；列表卡片提供“详情”，详情内“查看链接”会展示可复制输入框：`mail-vue/src/views/share-admin/ShareCreateWizard.vue:60-74`、`mail-vue/src/views/share-admin/ShareRowActions.vue:3-5`、`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:292-343`。
- 原 AuthKey 按 AC-CAP-05 不可恢复；关闭后详情会显示已启用状态并提供“重置”，重置后再次进入一次性明文交付，因此主任务仍可用一把新 Key 完成，而不是伪装成可找回旧 Key：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:365-425`。
- 空地址、格式错误、域名未配置和未知结果均有用户可见文字；业务拒绝后表单仍可编辑，未知结果则单独锁定并提供同键重试。问题仅是邮箱类错误的空间归属，不是缺少错误态：`mail-vue/src/views/share-admin/ShareCreateWizard.vue:344-351`。
- 实跑：`pnpm exec vitest run src/views/share-admin/ShareCreateWizard.spec.js src/views/share-admin/ShareDetailDrawer.spec.js --reporter=dot` → EXIT=0，2 files / 111 tests passed。
