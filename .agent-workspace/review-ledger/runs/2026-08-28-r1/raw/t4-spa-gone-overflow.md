# T4 · 访客页退场与外部文本 overflow

## 结论

`NEEDS_CHANGES`：无新增 finding；`F-0027`、`F-0029` 在当前状态继续存在。`F-0028` 指定的四组外部文本消费者未回归；sessionStorage 不可用时，gone 路径会直接清空文档而不进入 reload 循环。

## Findings

### persists: F-0027

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1220`
- symbols: `.share-top`, `.share-expires`, `[data-share-exit]`, `.share-shell`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:31` 要求移动端全宽布局及触控目标 ≥44px；`reviewer-l0-l1.md:51` 将该 identity 列为 T4 open carryover。
- identity_scope: 390px 访客 ready 页首栏的宽度约束与离开动作可见性。
- failure_mode: `.share-top` 仍是不可换行的单行 flex；最外层 `.share-shell { overflow-x: hidden }` 只隐藏页面横向滚动，没有把页首内容收进卡片。390×844 实测 `.share-top clientWidth=358 / scrollWidth=363`，Leave 右缘为 `378.89px`，超过卡片内容右缘约 `374.10px`。
- trigger: 单邮箱 ready 页同时显示普通长度邮箱、倒计时与 Leave 按钮。
- impact: Leave 按钮右侧边框及部分点击区域被裁切；外层隐藏横向滚动后，访客也无法滚动查看被裁部分。
- required_fix: 在 `.share-top` 责任层定义移动端换行或分区布局，使标题、倒计时和 Leave 都受可用宽度约束；不要用父容器裁切代替布局收口。
- verify: 本地 Vite 页面配合拦截的访客 API，在 Chromium 390×844 下以 `visitor@example.com` 和 38 分钟倒计时复现上述几何值。修复后应满足 `.share-top scrollWidth <= clientWidth`，且所有子项右缘不超过卡片内容右缘。
- risk_spread: none

### persists: F-0029

- severity: P2
- anchor: `mail-vue/src/views/share/index.vue:1207`
- symbols: `.share-shell[data-share-state="unavailable"] .share-card`, `.share-shell[data-share-state="timedout"] .share-card`, `.share-shell[data-share-state="exited"] .share-card`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:39` 要求 unavailable / timedout / exited 使用“居中终态卡”；`reviewer-l0-l1.md:53` 将该 identity 列为 T4 open carryover。
- identity_scope: unavailable、timedout、exited 三种非 gone 终态卡在视口中的纵向定位。
- failure_mode: 终态样式仍只有 `max-width`、`text-align` 与页首水平居中，没有建立视口级垂直居中布局。1280×900 实测 unavailable 卡片 `y=32`、高 `69`、中心 `66.5`，远离视口中心 `450`。
- trigger: 访客进入 unavailable、timedout 或 exited 任一终态。
- impact: 结束信息贴近视口顶部，下方留下大块空白，未形成设计卡要求的聚焦终态。
- required_fix: 在终态 `.share-shell` 责任层建立带安全边距的视口级 flex/grid 居中；内容高于短视口时仍须允许正常滚动。
- verify: Chromium 1280×900 直接打开无凭据访客页，状态为 unavailable，并测得上述卡片位置。修复后应分别验证三态卡片中心接近可用视口中心，且短屏不裁切内容。
- risk_spread: none

## 已查证且无 finding

- `session.js` 的 sessionStorage 读、写、删及枚举均位于 `storageCall` 或 `markShareGone` 自身的 `try` 内：`mail-vue/src/views/share/session.js:20-25,28-50,57-81,84-100,113-123`。
- `markShareGone` 在 `getItem` 或 `setItem` 抛 `SecurityError` 时都返回 `blank`；运行时探针两种分支均输出 `blank`。因此标记写不进去时不会先 reload 再回 SPA 形成循环：`mail-vue/src/views/share/session.js:107-123`。
- `handleShareGone` 即使 `clearMailboxView()` 抛错也会执行本地状态兜底，随后必经 `markShareGone` 并二选一执行 reload/blank；该控制流与 `docs/specs/mail-share/design.md:751` 的 vite 直出防循环兜底一致：`mail-vue/src/views/share/index.vue:824-842`。
- `F-0028` 没有回归。390×844、180 个连续字符样本下，列表主题、列表发件人、详情发件人、详情主题、附件按钮均为 `scrollWidth === clientWidth`，computed style 为 `overflow-wrap:anywhere` / `word-break:break-word`：`mail-vue/src/views/share/index.vue:1499-1506`。
- `/S/:lid` 的匿名判定仍以“无 token”为前提；运行时调用结果为匿名 `/S/` → `true`、有 token 的 `/S/` 与 `/s/` → `false`，已登录用户不会被大小写 alias 强制切入匿名初始化：`mail-vue/src/init/init.js:18-20`、`mail-vue/src/router/index.js:69-72`。
- 定点测试：`pnpm exec vitest run src/views/share/session.spec.js src/views/share/index.spec.js --reporter=dot` → 2 files / 80 tests passed。
- risk_spread: `spa-gone-exit-under-storage-failure` 已沿 `session.js → index.vue` 一跳到达 stop_when；未扩散到其他 SPA 存储面。
