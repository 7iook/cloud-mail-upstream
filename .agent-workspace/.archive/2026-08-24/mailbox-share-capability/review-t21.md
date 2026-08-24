# T-21 独立代码审查

Verdict: NEEDS_CHANGES

- 审查对象：`00b0ae141355ec93b7fc39cc2ec4b68a77c6830c`
- P0: 0
- P1: 1
- P2: 1
- 未采信 `exec-t21-note.md` 作为完成证据；结论来自提交 diff、当前生产调用链、后端契约及实际测试。

## P0

无。

## P1

### P1-1 · 迟到的旧分享响应可覆盖当前抽屉，并把一次性 AuthKey 显示到错误分享

- 位置：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:508-524`、`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:674-718`、`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:721-750`、`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:779-792`
- 触发：对分享 A 发起详情加载、配置保存或 AuthKey 操作，在 Promise 完成前关闭抽屉并打开分享 B。组件没有 selection generation/request sequence；A 的迟到结果仍会无条件执行 `applyDetail`、写 `authKeyOnce`、设置错误态或调用 `closeGone`。
- 影响：
  - A 的详情/表单可覆盖 B 的抽屉，而后续写请求使用当前 `props.shareId`，形成“展示 A、写 B”的错误资源关联；
  - A 的一次性 AuthKey 可出现在 B 的抽屉中，Owner 可能把错误 Key 交付给访客；
  - A 的迟到 `SHARE_NOT_FOUND` 可关闭正在查看的 B。
- 证据：`watch` 每次直接调用 `load(shareId)`，但 `load` 在 await 后未核对当前 `shareId`；`updateMailShare` 与 `resetMailShareAuthKey` 的响应同样直接落入共享状态。列表页已有 `reqSeq` 防旧响应覆盖，抽屉没有等价保护。现有测试只覆盖单次打开，没有构造两个 shareId 的逆序 resolve。
- 必需修复：以“当前选择代次”为边界；每次 `shareId` 变化/关闭时递增 generation，各异步入口捕获发起时的 `shareId + generation`，在写 `detail`、`authKeyOnce`、错误态、关闭抽屉或触发后续 reload 前确认仍是当前选择。补充 deferred Promise 回归：A、B 逆序返回后只允许 B 渲染；A 的 AuthKey/错误不得进入或关闭 B。

## P2

### P2-1 · 成功 disable 后仍保留并展示已失效的一次性 Key

- 位置：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:300-317`、`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:728-736`
- 触发：先 enable 得到明文，但不点击“我已保存”，随后成功 disable。
- 影响：disable 响应没有 `authKey`；当前代码只在 `if (authKey)` 时赋值，因此旧 `authKeyOnce` 不会清空。页面会同时显示“未启用”和一把已失效的“新密钥”，并让敏感明文无必要地继续留在 DOM。
- 建议修复：成功处理 AuthKey 响应时令 `authKeyOnce.value = authKey || ''`；补充 enable → disable 的连续操作测试，断言一次性区消失。

## 要求逐项核验

1. **提交范围 / 禁改文件：PASS。** `git show --stat 00b0ae1` 列出 9 个路径；针对 `mail-vue/src/request/mail-share.js`、i18n、router、`mail-worker/**`、`mail-vue/src/views/email/**`、`mail-vue/src/views/share/**` 的提交差异为空。
2. **列表页挂载 ≤10 行：PASS。** `mail-vue/src/views/share-admin/index.vue` 为 `+7/-0`，仅加入两个组件、两个 import、`activeShareId` 和两处挂载。
3. **dirty-field update：PASS。** `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:626-660` 逐字段与 detail 基线比较；`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:684-704` 只发送 `{shareId, ...patch}`，没有全表单 PUT。
4. **ACCESS_LIMIT_REACHED 可写：PASS。** `mail-vue/src/views/share-admin/status.js:20-22` 仅把 `ACTIVE` 与 `ACCESS_LIMIT_REACHED` 判为 mutable；EXPIRED/REVOKED 详情仍渲染但控件禁用。
5. **T21-FLIP：PASS。** 父提交中的旧用例断言 row 内 `0 button`；当前 `mail-vue/src/views/share-admin/index.spec.js:291-307` 保留该用例位置与 `data-share-id`/`data-status` 守卫，并要求 `row-open-detail`、`row-revoke`、`row-delete` 三个 hook。
6. **Binding 请求维度：PASS。** add 在 `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:576-583` 发送 accountId；remove 在 `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:585-603` 发送 bindingId。
7. **不消费 bindings PUT 的 mailbox：PASS。** `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:552-574` 丢弃 PUT 响应并重新调用 detail GET。
8. **AuthKey 三操作与一次性明文主路径：PASS（但受 P1/P2 影响）。** enable/reset/disable 都进入 `resetMailShareAuthKey`；enable/reset 的返回明文只落本地 `authKeyOnce`，确认或关闭时清除。
9. **生产调用方：PASS。** `mail-vue/src/views/share-admin/index.vue:80-85` 实际挂载 `ShareRowActions` 与 `ShareDetailDrawer`；抽屉生产代码直接调用 get/update/bindings/resetAuthKey，不是 tests-only。
10. **指定回归：PASS。** 4 files / 60 tests 全部通过，EXIT=0；这些测试未覆盖 P1 的跨 shareId 逆序响应及 P2 的 enable → disable 连续流。

## 实际运行命令

```sh
git status --short --branch && git rev-parse --abbrev-ref HEAD && git show --stat 00b0ae1 && git diff-tree --no-commit-id --name-status -r 00b0ae1

git diff --name-only 00b0ae1^ 00b0ae1 -- mail-vue/src/request/mail-share.js mail-vue/src/locales mail-vue/src/i18n mail-vue/src/router mail-worker mail-vue/src/views/email mail-vue/src/views/share && git diff --numstat 00b0ae1^ 00b0ae1 -- mail-vue/src/views/share-admin/index.vue && git diff --unified=80 00b0ae1^ 00b0ae1 -- mail-vue/src/views/share-admin/index.vue

git show 00b0ae1^:mail-vue/src/views/share-admin/index.spec.js | rg -n "hands row actions|button|data-share-id|data-status"

git diff --check 00b0ae1^ 00b0ae1

pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareDetailDrawer.spec.js src/views/share-admin/ShareRowActions.spec.js src/views/share-admin/index.spec.js src/request/mail-share.spec.js --no-cache
```

## 测试结果

- 指定 Vitest：4 files passed，60 tests passed，EXIT=0。
- `git diff --check 00b0ae1^ 00b0ae1`：无输出，EXIT=0。
- 禁改路径差异：无输出。
- `index.vue` numstat：`7  0`。
