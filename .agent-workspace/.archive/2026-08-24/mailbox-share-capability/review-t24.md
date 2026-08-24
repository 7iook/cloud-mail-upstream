# T-24 `ShareOtpCard` 抽取审查

VERDICT APPROVED

## P0

无。

## P1

无。

## P2

无。

## 独立核验

- 用户可见行为保持：卡片仍先取当前选中且有码的邮件，否则从 `mails` 尾部向前取最新有码邮件；展示、发送者文案、复制成功与手动复制降级仍由同一卡片完成。`mail-vue/src/views/share/ShareOtpCard.vue:3-30,68-100`
- `otpExtractionEnabled` 仅在严格等于 `false` 时关闭 OTP；缺失配置保持开启，`bootstrap` 每次先重置为 `true`，首次建会话和重建会话均应用同一 helper。`mail-vue/src/views/share/index.vue:142,224-226,275-292,447-475`
- 关闭 OTP 不影响邮件列表；空 `code` 也仍列出邮件且不显示 OTP。`mail-vue/src/views/share/index.spec.js:300-316,516-532`
- `copyResult` 留在子组件内，父级仅在 `state === 'ready'` 时挂载该组件；退出后卸载并在再次 ready 时无残留。未新增 `defineExpose`、`v-model` 或父级复制状态。`mail-vue/src/views/share/index.vue:30-35,500-503`; `mail-vue/src/views/share/ShareOtpCard.vue:62,89-100`; `mail-vue/src/views/share/index.spec.js:534-561`
- 手动复制路径保留 `is-visible`；32px、0.12em 和显形规则均随卡片迁移，父组件已无 `.share-otp {` 规则。`mail-vue/src/views/share/ShareOtpCard.vue:20-30,131-160`; `mail-vue/src/views/share/index.spec.js:563-592`
- `senderLine` 只有一个实现并由父子共用。`mail-vue/src/views/share/mail-fields.js:1-8`; `mail-vue/src/views/share/index.vue:58-69,122`; `mail-vue/src/views/share/ShareOtpCard.vue:18,38`
- 子组件 props 仅为 `mails`、`selected`、`enabled`，没有 `bindingId`、`mailboxes`、`shareType`；`ElMessage` 仍为受守卫的自动导入裸标识符，没有从 `element-plus` 手动导入。`mail-vue/src/views/share/ShareOtpCard.vue:35-57,95-100`
- `data-share-shell="cloud-mail-share-shell"` 保持在父入口。`mail-vue/src/views/share/index.vue:2-5`
- 对 `baab349^..baab349` 的提交范围核验未发现 router 访客守卫、`init/init.js`、`session.js`、i18n、`mail-worker` 或其他负面清单文件改动；新增 share 源文件的登录图禁入断言覆盖三文件，构建后 share chunk 隔离闸门也保持通过。`mail-vue/src/views/share/index.spec.js:503-514`; `mail-vue/src/views/share/share-chunk.spec.js:11-21`
- 对 `index.spec.js` 的 zero-context diff 核验：原 18 个 `it()` 中仅 AC-VISIT-10 改为循环 `index.vue`、`ShareOtpCard.vue`、`mail-fields.js` 且七条断言未变；其余 17 个旧用例正文无改动，新增 4 个用例后总数为 22。`mail-vue/src/views/share/index.spec.js:503-592`
- 未发现 `ShareOtpCard.spec.js`。

## 运行证据

`pnpm --dir mail-vue exec vitest run --no-cache src/views/share/index.spec.js src/views/share/share-chunk.spec.js`

结果：2 个测试文件通过，23 个测试全部通过；其中 `index.spec.js` 22 条、share chunk 隔离闸门 1 条。
