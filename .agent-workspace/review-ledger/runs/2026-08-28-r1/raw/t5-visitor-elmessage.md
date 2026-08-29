# T5 · 访客页三处提示移除 Element Plus toast

结论：NEEDS_CHANGES（新增 P1 × 1、P2 × 2；persists P2 × 2）

## Findings

### T5-F1 · 三个 `status` 都与文案同时挂载，不能兑现首次及重复播报

- severity: P1
- anchor: `mail-vue/src/views/share/index.vue:130`
- symbols: `newMailNotice`, `newMailArrival`, `copyAllResult`, `copyAllAttempt`, `copyResult`, `copyAttempt`
- rule_source: W3C WCAG 2.2 Technique ARIA22 的测试步骤 1 要求“用于承载 status message 的容器在消息发生前已经具有 `role=status`”；同页步骤 2 才是在消息触发时把消息放入该容器。`themes.md:168,176-177` 又把“第一次和同一句重复发生时都能播报”定为本提交保留旧 toast 行为的成功条件。
- identity_scope: 访客页复制验证码、复制全文和当前邮箱新邮件到达三类状态消息的辅助技术播报生命周期
- failure_mode: 三处都把 `v-if` 和 `role="status"` 放在同一个消息节点上，首次消息发生前 DOM 中没有 live-region 容器；消息发生时角色与已填充文案一起插入。重复消息又通过变化的 `:key` 销毁旧容器并用已填充文案创建新容器，而不是更新一个事先存在的 live region。实跑 Vue 3 DOM 探针得到 `initiallyAbsent=true`、首次节点直接带 `Copied`、第二次 `repeatSameNode=false` 且旧节点已移除，精确复现了三处模板的时序；这不满足 ARIA22 的“容器先存在、消息后发生”程序。
- trigger: 使用不会把新挂载 `role=status` 节点的初始内容当成 live-region 变更的浏览器/读屏组合时，访客首次复制、再次复制，或收到新邮件。
- impact: 读屏访客在核心收码任务中听不到复制成功/手动复制提示，也听不到新邮件到达；本提交用页内区域保持旧 `ElMessage` 播报能力的主要可访问性目标失效，三处共用同一缺陷。
- required_fix: 在拥有这些消息的页面/卡片责任层预先挂载稳定、空的 `role="status"` 容器（并按 ARIA22 建议显式设 `aria-atomic="true"`），事件发生时只更新其内容；同一句需要重播时先清空内容，等待一次可观察的 DOM 更新后再写入，而不是给 live-region 容器换 key 或用 `v-if` 重建。
- verify: 用真实浏览器 + 至少一组目标读屏对三条路径各验“第一次”和“同句第二次”；同时增加 DOM 生命周期回归，断言动作前 status 容器已存在、动作后仍是同一个容器节点且内容发生更新。现有 `ShareOtpCard.spec.js:183-197` 与 `index.spec.js:1723-1747` 只比较 attempt 属性，不能证明辅助技术收到播报。
- risk_spread: none

### T5-F2 · 构建后的 share 路由依赖闭包仍含 Element Plus

- severity: P2
- anchor: `mail-vue/src/components/safe-mail/index.vue:5`
- symbols: `SafeMailRenderer`, `ElButton`, `ElAlert`, `ElementPlusResolver`, `assertShareChunkIsolation`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:45` 禁止访客页使用 Element Plus；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:203,266` 把“不引入 Element Plus 到 share chunk”列为包体积与鉴权隔离硬约束和必做验收。
- identity_scope: `/s/:lid` 异步路由的生产构建依赖闭包
- failure_mode: `index.vue:252` 仍直接导入 `SafeMailRenderer`，后者模板第 5、11 行使用 `el-button`，第 25、33 行使用 `el-alert`，并被全局 `ElementPlusResolver` 解析。release 构建的 share 根 chunk 为 `index-BHKpjQXE.js`；沿其相对 import 实跑闭包追踪得到 8 个 JS chunk，其中命中 Element Plus 的有 `el-button-BEnL_rT1.js`、实现 `ElAlert` 的 `index-CVrZKXm8.js`，以及承载 Element Plus 共享代码的 `index-C1XgeGo-.js`。因此删掉三处 `ElMessage` 没有把 Element Plus 从 share chunk 依赖图移除。
- trigger: 任意访客导航到 `/s/:lid` 并加载 share 异步路由。
- impact: 每个访客仍加载设计卡禁止的 Element Plus 按钮/告警实现及关联样式，提交标题和硬约束声称的匿名 chunk 去依赖未完成；现有构建闸门还会继续把这一状态判绿。
- required_fix: 在 `SafeMailRenderer` 这个最早的共享责任层拆出不依赖 UI 框架的渲染核心，并让匿名 share 消费原生按钮/状态提示外壳；不要只改 chunk 名或手工分包来掩盖依赖。随后把 Element Plus 特征加入 `assert-share-chunk.js:10-15` 的 `FORBIDDEN`，使真实构建闭包成为回归闸门。
- verify: `pnpm -C mail-vue build` 后从含 `cloud-mail-share-shell` 的 route chunk 递归遍历静态 import，断言闭包中无 `el-*` chunk、`ElButton`/`ElAlert` 实现和 Element Plus 组件源码特征；当前同样探针输出 `elementPlusFiles=["index-C1XgeGo-.js","index-CVrZKXm8.js","el-button-BEnL_rT1.js"]`。现有 `share-chunk.spec.js` 虽通过，但 `assert-share-chunk.js:10-15` 的禁用表没有 Element Plus 规则。
- risk_spread: `element-plus-in-share-chunk` · origin `views/share/index.vue` 的 `SafeMailRenderer` import → hop 1 `components/safe-mail/index.vue` 的 `el-button` / `el-alert` → hop 2 `vite.config.js` 的 `ElementPlusResolver` 与构建产物闭包；已取得产物层“仍包含”结论并命中 stop_when，未进入允许使用 Element Plus 的 `views/share-admin/`。

### T5-F3 · 新邮件横幅在多邮箱 Tab 切换后继续显示为新 Tab 的消息

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:640`
- symbols: `selectTab`, `setActiveBinding`, `announceNewMail`, `clearNewMailNotice`, `newMailNoticeTimer`
- rule_source: `themes.md:168,179` 要求新邮件提示的定时器在切邮箱时清理，并明确要求枚举多邮箱 Tab 切换出口；`index.vue:143-149` 对复制确认已经声明消息必须归属当前 Binding，同一上下文归属约束也适用于位于 tabpanel 上方的新邮件横幅。
- identity_scope: 当前 Binding 的新邮件提示与多邮箱 Tab 选择状态的一致性
- failure_mode: `announceNewMail()` 创建的是没有 Binding 身份的全局 `newMailNotice`；`selectTab()` 在第 640-670 行切换 `activeBinding`、取数并重新武装通知，却从未调用 `clearNewMailNotice()`。因此旧 Tab 到件后的横幅会在新 Tab 已选中后继续保留到原 6 秒计时器到期。现有清理只覆盖 `exitShare`、`resetMailbox`（换 lid/bootstrap）和 `onUnmounted`，不覆盖页内邮箱 Tab。
- trigger: 当前 Tab 收到新邮件并显示横幅后的 6 秒内，访客点击另一个邮箱 Tab或使用左右方向键切换。
- impact: 横幅位于当前 tabpanel 上方且文案只有“收到新邮件”，切换后会被视觉归因于新选中的邮箱，访客会在错误邮箱里寻找刚到邮件；计时器也与其原 Binding 的生命周期脱钩。
- required_fix: 在唯一的 active Binding 状态迁移层 `setActiveBinding()` 中，只要 Binding 发生变化就同步清除当前提示和计时器；这样用户点击、键盘切换及 status 帧导致的自动回退都共用同一清理，不要只在 `selectTab()` 的某个取数分支补丁式清理。
- verify: 新增多邮箱 fake-timer 用例：在 Binding A 触发 `[data-share-new-mail]`，计时器到期前点击及键盘切到 B，断言横幅立即消失、推进时间不再影响 B；再在 B 到件，断言只出现 B 的新提示。当前 `index.spec.js:1649-1695` 只在单邮箱内验证替换与超时。
- risk_spread: none

## 历史 finding 回归

### persists: F-0027

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1220`
- symbols: `.share-top`, `.share-card`, `.share-expires`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:31` 的 390px 移动布局要求；历史 F-0027 已记录 header 横向溢出约 8px。
- identity_scope: 390px 访客页 header 横向溢出
- failure_mode: header 仍为不换行的 flex 行，提交 `083c87f` 只新增 `.share-new-mail` 样式，没有修改 `.share-top`、卡片 padding 或倒计时/离开按钮的窄屏布局。
- trigger: 390px 窄屏打开带倒计时和离开按钮的 ready 访客页。
- impact: header 继续超出可用宽度并产生横向溢出。
- required_fix: 在访客页 header 布局责任层允许窄屏换行或收紧其 padding/gap，并用 390px 真实视口确认无横向溢出。
- verify: 对比 `083c87f^..083c87f` 的 scoped CSS，`.share-top` 第 1220-1225 行及相关移动规则未变；按历史身份标记 persists，不作为新 finding。
- risk_spread: none

### persists: F-0029

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1205`
- symbols: `.share-shell[data-share-state]`, `.share-card`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:39` 要求 unavailable / timedout / exited 为居中终态卡；历史 F-0029 已记录当前只做水平文字居中。
- identity_scope: 访客页终态卡的视口垂直居中
- failure_mode: 三种终态规则仍只有 `max-width: 480px` 与 `text-align: center`，`.share-shell` 没有按终态建立 flex/grid 垂直居中；`083c87f` 未改这组规则。
- trigger: 访客进入 unavailable、timedout 或 exited 终态。
- impact: 终态卡继续停在页面顶部区域而非视口垂直居中。
- required_fix: 在终态 shell 布局责任层建立覆盖可用视口高度的 flex/grid 居中，并保留移动安全边距。
- verify: `index.vue:1205-1217` 当前仍与父提交一致；按历史身份标记 persists，不作为新 finding。
- risk_spread: none

## 已查证且无 finding

- `v-if + :key` 的 Vue 3 节点身份机制本身成立：实跑与提交同形的组件，第二次相同文案时 `repeatSameNode=false`、旧节点 `isConnected=false`。问题不是 Vue 复用了节点，而是 live-region 容器也被一起销毁重建，见 T5-F1。
- 连续到件不会叠加横幅：`announceNewMail()` 先清旧 timer，再递增 key，并立即重设 6000ms timer；页面始终只有一个提示。6000ms 正好是 `POLL_INTERVAL_MS=3000` 的两个轮询间隔，注释“长于一个轮询间隔”成立。
- 换 lid 会先经 `bootstrap()` → `resetMailbox()` 清理，显式退出和组件卸载也分别清理；gone 路径立即 reload 或清空 document，不形成跨 lid 可见横幅。缺口限于 T5-F3 的页内 Tab 切换。
- 中英文 `shareVisitCopied`、`shareVisitCopiedAll`、`shareVisitNewMailToast` 文案在横幅/状态行形态下仍表达成立；旧 `Toast` 键名只属维护命名，不形成可复现故障。
- 实跑 `pnpm -C mail-vue test -- src/views/share/ShareOtpCard.spec.js src/views/share/index.spec.js`：26 files / 378 tests 全绿；release 构建成功（2328 modules transformed）。测试全绿不覆盖 T5-F1 的真实辅助技术播报，也因 `assert-share-chunk.js` 未禁 Element Plus 而漏掉 T5-F2。
- 未修改业务代码，未执行 commit/push。
