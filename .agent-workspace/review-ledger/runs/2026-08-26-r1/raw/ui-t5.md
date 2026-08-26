# T5 · Owner 侧过期状态五面视觉验收

## Findings

### UI-T5-F1

- severity: P1
- anchor: `mail-vue/src/views/share-admin/index.vue:48`
- symbols: `status`, `rows`, `liveStatus`, `fetchList`
- rule_source: `docs/specs/mail-share/requirements.md:116` 的 AC-LIFE-08 要求停页跨过失效时刻即翻为 `EXPIRED`；本轮 `themes.md` T5 review_focus 6 明确要求核对 ACTIVE 筛选与本地翻转的冲突。
- identity_scope: `share-admin` 状态筛选的结果集合与卡片实时状态投影
- failure_mode: 筛选值只在请求时作为服务端 `query.status` 生效，返回行则在本地时钟上单独翻成 `EXPIRED`；因此筛选器仍显示“有效”，卡片却显示“已过期”，`total`、分页和空态也仍沿用旧 ACTIVE 结果集。
- trigger: Owner 选择“有效”筛选后停留在页面，当前页任一 ACTIVE 分享跨过 `expiresAt`，且期间没有 focus、visibility 或手动刷新触发回源。
- impact: 页面同时给出“只看有效”与“这条已过期”两个互斥信息；最后一条有效分享过期时也不会进入空态，Owner 无法信任筛选结果。
- required_fix: 让筛选成员资格与卡片展示共同消费实时 effectiveStatus，并同时收口 `total`、分页与空态；可在下一到期边界重取当前筛选，也可做客户端投影，但不能只替换状态标签。
- verify: `unverified: 已执行五面现有 Vitest，5 files / 124 tests / EXIT=0；index.spec.js 只覆盖“无筛选时过期标签翻转”和 REVOKED 参数转发，没有 ACTIVE 筛选内跨时刻翻转、最后一行空态或分页总数用例。`
- risk_spread: none

### UI-T5-F2

- severity: P2
- anchor: `mail-vue/src/views/email/ShareDialog.vue:84`
- symbols: `statusLabel`, `liveStatus`, `.share-row-meta`, `share-status`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:123` 的五面接线契约明确要求 ShareDialog “展示 tag”；同卡 `:13` 的成功状态要求 Owner 一眼看到“已过期”。
- identity_scope: 邮箱快捷分享对话框的生命周期状态视觉语义
- failure_mode: 对话框把状态渲染为与邮箱、创建时间、失效时间同层同色的普通文本；`data-status` 没有任何对应样式，未形成管理列表与详情抽屉已有的状态徽章。
- trigger: 对话框打开期间一行从 ACTIVE 翻成 EXPIRED，或打开时列表中已存在多条不同状态记录。
- impact: 状态变化只表现为密集元数据中的几个字替换，扫视时不易发现，也使五个 Owner 面对同一 EXPIRED 状态呈现不一致。
- required_fix: 收口一个由 `statusMeta` 驱动的 Owner 状态徽章/视觉 token，并由快捷对话框、管理卡片和详情抽屉共用；不要只给当前文本临时加颜色。
- verify: `unverified: ShareDialog.spec.js 仅断言 data-status 与文本，现有 124 项用例全绿；没有浏览器视觉断言能验证状态徽章层级。`
- risk_spread: none

### UI-T5-F3

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:32`
- symbols: `writable`, `liveStatus`, `shareDetailReadonly`, `link-reveal`, `canRevoke`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:128` 明确要求 EXPIRED 仍可 revoke；`docs/specs/mail-share/requirements.md:109` 的 AC-LIFE-02 保留 Owner 主动销毁语义。
- identity_scope: 详情抽屉中 EXPIRED 与 REVOKED 的动作可用性说明
- failure_mode: EXPIRED 与 REVOKED 共用“已不可修改……仅供查阅”文案，抽屉内没有销毁动作；与此同时 EXPIRED 在列表行和快捷对话框仍显示“销毁”，抽屉自己的“查看链接”也保持可用。
- trigger: 分享在抽屉打开期间过期，或 Owner 从一张 EXPIRED 卡片进入详情。
- impact: 同一条 EXPIRED 分享在不同面给出相反动作暗示，Owner 会误以为过期后不能再正式销毁，只能关闭抽屉回到列表试探按钮。
- required_fix: 将“配置不可编辑”与“生命周期动作仍可用”拆开表达；EXPIRED 详情应明确保留销毁入口或清晰引导，REVOKED 才呈现终态只读，避免两态共用一条笼统提示。
- verify: `cd /tmp/review-share-fullchain/mail-vue && pnpm exec vitest run src/views/share-admin/ShareDetailDrawer.spec.js src/views/share-admin/ShareRowActions.spec.js --reporter=dot`，当前预期 EXIT=0；现有断言分别固定了“抽屉 EXPIRED 只读”和“行操作 EXPIRED 可销毁”，但没有跨面一致性断言。
- risk_spread: none

## 已查证且无 finding

- 收件箱徽章按实时状态只计当前邮箱 ACTIVE 数量，停页跨过到期点会从 1 归零，符合 AC-MGMT-04：`mail-vue/src/views/email/ShareIndicator.vue:40-44`、`mail-vue/src/views/email/ShareIndicator.spec.js:122-142`。
- 管理卡片与详情抽屉的状态标签均消费 `liveStatus`；EXPIRED 在列表保留供审计，未被误做物理消失：`mail-vue/src/views/share-admin/index.vue:42-56`、`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:20-28`。
- 快捷对话框和行操作都保留 EXPIRED 的“销毁”入口，并只对 REVOKED 隐藏，动作语义本身一致：`mail-vue/src/views/email/ShareDialog.vue:95-101`、`mail-vue/src/views/share-admin/ShareRowActions.vue:63-67`。
- 无筛选时，最后一条分享从 ACTIVE 翻成 EXPIRED 后继续留在列表而不进入“还没有分享”空态，符合 AC-ADMIN-09 的审计留存；问题仅出在 ACTIVE 筛选集合未同步。
- 实跑：`pnpm exec vitest run src/views/email/ShareIndicator.spec.js src/views/email/ShareDialog.spec.js src/views/share-admin/index.spec.js src/views/share-admin/ShareDetailDrawer.spec.js src/views/share-admin/ShareRowActions.spec.js --reporter=dot` → EXIT=0，5 files / 124 tests passed。
