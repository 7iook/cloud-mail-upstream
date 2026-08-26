# T4 · 创建成功后关窗不再拦「只显示一次」确认

审查对象：`fabe6e841109dfb84b8b4da651c7caa03a5d7db4` 中 T4 部分。当前 worktree 为 `9b6eb8072fe73c93518e872037702a2e8e54056b`；`fabe6e8..HEAD` 对本主题代码、测试、i18n、详情取回及服务端取回实现均无后续改动。

## Findings

本主题无 finding。

## 实际查证

1. **`sec` 的可恢复前提成立。** `docs/architecture/ADR-share-credential-recoverability.md:41-49` 只放宽新建分享的 `sec`，要求 Owner 可经专用端点取回完整链接；`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:292-340` 提供真实的“查看链接”入口及完整 URL 输出；`mail-vue/src/request/mail-share.js:127-132` 接到 `POST /mailShare/revealSec`；`mail-worker/src/service/mail-share-service.js:2159-2193` 以 Owner 归属校验后解密并返回 `shareUrl`。现有正向契约测试 `mail-worker/test/mail-share-service.spec.js:4336-4346` 逐字比较 reveal 与 create 返回的 URL。

2. **AuthKey 不可恢复，但没有被链接文案错误覆盖。** ADR 在 `docs/architecture/ADR-share-credential-recoverability.md:75-78` 明确排除 AuthKey；`docs/specs/mailbox-share-capability/requirements.md:59,108` 分别规定明文恰一次与不得存储/记录。结果面板在 `mail-vue/src/views/share-admin/ShareCreateWizard.vue:77-95` 仅当响应含 AuthKey 时显示独立警示；中英文文案在 `mail-vue/src/i18n/{en,zh}.js:515` 均明确“关闭后无法再查看”。`ShareCreateWizard.spec.js:624-648` 同时断言 AuthKey 警示包含不可恢复语义、链接提示不再冒充同一语义。因此，关窗确实会丢失未保存的 AuthKey，但这是 ADR 保留的“只展示一次”行为，且已在关窗前的结果面板准确告知；仓库契约没有要求再叠加一个模态确认。

3. **批量结果没有放大不可恢复损失。** `ShareCreateWizard.vue:35-57` 的批量面板逐条展示链接并明确日后可从详情查看；该分支按代码注释与栅栏关系不携带 AuthKey。`ShareCreateWizard.spec.js:582-607` 覆盖两条链接均渲染、均可复制，并在“我已保存”后清除本地明文。`ShareCreateWizard.vue:630-632` 的 `acknowledgeSecret` 只清本地结果，不撤销或改写服务端分享；创建成功还在 `:740-748` 发出 `created` 以刷新管理列表，详情取回入口仍可达。

4. **残留与回归断言已收口。** 生产源码检索 `shareWizardCloseConfirm|hasUnsavedSecret` 为零命中；`ShareCreateWizard.vue` 已无 `ElMessageBox` import。`ShareCreateWizard.spec.js:651-680` 将原“确认框被调用”断言重写为 `confirm` 不得调用、对话框立即关闭且本地明文清空，并未删除该场景；`:738-759` 仍单独守住创建请求进行中不得关闭。`shareWizardCloseConfirm` 已从 zh/en 与组件 `PENDING_COPY` 移除。

## 验证记录

- 静态可执行核对：8/8 通过，覆盖残留为零、AuthKey 独立警示、中英文不可恢复文案、关闭不弹确认、pending create 关闭保护、批量链接回归。
- `git diff --check fabe6e8^ fabe6e8 --` 本主题四个文件：退出码 0。
- 专项 Vitest 未计入通过证据：`/tmp/share-review/mail-vue` 没有依赖目录，`pnpm exec vitest run src/views/share-admin/ShareCreateWizard.spec.js --no-cache` 退出 254（`vitest not found`）；复用 `/workspace` 依赖时因 ESM 不能从该 detached worktree 解析 `vitest/config` 而在启动阶段退出 1。遵守 read-only 约束，未安装依赖、未写 symlink。

## 结论

`NO_FINDINGS`。删除的是重复且对链接作出错误陈述的二次确认；`sec` 可恢复、AuthKey 仍不可恢复且有独立一次性警示、批量链接均可从各自详情取回、创建进行中的关闭保护仍在。
