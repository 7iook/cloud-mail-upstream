VERDICT NEEDS_CHANGES

# T-25 R2 · P1 过筛修复复审

## P0

无。

## P1

1. **已缓存的兄弟 Tab 出现新邮件角标后，点击仍不拉新邮件，P1-1 只修复了“首次进入无缓存 Tab”的路径。** `selectTab` 先切换 active Binding，随后只要该 Binding 存在任意缓存邮件，就用旧缓存推进水位并直接返回；它没有检查 status 已经报告的 `latestEmailId` 是否高于该水位。可复现调用链：先访问 Binding 8002 缓存 mailId 52 → 切回 Binding 0 → 后续 status 报告 8002 的 `latestEmailId=53` 并亮角标 → 再点击 8002。此时缓存分支只把水位推进到 52，不调用 `listShareMails`，mailId 53 没有展示；切回 Binding 0 后 `hasNew(52, 53)` 又让同一角标复现。当前新增 AC-OTP-09 用例在点击 8002 前没有缓存该 Binding，因此只覆盖了 fetch 分支；既有“有缓存就永不重取”的断言也没有区分“无新邮件”与“status 已报新邮件”。这违反“切 Tab 拉取该 Binding 的 mails 并推进实际返回页水位”以及本轮成功条件中的消费后角标语义。修复应在改变 active Binding 前保留该 Tab 是否有新邮件的判断：仅 `cached && !hasNew` 时复用缓存；有角标时仍拉一次该 Binding，随后按实际返回页推进水位。补回归：先缓存兄弟 Tab，再令其 status head 从 52 变 53，点击后必须请求 8002、展示 53，未等下一 tick 切走时角标仍为空。`mail-vue/src/views/share/index.vue:308-317,365-367,417-435`; `mail-vue/src/views/share/index.spec.js:707-733,935-969`; `docs/specs/mailbox-share-capability/requirements.md:143-145`

## P2

无。

## 其余复审结论

- P1-2 已修：`isMulti` 由当前 Binding 数量派生，stored token 路径在首个 status tick 后恢复 Tab，且列表按 active Binding 隔离。`mail-vue/src/views/share/index.vue:331-340,390-415`; `mail-vue/src/views/share/index.spec.js:972-997`
- P1-3 已修：multi 页面不再拼接遗留明文 `mailbox`，整页明文断言已覆盖；single 页面仍保留原标题行为。`mail-vue/src/views/share/index.vue:9,333-340`; `mail-vue/src/views/share/index.spec.js:658-679`
- `advanceFromPage` 已接入 poll、无缓存的 `selectTab` 与 `beginMailbox`，并按实际返回页而非 status head 推进；本轮 P1 仅是上述 cached 分支遗漏。`mail-vue/src/views/share/index.vue:274-317,417-438,622-645`
- 每个 poll tick 仍为一次 status + 一次当前 Binding mails；没有 Binding fan-out。`mail-vue/src/views/share/index.vue:300-317`; `mail-vue/src/views/share/index.spec.js:736-759`
- 按主 AI 过筛维持 P1-4 HOLD：未要求 `listForBinding` 返回 `SHARE_UNAVAILABLE`，未重开空页语义。
- `mail-vue/src/composables/useSharePolling.js` 在 `6f4efd4..33213e9` 无差异；`SHARE_CAPABILITY_V2` 测试配置仍为 `"false"`，生产配置仍缺省即 false。`mail-worker/wrangler-vitest.toml:39-41`; `mail-worker/wrangler.toml:56-59`
- `git diff --check 6f4efd4..33213e9` 通过。

## 测试证据

- `pnpm --dir mail-vue exec vitest run --no-cache src/views/share/index.spec.js src/views/share/status-watermark.spec.js src/composables/useSharePolling.spec.js src/request/share.spec.js src/views/share/share-chunk.spec.js` → EXIT=0，5 个文件 / 67 条测试通过。
- 绿测不推翻 P1：新增 leave-before-next-tick 用例只走“兄弟 Tab 尚无缓存”的 fetch 分支，没有执行 `selectTab` 的 `cached.length` 提前返回分支。

## Update Log

- 2026-08-24 · 主 AI 过筛：R2 P1-1 CHANGE（有缓存且 `hasNew` 时仍拉一页；无新邮件的缓存点击保持零请求）。P1-4 不重开。
