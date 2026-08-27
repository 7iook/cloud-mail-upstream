# T1 · high-risk 独立审查

## 1. verdict

`NEEDS_CHANGES`：1 条 P2 文档入口契约违例；`SHARE_DESTROYED` 错误码逃逸与 Owner 面裸 404 两条风险已闭合。

## 2. findings

### T1-HR-F1 · 大写 `/S/:lid` 能进入分享 SPA，却绕过 gone 文档拦截

- severity: P2
- anchor: `mail-worker/src/security/share-document-gone.js:10`
- symbols: `SHARE_DOC_PATH`, `parseShareLidPath`, `routes[name='share']`, `shareDocumentIfGone`
- rule_source: `docs/specs/mail-share/requirements.md:86` AC-VISIT-04 要求文档 `GET|HEAD /s/:lid` 的 gone 入口返回原生 HTTP 404 空 body；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md:7-8` 将 GET/HEAD 文档入口列为全量收口项。实际 Vue Router 匹配器把 `/S/dead` 解析为 `name='share'`，因此它属于当前 SPA 的可达分享路由形态。
- identity_scope: `ShareDocumentGone/ReachableShareRoutePathSet`
- failure_mode: Worker 的 `SHARE_DOC_PATH` 是大小写敏感正则，只接受小写 `/s/`；前端 `/s/:lid` 路由未启用大小写敏感匹配，默认同时接受 `/S/:lid`，两侧路径集合存在确定差集。
- trigger: 浏览器直接 GET 或 HEAD `/S/<不存在或已销毁的 lid>`（query/hash 不影响该差集）。
- impact: `mail-worker/src/index.js` 不会调用 gone 查询命中 404，而会把请求交给 `env.assets.fetch`；`wrangler.toml` 的 SPA fallback 因而返回业务 SPA 文档而非原生 404，销毁/不存在 URL 的文档终局契约未兑现。
- required_fix: 统一 Worker 与 Vue Router 的路径大小写策略，使每个会被解析为 `name='share'` 的单段路径都先经过 gone 拦截，并用 GET/HEAD 的大小写路径矩阵固定两侧集合相等。
- verify: `node --input-type=module -e "import {createRouter,createMemoryHistory} from '/workspace/mail-vue/node_modules/vue-router/dist/vue-router.mjs'; const r=createRouter({history:createMemoryHistory(),routes:[{path:'/s/:lid',name:'share',component:{}}]}).resolve('/S/dead'); const worker=/^\\/s\\/([^/]+)\\/?$/.test('/S/dead'); if(r.name!=='share'||worker) process.exit(1)"`；期望退出码 `0`（实测 `0`，复现 SPA 接受而 Worker 拒绝的路径差集）。
- risk_spread: `文档拦截面 vs SPA 可达路径`；origin=`share-document-gone.js:SHARE_DOC_PATH`；hop1=`router/index.js routes[name='share'] → index.js shareDocumentIfGone → wrangler.toml SPA fallback`；surfaces=`mail-vue/src/router/index.js, mail-worker/src/index.js, mail-worker/wrangler.toml`；stop=`已定位差集 /S/:lid`。

## 3. gone 码在错误信封里的逃逸路径

- `SHARE_DESTROYED` 只有 `share-auth-service.js:51-53` 的 `throwDestroyed` 产出；调用点为 `:372`、`:613`、`:704`，最终只从 `establishSession` / `resolveSession` 抛出。
- `share-api.js:61,75,93,99,109` 的五个访客 handler 全部由 `withShare` 包裹；`withShare:33-40` 在异常到达 Hono 全局 `onError` 前把该码转换为 `nativeGoneResponse()`。
- `hono/hono.js:9-29` 的 200 JSON 全局错误信封因此不可达；`biz-error.js:1-6` 固定异常名为 `BizError`，满足 `withShare` 的捕获条件。
- stop_when：所有产码调用点均闭合到五个 `withShare` handler，停止追踪；本路径无 finding。

## 4. Owner 面被裸 404 波及

- `assertAllowed` 是 `share-auth-service.js:367-378` 的私有函数，全部调用仅为 `establishSession:663` 与 `resolveSession:719` 两个 Visitor 会话路径。
- `mail-share-service.js` 对 `shareAuthService` 的调用只有 Owner DTO 投影用的纯函数 `effectiveStatus:490` 与凭据摘要 `digestShareSecret`；没有调用 `establishSession`、`resolveSession` 或不可导出的 `assertAllowed`。
- `mail-share-api.js:62-126` 的全部 Owner 端点经自身 `withShare` 返回业务 JSON；该文件不导入 `nativeGoneResponse`，REVOKED 行仍由 Owner 查询投影为 `effectiveStatus='REVOKED'`。
- stop_when：`assertAllowed` / `effectiveStatus` 的调用方已列完，Owner 端点不经过裸 404 转换，停止追踪；本路径无 finding。

## 5. 文档拦截面 vs SPA 可达路径

- 对齐部分：`/s/:lid`、可选尾斜杠、query，以及 fragment 导航均不形成差集；`router/index.js:69-71` 与 `SHARE_DOC_PATH` 都只接受一个动态段，`index.js:28-33` 在 assets 前执行拦截。
- 差集：Vue Router 默认大小写不敏感，`/S/:lid` 仍命中 `name='share'`；`SHARE_DOC_PATH` 无 `i` flag，不命中该形态；随后 `wrangler.toml:50-54` 的 `single-page-application` fallback 返回 SPA。
- stop_when：两侧集合已比较并定位 `/S/:lid` 差集，见 T1-HR-F1；未继续扩展到主题外路径。

## 6. verification

- reviewed HEAD：`9b6eb8072fe73c93518e872037702a2e8e54056b`。
- Vue Router 定点探针：`/s/dead`、`/s/dead/`、`/S/dead` 均命中 `name='share'`；`/s/dead/extra` 不命中；命令退出码 `0`。
- Worker 正则定点探针：只命中前两项，不命中 `/S/dead` 与子段；命令退出码 `0`。
- 静态调用枚举：五个 Visitor handler 均有 `withShare`；`throwDestroyed` 三个调用点均处于 `establishSession` / `resolveSession`；Owner service 无这两个调用。
- 工作树未改业务文件；未执行 git commit。

## 7. stop_when

- `gone-码在错误信封里的逃逸路径`：全部产码点已闭合到 `withShare`，命中停止条件。
- `Owner 面被裸 404 波及`：`assertAllowed` / `effectiveStatus` 调用方已列完且 Owner 端点不在裸 404 路径，命中停止条件。
- `文档拦截面 vs SPA 可达路径`：已定位 `/S/:lid` 差集并形成 T1-HR-F1，命中停止条件。
- 三项均已停止；未复制仓库规则、未重复机械闸门、未越过允许 surface。
