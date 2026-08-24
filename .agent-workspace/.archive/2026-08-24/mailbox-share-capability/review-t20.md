# T-20 独立代码审查

Verdict: APPROVED

审查对象：`672da73 feat(vue): add share-admin list page and owner APIs`

当前 `HEAD` 为后续纯文档提交 `ee50647`；`git diff --name-status 672da73..HEAD -- <7 个受审源码/测试文件>` 无输出，因此本次测试运行的受审文件与 `672da73` 完全一致。

## P0 / P1 / P2

| 级别 | 数量 | Findings |
|---|---:|---|
| P0 | 0 | 无 |
| P1 | 0 | 无 |
| P2 | 0 | 无 |

## Findings

无。未发现阻塞 T-20 验收或需要后续修正的缺陷。

## 12 项核对

| # | 结果 | 独立核对证据 |
|---:|:---:|---|
| 1 | PASS | `git show --stat` 与 `git diff --name-only` 仅列出 9 个白名单路径：request + spec、`perm.js`、aside、`share-admin/*`、`exec-t20-note.md`、`recon-t21-drawer.md`。未出现 `router/index.js`、i18n、axios、`views/share/**`、`ShareDialog.vue` 或 `mail-worker/**`。 |
| 2 | PASS | `mail-vue/src/request/mail-share.js:33-52` 只提取非空 `page/size/status`；无有效参数时调用单实参 `http.get('/mailShare/list')`。`mail-vue/src/request/mail-share.spec.js:67-76` 覆盖 `listMailShares()`、`listMailShares({})`、`listMailShares({status:'', page:null})`。 |
| 3 | PASS | `mail-vue/src/request/mail-share.spec.js:40-65` 的既有 create 及 list/revoke 两例仍保留原契约断言；提交 diff 仅扩充 mock/import/setup，并在这两例之后追加用例。 |
| 4 | PASS | `mail-vue/src/request/mail-share.js:84-90` 以数值 `code === 403` 或 `message === 'SHARE_FORBIDDEN'` 判定 body-403；`mail-vue/src/views/share-admin/index.vue:167-177` 只切换 forbidden/error 状态，不清 token、不调用 `router.replace`。对应回归见 `mail-vue/src/views/share-admin/index.spec.js:205-223`。 |
| 5 | PASS | `mail-vue/src/views/share-admin/status.js:3-14` 为四态配置不同 label/tone；`mail-vue/src/views/share-admin/index.vue:47-55` 同时输出 `data-status` 和可见标签；`mail-vue/src/views/share-admin/index.spec.js:124-142` 验证四个状态与四个不同文案。 |
| 6 | PASS | `mail-vue/src/views/share-admin/status.js:28-30` 对 `maxSessions == null` 使用 unlimited 文案；`mail-vue/src/views/share-admin/index.vue:64-68` 渲染该结果；`mail-vue/src/views/share-admin/index.spec.js:144-155` 防止出现字面量 `null`。 |
| 7 | PASS | `mail-vue/src/views/share-admin/status.js:33-50` 对空 mailbox 使用 `#accountId` 并过滤空项；`mail-vue/src/views/share-admin/index.vue:60-63` 渲染摘要；`mail-vue/src/views/share-admin/index.spec.js:157-174` 覆盖空 mailbox 场景及空逗号防线。 |
| 8 | PASS | `mail-vue/src/views/share-admin/index.vue:133-157` 首次查询只带 `page/size`；`mail-vue/src/views/share-admin/index.vue:186-193` 切筛选先重置到第 1 页。`mail-vue/src/views/share-admin/index.spec.js:176-203` 覆盖筛选、翻页及单页隐藏分页器。 |
| 9 | PASS | `mail-vue/src/perm/perm.js:62-72` 仅在 `share:manage` 映射中定义 `/share-admin` 且设置 `meta.perm`；`mail-vue/src/views/share-admin/index.spec.js:255-272` 验证 `share:manage` 命中、`email:send` 不命中、`*` 命中。 |
| 10 | PASS | `mail-vue/src/views/share-admin/index.vue:41-79` 的 row 只有字段和徽标，无写入/撤销/删除按钮；`mail-vue/src/views/share-admin/index.spec.js:243-252` 验证 row 内 0 button 且无 `revoke-share` hook。页头刷新按钮不在 row 内，符合已裁决范围。 |
| 11 | PASS | `mail-vue/src/views/share-admin/index.vue:216-218,249-253,321-330` 使用 `@media (max-width: 767px)`；源码无 `window.onresize`。`mail-vue/src/views/share-admin/index.spec.js:275-280` 有静态契约守卫。 |
| 12 | PASS | 生产接线完整：`mail-vue/src/layout/aside/index.vue:29-33` 提供带权限的个人组入口；`mail-vue/src/perm/perm.js:62-72` 提供动态路由；`mail-vue/src/views/share-admin/index.vue:151-200` 实际调用 `listMailShares` 并支持筛选、刷新、翻页。不是 tests-only。 |

## 实际运行命令

```text
git status --short --branch
git show --stat --oneline --decorate --no-renames 672da73
git diff --name-only --no-renames 672da73^ 672da73
git show --no-ext-diff --no-renames --format=fuller 672da73
git diff --no-ext-diff --no-renames 672da73^ 672da73 -- mail-vue/src/request/mail-share.js mail-vue/src/request/mail-share.spec.js mail-vue/src/perm/perm.js mail-vue/src/layout/aside/index.vue mail-vue/src/views/share-admin/index.vue mail-vue/src/views/share-admin/status.js mail-vue/src/views/share-admin/index.spec.js
git rev-parse HEAD
git diff --check 672da73^ 672da73
git diff --name-status 672da73..HEAD -- mail-vue/src/request/mail-share.js mail-vue/src/request/mail-share.spec.js mail-vue/src/perm/perm.js mail-vue/src/layout/aside/index.vue mail-vue/src/views/share-admin/index.vue mail-vue/src/views/share-admin/status.js mail-vue/src/views/share-admin/index.spec.js
pnpm --dir mail-vue exec vitest run src/views/share-admin/index.spec.js src/request/mail-share.spec.js --no-cache
pnpm --dir mail-vue test -- --no-cache
```

## 测试结果

- 必跑定点测试：2 files / 20 tests，全部通过，EXIT=0。
- 可选全量 Vue 回归：18 files / 113 tests，全部通过，EXIT=0。
- `git diff --check 672da73^ 672da73`：无输出，EXIT=0。
