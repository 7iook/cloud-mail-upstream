# T-22 R2 独立复审

Verdict: APPROVED

- 复审对象：`4648101ec1683c22467aec9618b1ea88f70782d4`
- 当前 `HEAD=0a7ea312539e0d73a788ba72fdfa097b718df12e`，目标提交是当前 HEAD 的祖先；目标提交后这两个 wizard 文件无后续差异。
- P0: 0
- P1-1: CLOSED
- P2-1: CLOSED

## P1-1 · CLOSED

- `mail-vue/src/views/share-admin/ShareCreateWizard.vue:12-15` 在提交中把遮罩关闭、Escape 关闭和右上角关闭入口都绑定为 `!submitting`。
- `mail-vue/src/views/share-admin/ShareCreateWizard.vue:295-296` 在提交期间禁用 footer close。
- `mail-vue/src/views/share-admin/ShareCreateWizard.vue:560-579` 的统一 `onOpenChange(false)` 路径在 `submitting` 时直接返回，因此即使收到关闭事件也不会清空或隐藏向导。
- `mail-vue/src/views/share-admin/ShareCreateWizard.vue:666-708` 在等待 `createMailShare` 前置 `submitting=true`，成功后先把完整响应写入 `created`，最后才解除 submitting；仍打开的对话框会渲染 `mail-vue/src/views/share-admin/ShareCreateWizard.vue:17-65` 的一次性链接和可选 AuthKey。
- `mail-vue/src/views/share-admin/ShareCreateWizard.spec.js:567-587` 使用未决 Promise，提交后实际尝试关闭，确认请求完成前向导仍在且 close 已禁用；手动 resolve 后确认 `secret-once` 和含 `#sec-7` 的链接可见。该测试会在旧实现下失败，不是空断言。

结论：pending create 的所有关闭路径均被拒绝；成功响应到达后，一次性 secret 留在仍打开的对话框中。P1-1 已关闭。

## P2-1 · CLOSED

- `mail-vue/src/views/share-admin/ShareCreateWizard.vue:214-225` 为刷新间隔输入设置了 `precision=0` 和 `step-strictly=true`。
- `mail-vue/src/views/share-admin/ShareCreateWizard.vue:597-618` 在请求发出前要求刷新间隔既是 safe integer 又不小于 3000；`3000.5` 会在 `submit()` 调用 `createMailShare` 前返回本地错误。
- `mail-vue/src/views/share-admin/ShareCreateWizard.spec.js:589-600` 明确启用 AuthKey 形成 fence intent，再输入 `3000.5`，断言零请求、`capabilityV2` 保持 `unknown`、不出现 inactive 提示且显示本地错误。该测试直接覆盖原误降级链，不是空断言。

结论：小数刷新间隔不会到达后端，也不会被误读为 V2 fence miss。P2-1 已关闭。

## 范围与回归核验

1. `git show --stat 4648101` 仅包含 `ShareCreateWizard.vue` 和 `ShareCreateWizard.spec.js`：2 files changed，53 insertions，4 deletions。
2. 提交期间 footer、遮罩、Escape、右上角关闭均被阻止，且统一关闭回调还有状态守卫。
3. deferred create resolve 后，一次性链接在仍打开的向导中可见。
4. 带 fence intent 的 `refreshIntervalMs=3000.5` 不调用 `createMailShare`，能力状态不变。
5. 新用例分别使用 deferred Promise 和显式小数输入，均命中原失败链。
6. 生产调用方仍存在：`mail-vue/src/views/share-admin/index.vue:18` 挂载 `<ShareCreateWizard @created="refresh"/>`，`mail-vue/src/views/share-admin/index.vue:107` 导入该组件。
7. `4648101` 只改 wizard 生产文件及其测试，没有引入新的 P0。

## 实际运行命令

```sh
git show --stat 4648101

git show --format=fuller --no-ext-diff --no-renames 4648101 --

git status --short --branch && git rev-parse HEAD && git merge-base --is-ancestor 4648101 HEAD

git diff --stat 4648101..HEAD -- mail-vue/src/views/share-admin/ShareCreateWizard.vue mail-vue/src/views/share-admin/ShareCreateWizard.spec.js && git diff --check 4648101^ 4648101

git diff --name-status 4648101^ 4648101 && git diff --numstat 4648101^ 4648101

pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareCreateWizard.spec.js src/request/mail-share.spec.js src/views/email/ShareDialog.spec.js src/views/email/ShareIndicator.spec.js src/views/share-admin/index.spec.js src/views/share/share-chunk.spec.js --no-cache

pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareCreateWizard.spec.js --no-cache -t 'T22-P'
```

## 测试结果

- 指定六文件 Vitest：**6 files passed / 58 tests passed**，EXIT=0。
- T22-P 定向 Vitest：**1 file passed / 2 tests passed / 21 tests skipped（23 total）**，EXIT=0。
- `git diff --check 4648101^ 4648101`：无输出，EXIT=0。
- `git diff --stat 4648101..HEAD -- <wizard vue+spec>`：无输出，确认当前被审文件与修复提交一致。
