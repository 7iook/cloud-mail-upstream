# UI-T3 · 分享文档入口、大小写 URL 与空白状态

## 1. Lens

- 角色：UI/UX，只审视觉、信息层级与状态呈现。
- 对象：T3 触及的 `/s/:lid`、`/S/:lid` 用户可见入口，`init.js` 匿名访客分流，以及文档导航层 429 / gone 404 的用户可辨识性。
- 不审：限流算法、配额数值、数据库查询、路径判定的实现正确性。

## 2. Range

- 审查提交：`0f4f52c`、`1da171f`
- 审查区间：`9b6eb8072fe73c93518e872037702a2e8e54056b..083c87f2d2ccc8c459adfd45fc31a43afc63256f`
- 历史边界：`F-0022` 已 resolved；本轮只确认大小写入口的用户呈现，不重开其 gone 绕过 identity。

## 3. Rule sources

- `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:7-13,33-40`：访客应尽快进入收码主任务；gone 使用原生 404，limited 使用警告横幅。
- `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:42-48`：访客视觉层不得引入主 layout / 登录 axios，gone 守卫是唯一允许触及的会话逻辑例外。
- `docs/specs/mail-share/design.md:578-588`：gone 为 HTTP 404 空 body；429 是可恢复运输层错误，客户端须按 `Retry-After` 退避。
- `.agent-workspace/review-ledger/runs/2026-08-28-r1/reviewer-l0-l1.md:3-12,46-49`
- `.agent-workspace/review-ledger/runs/2026-08-28-r1/themes.md:96-131`

## 4. Conclusion

`NEEDS_CHANGES`：P2 × 1。`/s/<lid>` 与 `/S/<lid>` 会进入同一个 ShareView 和同一套匿名初始化，页面内容与状态层级一致；但文档入口命中 429 时在 SPA 加载前返回空 body，设计卡规定的 limited 警告横幅不可达，普通访客无法获得“可恢复、稍后重试”的信息。该 finding 与 `raw/cross-theme.md` Finding 2 是同一 identity，主审应去重计数。

## 5. Findings

### UI-T3-F1 · 文档层 429 没有可恢复状态，用户无法可靠地区分于 gone 404

- severity: P2
- anchor: `mail-worker/src/security/share-rate-limit.js:95`
- symbols: `enforceShareRateLimitOnRequest`, `shareDocumentIfGone`, `nativeGoneResponse`, `routes[name='share']`, `isAnonymousShareVisit`, `.share-wait`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md:39` 要求 gone 走原生 404、不得画业务 gone 页，`:40` 同时要求 limited 呈现警告横幅；`docs/specs/mail-share/design.md:584-588` 将任何 429 定义为可恢复运输层错误，客户端须按 `Retry-After` 退避。
- identity_scope: 浏览器直接导航或硬刷新 `/s/:lid`、`/S/:lid` 时的顶层文档 429；不包含 SPA 已加载后访客 API 429 的既有页内横幅。
- failure_mode: 文档请求先经过 `shareDocumentIfGone`，限流拒绝后由 `enforceShareRateLimitOnRequest` 直接返回 `Response(null, { status: 429 })`，assets、Vue Router、`init()` 和 ShareView 均不会运行。因此 `mail-vue/src/views/share/index.vue:16,36-40` 已设计的“尝试次数过多 / 请稍候再试”标题与横幅在该入口不可达；用户得到的文档没有业务 DOM、恢复说明、重试动作或等待反馈。gone 入口同样返回空 body 404。即使不同浏览器可能为 404 绘制不同的原生外壳，429 仍没有应用层可恢复语义，普通用户不能可靠判断“稍后可恢复”与“链接永久不存在/已销毁”。
- trigger: 一条仍有效的分享在文档 GET/HEAD 阶段命中 limiter，随后访客打开、刷新或重新载入该链接；小写与大写入口都会触发同一空 429。
- impact: 访客会把暂时受限误判成链接失效或页面故障，无法知道应等待多久，也没有可执行的恢复路径；P0 收码任务在页面挂载前被截断。
- required_fix: 在最早产生顶层文档响应的责任层补齐可消费的 limited 状态：429 必须得到不依赖既有 SPA 的最小恢复文档或等价浏览器层重试机制，明确“暂时受限”、消费 `Retry-After` 并可恢复到原分享；gone 404 继续保持无业务 HTML。不能只改当前根本不会被加载的 ShareView 横幅。
- verify: 在同一浏览器、同一有效 lid 上分别导航 `/s/<lid>` 与 `/S/<lid>`，令文档 limiter 拒绝，断言两者都出现明确的暂时受限说明并按 `Retry-After` 恢复；再令同一 lid gone，断言仍为原生 404 且无业务 DOM。当前仅完成静态响应链取证，未执行浏览器运行时验证。
- risk_spread: `gone-vs-limited-distinguishability`；origin=`share-rate-limit.js:enforceShareRateLimitOnRequest` → hop 1=`share-document-gone.js:shareDocumentIfGone` 与未被加载的 Router/ShareView；在确认“顶层 429 无 limited consumer”后停止，未进入限流实现与数据库。
- related_review: `raw/cross-theme.md` Finding 2（同一用户影响，主审去重）

## 6. Verified with no finding

- 大小写入口的业务页面一致：`mail-vue/src/router/index.js:69-72` 将 `/s/:lid` 与 `/S/:lid` 绑定到同一个命名路由和同一个 `@/views/share/index.vue`；`mail-vue/src/init/init.js:18-19,34-35` 对匿名访客使用大小写不敏感判定，两种写法都跳过站点配置初始化。没有一条写法落登录页、另一条落分享页的视觉分叉。
- `alias` 不会改写地址栏，所以用户输入 `/S/...` 后仍会看到大写、书签也会保留该拼写；这是可观察差异，但两者的 lid、组件、文案和状态层级相同。设计卡没有“必须把地址栏归一成小写”的条款，不能仅凭拼写未重写成立 finding。
- SPA 能成功挂载时，limited 与 gone 的信息层级本身清楚：`mail-vue/src/views/share/index.vue:16,36-40,1267-1275` 使用页内警告横幅，gone 不进入业务卡；问题仅是顶层文档 429 绕过了这套状态。
- 空收件箱仍是有等待语义的一等空态，而不是错误页：`mail-vue/src/views/share/index.vue:151-155,1277-1295` 保留“新邮件会自动出现”的文案和独立等待卡。T3 路由/初始化改动没有改变 OTP、邮件列表或空态的视觉优先级。
- `F-0022` 的原 identity 未复现：大小写两种入口在 Router 与匿名初始化层已收口；本 Lens 不评价 Worker 正则或 gone 查询的代码正确性。

## 7. Risk spread and exclusions

- risk_spread 仅使用 T3 的 `gone-vs-limited-distinguishability` 预算，并在文档响应到用户可见状态这一跳停止。
- 未审限流绑定、IP key、配额共享、D1 或响应头侧信道；未把 T4 的 `F-0027` / `F-0029` 空间布局问题重复计入 T3。
- 按本 Lens 的 read-only / 不审代码正确性约束，本轮只做静态视觉状态链取证，没有运行项目测试或修改业务代码。
