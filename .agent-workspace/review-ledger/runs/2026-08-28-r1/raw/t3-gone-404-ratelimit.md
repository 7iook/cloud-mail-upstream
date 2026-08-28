# T3 · 销毁分享文档入口审查

结论：`NEEDS_CHANGES`（P2 × 2）。

## T3-F1 · 页面内读流量能耗尽文档入口共用桶，刷新停在不可恢复的空 429

- severity: P2
- anchor: `mail-worker/src/security/share-document-gone.js:69`
- symbols: `shareDocumentIfGone`, `enforceShareRateLimitOnRequest`, `SHARE_READ_RATE_LIMITER`, `pollTick`, `beginMailbox`, `selectTab`, `useSharePolling`
- rule_source: `docs/specs/mail-share/design.md:584-588` 的 P-TRANS-01 要求任何 429 都携带 `Retry-After`，且客户端按其退避重试；`docs/specs/mail-share/requirements.md:323-324` 的 AC-ABUSE-08/09 要求 429 是独立、可恢复的运输层错误，不得被当作链接永久失效。`mail-worker/wrangler.toml:17-20` 把共用读桶定为 100/60s。
- identity_scope: 同一访客、同一 `CF-Connecting-IP` 下，顶层 `/s/:lid` 文档导航与已加载 SPA 的四个访客读 API 对同一读桶的消费及恢复责任。
- failure_mode: 文档入口在 D1 查询前消费 `SHARE_READ_RATE_LIMITER`；同一 binding 又被 `/share/mails`、`/share/mailboxes/status`、`/share/mail`、`/share/attachment` 消费。页面已加载时，API 429 可由 `ShareRateLimitedError` 与 `useSharePolling` 退避；页面刷新或 gone reload 命中文档 429 时，assets 与 SPA 尚未加载，空 body 中不存在能读取 `Retry-After` 并重试的客户端。
- trigger: 一条合法的 50-Binding 分享，其当前 Tab 有至少 2000 封待 catch-up 邮件：文档打开 1 次 + `MAX_CATCHUP_PAGES=40` 次列表读 + 60 秒内 20 个轮询 tick × 每 tick 2 次读 = 81；再首次打开其余 49 个 Tab 各读 1 次，页面自身请求上界为 130。第 101 次开始可被 100/60s 桶拒绝，此时刷新同一活链接即在文档层得到空 429。共享 NAT 下多个访客按同一 key 累加，会以更少的单页操作触发同一路径。纯自动轮询的上界为 81，不会单独耗尽该桶。
- impact: 活链接的顶层文档被截成无业务 DOM 的空 429；页面内已有的“请稍候”状态与退避代码不可达，访客只能自行再次导航。该失败是暂时限流，却失去 P-TRANS-01/AC-ABUSE-09 要求的客户端恢复路径。
- required_fix: 在文档入口这一最早的配额责任层把 D1 存在性探测与 SPA API 读流量拆成独立预算，保证同一合法页面的 API 消费不能挤掉其文档导航；同时为顶层文档限流定义无需既有 SPA 即可执行的 `Retry-After` 恢复机制。不得把恢复逻辑补进当前 429 时根本不会加载的访客组件。
- verify: 增加带计数 limiter 的 Worker/E2E 契约：同一 IP 先完成最大 catch-up、轮询与多 Tab 读取，再导航同一活 `/s/:lid`；断言页面 API 配额不截断文档入口，或顶层 429 能按 `Retry-After` 自动恢复到活分享。审查实算输出为 `autoOnly=81,total=130,limit=100,exceeds=true`。
- risk_spread: `share-read-quota-contention`；origin=`share-document-gone.js` 的新增文档消费 → hop1=`share-rate-limit.js` 与 `share-api.js` 的共用常量/四个消费点 → hop2=`useSharePolling` 的 3000ms 调度及页面注入的 `pollTick`；拿到单访客 60 秒上界 130 vs 100 后停止，未展开 session/reveal limiter。

## T3-F2 · `/S/:lid` 活文档绕过小写 `_headers`，与 `/s/:lid` 不是同一响应策略

- severity: P2
- anchor: `mail-vue/src/router/index.js:70`
- symbols: `routes[name=share].alias`, `SHARE_DOC_PATH`, `isAnonymousShareVisit`, `env.assets.fetch`, `mail-vue/public/_headers`
- rule_source: `docs/specs/mail-share/requirements.md:298-300` 的 AC-LEAK-02/03/04 要求分享页分别带 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md:7-8` 又把文档 GET/HEAD 定义为同一分享入口。
- identity_scope: 被 Worker 与 Vue 都认作分享路由的大小写路径集合，在活着/过期而交给 assets 时的缓存与泄露响应策略。
- failure_mode: `SHARE_DOC_PATH`、Vue Router 与匿名初始化都接受 `/S/:lid`，alias 又保留地址栏中的大写路径；但 `mail-vue/public/_headers:13-17` 只声明 `/s/*`。Wrangler 4.90.0 的实际 assets 响应中，小写活链接带 `no-store/no-referrer/noindex/CSP`，同一 live lid 的大写路径返回 `Cache-Control: public, max-age=0, must-revalidate`，且 `Referrer-Policy`、`X-Robots-Tag`、CSP 均缺失；两者正文 ETag 相同。
- trigger: 浏览器以历史书签、手工输入或外部链接打开仍 ACTIVE 或已 EXPIRED 的 `/S/<lid>#<sec>`；gone 请求在 assets 前已被 404 拦截，因此不触发本差集。
- impact: 大写活分享页失去仓库规定的 no-store、referrer 与索引隔离；`lid` 可进入外跳 Referer 与索引面，静态分享壳又被按公开资产缓存。页面虽能渲染，但 `/S/` 与 `/s/` 未达到同一入口的传输契约。
- required_fix: 在文档入口的统一责任层对所有 `parseShareLidPath` 接受的大小写形态应用同一份分享文档头策略，或在进入 assets 前无损规范化到唯一小写 URL；不要仅在 Vue alias 或另一条易漂移的大小写专用规则里补丁式复制。
- verify: 用真实 Wrangler assets 创建一条 live share，分别 GET/HEAD `/s/<lid>` 与 `/S/<lid>`，断言状态、body/ETag 及 `Cache-Control`、`Referrer-Policy`、`X-Robots-Tag`、CSP 全部一致；expired 两种路径也执行同一矩阵。本轮实测：小写 `200 + no-store/no-referrer/noindex/CSP`，大写 `200 + public,max-age=0` 且后三项缺失。
- risk_spread: `case-insensitive-share-path`；origin=`SHARE_DOC_PATH /i` → hop1=`router alias`、`isAnonymousShareVisit /i` 与全仓其余 `/s/` 路径策略点；枚举到 deployed asset policy `mail-vue/public/_headers` 的大小写差集并完成 live HTTP 复现后停止，未扩展成整体路由规范化。

## 其余查证

1. gone 形态：`nativeGoneResponse()` 固定为 404、空 body、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`。真实 Wrangler 请求 `/s/t3-missing-probe` 与 `/S/t3-missing-probe` 均得到相同头和 `bytes=0`；F-0022 未回归。
2. limited 形态：文档 limiter 拒绝固定为 429、空 body、`Retry-After: 60`、`Cache-Control: no-store`。429 与 404 按 HTTP 状态和 `Retry-After` 可区分，这是 P-TRANS-01 明定的独立运输层族；限流发生在 D1 之前，同一 key 下所有合法形状的 `/s/:lid` 均先返回同一 429，因此这组头不泄露某个 lid 是 live、missing 还是 revoked。恢复缺口已归入 T3-F1。
3. 规范 URL：Worker `SHARE_DOC_PATH` 为 `/i`，router alias 与 `isAnonymousShareVisit` 同步接受 `/S/`；生成与 E2E 固定使用小写 `/s/`。除 T3-F2 的 assets 头策略外，未发现第四处把 `/S/` 送回业务 200 壳的 gone 绕过。
4. binding：`wrangler.toml`、`wrangler-action.toml`、`wrangler-dev.toml`、`wrangler-test.toml` 的 `SHARE_READ_RATE_LIMITER` 名称及 100/60s 数值一致，部署工作流实际使用 `wrangler-action.toml`；当前不存在部署配置名漂移。`wrangler-vitest.toml` 与本地 E2E 配置有意不声明 limiter，靠用例注入 mock。
5. 测试缺口：`share-document-gone.spec.js` 的既有 gone/HEAD 404 用例在无 limiter 状态运行；“limiter 存在且放行”只覆盖 live 200，没有覆盖 allow + gone 404 + 完整头集合。当前实现的顺序仍会返回正确 404，但缺少该真实部署组合的回归锁。

## verification

- `pnpm exec vitest run test/share-document-gone.spec.js test/share-rate-limit.spec.js`：2 files / 34 tests，exit 0。
- Vue 定点：router/init/访客页中 `/S/`、匿名入口及每 tick 两次读的 9 个命中用例通过，exit 0。
- Wrangler 真实 HTTP：missing 的 `/s/`、`/S/` 均为相同空 404；live 的两种路径正文 ETag 相同但安全头差异稳定复现，见 T3-F2。
- 未改业务代码；F-0001、F-0022 均未重开。
