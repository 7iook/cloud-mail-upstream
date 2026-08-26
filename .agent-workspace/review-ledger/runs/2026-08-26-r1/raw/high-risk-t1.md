# T1 · gone 原生 404 · 高风险传播链独立审查

- 被审对象：`/tmp/share-review`，HEAD `9b6eb8072fe73c93518e872037702a2e8e54056b`
- 对比基线：`origin/main...HEAD`
- 审查范围：仅 `gone-oracle-ratelimit`、`frontend-404-overreach`、`gone-sticky-session-flag`
- Findings：**P1 × 2，P2 × 1**

## Findings

### T1-P1-1 · `/s/:lid` 的 gone 查询位于 Hono 限流之外，形成无限速 D1 入口与 lid 状态预言机

1. **证据锚点**：
   - `mail-worker/src/index.js:16-33`：只有 `/api/*` 被交给 `app.fetch`；文档请求在 assets 前直接调用 `shareDocumentIfGone(req, env)`。
   - `mail-worker/src/security/share-document-gone.js:41-58`：每个匹配的匿名 GET/HEAD 都执行一次 `SELECT status FROM mail_share WHERE lid = ?`；无行/REVOKED 返回 404，其他状态继续进入 assets。
   - `mail-worker/src/security/share-rate-limit.js:37-81`：现有限流器是依赖 Hono `c` 与 `c.env[bindingName]` 的中间件。
   - `mail-worker/src/hono/webs.js:1-25`：该 app 只注册 Hono API；没有接管裸文档入口。
2. **触发条件**：任意未认证来源连续请求单段非空路径 `/s/<candidate>`，GET 与 HEAD 均可；无需 `sec`、Session token 或其它凭据。
3. **传播路径/失效机制**：`Worker.fetch` → `shareDocumentIfGone` → D1。该路径在进入 Hono 之前完成查询与返回，因此 API 路由上的 session/read limiter 不可能生效。响应又把“无行或 REVOKED”映射为 404，把“ACTIVE 或 EXPIRED”交给 SPA 响应，攻击者可按状态码区分两族。
4. **边界判定**：文档入口限流归属已确认：当前没有覆盖。到 `index.js`、`share-rate-limit.js`、`hono/webs.js` 即可闭合，不需追入 Owner API。
5. **用户/系统影响**：请求量可线性放大 D1 读取与 Worker 执行成本；同时提供无需 `sec` 的 lid 存在/非 REVOKED 判定。lid 熵只能降低随机命中率，不能限制已泄露候选的验证速度，也不能限制空猜造成的数据库成本。
6. **严重度与置信度**：**P1，高置信度**。控制流没有条件分支可把 `/s/:lid` 导入现有限流中间件，且每次命中路径都明确执行数据库查询。
7. **修复与回归**：在 D1 前为文档入口增加独立、按 `CF-Connecting-IP` 计数的 Workers 限流 binding；拒绝时直接返回 429 + `Retry-After`，不得访问 D1。回归应覆盖 GET/HEAD：拒绝型 limiter 下 `db.prepare` 为 0 次；允许型 limiter 下 missing/REVOKED 为 404，ACTIVE/EXPIRED 继续 assets，且单请求至多一次查询。

### T1-P1-2 · `shareHttp` 把任意运输层 404 升格为 gone，活分享会被清会话并强制 reload

1. **证据锚点**：
   - `mail-vue/src/request/share.js:3-5,152-175`：客户端允许配置 `VITE_BASE_URL`，错误拦截器只检查 `status === 404`，不检查响应来源、响应头或业务标识，随后无条件构造 `ShareGoneError`。
   - `mail-vue/src/request/share.js:184-228`：同一拦截器覆盖五个端点：POST `/share/session`，GET `/share/mails`、`/share/mailboxes/status`、`/share/mail`、`/share/attachment`。
   - `mail-vue/src/composables/useSharePolling.js:122-135,170-185`：轮询把 `ShareGoneError` 作为终局，停表并调用 `onUnavailable`。
   - `mail-vue/src/views/share/index.vue:739-748,776-798,834-851,893-898`：session、轮询、手动刷新和附件链最终都进入 `handleShareGone`；它先清 session/establish key，再 reload 或清空文档。
2. **触发条件**：活分享的任一 `shareHttp` 请求收到非 gone 的 HTTP 404，例如 baseURL/反向代理/滚动发布路由暂时不匹配。当前页面实际消费 session、mails、mailboxes/status、attachment；`getShareMail` 已定义但在 `views/share/**` 内无消费点。
3. **传播路径/失效机制**：普通 Axios 404 → 全局响应拦截器伪装为 `ShareGoneError` → poller 或页面 `noteShareFailure` → `recoverFromUnavailable` 优先走 gone → `handleShareGone` 清掉有效 token 与重放键并 reload。拦截器没有可用于证明“404 确由 gone 判定产生”的信息。
4. **边界判定**：`shareHttp` 端点集合已枚举完。五个端点共用同一无来源鉴别的 404 映射；四个有当前页面消费路径，一个当前未消费。无需进入登录态 axios。
5. **用户/系统影响**：一次代理或部署路由 404 会被提升为不可恢复的业务终局。原 URL fragment 已在首次 bootstrap 时清除，reload 后内存中的 `sec` 也丢失；即使文档入口仍把活 lid 交回 SPA，当前页面也没有 token/secret 可恢复，只能要求用户重新取得原始完整链接。
6. **严重度与置信度**：**P1，高置信度**。误判条件是单一状态码，破坏动作是确定的清凭据加导航；不依赖响应 body 内容。
7. **修复与回归**：让 Worker gone 响应携带专用标识，拦截器仅在“404 + gone 标识”时构造 `ShareGoneError`；未标识 404 保留原 Axios 错误且不得清 token/导航。对五个端点参数化测试普通 404 与 gone 404，并对当前四条消费路径断言前者不 reload、不 blank、不删除 `share:session:<lid>`。

### T1-P2-1 · `share:gone:<lid>` 只写不清，成功重新建会话也无法重置“一次 reload”状态

1. **证据锚点**：
   - `mail-vue/src/views/share/session.js:82-103`：`markShareGone` 首次写 `share:gone:<lid>`，之后永远返回 `blank`；模块没有对应 remove/clear 函数。
   - 对 `mail-vue/src/views/share/**` 的受限检索只有 `markShareGone` 的定义、`index.vue:793` 的调用与测试引用，没有 `clearShareGone` 或 `removeItem(shareGoneKey(...))`。
   - `mail-vue/src/views/share/index.vue:753-760,809-831,1034-1093`：首次建立成功、重建成功、bootstrap 成功均只写 session/清 establish key，不清 gone 标记。
   - `mail-vue/src/views/share/index.vue:785-798`：已有标记时，下一次 gone 直接执行 `blankShareDocument()`，不再尝试文档 reload。
2. **触发条件**：某 lid 曾因 gone 或 T1-P1-2 的普通 404 写入标记；随后用户在同一 tab 重新打开带 fragment 的完整活链接并成功建立 Session；之后该 lid 再收到一次 404。
3. **传播路径/失效机制**：第一次判 gone → sessionStorage 写 `'1'`；后续成功链没有清除点 → 下一次 `markShareGone` 仍读到旧值 → 直接清空 `documentElement`。这个标记记录的是“历史上 reload 过”，却被当成当前生命周期仍处于同一次 gone 恢复。
4. **边界判定**：`share:gone:<lid>` 没有清除路径，stop condition 已命中。标记按 lid 隔离，但生命周期覆盖整个 tab session，而非一次 Session 建立周期。
5. **用户/系统影响**：活分享即使已被一次成功响应证明可用，旧误判仍会改变未来错误处理；后续首个 gone/普通 404 不再交给文档入口生成原生 404，而是直接得到无状态、无 HTTP 404 语义的空白文档。
6. **严重度与置信度**：**P2，高置信度**。缺少清除路径可由完整符号检索确认；影响需要“先写标、后成功、再 404”的复合序列，因此低于直接误判的 P1。
7. **修复与回归**：增加按 lid 清除 gone 标记的唯一入口，并在成功建立/重建 Session，或其它足以证明该 share 当前存活的成功响应后调用。回归应预置 gone 标记，完成一次成功 Session 后断言标记消失；随后注入真正的 gone 404，必须重新从一次 reload 开始，而不是直接 blank。

## 传播链闭合

| 风险链 | 独立结论 | stop condition |
|---|---|---|
| `gone-oracle-ratelimit` | 裸文档入口明确绕过 Hono limiter；每次候选 lid 触发 D1，并以 404/SPA 响应区分 gone 与非 gone | 已确认文档入口无现有限流覆盖 |
| `frontend-404-overreach` | 五个 `shareHttp` 端点全部由仅看状态码的拦截器处理；四个当前页面消费点会进入破坏性 gone 终局，`getShareMail` 当前未消费 | 已枚举端点与页面传播出口 |
| `gone-sticky-session-flag` | 标记只有 set/get，没有任何成功路径上的 remove | 已确认无清除路径 |

## 最终判定

**CHANGES_REQUIRED**。合入前至少需要关闭裸 `/s/:lid` 的无限速 D1/状态预言机，并让前端 gone 判定具备来源标识；否则 T1 的两个高风险失败模式均可达。sticky 标记也应随成功生命周期重置，避免一次历史误判永久改变同 tab、同 lid 的后续终局行为。
