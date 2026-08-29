# T3 · high-risk 独立审查

## 1. verdict

`NEEDS_CHANGES`：1 条 P2 可用性/恢复协议 finding。`/S/` 与 `/s/` 的 Worker 拦截、匿名初始化和 Vue 路由已对齐；404/429 可区分本身符合运输层契约，不另报 finding。

## 2. findings

### T3-F1 · API 读流量可挤掉同一访客的文档刷新，而空 429 没有能执行退避的客户端

- severity: P2
- anchor: `mail-worker/src/security/share-document-gone.js:69`
- symbols: `shareDocumentIfGone`, `enforceShareRateLimitOnRequest`, `SHARE_READ_RATE_LIMITER`, `pollTick`, `beginMailbox`, `selectTab`, `useSharePolling`
- rule_source: `docs/specs/mail-share/design.md:584-588` 的 P-TRANS-01 要求任何 429 都携带 `Retry-After`，且客户端按其退避重试；`docs/specs/mail-share/requirements.md:152-154,323-324` 要求访客把 429 当作可恢复运输层错误而不是永久失效；`docs/specs/mailbox-share-capability/requirements.md:67` 允许一条分享最多 50 个 Binding。
- identity_scope: `/s/:lid` 顶层文档导航与已加载 Visitor SPA 的读 API 共用同一 IP 限流桶时的可用性和恢复责任。
- failure_mode: 文档 `GET|HEAD /s/:lid` 在 assets 之前消费 `SHARE_READ_RATE_LIMITER`；同一 binding 也保护 `/share/mails`、`/share/mailboxes/status`、`/share/mail`、`/share/attachment`，配置仅为 100 次/60 秒。一个契约内合法的 50-Binding 页面可在 60 秒内形成 1 次文档请求、最多 40 次首个 Binding 的 catch-up、20 个 3 秒 poll tick × 每 tick 2 次读请求、其余 49 个 Tab 的首次读取，共 `1 + 40 + 20×2 + 49 = 130` 次；该数尚未计入手动刷新、详情和附件。桶耗尽后，刷新页面或 gone 退场 reload 会在第 69-75 行直接得到空 body 429，SPA 尚未加载，页面内读取 `Retry-After` 的逻辑无从执行。
- trigger: 同一 `CF-Connecting-IP` 下，访客打开一条允许的 50-Binding 分享，首个 Binding 有至少 40 个满页待追赶，并在同一 60 秒窗口内依次首次查看其余 Tab；随后刷新页面。共享 NAT 下不需要单页达到该上界也会更早触发。
- impact: 活链接暂时显示为无业务 DOM 的顶层 429；虽然响应头声明 60 秒后可重试，但浏览器页面中没有代码或操作提示执行该恢复。终态 404 与可恢复 429 在产品恢复路径上都只剩浏览器错误页，P-TRANS-01 的“客户端退避重试”对文档入口不可达。
- required_fix: 在最早的文档运输层先定清恢复契约：文档存在性检查不得与 SPA 高频 API 共用同一 namespace/容量，或须为文档额度保留不会被 API 消耗的预算；若文档入口仍可能返回 429，则必须由不依赖既有 SPA 的第一方最小响应或等价浏览器层机制读取 `Retry-After` 并重试。若坚持空 body 且不自动恢复，则应显式修改 P-TRANS-01，不能继续声称客户端会退避。
- verify: 用同一 `CF-Connecting-IP` 在真实 Workers/Rate Limiting 环境先消费 API 读额度，再导航到一条 ACTIVE `/s/:lid`；修复后应证明 API 流量不能截断文档入口，或顶层 429 会按 `Retry-After` 自动恢复并最终加载该 ACTIVE 分享。另用 50-Binding、40 个满 catch-up 页的页面记录 60 秒请求瀑布，读桶不得超过其设计容量。
- risk_spread: `share-read-quota-contention`；origin=`share-document-gone.js` 的文档入口新增消费 → hop1=`share-rate-limit.js`/`share-api.js` 共用 `SHARE_READ_RATE_LIMITER` → hop2=`useSharePolling.js` 的 3000ms 调度及页面 `pollTick` consumer；得到有界合法场景 `130 > 100` 后停止，未进入 session/reveal limiter。

## 3. share-read-quota-contention

| 60 秒内的消费 | 次数 | 依据 |
|---|---:|---|
| 顶层文档 `GET /s/:lid` | 1 | `share-document-gone.js:58-75` |
| 首个 Binding 初始 catch-up | 40 | `views/share/index.vue:291-292,1015-1035` |
| 自动轮询 | 40 | `useSharePolling.js:10,169-175`；页面一拍为 status + mails（`index.vue:471-488`），20 拍 × 2 |
| 其余 49 个 Binding 首次打开 | 49 | Binding 上限 50；未缓存 Tab 在 `index.vue:640-670` 各读一次 mails |
| 合计 | **130** | 超过 `wrangler.toml:18-20` 的 **100/60s**，多 30 |

补充边界：

- `POST /share/session` 使用独立 `SHARE_SESSION_RATE_LIMITER`，不计入上述 130。
- 单 Binding 即使有 40 个满 catch-up 页，有界后台上界为 `1 + 40 + 20×2 = 81`；空邮箱常见路径为 `1 + 1 + 20×2 = 42`。因此不是所有普通打开都会自限流，触发点是仓库明确支持的上限规模与合法交互组合。
- 130 是未计手动刷新、详情、附件的保守有界数，不是交互驱动请求的绝对上限。

## 4. gone-vs-limited-distinguishability

| 形态 | body | 应用代码明确设置的响应头 | 用户恢复路径 |
|---|---|---|---|
| gone 文档/API 404 | 空 | `Cache-Control: no-store`；`Referrer-Policy: no-referrer`；`X-Robots-Tag: noindex, nofollow` | 终态，无重试指示 |
| 文档入口 429 | 空 | `Cache-Control: no-store`；`Retry-After: 60` | 协议称可恢复，但 SPA 未加载，当前无执行者 |
| 已加载 SPA 的 API 429 | JSON `RATE_LIMITED` | `Cache-Control: no-store`；`Retry-After: 60` | `request/share.js` 翻成 `ShareRateLimitedError`，`useSharePolling.js` 可按头退避 |
| ACTIVE/EXPIRED 的 assets 200 | HTML | Worker 在 `index.js:33` 直接透传 `env.assets.fetch(req)`，自身不补头；`mail-vue/public/_headers:13-17` 只声明 `/s/*` 的 `no-store`、`no-referrer`、`noindex,nofollow`、CSP | SPA 能加载，API 429 才有页内恢复 |

结论：

- 404 与 429 不只头集合不同，HTTP 状态本身也不同；这种可区分性是 P-TRANS-01 明定的必要性质，不应为了“同貌”抹掉 `Retry-After`。
- 限流发生在 D1 查询前；命中后任意形状合法的 `/s/:lid` 都先返回同一 429，故这组头不会继续泄露具体 lid 是 ACTIVE 还是 gone。它会表明该路径受限流，但 `/s/` 本来就是公开 Share URL 形态，不形成独立 finding。
- 真正的产品缺口不是“机器分不清”，而是“机器能凭头分清，顶层浏览器却没有客户端把 `Retry-After` 变成恢复动作”，已并入 T3-F1。
- assets 200 的生产头全集无法由仓内代码闭合：现有 E2E `tests/e2e/specs/visitor-headers.spec.js:5-33` 在 `_headers` 未应用时直接标 deploy-time 后跳过；Cloudflare 当前 Static Assets 文档也说明 `_headers` 只约束静态资产响应，不应把 Worker-first 动态响应当作已验证。这里记录为既有部署验证缺口，不用不确定事实另开 finding。

## 5. case-insensitive-share-path

按 `/s/` 判分享入口的实现点已枚举：

| 层 | 当前判定 | `/S/` 结果 |
|---|---|---|
| Worker 文档拦截 | `share-document-gone.js:15` 的 `^/s/([^/]+)/?$` 带 `/i` | 与 `/s/` 同样先限流，再查 gone |
| Vue router | `router/index.js:69-72`：主 path `/s/:lid` + alias `/S/:lid` | 同一个 `name='share'` 组件；alias 不是 redirect，地址栏保留原大小写 |
| 匿名初始化 | `init/init.js:18-20` 的路径正则带 `/i` | 与 `/s/` 同样跳过登录态 `websiteConfig()` |
| URL 生产 | `mail-worker/src/service/mail-share-service.js:587-588` | 只生成规范小写 `/s/<lid>#<sec>` |
| E2E | `tests/e2e/` 中分享 URL 全为小写 `/s/` | 无 ACTIVE `/S/` 的部署级导航/响应头用例 |

因此 `/S/` 与 `/s/` 在本轮要防的 404 绕过、限流和 SPA 路由上是同一入口，历史 F-0022 不重开。规范 URL 仍由服务端统一生成为小写；alias 未做规范化跳转不违反现有契约。

剩余验证缺口限于 ACTIVE `/S/` 的 assets 200 安全头：`public/_headers` 写的是 `/s/*`，仓库既没有 `/S/*` 声明，也没有真实部署用例证明平台匹配是否大小写无关；在没有运行时证据时不判定为差异 finding。

## 6. verification

- 实读当前实现与判据：`share-document-gone.js:15,39-47,58-86`、`share-rate-limit.js:31-35,70-101`、`share-api.js:61-116`、`wrangler.toml:12-29`、`useSharePolling.js:10,137-186`、router/init 与相关 requirements/design。
- 实跑纯计算探针，输出：`{"document":1,"catchup":40,"ticks":20,"perTick":2,"tabs":49,"total":130,"limit":100,"overBy":30,"singleActiveBinding":81}`。
- 实跑限定目录文本枚举；Worker 实现只发现 `SHARE_DOC_PATH` 与小写 URL producer，router/init 各发现一个大小写入口判定；E2E 分享导航全部使用小写。
- 复核 `9b6eb807..083c87f` 的 T3 diff：大小写修复落在 Worker/router/init；限流改动只落在文档拦截与共用限流 helper，没有为顶层 429 增加恢复 consumer。
- 当前测试源码钉住空 404、空 429、`Retry-After` 及 `/S/` gone 路径，但没有“API 桶耗尽后导航 ACTIVE 文档仍可恢复”的用例，也没有 ACTIVE `/S/` 的部署级用例。
- 按 read-only 约束未运行可能写缓存/测试数据库的项目测试，未修改业务代码。

## 7. stop_when

- `share-read-quota-contention`：已得到一个契约内合法、有界且不含手动刷新/附件的单页数值 **130 vs 100/60s**，命中 stop_when；未展开 session/reveal limiter。
- `gone-vs-limited-distinguishability`：已列明应用构造的 404、文档 429、API 429 与 assets 200 头责任；确认头差异符合运输层分族，恢复 consumer 缺失已归入 T3-F1，命中 stop_when。
- `case-insensitive-share-path`：已枚举 Worker、router、init、URL producer 与 E2E 的全部 `/s/` 判定/生成点；确认 `/S/` 不再绕过 gone/limited，命中 stop_when。
- 审查到此停止。
