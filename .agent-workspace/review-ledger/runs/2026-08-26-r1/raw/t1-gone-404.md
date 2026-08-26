## Findings

### F1 · 裸文档入口绕过现有匿名限流，每个猜测 lid 都直达 D1

- evidence: `mail-worker/src/index.js:16-33` 只把 `/api/*` 交给 Hono，`/s/:lid` 在 assets 前直接调用 `shareDocumentIfGone`；`mail-worker/src/security/share-document-gone.js:41-58` 对每个匹配的匿名 GET/HEAD 执行 `SELECT status FROM mail_share WHERE lid = ?`。现有限流只以 Hono 中间件形态存在于 `mail-worker/src/api/share-api.js:61-109`，`mail-worker/src/security/share-rate-limit.js:74-81` 也要求 Hono `c`；`mail-worker/wrangler.toml:12-20` 只有 session/read 两个绑定，没有文档入口绑定。
- severity: high
- anchor: `mail-worker/src/security/share-document-gone.js:41-58`; `mail-worker/src/index.js:16-33`; `mail-worker/src/api/share-api.js:61-109`; `mail-worker/wrangler.toml:12-20`
- symbols: `shareDocumentIfGone`, `SHARE_DOC_PATH`, `shareRateLimit`, `SHARE_SESSION_RATE_LIMITER`, `SHARE_READ_RATE_LIMITER`
- rule_source: `docs/specs/mail-share/requirements.md:304-308`（Requirement 9 的 token 枚举与滥用防护目标）；`docs/specs/mail-share/requirements.md:323-324`（边缘限速及 429 独立运输语义）；`docs/specs/mail-share/requirements.md:83-86`（gone 404 只改变结果族）
- identity_scope: 任意未认证网络来源 × 任意非空单段 lid × 文档 GET/HEAD
- failure_mode: 请求不带 `sec`、sessionToken 或任何身份凭据，且没有来源限速；每次请求固定产生一次 D1 查询。响应同时以 404 与 assets 200 区分“无行/REVOKED”和“存在且非 REVOKED”。
- trigger: 同一来源连续请求 `/s/<随机单段>` 或对应 HEAD。
- impact: 攻击流量按请求数线性消耗 D1 读与 Worker 执行资源；API 上的 10/60、100/60 两个限流绑定完全不覆盖该路径，gone 改造新增了一个无限速数据库入口。
- required_fix: 在执行 D1 查询前给裸 `/s/:lid` 入口接入按 `CF-Connecting-IP` 计数的边缘/Workers 限流，并让超限直接返回 429 + `Retry-After`、不触碰 D1；文档入口使用独立 binding，避免与已建立 Session 的读配额互相挤占。
- verify: 注入拒绝型 limiter 后连续 GET/HEAD `/s/x`，断言 429、`Retry-After`、D1 `prepare` 调用数为 0；允许型 limiter 下分别断言 missing/REVOKED 为 404 空 body、ACTIVE/EXPIRED 继续 assets，且每次最多一次索引查询。

### F2 · gone 优先级没有覆盖功能关停与凭据版本失配

- evidence: `mail-worker/src/service/share-auth-service.js:600-613` 在查行前先执行 `isShareDisabled`，所以功能关闭时 missing/REVOKED 直接抛 `SHARE_UNAVAILABLE`；`mail-worker/src/service/share-auth-service.js:692-719` 在查行前同样先判功能关闭，并在 `assertAllowed` 的 REVOKED 判定前先判 `credentials_version`，所以“已撤销且 token 版本旧”也返回 `SHARE_UNAVAILABLE`。`assertAllowed` 自身在 `mail-worker/src/service/share-auth-service.js:367-377` 声明 REVOKED 优先，但两个前置短路使该优先级不完整。
- severity: high
- anchor: `mail-worker/src/service/share-auth-service.js:600-613`; `mail-worker/src/service/share-auth-service.js:692-719`; `mail-worker/src/service/share-auth-service.js:367-377`
- symbols: `establishSession`, `resolveSession`, `isShareDisabled`, `assertAllowed`, `throwDestroyed`, `throwUnavailable`
- rule_source: `docs/specs/mail-share/requirements.md:83-86`（无行或 REVOKED 固定为 404，功能关闭属于 unavailable）；`docs/specs/mail-share/requirements.md:108-110`（销毁后再次访问固定 404）；`docs/specs/mailbox-share-capability/requirements.md:106-107`（gone 与其余 Visitor 失败分族）；`docs/specs/mailbox-share-capability/requirements.md:208-210`（已打开页在撤销后的下一次请求走 404 恢复）；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md:3-14`
- identity_scope: 未建 Session 的 Visitor（lid+sec）与持有效签名 token 的 Visitor；资源范围均为同一 MailShare
- failure_mode: 同一个 gone 事实因并存状态不同而跨族：功能开关关闭会遮蔽 missing/REVOKED；旧 token 的 `credentials_version` 失配会遮蔽 REVOKED。API 因此返回 HTTP 200 `SHARE_UNAVAILABLE`，而同一 lid 的文档入口返回 404。
- trigger: `SHARE_ENABLED=0` 时请求不存在或已撤销 lid；或一枚旧版本 token 对应的行在版本递增后又被撤销。
- impact: 文档入口、访客 API、已打开 SPA 不再同时终结；已打开页停在业务不可用态，不执行 `handleShareGone` 的清凭据、单次 reload 与原生 404 交接，直接违背本主题的终局契约。
- required_fix: 明确并实现 Visitor 失败优先级。`establishSession` 先查行并处理 missing/REVOKED，再处理功能冻结；`resolveSession` 在 token 验签与行定位后先处理 missing/REVOKED，再处理功能冻结与 `credentials_version`。`row.lid !== payload.lid` 继续保留 unavailable，避免把凭据绑定损坏扩成 gone。
- verify: 增加交叉矩阵：missing/REVOKED × `SHARE_ENABLED` 开/关、REVOKED × cv 相同/失配，全部断言 404 空 body；ACTIVE/EXPIRED × 功能关闭仍断言同一个 `SHARE_UNAVAILABLE` 信封；有效 ACTIVE 的错 sec 与 EXPIRED 的错 sec 继续逐字节一致。

### F3 · 前端把任意 HTTP 404 当成 gone，且误判标记在成功恢复后仍不清除

- evidence: `mail-vue/src/request/share.js:3-5` 允许通过 `VITE_BASE_URL` 接入不同 API origin；`mail-vue/src/request/share.js:162-174` 仅检查 `status === 404`，不验证响应来自 `nativeGoneResponse`，随后构造 `ShareGoneError`。`mail-vue/src/views/share/session.js:82-103` 写入 `share:gone:<lid>` 后没有对应清除函数；`mail-vue/src/views/share/index.vue:785-798` 对该错误清空当前会话，第一眼 reload、第二眼直接清空整个文档。
- severity: medium
- anchor: `mail-vue/src/request/share.js:3-5`; `mail-vue/src/request/share.js:162-174`; `mail-vue/src/views/share/session.js:82-103`; `mail-vue/src/views/share/index.vue:785-798`
- symbols: `shareHttp`, `ShareGoneError`, `markShareGone`, `handleShareGone`, `reloadShareDocument`, `blankShareDocument`
- rule_source: `docs/specs/mail-share/requirements.md:83-86`（只有无行/REVOKED 属 gone 404）；`docs/specs/mailbox-share-capability/requirements.md:208-210`（只有撤销分支触发 reload/清文档恢复）；`.agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md:14-16`
- identity_scope: 单个浏览器 tab × 单个 lid × `sessionStorage` 中的 session/establish/gone 三组键
- failure_mode: API 网关、反代或版本不匹配返回的普通 404 与后端 gone 404 在客户端不可区分。活分享收到该运输层 404 后也会被清 token、打 gone 标、reload；同一 lid 再收到一次普通 404 时直接执行 `document.documentElement.innerHTML = ''`。后续请求成功不会删除旧 gone 标记。
- trigger: 任一 `shareHttp` 固定端点在活分享上收到非 `nativeGoneResponse` 的 HTTP 404。
- impact: 运输层路由故障被提升为不可逆业务终局；活链接在当前 tab 被清凭据并进入 reload/空文档路径，且遗留标记放大后续一次 404。
- required_fix: 给 Worker 生成的 gone 响应增加专用不可伪混的响应标记，并让拦截器只在“404 + 标记”时构造 `ShareGoneError`；普通 404 保留原 Axios 错误。增加 `clearShareGone(lid)`，在成功建立/恢复 Session 或任一证明分享仍活着的响应后删除旧标记。
- verify: 客户端测试分别注入无标记 404 与带 gone 标记的 404：前者不 reload、不写 `share:gone:*`，后者保持单次 reload；预置 gone 标记后完成一次成功 Session，断言标记被删除，下一次带标记 gone 仍从 reload 开始而非直接 blank。

### F4 · 裸 404 绕过 `/s/*` 的 Referrer-Policy、X-Robots-Tag 与 CSP

- evidence: `mail-worker/src/security/share-document-gone.js:29-30` 构造的响应只有 `Cache-Control: no-store`；`mail-worker/src/index.js:28-31` 直接返回该响应，不再进入 `env.assets.fetch`。仓库对 `/s/*` 声明的完整头集合位于 `mail-vue/public/_headers:13-17`。改后的 `tests/e2e/specs/visitor-headers.spec.js:3-33` 只探测 ACTIVE 的 assets 响应，missing/REVOKED 的裸响应不在断言内。
- severity: medium
- anchor: `mail-worker/src/security/share-document-gone.js:29-30`; `mail-worker/src/index.js:28-31`; `mail-vue/public/_headers:13-17`; `tests/e2e/specs/visitor-headers.spec.js:3-33`
- symbols: `nativeGoneResponse`, `shareDocumentIfGone`, Worker `fetch`, `/s/*` headers rule
- rule_source: `docs/specs/mail-share/requirements.md:295-300`（AC-LEAK-02..04）；`docs/specs/mail-share/design.md:129-142`（匿名 Bootstrap 的 `/s/*` 文档头边界）
- identity_scope: 所有直接导航到 missing/REVOKED `/s/:lid` 的匿名浏览器，包括 GET 与 HEAD
- failure_mode: Worker 自建 404 不消费 assets `_headers`，因此响应仅满足 no-store，缺失 `Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow` 与分享文档 CSP。
- trigger: 直接 GET/HEAD 一个不存在或已撤销的 `/s/:lid`。
- impact: gone 文档脱离仓库为 `/s/*` 规定的泄漏与索引控制；现有 header E2E 改打活链接后无法捕获该回归。
- required_fix: 把分享文档安全头收敛为 Worker 可复用的响应头构造器，并让 `nativeGoneResponse` 带齐 no-store、no-referrer、noindex/nofollow 与分享文档 CSP；若 API 404 不承载文档头，则为文档/API 两种调用显式区分参数，禁止依赖 assets `_headers` 补 Worker 直返响应。
- verify: 对 missing 与 REVOKED 的 GET、HEAD 分别断言 404、空 body 及四类安全头；保留 ACTIVE `/s/:lid` 的头探针，形成 Worker 直返与 assets 两条路径的并列覆盖。

## 其余逐项查证

- review_focus #2 的剩余时序对：`mail-worker/src/service/share-auth-service.js:606-617` 对 ACTIVE 与 EXPIRED 的错 sec 都先执行同一个 `matchSec` 并在失配处分流，未发现这两者的时序分叉；gone 的复合状态优先级缺口已记 F2。
- review_focus #3：`mail-worker/src/security/share-document-gone.js:49-58` 的 D1 异常确实 fail-open；`share:gone:<lid>` 无清除路径的后果已并入 F3。
- review_focus #4：`mail-vue/src/request/share.js:184-228` 的 `shareHttp` 承载集合恰为 session、mails、mailboxes/status、mail、attachment，服务端对应路由均在 `mail-worker/src/api/share-api.js:61-116` 经 `withShare`；404 来源鉴别缺口已记 F3。
- review_focus #5：Worker 匹配为 `mail-worker/src/security/share-document-gone.js:8-22` 的单段 `/s/:lid`，SPA 路由为 `mail-vue/src/router/index.js:69-71`；生产 lid 由 `mail-worker/src/service/mail-share-service.js:90-94` 生成 base64url，不含 `/`。query 不进入 `URL.pathname`，尾斜杠与一次 percent decode 已覆盖，未发现 SPA 可命中而文档拦截逃逸的生产 lid 形态。
- review_focus #6：缺失安全头已记 F4。
