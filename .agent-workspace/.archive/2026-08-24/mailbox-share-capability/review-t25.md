VERDICT NEEDS_CHANGES

# T-25 多邮箱 Tab / 水位 / `listForBinding` 审查

## P0

无。

## P1

1. **切 Tab 的即时取数没有推进该 Binding 水位，已消费邮件会再次亮角标。** `selectTab` 成功拉取后只调用 `mergeMails`，而 `advanceFromPage` 只在轮询路径调用；`beginMailbox` 的首次拉取也没有推进。触发方式：兄弟 Tab 的 `latestEmailId` 从 52 变 53 后出现角标，点击该 Tab 即时拉到 mailId 53，再在下个 poll tick 前切回其他 Tab；存储仍为 52，53 已展示却再次被 `hasNew` 判为未消费。该行为违反 AC-OTP-09 与 design.md 的“消费（拉取）后推进实际返回页最大 email_id / 切 Tab 拉取并推进水位”。修复应让所有成功消费路径（至少 `selectTab` 与 `beginMailbox`，以及现有 `pollTick`）统一调用同一推进 helper，并补“点击有角标 Tab → 存储推进 → 未等下一 tick 切走仍无角标”的回归测试。`mail-vue/src/views/share/index.vue:274-281,292-301,392-409,593-615`; `docs/specs/mailbox-share-capability/design.md:348,401`; `docs/specs/mailbox-share-capability/requirements.md:145`

2. **从 sessionStorage 恢复多邮箱 Session 后，Tab 永久不出现。** `bootstrap` 先把 `shareType` 重置成 `single`、清空 `mailboxes`；命中已有 token 的分支不调用 `applyShareConfig`。后续 status 虽能通过 `syncMailboxesFromStatus` 恢复多个 Binding，却从不把 `shareType` 改回 `multi`，因此 `isMulti` 始终为 false。该路径首次还以 `activeBinding=null` 拉取归并列表，页面退化为无 Tab 的混合邮箱视图，违背 T-25 的多邮箱访客成功态。修复应从已有 token 恢复时由权威状态重建多邮箱渲染状态（同时保留安全的掩码标签来源），并补“预置 `share:session:<lid>` + 两条 status Binding → 首个 status tick 后出现 Tab 且列表按 active Binding 隔离”的测试。`mail-vue/src/views/share/index.vue:315-325,375-390,653-699`; `mail-vue/src/views/share/index.spec.js:172-180`

3. **默认掩码的多邮箱页仍在顶部展示第一个邮箱明文。** 模板始终渲染 `mailbox`，bootstrap 又把 session 响应的遗留 `mailbox` 写入该字段；服务端明确说明这个遗留字段是未掩码值，而同一响应的 `mailboxes[].address` 才应用掩码策略。现有测试只断言 Tab 容器内没有 `first@example.com`，没有检查整页，因此默认 `showFullAddress=false` 时会同时出现掩码 Tab 和明文标题。修复应在 multi 分支使用 `mailboxes[].address` 或不展示遗留 `mailbox`，同时保持 single 页面原行为，并把断言扩大到整个多邮箱页面。`mail-vue/src/views/share/index.vue:7-10,436-440,683-687`; `mail-worker/src/service/share-auth-service.js:392-403`; `mail-vue/src/views/share/index.spec.js:658-670`; `docs/specs/mailbox-share-capability/requirements.md:45,128`

4. **篡改或外部 `bindingId` 被改成成功空页，违反既定错误契约。** `listForBinding` 对不属于当前 ShareContext 的 id 直接返回 `[]`，API 测试进一步固定为 HTTP 200 / code 200；但 AC-MAIL-06 与 AC-EDGE-08 要求此类越界请求返回不可区分的 `SHARE_UNAVAILABLE`。当前实现虽未泄露目标存在性，仍改变了调用方可观察的授权失败语义。修复应在服务层统一抛出 `SHARE_UNAVAILABLE`（未知、外部及非法 id 保持同形响应且不查询目标），并把 API 测试改为验证失败 envelope 与不可区分性。`mail-worker/src/service/share-mail-service.js:158-168,193-211`; `mail-worker/test/share-api.spec.js:571-595`; `docs/specs/mailbox-share-capability/requirements.md:126,215`

## P2

无。

## 独立核验

- `GET /share/mails` 缺省或空 `bindingId` 仍走合并 `list`；有值时走 `listForBinding`，字符串 `"0"` 不被当成缺省。`mail-worker/src/api/share-api.js:65-77`
- `listForBinding` 先按当前 ShareContext 收窄 Binding；正整数走 repository 的 `listForBinding`，遗留 `bindingId=0` 用已收窄 context 走同范围的 `list`。`mail-worker/src/service/share-mail-service.js:158-168,193-211`
- request 层只有一个 `shareHttp`；`listShareMails` 通过 `listParams` 可选传 `bindingId`（保留 0），`getShareMailboxesStatus` 复用同一实例。`mail-vue/src/request/share.js:1-5,112-126,158-170`
- 成功的 `pollTick` 顺序为一次 status 后一次当前 Binding mails，忽略 composable 传入的 cursor；没有按 Binding fan-out，也没有用 `!hasNew` 跳过 mails。`mail-vue/src/views/share/index.vue:284-301`
- 单邮箱也由 `mailboxes[0].bindingId` 设置 active Binding，`0` 可用；active 为 null 时仍调用 mails 并由 request 层省略参数，没有返回本地空列表短路。`mail-vue/src/views/share/index.vue:356-370,292-301`
- 水位按 `share:status:<lid>` 分 lid 存储；首帧/新增 Binding 以 status head 建基准，删除 Binding 丢键，推进单调且按实际 mailId。`mail-vue/src/views/share/status-watermark.js:1-13,32-60,70-107`
- 原生 Tab 使用 `tablist` / `tab`、roving tabindex、方向键与非纯颜色选中态；`ShareOtpCard` props 仍仅有 `mails` / `selected` / `enabled`。`mail-vue/src/views/share/index.vue:30-75,412-425,753-797`; `mail-vue/src/views/share/ShareOtpCard.vue:44-57`
- `417ebf9..2e6754d` 只有一个提交。负面清单中的 `useSharePolling.js`、visitor guard、`init.js` 正则、`session.js`、i18n、`ShareOtpCard.vue`、`assert-share-chunk.js` 均无提交差异；`SHARE_CAPABILITY_V2` 测试配置仍为 `"false"`，生产配置仍缺省即 false。`mail-worker/wrangler-vitest.toml:41`; `mail-worker/wrangler.toml:58`
- `index.spec.js` 旧 22 个 `it()` 正文的 diff 仅涉及许可的 hoisted/setup status mock 与 AC-VISIT-10 文件循环扩展；新增 10 条后为 32 条。`useSharePolling.spec.js` 仅新增 1 条后为 7 条。
- `git diff --check 417ebf9..2e6754d` 通过。

## 运行证据

- `pnpm --dir mail-vue exec vitest run --no-cache src/views/share/status-watermark.spec.js src/views/share/index.spec.js src/composables/useSharePolling.spec.js src/request/share.spec.js src/views/share/share-chunk.spec.js` → EXIT=0，5 个文件 / 65 条测试通过。
- `pnpm --dir mail-worker exec vitest run --no-cache test/share-api.spec.js test/share-mail-service.spec.js` → EXIT=0，2 个文件 / 38 条测试通过。
- 现有绿测未覆盖 P1-1 的“切 Tab 后立即切走”、P1-2 的“已有 token 恢复 multi 配置”、P1-3 的整页明文断言；P1-4 的现有测试则固定了与 requirements 相反的成功空页行为。

## Update Log

- 2026-08-24 · 主 AI 过筛：P1-1 CHANGE（design.md:348/401 + AC-OTP-09：拉取即消费）；P1-2 CHANGE（`isMulti` 误依赖 session `shareType`，复活后 Tab 永不出现）；P1-3 CHANGE（multi 页不得展示遗留明文 `mailbox`）；P1-4 HOLD（列表越界返回同形 `[]` 才不泄露存在性；改 `SHARE_UNAVAILABLE` 会让 AC-EDGE-04 删箱竞态整页判死）。
