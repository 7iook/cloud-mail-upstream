# T6 · 访客收码页视觉验收

## Findings

### UI-T6-F1

- severity: P1
- anchor: `mail-vue/src/views/share/index.vue:1172`
- symbols: `.share-top`, `.share-expires`, `readyMailboxLabel`, `[data-share-exit]`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:31` 要求移动端全宽且触控目标 ≥ 44px；本轮 `themes.md` T6 review_focus 5 明确要求在 390 视口实际验收。
- identity_scope: 访客 ready 页首栏在移动视口内的宽度约束与换行策略
- failure_mode: `.share-top` 保持单行 flex 且没有换行/分区规则，标题、不可换行的倒计时和 Leave 按钮共同撑宽页面；390 视口用普通 `visitor@example.com` 实测文档 `scrollWidth=398`、`clientWidth=390`，Leave 按钮右缘落在 `398.5px`。
- trigger: 单邮箱 ready 页同时显示邮箱地址、到期倒计时和离开按钮；无需超长文本即可复现。
- impact: 手机页面出现横向滚动，最右侧 Leave 按钮被裁出视口；虽然按钮高度为 44px，实际可点击区域没有完整留在可视宽度内。
- required_fix: 把页首标题、到期信息和离开动作收口为明确的响应式 header 布局契约，在移动端允许分行或分区，并保证任意组合都受卡片内容宽度约束；不要只压缩 Leave 按钮或隐藏倒计时。
- verify: `unverified: 已在本地 Vite + Playwright 以 390×844、普通邮箱地址和有效 expiresAt 实测上述 398/390 溢出；仓库没有覆盖该 header 几何关系的视觉回归命令。`
- risk_spread: none

### UI-T6-F2

- severity: P1
- anchor: `mail-vue/src/views/share/index.vue:161`
- symbols: `readyMailboxLabel`, `senderLine`, `.share-list`, `.share-list-from`, `.share-detail h2`, `.share-atts`, `[data-share-code-from]`
- rule_source: 本任务明确要求验收超长文本；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:31` 要求移动端布局不退化；同卡 `:37` 要求 OTP 区是 ready 页主信息区，而非被横向溢出破坏。
- identity_scope: 访客页服务端可控文本在 header、OTP、邮件列表、详情与附件动作中的统一宽度 containment
- failure_mode: 只有验证链接设置了 `overflow-wrap:anywhere`，邮箱地址、主题、发件人和附件名均保留 `overflow-wrap:normal/word-break:normal`；390 视口注入合法的无空格长值后，页面 `scrollWidth=983`、可视宽 `379`，其中详情标题 `scrollWidth=967/clientWidth=348`，邮件列表按钮 `660/346`，附件按钮 `637/346`，OTP 发件人行 `608/306`。
- trigger: 邮件主题、发件人显示值、绑定邮箱或附件文件名包含超过一行宽度的连续字符；这些字段均来自真实邮件或分享投影，不需要篡改 DOM。
- impact: 整张收码页被拉成近三倍屏宽，验证码、复制结果和离开动作不再处于稳定视口，用户必须横向拖动才能阅读和操作。
- required_fix: 建立一条覆盖所有外部文本消费者的共享换行/收缩规则，并逐面验证 header、OTP 来源、列表摘要、详情标题与附件动作；不能只修当前截图里最先溢出的主题。
- verify: `unverified: 已在本地 Vite + Playwright 以 390×844 注入长邮箱/主题/发件人/附件名并逐节点读取 scrollWidth/clientWidth；现有组件测试只检查文本存在，不检查长文本 containment。`
- risk_spread: none

### UI-T6-F3

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1159`
- symbols: `.share-shell[data-share-state="unavailable"] .share-card`, `.share-card`, `.share-top`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:39` 要求 unavailable / timedout / exited 使用“居中终态卡”；实现自身 `mail-vue/src/views/share/index.vue:1157` 也声明这三态是“居中终态卡”。
- identity_scope: unavailable、timedout、exited 三种非 gone 终态在视口中的空间定位
- failure_mode: 终态规则只缩窄卡片并设置 `text-align:center`，没有改变 shell 的纵向布局；1280×900 实测 unavailable 卡片位于 `y=32`、高 `69`，中心点 `66.5`，而视口中心点为 `450`。
- trigger: 访客在桌面视口进入 unavailable、timedout 或 exited 任一终态。
- impact: 终态信息贴在页面顶部，下方留下大块无意义空白；视觉结果没有兑现设计卡所说的居中终态，与一次性结束页的聚焦感不符。
- required_fix: 为三种终态定义共同的视口级居中布局，同时保留移动端安全边距和短屏滚动能力；不要把“文字居中”继续当成“终态卡居中”。
- verify: `unverified: 已在本地 Vite + Playwright 以 1280×900 模拟 SHARE_UNAVAILABLE 并读取 shell/card 边界；仓库无终态位置视觉断言。`
- risk_spread: none

### UI-T6-F4

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1149`
- symbols: `--sh-*`, `.share-card`, `.share-wait`, `.share-empty`, `.share-auth-input`, `.share-list`, `.share-otp`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:15-25` 将颜色定义为挂在 `.share-shell` 的 token；仓库 `mail-vue/src/style.css:145-168` 已定义 `.dark` 主题语义，本任务明确要求同时验收明暗与硬编码颜色。
- identity_scope: 匿名访客页颜色语义的单一 token 来源及 light/dark 主题投影
- failure_mode: token 声明之后仍有阴影、警告底色、边框和按钮前景共 11 处裸 `rgba(...)`/`#fff`，`ShareOtpCard.vue` 也有 11 行 raw/fallback 颜色；同时没有 `.dark` 或 `prefers-color-scheme` 的 `--sh-*` 覆盖。运行时在 light、OS dark、`html.dark` 三种条件下均得到同一组浅色：shell `rgb(244,245,247)`、card `rgb(255,255,255)`、OTP `rgb(237,242,255)`。
- trigger: 访客系统偏好暗色、从已切为 dark 的站内上下文进入分享页，或后续只调整 `--sh-muted/--sh-warn/--sh-accent` 主题值。
- impact: 访客页强制亮色并与仓库其余暗色界面割裂；后续换肤时语义 token 与复制出的 RGB 边框/底色会分叉，形成混合配色。
- required_fix: 补齐 on-accent、border、shadow、warning-soft 等语义 token，并由 light/dark 两套主题集中赋值；所有选择器只消费 token，不要逐个选择器追加暗色特判。
- verify: `unverified: 已在本地浏览器分别设置 colorScheme=dark 与 html.dark 并读取四个核心 computed color，结果与 light 完全相同；当前没有访客页主题视觉回归命令。`
- risk_spread: none

## 已查证且无 finding

- 1280×900 实测卡片宽 `640px`，OTP 卡位于主要内容前部、使用 accent-soft 底色，验证码字号 `40px`；390×844 下验证码字号约 `31.2px`，复制按钮全宽 `316px` 且高 `44px`。验证码与复制是明确主焦点：`mail-vue/src/views/share/ShareOtpCard.vue:148-192`。
- 390 视口下 Refresh、Copy、Copy full email、Leave 均实测高 `44px`；AuthKey 输入与提交按钮也均为 `44px`。除 F1 的页首横向裁切外，触控尺寸兑现设计卡：`mail-vue/src/views/share/index.vue:1529-1543`、`mail-vue/src/views/share/ShareOtpCard.vue:239-245`。
- 空收件箱实测只显示等待卡，不误出 OTP 业务卡；等待文案为 “No mail yet. New messages will appear here.”，盒宽受卡片约束：`mail-vue/src/views/share/index.vue:140-144`、`:1229-1247`。
- AuthKey 错误态在字段旁显示 danger 色错误文案，390 视口无横向溢出；loading 保留文案并在卡片内显示 spinner：`mail-vue/src/views/share/index.vue:11`、`:73-79`、`:1190-1212`。
- 两处动画都只在 `prefers-reduced-motion:no-preference` 下启用；空态呼吸动画运行时从 `share-breathe-*` 切为 `none`：`mail-vue/src/views/share/index.vue:1202-1212`、`:1249-1264`。
- 强制 Clipboard API 与 `execCommand` 同时失败后，手动输入框实测可见、获得焦点并选中 `0..6` 的完整验证码，符合 AC-OTP-09：`mail-vue/src/views/share/ShareOtpCard.vue:213-237`。
- 验证链接使用 `overflow-wrap:anywhere` + `word-break:break-all`，超长 URL 实测仍留在 OTP 卡宽度内；F2 不包含该字段：`mail-vue/src/views/share/ShareOtpCard.vue:198-206`。
- 新增 `.share-card` 没有移动或删除 `data-share-*` 属性；检索现有 visitor e2e / 组件测试也未发现依赖 `[data-share-shell] > ...` 的直接子选择器：`mail-vue/src/views/share/index.vue:2-9`。
- 模板和 CSS 都没有定义 gone 业务卡或 gone 插画；非 gone 的 unavailable 终态中 `[data-share-body]` 实测为空。404 能否正确抵达该出口属于 T1，本报告不审其逻辑正确性：`mail-vue/src/views/share/index.vue:1157-1169`。
