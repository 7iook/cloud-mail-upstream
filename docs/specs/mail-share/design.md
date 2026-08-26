---
# ═══ CORE IDENTITY ═══
slug: mail-share
title: 邮箱临时分享 —— 不交出密码的匿名只读授权与验证码提取
# ═══ LIFECYCLE ═══
status: converged
review_rounds_done: 3
last_review_status: NEEDS_CHANGES
last_review_p0: 1
created: 2026-08-16
last_updated: 2026-08-16
shipped_commit: null
# ═══ RELATIONSHIPS ═══
related_adrs: [docs/architecture/ADR-mail-share-capability-boundary.md]
related_specs: []
supersedes: null
superseded_by: null
rca: null
# ═══ DISCOVERY ═══
tags: [share, capability-url, otp, sandbox-rendering, anonymous-access]
domain: business
one_line: 所有者创建不可猜链接，未登录访客只读授权窗内的邮件与验证码；含沙箱 iframe 全站渲染器改造
---

# Design · mail-share

## Overview

本设计把「分享邮箱」实现为一个独立的 **资源级 capability 授权边界**，而不是在现有全局 `/public/*` 机器令牌上加参数。核心权衡：**分享链接必须携带 per-link 可变状态**（过期、销毁、访问计数），所以无状态 HMAC 签名方案（Rails `signed_id` / Django reset token / Laravel signed URL）不适用——状态必须落库，于是「按 token 定位那一行」不可回避。选定 **lookup-id + secret-verifier 拆分**：`lid` 明文建唯一索引供 O(1) 定位，`sec` 只存 HMAC 摘要，且 `sec` 放在 URL fragment 里。

fragment 这一个决定同时解决三件事：token 不进服务端日志、不进 `Referer`、链接预览机器人天然拿不到内容（bot 不执行 JS）。这是 Bitwarden Send 的已验证做法。

第二个权衡：**实时推送**。经查证 Workers 请求间无共享内存，`email()` handler 无法唤醒任何 in-flight 请求；Queues consumer 是独立调用，KV 跨地区 60s+ 传播。所以「SSE vs 轮询」是伪命题，读侧必然轮询 D1，区别只在轮询藏在哪一层。本期选 **客户端 3 秒增量轮询**（**参照** `mail-vue/src/views/email/index.vue:76-131` 的增量游标思路，**但须新建**带 `onUnmounted` 取消、`visibilitychange`/`document.hidden` 后台暂停与 429 退避的 composable——既有内联 `while(true)` 无卸载清理、无可见性暂停，组件卸载后循环仍在跑）：拿验证码场景 3 秒足够，换掉一整块容量模型、退避、重连风暴与降级契约。**服务端 25 秒长轮询**列为后续升级项（触发条件见 Decision 3）。

第三个权衡（用户 R1 + R2 方案收缩）：正文**双模式**，默认纯文本、可切沙箱 iframe **完整 HTML**。安全策略为 `<iframe sandbox>`（不含 `allow-scripts` / `allow-same-origin`）+ `srcdoc` 内层 CSP `script-src 'none'`，**不做** DOMPurify 式正向白名单净化。由此派生既有缺陷修复——`SafeMailRenderer` **登录态详情页与分享页本期一并交付**（用户 R2 裁决：沙箱方案增量小），替换 `shadow-html` 裸 `innerHTML`。同类产品（临时邮箱）均直接渲染完整 HTML；在本产品定位下过滤排版得不偿失。

## Current-State Inventory (from recon)

| Path | Type | Interface/Fields | Reuse decision |
|---|---|---|---|
| `mail-worker/src/index.js:11-24` | Worker entry | `/api/*` → hono；`/static/`+`/attachments/` → kvObj；否则 assets+SPA fallback | ✅ 复用（`/s/<lid>` 已自动落 SPA，无需改动） |
| `mail-worker/src/hono/webs.js:1-23` | 路由注册 | 21 个 `*-api.js` side-effect import | ✅ 扩展（新增 1 行 import） |
| `mail-worker/src/security/security.js:11-22,96-98` | `exclude` 白名单 | `path.startsWith(item)` 宽泛匹配 | ⚠️ **须改中间件**：Visitor `/share/*` 用精确 `method+path`；Owner `/mailShare/*` 走 JWT + `share:manage`；保留 `/oss/` 等前缀语义（见 Decision 4） |
| `mail-worker/src/security/security.js:101-115` | `/public` 分支 | 单一全局 `KvConst.PUBLIC_KEY`，含可写 `/public/addUser` | ❌ 不复用（管理员级凭据，非资源级） |
| `mail-worker/src/security/user-context.js:5-7` | Owner 身份 | `c.get('user').userId` | ✅ 复用 |
| `mail-worker/src/entity/email.js:3-28` | 邮件表 | `emailId/accountId/userId/code/content/text/isDel/status/createTime` | ✅ 复用（ownership SSOT；**存在 `account_id=0` 脏行**与**两阶段写入**中间态，分享查询须显式排除，见下文） |
| `mail-worker/src/email/email.js:95-131,147` | 邮件摄取 | 先 `status=SAVING`+`isDel=DELETE` 插入，后 `completeReceive` 翻转；`code` 同批写入 | ✅ 参照（分享 Visible Window **须**排除 `SAVING` 与未完成 `isDel`） |
| `mail-worker/src/entity/orm.js:3-5` | drizzle over D1 | `drizzle(c.env.db)` | ✅ 复用 |
| `mail-worker/src/init/init.js:5-34` | 迁移链 | `intDB → v1_1 → … → v3_0`，幂等 ALTER + try/catch 吞异常 | ✅ 扩展（新增 `v3_1DB` 并在 `init()` 注册） |
| `mail-worker/src/service/email-service.js:61-75` | 登录态列表 | 查询含 `email.userId === userId` | ✅ 参照其 ownership 不变量 |
| `mail-worker/src/service/email-service.js:696-702` | `selectById` | **只按 `emailId`+`isDel`，无 owner 条件** | ❌ 分享服务禁止调用（见 Decision 5） |
| `mail-worker/src/service/email-service.js:719` | `latest` | `gt(email.emailId, emailId)` 游标 | ✅ 参照（分享列表同款查询形状） |
| `mail-worker/src/service/ai-service.js:5-51` | LLM 抽码 | 单次 `ai.run`，无 regex 兜底，失败返 `''` | ✅ 保留并存（不改，见 Decision 6） |
| `mail-worker/src/service/ai-service.js:54-67` | `shouldExtractCode` | `aiCodeFilter` = 发件人邮箱/域白名单 | ⚠️ 已知运营陷阱（配了白名单则名单外 `code` 恒空） |
| `mail-worker/src/service/telegram-service.js:64-69` | code 唯一消费者 | 做成 TG `copy_text` 按钮 | ✅ 参照（「只展示部分邮件」的既有先例） |
| `mail-worker/src/api/email-api.js:7-10` | 列表 API | `result.ok(list)` **返回全行，无字段投影** | ❌ 不复用（必须新建投影层） |
| `mail-worker/src/model/result.js:3-4` | 响应封装 | `data ? data : null`，**truthiness 吞 `0`/`false`/`''`** | ⚠️ 见 Decision 7 |
| `mail-worker/src/error/biz-error.js:1-9` | 业务异常 | `code` 默认 501 | ✅ 复用 |
| `mail-worker/src/hono/hono.js:9-28` | 全局 onError | `c.json(...)` **不设 HTTP status** | ⚠️ 业务错误一律 HTTP 200 + body code |
| `mail-worker/src/utils/crypto-utils.js:5-9` | 随机 | `generateSalt` 用 `crypto.getRandomValues` | ✅ 复用（`genRandomPwd` 用 `Math.random`，❌ 禁用于 token） |
| `mail-worker/src/service/verify-record-service.js:54-86` | 计数 | **先读再 +1，非原子**；`clearRecord` 删整表 | ❌ 不复用为限流底座 |
| `mail-worker/src/utils/req-utils.js:3-7` | 取 IP | `X-Forwarded-For` **未拆逗号、无可信代理链** | ⚠️ IP 维度不可靠 |
| `mail-worker/src/const/kv-const.js:1-9` | KV 命名空间 | 5 个前缀 | ⚠️ KV 不用于分享失败计数（AC-ABUSE-04） |
| `mail-vue/src/router/index.js:56-69` | 顶层兄弟路由 | `login`/`test`/`404` 平级于 `layout` | ✅ 复用此形状 |
| `mail-vue/src/router/index.js:98-100` | 守卫 | `if (!token && to.name !== 'login') next({name:'login'})`，**不读 meta** | ⚠️ 必须改（唯一阻断点） |
| `mail-vue/src/layout/main/index.vue:2` | layout 内 | 调 `hasPerm()` | ❌ 分享页不得挂 layout（匿名时抛 TypeError） |
| `mail-vue/src/db/db.js:5,12,21` | Dexie | **模块顶层** `new Dexie(userStore.user.email)` | ❌ 分享页不得导入（匿名时库名 undefined） |
| `mail-vue/src/axios/index.js:12,37-38,73-76` | HTTP 客户端 | 无条件发 `Authorization: null`；401 跳登录；**HTTP 403 `location.reload()` 且早于 `noMsg` 判断** | ❌ 必须新建独立实例 |
| `mail-vue/src/components/shadow-html/index.vue:24-33,66,99` | 正文渲染 | 正则只删 `<body>`；裸 `shadowRoot.innerHTML`；`bodyStyle` 裸插 `<style>`（`}` 可闭合规则注入） | ⚠️ 升级为 SafeMailRenderer（既有漏洞） |
| `mail-vue/src/components/email-scroll/index.vue:85,158-163,670-685` | code UI | 列表徽标 + 右键菜单 + `navigator.clipboard` **零降级** | ⚠️ 抽 composable（仓内已重复 4 处） |
| `mail-vue/src/views/content/index.vue:38-39` | 双分支 | `ShadowHtml v-if="content"` / `<pre>{{text}}</pre>` v-else | ✅ 纯文本分支已转义安全，可作双模式基础 |
| `mail-vue/src/views/email/index.vue:51-54,76-131` | 轮询 | 内联 `while(true)`；**无** `onUnmounted`/`visibilitychange`；卸载后循环仍跑 | ❌ **不可直接复用**；分享页须新建 composable（见 Decision 3） |
| `mail-worker/src/service/r2-service.js:43-56` | 对象读取 | KV/S3 返 `Response`；R2 直返 `R2Object` | ⚠️ 附件端点**须先归一化**返回类型（见 Components） |
| `mail-vue/src/init/init.js:18-24,50-55` | 启动 | locale 探测可复用；`websiteConfig()` **无 catch → 白屏** | ⚠️ 分享页需解耦 |
| `mail-vue/public/_headers` | 头文件源 | `/s/*` 安全头 + 放宽 CSP（T-21）；产物 `mail-worker/dist/_headers` 会被构建覆盖 | ✅ 已扩展（`run_worker_first` 应用时机 **unverified**） |
| `mail-vue/vite.config.js:34-38` | PWA | `globPatterns:[]` `runtimeCaching:[]` `navigateFallback:null` | ✅ SW 不缓存分享页，无需改 |
| `mail-worker/package.json:5-10` + `vitest.config.js` | 测试 | `test` 脚本是 `wrangler deploy`；config 引用缺失文件；`test/index.spec.js` 仍 Hello World | ❌ **测试基础设施实际不存在** |

## Corrected Goal (draft-vs-reality)

| Draft assumption | Reality found | Correction |
|---|---|---|
| 生成一个 URL 即可，主要是 UI 工作 | 授权边界、状态机、投影层、安全渲染器全部缺失 | 独立 bounded context + 新表 + 新投影 |
| 可复用 `/public/*` 做匿名访问 | 它是单一全局可覆盖令牌且含可写端点 | 不扩展，另建资源级授权 |
| Shadow DOM 已隔离不可信 HTML | 规范制定者一手证实只隔样式不隔脚本；且 `bodyStyle` 另有 CSS 注入面 | 沙箱 iframe + 内层 CSP，且**全站共用** |
| 服务端可以净化 HTML | Workers 官方无 DOM 且无计划；DOMPurify 只背书 jsdom，linkedom 组合无背书无先例 | 沙箱只在浏览器内做；本期不做白名单净化 |
| 实时可用 SSE 或需引入 DO | 请求间无共享内存，`email()` 无法唤醒等待者；Free plan 10ms CPU + 1000 内部 subrequest 掐断长连 SSE | **客户端 3 秒增量轮询**（AC-RT-14）；服务端长轮询为后续升级项 |
| OTP 已有置信度可用 | 单次 LLM 调用，只回字符串，无候选集无置信度；且受发件人白名单影响 | 分享页只读 `email.code`；打分器留改进版 |
| 附件加个权限判断即可 | 字节入口在鉴权中间件**之前**按路径读取；key 是跨租户确定性内容哈希；公开 `/oss/` 直链永久有效 | **受控下载端点** `GET /share/attachment`（AC-SEC-20/21）；经 ShareAuthService 鉴权后 Worker 回传字节；**不修**既有 `/oss/*` 缺陷 |
| `max_views` 需要锁或 DO | D1 官方文档：每库单线程串行执行查询 + 隐式事务 | 单条条件 UPDATE 即原子（本期不做，但已验证可行） |
| 现有限流可复用 | 非原子计数 + 清理时删整表；KV 60s 传播且否定结果亦缓存 | Cloudflare 边缘限速；禁用 KV 与 D1 计数表 |
| 加测试即可 | 测试运行器实际不可用 | 必须先搭 vitest + workers pool |

## Decision(s)

- **Decision 1 · Token 方案**：`/s/<lid>#<sec>`，`lid` 128-bit 明文唯一索引，`sec` 256-bit 只存 `HMAC-SHA256(sec, PEPPER)`。拒绝方案：全 token 不加盐 SHA-256 建索引（可行但应用层无可比较对象、时序性质差）；per-row salt（无法索引，实测有人因此 500 请求从 5.1s 劣化到 81.7s）；无状态签名（不承载可变状态）。W3C capability URL 门槛为 120 bits 以上，本方案远超。
- **Decision 2 · `sec` 放 fragment**：浏览器不发送 `#` 后内容。同时得到「不进日志 / 不进 Referer / 预览 bot 免疫」。代价：服务端首屏无法鉴权，必须 JS 二次请求——与本项目 `/s/*` 走 SPA fallback 的现状天然吻合。硬约束（W3C，非最佳实践）：**该页面不得引入任何第三方脚本**，因为脚本能读到含 fragment 的完整 URL。
- **Decision 3 · 客户端增量轮询而非服务端长轮询 / SSE / DO（R3-A3 · 用户 R3 裁决）**：本期 `ShareView` 每 3 秒调用 `GET /share/mails?cursor=<lastKnown>`；页面后台时暂停；游标推进与断线恢复见 AC-RT-12/14。**后续升级项 · 服务端长轮询**：仅当 (1) 需要**稳定亚秒级**延迟，或 (2) 生产实测证明 3 秒轮询不满足业务时，再引入 `GET /share/wait`；届时须补并发容量公式、指数退避+jitter、Worker 重启/429/5xx 降级契约，并以压测作为开工门禁。DO 的增量价值仅是把 3s 变亚秒，却带来「部署即断连」的生命周期语义。
- **Decision 4 · Visitor 端点精确匹配 + 既有前缀路由保留**：现有 `exclude` 用 `startsWith`，加 `/share` 会放行所有 `/share*`。Visitor 分享端点须用精确 `method + path` 枚举；Owner `/mailShare/*` **不**进 `exclude`，走 JWT + `share:manage`（见 `security.js:24-62`、`64-90`）。`/oss/`、`/oauth/`、`/telegram/`、`/init/` 等含动态段的路由**保留**受控前缀语义——禁止 blanket 把整个 `exclude` 改为精确匹配。
- **Decision 5 · 新增 owner-scoped 邮件查询契约**：`selectById` 无 owner 条件且已有两个消费者（`star-service.js:11-20` 自行补判、`email-service.js:247-258` **未补**）。分享服务禁止调用它；本期新增明确的 owner/scope 查询方法，并把 `email-service.js:247-258` 的缺陷单列上报（不在本期修，避免扩大范围）。
- **Decision 6 · OTP 只读邮件域结果（R2-A1 · 用户 R2 收缩）**：分享投影链**只读** `email.code`；非空则展示+复制，为空则不展示。**不做**确定性打分器、双路合并或 HTML 转文本再推断。改进版若需增强，统一抽取应归属邮件摄取链。
  - *2026-08-25*：末句已兑现——摄取链新增确定性提取 + AI 补位，并扩出 `email.verify_link`（验证链接）。**本决策本身不变**：投影层依旧只读、不推断，新字段同样受此约束。详见 `requirements.md` Requirement 5 策略段的后续说明与 Requirement 5.1。
- **Decision 7 · 分享接口自有响应封装**：`result.ok()` 的 truthiness 会把 `0`/`false`/`''` 吞成 `null`，而分享响应含 `views:0`、布尔开关等。分享 API 使用不吞值的封装。
- **Decision 8 · ADR needed? yes** — 理由：确立了一个新的资源级授权边界并明确拒绝复用既有全局 public token，属边界定义型且难以反转的决策。落 Proposed ADR 于 `docs/architecture/`，实现完成后转 Accepted。

## Architecture & Layering

单向依赖，遵循仓内既有分层（api → service → entity/orm）：

```
mail-vue/src/views/share/           匿名页（顶层兄弟路由，不进 layout）
mail-vue/src/request/share.js       独立 axios 实例（不发 token、不跳登录）
mail-vue/src/components/safe-mail/  SafeMailRenderer（登录态与分享页共用）
        │
mail-worker/src/api/share-api.js         公开端点（精确路径集合）
mail-worker/src/api/mail-share-api.js    Owner 端点（走既有 JWT + perm）
        │
mail-worker/src/service/mail-share-service.js   创建/销毁/列表
mail-worker/src/service/share-auth-service.js   lid 定位 + sec 验证 + 状态判定 + 附件鉴权（唯一授权入口）
mail-worker/src/service/share-mail-service.js   Visible Window 内的字段投影
mail-worker/src/service/share-attachment-service.js  受控附件字节回传（**先归一化** r2/kv-obj/s3 返回类型，再回传 Response）
mail-worker/src/service/share-scoped-email-repository.js  不可绕过的范围查询（A3）
        │
mail-worker/src/entity/mail-share.js
```

**反腐层**：Visitor 请求永不进入 `email-service` 的登录态方法；`share-mail-service` 是唯一把 `email` 行转成 Visitor 可见 DTO 的地方。**所有分享鉴权只经 `share-auth-service`**（Globalrules 对应「统一 Share Authorization Layer」）。

### 匿名 Bootstrap 隔离（A7）

`/s/<lid>` 仍走同一 SPA 入口，「不进 layout」不足以证明 `sec` 不会被全局初始化读取或外传。本期采用以下可验证边界：

| 层 | 约束 |
|---|---|
| **路由** | `views/share/index.vue` 为顶层兄弟路由；守卫对 `name==='share'` 直接 `next()`，不触发登录跳转 |
| **入口拆分** | 分享页通过 **独立 async chunk** 加载（`() => import('./views/share/index.vue')`）；该 chunk 的静态导入图 SHALL NOT 含 `db.js`、`layout/**`、`axios/index.js`、`init/init.js` 的 `websiteConfig()` |
| **最小 bootstrap** | 分享页自行调用精简版 `locale` 探测（复用 `init.js` 中的纯函数，不 await 阻塞性配置接口）；`websiteConfig()` 失败不得白屏 |
| **Fragment 清除** | 客户端从 `location.hash` 读取 `sec` 后 **立即** `history.replaceState` 清除 fragment（在任何网络请求与其他模块初始化之前） |
| **Session 存储（R2-F1 · R3-F3 定稿 · 2026-08-17 TTL 裁决）** | 键名 **`share:session:<lid>`**（按 `lid` 隔离，AC-VISIT-13）。同 tab 刷新且**仍处分享路由**可恢复；关闭 tab 失效；不跨 tab。**必须清除**（AC-VISIT-14）：鉴权失败、`SHARE_UNAVAILABLE`（撤销/过期/凭据错等）、Visitor 显式退出。**离开分享路由必须清除**（AC-VISIT-15）：SPA `name !== 'share'` 时立即删键——因 SPA 与 `/login`/layout **同源**，其脚本可读 `sessionStorage`。**硬导航不跑守卫**，token 可残留于同 tab 下一个同源页；`pagehide` 不能补这一刀（刷新也会触发，会打破 AC-VISIT-12）。本期接受该残留：仅同 tab、同源、被 Session TTL（默认 15 分钟）封顶；token 只授予访问者已经换到的只读能力。切换不同 `lid` 时清除旧 `lid` 键、不得误用。fragment 清除后凭 token 继续访问；TTL 过期后须再次提交 `lid`+`sec`（页面内存保留 `sec`，或重开含 `#<sec>` 的原链接），**不得**用过期 token 续期 |
| **CSP** | 分享页**外层** CSP（`mail-vue/public/_headers` 按路径匹配 `/s/*`）：`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' http: https:; img-src 'self' data: blob: http: https:; font-src 'self' data: http: https:; media-src data: blob: http: https:; connect-src 'self'; frame-src 'none'; object-src 'none'` —— **约束分享壳主文档，且被 `srcdoc` iframe 继承**（CSP3 §7.8）。T-21 将 `img`/`style`/`font`/`media` 放宽至 `http:`/`https:`：设计初稿的 `img-src 'self'` 会阻断沙箱 iframe 内远程邮件图片（与 AC-SEC-23 冲突）；完整 HTML 邮件含远程资源为显式产品决策。**unverified**：`run_worker_first = true` 且响应经 `env.assets.fetch` 时，Cloudflare 文档警告 `_headers` **可能不**作用于 Worker 生成的响应——须真实部署确认（AC-LEAK-02~04）。内层 `srcdoc` 文档仍设 CSP `script-src 'none'`（P-SEC-04） |
| **第三方脚本** | 分享页及 `/share/*` 接口 **零** 第三方脚本/遥测（W3C capability URL 硬约束：脚本能读完整 URL 含 fragment） |
| **错误上报** | 分享页不接入 Sentry/GA 等外联；错误仅 `console.error` 本地输出 |
| **构建门禁** | CI 对 `share` chunk 做依赖图断言：不含 Dexie、不含登录态 store |

## Components & Interfaces

### 领域契约：User · Account · Permission（A8）

本仓**无独立 tenant 概念**。不变量如下：

| 实体 | 不变量 |
|---|---|
| **User** | Owner 身份取自 JWT `userId`（`user-context.js:5-7`） |
| **Account** | `account.user_id` 为归属 SSOT；Owner 仅能对 `user_id = 自身` 的 account 创建分享 |
| **MailShare** | `mail_share.user_id` 必须等于目标 `account.user_id`；创建时断言二者一致 |
| **Permission** | 新增单一 perm 种子行（`init.js` v3_1DB）：`share:manage`（创建、列表、销毁）；**默认绑定默认角色**（`role_id = 1`，`is_default = 1`，见 `init.js:486-492`）。**后建自定义角色不会自动继承**——须管理员在角色权限中显式分配，否则 Owner 写操作返回 `SHARE_FORBIDDEN`（AC-MGMT-09） |
| **功能开关** | 管理员后台全局开关；关闭时 Owner 创建返回 `SHARE_DISABLED`，Visitor 返回 `SHARE_UNAVAILABLE`；**临时冻结**——重新开启后旧链接恢复（AC-LIFE-13） |
| **Account 失效** | account **删除**（软删 `account-service.js:158-159`、硬删 `account-service.js:243-246`）后 Visitor 返回 `SHARE_UNAVAILABLE`；**本期**在删除路径挂钩永久撤销相关 MailShare（AC-LIFE-09/12 删除侧）；**account 转移**能力当前不存在——AC-LIFE-12 保留为未来新增转移入口时的必挂钩点，本期不假装已实现 |

**错误码边界**：
- `SHARE_DISABLED`：**仅 Owner 写操作**（创建）在功能关闭时返回；Visitor 侧统一 `SHARE_UNAVAILABLE`。
- `SHARE_UNAVAILABLE`：Visitor 侧非 gone 失败（功能关闭、过期、凭据错）。**无行 / `REVOKED` 走裸 HTTP 404**（P4，2026-08-26）。
- `SHARE_FORBIDDEN`：用户缺少 `share:manage` 权限。
- `SHARE_NOT_FOUND`：Owner 操作他人分享。

Owner 侧（JWT + perm `share:manage`）：
- `POST /mailShare/create` → `{ accountId, name?, remark?, durationSeconds }` → `{ shareUrl, lid, sec, expiresAt }`（`sec` 仅此一次）
- `GET /mailShare/list` → `{ list, total }`
- `DELETE /mailShare/revoke` → `{ shareId }`

~~**本期不做** `PUT /mailShare/regenerate`（revoke + create 已覆盖；R2 regenerate 语义保留为后续约定，见下文「后续 regenerate 约定」）。~~
**2026-08-25 已实现为 `POST /mailShare/regenerate`**（动词由 PUT 改为 POST：每次铸新凭据不是幂等覆盖，与 `resetAuthKey` 同理）。语义按下文「regenerate 约定」原样兑现，AC-SHARE-13 / AC-LIFE-05 / AC-LIFE-11 与 P-LIFE-02 一并重新激活。

Visitor 侧（公开，精确路径）：
- `POST /share/session` → `{ lid, sec }` → `{ sessionToken, mailbox, expiresAt }`（`sec` 仅此一次出现在请求体）
- `GET /share/mails?cursor=&limit=` → 授权窗内分页列表（投影字段）
- `GET /share/mail?mailId=` → 单封详情（投影字段，含 `text` 与 `content`）
- `GET /share/attachment?mailId=&attachmentId=` → 受控附件下载（ShareAuthService 鉴权 + Worker 回传字节）

#### Share Session 安全契约（A1）

| 属性 | 规格 |
|---|---|
| **签发** | `POST /share/session` 验证 `lid`+`sec` 成功后，由 `share-auth-service` 签发 |
| **格式** | 无状态 HMAC 签名令牌（非 JWT 以避免额外依赖）；payload 含 `shareId`, `lid`, `iat`, `exp`, `kid` |
| **承载位置** | `Authorization: Bearer <sessionToken>` 请求头。理由：① 后续请求不携带 `sec`；② 比 Cookie 少 CSRF 面（公开 API 无登录态 cookie）；③ 不进 URL/日志 |
| **绝对有效期** | `exp = min(share.expires_at, iat + SESSION_TTL)`；`SESSION_TTL` 默认 **15 分钟（900s）**，环境变量 `SHARE_SESSION_TTL` 可覆盖，只减不续。选 15 分钟是因为核心场景是等待验证码邮件到达并复制：常见延迟 5–10 分钟，OTP 本身也多在该量级过期；短于 24h 以封顶硬导航残留，长于 5 分钟以避免延迟邮件把访问者卡死 |
| **与 Share 生命周期** | **从属关系**：Share 被销毁、`effectiveStatus` 变为非 ACTIVE、或 account 失效 → 旧 sessionToken **下一次请求即失效**（逐请求回源查库） |
| **验证** | 每请求：验签 → 查 `mail_share` 行 → 重算 `effectiveStatus` → 校验 account 仍有效 → 构建 `ShareContext` |
| **重放** | 无 refresh；过期 token **不得**换新 token。过期后须重新 `POST /share/session` 提交 `lid`+`sec`。fragment 已从 URL 清除，故客户端须在**页面内存**保留 `sec`（不得写入 `sessionStorage`），或访问者重新打开含 `#<sec>` 的原链接。Share 行仍 `ACTIVE` 时该路径必须能建立新会话，不得因 fragment 已清而死结 |
| **撤销** | 无服务端 session 表；撤销由 Share 行状态驱动，验签后立即查库即可 |
| **失败响应** | 鉴权/过期/凭据错/超窗/功能关：统一 `SHARE_UNAVAILABLE` + JSON 形状（P-AUTH-01）。无行或 `REVOKED`：裸 HTTP 404（P4）。**HTTP 429 + `Retry-After`** 为独立运输层错误（P-TRANS-01），不属于 P-AUTH-01 集合 |
| **密钥轮换** | 环境变量 `SHARE_SESSION_SIGNING_KEY` + `kid`；支持双 key 验签窗口（新旧并行 ≤7 天） |

**已知限制（AC-VISIT-12 与 AC-VISIT-15）**：硬导航不跑 Vue 守卫，`sessionStorage` token 会留给同 tab 下一个同源页。`pagehide` 不是修复——刷新也会触发，而 AC-VISIT-12 依赖刷新后仍能读到该 token（fragment 已清）。用户 2026-08-17 裁决：接受该残留，用 15 分钟绝对 TTL 封顶窗口。残留范围 = 同 tab + 同源 + ≤TTL；token 只授予访问者已经用完整链接换到的只读能力。

错误码（稳定注册表）：`SHARE_UNAVAILABLE`（Visitor 不可区分：过期/凭据错/超窗/功能关）、`SHARE_DESTROYED`（无行/`REVOKED`，HTTP 层翻成裸 404）、`SHARE_ACCOUNT_FORBIDDEN`、`SHARE_DURATION_EXCEEDED`、`SHARE_LIMIT_EXCEEDED`、`SHARE_IDEMPOTENCY_CONFLICT`（同 Key 异请求体）、`SHARE_NOT_FOUND`（仅 Owner 侧）、`SHARE_FORBIDDEN`（缺 `share:manage`）、`SHARE_DISABLED`（Owner 创建时功能关闭）。**HTTP 429** 为运输层响应，**不**映射为 `SHARE_UNAVAILABLE`。

### Link table (§0.16)

| node | producer | consumer |
|---|---|---|
| Owner 创建入口 | `mail-vue/src/views/email/**` ShareDialog（待建） | `POST /mailShare/create`（待建） |
| Owner 身份 | `security/user-context.js:5-7`（existing） | `mail-share-service`（待建） |
| 分享记录落库 | `mail-share-service`（待建） | `entity/mail-share.js`（待建）+ `init.js` v3_1DB（待建） |
| 路由注册 | `hono/webs.js:1-23`（existing，加 import） | `api/share-api.js` + `api/mail-share-api.js`（待建） |
| 公开路径放行 | `security/security.js:11-22`（existing，Visitor 精确 + 前缀 hybrid） | `share-auth-service`（待建） |
| `/s/<lid>` 落地 | `mail-worker/src/index.js:23` + `wrangler.toml:31-32`（existing，**无需改**） | `mail-vue/src/router/index.js` 新顶层路由（待建） |
| 守卫放行 | `mail-vue/src/router/index.js:98-100`（existing，需改） | `views/share/index.vue`（待建） |
| Visitor 取内容 | `request/share.js` 独立实例（待建） | `POST /share/session` → `GET /share/mails`（待建） |
| 新邮件 | `email/email.js:127` 写入 D1（existing） | `ShareView` 客户端 3s 轮询 `GET /share/mails`（待建） |
| 附件字节 | `share-attachment-service`（待建；**含对象读取返回类型归一化层**，不可假设 `r2-service.getObj` 统一返回 `Response`） | `GET /share/attachment`（待建） |
| OTP 展示 | `email.code` 列（existing，`entity/email.js:10`） | `share-mail-service` 投影（待建） |
| 安全渲染 | `components/safe-mail/`（待建，沙箱 iframe） | `views/share/**`（待建）+ `views/content/index.vue:38-39`（existing，**本期切换**） |
| 安全头 | `mail-vue/public/_headers`（existing，需扩展） | 浏览器 |

**最终 sink**：Visitor 浏览器中显示的验证码文本 + 剪贴板内容。
**真跑一次的 e2e 姿势**：全新浏览器上下文（无 localStorage/IndexedDB）访问有效/随机/过期/已销毁四种 token；期间从外部真实投递一封含验证码的邮件，观察其在不刷新下出现。

## Key Functions — Formal Specifications

### `shareAuthService.resolveSession(c, sessionToken: string) -> ShareContext` (待建)
- **Preconditions**：`sessionToken` 为 Bearer 头中的不可信字符串。
- **Postconditions**：验签通过且 Share 行 `effectiveStatus=ACTIVE` 且 account 仍有效时返回含 `shareId`/`accountId`/`windowStartEmailId`/`expiresAt` 的上下文；否则抛 `BizError(SHARE_UNAVAILABLE)`；失败原因不可区分。
- **Errors**：`SHARE_UNAVAILABLE`。

### `shareAuthService.establishSession(c, lid: string, sec: string) -> { sessionToken, ... }` (待建)
- **Preconditions**：`lid`、`sec` 为客户端提供的不可信字符串。
- **Postconditions**：成功时返回 `sessionToken`；`sec` 比较为常量时间；不返回任何可重建 `sec` 的数据；**仅在此处**更新 `access_count`/`last_access_at`（语义：持链者成功建立 Session，非阅读确认）。
- **Errors**：`SHARE_UNAVAILABLE` 覆盖不存在/摘要不匹配/已过期/已销毁/account 失效/功能被关闭。**HTTP 429** 由边缘返回，不属于本方法的 BizError 集合。

### `shareScopedEmailRepository.list(c, ctx, cursor, limit) -> EmailRow[]` (待建 · A3)
- **Preconditions**：`c` 为 Hono 上下文（与仓内其他 service 一致，DB 访问需要 `c.env.db`）；`ctx` 由 `shareAuthService.resolveSession` 产出且已通过 `effectiveStatus` 校验；`ctx.accountId > 0`。
- **Postconditions**：查询条件**不可绕过**，恒包含：
  - `email.account_id = ctx.accountId`（**且** `ctx.accountId > 0`，排除历史 `account_id=0` 脏行，`email/email.js:112-113`）
  - `email.email_id > ctx.windowStartEmailId`
  - `email.is_del = NORMAL`（`0`；该列**同时**承担「用户删除」与「收件未完成」两种语义——未完成收件亦以非 NORMAL 写入，`email/email.js:114-115`）
  - `email.status != SAVING`（排除两阶段写入中间态，`email/email.js:114-115` → `completeReceive` 于 `:147` 翻转）
  - 按 `email_id ASC` 排序；`limit ≤ 50`。
- **Errors**：无匹配行时返回空数组（非异常）。

### `shareScopedEmailRepository.getById(c, ctx, mailId) -> EmailRow | null` (待建 · A3)
- **Preconditions**：同上。
- **Postconditions**：同上范围条件绑定 `email.email_id = mailId`；窗口外、中间态、脏关联或不存在返回 `null`（调用方统一映射为 `SHARE_UNAVAILABLE`）。
- **Errors**：无。

### `shareMailService.project(emailRow) -> VisitorMailDTO` (待建)
- **Preconditions**：`emailRow` **必须**来自 `shareScopedEmailRepository` 的查询结果（编译/代码审查约束，非运行时参数）。
- **Postconditions**：返回对象的键集合**恒等于**白名单集合；纯字段映射，**不承担**范围授权。
- **Errors**：无（纯映射）。

## Data Models

### `mail_share`（D1 · A2 状态模型）

**持久化状态**仅 `ACTIVE` / `REVOKED`。`EXPIRED` 为 **effectiveStatus**（由 `expires_at` 与当前时间实时计算，不写入 DB）。

```
effectiveStatus(row, now) =
  if row.status == 'REVOKED' → REVOKED
  else if row.expires_at <= now → EXPIRED
  else → ACTIVE
```

| 列 | 类型 | 说明 |
|---|---|---|
| `share_id` | INTEGER PK AUTOINCREMENT | |
| `lid` | TEXT NOT NULL | 公开定位半，**UNIQUE INDEX** |
| `sec_hmac` | TEXT NOT NULL | `HMAC-SHA256(sec, PEPPER[pepper_kid])` |
| `pepper_kid` | TEXT NOT NULL | 计算 `sec_hmac` 时使用的 PEPPER 版本标识 |
| `user_id` | INTEGER NOT NULL | Owner |
| `account_id` | INTEGER NOT NULL | 被分享邮箱 |
| `name` / `remark` | TEXT DEFAULT '' | 仅 Owner 可见（见 requirements 业务场景表） |
| `status` | TEXT NOT NULL DEFAULT 'ACTIVE' | **仅** `ACTIVE` / `REVOKED` |
| `window_start_email_id` | INTEGER NOT NULL DEFAULT 0 | Visible Window 下界 |
| `expires_at` | TEXT NOT NULL | 链接失效时刻 |
| `delete_at` | TEXT NOT NULL | 物理清除时刻（晚于 `expires_at`） |
| `access_count` | INTEGER NOT NULL DEFAULT 0 | Owner 列表：持链者成功建立 Session 的次数（非阅读确认） |
| `last_access_at` / `revoked_at` | TEXT | Owner 列表：最后成功建立 Session 时刻 / 销毁时刻 |
| `create_time` | TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL | |

**本期不预留** `password_hash` / `max_views` / `current_views` / `otp_only` / `allow_html` / `allow_attachments`（用户 R1 裁决 · F3：纯占位、无语义，未来走新迁移）。**不在** `mail_share` 行上存储幂等键（R2-A4：单一真源为 `share_idempotency` 表）。

#### 状态迁移表

| 触发 | 前置条件 | 持久化 `status` 变化 | `effectiveStatus` | 触发者 |
|---|---|---|---|---|
| 创建 | account 归属 Owner、未超活跃上限 | → `ACTIVE` | `ACTIVE` | Owner |
| 自然过期 | `expires_at ≤ now` 且 `status=ACTIVE` | **不变**（仍 `ACTIVE`） | → `EXPIRED` | 时间 |
| 撤销 | `status=ACTIVE` 或 `effectiveStatus=EXPIRED` | → `REVOKED`，写 `revoked_at` | `REVOKED` | Owner |
| account 删除 | account 软删/硬删 | → **永久** `REVOKED`，写 `revoked_at`（AC-LIFE-09/12 删除侧） | `REVOKED` | `account-service` 删除路径 |
| account 转移 | `account.user_id` 变更（**能力当前不存在**） | → **永久** `REVOKED`，写 `revoked_at`（AC-LIFE-12 **未来挂钩点**） | `REVOKED` | 未来转移入口 |
| 过期后重新授权 | `effectiveStatus=EXPIRED` | 须 `POST /mailShare/create` 新建行 | — | Owner |
| 物理清理 | `delete_at ≤ now` | 行删除 | — | `index.js:27-37` scheduled 扩展 |
| 功能关闭 | 管理员关开关 | **不变**（仍 `ACTIVE`） | Visitor 判不可用；**重开恢复**（AC-LIFE-13） | 管理员 |

#### regenerate 约定（T-20a 已实现 · R2 语义原样兑现）

`POST /mailShare/regenerate`：**仅**对 `effectiveStatus=ACTIVE` 的授权在同一 `share_id` 行内原子更新 `lid` 与 `sec_hmac`（连同 `pepper_kid`，新 `sec` 用当前 pepper 摘要），**保持** `expires_at` 与 `window_start_email_id`；`EXPIRED`/`REVOKED` 拒绝 regenerate，须新建授权。

R2 原文写的是 `PUT`，落地改用 **`POST`**：与 `resetAuthKey` 同理——每次都铸一把新 `sec`，不是幂等的字段覆盖，幂等由 `Idempotency-Key` 请求头显式表达（AC-SHARE-13），而不是由 HTTP 动词隐含。

补充两条实现级约束（原文未及，与本模块既有写入路径同款）：

- **`credentials_version + 1`**：让在飞 Visitor Session 当场断开（`share-auth-service` 每请求比对 cv）。旧链接的失效由 `sec_hmac` 变更保证，cv 只管已经建立的会话。
- **CAS**：预读到的 `credentials_version` 与 `expires_at` 原样进 WHERE（与 `update` 的 `prepareUpdate` 同款）。预读之后、写入之前发生的 `resetAuthKey` / 续期会让本次零命中，分流 `SHARE_UPDATE_CONFLICT`，而不是无声盖过。
- **不设 V2 栅栏**：只写 v1 就有的 `lid` / `sec_hmac` / `pepper_kid`，滚动发布窗口内的旧 Worker 完全认得（照样会拒掉旧 `sec`）；`cv` 是纯加严，旧 Worker 读不到也不会放宽任何东西。

### 辅助表

**`share_idempotency`**（D1 · A4 · **唯一幂等真源** · 锚点 `init.js:v3_1DB`、`entity/mail-share.js`）：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT |  surrogate |
| `user_id` | INTEGER NOT NULL | Owner |
| `idempotency_key` | TEXT NOT NULL | 请求头 `Idempotency-Key` |
| `operation` | TEXT NOT NULL | 本期仅 `create` |
| `request_fingerprint` | TEXT NOT NULL | 规范化请求体 SHA-256 |
| `share_id` | INTEGER | 首次成功创建的 `mail_share.share_id`；写入前可为 NULL |
| `response_fingerprint` | TEXT | 重放响应指纹；写入前可为 NULL |
| `created_at` | TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL | 24h 过期清理依据 |

`UNIQUE(user_id, idempotency_key, operation)`；24h 过期清理；Share 行与幂等行 **`c.env.db.batch()` 原子提交**（AC-SHARE-15）；同 Key 异指纹 → `SHARE_IDEMPOTENCY_CONFLICT`（AC-SHARE-14）；重放返回已记录的 `shareId`/`lid`，**不含** `sec`。

#### Share Secret 密钥生命周期（R3-A6）

| 场景 | 行为 |
|---|---|
| **正常轮换** | 环境变量 `SHARE_SEC_PEPPER` + `pepper_kid`；新旧 PEPPER 并行验证窗口 ≤7 天（与 Session 签名 `kid` 模型对齐）；新创建的 Share 写入当前 `pepper_kid` |
| **验证** | `establishSession` 只按行上记录的 `pepper_kid` 选 PEPPER 做常量时间比较；第二把配置中的 PEPPER 只服务「行上 kid 等于该版本」的存量链接（轮换重叠窗口），不是未知 kid 的兜底。行上 `pepper_kid` 未在当前/上一把中配置（密钥过早撤下）时 **fail closed**：返回与其他死链相同的 `SHARE_UNAVAILABLE`，**不得**改用另一把 PEPPER。 |
| **密钥丢失** | 无法验证的存量链接在窗口结束后自然失效；Owner 须 revoke + create；**不**静默批量复活 |
| **紧急吊销** | 运维可提前结束旧 PEPPER 验证窗口（缩短至 0）；等同于加速失效，须公告 Owner |

**本期不建** `share_auth_rate_limit` / `share_auth_metrics`（R2-A6：滥用防护改 Cloudflare 边缘限速）。

时间列一律 TEXT，与仓内既有约定一致（`email.createTime`、`account.latestEmailTime`）。

索引：`UNIQUE(lid)`、`(user_id, status)`（AC-MGMT-03）、`(account_id, status)`（AC-MGMT-04）、`(delete_at)`（清理任务）、`UNIQUE(user_id, idempotency_key, operation)`。
**依赖既有索引**：`idx_email_user_id_account_id`（`init.js:212`）**不**覆盖 `(account_id, email_id)` 形状——v3_1DB **必须**新建 `idx_email_account_id_email_id ON email(account_id, email_id)`，否则 AC-RT-04 不成立。

#### 对象存储读取归一化（R3 核实 · 附件端点前置）

`r2-service.getObj`（`r2-service.js:43-56`）按 setting 分派，**返回类型不一致**：

| 后端 | 返回类型 | 消费方式 |
|---|---|---|
| KV | `Response`（经 `kvObjService.getObj`） | 直接回传 |
| R2 | **`R2Object`**（`c.env.r2.get(key)`） | `/oss/*` 在 `r2-api.js` 自行取 `.body` 与 `.httpMetadata` |
| S3 | `Response`（经 `s3Service.getObj`） | 直接回传 |

`share-attachment-service` **不得**假设「复用现成封装即可」——须先实现一层返回类型归一化（统一成 `Response` 或 `{ body, httpMetadata }`），再供 `GET /share/attachment` 回传字节（AC-SEC-21）。

#### `email.is_del` 双语义（实现须知）

`is_del` 列同时承担：**(a)** 用户删除标记；**(b)** 收件流程未完成标记（摄取时以 `isDel.DELETE` 插入，`completeReceive` 后翻转，`email/email.js:114-115,147`）。分享 Visible Window 查询**须同时**判 `is_del = NORMAL` **与** `status != SAVING`，不可只判其一。

`VisitorMailDTO` 白名单字段：`mailId`、`senderName`、`senderAddress`、`subject`、`text`、`content`、`receivedAt`、`code`（=`email.code`；**空字符串 `''` 视为无验证码**，非 null）、`attachments`（数组：`attachmentId`、`filename`、`size`、`downloadUrl` 指向 `/share/attachment?...`，**非** `/oss/`）。

无外键、无级联（与仓内既有一致：`init.js:465-591` 全表无 `FOREIGN KEY`）⇒ 清理必须显式守恒。

## Error Handling

| Scenario | Layer | Handling |
|---|---|---|
| `lid` 不存在 / 销毁（`REVOKED`） | share-auth-service | 抛 `SHARE_DESTROYED` → 裸 HTTP 404 |
| `sec` 错 / `pepper_kid` 未配置 / 过期 / 超窗 / 功能关 | share-auth-service | 抛 `SHARE_UNAVAILABLE`（族内不可区分） |
| account 非本人 | mail-share-service | `SHARE_ACCOUNT_FORBIDDEN` |
| 有效期超上限 / 数量超上限 | mail-share-service | `SHARE_DURATION_EXCEEDED` / `SHARE_LIMIT_EXCEEDED` |
| 同 Idempotency-Key 异请求体 | mail-share-service | `SHARE_IDEMPOTENCY_CONFLICT` |
| 边缘限速超限 | Cloudflare Rate Limiting | HTTP **429** + **`Retry-After`**（独立运输层错误，P-TRANS-01） |
| 功能被管理员关闭 | mail-share-service（Owner 创建） | `SHARE_DISABLED` |
| 功能被管理员关闭 | share-auth-service（Visitor） | `SHARE_UNAVAILABLE` |
| 缺少 `share:manage` | mail-share-api | `SHARE_FORBIDDEN` |
| iframe/srcdoc 注入失败 | SafeMailRenderer | 降级为纯文本，**不降级为裸 HTML** |
| `text` 为空且存在 HTML | SafeMailRenderer / ShareView | 默认纯文本模式**直接呈现沙箱 iframe**并在 UI 说明；**不**留空白页（AC-SEC-24） |
| Clipboard 不可用 | CopyComposable | 提供手动选中路径 |

## 测试策略

**前置任务（阻塞项）**：`mail-worker` 的测试运行器当前不可用（`package.json:5-10` 的 `test` 脚本是 `wrangler deploy`；`vitest.config.js` 引用缺失文件；`test/index.spec.js` 是 Hello World）。必须先接好 `@cloudflare/vitest-pool-workers`（依赖已在）+ 隔离 D1，才能谈红绿。

- **property-testable**：`shareMailService.project`（键集合恒等）、`shareScopedEmailRepository` 范围封闭性。
- **example-tested**：状态机各转移、过期边界、owner 越权、字段投影、错误码不可区分性。
- **必须真跑一次的 e2e**：见 Link table 的 e2e 姿势。单测绿不算接线。

### Traceability 矩阵（每条 AC 的验证手段）

层级：`U`=单元 / `P`=property / `I`=集成（真 D1） / `E`=端到端（真浏览器 + 真投递） / `M`=人工核验（配置或响应头，用一次真实请求核）

| AC | 验证手段 | 层 |
|---|---|---|
| AC-SHARE-01 | 创建后按 `lid` 查库存在，且响应含可解析的 Share URL | I |
| AC-SHARE-02 | 断言 `lid` 16 字节 / `sec` 32 字节，且两次创建互不相同 | U |
| AC-SHARE-03 | 创建后全表扫描断言无任何列等于 `sec` 明文 | I |
| AC-SHARE-04 | 创建响应含 `sec`；随后 list/detail 响应键集合不含 `sec` | I |
| AC-SHARE-05 | 用他人 `accountId` 创建 → `SHARE_ACCOUNT_FORBIDDEN` | I |
| AC-SHARE-06 | 先投递 2 封再创建，断言 `window_start_email_id` 等于第 2 封 `emailId` | I |
| AC-SHARE-07 | 设上限后请求超长有效期 → `SHARE_DURATION_EXCEEDED` | I |
| AC-SHARE-08 | 断言 `expires_at - create_time` 等于所选时长 | I |
| AC-SHARE-09 | 提交 name/remark 后仅 Owner 列表返回，Visitor 响应不含 | I |
| AC-SHARE-10 | 同一 `accountId` 连续创建 2 条均成功且 `lid` 不同 | I |
| AC-SHARE-11 | 同一 Idempotency-Key 重放：第二次无 `sec` 且 `idempotentReplay=true` | I |
| AC-SHARE-12 | 并发创建达上限：恰 N 成功、其余 `SHARE_LIMIT_EXCEEDED`、无孤儿行 | I |
| AC-SHARE-13 | {status: active, by: 2026-08-25-T-20a} regenerate 幂等：同 owner+key+shareId 返回相同 lid 且不再下发 sec；跨 shareId 冲突；与 create 的 operation 隔离 | U |
| AC-SHARE-14 | 同 Key 异请求体 → `SHARE_IDEMPOTENCY_CONFLICT` | I |
| AC-SHARE-15 | Share 行与幂等行 `batch()` 原子提交；失败无孤儿行 | I |
| AC-SHARE-16 | 复合游标退路**本期不实施**——单语句 `INSERT ... SELECT MAX(...)` 已提供线性化切点（T-02 否定 drizzle `.transaction()`） | — |
| AC-VISIT-01 | `GET /s/<lid>` 响应体不含任何邮件字段 | E |
| AC-VISIT-02 | `GET /s/<lid>` 前后对比 `access_count` 与 `last_access_at` 未变 | I |
| AC-VISIT-03 | 篡改 `sec` 一个字符 → 拒绝；比较走常量时间 API（代码级断言调用点） | I |
| AC-VISIT-04 | 四种非法输入（不存在/错 sec/过期/已销毁）响应逐字节相同 | P |
| AC-VISIT-05 | 窗口前邮件与他邮箱邮件均不出现在列表中 | I |
| AC-VISIT-06 | 响应键集合恒等于白名单（P-PROJ-01） | P |
| AC-VISIT-07 | 建会话后销毁分享，再取列表 → `SHARE_UNAVAILABLE` | I |
| AC-VISIT-08 | 对分享会话尝试删除/发信/标记已读/改分享全部被拒 | I |
| AC-VISIT-09 | 请求窗口外 `emailId` → 与不存在 `emailId` 响应相同 | P |
| AC-VISIT-10 | 分享页 HTML 中无任何跨域 script 源（构建产物断言） | M |
| AC-VISIT-11 | 后续请求 Authorization Bearer 含 sessionToken；无 sec 查询参数 | I |
| AC-VISIT-12 | 建会话后 `sessionStorage['share:session:<lid>']` 含 token；分享路由内刷新恢复；关 tab 清除；sec 已从 URL 清除；默认 Session TTL 15 分钟 | E |
| AC-VISIT-13 | 同 tab 先后打开 lid A/B：不得用 A 的 token 访问 B；切换时清除旧 lid 键 | E |
| AC-VISIT-14 | 鉴权失败 / SHARE_UNAVAILABLE / 显式退出后键被清除 | E |
| AC-VISIT-15 | SPA 导航至非 share 路由（如 login）后键被清除；硬导航残留为已知限制，由 Session TTL 封顶 | E |
| AC-VISIT-16 | 收件中间态（`status=SAVING` 或非 NORMAL `is_del`）不出现在列表/详情 | I |
| AC-LIFE-01 | 把 `expires_at` 改为过去且不跑 cron，立即访问 → 拒绝（P-LIFE-01） | I |
| AC-LIFE-02 | 销毁后断言 `status='REVOKED'` 且 `revoked_at` 非空 | I |
| AC-LIFE-03 | 销毁后访问 → `SHARE_UNAVAILABLE` | I |
| AC-LIFE-04 | 对已销毁记录尝试延期/重新启用 → 被拒且状态未变 | I |
| AC-LIFE-05 | {status: active, by: 2026-08-25-T-20a} regenerate 凭据轮换：新 lid/sec + cv+1 使在途会话失效,`expires_at` 与 Visible Window 不变 | U+I |
| AC-LIFE-06 | 断言 `delete_at > expires_at` | U |
| AC-LIFE-07 | 造 `delete_at` 未到与已到各一条，跑清理，断言只删后者 | I |
| AC-LIFE-08 | 过期/销毁未到 `delete_at` 时 Owner 列表仍含该条且 `effectiveStatus` 正确 | I |
| AC-LIFE-09 | 软删 account 后访问 → `SHARE_UNAVAILABLE` | I |
| AC-LIFE-10 | 建立 Session 成功后 `access_count` +1 且 `last_access_at` 更新；轮询不触发 | I |
| AC-LIFE-11 | {status: active, by: 2026-08-25-T-20a} EXPIRED / REVOKED 的 regenerate 拒绝且零变更（过期授权不得原地复活） | U |
| AC-LIFE-12 | account 删除路径撤销相关 Share；转移挂钩点（转移能力不存在，本期不测转移路径） | I |
| AC-LIFE-13 | 功能关→开：旧 ACTIVE 链接恢复可用 | I |
| AC-LIFE-14 | 统计写入失败仍返回有效 sessionToken | I |
| AC-RT-01 | {status: deprecated, by: R3-A3} 服务端 25s wait | — |
| AC-RT-02 | {status: deprecated, by: R3-A3} wait 立即返回 | — |
| AC-RT-03 | {status: deprecated, by: R3-A3} wait 空结果游标 | — |
| AC-RT-04 | 对 `GET /share/mails` 跑 `EXPLAIN QUERY PLAN`，断言用到 `(account_id, email_id)` 索引且无 SCAN | I |
| AC-RT-05 | 切后台后断言不再发出轮询请求 | E |
| AC-RT-06 | {status: deprecated, by: R3-A3} wait 中销毁 | — |
| AC-RT-07 | {status: deprecated, by: R3-A3} wait no-store | — |
| AC-RT-08 | `limit=999` 请求截断为 50 | U |
| AC-RT-09 | 同一 cursor：稳定排序、不重复、不跳过（允许新邮件追加） | I |
| AC-RT-10 | {status: deprecated, by: R3-A3} wait cursor 语义 | — |
| AC-RT-11 | {status: deprecated, by: R3-A3} wait 批量返回 | — |
| AC-RT-12 | 断线重连后不重复已确认邮件 | I |
| AC-RT-13 | {status: deprecated, by: R2-A3} in-flight 上限 | — |
| AC-RT-14 | 前台每 3s 调用 `GET /share/mails` 拉取新邮件 | E |
| AC-RT-15 | 收到 429 读 `Retry-After` 退避，不当永久失效 | E |
| AC-RT-16 | Share 失效时轮询返回 `SHARE_UNAVAILABLE` 并停止 | E |
| AC-OTP-01 | {status: deprecated, by: R2-A1} 确定性打分器 | — |
| AC-OTP-02 | {status: deprecated, by: R2-A1} | — |
| AC-OTP-03 | {status: deprecated, by: R2-A1} | — |
| AC-OTP-04 | {status: deprecated, by: R2-A1} | — |
| AC-OTP-05 | {status: deprecated, by: R2-A1} | — |
| AC-OTP-06 | {status: deprecated, by: R1-F1} 已由 AC-OTP-14 取代 | — |
| AC-OTP-07 | 页面同时显示发件人显示名与地址 | E |
| AC-OTP-08 | 点击复制后读回剪贴板内容等于验证码 | E |
| AC-OTP-09 | 禁用 Clipboard API 后仍存在可手动选中的元素 | E |
| AC-OTP-10 | {status: deprecated, by: R2-A1} | — |
| AC-OTP-11 | {status: deprecated, by: R2-A1} 双路合并 | — |
| AC-OTP-12 | {status: deprecated, by: R2-A1} | — |
| AC-OTP-13 | {status: deprecated, by: R2-A1} | — |
| AC-OTP-14 | `email.code` 非空时 DTO 含 code 且页面顶部展示 | E |
| AC-OTP-15 | `email.code` 为空时不展示验证码区块 | E |
| AC-EXT-01 | 三模式各跑一次；`RULE_ONLY` 用 spy 断言 `env.ai` 零调用 | U |
| AC-EXT-02 | 高置信正文码存在时 AI 桩不被调用；低置信时 AI 结果被采纳 | U |
| AC-EXT-03 | 带 `One-Time-Code` 头且正文含验证链接 → 两字段都有值 | U |
| AC-EXT-04 | 码只在主题时取到；主题关键词不得给正文无关数字背书；两者皆高置信取正文 | U |
| AC-EXT-05 | 4/6/8 位纯数字、字母数字混合、带连字符各一例；纯字母不入选 | U |
| AC-EXT-06 | 「验证码 918273。客服电话 555-…」取到 918273；订单号/年份/电话不入选 | U |
| AC-EXT-07 | `javascript:` / `data:` / `file:` 候选出局（href 其余特征均像验证链接） | U |
| AC-EXT-08 | AI 返回越界下标、返回原文不存在的码 → 均丢弃并回落确定性结果 | U |
| AC-EXT-09 | AI 桩挂起 → 落库仍在时限内完成 | U |
| AC-EXT-10 | 六类失败各触发一次，计数分别递增 | U |
| AC-EXT-11 | 注入的 insert 首次抛错 → 摘 `verifyLink` 重试一次并成功；无该字段时不重试 | U |
| AC-EXT-12 | 开关关闭时 `'code' in dto` 与 `'link' in dto` 均为 false | U |
| AC-EXT-13 | 选中无码邮件时不得出现其它邮件的码（组件级） | U |
| AC-EXT-14 | 码/链接任一有值即展示；皆空出现未识别文案 | U |
| AC-EXT-15 | 链接元素带 `rel="noopener noreferrer"`、文本等于完整 URL、非法协议不渲染 | U |
| AC-SEC-01 | 默认渲染路径断言渲染的是 `text` 分支 | E |
| AC-SEC-02 | 切换后在沙箱 iframe 中原样渲染 HTML | E |
| AC-SEC-03 | {status: deprecated, by: R2+用户收缩} 净化库 | — |
| AC-SEC-04 | {status: deprecated, by: R2+用户收缩} 元素白名单 | — |
| AC-SEC-05 | {status: deprecated, by: R2+用户收缩} 事件处理器剥离 | — |
| AC-SEC-06 | {status: deprecated, by: R2+用户收缩} URL 协议白名单 | — |
| AC-SEC-07 | 外链 `target=_blank` + `rel=noopener noreferrer` | U |
| AC-SEC-08 | {status: deprecated, by: R2+用户收缩} 阻断远程图片 | — |
| AC-SEC-09 | iframe sandbox 不含 `allow-scripts`/`allow-same-origin`（P-SEC-03） | E |
| AC-SEC-10 | 登录态详情页与分享页导入同一 SafeMailRenderer | U |
| AC-SEC-11 | {status: deprecated, by: R2+用户收缩} 禁止附件 | — |
| AC-SEC-12 | {status: deprecated, by: R2+用户收缩} CSS 声明过滤 | — |
| AC-SEC-13 | {status: deprecated, by: R2+用户收缩} srcset 校验 | — |
| AC-SEC-14 | iframe 注入失败降级纯文本、主文档无裸 HTML | U |
| AC-SEC-15 | 使用 `srcdoc` 注入、主文档无 innerHTML | U |
| AC-SEC-16 | srcdoc 文档含 CSP `script-src 'none'`（P-SEC-04） | E |
| AC-SEC-17 | {status: deprecated, by: R3-A2} iframe 自动高度 | — |
| AC-SEC-18 | {status: deprecated, by: R3-A1} 公开 `/oss/` 附件直链 | — |
| AC-SEC-19 | {status: deprecated, by: R3-A1} 附件不随 Share 失效 | — |
| AC-SEC-20 | Visitor DTO 含 attachments；downloadUrl 指向 `/share/attachment` | I |
| AC-SEC-21 | 受控端点鉴权；过期/撤销后下载拒绝；Worker 回传字节 | I |
| AC-SEC-22 | HTML 模式固定高度 + 内层滚动 | E |
| AC-SEC-23 | iframe 内默认加载远程图片；隐私代价文档化 | E |
| AC-SEC-24 | `text` 为空且存在 HTML 时默认模式呈现沙箱 iframe 并 UI 说明 | E |
| AC-MGMT-01 | 他人分享不出现在本人列表中 | I |
| AC-MGMT-02 | 列表响应含全部约定字段 | I |
| AC-MGMT-03 | 对列表查询跑 `EXPLAIN QUERY PLAN`，断言命中 `(user_id, status)` | I |
| AC-MGMT-04 | 创建 2 条后邮箱界面显示计数 2；销毁 1 条后显示 1 | E |
| AC-MGMT-05 | 点击销毁先出现确认，取消则状态不变 | E |
| AC-MGMT-06 | 创建对话框中存在该提示文案 | E |
| AC-MGMT-07 | 对他人 `shareId` 操作 → `SHARE_NOT_FOUND` | I |
| AC-MGMT-08 | {status: deprecated, by: R3-perm} 三份 share:* 权限 | — |
| AC-MGMT-09 | 移除 `share:manage` 后全部 Owner 操作 → `SHARE_FORBIDDEN` | I |
| AC-LEAK-01 | 构造的 Share URL 中 `sec` 位于 `#` 之后；服务端请求日志不含 `sec` | I |
| AC-LEAK-02 | 分享页与分享接口响应头均含 `no-store`（**unverified**：`run_worker_first` 下 `_headers` 应用时机） | M |
| AC-LEAK-03 | 分享页响应头含 `Referrer-Policy: no-referrer`（**unverified**：同上） | M |
| AC-LEAK-04 | 分享页响应头含 `X-Robots-Tag: noindex, nofollow`（**unverified**：同上） | M |
| AC-LEAK-05 | 走完整流程后检查日志输出不含 `sec`/会话凭据/正文 | I |
| AC-LEAK-06 | 构造 `/share-evil` 类路径断言未被豁免放行（精确匹配而非前缀） | I |
| AC-ABUSE-01 | {status: deprecated} 按 lid 锁定 | — |
| AC-ABUSE-02 | 超出同时活跃上限后创建 → `SHARE_LIMIT_EXCEEDED` | I |
| AC-ABUSE-03 | 关闭开关后 Owner 创建 → `SHARE_DISABLED`；Visitor → `SHARE_UNAVAILABLE` | I |
| AC-ABUSE-04 | 应用代码依赖图不含 KV 限速客户端 | U |
| AC-ABUSE-05 | {status: deprecated, by: R2-A6} D1 来源限速 | — |
| AC-ABUSE-06 | {status: deprecated, by: R2-A6} D1 全局指标 | — |
| AC-ABUSE-07 | {status: deprecated, by: R2-A6} D1 失败计数重置 | — |
| AC-ABUSE-08 | Cloudflare 控制台/配置中存在 Rate Limiting 规则；429 + Retry-After | M |
| AC-ABUSE-09 | 客户端 429 退避，不映射 SHARE_UNAVAILABLE | E |


## Correctness Properties

### P-OTP-01: {status: deprecated, by: R2-A1} 标注样本集上的置信度阈值

~~For any 标注排除样本集中的 token，THE DeterministicOtpScorer SHALL 将其置信度降至阈值以下。~~（本期不做确定性打分器）

**Validates: AC-OTP-03（已废弃）**

### P-OTP-02: {status: deprecated, by: R2-A1} 打分确定性

~~For any 相同的 `(subject, text)` 输入对，THE DeterministicOtpScorer SHALL 返回完全相同的候选序列。~~

**Validates: AC-OTP-01, AC-OTP-10（已废弃）**

### P-OTP-03: 验证码单一真源

For any 进入 Visible Window 的邮件，THE ShareMailService SHALL 在 Visitor DTO 中返回的 `code` 字段 SHALL 等于该邮件行上的 `email.code`，SHALL NOT 在投影链中重新推断或变换。

**Validates: AC-OTP-14, AC-OTP-15**

### P-PROJ-01: 投影键集合恒定

For any `email` 行（无论其含多少额外列），THE ShareMailService SHALL 产出键集合恰好等于白名单集合的 DTO（含 `attachments` 当且仅当该邮件有附件）。

**Validates: AC-VISIT-06, AC-SEC-20**

### P-ATT-01: 附件授权边界与 Share 生命周期一致

For any 附件下载请求，THE ShareAuthService SHALL 在回传字节前逐请求校验 Share Session 与 `effectiveStatus`；IF Share 已过期、已撤销或 account 已失效 THEN SHALL 拒绝下载。THE `downloadUrl` SHALL NOT 指向公开 `/oss/<key>` 直链。

**Validates: AC-SEC-20, AC-SEC-21**

### P-SCOPE-01: 可见窗口封闭性（Repository 层）

For any Visitor 请求，THE ShareScopedEmailRepository 的每条查询 SHALL 恒包含 `account_id = ctx.accountId`（且 `ctx.accountId > 0`）AND `email_id > ctx.windowStartEmailId` AND `is_del = NORMAL` AND `status != SAVING`；窗口外邮件、历史 `account_id=0` 脏行、收件中间态 SHALL NOT 被返回。

**Validates: AC-VISIT-05, AC-VISIT-09, AC-VISIT-16**

### P-SCOPE-02: 投影不承担授权

For any 直接传入 `shareMailService.project()` 的 `emailRow`（绕过 repository），THE 代码审查/模块边界 SHALL 禁止此类调用；运行时 `project()` 不做范围校验。

**Validates: AC-VISIT-06**

### P-AUTH-01: 失败不可区分

For any 非法输入组合（`lid` 不存在 / `sec` 错误 / 已过期 / 已销毁 / 超窗 / 功能关），THE ShareAuthService SHALL 返回完全相同的错误码与响应形状。**HTTP 429 限速不属于本性质集合**（见 P-TRANS-01）。

**Validates: AC-VISIT-04, AC-VISIT-09**

### P-TRANS-01: 限速为可恢复运输层错误

For any 边缘 Rate Limiting 触发的 HTTP 429 响应，THE 部署 SHALL 携带 `Retry-After`；THE 客户端 SHALL 按退避重试，SHALL NOT 将其映射为 `SHARE_UNAVAILABLE`。

**Validates: AC-ABUSE-08, AC-ABUSE-09, AC-RT-15**

### P-SEC-01: {status: deprecated, by: R2+用户收缩} 净化输出符合正向允许模型

~~For any 输入 HTML，THE SafeMailRenderer 的输出 SHALL 只含允许元素集合内的标签。~~（已改为沙箱原样承载）

**Validates: AC-SEC-04, AC-SEC-05, AC-SEC-06（已废弃）**

### P-SEC-02: {status: deprecated, by: R2+用户收缩} 内联样式无外连能力

~~For any 输入 HTML 的内联 `style` 属性，THE SafeMailRenderer 的输出 SHALL NOT 保留危险 CSS 声明。~~

**Validates: AC-SEC-12（已废弃）**

### P-SEC-03: 沙箱脚本隔离

For any 含 `<script>` 或事件处理器的邮件 HTML，THE SafeMailRenderer 在 HTML 模式下 SHALL 通过 `sandbox`（不含 `allow-scripts`/`allow-same-origin`）的 iframe 渲染，且父文档 SHALL NOT 收到来自 iframe 的脚本执行副作用。

**Validates: AC-SEC-09**

### P-SEC-04: 内层 CSP 第二闸门

For any 经 `srcdoc` 注入的邮件 HTML 文档，THE SafeMailRenderer SHALL 设置 CSP `script-src 'none'`，作为脚本禁行的硬约束。

**Validates: AC-SEC-16**

### P-LIFE-01: 过期即时性

For any 时刻 T 与任意 MailShare，IF `expires_at ≤ T`，THEN THE ShareAuthService 在 T 时刻的判定结果 SHALL 为不可用，与清理任务是否已运行无关。

**Validates: AC-LIFE-01**

### P-LIFE-02: {status: active, by: 2026-08-25-T-20a} regenerate 不改变授权边界

For any `effectiveStatus=ACTIVE` 的 MailShare 上的 regenerate 操作，THE MailShareService SHALL 只变更 `lid`/`sec_hmac`（连同 `sec_cipher`/`kek_kid`/`credentials_version`），SHALL NOT 变更 `expires_at` 或 `window_start_email_id`。

**Validates: AC-LIFE-05, AC-LIFE-11**

## Decision Record

| 字段 | 值 |
|---|---|
| Reviewer | codex（默认） |
| 用户裁决 | R1：正文双模式 / 严格最小集 / 首版不提供附件（2026-08-16）。R2 有意推翻：附件提供、沙箱原样 HTML、登录态渲染器一并交付、不做 OTP 打分器（2026-08-17） |
| 侦察来源 | 6 份 plan-reality-recon（后端架构 / 数据模型与威胁面 / 前端渲染 / 前端外壳 / Workers 实时推送 / token 与并发计数）+ 主 AI 亲读 `ai-service.js` |
| unverified | `run_worker_first=true` 下 `_headers` 的应用时机；Dexie 两次 `.version(1)` 语义；生产数据量级与 `EXPLAIN QUERY PLAN` 实测；浏览器矩阵 sandbox/srcdoc/CSP 行为；软删 account 后是否仍算失效（运行时确认） |

### 2026-08-25 · regenerate 重新激活（T-20a · 推翻 R3 的「本期延后」）

R3 当初把 `regenerate` 移出本期，理由是「revoke + create 已覆盖」。该理由在**凭据可恢复性**这一需求下不再成立：

- `sec` 明文在创建响应之后不存在于任何地方，Owner 关掉对话框即永久失去链接；而 `revoke + create` 会**换掉整条授权**——有效期、可见邮件窗口、各项配置全部重来，已分发出去的旧链接同时作废。管理员因此宁可不处理，也不愿"为了换条链接把整个分享重配一遍"。
- 上线前创建的存量分享其明文已不可能回填，`regenerate` 是它们**唯一**的出路（详见 `docs/architecture/ADR-share-credential-recoverability.md`）。

**重新激活范围**：`POST /mailShare/regenerate`（动词由 R2 原文的 `PUT` 改为 `POST` —— 每次铸新凭据不是幂等覆盖，与 `resetAuthKey` 同理）；AC-SHARE-13 / AC-LIFE-05 / AC-LIFE-11 与 P-LIFE-02 一并转回 active。语义**未作任何修改**，原样兑现 R2-A2 收敛的结论：仅 ACTIVE 可调、保持 `expires_at` 与 Visible Window、`cv+1` 使在途会话失效、EXPIRED/REVOKED 拒绝。

**本条为追加，不改写上方 R2/R3 的历史记录** —— 那些结论在当时的范围内是对的，变的是需求而非判断。

## 既有缺陷（本期不修，单列上报）

1. **附件字节零鉴权**：`index.js:10-24` 在进入 hono 前按路径读 KV；`/oss/*` 在 `exclude` 内；`att-service.js:265-272` 按 key 查行不接收 `userId`；key 是跨租户确定性内容哈希（`file-utils.js:11-15`）。
2. **回复来源无 owner 校验**：`email-service.js:247-258` 调用无 owner 条件的 `selectById`。
3. **`email-service.js:742-745,949-983`** 按用户/账户/条件删邮件漏删 `star`（无级联）。
4. **`init.js` 无 catch 的启动依赖**：`mail-vue/src/init/init.js:50-55` 的 `websiteConfig()` 失败 → 顶层 await reject → 整页白屏。
5. **`views/email/index.vue:76-131`** 轮询循环在 `autoRefresh<=1` 时空转不退出，且无卸载清理。
6. **`.env.eo` 不存在**导致 `pnpm eo` 构建的 `VITE_BASE_URL` 为 undefined。
7. **`shadow-html/index.vue:66`** `bodyStyle` 裸插 `<style>`，捕获组可含 `}` 闭合规则注入 CSS（本期随 SafeMailRenderer 沙箱 iframe 一并替换；`bodyStyle` 注入面在 iframe 内隔离）。

## 开工前核实清单（R3 · 已闭合）

以下结论由主 AI 亲读源码确认（2026-08-17）；**不可从代码核实的项**移至 `tasks.md` 末尾「开工前仍需人工/运行时确认」。

### 当前领域模型和数据库结构

| 项 | 结论 | 锚点 |
|---|---|---|
| `account.user_id` 归属真源 | ✅ 是；entity 层无 tenant | `entity/account.js`；全仓无转移接口 |
| account 软删/硬删 | ✅ 存在；**无**转移、**无** ID 复用、**无**领域事件 | 软删 `account-service.js:158-159`；硬删 `:243-246` |
| `account.status` | ⚠️ 列存在但**全仓无读写**；用户禁用只拦登录 `login-service.js:220`，**不阻止收件** | 勿假设「Account 禁用」走 `account.status` |
| `email.email_id` | ✅ PK + AUTOINCREMENT，全局唯一、正常路径单调递增 | `entity/email.js:4`；`init.js:525` |
| `email.account_id` 完整性 | ⚠️ **存在合法 `account_id=0` 脏行**（收件人匹配不到账号时写入 0） | `email/email.js:112-113` |
| D1 单语句原子性 / `RETURNING` | ✅ 可行；`INSERT ... SELECT MAX(...)` 与条件 INSERT + `RETURNING`/`meta.changes` 已验证（T-02） | `mail-worker/test/transaction.spec.js`；`email-service.js:149` |
| D1 `c.env.db.batch()` | ✅ 可行；Share+幂等原子提交须用 batch，**不得**用 drizzle `.transaction()` | T-02；`init.js:38`、`public-service.js:152` |
| drizzle D1 `.transaction()` | ❌ **不可用**——API 存在但 D1 拒绝 SQL `BEGIN`，回调从未执行（Miniflare 与 remote 同限制） | `drizzle-orm/d1/session.js:57-67`；`transaction.spec.js` |
| TEXT 时间列 | ✅ 与仓内一致（TEXT + `CURRENT_TIMESTAMP`） | 沿用既有约定 |
| 迁移器部分失败 | ⚠️ `init.js:5-34` 幂等 ALTER + try/catch 吞异常——**可能**留半迁移态 | 实现 v3_1DB 时须幂等 |

### 现有接口、任务和事件链路

| 项 | 结论 | 锚点 |
|---|---|---|
| 邮件两阶段写入 | ✅ **非**同一完成事件：先 `status=SAVING`+`isDel=DELETE` 插入，后 `completeReceive` 翻转 | `email/email.js:114-115,147` |
| Account 删除/转移事件 | ❌ **无** event bus；AC-LIFE-12 **本期挂删除路径**；转移为未来挂钩点 | 见上 |
| CleanupTask 注册 | ❌ **无**任务注册机制；`scheduled()` 硬编码 4 任务 | `index.js:27-37`；cron `wrangler.toml:35` |
| `/share/*` Visitor 精确匹配 | ⚠️ 现有 `exclude` 用 `path.startsWith(item)`；Owner `/mailShare/*` 不进 exclude，走 `requirePerms` + `premKey` | `security.js:96-98`、`24-90`；**须改中间件** |

### 数据真正来源及字段完整性

| 项 | 结论 | 锚点 |
|---|---|---|
| `email.code` | ✅ 插入前同批写入；**无** UPDATE 路径；AI 失败永久为**空串** `''`（非 null） | `email/email.js:95-131`；`ai-service.js:6-8,48-50`；`entity/email.js:10` |
| `email.text` | ⚠️ **不保证存在**（PostalMime）；服务端**无** HTML→text 降级 | `email/email.js:104-105` |
| 附件与邮件行时序 | ⚠️ **运行时确认**（无法从代码静态闭合） | 见 tasks.md |
| `email_id` 表达「分享创建前后」 | ✅ 成立；单语句 `INSERT ... SELECT MAX(...)` 提供线性化切点；AC-SHARE-16 复合游标退路**本期不实施** | T-02；见 AC-SHARE-16 |
| Owner 列表邮箱地址 | ✅ 来自 Account 行（可能被删） | 运行时确认软删后展示行为 |

### 账户、租户和业务实体映射

| 项 | 结论 | 锚点 |
|---|---|---|
| Tenant 语义 | ✅ **无**；entity 仅 user/account/email/role/perm | entity 层 |
| 一 Account 多 User | ❌ **无**；`account.user_id` 单归属 | — |
| Account 转移撤销 Share | 📌 AC 保留；**能力不存在**，未来入口必挂钩 | AC-LIFE-12 |
| Account 禁用恢复 Share | N/A（禁用不拦收件；`account.status` 未用） | — |
| `share:manage` 默认授予 | ❌ 种子**无** `share:*`；须在 v3_1DB 内独立 try/catch INSERT perm + `role_perm`（**不可**依赖 `permTotal===0` / `rolePermCount===0` 块；参照 `v1_4DB:271-280` 但须补 role 绑定） | `init.js:271-280,428-518`；`perm-service.js:26-33` |

### 已有状态机、幂等和失败恢复机制

| 项 | 结论 | 锚点 |
|---|---|---|
| Idempotency-Key 设施 | ❌ **无**；`share_idempotency` 表为新建 | 全仓无表 |
| PEPPER / Session `kid` 轮换 | ❌ **无**；JWT 单密钥无 `kid` | `jwt-utils.js:17-20`；无 PEPPER env |
| Share+幂等原子提交 | ✅ `c.env.db.batch()` 可行（AC-SHARE-15）；batch 内语句不得消费前序结果 | T-02 |
| `access_count` 原子递增 | 📌 须新建；可参照 `verify-record-service.js:63-64` sql 模板 | — |
| 统计失败不阻断 Session | 📌 设计已定（AC-LIFE-14）；实现时 catch 须 rethrow 或 log | — |
| 功能开关冻结语义 | 📌 AC-LIFE-13 已定：临时冻结、重开恢复 | 产品决策 |

### 历史 Git、旧实现和废弃逻辑

| 项 | 结论 | 锚点 |
|---|---|---|
| 历史分享能力 | ✅ **无** | — |
| `/public/*` 全局 token | ✅ 单一全局 `KvConst.PUBLIC_KEY`；含可写 `addUser` | `public-service.js:167-169`；`security.js:104-111`；`public-api.js:15-17`；见 ADR |
| D1/附件/白名单事故 | 未知 | — |

### 前后端已有类似能力

| 项 | 结论 | 锚点 |
|---|---|---|
| 匿名路由壳 / 独立 axios / Session 清理 | ❌ **全部为零** | 单一 axios `axios/index.js:6-76`；守卫只豁免 login `router/index.js:103-105`；**无** sessionStorage |
| 安全 iframe 组件 | ❌ **无**；须新建 SafeMailRenderer | — |
| 轮询 composable | ❌ **不可直接复用**；须新建（卸载取消+可见性暂停） | `email/index.vue:51-54,76-131` |
| 复制降级 | ❌ **无**；4 处仅 `navigator.clipboard` | `reg-key/index.vue:261-277` 等 4 处 |
| owner-scoped repository | ❌ **无** | `selectById` 无 owner 条件 |
| 对象存储路径 | ✅ 经 `r2-service.getObj` 分派 KV/R2/S3 | `r2-service.js:43-56`；**返回类型须归一化** |
| `_headers` 源文件 | ✅ `mail-vue/public/_headers`（`:1-5`）；产物 `mail-worker/dist/_headers` 会被构建覆盖 | `.env.release:5` |
| PWA 影响分享页 | ✅ **不影响** | `vite.config.js:36-38` |

### 测试覆盖、规模和性能基线

| 项 | 结论 | 锚点 |
|---|---|---|
| 测试运行器 | ❌ **完全不可用**；须为 T-01 阻塞项 | `vitest.config.js:7` 指向不存在文件；`package.json:7` test=deploy；`test/index.spec.js` Hello World |
| 生产量级 / EXPLAIN / 浏览器矩阵 / E2E | ⚠️ **运行时/人工确认** | 见 tasks.md 末尾 |

## Update Log

### 2026-08-26 · share-fullchain 整改：P4 销毁原生 404 + P1 Owner live 展示（executor）

依据已审决策卡 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md`（用户五条原话整改，dated changelog 记入本 shipped spec，不新开 ADR）：

**P4 · 有意推翻 AC-VISIT-04 的「不存在/已销毁」一支（用户点名：销毁 URL 禁止任何业务 HTML）**：
- 新口径：`lid` 无行 **或** `status='REVOKED'`（gone）→ 浏览器原生 **HTTP 404 空 body**（`Cache-Control: no-store`）；`EXPIRED` / 错 `sec` / 功能关 / 死账号 → 仍不可区分 `SHARE_UNAVAILABLE`。gone 与 unavailable **两族从此可区分**，族内仍不可区分。AC-VISIT-04、AC-LIFE-03 已行内修订。
- 入口全量收口：文档 `GET|HEAD /s/:lid` 由 `mail-worker/src/security/share-document-gone.js` 在 `env.assets.fetch` **之前**拦截；访客 API 由 `throwDestroyed()`（`BizError('SHARE_DESTROYED', 404)`）+ `withShare` 翻成裸 404；已打开 SPA 由 `ShareGoneError` + `share:gone:<lid>` 单次 reload 落到文档拦截（vite 直出环境清空 document 兜底防循环）。gone-check DB 失败 **fail-open** 到 assets 并打 `share.system.error`（reason=`gone-check-failed`）；正常 404 是成功态，不打事件。
- 测试契约同步：`visitor-unavailable.spec.js` 拆为「gone 原生 404 / EXPIRED 仍 SPA」两族；`visitor-revoke-live.spec.js` 改为撤销后 reload 落原生 404；`visitor-headers.spec.js` 改打活链接；worker/vue 各 spec 中「销毁仍回 `SHARE_UNAVAILABLE` 信封」的断言按新口径重写。

**P1 · 局部修订 Owner 展示纪律（AC-LIFE-08 行内 amended）**：Owner 展示侧由「只信 API `effectiveStatus`」改为 `liveEffectiveStatus(row, nowMs)`（`mail-vue/src/views/share-admin/status.js` + `use-share-clock`），页面停留跨过 `expiresAt` 或刷新即翻 `EXPIRED`，不再要求重新登录；鉴权与写入仍以服务端每请求实时计算为唯一真源（前端时钟不得充当写闸门）。

### 2026-08-17 · T-02 D1 事务探测 + spec 漂移修正（executor · 文档波）

**spec-changing finding（T-02）**：drizzle D1 `.transaction()` 不可用（SQL `BEGIN` 被 D1 拒绝）；T-09 须用单语句 `INSERT ... SELECT MAX(...)` + 条件 INSERT + `c.env.db.batch()`。证据：`mail-worker/test/transaction.spec.js` 10/10；`.agent-workspace/.archive/2026-08-17/t-02-d1-transaction/t-02-d1-transaction-findings.md`。

**修正 AC/段落**：
- AC-SHARE-06/12/15/16、AC-ABUSE-02（requirements.md）：「同一 D1 事务」→ 单语句原子性 / `batch()`；AC-SHARE-16 否定原「`.transaction()` 已确认」断言，明确复合游标退路因单语句快照而**仍不实施**
- R3 核实清单 D1 行：`.transaction()` ❌；`batch()` ✅；单语句 `RETURNING`/`meta.changes` ✅
- `share_idempotency` 表定义对齐 `init.js:v3_1DB` + `entity/mail-share.js`（补 `id`、nullable `share_id`/`response_fingerprint`）
- CSP 段（匿名 Bootstrap + requirements R3-A2）：T-21 放宽 `img`/`style`/`font`/`media` 至 `http:`/`https:`（srcdoc 继承父 CSP）；AC-LEAK-02~04 标注 `_headers` 在 `run_worker_first` 下 **unverified**
- Traceability：AC-SHARE-15/16、AC-LEAK-02~04 同步

**评审**：`NEEDS_CHANGES`（1 critical / 1 important）——critical 为 D1 事务假设错误（本波文档修正）；important 为 `share_idempotency` DDL 漂移（本波已对齐）。T-09 实现修正由并行 agent 处理。

### 2026-08-17 · 核实结论回填 + tasks/ADR（executor）

主 AI 亲读源码核实 19 条事实回填 spec；修正被推翻的假设；新增 AC-VISIT-16、AC-SEC-24；矩阵已同步。

**修正段落/AC：**
- Overview Decision 3：轮询从「复用范式」改为「参照但须新建 composable」
- Current-State Inventory：`security.js` 精确匹配、`email` 两阶段写入/`account_id=0`、`r2-service` 返回类型、前端轮询/axios 不可复用
- 领域契约 Account 失效：AC-LIFE-12 转移为未来挂钩；本期挂删除路径
- `shareScopedEmailRepository` 查询契约 + P-SCOPE-01：加 `accountId>0`、`status!=SAVING`、`is_del` 双语义
- 状态迁移表：account 删除/转移行；scheduled 清理锚点
- 对象存储归一化段（新建）；`email.is_del` 双语义段（新建）
- Error Handling：AC-SEC-24 行为
- AC-SHARE-16 / AC-VISIT-05 / AC-LIFE-12 / AC-OTP-14/15 / AC-SEC-21 / 读模型轮询段（requirements.md）
- 「开工前需实现方核实清单」→「已闭合」表格（19 条核实 + 运行时项外移 tasks.md）
- `related_adrs` → `docs/architecture/ADR-mail-share-capability-boundary.md`

**新增 AC：** AC-VISIT-16（排除 SAVING 中间态）、AC-SEC-24（text 空时默认 iframe）

### 2026-08-17 · R3-F3 收尾（executor）

来源 `review3.codex.md` R3-F3（P2）：补齐 Session 清理与多 Share 隔离。新增 AC-VISIT-13~15；扩展「Session 存储（R2-F1 · R3-F3 定稿）」；AC-VISIT-12 键名改为 `share:session:<lid>`。结论：**离开分享路由（`name !== 'share'`）必须清除 token**——同源 `/login`/layout 脚本可读 `sessionStorage`。`spec_coherence.py` blocking=0。

### 2026-08-17 · R3 评审意见落实 + 用户 2 项裁决（executor）

依据 `review3.codex.md`（NEEDS_CHANGES, P0=1, P1=8）及用户 R3 两项裁决：

**R3 九条闭合：**
1. **R3-A1（P0 · 用户裁决）**：附件改 **受控下载端点** `GET /share/attachment`；废弃 AC-SEC-18/19；新增 AC-SEC-20/21、P-ATT-01。理由：公开 `/oss/` 直链使正文与附件出现两个授权真源，「销毁」对附件无效。已知仓内已有 r2/kv-obj/s3 读取封装；**不修**既有 `/oss/*` 缺陷。
2. **R3-A2**：放弃 iframe 自动高度，改固定高度+内层滚动；远程图片默认加载；CSP 分层（外层管壳、内层管邮件）；废弃 AC-SEC-17；新增 AC-SEC-22/23。
3. **R3-A3（用户裁决）**：放弃服务端 25s 长轮询，改客户端 **3 秒**增量轮询；废弃 AC-RT-01~03/06/07/10/11；新增 AC-RT-14~16；Decision 3 写明长轮询为后续升级项及触发条件。
4. **R3-A4**：补请求指纹、同 Key 冲突、同事务提交、清理顺序、统计失败不阻断 Session；新增 AC-SHARE-14/15、AC-LIFE-14。
5. **R3-A5**：429 + `Retry-After` 为独立运输层错误；P-AUTH-01 移出限速；新增 P-TRANS-01、AC-ABUSE-09。
6. **R3-A6**：`pepper_kid` + 双 key 验证窗口；新增 Share Secret 密钥生命周期段。
7. **R3-A7**：窗口快照与 Share 插入同一事务（AC-SHARE-06）；退路 AC-SHARE-16。
8. **R3-F1**：AC-RT-09 改为稳定排序/不重复/不跳过，不承诺内容恒等。
9. **R3-F2**：Account 转移永久撤销（AC-LIFE-12）；功能开关临时冻结、重开恢复（AC-LIFE-13）。
10. **R3-F3**：Session 按 `lid` 键隔离（AC-VISIT-13）；鉴权失败/SHARE_UNAVAILABLE/显式退出清除（AC-VISIT-14）；**离开分享路由必须清除**（AC-VISIT-15）——同源脚本可读 sessionStorage，属安全契约非 UX。
11. **2026-08-17 Session TTL 裁决**：默认 `SESSION_TTL` 从 24h 改为 **15 分钟**；接受 AC-VISIT-12 与 AC-VISIT-15 在硬导航下无法同时干净满足（`pagehide` 会打断刷新）。残留 = 同 tab + 同源 + ≤TTL；过期后须再提交 `lid`+`sec`，不得用过期 token 续期。

**权限与范围：**
- 三份 `share:*` 合并为 `share:manage`（AC-MGMT-09）；废弃 AC-MGMT-08。
- ~~`regenerate` 本期移除；R2 语义保留于「后续 regenerate 约定」；废弃 AC-SHARE-13、AC-LIFE-05/11、P-LIFE-02。~~ → **2026-08-25 重新激活**，见下方 Decision Record 同日条目。

**有意推翻的 R2 结论（避免下轮当不一致）：**
- 附件公开直链（R2 用户收缩）→ R3 受控端点（临时授权边界优先）
- 服务端长轮询（R2-A3 保留）→ R3 客户端 3s 轮询
- iframe 自动高度（R2 沙箱方案）→ R3 固定高度+内层滚动
- 三份 share 权限（R1/R2）→ 单一 share:manage
- regenerate 保留（R2-A2）→ 本期延后 ｜ **2026-08-25 再度反转：重新激活并实现**（本行保留以存续 R2→R3 的裁决轨迹，现状以同日 Decision Record 为准）

**其他：** 新增「开工前需实现方核实清单」节（来自 review3 末尾，全部标 unverified）。矩阵已同步（含 R3-F3 AC-VISIT-13~15）。

### 2026-08-17 · R2 评审意见落实 + 用户方案收缩（executor）

依据 `review2.codex.md`（NEEDS_CHANGES, P0=2, P1=6）及用户 R2 六项裁决：

**R2 八条闭合：**
1. **R2-A1（P0）**：删除双路 OTP 打分器；分享只读 `email.code`（AC-OTP-14/15）；废弃 AC-OTP-01~05/10~13。
2. **R2-A2（P0）**：`regenerate` 仅 `effectiveStatus=ACTIVE`；保持 `expires_at`/Visible Window；EXPIRED 拒绝（AC-LIFE-05/11）；更新状态迁移表。
3. **R2-A3**：保留服务端长轮询；删除 in-flight 5 连接上限（废弃 AC-RT-13）。
4. **R2-A4**：幂等定位为重复检测非可恢复；`sec` 丢失用户代价明示；单一真源 `share_idempotency` 表。
5. **R2-A5**：保留 `access_count`/`last_access_at`；文案改为「成功建立 Session」非阅读确认；写入仅在 Session 建立。
6. **R2-A6**：滥用防护改 Cloudflare 边缘限速（AC-ABUSE-08）；废弃 D1 计数表 AC-ABUSE-05~07；写明 period 10/60s 与 eventually consistent 约束。
7. **R2-A7**：SafeMailRenderer 登录态+分享页**本期一并交付**；沙箱 iframe 替代净化白名单；回归范围：登录态正文排版。
8. **R2-F1**：`sessionToken` → `sessionStorage`（AC-VISIT-12）；fragment `sec` 读后即清。
9. **R2-F2**：删除 Glossary 中 `Reveal` 术语。

**用户 R2 方案收缩（有意推翻 R1）：**
- **附件**：本期提供，复用 `/oss/` 公开直链（AC-SEC-18/19）；推翻 R1「首版不提供附件」——本仓直链本就无鉴权，给访客不新增暴露面；已知代价：链接不随分享到期失效。
- **正文渲染**：沙箱 iframe 原样完整 HTML + 内层 CSP；删除正向允许模型/CSS 过滤（废弃 AC-SEC-03~06/08/11~13）；推翻 R1 净化白名单方案。
- **OTP**：推翻 R1 双路合并；改进版再做确定性打分器。

**AC 变动摘要**：新增 AC-OTP-14/15、AC-SEC-16~19、AC-LIFE-11、AC-VISIT-12、AC-ABUSE-08；废弃见 requirements.md 各 `{status: deprecated}` 行。矩阵已同步。

### 2026-08-16 · R1 评审意见落实（executor）

依据 `review.codex.md` 第 1 轮（NEEDS_CHANGES, P0=3, P1=8）及用户 4 项裁决：

1. **F3 字段裁剪**：删除 `password_hash`/`max_views`/`current_views`/`otp_only`/`allow_html`/`allow_attachments` 预留列；保留 `access_count`/`last_access_at`/`name`/`remark` 并补业务场景表。
2. **A6 滥用防护**：废弃按 `lid` 锁定（AC-ABUSE-01）；改为来源限速 + 全局失败告警 + D1 原子计数；继续禁止 KV。
3. **F1 OTP 双路合并**：置信度 ≥ 阈值优先；低于阈值且与 LLM 不一致时双候选展示（AC-OTP-11）；废弃 AC-OTP-06。
4. **A8 权限默认授予**：新增 `share:create`/`share:query`/`share:revoke`，默认绑定普通用户角色；无 tenant 模型。
5. **A1 Share Session**：补全无状态 HMAC 令牌、Bearer 承载、逐请求回源、密钥轮换契约。
6. **A2 状态机**：持久化仅 ACTIVE/REVOKED；EXPIRED 为 effectiveStatus；补状态迁移表；统一 SHARE_DISABLED vs SHARE_UNAVAILABLE。
7. **A3 Scoped Repository**：范围约束下沉至 `shareScopedEmailRepository`；`project()` 纯映射。
8. **A4/A5/A7/F2**：幂等键、分页游标、容量预算、匿名 bootstrap 隔离、SafeMailRenderer 正向允许模型。

`status` → `reviewing`。
