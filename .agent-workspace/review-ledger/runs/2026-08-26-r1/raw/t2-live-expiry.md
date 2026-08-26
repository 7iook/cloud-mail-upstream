# T2 · Owner 侧过期状态实时翻转 · 独立审查

审查对象：`b36581046fcf40d6d2476facfed78f05f3115d93`（代码只读自 `/tmp/share-review`，HEAD `9b6eb80`）

结论：4 条 finding（3 medium，1 low）。

## Finding 1

- severity: medium
- anchor: `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:468-470,602-604,930-932,1009-1011,1067-1070`；对照服务端 `mail-worker/src/service/mail-share-service.js:1515-1527,1582-1591,1650-1658`
- symbols: `ShareDetailDrawer.writable`、`liveStatus`、`isMutableStatus`、`submitSave`、`submitAuthKey`、`submitRegenerate`、`loadMutableShare`、`prepareUpdate`、`prepareRegenerateUpdate`
- rule_source: `docs/specs/mail-share/requirements.md:108,111-116`（AC-LIFE-01/04/08/11，尤其 AC-LIFE-08“仅展示层”“鉴权与写入仍以服务端为准、前端结果不得回写”）；`docs/specs/mail-share/design.md:297-306,743-754`（P1 只修 Owner live 展示）
- identity_scope: 持有 `share:manage` 的 Owner，操作本人、服务端仍判为 ACTIVE 的分享
- failure_mode: `writable` 把浏览器本地时钟算出的 `liveStatus(detail)` 当成了所有配置、Binding、AuthKey、regenerate 的前置闸门。服务端真正的写谓词用 Worker 当前时间检查 `status='ACTIVE' AND expires_at > nowText()`；两者时钟不是同一权威。客户端时钟快于服务端时，展示层先翻 EXPIRED，前端在发请求前即静默拦截，而此时服务端本来仍会接受写入。
- trigger: Owner 设备时钟快于服务端，且本地 `Date.now() >= expiresAt`、Worker 当前时间仍 `< expires_at`；或设备时钟被手工/系统同步向前拨动后打开详情抽屉
- impact: 合法的延期、改配置、增删 Binding、AuthKey 操作和 regenerate 都不可点击/不会发请求；Owner 无法在服务端有效期内续期。没有越权写入风险，但违反“live 状态只管展示”的边界，并把客户端时钟变成了第二个写权限真源。
- required_fix: 将视觉状态与写入资格拆开。徽章/文案继续用 `liveStatus(detail)`；写按钮不要由客户端推导的 EXPIRED 拦截，应以服务端快照仅作提示并让请求到达服务端，由 `loadMutableShare`/条件 UPDATE 作最终判定。服务端若已过期，前端按 `SHARE_NOT_FOUND` 刷新详情并转只读。
- verify: 冻结 Worker/接口样本为 `effectiveStatus='ACTIVE'`、`expiresAt` 尚在服务端未来，再把浏览器 fake clock 调到 `expiresAt` 之后；断言详情显示 EXPIRED，但保存/Binding/AuthKey/regenerate 仍能发请求。另测服务端返回 `SHARE_NOT_FOUND` 后详情转只读且无写入。

## Finding 2

- severity: low
- anchor: `mail-vue/src/views/share-admin/use-share-clock.js:7-10,21-48`；消费点 `mail-vue/src/views/share-admin/index.vue:41-86,140-142`、`ShareRowActions.vue:58-67`、`ShareDetailDrawer.vue:468-470`；默认页长 `share-admin/index.vue:139-142`
- symbols: `useShareClock`、`start`、`stop`、`ShareRowActions`、`ShareDetailDrawer`、`ShareAdmin`
- rule_source: `docs/specs/mail-share/requirements.md:116`（AC-LIFE-08 明确“共享时钟”）；T2 intent 的“展示层 SSOT liveEffectiveStatus + 1s 时钟”
- identity_scope: 打开分享管理页的 Owner；行数为当前页 N（默认最多 20）
- failure_mode: `useShareClock()` 每次调用都新建一个 `ref`、一个 1 秒 interval、一个 `focus` 监听和一个 `visibilitychange` 监听，并非共享时钟。默认 20 行时，页面自身 1 个实例、20 个 `ShareRowActions`、始终挂载的 `ShareDetailDrawer` 共 22 个 interval 和 44 个窗口/文档监听。翻页/卸载会走 `stop`，未发现旧实例永久残留；问题是同屏资源按行线性放大。
- trigger: 分享管理页当前页渲染 20 条记录；每秒 tick，或窗口 focus/visibilitychange
- impact: 同一时刻被重复采样和广播 22 次，并触发每行独立的响应式重算；后续若页长提高，成本继续线性增长。它也使“共享时钟”契约名实不符。
- required_fix: 把 `nowMs` 做成页面级 `provide/inject` 或带引用计数的模块级单例；管理页只保留一个 timer/两类监听，并把 `liveStatus` 或 `nowMs` 传给行操作与抽屉。
- verify: 挂载含 20 行的真实管理页，spy `setInterval`/`addEventListener`，断言只创建 1 个 interval 和各 1 个 focus/visibility 监听；翻页不增加数量，离开页面后归零。

## Finding 3

- severity: medium
- anchor: `mail-vue/src/views/email/ShareIndicator.vue:47-85`；`mail-vue/src/views/email/index.vue:65-72`；keep-alive 事实 `mail-vue/src/layout/main/index.vue:5-8`；对照已有 latest-only 做法 `mail-vue/src/views/share-admin/index.vue:154-195`
- symbols: `ShareIndicator.refresh`、`onVisible`、`onMounted`、`onActivated`、`email/index.vue:onActivated`、`reqSeq`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-expired-status-rca.md:33-36,42-47`（回到页面/聚焦时刷新，但后台冻结只需在恢复点同步）；T2 review_focus 5
- identity_scope: 有 `share:manage` 的 Owner，邮箱页被 layout keep-alive 缓存
- failure_mode: 同一个刷新被三个未协调入口触发：`ShareIndicator.onActivated` 与父级 `email/index.vue.onActivated` 在每次恢复时各调一次；浏览器从后台恢复通常又依次触发 `visibilitychange` 与 `focus`。`refresh()` 没有 in-flight 合并或序号保护，较早请求可在较新请求之后返回并覆盖 `shares`。此外 focus/visibility 监听只在 `onUnmounted` 移除，而 keep-alive 离开邮箱页只触发 deactivation，所以 Owner 已在别的页面时仍会后台拉取分享列表。
- trigger: 从其它路由回到邮箱页；标签页由 hidden 恢复并获得焦点；或一次旧 refresh 尚未返回时发生 create/revoke 并触发新的 refresh
- impact: 一次恢复可并发发出 2 个以上列表请求；离开邮箱页后仍有无关后台请求。若旧响应最后落地，可把刚创建/撤销后的新列表覆盖回旧快照，徽章重新显示错误计数或旧 ACTIVE 状态，直到下一次刷新。
- required_fix: 只保留一个生命周期 owner（父或子之一）；在 `onDeactivated` 停止 refresh 监听、`onActivated` 恢复；对 `refresh()` 加 latest-only 序号（同管理页 `reqSeq`）或合并同一 in-flight 请求，并把 visibility/focus 的同轮恢复去抖/合并。
- verify: 用真实 `email` 父组件 + KeepAlive 测试：首次/再次 activated 各只发 1 次；deactivated 后触发 focus/visibility 不发请求；构造 deferred A、B，让 B 先返回新状态、A 后返回旧状态，断言最终仍保留 B。

## Finding 4

- severity: medium
- anchor: `mail-vue/src/views/email/ShareIndicator.vue:40-45,53-60`；`mail-vue/src/request/mail-share.js:83-87`；`mail-worker/src/service/mail-share-service.js:26-31,1543-1562,2196-2233`；硬上限已有可复算测试 `mail-worker/test/mail-share-service.spec.js:3197-3208`
- symbols: `activeCount`、`ShareIndicator.refresh`、`listMailShares`、`normalizeListPaging`、`mailShareService.list`、`LIST_DEPRECATED_CAP`
- rule_source: `docs/specs/mail-share/requirements.md:281-285`（AC-MGMT-04：当前邮箱所有 `effectiveStatus=ACTIVE` 分享数量）；T2 review_focus 6
- identity_scope: Owner 的保留期内记录总数超过 500，且当前邮箱至少一条 ACTIVE 分享不在最新 500 条内
- failure_mode: Indicator 无参调用 `listMailShares()`，后端明确走 deprecated 全量转储分支，但该“全量”按 `share_id DESC` 只返回最新 500 条；响应的 `total` 虽是真实总数，Indicator 完全忽略它并只过滤 `data.list`。因此徽章统计的是“最新 500 条中的当前邮箱 ACTIVE 数”，不是全部 ACTIVE 数。
- trigger: Owner 有至少 501 条尚未物理清理的分享记录；较老的当前邮箱 ACTIVE 分享被 500 条较新的记录（可来自其它邮箱、EXPIRED 或 REVOKED）挤出返回集
- impact: 徽章稳定少计，最坏显示 0 但该邮箱仍有有效分享；1 秒本地时钟无法修复根本没取回的行。当前默认 `SHARE_ACTIVE_LIMIT` 实际为 `1_000_000_000`，不能以活跃上限证明 500 条场景不可达（`mail-share-service.js:15,301-306`）。
- required_fix: 不再用 deprecated list dump 做聚合。由 Owner API 按 `user_id + account_id + effectiveStatus=ACTIVE` 返回服务端 count，或给 list 增加 account/status 聚合查询；前端只消费该总数。不要靠循环拉取全部审计记录来数徽章。
- verify: 集成测试先造 1 条较老的当前邮箱 ACTIVE 分享，再造 500 条较新的其它邮箱/EXPIRED/REVOKED 记录；断言 Indicator count 仍为 1。再覆盖该分享跨过 `expiresAt` 后 count 实时从 1 变 0。

## 其余 review_focus 查证锚点

- expiresAt wire format 未形成 finding：创建路径固定写 `YYYY-MM-DD HH:mm:ss`（`mail-share-service.js:48-54,1204-1207`），续期输入规范化后仍落同一形态（`:1392-1410`），list/get 直接投影该非空 TEXT 列（`:446-510`；`init/init.js:187-203`）；展示 `tzText` 与判定 `expiresAtUtcMs` 都把裸串按 UTC 解释（`mail-vue/src/utils/day.js:83-93`；`share-admin/status.js:24-47`）。
- revoke 谓词未形成 finding：前端 EXPIRED 仍保留 revoke，服务端只要求持久化 `status='ACTIVE'`（`ShareRowActions.vue:63-67`；`mail-share-service.js:514-522`），口径一致。
- SSR/非浏览器路径未形成 finding：入口为 Vite SPA 的 `createApp(...).mount('#app')`（`mail-vue/src/main.js:1-18`），无 SSR 渲染入口；`useShareClock.start()` 中直接使用 `window/document` 在当前仓库形态可接受。
- interval 清理本身未形成永久泄漏 finding：`useShareClock.stop()` 同时挂到 `onDeactivated` 与 `onUnmounted`（`use-share-clock.js:33-48`），v-for 行卸载会清 timer/监听；Finding 2 针对的是同屏实例倍增。
