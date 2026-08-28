# UI-T5 · 访客页页内状态与新邮件横幅

## 1. Lens

- 角色：UI/UX，只审视觉、信息层级与状态呈现。
- 对象：`mail-vue/src/views/share/ShareOtpCard.vue`、`mail-vue/src/views/share/index.vue` 的页内 `role="status"`、新邮件横幅及相关空态/终态。

## 2. Range

- 审查提交：`083c87f`
- 审查区间：`9b6eb8072fe73c93518e872037702a2e8e54056b..083c87f2d2ccc8c459adfd45fc31a43afc63256f`
- 不审：构建产物 share chunk 依赖图；`:key` 是否触发读屏重复播报等代码正确性。

## 3. Rule sources

- `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:7-12,31,33-48`
- `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:145-147,198-206,263-267`
- `.agent-workspace/review-ledger/runs/2026-08-28-r1/reviewer-l0-l1.md:3-12,50-56`
- `.agent-workspace/review-ledger/runs/2026-08-28-r1/themes.md:163-187`

## 4. Conclusion

`NEEDS_CHANGES`：无新增 finding；两条既有 P2 在当前状态仍可复现（`F-0027`、`F-0029`）。新邮件横幅和三处页内状态文案没有遮挡 OTP，主任务仍保持最高视觉层级。

## 5. Findings

### persists: F-0027

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1220`
- symbols: `.share-top`, `.share-expires`, `.share-shell`, `[data-share-exit]`
- rule_source: `visitor-share-ui-design.md:31` 要求移动端全宽且触控目标 ≥44px；`reviewer-l0-l1.md:51,55` 将该 identity 明确列为 T5 的 open carryover。
- identity_scope: 访客 ready 页首栏在 390px 视口内的宽度约束与动作可见性。
- failure_mode: 页首仍是不可换行的单行 flex。390×844 实测 `.share-top clientWidth=358`、`scrollWidth=383`，Leave 按钮右缘为 `398.55px`；本轮 `.share-shell { overflow-x:hidden }` 只把文档 `scrollWidth` 压回 390，没有让 header 收进视口，按钮右侧仍被裁切。
- trigger: 单邮箱 ready 页同时显示普通长度邮箱、到期倒计时和 Leave。
- impact: 离开动作的边框与约 8.5px 可点击区域落在视口外；横向滚动提示被隐藏后，访客也无法通过滚动看到完整控件。
- required_fix: 在 header 责任层定义移动端换行/分区布局，让标题、倒计时和 Leave 各自受可用宽度约束；移除以裁切掩盖溢出的做法，不要删倒计时或继续压缩按钮。
- verify: 本地 Vite + Chromium 以 390×844 渲染真实 SFC 并读取几何：标题右缘 `161.92`、倒计时右缘 `314.44`、Leave 右缘 `398.55`，复现 persists。修复后同一组合应满足所有子项右缘 ≤390、`.share-top scrollWidth <= clientWidth`。
- risk_spread: none

### persists: F-0029

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1207`
- symbols: `.share-shell[data-share-state="unavailable"] .share-card`, `.share-card`, `.share-top`
- rule_source: `visitor-share-ui-design.md:39` 要求 unavailable / timedout / exited 使用“居中终态卡”；`reviewer-l0-l1.md:53,55` 将该 identity 明确列为 T5 的 open carryover。
- identity_scope: unavailable、timedout、exited 三种非 gone 终态在视口中的纵向定位。
- failure_mode: 终态样式仍只缩窄卡片、居中文字和 header，没有建立视口级纵向居中布局。1280×900 实测 unavailable 卡片 `y=32`、高 `69`、中心 `66.5`，而视口中心为 `450`。
- trigger: 访客进入 unavailable、timedout 或 exited 任一终态。
- impact: 终态信息贴顶、下方留下大块空白，没有形成一次性结束页应有的聚焦终态。
- required_fix: 在终态 shell 责任层建立带安全边距的视口级 flex/grid 居中；短屏内容超高时仍须允许正常滚动。
- verify: 本地 Vite + Chromium 以 1280×900 模拟 `SHARE_UNAVAILABLE`，测得上述位置，复现 persists。修复后分别验证三态卡片中心接近可用视口中心，并在短屏不裁内容。
- risk_spread: none

## 6. Verified with no finding

- 主任务未被横幅抢焦点：桌面横幅高 `43px`，OTP 卡高 `138.5px`；390px 下横幅高 `43px`，OTP 卡高 `204.94px`，验证码仍为约 `31.2px` 大字且复制按钮全宽。横幅出现后 OTP 从 `y=182` 下移到 `y=237`（移动端位于 `y=203`），仍完整可见且无覆盖。锚点：`index.vue:130-136,1402-1411`、`ShareOtpCard.vue:151-195`。
- 三处 `role="status"` 均处于普通文档流：新邮件横幅是完整可见的 43px 信息条；复制验证码反馈显示在复制按钮下方；复制全文反馈显示在对应动作下方。没有 `position:absolute/fixed`、负边距或 z-index 覆盖 OTP。锚点：`ShareOtpCard.vue:35-41`、`index.vue:130-136,211-217`。
- reduced-motion 成立：`prefers-reduced-motion: reduce` 下新邮件横幅 computed `animation-name=none`；`no-preference` 下为 `share-notice-in-*`。spinner 与空态呼吸动画也只在 `no-preference` 分支启用。锚点：`index.vue:1250-1260,1297-1312,1415-1426`。
- 明暗未形成新增 finding：设计卡给的是固定浅色 `--sh-*` token；实测 light 与 `html.dark` 下 shell 均保持 `rgb(27,31,59)` / `rgb(244,245,247)`，横幅、OTP 与文字仍是一套完整浅色界面。上一轮“补暗色主题”已在 `runs/2026-08-26-r1/decisions.json:985-986` 被裁决为 deferred，不能重复上报。
- 空收件箱仍是一等等待卡：1280px 下实测等待卡 `592×99px`，文案为 “No mail yet. New messages will appear here.”，且 OTP 卡数量为 0；不会用“未识别验证码”冒充收件箱空态。锚点：`index.vue:151-155,1277-1295`。

## 7. Risk spread and exclusions

- risk_spread: none。视觉取证未跨出 `views/share/` 与既定样式/状态边界。
- 按任务约束，未检查构建产物 chunk 图，也未对 `role=status` 的首次插入/重复播报做读屏实现正确性结论。
