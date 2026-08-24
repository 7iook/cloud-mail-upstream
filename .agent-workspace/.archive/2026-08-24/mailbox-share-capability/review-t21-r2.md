# T-21 R2 独立复审

Verdict: APPROVED

- 审查对象：`5af86753257848d44c67b7d46acdc3e3615d28b1`
- P0: 0
- P1: 0
- P2: 0
- 结论来自修复提交 diff、当前生产文件与独立运行的指定测试；未采信执行者说明作为证据。

## P0

无。`5af8675` 未引入新的 P0。

## P1

### P1-1 · CLOSED

- 位置：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:424-432`、`:499-503`、`:518-540`、`:570-599`、`:715-752`、`:760-790`、`:820-833`
- `watch(shareId)` 在清理状态和调用 `load` 前先递增 `reqGen`；`close()` 也先递增，关闭后的迟到响应无法再通过 `isCurrent(gen, shareId)`。
- `load`、`runBindingChange`、`submitSave`、`submitAuthKey` 均捕获发起时的 generation 与 shareId，并在写入详情、一次性 AuthKey、错误状态、触发 `closeGone` 或成功副作用前核对当前选择。A 的迟到详情、AuthKey 或 `SHARE_NOT_FOUND` 不会覆盖、污染或关闭 B。
- 回归位置：`mail-vue/src/views/share-admin/ShareDetailDrawer.spec.js:797-868`。三项测试使用独立 deferred Promise，真实控制 A/B 的逆序完成，并分别断言 A 详情被丢弃、A 明文 Key 不进入 B、A 的 `SHARE_NOT_FOUND` 不关闭 B，不是无效断言。

## P2

### P2-1 · CLOSED

- 位置：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:769-775`
- AuthKey 操作成功后无条件执行 `authKeyOnce.value = authKey || ''`；disable 响应没有 `authKey` 时会清空旧明文。
- 回归位置：`mail-vue/src/views/share-admin/ShareDetailDrawer.spec.js:671-687`。测试先 enable 并确认一次性区域出现，再 disable，断言区域消失、明文输入为零且回到 enable 状态。

## 逐项核验

1. **提交范围：PASS。** `git show --stat 5af8675` 为 5 个文件：drawer Vue、drawer spec、`review-t21.md`、session ledger、tasks；共 `230 insertions(+), 12 deletions(-)`。
2. **切换与关闭递增 generation：PASS。** `watch` 与 `close()` 均在异步结果可能落地前使旧 generation 失效。
3. **所有指定异步入口隔离旧响应：PASS。** 四个入口的成功、失败及关闭路径均受 `isCurrent` 约束。
4. **disable 清理明文：PASS。** 无 `authKey` 属性的成功响应将一次性 Key 置空。
5. **新增测试有效：PASS。** 要求的四个场景均有行为断言；聚焦筛选实际命中 4 项测试。
6. **生产调用方：PASS。** `mail-vue/src/views/share-admin/index.vue:80-85` 仍由真实行操作设置 `activeShareId` 并挂载 `ShareDetailDrawer`，不是 tests-only。
7. **差异完整性：PASS。** `git diff --check 5af8675^ 5af8675` 无输出，退出码 0。

## 实际运行命令

```sh
git status --short --branch && git show --stat --oneline --decorate --no-renames 5af8675 && git show --format=fuller --no-ext-diff --no-renames --find-renames=0 5af8675 --

git diff-tree --no-commit-id --name-status -r 5af8675 && git diff --check 5af8675^ 5af8675

git show --stat 5af8675 && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --short --branch

pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareDetailDrawer.spec.js src/views/share-admin/ShareRowActions.spec.js src/views/share-admin/index.spec.js src/request/mail-share.spec.js --no-cache

pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareDetailDrawer.spec.js --no-cache -t 'T21-P'
```

## 测试结果

- 指定回归：4 files passed，64 tests passed，退出码 0。
- `T21-P` 聚焦回归：1 file passed，4 tests passed，33 tests skipped，退出码 0。
