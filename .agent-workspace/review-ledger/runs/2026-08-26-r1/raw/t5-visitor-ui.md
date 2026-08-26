# T5 · 访客收码页视觉重做 · 技术独立审查

- 被审提交：`e309ad4a17c46dcfff896b9d967b322cca4389a7`（仅 T5；同提交 P4 gone 恢复归 T1，本报告不重审）
- 被审文件：`mail-vue/src/views/share/index.vue`、`mail-vue/src/views/share/ShareOtpCard.vue`，以及 `index.spec.js` 的 T5 断言
- 唯一判据：`.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md`；chunk 判据补充 `docs/specs/mailbox-share-capability/requirements.md` AC-SEC-06
- 当前树：`9b6eb8072fe73c93518e872037702a2e8e54056b`；`e309ad4..HEAD` 对上述三文件无后续差异
- 结论：`NEEDS_CHANGES`
- Findings：`P0 × 1 · P1 × 1`

## Findings

### T5-P0-1 · 匿名访客 chunk 仍由三条反馈路径静态引入 Element Plus

1. **严重度**：P0（阻塞）。本主题唯一设计卡把“禁止 Element Plus”列为硬约束，当前最终页面不满足该约束。
2. **置信度**：高。源码消费点、构建期自动导入配置及现有测试注释三处相互印证；这不是根据包名猜测 bundle。
3. **证据锚点**：
   - `mail-vue/src/views/share/index.vue:390-394,536-540`：到信提示、复制整封邮件成功均调用裸标识符 `ElMessage`。
   - `mail-vue/src/views/share/ShareOtpCard.vue:136-140`：复制 OTP 成功调用同一 `ElMessage`。
   - `mail-vue/vite.config.js:42-47`：`AutoImport` 与 `Components` 都启用 `ElementPlusResolver()`，裸标识符会被改写为真实 Element Plus import。
   - `mail-vue/src/views/share/index.spec.js:34-39`：测试注释明确记录该改写，并通过 `vi.mock('element-plus', ...)` 观察真实包。
   - `mail-vue/src/views/share/assert-share-chunk.js:10-14,85-93`：chunk 守护只禁止 Dexie、登录 layout 权限串、登录 axios reload 与 `websiteConfig`，不禁止 `element-plus`，所以 AC-SEC-06 守护可绿而设计卡硬约束仍失败。
   - 判据：`visitor-share-ui-design.md:42-48` 明确“禁止 Element Plus / 主 layout / db.js / 登录 axios”。
4. **触发条件**：访客打开该异步路由；构建插件处理 `index.vue` 或 `ShareOtpCard.vue` 的任一 `ElMessage` 裸标识符。用户实际触发新邮件到达、复制 OTP 或复制全文时会消费相应反馈。
5. **失效机制**：源码没有显式 import 不等于没有依赖；`ElementPlusResolver` 在构建期补入静态 import。现有 chunk 守护的禁止集合与设计卡禁止集合不同，因此不能替本主题发现该违规。
6. **用户/系统影响**：匿名收码页的依赖闭包仍包含设计卡明确排除的组件库反馈层；T5 即使所有现有 chunk 隔离测试通过，也不能据此判定设计卡硬约束已满足。
7. **修复与回归**：
   - 用访客页自身的原生状态/就地文案承载三条反馈，移除两个组件中的 `ElMessage` 消费点，不引入另一套登录态 UI 依赖。
   - 增加 T5 专项守护：访客源码和构建后的 share 依赖闭包均不得出现 `ElMessage` / `element-plus`；不要扩大或改弱 AC-SEC-06 现有四项禁止规则。
   - 验证：`rg -n "ElMessage|element-plus" mail-vue/src/views/share/index.vue mail-vue/src/views/share/ShareOtpCard.vue` 期望无命中；随后执行 `share-chunk.spec.js` 并检查构建闭包无 `element-plus`。

补充归因：`git show e309ad4^` 在 `index.vue:382-383,528-529` 与 `ShareOtpCard.vue:136-137` 已存在同三处消费点，`e309ad4` 没有新增第四处。因此它不是该提交新制造的依赖回归；但设计卡是本主题的最终态硬判据，“存量”不能使 T5 获得通过结论。

### T5-P1-1 · 移动端验证链接点击框只有 24px，高度未达到 44px

1. **严重度**：P1。直接违反设计卡的移动触控硬指标；影响的是 P2 验证链接，不涉及授权或数据写入。
2. **置信度**：高。CSS 缺口可静态闭合，并用隔离 Chromium 按当前规则得到实际边界。
3. **证据锚点**：
   - `mail-vue/src/views/share/ShareOtpCard.vue:200-206`：`.share-otp-url` 只有 `display:inline-block`、换行与颜色，没有 padding、`min-height` 或其它 44px 命中区规则。
   - `mail-vue/src/views/share/ShareOtpCard.vue:239-245`：移动媒体查询只扩大 `.share-otp-row button`，未覆盖 `.share-otp-url`。
   - `mail-vue/src/views/share/index.vue:1137-1139`：链接继承 `line-height:1.5`；默认 16px 字号下单行高度为 24px。
   - 隔离 Chromium 以当前相关 CSS、短链接 `https://x.co/a`、处于 `max-width:640px` 媒体查询内的视口复算，输出：`{"width":100.1875,"height":24,"lineHeight":"24px","minHeight":"0px","padding":"0px"}`。
   - 判据：`visitor-share-ui-design.md:28-31` 要求移动触控目标 `≥ 44px`。
4. **触发条件**：移动断点内，邮件提取出可单行显示的短 `http/https` 验证链接，访客直接点击该 URL。
5. **失效机制**：锚点的命中框等于单行 line box；当前规则没有任何垂直扩展，故稳定停在 24px。长 URL 偶然换成多行不能修复短 URL 场景。
6. **用户影响**：验证链接的触控面积只有硬指标约 55%，移动访客更易点不中或误触，逐状态可访问性验收失败。
7. **修复与回归**：
   - 在移动断点扩大链接自身命中区到至少 44px（例如 `inline-flex`/`flex` 配合 `min-height:44px` 与对齐），继续显示完整 URL，不改 `data-share-link-url`。
   - 增加浏览器回归：短链接在移动视口的 `getBoundingClientRect().height >= 44`，并同时断言完整 URL 文本、`href`、`target="_blank"` 与 `rel="noopener noreferrer"` 保持不变。

## review_focus 逐项查证

1. **`data-share-*` 钩子稳定性**：提交前后完整模板清单逐项相同。`index.vue` 为 21 个出现项（含 ready/非 ready 两个 `data-share-body`），`ShareOtpCard.vue` 为 8 个；名称、动态值及出现次数均未变化。DOM 关系并非字面“零改”：`[data-share-shell]` 与 header/body 从直接父子变为 `[data-share-shell] > .share-card > ...`，但 `[data-share-body]` 到 `[data-share-mail-list]` 的内部祖先链未变。`tests/e2e/fixtures/share.js` 与全部 `visitor-*.spec.js` 只使用全局/节点内 locator，没有 `>`、兄弟组合器或 shell→body 直接子假设；唯一 `parentNode` 是 `index.vue:647` 的 Tab 键盘导航，父节点仍是 `.share-tabs`。未形成 finding。
2. **token 继承链**：九个 token 在 `index.vue:1122-1131` 按设计卡逐值定义；`ShareOtpCard` 唯一生产渲染点位于 `index.vue:134-138`，恒在 `.share-shell > .share-card > [data-share-body]` 子树内。子组件消费的 `--sh-accent/#3b5bdb`、`--sh-accent-soft/#edf2ff`、`--sh-text/#1b1f3b`、`--sh-muted/#5c5f77`、`--sh-radius/16px` fallback 均与设计卡一致。CSS 变量依 DOM 继承，不依 scoped attribute，链路成立。
3. **匿名 chunk 隔离**：`e309ad4^` 与 `e309ad4` 的两个组件模块 specifier 清单完全相同；T5 的 wrapper/CSS 没有新增 runtime import。AC-SEC-06 明列的登录态 axios、layout、Dexie、`websiteConfig` 仍由 `assert-share-chunk.js` 从 `cloud-mail-share-shell` marker 沿构建产物相对 import 闭包检查。Element Plus 是设计卡额外硬约束且守护未覆盖，见 T5-P0-1。
4. **逐状态可访问性**：倒计时 `<time>` 没有 `aria-live`；`share-spin` 与 `share-breathe` 两个 `animation` 声明都只存在于 `prefers-reduced-motion:no-preference` 内；Tab 选中态同时使用 `font-weight:600` 与下划线，不只靠颜色；移动按钮组均有 `min-height:44px`。验证链接遗漏见 T5-P1-1。
5. **样式断言形态**：`index.spec.js:649-658` 的源码正则确实不验证 computed style 或 selector 是否实际命中，但它沿用同一测试自 T-24 已有的源码契约：本提交只是把 `/font-size:\s*32px/` 改成空白宽容的 `clamp(...)` 正则，并继续守住样式属于 `ShareOtpCard` 而非父页。设计卡恰好规定该精确值，因此未把这一既有断言形态单独报为 finding；T5-P1-1 需要的 44px 行为则必须补浏览器边界断言，不能再用文本正则代替。

## 验证记录与机械闸门

- `git diff --check e309ad4^ e309ad4 --`（三文件）退出码 0。
- `git diff --exit-code e309ad4 9b6eb80 --`（三文件）退出码 0，当前行锚点可复现目标提交。
- 被审 worktree 在审查前后 `git status --short` 均为空；未修改被审代码。
- `/tmp/share-review/mail-vue` 没有 `node_modules`，遵守 read-only 约束未安装依赖，因此未把 Vitest/chunk build 伪报为已执行；chunk 结论来自 import 闭包实现与目标 diff 的静态可执行核对。
- `.github/workflows/deploy-cloudflare.yml` 会构建并部署，但没有调用 Vue test、`share-chunk.spec.js` 或 `scripts/assert-share-chunk.js`。仓库没有条款要求该测试成为自动 gate，且这是跨主题同一机械缺口，按“不重复机械闸门”不在 T5 再生成 suggestion。

## 最终判定

hook 名称/值及现有 E2E 定位保持稳定，token 继承与 AC-SEC-06 四项匿名依赖隔离也成立；但最终访客 chunk 仍保留设计卡明禁的 Element Plus，移动验证链接的 24px 点击框又直接违反 44px 硬指标。T5 不能按当前状态通过。
