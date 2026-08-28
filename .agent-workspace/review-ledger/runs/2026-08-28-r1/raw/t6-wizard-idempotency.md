# T6 · 创建向导在响应丢失后不得盲建第二条分享

## Findings

### T6-F1

- severity: P1
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:489`
- symbols: `unknownResult`, `idempotencyKey`, `openDialog`, `submit`
- rule_source: `docs/specs/mailbox-share-capability/requirements.md:68` 的 AC-CAP-14 明确要求结果未知时前端不得更换 `Idempotency-Key` 盲目重复创建；`docs/specs/mailbox-share-capability/design.md:393` 把同键重试定为向导的结果未知恢复流程。
- identity_scope: `ShareCreateWizard` 未知结果恢复上下文跨组件重建的生命周期
- failure_mode: `unknownResult`、冻结表单和 `idempotencyKey` 全是组件实例内 `ref`，没有任何持久化或恢复入口。页面刷新或组件卸载重建后，`unknownResult` 回到 false，`idempotencyKey` 在第 503 行重新生成，随后 `openDialog()` 又在第 607 行轮换一次；向导已无法知道上一请求仍属未知结果。
- trigger: create 请求已到达服务端但响应在运输中丢失，Owner 随后刷新页面，或离开分享管理页再返回，然后按原表单重新创建。
- impact: 首次请求若已提交，第二次请求会携带新键绕过幂等重放，创建第二条活动分享；Owner 仍不知道第一条分享及其授权已存在。其影响与已关闭 F-0005 相同，但触发边界是组件重建而非同实例关窗重开。
- required_fix: 在创建请求发出前保存可恢复的 pending create 上下文，并让组件重建后恢复冻结 payload 与原 `Idempotency-Key`；只有同键请求得到确定成功或可证明未创建的确定结果后才能清除。恢复载体不得仅保存 key 而丢失原请求体，否则无法安全重放同一指纹。
- verify: 新增组件重建用例：第一次 mount 提交后注入运输层失败，unmount，再 mount/open；断言仍呈现未知态、原表单不可编辑，重试传给 `createMailShare` 的 body 与 key 均和首次一致。当前 `ShareCreateWizard.spec.js:361-379` 新增用例始终复用同一个 wrapper，且全文件没有 `unmount()`，未覆盖此触发链。
- risk_spread: `wizard-idempotency-key-lifecycle` · origin `ShareCreateWizard.vue` 的 `unknownResult` / `idempotencyKey` → hop 1 `request/mail-share.js:34-66`；后者只把调用方传入的 key 装进请求头，不保存或恢复 pending 上下文。已在允许 surface 内到达 stop_when；未审服务端重放实现。

### T6-F2

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:754`
- symbols: `submit`, `isBusinessError`, `unknownResult`, `createErrorKey`
- rule_source: `docs/specs/mailbox-share-capability/requirements.md:68` 的 AC-CAP-14 要求结果未知时不得换键盲建；`docs/specs/mailbox-share-capability/design.md:393` 要求向导依据重放结果进入清理后重建流程。
- identity_scope: 未知结果同键重试收到 `SHARE_NOT_FOUND` 后的前端状态判定与恢复引导
- failure_mode: 同键恢复请求只要返回数字 `code` 与字符串 `message`，`isBusinessError()` 就把它视为确定结果；`submit()` 无条件将 `unknownResult` 清为 false。因 `createErrorKey()` 没有 `SHARE_NOT_FOUND` 分支，界面只显示“创建分享失败，请稍后重试”，并解锁表单。此响应只证明整批重放无法完整回读，不证明首次请求没有留下其余分享；关窗重开或编辑后便可使用新键。
- trigger: 向导先经历运输层响应丢失，随后用原 key 重试；服务端按本轮既定对端契约返回 `SHARE_NOT_FOUND`（例如幂等记录所列分享已有一条不再可回读）。
- impact: Owner 得不到“已有分享仍需核对/清理”的提示，按通用失败提示重新创建时会为仍存在的邮箱再建分享，重新出现本主题要禁止的未知活动授权。
- required_fix: 向导须记住本次 submit 是否从 `unknownResult` 恢复而来；该恢复请求收到 `SHARE_NOT_FOUND` 时不得转入可安全新建态，应保留隔离状态并明确引导 Owner 先在列表核对、撤销或删除残留分享，再显式开始新请求。服务端为何返回该码归 T1，本 finding 不要求修改或重审服务端重放语义。
- verify: 新增状态机用例：运输层失败 → 同 key retry 返回 `{code: 500, message: 'SHARE_NOT_FOUND'}` → 关窗重开；断言不出现普通 `wizard-submit`、不轮换 key，并显示核对/清理引导。当前 wizard spec 全文没有 `SHARE_NOT_FOUND` 或 `SHARE_IDEMPOTENCY_CONFLICT` 覆盖。
- risk_spread: `wizard-idempotency-key-lifecycle` · origin `ShareCreateWizard.vue:752-768` → hop 1 `presets.js:154-174` 的错误映射；确认 `SHARE_NOT_FOUND` 落到通用 `shareCreateFailed` 后停止。服务端返回语义仅作为 T1 已给定输入，未跨入 T1 实现复审。

### persists: F-0023

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:98`
- symbols: `acknowledgeSecret`, `created-saved`
- rule_source: `docs/specs/mailbox-share-capability/design.md:300` 规定 create 成功结果承担链接与可选 AuthKey 的首次交付；既有 UI-T4 信息层级裁决要求完成动作的标签与状态迁移一致。
- identity_scope: `ShareCreateWizard` 成功结果区的完成动作与再次创建动作
- failure_mode: 主按钮仍写“我已保存”，点击 `acknowledgeSecret()` 却只清掉 `created`，对话框不关闭并回到创建表单。
- trigger: Owner 复制结果后按主按钮结束任务。
- impact: “完成”实际进入再次创建流程，Owner 会误判保存/创建状态，或在没有明确新建意图时进入第二次创建。
- required_fix: 提供标签与行为一致的“完成并关闭”主动作；若保留“再创建一个”，应作为明确命名的独立次动作。
- verify: 源码查证第 98-100 行按钮仍绑定 `acknowledgeSecret`，第 632-634 行函数仍仅执行 `created.value = null`；提交 `0f4f52c` 的 scoped diff 未改这两处，故 persists。
- risk_spread: none

### persists: F-0024

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:349`
- symbols: `formError`, `localError`, `wizard-error`, `wizard-emails`
- rule_source: `docs/specs/mailbox-share-capability/design.md:434-436` 的 Error Handling 表要求向 Owner 区分邮箱格式、域名未配置与账号不可用；既有 UI-T4 裁决要求邮箱错误贴近输入并建立可访问关联。
- identity_scope: `ShareCreateWizard` 邮箱输入的空态、格式错误与服务端业务拒绝反馈
- failure_mode: 邮箱类本地错误和服务端错误仍统一渲染在全部基本字段及高级选项之后的全局 `wizard-error`，邮箱输入附近只有常规 hint，没有字段错误态或错误关联。
- trigger: Owner 空提交、粘贴非法地址，或收到域名未配置/邮箱不可用业务拒绝。
- impact: Owner 看到错误后还要回找应修改的字段；窄屏下输入与原因分处不同视口，错误也容易被误认为属于有效期或高级配置。
- required_fix: 将邮箱类错误锚定到 `wizard-emails` 并建立持久字段错误态与可访问关联；仅将无法归属单一字段的失败保留为底部全局告警。
- verify: 源码查证邮箱输入位于第 140-157 行，唯一错误槽仍位于第 349-351 行；提交 `0f4f52c` 的 scoped diff只改未知态关窗生命周期，未改错误布局，故 persists。
- risk_spread: none

## 已查证且无 finding

- F-0005 保持 resolved：同一组件实例内，`closeNow()` 已不清 `unknownResult`，`openDialog()` 在未知态提前返回；新增测试也确认“关窗→重开→同表单重试”继续复用原 key：`mail-vue/src/views/share-admin/ShareCreateWizard.vue:596-614`、`ShareCreateWizard.spec.js:361-379`。
- `unknownResult` 在同实例内的置位/清除出口已枚举：非业务异常置 true；成功响应或数字业务码响应置 false；表单与 emails watcher 在未知态不轮换 key：`ShareCreateWizard.vue:724-813`。
- 正常成功与幂等重放后的新建边界没有新增 finding：正常成功立即轮换 key；重放保留 key，但表单一旦编辑即由 watcher 轮换，因此同一实例中“改 emails 后新建”不会与旧指纹共用 key：`ShareCreateWizard.vue:742-751`、`:798-813`。
