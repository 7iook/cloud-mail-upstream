# T5 Findings

## Finding 1

- severity: P2
- anchor: `mail-vue/src/views/share-admin/ShareRowActions.vue:61`
- symbols: `ShareRowActions`, `useShareClock`, `liveStatus`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:117-126` 要求一个轻量共享 tick，并允许行操作继承父时钟；`mail-vue/src/views/share-admin/index.vue:43-44,81,140-142` 可复现一页最多 20 个行组件且父页面已有时钟。
- identity_scope: Owner 分享管理列表的展示时钟实例模型。
- failure_mode: 每个 `ShareRowActions` 实例都独立创建 1 秒 interval 及 focus/visibility 监听，而不是消费列表页已有的时钟。
- trigger: 一页渲染满 20 条分享时，20 个行组件、列表页和常驻的详情抽屉同时挂载。
- impact: 实测 20 个同构时钟实例产生 20 个 interval、20 个 focus listener、20 个 visibility listener；完整列表树为 22 个 interval，并在每秒触发 22 份响应式更新时间工作。
- required_fix: 将时钟所有权提升为页面级单一实例并把 `nowMs`/`liveStatus` 传给行操作与详情，保证列表行数增长不增加 heartbeat 或全局监听数。
- verify: `node -e "const fs=require('fs');const p=fs.readFileSync('mail-vue/src/views/share-admin/index.vue','utf8');const r=fs.readFileSync('mail-vue/src/views/share-admin/ShareRowActions.vue','utf8');process.exit(/const size = 20/.test(p)&&/<ShareRowActions/.test(p)&&/useShareClock\(\)/.test(r)?0:1)"`，当前期望退出码 `0`（确认 N 行各自持钟的触发结构）；修复后的资源计数回归应以 20 行仍只有 1 个页面时钟为退出码 `0`。
- risk_spread: none

## Finding 2

- severity: P2
- anchor: `mail-vue/src/views/email/ShareIndicator.vue:69`
- symbols: `ShareIndicator.refresh`, `onVisible`, `onMounted`, `onActivated`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:116-117` 要求 keep-alive 下的回源监听在 deactivate/unmount 对称清理；`mail-vue/src/layout/main/index.vue:5-8` 明确缓存 `email`。
- identity_scope: keep-alive 收件箱内分享徽章的回源订阅生命周期。
- failure_mode: `ShareIndicator` 自建的 focus/visibility 监听只在 `onUnmounted` 移除，email 被 keep-alive deactivate 时仍会继续调用无参 `listMailShares()`；同时子组件与 `views/email/index.vue` 都在 activation 调 `refresh`。
- trigger: Owner 离开收件箱但保留缓存后切回浏览器标签，或再次激活收件箱。
- impact: 已隐藏的收件箱仍发起最多扫描 500 行的 Owner list 请求，重新激活时父子双重回源；`refresh` 无请求代际保护，重叠响应可让较旧快照后到并覆盖较新快照。
- required_fix: 为收件箱回源建立唯一生命周期所有者，在 deactivate 时注销全局监听、activate 时只注册并刷新一次，并让并发刷新只接受最新响应。
- verify: `node -e "const fs=require('fs');const s=fs.readFileSync('mail-vue/src/views/email/ShareIndicator.vue','utf8');process.exit(/onDeactivated/.test(s)?0:1)"`，当前期望退出码 `1`；补齐 deactivate 对称生命周期后期望退出码 `0`。
- risk_spread: none

## Finding 3

- severity: P2
- anchor: `mail-vue/src/views/share-admin/index.vue:48`
- symbols: `liveStatus`, `fetchList`, `status`, `onStatusChange`
- rule_source: `mail-worker/src/service/mail-share-service.js:2196-2217` 定义 `status` 为服务端结果集谓词，`mail-vue/src/views/share-admin/index.spec.js:266-281` 固定筛选值会作为 `query.status` 发送。
- identity_scope: Owner 分享管理列表的状态筛选结果集不变量。
- failure_mode: 卡片状态随本地时钟从 ACTIVE 翻为 EXPIRED，但 `rows` 仍是上次服务端按 ACTIVE 选出的快照，tick 不会重新应用筛选或回源。
- trigger: Owner 选择 ACTIVE 筛选后停留在页面，任一结果行跨过 `expiresAt`，且未发生 focus、visibility、手动刷新或翻页。
- impact: 「ACTIVE」筛选结果中会无限期保留并展示 EXPIRED 卡片，`total` 与分页也继续计算这条已不满足筛选条件的记录。
- required_fix: 让筛选集合与 `liveEffectiveStatus` 共用同一状态真源，并在行跨越当前筛选边界时原子地重算结果集与总数或触发一次受控回源。
- verify: `node --input-type=module -e "import {liveEffectiveStatus} from './mail-vue/src/views/share-admin/status.js';const selected='ACTIVE';const rows=[{status:'ACTIVE',effectiveStatus:'ACTIVE',expiresAt:'2026-08-26 19:33:01'}];const shown=rows.map(r=>liveEffectiveStatus(r,Date.parse('2026-08-26T19:33:02Z')));process.exit(shown.every(s=>s===selected)?0:1)"`，当前期望退出码 `1`；筛选边界回归用例闭合后期望退出码 `0`。
- risk_spread: none
