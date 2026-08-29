# T4 · 访客分享页退场与 overflow UI/UX 审查

## Findings

### UI-T4-F1

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1183`
- symbols: `.share-shell`, `ShareOtpCard`, `[data-share-code-from]`, `.share-list-from`, `.share-from`, `.share-detail h2`, `.share-atts button`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:31` 要求移动端内容保持在全宽页面内；`docs/specs/mail-share/requirements.md:178` 的 AC-OTP-07 要求验证码同时展示发件人显示名与地址。
- identity_scope: 390 视口下 OTP 卡发件人身份行的外部文本 containment；不包含历史页首问题 F-0027。
- failure_mode: 本轮把 `overflow-x:hidden` 加在最外层 shell，并只给邮件列表、详情标题/发件人和附件按钮补换行；父组件 scoped 规则没有覆盖 `ShareOtpCard` 内无 class 的 `[data-share-code-from]`。因此页面级横向滚动被隐藏了，但超长无空格发件人仍按 intrinsic width 向右溢出并被 shell 裁掉，访客看不全验证码对应的来源身份。
- trigger: 390px 视口打开一封 `senderName` 或 `senderAddress` 含连续长 token 的邮件；该值来自邮件投影，无需修改 DOM。
- impact: OTP 与复制仍可用，但用于判断验证码来源的发件人名/地址被静默截断；页面表面没有横向滚动，访客也无法滚到被裁掉的内容。
- required_fix: 在拥有该 DOM 的 `ShareOtpCard` 视觉层为 OTP 来源行建立 `min-width:0` 与可断词规则，并把 shell 的 `overflow-x:hidden` 仅作为兜底而非 containment 手段；同一极端样本下逐节点确认所有外部文本消费者的实际 scroll width 不超过自身内容宽。
- verify: Playwright 以 390×844、普通绑定邮箱及 180 个连续 `W` 的发件人名/地址实测：`[data-share-code-from] clientWidth=306 / scrollWidth=2678`，`.share-shell/.share-card scrollWidth=2715`，而文档 `scrollWidth=379`，证明超宽内容只是被 `overflow-x:hidden` 隐藏；同页列表主题/发件人、详情主题/发件人、附件按钮均为 `scrollWidth === clientWidth`。修复后应断言 OTP 来源行、card 与 shell 均满足 `scrollWidth <= clientWidth`，且完整发件人文本可见。
- risk_spread: none
- related_history: F-0028（台账已标 resolved，但原超长外部文本身份范围在 OTP 来源行仍有未覆盖面；由主审决定 reopen 还是新编号）

## 历史问题复核（不计新 finding）

- persists: F-0027。`mail-vue/src/views/share/index.vue:1220-1225` 的 `.share-top` 仍是不可换行的单行 flex。390×844、普通 `visitor@example.com`、倒计时和 Leave 同显时，实测 header `clientWidth=358 / scrollWidth=363`，Leave 右缘 `378.89px` 超过卡片内容右缘 `374.10px`；外层 hidden 只消除了文档滚动条，没有收口 header。按指令不作为新问题。
- persists: F-0029。`mail-vue/src/views/share/index.vue:1207-1217` 仍只缩窄终态卡、居中文字。1280×900 的 unavailable 卡片实测 `y=32, height=69`，中心 `66.5` 对比视口中心 `450`；390×844 的 exited 卡片实测 `y=0, height=61`。按指令不作为新问题。

## 已查证且无 finding

- F-0028 本轮明确覆盖的四组消费者已生效：390×844 注入同一组 180 字符连续外部文本后，邮件列表主题/发件人、详情主题/发件人、附件按钮均有 `overflow-wrap:anywhere`，各自 `scrollWidth === clientWidth`；纯文本正文也由 SafeMailRenderer 的 `word-break:break-word` 收口：`mail-vue/src/views/share/index.vue:1499-1506`。
- 390 空收件箱下，等待卡宽 `358px`、文档 `scrollWidth=390`，手动刷新按钮宽 `358px` 且高 `44px`；等待文案仍是独立卡片，没有误出 OTP：`mail-vue/src/views/share/index.vue:151-155,1277-1295,1622-1625`。
- AuthKey 错误态在 390 下输入、提交和字段错误同屏：输入与按钮边界均落在 `x=16..374`，高度均为 `44px`，错误紧随其后且文档无横向溢出：`mail-vue/src/views/share/index.vue:42-80,1336-1365,1391-1396`。
- limited 态在 390 下有可见警告横幅且无横向溢出；loading 保留 spinner 与文字；unavailable / timedout / exited 的业务 body 为空。终态空间位置仅保留上述 F-0029：`mail-vue/src/views/share/index.vue:11-17,36-40,243`。
- 模板没有 gone 业务卡或插画；本审查只确认该视觉层事实，不判断 sessionStorage、reload 或 blank document 的实现正确性：`mail-vue/src/views/share/index.vue:14-17,243`。
- 定点自动化实跑：`pnpm exec vitest run src/views/share/index.spec.js src/views/share/ShareOtpCard.spec.js --reporter=dot` → EXIT=0，2 files / 82 tests passed。现有 overflow 断言只检查源码存在 `overflow-wrap:anywhere`，没有覆盖 390 几何或 OTP 来源行：`mail-vue/src/views/share/index.spec.js:649-659`。
