# T4 · 创建结果区关闭不再二次确认

## Findings

### T4-F1

- severity: P1
- anchor: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:627`
- symbols: `onOpenChange`, `closeNow`, `openDialog`, `unknownResult`, `rotateIdempotencyKey`
- rule_source: `docs/specs/mailbox-share-capability/requirements.md:68` 的 AC-CAP-14 明确要求结果未知时不得更换 `Idempotency-Key` 盲目重复创建。
- identity_scope: `ShareCreateWizard` 的「create 结果未知 → 复用同一幂等键重试」恢复契约
- failure_mode: `unknownResult=true` 时关闭仍会进入 `closeNow()` 清空未知态，而下次 `openDialog()` 会调用 `rotateIdempotencyKey()`，把同一未知请求变成一把新键。
- trigger: create 请求发生运输层失败后，Owner 不点「用同一密钥重试」而是关闭向导、重新打开并再次提交相同表单。
- impact: 首次请求若已在服务端提交，第二次会绕过幂等重放再创建一条分享，留下 Owner 未确认且可能未取得凭据的额外活动授权。
- required_fix: 在 `unknownResult` 状态下不得进入会清空恢复上下文的关闭生命周期；关闭入口必须保留冻结 payload 与原 `Idempotency-Key` 直到同键重试得到确定结果，或在该状态直接禁用全部关闭入口，成功结果区仍保持无二次确认。
- verify: `unverified: mail-vue/node_modules 不存在，实际执行 pnpm -C mail-vue test -- ShareCreateWizard.spec.js 以 vitest: not found（exit 1）终止；现有 spec 只覆盖原地同键重试（ShareCreateWizard.spec.js:343-359），没有覆盖 unknown 后关闭、重开、再提交。`
- risk_spread: none

## 已查证且无 finding

- 成功结果区关闭已直接走 `closeNow()`，没有恢复确认框；W15 也从旧正向断言改成了 `confirm` 未调用的反向断言：`mail-vue/src/views/share-admin/ShareCreateWizard.vue:615-627`、`mail-vue/src/views/share-admin/ShareCreateWizard.spec.js:651-680`。
- 两条 create 分支都在写入前要求 KEK、经 `mintShareCredentials` 生成 `secCipher/kekKid` 并随主行写入；emails 批量分流对每一组逐条铸造并写入，因此单地址、V2 multi 与 V2=false 的 N 条单分享均具备 `sec` 取回材料：`mail-worker/src/service/mail-share-service.js:1178-1237`、`:1274-1303`、`:1790-1865`。
- 详情抽屉对每个列表中的 `shareId` 提供 reveal 入口，服务端按 Owner 归属读取该行密文并返回完整 URL；批量创建出的每条 share 都可独立取回：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:292-338`、`:1141-1161`、`mail-worker/src/service/mail-share-service.js:2159-2193`。
- AuthKey 不可恢复是明确保留的契约，不构成本主题 finding；结果区仍以独立警告说明关闭后不可再查看：`docs/architecture/ADR-share-credential-recoverability.md:75-78`、`mail-vue/src/views/share-admin/ShareCreateWizard.vue:77-95`。
- `shareWizardCloseConfirm` 已从中英文表与组件兜底表删除，组件源码也无残留引用；相邻 i18n 键连续：`mail-vue/src/i18n/zh.js:511-517`、`mail-vue/src/i18n/en.js:511-517`。
- 聚焦 diff 的 `git diff --check` 退出码为 0。
