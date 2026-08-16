# Mail Share · 执行跟踪

> 主 AI 每轮维护本文件。任务定义在 `tasks.md`（T-01~T-27），本文件只记**执行状态、决策与偏差**。

## 本轮用户原始需求

在现有 Cloudflare 域名邮箱项目中，新增**邮件/邮箱安全分享（Mail Share）**：邮箱所有者创建不可猜的临时链接，把某个邮箱在一段时间内收到的邮件临时授权给一个**未登录**的人查看，**不交出邮箱账号密码**。核心场景是转交登录验证码。

用户在设计阶段的关键裁决（不可推翻）：

1. 分享页**完整展示邮件原文**，不做净化筛选 —— 这是临时域名邮箱，没有强防护价值；用沙箱 iframe 承载
2. 自动提取验证码**降级为后续改进版**，本期只读既有 `email.code`
3. 附件**本期提供**，但必须经受控端点，到期/销毁同步失效
4. 登录态详情页的既有 XSS **本期一并修**（换成同一个沙箱渲染器）
5. 实时性用**客户端 3 秒增量轮询**，不做服务端长轮询
6. 范围严格最小集：访问密码、次数上限、阅后即焚、二维码、Webhook、IP 白名单等均不在本期

## 本轮需要完成什么

按 `tasks.md` 的 27 个任务交付可上线的 Mail Share 首版，并满足 88 条 active AC。

**完成的定义**（来自 requirements.md Success State）：一个从未登录本系统的人，只凭所有者给的一条链接，就能在浏览器里看到该邮箱在授权时间窗内收到的邮件和其中的验证码并复制走；链接到期或被销毁后立即不再显示任何邮件内容。**T-25 浏览器 E2E（Chromium · `node tests/e2e/run.mjs` · 10/10）已闭合此句；合并前仍须 §Review findings in flight 四项 + deploy 确认项。**

## 执行方式

- 主 AI：任务编排、依赖协调、结果整合、冲突处理、验收验证、维护本文件。**不直接大量改业务代码**。
- 执行以多 SUB 并行为主；阶段完成即派 Review SUB，同时推进下一波。
- 模型分工：改代码 `cursor-grok-4.6-xhigh-fast` · 文档 `composer-2.5-fast` · 审查 `gpt-5.6-terra-medium`。
- 冲突点单一 owner：`init.js`(T-03) · `security.js`(T-05) · `index.js`(T-12) · 对象存储归一化(T-10)。
- SUB 不执行 git commit，变更留在工作树，由主 AI 统一提交。

## 波次状态

### Wave 1（2026-08-17 · 大部分完成）

| SUB | 任务 | 范围 | 状态 |
|---|---|---|---|
| A | T-01 测试基础设施（阻塞项） | `mail-worker` 测试链 | ✅ **完成 · 主 AI 已独立复跑验证**（16s，2 passed，Miniflare 本地 D1，不部署不构建前端） |
| B | T-17 SafeMailRenderer 沙箱渲染组件 | `mail-vue/src/components/safe-mail/` | ✅ 完成 |
| C | T-19 剪贴板 composable（含降级） | `mail-vue/src/composables/` | ✅ 完成 |
| D | Wave 2 侦察（T-03 / T-05 / T-10 落地细节） | 只读调查 | ✅ 完成 · 产出 4 项 spec/代码不符，已修正 |

### Wave 1.5 · spec 修正波（2026-08-17）

| 触发 | 内容 | 评审 | 状态 |
|---|---|---|---|
| T-02 运行时探测 | drizzle D1 `.transaction()` **不可用**（BEGIN 被拒）；T-09 改单语句 + `batch()` | **NEEDS_CHANGES** · 1 critical / 1 important | ✅ spec 文档已修正（本波）；T-09 **实现**由并行 agent 处理 |
| T-21 实现 | CSP 放宽（srcdoc 继承父 CSP）；`_headers` under `run_worker_first` unverified | — | ✅ 已写入 design + AC-LEAK-02~04 |
| DDL 漂移 | `share_idempotency` 缺 `id`/nullable 列于 design | important | ✅ design 已对齐 `init.js` + entity |

**T-02 证据**：`mail-worker/test/transaction.spec.js` 10/10；`.agent-workspace/.archive/2026-08-17/t-02-d1-transaction/t-02-d1-transaction-findings.md`

T-01 交付物：改 `vitest.config.js`（configPath 指向新建的 `wrangler-vitest.toml`）、`package.json`（`test` → vitest，原部署脚本改名 `test:deploy`）；新建 `wrangler-vitest.toml`（无 `[build]`、本地 D1）、`test/setup.js`、`test/smoke.spec.js`；删除 Hello World 模板。开发者命令：`pnpm --dir mail-worker test`。

并行安全性：A 只动 `mail-worker`，B/C 只动 `mail-vue` 且文件不相交，D 只读。无 worktree 隔离需求。

### 后续波次（预定）

- **Wave 2**：T-03 迁移（单 owner）→ 打开 ‖-1
- **Wave 3**：‖-1 组 T-05 / T-06 / T-08 / T-12 / T-21
- **Wave 4**：‖-2 组 T-07 / T-09 / T-10 → 阶段 Review
- **Wave 5**：前端 ‖-3 组 T-14~T-16 / T-20 / T-26
- **Wave 6**：T-18 / T-22 → T-24 集成 → T-25 E2E — ✅ **完成**（2026-08-17）

### Wave 6 交付摘要（2026-08-17）

| 任务 | 状态 | 证据摘要 |
|---|---|---|
| T-18 ShareView | ✅ | `index.spec.js` 15/15（五态 + OTP/附件/轮询）；`node tests/e2e/run.mjs` Success State |
| T-23 clipboard 收敛 | ✅ | 4 处 `useCopyWithFallback`；`header/index.copy.spec.js` 2/2；`grep writeText` → 0 |
| T-25 浏览器 E2E | ✅ | `tests/e2e/` 10 Playwright 场景；`email()` 入站非 D1 直插 |
| T-27 mail-vue 测试 | ✅ | 绿基线 **15 files / 70 tests** |

**测试绿基线（executor 2026-08-17）**：`pnpm --dir mail-worker test` → 16 / 137 · `pnpm --dir mail-vue test` → 15 / 70 · `node tests/e2e/run.mjs` → 10 passed

**AC-VISIT-10 运行时发现**：`mail-vue/index.html` 曾无条件加载 Google Fonts + Turnstile；已改为 `/s/` 路径跳过 — 仅真浏览器 E2E 捕获。

## 合并门禁 · Review findings in flight（2026-08-17 · 勿标完成）

审查判定 **not merge-ready** 直至下列四项闭合（并行 agent 修复中；详见 `tasks.md` §Review findings in flight）：

1. **`websiteConfig` 白屏** — 匿名 share 仍阻塞在 `init()` → `websiteConfig()`（`init.spec.js` 红）
2. **`srcdoc.spec.js` vitest 门禁** — sandbox/CSP 断言须为默认 `pnpm --dir mail-vue test` 一部分
3. **Axios 错误日志泄密** — 失败 session 请求 `{ lid, sec }` 可能经 `console.error(err)` 泄漏
4. **Session TTL + hard-navigation 文档** — TTL 缩短与 residual exposure 须写入 spec

## 决策与偏差记录

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-08-17 | 前端 T-17 / T-19 提前到 Wave 1，不等 T-03 | 二者与 D1 及测试基线零依赖，`tasks.md` 的排序是保守估计；提前可压缩关键路径 |
| 2026-08-17 | T-04 / T-05 提前，不等 T-03 完成 | 文件归属澄清后与在跑任务零重叠；T-05 的权限测试若遇 T-03 未落地，自行在夹具种权限行 |

## 跨 SUB 共享契约（唯一真源 · 新建服务一律照此对齐）

由 T-10 在实现中确定并回写 `design.md` / `tasks.md`，T-08 已按此派发：

| 调用 | 签名 |
|---|---|
| 会话解析 | `shareAuthService.resolveSession(c, sessionToken)` |
| 范围内列表 | `shareScopedEmailRepository.list(c, ctx, cursor, limit)` |
| 范围内取单封 | `shareScopedEmailRepository.getById(c, ctx, mailId)` |
| 附件下载 | `shareAttachmentService.download(c, { sessionToken, mailId, attachmentId })` |

`ShareContext` 形状：`{ accountId, windowStartEmailId, ... }`（`accountId` 必须 `> 0`；`windowStartEmailId` 可为 `0`）。本仓库不解读 `effectiveStatus`。

T-06 对账：已按三参落地，与 `share-attachment-service.js:150` 一致。`getById(ctx, mailId)` / `list(ctx, cursor, limit)` 在 live spec/code 零命中。

## 进度快照（2026-08-17 · post-T-25 文档刷新）

**测试绿基线（executor 复跑）**：`pnpm --dir mail-worker test` → **16 files / 137 passed**；`pnpm --dir mail-vue test` → **15 files / 70 passed**；`node tests/e2e/run.mjs` → **10 passed** (Chromium, 24.2s)。

| 任务 | 状态 |
|---|---|
| T-01~T-17、T-19~T-24、T-26~T-27 | ✅ 完成（证据见 `tasks.md` 各节） |
| T-18 ShareView 邮件/OTP/附件 UI | ✅ 完成 · 15 mount tests + E2E Success State |
| T-23 四处 clipboard 收敛（可选） | ✅ 完成 |
| T-25 浏览器 E2E | ✅ 完成 · `tests/e2e/` 10 场景 |
| **合并阻塞** | 🔧 四项 review finding in flight（见上节） |

### 关键结论：drizzle `.transaction()` 在 D1 上不可用

T-02 实测：drizzle-orm 0.42 的 D1 驱动发 SQL `BEGIN`，D1 在回调执行前就以 `D1_ERROR` 拒绝。早先侦察从**类型定义**看到该 API 存在，被记成「能力已确认」——API 存在 ≠ 运行时可用。这正是 T-02 排在写路径之前的价值。

替代方案（T-09 已按此实现）：单语句 `INSERT ... SELECT MAX(...)` 做窗口快照、条件写 + `meta.changes` 做活跃上限、`c.env.db.batch()` 做跨表原子提交。spec 相关 AC 与设计段已同步修正。

### 依赖漂移（用户裁决：接受 + 必须验证）

加测试运行器导致 pnpm 重解析锁文件，411 处版本变动（Vue 3.5.20→3.5.41、vue-router 4.5.1→4.6.4、dexie 4.2.0→4.4.5 等），均在既有 semver 范围内。已验证：release 构建成功、231 个产物一致、前后端两套测试全绿。

⚠️ 新增待办：**vue-router 4.6 已弃用本应用仍在使用的 `next()` 回调**（`router/index.js` 守卫）。4.6.4 仍接受，未来升 5.x 需改写。与本期无关，登记备查。

## 事故与纠偏记录

### 2026-08-17 · 测试套件整体失效（已解决）

**现象**：`pnpm --dir mail-worker test` 连续两次全量失败，8 个文件 `no tests`，错在 workerd 内部 `updateStackedStorage`。

**主 AI 的初始归因（错误）**：以为是八个 SUB 并发跑同一条命令、抢同一份 `mail-worker/.wrangler` 状态目录。

**真实根因（由独立 debugger 证伪并查明）**：`vitest-pool-workers` 的 `isolatedStorage` 默认**给每个测试文件各起一个 workerd 实例**；Windows 上模块回退走本机 loopback，实例数上去后 `ConnectEx #1225/#52` 连接失败，被包装成 `internal error`。与并发只是相关而非因果——单跑同样会失败，只是文件少时不触发。

**修复**：`vitest.config.js` 开 `singleWorker: true`（保留存储隔离）+ 每进程独立 Vite `cacheDir`。两个套件同时启动均通过（各 10 files / 74 tests）。主 AI 已独立复跑验证。

**教训**：并发是最显眼的变量，但显眼不等于是原因。派独立 debugger 而不是顺着自己的假设改配置，避免了在错误方向上改动测试隔离设置。

## 已澄清（一次错误归因的更正）

- **前端套件那次偶发失败不是并发抖动**。主 AI 最初归因为「多个 SUB 同时跑 vitest」，T-18 复现后查明真因：全量套件下**首次懒加载较重的 ShareView 超过 vitest 默认 5 秒超时**；同一用例隔离单跑 2.36 秒通过。修法是在 router spec 里 stub 掉 `@/views/share/index.vue`（那组用例本就只测守卫，不测页面）。
  - 与早先 workerd 那次同一形状：**并发是最显眼的变量，但显眼不等于是原因**。两次都是先假设并发、后被实测推翻。

## 发现的既有缺陷（本期不修，单列上报）

| # | 缺陷 | 锚点 | 影响 |
|---|---|---|---|
| E-1 | 全新库上迁移链必然报一次错：`v2_7DB` 执行 `ALTER TABLE setting RENAME COLUMN auto_refresh_time TO auto_refresh`，但 `intDB` 建表时列名本就是 `auto_refresh` | `init.js:80` vs `init.js:598` | 被 try/catch 吞掉，功能无害；但每次测试运行 stderr 都会留一行 `D1_ERROR: no such column: "auto_refresh_time"`，**会掩盖真实错误**。修它要动迁移链，有回归风险，故不在本期 |

## 风险看板

| 风险 | 状态 |
|---|---|
| 测试基线完全不可用，所有真 D1 断言被阻塞 | ✅ Wave 1 T-01 已闭合 |
| drizzle D1 `.transaction()` 不可用；T-09 须单语句 + `batch()` | ✅ T-02 已探测并回填 spec（2026-08-17） |
| 登录态详情页换渲染器 → 正文排版回归 | T-22，最可能拖慢上线 |
| Safari/WebKit 下 sandbox + srcdoc 行为差异 | T-25 仅 Chromium；Firefox/Safari 待矩阵 |
| 生产量级下新索引是否真命中 | T-24 本地 EXPLAIN 已绿；生产 cardinality 待测 |
| 合并前 review findings（websiteConfig / srcdoc 门禁 / 日志泄密 / Session TTL 文档） | 🔧 并行修复中 |

## Wave 2 侦察结论（2026-08-17）

来源：Wave 2 只读侦察（主 AI 亲读 `init.js` / `security.js` / `perm-service.js`），已回填 `tasks.md` 与 `design.md`。

| # | 发现 | 文档修正 |
|---|---|---|
| 1 | T-03 原指令扩展 `init.js:432-461` 块；该块在 `permTotal === 0` 内（`428-463`），`role_perm` 块在 `rolePermCount === 0` 内（`504-518`）——生产库均跳过，会静默授予失败 | T-03 改为 `v3_1DB` 内独立 try/catch INSERT perm + `role_perm(role_id=1)`，参照 `v1_4DB:271-280` 并注明 v1_4 未绑 role 的遗漏 |
| 2 | T-03 与 T-04 均列 `entity/mail-share.js`；schema 归 T-04 | 从 T-03 文件列表移除；T-03 仅 DDL + 种子 |
| 3 | T-05 将 Owner `/mailShare/*` 与 Visitor `/share/*` 同列 JWT 豁免；与 design 矛盾 | T-05 拆为 JWT 豁免集（Visitor 四端点）与权限门控集（Owner 三路 + `requirePerms`/`premKey`）；补充 hybrid 匹配器约束（保留 `/oss/` 等前缀） |
| 4 | design 称 `share:manage` 绑定「所有普通用户角色」；仓内仅一个默认角色 `role_id=1` | design 领域契约改为默认角色 + 自定义角色须管理员分配 |

## Update Log

- 2026-08-17 executor T-01: wired `mail-worker` vitest to `wrangler-vitest.toml` (local Miniflare D1, no `[build]`); `test` is now `vitest run`, old deploy kept as `test:deploy`. Red: Hello World snapshot vs real SPA HTML (2 failed, 8.26s). Green: `pnpm --dir mail-worker test` → 2 passed (5.41s). Report: `.agent-workspace/.archive/2026-08-17/t-01-mail-worker-test-harness/t-01-mail-worker-test-harness-completion.md`.
- 2026-08-17 executor T-19: added `mail-vue/src/composables/useCopyWithFallback.js` (Clipboard API → execCommand → selected fallback; reports `path`). Red: `node --test src/composables/useCopyWithFallback.spec.js` 1 pass / 4 fail (writeText missing or NotAllowedError, no fallback). Green: 5 pass / 0 fail. Four existing copy sites not touched. Report: `.agent-workspace/.archive/2026-08-17/t-19-use-copy-with-fallback/t-19-use-copy-with-fallback-completion.md`.
- 2026-08-17 executor T-06: added `mail-worker/src/service/share-scoped-email-repository.js` + D1 poison-row spec. Signatures `list(c, ctx, cursor, limit)` / `getById(c, ctx, mailId)` match T-10. Red 4 failed (unscoped leak of account_id=0 / SAVING / below-window / other-account). Green 4 passed. Report: `.agent-workspace/.archive/2026-08-17/t-06-share-scoped-email-repository/t-06-share-scoped-email-repository-completion.md`.
- 2026-08-17 executor T-10: added `mail-worker/src/service/share-attachment-service.js` (normalize KV/R2/S3 → one Response + scoped download). Red 11 fail / 3 pass; green 14/14; full `pnpm test` 25/25 exit 0. Propagated repo signature to `getById(c, ctx, mailId)`. Report: `.agent-workspace/.archive/2026-08-17/t-10-share-attachment-service/t-10-share-attachment-service-completion.md`.
- 2026-08-17 executor T-17: built `mail-vue/src/components/safe-mail/` (srcdoc.js + index.vue + harness). Red: `node --test srcdoc.spec.js` 1 pass / 14 fail (stub). Green: 15 pass / 0 fail. Chromium harness 9/9 PASS (script/onerror/onload did not run; frame localStorage SecurityError; fixed-height scroll). Not wired; shadow-html untouched. Report: `.agent-workspace/.archive/2026-08-17/t-17-safe-mail-renderer/t-17-safe-mail-renderer-completion.md`.
- 2026-08-17 executor T-27: wired `mail-vue` vitest 4.1.10 + jsdom + Vue Test Utils; `test` is `vitest run`. Merges `vite.config.js` at mode `test`, strips PWA, pins `outDir` away from `mail-worker/dist`. Converted `useCopyWithFallback.spec.js` off `node:test`. Red: hamburger `is-open` (1 failed / 6 passed). Green: `pnpm --dir mail-vue test` → 2 files, 7 passed. `safe-mail` excluded (T-17 still `node:test`). Report: `.agent-workspace/.archive/2026-08-17/t-27-mail-vue-test-runner/t-27-mail-vue-test-runner-completion.md`.
- 2026-08-17 executor T-21: extended `mail-vue/public/_headers` with `/s/*` no-store / no-referrer / noindex,nofollow / outer CSP. Widened img/style/font/media http(s) because srcdoc inherits parent CSP (CSP3 7.8); literal design `img-src 'self'` would block AC-SEC-23. Build `pnpm --dir mail-vue run build` copied byte-identical `_headers` to `mail-worker/dist/_headers` (895 bytes; three cache rules kept). `run_worker_first` apply: unverified without deploy. Report: `.agent-workspace/.archive/2026-08-17/t-21-share-headers/t-21-share-headers-completion.md`.
- 2026-08-17 executor T-02: added `mail-worker/test/transaction.spec.js`. **Spec-changing**: drizzle D1 `.transaction()` unusable (BEGIN rejected); T-09 must use single-statement `INSERT...SELECT` + `env.db.batch()`. Red: orphan assertion `expected 1 to be +0`. Green: 10/10. Parallel spec doc wave: AC-SHARE-06/12/15/16, R3 checklist, `share_idempotency` DDL, CSP/`_headers` notes. Review: NEEDS_CHANGES (1 critical / 1 important). Report: `.agent-workspace/.archive/2026-08-17/t-02-d1-transaction/t-02-d1-transaction-findings.md`.
- 2026-08-17 executor (doc wave): spec corrections for T-02 finding + T-21 CSP + `share_idempotency` drift in `requirements.md`, `design.md`, `tasks.md`, `EXECUTION-TRACKER.md`. `spec_coherence.py` blocking=0 expected.
- 2026-08-17 executor T-09: added `mail-worker/src/service/mail-share-service.js` (create/list/revoke). Window + active cap are one `INSERT...SELECT`; share+idempotency use `env.db.batch()`. Replay never re-issues `sec`. Red: 6 failed (concurrent cap, replay sec, conflict, fingerprint, INSERT...SELECT). Green: 21/21 then full suite 12 files / 103 tests. Report: `.agent-workspace/.archive/2026-08-17/t-09-mail-share-service/t-09-mail-share-service-completion.md`.
- 2026-08-17 executor T-11: registered visitor `/share/*` + owner `/mailShare/*` in `share-api.js` / `mail-share-api.js` / `webs.js`; responses use `share-result` + `Cache-Control: no-store`; `Idempotency-Key` passed through. Red: 6 failed (`POST /mailShare/create` 404). Green: 6/6 then full suite 14 files / 114 tests. Report: `.agent-workspace/.archive/2026-08-17/t-11-share-api/t-11-share-api-completion.md`.
- 2026-08-17 executor T-13: hooked account soft/hard/user-wipe delete to `mailShareService.revokeByAccountId(s)` (single `applyRevoke` UPDATE). Red: 4 failed (`ACTIVE` left after delete; restore revived visitor). Green: 5/5 then 13 files / 108 tests (excluded in-progress T-11 `share-api.spec.js`). Report: `.agent-workspace/.archive/2026-08-17/t-13-account-delete-share/t-13-account-delete-share-completion.md`.
- 2026-08-17 executor T-22: switched logged-in `content/index.vue` to `SafeMailRenderer`; deleted unused `shadow-html` (only consumer was this view). Red: 4 failed (SafeMailRenderer absent). Green: 4/4; hamburger+copy+content 11/11. Chromium: 5 fixtures rendered; default is text-first; HTML is 480px sandbox iframe. Report: `.agent-workspace/.archive/2026-08-17/t-22-logged-in-safe-mail/t-22-logged-in-safe-mail-completion.md`.
- 2026-08-17 executor T-26: Cloudflare Workers Rate Limiting on anonymous `/share/*` (not lid lock, not D1/KV). 429 + Retry-After returned as Response so `hono.js` onError cannot rewrite it to HTTP 200. Key is CF-Connecting-IP only. Red: 4 failed (`expected 200 to be 429`). Green: 7/7 then full suite 15 files / 121 tests. Report: `.agent-workspace/.archive/2026-08-17/t-26-share-rate-limit/t-26-share-rate-limit-completion.md`.
- 2026-08-17 executor T-15: top-level `/s/:lid` `share` route + guard exemption; fragment `replaceState`; `sessionStorage` `share:session:<lid>` isolated and cleared on fail/unavailable/exit/leave-route. Red: 18 failed / 1 passed (no route, stub session). Green: 20 T-15 tests + chunk build assert (no Dexie/layout/axios-index/websiteConfig). Report: `.agent-workspace/.archive/2026-08-17/t-15-share-route/t-15-share-route-completion.md`.
- 2026-08-17 executor T-23: swapped 4 leftover `navigator.clipboard.writeText` sites onto `useCopyWithFallback` (header / account / reg-key / email-scroll). Success toast only when `copied`. Red: header mount 1 fail / 1 pass (no fallback host). Green: 2/2; composable+header 7/7. Exercised header; reasoned the other three. Report: `.agent-workspace/.archive/2026-08-17/t-23-copy-fallback-converge/t-23-copy-fallback-converge-completion.md`.
- 2026-08-17 executor T-18: assembled visitor ShareView on T-15 shell — list/detail, `email.code` OTP+sender+copy-with-fallback, `/share/attachment` blob download, 3s poll, dead vs 429. Red: 8 failed / 7 passed (empty `data-share-body`). Green: 15/15 then 14 files / 69 passed (excluded chunk spec). `node scripts/assert-share-chunk.js` → violations []. Report: `.agent-workspace/.archive/2026-08-17/t-18-share-view/t-18-share-view-completion.md`.
- 2026-08-17 executor T-18 close-out: `pnpm --dir mail-vue test` first two full runs timed out on router `open /s/:lid` (5s, first ShareView import under suite load). Isolated that test passed (2.36s). Stubbed ShareView in `router/index.spec.js` (guard tests do not need the mailbox page). Third full run: 15 files / 70 passed. `node mail-vue/scripts/assert-share-chunk.js` → `violations: []` marker `assets\\index-D5y-HPRP.js`.
- 2026-08-17 executor (doc ledger refresh): reconciled `tasks.md` + `EXECUTION-TRACKER.md` post T-18/T-23/T-25 landing. Marked T-18/T-23/T-25 done with auditable test names + run output (worker 16/137, vue 15/70, e2e 10/10). Added §Review findings in flight (4 open). Refreshed §人工确认 for E2E proved vs simulated vs deploy. AC-VISIT-10 index.html third-party skip documented. `spec_coherence.py` blocking=0 (executor run).
