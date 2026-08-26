# T5 · 访客收码页视觉验收与重排诊断

审查对象：`e309ad4` 触及的 `mail-vue/src/views/share/index.vue`、`mail-vue/src/views/share/ShareOtpCard.vue`；当前审查 HEAD 为 `9b6eb80`。唯一视觉规则源为 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md`。

结论：6 条 finding（P0=1，P1=3，P2=2）。

## 复现证据

1. `mail-vue/src/views/share/index.vue:390-394,536-540` 与 `ShareOtpCard.vue:136-140` 均调用 `ElMessage`；`index.spec.js:34-39` 明确记录裸标识符会被 auto-import 改写为真实 `element-plus` import，并实际 mock 该包。
2. 按实现中的 390px 媒体查询复刻 CSS 后，Playwright 量测长邮箱标题场景得到 `viewport=390`、`documentScrollWidth=437`、离开按钮 `right=438.24`；对应约束缺口在 `index.vue:1172-1177,1269-1275,1503-1543`。
3. 同一 390px 量测中，16 位验证码得到 `documentScrollWidth=419`、验证码 `right=419.73`，卡片 `right=374.10`；对应样式为 `ShareOtpCard.vue:163-191,239-245`。
4. 短验证链接 `https://x.co/a` 在 390px 下的实际点击框为 `101.14×24px`；`ShareOtpCard.vue:200-206` 没有移动端触控尺寸规则。
5. ready 模板顺序是 Tab（`index.vue:83-113`）→ 刷新（`:118-125`）→ OTP（`:134-138`）→ 空态（`:140-144`），与设计卡 P0/P1/P2 顺序相反；颜色检索还命中 12 处 `rgba(...)` 与 2 处 `color: #fff`，均位于声明 token 之外。

## Finding 1

- severity: P0
- anchor: `mail-vue/src/views/share/index.vue:390`
- symbols: `onPolledMails`、`copyFullMail`、`ShareOtpCard.copyCode`、`ElMessage`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md §硬约束（L42-48，禁止 Element Plus）`
- identity_scope: 匿名访客页的到信与复制反馈组件边界
- failure_mode: 三条用户可见反馈路径调用的 `ElMessage` 会被构建插件改写为真实 Element Plus import，访客页实际使用了设计卡明令禁止的组件库反馈层。
- trigger: 新邮件到达、复制 OTP 成功或复制完整邮件成功。
- impact: 访客看到脱离本页 token 的 Element Plus toast；T5 视觉实现不满足访客页硬约束，不能通过验收。
- required_fix: 在访客页内部统一反馈呈现，沿用本页原生元素和 `--sh-*` token；移除两个组件中的 `ElMessage` 消费点，同时保留现有就地复制结果。
- verify: `rg -n "ElMessage|element-plus" mail-vue/src/views/share/index.vue mail-vue/src/views/share/ShareOtpCard.vue` → 期望 EXIT=1。

## Finding 2

- severity: P1
- anchor: `mail-vue/src/views/share/index.vue:1172`
- symbols: `.share-top`、`.share-expires`、`readyMailboxLabel`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md §布局（L28-31，移动端全宽与 ≥44px 触控）`
- identity_scope: 390px ready 状态的页头布局
- failure_mode: 页头固定为不换行的单行 flex，倒计时又强制 `white-space: nowrap`；长邮箱标题与倒计时、离开按钮同屏时，量测页面宽度从 390px 扩到 437px，离开按钮右缘落在 438.24px。
- trigger: 单邮箱地址较长，且页面同时显示过期倒计时与离开按钮。
- impact: 移动访客页面出现横向滚动，主要退出操作部分落出首屏可视宽度。
- required_fix: 在移动断点重排页头，让标题、倒计时和离开操作分行或允许受控换行；约束标题可收缩/断词，并保持离开按钮触控高度。
- verify: `cd tests/e2e && npx playwright test specs/visitor-session.spec.js --project=chromium -g "long mailbox header stays inside 390px viewport"` → 期望 EXIT=0，且 `documentElement.scrollWidth <= 390`、离开按钮 `right <= 390`。

## Finding 3

- severity: P1
- anchor: `mail-vue/src/views/share/ShareOtpCard.vue:186`
- symbols: `.share-otp-row`、`.share-otp-value`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md §Token（L15-26，OTP 字号）及 §布局（L28-31，移动布局）`
- identity_scope: 移动端 OTP 主信息的宽度约束
- failure_mode: OTP 保持大字号和 `0.12em` 字距，但没有最大宽度、断行或缩放边界；390px 下 16 位数字宽 382.71px，越过卡片右缘 45.63px，并把文档宽度撑到 419px。
- trigger: 当前邮件提取到 16 位或更长的验证码/恢复码。
- impact: P0 验证码被截出卡片并制造横向滚动，访客无法在固定视口中完整核对主任务信息。
- required_fix: 在 OTP 自身建立移动宽度兜底，使长值可完整显示且不突破卡片；保留设计卡规定的字号范围与等宽数字，不以裁切隐藏内容。
- verify: `cd tests/e2e && npx playwright test specs/visitor-otp-copy.spec.js --project=chromium -g "long code stays inside 390px viewport"` → 期望 EXIT=0，且验证码边界不超出 OTP 卡片、页面无横向滚动。

## Finding 4

- severity: P1
- anchor: `mail-vue/src/views/share/ShareOtpCard.vue:200`
- symbols: `.share-otp-url`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md §布局（L28-31，移动触控目标 ≥44px）`
- identity_scope: 移动端验证链接的点击目标
- failure_mode: 移动断点只扩大按钮，没有覆盖验证链接；单行短 URL 的实际点击框高度为 24px，低于 44px 硬指标。
- trigger: 邮件只提取到较短、单行显示的验证链接，访客在移动端点击。
- impact: P2 验证链接触控目标过小，手指操作易误触或点不中。
- required_fix: 扩大链接自身的可点击区域至至少 44px 高，同时继续显示完整 URL，不把链接伪装成背书式主按钮。
- verify: `cd tests/e2e && npx playwright test specs/visitor-otp-copy.spec.js --project=chromium -g "verification link has a 44px mobile target"` → 期望 EXIT=0，且链接 bounding box 高度 ≥44px。

## Finding 5

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:83`
- symbols: `.share-tabs`、`.share-refresh`、`ShareOtpCard`、`.share-empty`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md §信息优先级（L9-13）`
- identity_scope: ready 状态从页头到主任务区的垂直信息顺序
- failure_mode: P2 多邮箱 Tab 和刷新操作先于 P0 OTP/空收件箱等待渲染；有邮件与无邮件两条 ready 路径都先展示次级控制，再展示主任务。
- trigger: 任意 ready 页面；多邮箱页面还会额外先经过整排 Tab。
- impact: 访客第一眼先看到导航与刷新控制，验证码或“正在等新邮件”的主任务被下推，收码路径不符合设计卡的显著性顺序。
- required_fix: 以 OTP/等待为首个内容区重排 ready 页面，把邮件导航、刷新和列表组织为后续层级；多邮箱切换仍须可达，但不得先于当前邮箱的 P0 结果抢焦点。
- verify: `cd tests/e2e && npx playwright test specs/visitor-otp-copy.spec.js specs/visitor-multi-mailbox.spec.js --project=chromium -g "P0 region precedes secondary controls"` → 期望 EXIT=0，并断言 OTP 或空态的顶部坐标小于刷新按钮及非当前任务导航。

## Finding 6

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1224`
- symbols: `.share-wait`、`.share-empty`、`.share-auth-input`、`.share-list button`、`.share-otp`、`.share-otp-row button`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md §Token（L15-26，颜色 token 挂在 `.share-shell`）`
- identity_scope: 访客页单一浅色主题的颜色 token 消费边界
- failure_mode: token 已集中声明，但阴影、警告底色、边框和主按钮反白仍散落 12 处 `rgba(...)` 与 2 处 `#fff`；这些颜色不消费 `--sh-*`，同一浅色主题的调色入口不是单一真源。
- trigger: 按设计卡调整 `--sh-accent`、`--sh-muted`、`--sh-warn` 或 `--sh-text` 中任一颜色。
- impact: 边框、阴影、警告底色或按钮文字继续保留旧 RGB，页面内部出现不可由 token 一次控制的固定灰阶与色相。
- required_fix: 让所有用户可见颜色从 `.share-shell` 的既有 token 派生，必要时在同一处补充语义 token；本设计卡只规定浅色主题，不新增暗色主题。
- verify: `rg -n "rgba\\(|color:\\s*#fff;" mail-vue/src/views/share/index.vue mail-vue/src/views/share/ShareOtpCard.vue` → 期望 EXIT=1。

## 已核查且未形成 finding

- loading 保留文案并在卡内显示 spinner，且两组动画均受 `prefers-reduced-motion: no-preference` 约束：`index.vue:11,1190-1212,1249-1264`。
- 空收件箱已做成独立等待卡，unavailable/timedout/exited 已做居中终态卡：`index.vue:1157-1169,1229-1247`。
- 桌面卡片 `max-width: 640px`，移动端去圆角、去阴影、Tab 横向滚动及按钮 44px 基础规则均已落地：`index.vue:1142-1150,1503-1543`。
- 设计卡只定义一套浅色 token，没有双主题契约；本轮按该浅色逐屏核查，未把“缺少暗色”虚构为 finding。
- 访客页禁止 Element Plus，因此原生表单、按钮、Tab 与卡片包裹本身不构成“自造官方组件”的 finding；Finding 1 只针对仍然实际引入 Element Plus 的反馈路径。
