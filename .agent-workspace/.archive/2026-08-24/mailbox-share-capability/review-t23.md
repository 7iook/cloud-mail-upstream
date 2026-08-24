# T-23 独立代码审查

Verdict: NEEDS_CHANGES

审查对象：`4f4cc65294adcde226256f18183585c8e5bd42ba feat(vue): add share-admin jump from ShareDialog`

## P0 / P1 / P2

| 级别 | 数量 | Findings |
|---|---:|---|
| P0 | 0 | 无 |
| P1 | 0 | 无 |
| P2 | 1 | 提交范围多出非 archive 的 `docs/specs/mailbox-share-capability/tasks.md` |

## Findings

### P2-1 · 提交范围不符合本轮白名单

- 证据：`git show --format= --name-status --no-renames 4f4cc65` 列出 7 个文件；除两份 `ShareDialog` 文件和 archive 记录外，还修改了 `docs/specs/mailbox-share-capability/tasks.md`。
- 具体改动：仅在 `tasks.md` Update Log 新增一条“T-23 实现待审查”记录，未改任务勾选或产品契约；因此不是运行时缺陷，也未触及明确禁止的 request、share-admin、ShareIndicator、i18n、router、perm 或 mail-worker 路径。
- 风险：违反审查提示中“only ShareDialog.vue / ShareDialog.spec.js plus archive notes”的提交范围约束，使实现提交夹带非白名单文档变更。
- 建议：从 T-23 实现提交中移出该 `tasks.md` 更新，待审查结论产生后再由协调提交统一回写。

## 8 项核对

| # | 结果 | 独立核对证据 |
|---:|:---:|---|
| 1 | FAIL | 提交包含两份 `ShareDialog` 文件、4 个 archive 文件及 `docs/specs/mailbox-share-capability/tasks.md`；后者不属于 archive notes。明确禁止的 `request/mail-share.js`、`share-admin/**`、`ShareIndicator`、i18n、`router/index.js`、`perm/perm.js`、`mail-worker/**` 均无 diff。 |
| 2 | PASS | 逐个提取父提交与本提交的前 6 个 `it()`，6/6 字节一致；零删除既有断言。 |
| 3 | PASS | `submitCreate()` 仍只传 `{accountId, durationSeconds, name, remark}`；新增 `toEqual` 回归同时排除 `accountIds`、`authKeyEnabled`、`maxSessions`、`messageLimit`。 |
| 4 | PASS | footer 按钮使用 `v-if="canManage"`；`canManageShare()` 先以 `Array.isArray(permKeys)` 防守再调用 `hasPerm('share:manage')`。无权限和缺失 `permKeys` 两种测试均不渲染入口，且 `routerPush` 为 0 次。 |
| 5 | PASS | `goShareAdmin()` 源码先同步 `emit('update:modelValue', false)`，下一句才调用 `router.push({ name: 'share-admin' })`；测试确认关闭事件和唯一一次目标路由调用。 |
| 6 | PASS | 生产代码精确使用 `import router from '@/router/index.js'`，未使用 `useRouter()`；测试对同一模块字符串 mock 默认导出。 |
| 7 | PASS | `ShareDialog.vue` 对 `share-detail-drawer`、`share-create-wizard`、`binding-add`、`authkey-once` 搜索均无匹配；新增测试也逐项断言不存在。 |
| 8 | PASS | 入口位于 `ShareDialog.vue` 的真实 `<el-dialog>` footer slot，并直接绑定生产函数 `goShareAdmin`，不是 tests-only 接线。 |

## 实际运行命令

```sh
git status --short --branch
git show --stat --oneline --decorate --no-renames 4f4cc65
git show --format=fuller --no-ext-diff --no-renames 4f4cc65 -- mail-vue/src/views/email/ShareDialog.vue mail-vue/src/views/email/ShareDialog.spec.js
git show --format= --name-status --no-renames 4f4cc65
git diff --unified=0 4f4cc65^ 4f4cc65 -- mail-vue/src/views/email/ShareDialog.spec.js
git diff --check 4f4cc65^ 4f4cc65
git show --format= --numstat 4f4cc65
git diff --name-only 4f4cc65^ 4f4cc65 -- mail-vue/src/request/mail-share.js mail-vue/src/views/share-admin mail-vue/src/views/email/ShareIndicator.vue mail-vue/src/i18n mail-vue/src/router/index.js mail-vue/src/perm/perm.js mail-worker
node - <<'NODE'
// 读取 git show 的父/当前 ShareDialog.spec.js，精确比较前 6 个 it()。
NODE
pnpm --dir mail-vue exec vitest run src/views/email/ShareDialog.spec.js src/views/email/ShareIndicator.spec.js src/request/mail-share.spec.js --no-cache
git show --format= --no-ext-diff --no-renames 4f4cc65 -- docs/specs/mailbox-share-capability/tasks.md .agent-workspace/.archive/2026-08-24/mailbox-share-capability/session-ledger.md
```

另有一次初始比较尝试调用 `python`，因环境无该命令退出 127；随后改用上列 `node` 比较并取得 6/6 一致结果，该失败未作为审查证据。

## 测试结果

- 指定回归：3 files passed / 18 tests passed，EXIT=0。
- 文件分项：`ShareDialog.spec.js` 10 tests、`ShareIndicator.spec.js` 2 tests、`mail-share.spec.js` 6 tests，共 18 tests。
- `git diff --check 4f4cc65^ 4f4cc65`：无输出，EXIT=0。
