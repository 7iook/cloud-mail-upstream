# T-22 独立代码审查

Verdict: NEEDS_CHANGES

- 审查对象：`5c9651fd6247a3ccfb258ab71786fe05c1bb4c6d`
- P0: 0
- P1: 1
- P2: 1
- 当前 `HEAD=7d6a10f`；目标提交后的差异只有审查/任务文档，T-22 生产文件及测试文件与 `5c9651f` 字节一致。
- 未采信执行说明作为完成证据；结论来自目标 diff、当前生产调用链、Worker 校验顺序及独立测试。

## P0

无。

## P1

### P1-1 · 创建请求未完成时可以关闭向导，成功响应的一次性凭据会永久丢失

- 位置：`mail-vue/src/views/share-admin/ShareCreateWizard.vue:6-13`、`:290-311`、`:534-569`、`:652-695`
- 触发：点击创建后，在 Promise 完成前点击“取消”、右上角关闭、遮罩或 Escape。关闭按钮未随 `submitting` 禁用，`el-dialog` 也未阻止其他关闭入口；`onOpenChange(false)` 会立即执行 `closeNow()`。
- 影响：请求随后成功时，`submit()` 仍把 `created` 写入已经隐藏的组件并触发列表刷新，但用户看不到 `shareUrl`/`authKey`；下一次 `openDialog()` 又先清空 `created`。Worker 不会再次返回这些明文，因此已创建分享的凭据不可恢复，违反“成功后一次性展示”。
- 现有测试缺口：W18 只覆盖重复点击提交，W15 只覆盖成功后关闭；没有 deferred create + pending close 场景。
- 必需修复：`submitting` 期间统一拒绝所有关闭路径（至少在 `onOpenChange(false)` 守卫，并禁用 footer close；同时覆盖 dialog 的关闭按钮、遮罩和 Escape），补 deferred Promise 回归，确认响应完成前关不掉、完成后明文可见。

## P2

### P2-1 · 小数刷新间隔可把值域拒绝误判成 V2 栅栏拒绝

- 位置：`mail-vue/src/views/share-admin/ShareCreateWizard.vue:584-605`、`:622-630`、`:664-687`；服务端权威校验位于 `mail-worker/src/service/mail-share-service.js:334-365`
- 触发：自定义预设启用任一 V2 意图（例如 AuthKey），手工输入 `refreshIntervalMs=3000.5`。`el-input-number` 没有 `precision=0`/`step-strictly`，而 `localError()` 只检查 `<3000`，所以请求会发出。
- 影响：Worker 在执行任何 V2 栅栏前先因 `!Number.isSafeInteger(refreshIntervalMs)` 返回 `SHARE_INVALID_CONFIG`；前端看到同一错误码和 `fenceIntent=true` 后调用 `degradeToInactive()`，错误地宣称“能力未激活”并清除多邮箱/AuthKey/配额。该响应不是真实 V2 fence rejection。
- 现有测试缺口：W11 仅覆盖 `2999`，没有覆盖 `3000.5` 与 fence intent 的组合。
- 建议修复：本地同时要求刷新间隔为 safe integer 且 `>=3000`，并将输入限制为整数；补小数值回归，断言零请求且 `capabilityV2` 仍为 `unknown`。

## 10 项核验

1. **提交范围 / 禁改文件：PASS。** 共 8 个文件：两份 archive note、`mail-share.js`、追加 1 个 case 的 `mail-share.spec.js`、wizard Vue/spec、`presets.js`、`index.vue`。`index.vue` 为 `+2/-0`；所有明确禁止路径差异为空。
2. **旧 request 四键 `toEqual`：PASS。** 父提交与 `5c9651f` 的原用例片段 SHA-256 均为 `afae6a4b6fb205277ccbd1227401c55c2cbaad8bc8d2279e60dfdc2f1a12a602`，原断言未改。
3. **ShareDialog J3 四字段 body：PASS。** `ShareDialog.spec.js` 在父提交与目标提交的整文件 SHA-256 相同；J3 仍精确断言 `{accountId, durationSeconds, name, remark}`。
4. **`accountId` / `accountIds` 与可选字段：PASS。** `createMailShare` 以 `accountIds === undefined` 为互斥分支；8 个可选字段仅在值不是 `undefined` 时加入。
5. **request 层不 clamp / 不做 false→0：PASS。** 可选值原样透传；新增 request 用例明确覆盖 `autoRefresh:false`。
6. **unknown 不预灰 / 四组真实 fence 后降级：FAIL。** unknown 初态和四组降级动作本身正确，但 P2-1 证明非 fence 的 `SHARE_INVALID_CONFIG` 也能触发同一降级，未满足“真实 V2 fence rejection 后”这一前提。
7. **DURATION / ACCOUNT / BINDING 不标 inactive：PASS。** 只有 `err.message === 'SHARE_INVALID_CONFIG'` 才进入降级；这些独立领域码不会命中。
8. **未知传输结果同 key 重试并锁表单：PASS。** transport error 进入 `unknownResult`，表单控件禁用，retry 复用原 key；W4 实际通过。P1-1 是请求仍 pending 时的关闭竞态，不改变该路径结论。
9. **重放不显示 secret、不提供换 key：PASS。** `idempotentReplay` 且无 `sec/shareUrl` 时只显示 shareId/lid 与 revoke/delete 引导；无 retry/new-key 控件。
10. **生产调用方：PASS。** `index.vue` 的真实 header-actions 挂载 `<ShareCreateWizard @created="refresh"/>`，并导入生产组件，不是 tests-only。

## 实际运行命令

```sh
git status --short --branch && git show --stat --oneline --decorate --no-renames 5c9651f && git show --format=fuller --name-status --no-renames 5c9651f

git rev-parse HEAD && git diff 5c9651f^ 5c9651f --numstat

git log --oneline --decorate 5c9651f^..HEAD && git diff --stat 5c9651f..HEAD && git diff --name-status 5c9651f..HEAD

git diff --check 5c9651f^ 5c9651f

git diff --name-only 5c9651f^ 5c9651f -- mail-vue/src/views/share-admin/status.js 'mail-vue/src/views/share-admin/ShareDetailDrawer.*' 'mail-vue/src/views/share-admin/ShareRowActions.*' mail-vue/src/views/share-admin/index.spec.js 'mail-vue/src/views/email/**' 'mail-vue/src/i18n/**' 'mail-vue/src/router/**' 'mail-vue/src/**/*perm*' 'mail-worker/**' 'tests/e2e/**'

git diff --unified=80 5c9651f^ 5c9651f -- mail-vue/src/request/mail-share.js mail-vue/src/views/share-admin/index.vue mail-vue/src/request/mail-share.spec.js

git show 5c9651f^:mail-vue/src/request/mail-share.spec.js | sed -n '40,58p' | sha256sum
git show 5c9651f:mail-vue/src/request/mail-share.spec.js | sed -n '40,58p' | sha256sum
git show 5c9651f^:mail-vue/src/views/email/ShareDialog.spec.js | sha256sum
git show 5c9651f:mail-vue/src/views/email/ShareDialog.spec.js | sha256sum

pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareCreateWizard.spec.js src/request/mail-share.spec.js src/views/email/ShareDialog.spec.js src/views/email/ShareIndicator.spec.js src/views/share-admin/index.spec.js src/views/share/share-chunk.spec.js --no-cache
```

## 测试结果

- 指定 Vitest：**6 files passed / 56 tests passed**，EXIT=0，耗时 13.13s。
- `git diff --check 5c9651f^ 5c9651f`：无输出，EXIT=0。
- 禁改路径差异：无输出。
- 目标提交 numstat：wizard Vue `+965`、wizard spec `+606`、presets `+142`、`index.vue +2/-0`、request `+36/-6`、request spec `+53/-0`、两份 archive note `+366`。
