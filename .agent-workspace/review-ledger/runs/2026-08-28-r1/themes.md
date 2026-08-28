# Themes · 2026-08-28-r1

range: `9b6eb8072fe73c93518e872037702a2e8e54056b..083c87f2d2ccc8c459adfd45fc31a43afc63256f`
commits: 10 → themes: 9 · 侦察产出，非审查结论

判据源（scope.md「判据源」段，全部实读过）：
`docs/specs/mail-share/{design,requirements}.md` · `docs/specs/mailbox-share-capability/{design,requirements}.md` ·
`docs/architecture/ADR-mail-share-capability-boundary.md` 等三份 ADR ·
`.agent-workspace/.archive/2026-08-26/share-link-fullchain/{share-fullchain-decision-card.md,visitor-share-ui-design.md,p4-destroyed-entrypoints.md}`

提交归属总表（`0f4f52c` 是一个横跨六件事的批次提交，按业务语义拆开归属）：

| sha | 主题 |
|---|---|
| f6670e0 | T9 |
| 864358d | T8 |
| 0f4f52c | T1 / T2 / T3 / T4 / T6 / T7（拆） |
| 8a80014 | T1 |
| c0a4a45 | T9 |
| 7cafb35 | T9 |
| c0ede67 | T9 |
| 790c550 | T1 |
| 1da171f | T3 |
| 083c87f | T5 |

---

## T1 · 批量建分享的「整单成立或整单不成立」在真实 D1 上被推翻了两次，最后退回批后消歧

- **theme_id**: T1
- **commits**: `0f4f52c`（`prepareShareBatchComplete` / `isPartialInsert` 部分）、`8a80014`、`790c550`
- **intent**
  Owner 一次粘贴 N 个地址创建 N 条分享，必须要么 N 条全部可用、要么库里零残留 —— 中间态会让 Owner 把一条根本不存在的链接发给别人。D1 的 `batch()` 不认「INSERT 影响 0 行」为失败，所以这个不变量没有天然载体。本组三个提交是同一条不变量在真实平台行为下的三轮定盘：先用 `RAISE(ABORT)` 把零行变成语句错误（0f4f52c），发现 D1 禁止触发器外 RAISE 改成 `1/0`（8a80014），最后实测 SQLite 除零返回 NULL 而不报错、哨兵从未回滚过任何东西，于是整段删除并改回「batch 提交后读 `meta.changes` 消歧」（790c550）。净效果是这条不变量当前没有 batch 内的强制手段。
- **surfaces**
  `mail-worker/src/service/mail-share-service.js` 的 `createFromEmails` 写路径（D1 `batch()` 语句装配 + 批后消歧 + `attempt` 重试环）· 幂等重放读路径（`replayFromIdempotency` / `replayBatchFromLids`）· `mail-worker/test/mail-share-emails.spec.js` 测试契约面
- **refs**
  `docs/specs/mail-share/requirements.md` AC-SHARE-12 ·
  `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-13 / AC-CAP-14 ·
  `docs/specs/mail-share/design.md`「2026-08-17 · T-02 D1 事务探测」节（`.transaction()` 不可用、须走条件 INSERT + `batch()`）·
  决策卡 `share-fullchain-decision-card.md` DC-P0-1（批量分流）/ DC-P0-3（D1 batch）
- **review_focus**
  1. 现在唯一的部分写入检测是 batch **之后**的 `shareRows.every((row) => row.meta.changes)`（`mail-share-service.js` ≈1358）。查：当某一条 share INSERT 零行时，同一 batch 里已提交的 `prepareBindingInsertByEmails` / `syncPrimaryAccountId` / `prepareAccountInsert` / `prepareIdempotencyInsert` 是否留在库里。判据是 AC-CAP-03/AC-CAP-13 的「整单拒绝 SHALL NOT 留下部分 Binding」——不是「有没有抛错」，是「抛错之后库里干不干净」。`test/mail-share-emails.spec.js` 里查有没有一条钉零残留的用例，还是只钉了 `SHARE_LIMIT_EXCEEDED` 这个码。
  2. 790c550 的删除论证是「share INSERT 零行只可能来自归属谓词」。去 `prepareShareInsertByEmails` 的 WHERE 逐条看谓词构成，特别是 `limit: limit - (groups.length - 1 - index)` 这个每条各不相同的限额折算 —— 若限额谓词也能单独让第 i 条零行而第 j 条非零，那句「只可能来自归属」就不成立，整个删除的理由基础要重估。
  3. `isPartialInsert` 分支删掉后，`SHARE_LIMIT_EXCEEDED` 只剩批后消歧一条抛出路径。查这条路径在有 `Idempotency-Key` 时先走 `replayOrConflict`：如果部分行已提交、`replayBatchFromLids` 又要求 lid 集合精确相等（同批 0f4f52c 加的），会落到 `SHARE_NOT_FOUND` 还是落到 `SHARE_LIMIT_EXCEEDED`。判据：AC-CAP-14 的重放语义。
  4. 790c550 的提交信息声称「真实 D1 实测:该语句 success=true,同批 INSERT 存活未回滚」。查这份实测证据在仓内哪里落盘（`.agent-workspace/` / `docs/specs/mail-share/design.md` 的 T-02 节 / 台账 evidence 字段）。判据：决策卡任务清单 VERIFY 条原话「环境不可用必须写 Evidence 阻塞原因，禁止静默跳过」。
  5. `ledger.jsonl` 里 F-0004 当前是 `status: resolved`，`close_note` 写「commit 0f4f52c + 8a80014 · 哨兵改为 SELECT 1/0」，而 790c550 已把那段代码整个删除。查这条应转 `invalidated` 还是 reopen，以及 `INDEX.md` 覆盖区「P1=0」是否因此失真（与 T9 同一处证据）。
  6. 8a80014 顺手在 `mail-vue/src/views/share/session.spec.js` 补了一个 `vi` import，与 worker 侧哨兵毫无关系。查这行之前缺失时该 spec 的哪个分支根本没执行到 —— 一个被 import 报错掩盖的分支和一个通过的分支不是一回事。
- **risk**: high —— 数据完整性不变量在三个提交里反复，终点是「没有强制手段，只有批后事后检查」，且台账仍记为已修复。
- **risk_spread_budget**
  - name: `d1-batch-partial-write`
    origin: `mail-worker/src/service/mail-share-service.js` `createFromEmails`
    allowed_hops: 2（`createFromEmails` → `prepareShareInsertByEmails` / `prepareBindingInsertByEmails` / `prepareAccountInsert` → `mailbox-provision.js` 谓词）
    allowed_surfaces: `mail-worker/src/service/`、`mail-worker/test/mail-share-emails.spec.js`
    stop_when: 已确定「零行时同批其余语句是否留库」这一个事实，无论答案是留还是不留 —— 不要顺着 `insertShareAndIdempotency` 的单条创建路径继续扩散
  - name: `idempotent-replay-vs-partial-batch`
    origin: `replayBatchFromLids` 的 lid 集合精确相等断言
    allowed_hops: 1（`replayOrConflict` → `replayFromIdempotency` → `replayBatchFromLids`）
    allowed_surfaces: `mail-worker/src/service/mail-share-service.js`、`mail-worker/test/mail-share-emails.spec.js`
    stop_when: 已判定「部分提交 + 同键重发」落在哪个错误码上；不要把 `share_idempotency` 表结构/保留期清理拉进来

---

## T2 · 建号配额与角色域名权限从「预检」变成「batch 内谓词 + 缺角色即拒」

- **theme_id**: T2
- **commits**: `0f4f52c`（`mailbox-provision.js` 与 `createFromEmails` 的 `accountGuardSql` 部分）
- **intent**
  `emails[]` 建分享会顺带 find-or-create 邮箱。此前配额只在 `planMailboxProvision` 里做了一次预检，两个并发请求各自预检通过后可以一起把用户的邮箱数顶穿 `role.accountCount`；同时 role 行缺失时代码走的是 fail-open（跳过配额与域名白名单）。本组把配额判定折算成一条能跟 account INSERT 同批生效的 SQL 谓词，并把「查不到 role 行」改成 fail-closed 拒绝。
- **surfaces**
  `mail-worker/src/service/mailbox-provision.js`（建号不变量的唯一居所，新增 `resolveNonAdminAccountQuota` / `accountQuotaPredicateSql` / `accountQuotaPredicateBinds` 三个 export）· `mail-worker/src/service/mail-share-service.js` `createFromEmails` 的 guard 装配 · 设置页建号入口 `account-service.add` 共用同一居所
- **refs**
  `docs/specs/mailbox-share-capability/design.md` 错误码表「create `emails[]` 含账号侧不可用地址 → `SHARE_ACCOUNT_FORBIDDEN`」·
  `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-01（amended 2026-08-26）·
  决策卡 DC-P0-2（建号不变量唯一居所下沉）· 台账 carryover F-0008 / F-0009 / F-0010（锚点均在本文件）
- **review_focus**
  1. `accountQuotaPredicateBinds` 返回 `[userId, accountCount - (missingCount - 1)]`，配 `accountQuotaPredicateSql` 的 `COUNT(*) < ?`。查这个折算与 `planMailboxProvision` 里的 `owned + missing.length > accountCount` 是否逐边界等价，特别是 `missingCount = 1`、`owned = accountCount - 1`、`owned = accountCount` 三个点。两处判据就在同一个文件里，直接对照。
  2. 谓词只在 `plan.missing.length` 非零**且** `resolveNonAdminAccountQuota` 返回非 null 时注入。查它的两条 null 出口（`userRow.email === c.env.admin`、`!(roleRow.accountCount > 0)`）是有意豁免还是漏网 —— 判据是 requirements 里有没有对应的 AC，若没有则这是一条无 AC 的实现自由裁量（与 carryover F-0009 同族）。
  3. `resolveNonAdminAccountQuota` 在 `createFromEmails` 里是 batch 之前一次新增的 `userService.selectById` + `roleService.selectById` 往返，而 `planShareMailboxes` 刚刚已经做过同样两次查询。查是否重复往返；更要紧的是查它在 `for (let attempt = 0; ; attempt += 1)` 重试环**外**取值 —— 重试时用的还是第一次读到的 `accountCount`。
  4. `!roleRow → deny(PROVISION_DENIED.QUOTA_EXCEEDED, { limit: 0 })` 这条 fail-closed 现在同时写在 `planMailboxProvision` 和 `resolveNonAdminAccountQuota` 两处。查两处是否会被翻成同一个对外错误码，以及设置页「添加账号」入口走到这条时用户看到的是什么。判据：capability design 错误码表要求账号侧不可用一律 `SHARE_ACCOUNT_FORBIDDEN`，「不为新入口扩大可探测面」。
  5. 三条 P2 carryover（F-0008 `configuredDomains` 子串匹配、F-0009 前缀黑名单大小写、F-0010 `mailbox-provision → user-service → account-service` 间接环）的锚点就在本次改动的文件里。查新增的三个 export 有没有把 F-0010 那个环拉得更紧（`mail-share-service` 现在直接 import 了更多 provision 内部符号）。
- **risk**: high —— 授权与配额闸门，改的是并发下的写入判定，且同一文件已有三条未关闭的 P2。
- **risk_spread_budget**
  - name: `account-quota-predicate-equivalence`
    origin: `mailbox-provision.js` `accountQuotaPredicateBinds` / `accountQuotaPredicateSql`
    allowed_hops: 1（谓词 → `prepareAccountInsert` 的 `guardSql` 拼接点）
    allowed_surfaces: `mail-worker/src/service/mailbox-provision.js`、`mail-worker/src/service/mail-share-service.js`
    stop_when: 三个边界点（missing=1 / owned=limit-1 / owned=limit）的预检与谓词结论已逐一对齐或已找到分歧
  - name: `missing-role-fail-closed-blast-radius`
    origin: `planMailboxProvision` 与 `resolveNonAdminAccountQuota` 的 `!roleRow` 分支
    allowed_hops: 2（provision → `account-service.add` 设置页入口 → 用户可见错误码）
    allowed_surfaces: `mail-worker/src/service/`、`mail-worker/test/mail-share-emails.spec.js`
    stop_when: 已确认设置页与分享创建两条入口在 role 缺失时的对外码；不要展开成 role/permission 体系的整体审查

---

## T3 · 被销毁的分享 URL：既要与浏览器原生 404 同貌，又不能当免费的存在性预言机

- **theme_id**: T3
- **commits**: `0f4f52c`（`SHARE_DOC_PATH` 大小写 + Vue router `alias` + `init.js` 部分）、`1da171f`
- **intent**
  `/s/:lid` 这条跑在 hono 之前的裸 `fetch` 路径是判定「这条分享还在不在」的地方。两个缺口：一是 worker 只认小写 `/s/`，访客打开 `/S/<lid>` 会绕过 gone 检查落到 SPA fallback 的 200 业务壳；二是这条路径完全没有限流，探测者可以零成本无限次试探哪些 lid 已销毁，每次还换来一次 D1 查询。本组把大小写入口对齐（worker 正则 + Vue 路由 alias + 匿名访客判定三处同改），并给这条路径接上限流 —— 关键是拒绝响应必须是空 body，塞 JSON 信封等于把「这里是分享系统」白送出去。同时给 404 补 `Referrer-Policy` / `X-Robots-Tag`，因为 lid 就在 URL 里。
- **surfaces**
  `mail-worker/src/index.js` 的裸 `fetch` 入口（`assets.fetch` 之前的拦截层）· `mail-worker/src/security/share-document-gone.js` · `mail-worker/src/security/share-rate-limit.js`（新增 Request 版 `enforceShareRateLimitOnRequest`，与 hono 中间件版共用 `shareLimiterAllows`）· `mail-worker/wrangler.toml` 的 `[[ratelimits]]` 绑定面 · **ui-surface**：`mail-vue/src/router/index.js` 的 `/s/:lid` 路由与 `alias: '/S/:lid'`、`mail-vue/src/init/init.js` 的匿名访客判定
- **refs**
  `docs/specs/mail-share/requirements.md` AC-VISIT-04（revised 2026-08-26）/ AC-LIFE-03（revised）·
  `docs/specs/mail-share/design.md` P-AUTH-01（gone 不在集合内）、P-TRANS-01（429 为独立运输层错误）、错误码注册表 `SHARE_DESTROYED` ·
  `p4-destroyed-entrypoints.md` #1/#2/#10（入口全量收口）· AC-ABUSE-08
- **review_focus**
  1. 限流现在落在 `shareDocumentIfGone` 的 D1 查询**之前**，对所有 `/s/:lid` GET|HEAD 计数 —— 包括活链接。而 `SHARE_READ_RATE_LIMITER` 在 `wrangler.toml` 是 `limit = 100, period = 60`，同一份配额已被 `share-api.js` 的 `/share/mails`、`/share/mailboxes/status`、`/share/mail`、`/share/attachment` 四个访客 API 消费（该文件 75/93/99/109 行）。访客页轮询是 `POLL_INTERVAL_MS = 3000`。查一个正常访客在 60 秒里会不会自己把配额吃掉，进而把自己的页面刷新打成空 body 429。判据：AC-ABUSE-08 + P-TRANS-01（429 不得被访客当成「链接没了」）。
  2. 空 body 429 与空 body 404 的响应头不同：429 是 `Retry-After` + `Cache-Control: no-store`；404 是 `no-store` + `Referrer-Policy: no-referrer` + `X-Robots-Tag: noindex, nofollow`。查探测者能否靠这组头差异区分「被限流」与「真 gone」，以及能否靠 429 的存在反推「这条路径背后有分享系统」。判据：`share-document-gone.js` 自己写下的成功状态「不主动广播本模块要藏的那件事」+ AC-VISIT-04 revised 的「族内不可区分」。
  3. `/S/` 大小写在三处各改一次（worker `SHARE_DOC_PATH` 加 `/i`、Vue router 加 `alias`、`init.js` `isAnonymousShareVisit` 加 `/i`）。全仓 grep `'/s/'` 与 `/s\//`，查还有没有第四处按大小写判分享路径的地方（e2e harness、`request/share.js`、`share-auth-service`）。另外查用 `alias` 而不是 redirect 的后果：`/S/<lid>` 与 `/s/<lid>` 成为两个都能渲染的 URL，历史链接、书签、`shareUrl` 的规范形态是哪一个。判据：`p4-destroyed-entrypoints.md` #1/#2「入口全量收口」。
  4. `shareLimiterAllows` 有两条 fail-open：绑定缺失（且**不打日志**）与 `limit()` 抛错（打 `console.error`）。查绑定名一旦在部署侧漂移，这条路径会静默退回「无限免费探测」且无任何告警。对照 `wrangler.toml` 的三个 `[[ratelimits]]` 与 `.github/workflows/deploy-cloudflare.yml`（该工作流只部署、不校验）。
  5. key 是 `CF-Connecting-IP`，取不到时全部落到 `MISSING_CONNECTING_IP_KEY` 这一个共享桶。查在 workers.dev 直连、或反代未透传该头的部署形态下，是不是所有访客共用一个 100/60s 桶而被整体打成 429。判据：`share-rate-limit.js` 文件头注释自己列的 "Does not guarantee" 清单里没有这一条。
  6. `test/share-document-gone.spec.js` 的 `afterEach` 是 `delete env.SHARE_READ_RATE_LIMITER`。查该文件里 gone 404、fail-open、HEAD 等既有用例是否全部在「无 limiter」状态下跑 —— 那样就没有任何用例覆盖「limiter 存在且放行时 gone 仍回 404 且头齐全」这个真实部署组合。
- **risk**: high —— 唯一一条无鉴权的公开入口，同时动了存在性泄露面与可用性闸门，且判据分散在 spec、ADR 与部署配置三处。
- **risk_spread_budget**
  - name: `share-read-quota-contention`
    origin: `share-document-gone.js` 里对 `env[SHARE_READ_RATE_LIMITER]` 的新增消费
    allowed_hops: 2（文档入口 → `share-rate-limit.js` 共用常量 → `share-api.js` 四个访客 API 消费点 → `useSharePolling.js` 的轮询节奏）
    allowed_surfaces: `mail-worker/src/security/`、`mail-worker/src/api/share-api.js`、`mail-worker/wrangler.toml`、`mail-vue/src/composables/useSharePolling.js`
    stop_when: 已算出「一个访客 60 秒内的最坏请求数 vs 100」这一个数；不要顺着 `SHARE_SESSION_RATE_LIMITER` / `SHARE_REVEAL_RATE_LIMITER` 展开
  - name: `gone-vs-limited-distinguishability`
    origin: `nativeGoneResponse()` 与 `enforceShareRateLimitOnRequest` 的拒绝响应
    allowed_hops: 1（两个 Response 构造点 → `withShare` 的访客 API 404 翻译）
    allowed_surfaces: `mail-worker/src/security/`、`mail-worker/src/service/share-auth-service.js`
    stop_when: 已把「404 头集合」「429 头集合」「assets 200 头集合」三者列全并与 AC-VISIT-04 revised 对过
  - name: `case-insensitive-share-path`
    origin: `SHARE_DOC_PATH` 的 `/i`
    allowed_hops: 1（正则 → 全仓其余 `/s/` 字面量判定点）
    allowed_surfaces: `mail-worker/src/`、`mail-vue/src/router/`、`mail-vue/src/init/`、`tests/e2e/`
    stop_when: 已枚举完所有按 `/s/` 判分享路径的地方；不要展开成整体路由规范化重构

---

## T4 · 访客页在链接被销毁时必须真的退场，且外部文本不得把页面撑出视口

- **theme_id**: T4
- **commits**: `0f4f52c`（`mail-vue/src/views/share/index.vue` + `session.js` + 样式部分）
- **intent**
  P4 的成功状态原话是「销毁后是浏览器原生 404」。已经打开着的 SPA 要自己走到那一步：清会话 → 打 gone 标记 → reload → 落到 worker 的文档拦截。原实现里 `sessionStorage` 抛 `SecurityError`（隐私模式、第三方 cookie 拦截）会让清理函数在打标记与 reload 之前就抛出，访客停在业务壳上，等于 P4 没兑现。另一半是邮件主题/发件人/附件名这些完全由外部控制的文本，无空格超长 token 会把访客页拉宽到约 983px，把「读验证码」这个主任务挤出屏幕。
- **surfaces**
  **ui-surface**：`mail-vue/src/views/share/index.vue`（`handleShareGone` 退场路径 + scoped 样式的 `overflow-wrap`）· `mail-vue/src/views/share/session.js`（`SHARE_GONE_KEY_PREFIX` / `SHARE_ESTABLISH_KEY_PREFIX` 的 sessionStorage 读写）· 与 T3 的 worker 文档拦截层在 reload 处对接
- **refs**
  `docs/specs/mail-share/design.md` P4 段「已打开 SPA 由 `ShareGoneError` + `share:gone:<lid>` 单次 reload 落到文档拦截（vite 直出环境清空 document 兜底防循环）」·
  `p4-destroyed-entrypoints.md` #10 · `visitor-share-ui-design.md`「卡片不得被外部文本撑破视口」·
  台账 carryover F-0027（390 视口 header 溢出）/ F-0029（终态卡未垂直居中），锚点同文件
- **review_focus**
  1. `session.js` 现在吞 `SecurityError`。逐个查该文件里每一处 `sessionStorage` 调用是否都在 try 内（读、写、删三类都要），漏一处就等于这条修复只覆盖了一半。
  2. 吞掉异常之后 `markShareGone` 可能写不进去。查此时 `handleShareGone` 的「单次 reload 防循环」还成不成立 —— 标记写不进去意味着 reload 后 SPA 认不出自己刚 reload 过。判据：design.md P4 段明写的「vite 直出环境清空 document 兜底防循环」，查那条兜底在标记缺失时是否仍然生效。
  3. 查 `handleShareGone` 是否用 `try/finally` 保证「无论清理成功与否，`markShareGone` + reload/blank 必跑」，而不是只把清理包在 try 里。
  4. `overflow-wrap: anywhere` + `.share-shell` 的 `overflow-x: hidden` 落在哪些选择器上。查是否覆盖了 F-0028 列的全部四处（`share-list-from` / `share-from` / `share-detail` / `share-atts`），以及有没有顺带改到 F-0027 / F-0029 的样式却没回写台账（这两条至今仍是 OPEN）。
  5. `init.js` 的 `isAnonymousShareVisit` 加了 `/i` 之后，`/S/<lid>` 也被判为匿名访客访问。查一个**已登录**用户打开 `/S/<lid>` 时会不会被这条判定切成匿名初始化流程（`init.js` 与 `router/index.js` 的 alias 组合）。
- **risk**: medium —— 改的是终态退场路径的异常分支，用户可见，但爆炸半径限于访客 SPA 单页。
- **risk_spread_budget**
  - name: `spa-gone-exit-under-storage-failure`
    origin: `mail-vue/src/views/share/session.js` 的 SecurityError 吞异常
    allowed_hops: 1（`session.js` → `views/share/index.vue` 的 `handleShareGone` 与 `exitShare`）
    allowed_surfaces: `mail-vue/src/views/share/`
    stop_when: 已判定「标记写失败时是否仍单次 reload 且不循环」；不要展开成整个 SPA 的存储可用性审查

---

## T5 · 访客页的三处提示从 Element Plus toast 换成页内可播报区域

- **theme_id**: T5
- **commits**: `083c87f`
- **intent**
  设计卡对访客页的硬约束是「不引入 Element Plus 到 share chunk」（既有入口拆分约束，理由是包体积与鉴权泄漏风险）。访客页还剩三处 `ElMessage`：复制验证码确认、复制全文确认、新邮件到达。直接删掉会丢一件东西 —— `ElMessage` 自带 `role=alert`，读屏用户点了复制会什么也听不到。所以本组把三处换成页内元素并补 `role="status"`，且因为 `aria-live` 只在区域内容**变化**时播报、而重复发生的是同一句文案，三处都按次递增 `:key` 强制重建节点，让第二次复制、第二封邮件仍能被播报，与旧 toast「每次都播」对齐。新邮件横幅 6 秒自撤，定时器在切邮箱、退出、卸载三处清理。
- **surfaces**
  **ui-surface**：`mail-vue/src/views/share/ShareOtpCard.vue`（复制码确认）· `mail-vue/src/views/share/index.vue`（复制全文确认 + 新邮件横幅 + `.share-new-mail` 样式与 `prefers-reduced-motion` 动画）· 构建面：`mail-vue/vite.config.js` 的 `unplugin-auto-import` + `ElementPlusResolver`（裸 `ElMessage` 标识符会被改写成真实 element-plus import，所以源码里删掉这三处正是移除 chunk 依赖的手段）· i18n 面：`shareVisitCopied` / `shareVisitCopiedAll` / `shareVisitNewMailToast`
- **refs**
  `visitor-share-ui-design.md:45`「禁止 Element Plus / 主 layout / db.js / 登录 axios」·
  `share-fullchain-decision-card.md:266`「不引入 Element Plus 到 share chunk（既有入口拆分约束）」、`:203`、`:343`
- **review_focus**
  1. 硬约束的成功状态是**构建产物**里 share chunk 不含 element-plus，不是源码 grep 干净。`views/share/` 的直接与传递依赖（`SafeMailRenderer`、`useCopyWithFallback`、`useSharePolling`、`request/share.js`、`session.js`、`mail-fields.js`）已确认无 element-plus 引用，但 `unplugin-auto-import` 的 resolver 是全局的。查 `pnpm -C mail-vue build` 后 `/s/:lid` 路由那个 chunk 的实际依赖图。判据：决策卡 `:266` 那一行。
  2. 整个可播报性论证的地基是「`:key` 变化会让 Vue 销毁并重建这个 DOM 节点」。查在 `v-if` + `:key` 同时存在时 Vue 3 是否真的重建而非 patch 复用 —— 三处（`ShareOtpCard.vue` 的 `copyAttempt`、`index.vue` 的 `copyAllAttempt` 与 `newMailArrival`）用的是同一个手法，地基塌了就是三处一起塌。spec 里断言的是 `data-*-attempt` 属性值变化，那不等于节点被重建。
  3. `role="status"` 的区域是通过 `v-if` 首次**插入**的。查读屏在「aria-live 区域随内容一起插入 DOM」这种形态下是否播报（与「区域已在 DOM 里、内容后变」的行为不同）。这条决定了第一次复制能不能被听到，而 spec 只断言了 `role` 属性存在。
  4. `NEW_MAIL_NOTICE_MS = 6000`，`POLL_INTERVAL_MS = 3000`（`useSharePolling.js:10`）。注释声称「长于一个轮询间隔」—— 属实，但意味着横幅会跨两个轮询拍。查连续到件时横幅是被替换（key 递增、计时器重置）还是叠加，以及 `announceNewMail` 里 `clearTimeout` 后没有把 `newMailNoticeTimer` 置 null 就立刻重赋值这一处的时序。
  5. 定时器清理挂在 `exitShare` / `resetMailbox` / `onUnmounted` 三处。查多邮箱 Tab 切换、以及 T4 的 `handleShareGone` → reload 路径是否都经过这三者之一 —— 提交信息声称「不跨 lid 泄漏」，这句要靠出口枚举完整来兑现。
  6. i18n 键名仍叫 `shareVisitNewMailToast`，形态已不是 toast。查 zh/en 两份文案（`收到新邮件` / `New mail received`）在一个常驻 6 秒的横幅形态下是否仍成立，以及键名与形态脱节会不会误导后续改动。
- **risk**: medium —— 用户可见且是可访问性回归的高发点，但不触及鉴权与数据；硬约束的验证需要构建产物证据。
- **risk_spread_budget**
  - name: `element-plus-in-share-chunk`
    origin: `views/share/*.vue` 里被删除的三处 `ElMessage`
    allowed_hops: 2（`views/share/` → 直接 import → 传递 import；外加 `vite.config.js` 的 auto-import resolver）
    allowed_surfaces: `mail-vue/src/views/share/`、`mail-vue/src/composables/`、`mail-vue/src/components/safe-mail/`、`mail-vue/vite.config.js`
    stop_when: 拿到构建产物层面的结论（含或不含）；不要顺着 `views/share-admin/` 的 Element Plus 用量展开，那一侧本来就允许

---

## T6 · 创建向导在响应丢失后不得盲建第二条分享

- **theme_id**: T6
- **commits**: `0f4f52c`（`mail-vue/src/views/share-admin/ShareCreateWizard.vue` 部分）
- **intent**
  Owner 提交创建请求后运输层失败（响应丢了但服务端可能已经建成），向导进入 `unknownResult` 态。原实现里关窗走 `closeNow` 会把 `unknownResult` 清掉，下次 `openDialog` 又轮换幂等键 —— 于是 Owner 只是关了个窗，就永久失去了用同一把 `Idempotency-Key` 重放拿回那条分享的能力，只能盲建第二条。本组改成关窗保留 `unknownResult`、再次打开不轮换幂等键。
- **surfaces**
  **ui-surface**：`mail-vue/src/views/share-admin/ShareCreateWizard.vue`（`onOpenChange` / `closeNow` / `openDialog` / `rotateIdempotencyKey` / `unknownResult`）· 契约对端是 worker 的 `Idempotency-Key` 重放读路径（见 T1）
- **refs**
  `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-14（响应丢失恢复流程）·
  `docs/specs/mailbox-share-capability/design.md` create 契约行「重放含 `idempotentReplay: true` 且无 `sec`/`authKey`」·
  台账 carryover F-0023 / F-0024（锚点同文件）
- **review_focus**
  1. `unknownResult` 现在关窗不清。查它到底在什么条件下才会被清 —— 若只有「成功创建」一条出口，那么一次运输层失败之后幂等键会一直不轮换，Owner 下一次真正想新建另一批时会带着旧键提交，落到 `SHARE_IDEMPOTENCY_CONFLICT`（同键异请求体）。判据：AC-CAP-14 与 design 的 create 契约行。
  2. 查 `ShareCreateWizard.spec.js` 本次新增的 20 行覆盖了哪两条路径。至少要有「关窗→重开→提交同一批 emails（应重放）」和「关窗→重开→改了 emails 再提交（应冲突或应换键）」两条；只覆盖前者等于没验到风险面。
  3. 重放的对端语义是 T1 改过的 `replayBatchFromLids`（要求 lid 集合与幂等行记录的清单**精确相等**，且加了 `ms.user_id = ?` 限定）。查向导拿到 `SHARE_NOT_FOUND` 时展示什么 —— 一条分享其实创建成功但其中某条已被保留期清理，Owner 会看到「整单不存在」。
  4. F-0023（「我已保存」按钮语义像确认已复制、实际再走创建/清结果）与 F-0024（错误提示远离 emails 输入）锚点就在本文件且仍 OPEN。查本次改动有没有动到这两处的行为，动了就要回写台账。
- **risk**: medium —— 直接影响「Owner 会不会重复建出一条自己不知道的分享」，但影响面限于一个对话框的状态机。
- **risk_spread_budget**
  - name: `wizard-idempotency-key-lifecycle`
    origin: `ShareCreateWizard.vue` 的 `unknownResult` 与 `rotateIdempotencyKey`
    allowed_hops: 1（向导状态机 → `request/mail-share.js` 的请求头装配）
    allowed_surfaces: `mail-vue/src/views/share-admin/`、`mail-vue/src/request/mail-share.js`
    stop_when: 已枚举完 `unknownResult` 的全部置位与清除出口；服务端重放语义归 T1，不要在本主题里重查

---

## T7 · 规范、性质与决策卡回写到「gone 已被有意推翻」与「emails[] 已是正式入口」的新口径

- **theme_id**: T7
- **commits**: `0f4f52c`（`docs/specs/mail-share/design.md`、`docs/specs/mailbox-share-capability/requirements.md`、决策卡 Evidence 部分）
- **intent**
  上一轮把 gone（无行 / `REVOKED`）从「不可区分 `SHARE_UNAVAILABLE`」切成「裸 HTTP 404 空 body」，又把 `emails[]` 加成 create 的正式入口。若 spec 侧不同步，下一轮 reviewer 会拿旧判据把一次**有意推翻**判成实现漂移，或者反过来放过真正的回归。本组同步 P-AUTH-01 性质段、AC-VISIT-04 / AC-LIFE-03 追溯矩阵、错误码注册表（加 `SHARE_DESTROYED` / `SHARE_EMAIL_INVALID` / `SHARE_DOMAIN_NOT_CONFIGURED`）、AC-CAP-01 的 amended 条目，并把决策卡任务清单里 `commit: pending` 的 Evidence 回写成真实 sha。
- **surfaces**
  规范面 `docs/specs/mail-share/design.md`（P-AUTH-01、AC-VISIT-04/AC-LIFE-03 Traceability 行、错误码注册表、Update Log 源码锚点）· `docs/specs/mailbox-share-capability/requirements.md`（AC-CAP-01 amended）· 决策卡 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` 任务清单 Evidence + Update Log
- **refs**
  `docs/architecture/ADR-mail-share-capability-boundary.md`（Accepted，含 P-AUTH-01）·
  台账 carryover F-0020（front-matter 未随正文改）/ F-0021（P4 推翻未 amend Accepted ADR）
- **review_focus**
  1. `docs/specs/mail-share/design.md` 的 front-matter 当前仍是 `status: converged` / `shipped_commit: null` / `last_review_status: NEEDS_CHANGES` / `last_review_p0: 1`，而正文 Update Log 已经记了 2026-08-26 的 shipped 整改，本轮又往同一份 Update Log 里加了内容。查这轮是不是第二次「只改正文不改 front-matter」（F-0020 至今 OPEN）。
  2. P-AUTH-01 已在 design 里被重写成「gone 不在本集合」，但 `docs/architecture/ADR-mail-share-capability-boundary.md` 仍是 Accepted 且未 amend（F-0021）。查本轮 design 的改动有没有引用一个 ADR 里已经不存在或已相反的性质 —— ADR 与 design 谁是 P-AUTH-01 的真源，仓内要有一个答案。
  3. 0f4f52c 顺手把 design Update Log 里的源码锚点 `mail-vue/src/views/share/status.js` 改成了 `share-admin/status.js`。在 `docs/` 全目录 grep `mail-vue/src/views/share/`，查还有多少条源码锚点指向搬走后的旧路径。判据：锚点漂移会让下一轮 reviewer 按 spec 去查一个不存在的文件。
  4. 决策卡任务清单的 DOC / REV 两项 Evidence 从 `commit: pending` 回写成 `1288ac8`，P4 项从 `d602ec6` 改成 `d602ec6（worker/API）+ e309ad4（已打开 SPA 接线）`。用 `git show <sha> --stat` 逐条核对这些 sha 的文件清单是否真的对应那项工作 —— 回写的 Evidence 是下一轮的判据来源，写错比不写更糟。
  5. AC-CAP-01 用 `{amended: 2026-08-26, by: ...}` + 删除线保留原文的写法。查同两份 requirements 里其余 amended/revised 条目是否同格式（AC-VISIT-04 用 `{revised}`、AC-LIFE-08 用 `{amended}`），以及新加的两个错误码是否同时进了 mail-share design 的注册表**和** capability design 的错误码表。
- **risk**: low —— 不改运行时行为，但它决定下一轮的判据是否可信；错误的判据比缺失的判据危害大。
- **risk_spread_budget**: none —— 判据面自洽性检查，取证全在 `docs/` 与决策卡两处文本内，无跨 diff 必要。

---

## T8 · 已审的 share-link-fullchain 全链落地并入 main（already-reviewed · 只做回归确认）

- **theme_id**: T8
- **commits**: `864358d`
- **intent**
  把 2026-08-26-r1 已经审过的那段工作（`1288ac8..9b6eb80`：P4 销毁原生 404、P2 `emails[]` 创建、`mailbox-provision` SSOT 下沉、Owner live 状态、访客页视觉）merge 进 main，以便后续修复批次能在 main 上落地。这不是新功能，本轮不重开已审内容。
- **surfaces**
  合并面本身（first-parent churn 63 文件）· 被引入的实现面与后续三个 fix 提交高度重叠：`mail-worker/src/{security,service,api}/`、`mail-vue/src/views/{share,share-admin,email}/`、`tests/e2e/` 六个 spec、`docs/specs/`
- **refs**
  scope.md「已审不重开」段列出的 8 个 sha：`1288ac85, b3658104, fabe6e84, d602ec66, e309ad4a, 82f330e7, 37062220, 9b6eb807` ·
  上一轮 themes/report：`.agent-workspace/review-ledger/runs/2026-08-26-r1/`
- **review_focus**
  1. 合并保真：`git diff 9b6eb80 864358d` 应当只剩 `f6670e0` 引入的台账文件（`.agent-workspace/review-ledger/**` + `.gitignore`）。侦察阶段已跑过一次、结果符合，reviewer 复核一次即可 —— 目的是确认解冲突时没有夹带手改，因为一旦夹带，本轮全部「回归确认」的基线都是错的。
  2. 本轮三个 fix 提交（`0f4f52c` / `1da171f` / `083c87f`）改的文件几乎全部由这次 merge 引入。对 `mail-share-service.js`、`share-document-gone.js`、`views/share/index.vue` 三个重叠最深的文件，只查「修复覆盖到的那几段」的当前状态，不要重读整文件。
  3. merge 引入的 `tests/e2e/` 六个 spec 依赖 gone 走裸 404（`visitor-unavailable` / `visitor-revoke-live` / `visitor-headers`），而 T3 在这条路径前面插了一层限流。查这些 e2e 在 `1da171f` 之后是否还成立 —— 机械闸门 `deploy-cloudflare.yml` 只部署、不跑测试，没有任何自动化会替我们发现它们红了。
  4. 台账 carryover F-0008..F-0030 的锚点文件里，只有被本轮再次改到的那几个（`mailbox-provision.js`、`views/share/index.vue`、`ShareCreateWizard.vue`、`mail-share-service.js`）需要回归确认。其余（`use-share-clock.js`、`ShareIndicator.vue`、`ShareDetailDrawer.vue`、`share-admin/index.vue`）本轮未改，不要重开。
- **risk**: medium —— 内容本身已审，风险在「合并保真」与「后续修复是否把已审结论改坏了」这两点上。
- **risk_spread_budget**
  - name: `already-reviewed-regression-surface`
    origin: `864358d` 的 first-parent churn
    allowed_hops: 1（merge 引入的文件 → 本轮三个 fix 提交实际改到的那几段）
    allowed_surfaces: `mail-worker/src/`、`mail-vue/src/views/share/`、`tests/e2e/`
    stop_when: 已确认 merge 无手改，且重叠文件里被修复覆盖的段落已在 T1–T5 各主题内查过；不得把 2026-08-26-r1 已判的 30 条 finding 重开

---

## T9 · 审查台账自身的落盘、关闭回写与空轮记录

- **theme_id**: T9
- **commits**: `f6670e0`、`c0a4a45`、`7cafb35`、`c0ede67`
- **intent**
  让「哪天审过、当时判了什么、修没修、游标停在哪」跨会话不丢：`f6670e0` 把 2026-08-26-r1 的完整台账（scope / themes / report / decisions / raw / artifacts / ledger.jsonl / state.json）首次入库并改 `.gitignore` 放行；`c0a4a45` 在 FIX-BATCHES 落地后回写 15 条关闭；`7cafb35` 记一轮「确实没东西可审」的空轮（空轮也要留痕）；`c0ede67` 把空轮台账 merge 回 main。
- **surfaces**
  台账面 `.agent-workspace/review-ledger/`：`ledger.jsonl`（finding 真源）· `state.json`（游标与 ref 快照）· `INDEX.md`（SNAPSHOT 覆盖区 + 只增不改的追加区）· `runs/2026-08-26-r1/**` 与 `runs/2026-08-27-r1/**` · `.gitignore` 放行规则
- **refs**
  `INDEX.md` 自述的维护规则（「追加区只增不改，历史行不要编辑；当前状态看覆盖区」）· `runs/2026-08-27-r1/decisions.json` 的 `note: "empty round · no SUB dispatched"`
- **review_focus**
  1. **关闭证据对不上代码**：`ledger.jsonl` 里 F-0004 是 `status: resolved`，`close_note` 写「commit 0f4f52c + 8a80014 · D1 禁止触发器外 RAISE，哨兵改为 SELECT 1/0」。而 `790c550` 已经把那个哨兵从 main 上整个删除。查这条该转 `invalidated`（修复被后续推翻）还是 reopen，以及 `INDEX.md` 覆盖区的「P1=0」在此之后是否还成立。这是本主题唯一的高价值点。
  2. **空轮分支的基线错位**：`7cafb35` 的父提交是 `12cec61`（在 `f6670e0` 之前），所以它把整个 `runs/2026-08-26-r1/` 目录当作新文件又加了一遍（`decisions.json` +990 行，对应 `f6670e0` 的 929 + `c0a4a45` 的 +62-1）。查 `c0ede67` 这次 merge 之后，`runs/2026-08-26-r1/report.md` 与 `decisions.json` 保留的是 `c0a4a45` 回写后的版本还是空轮分支上的版本。取证：`git diff c0a4a45 c0ede67 -- .agent-workspace/review-ledger/runs/2026-08-26-r1/` 应为空。
  3. **state.json schema 静默换形**：`refs` 从「每个 ref 一个对象（`last_reviewed_sha` / `last_run_id` / `completed_at` / `mode` / `cursor_eligible`）」变成「ref → sha 字符串」。查这是有意收敛还是丢字段 —— `cursor_eligible` 与 `completed_at` 一旦不再记录，下一轮凭什么判断某个 ref 可不可以推进游标。同时 `refs` 里新增了 `main` / `origin` 两个本地别名与 `origin/main` 并列指向同一 sha，查这三者是不是同一个真源的三份副本。
  4. **计数口径**：`state.json` 里 `last_run_id` 已是 `2026-08-27-r1` 但 `run_seq` 仍是 `1`，而 `INDEX.md` 覆盖区写「累计轮次: 3」。查这三个数各自的定义在哪、谁是真源，以及 `run_seq` 该不该随 run 递增。
  5. **游标未误推进**：`state.json` 的 `last_reviewed_sha` 仍是 `9b6eb80`、`origin/main` 仍是 `12cec61`，而 main 的 HEAD 已经是 `083c87f`。查空轮声明的 `cursor_advanced: false` / `cursor_advance_reason: "empty round · Phase 1-4 not run · skill forbids cursor bump"` 与 `INDEX.md` 的「本轮未推进」是否一致，且没有任何一个 ref 的游标被悄悄推过它实际被审过的位置。
  6. **INDEX.md 覆盖区被整体换格式**：`c0ede67` 把 SNAPSHOT 区从 `key: value` 行换成了 markdown 列表（`last_run` / `last_ref` / `form` 三个字段消失，新增「累计轮次」）。查 SNAPSHOT 区的字段集合有没有约定的真源；`.gitignore` 在 `f6670e0` 与 `7cafb35` 里各加了同样三行，查 merge 后没有重复行。
- **risk**: low —— 不影响运行时；但 review_focus 1 是本轮最实的一条：台账正在把一个已被删除的修复记为已关闭。
- **risk_spread_budget**: none —— 取证全在 `.agent-workspace/review-ledger/` 内部与 `git diff`，唯一的跨面引用（F-0004 ↔ `mail-share-service.js`）已由 T1 的 `d1-batch-partial-write` 预算覆盖。

---

# 耦合边

## T1 --ordering--> T2

`790c550` 删掉批量完整性哨兵的正当性，整段建立在「真实的并发抢注由 account 的 `UNIQUE` 约束兜住，那条会真抛错真回滚」之上（注释直接点名 `mailbox-provision.js` 的 `prepareAccountInsert`）。而 `prepareAccountInsert` 的 `guardSql` 正是 T2 在同一个 `0f4f52c` 里新加的配额谓词。
**合起来看可能出什么问题**：配额竞态下 account INSERT 走的是「谓词不满足 → 零行」而**不是**「UNIQUE 冲突 → 抛错」。零行不报错，batch 不回滚，share INSERT 因为找不到 account 也零行，最后落到批后 `meta.changes` 消歧抛 `SHARE_LIMIT_EXCEEDED` —— 但同批已提交的 binding / `syncPrimaryAccountId` / 幂等行还留在库里。T1 的删除论证只覆盖了 UNIQUE 那一支，没覆盖 T2 新加的谓词零行那一支。

## T1 --same-file--> T2

两者改的是 `mail-share-service.js` 中 `createFromEmails` 同一段 statements 装配代码（≈1273–1345），在 `0f4f52c` 里作为同一次提交落地，随后 `8a80014` / `790c550` 只回退了其中属于 T1 的那一半。
**合起来看可能出什么问题**：读单个提交会以为「配额谓词 + 完整性哨兵」是一套配合设计（谓词负责收紧、哨兵负责兜底）；哨兵单独被摘走后，留下的谓词是否还是当初那套设计里的那个角色，没有任何注释或测试说明。回退的边界画在哪里，需要按当前文件状态而不是按提交历史判定。

## T1 --contract-change--> T6

T1 在 `0f4f52c` 里改了批量重放的服务端契约：`replayBatchFromLids` 加了 `ms.user_id = ?` 限定，并要求回读到的 lid 集合与幂等行记录的清单**精确相等**，否则整单 `SHARE_NOT_FOUND`。T6 的向导保留 `unknownResult`、重开不轮换幂等键，正是为了让 Owner 用同一把键重发去命中这条重放路径 —— 向导是这个契约的消费方。
**合起来看可能出什么问题**：那批 lid 里只要有一条已被保留期清理或被单独删除，服务端不再重放而是抛 `SHARE_NOT_FOUND`。向导会把「整单不存在」呈现给一个其实创建成功、只是丢了一条的 Owner，而 T6 这次改动的全部意义就是不让 Owner 盲建第二条。

## T1 --shared-ssot--> T9

F-0004 在 `ledger.jsonl` 里的 `close_note` 是「AC-CAP-13 整单拒绝已有修复看护」这件事的唯一书面真源，而 `790c550` 删了那个修复却没回写台账。
**合起来看可能出什么问题**：下一轮 sweep 读台账会看到 P1=0、F-0004 resolved，于是不再检查整单拒绝语义；而代码侧这条不变量当前只有批后事后检查。一个已经不存在的修复正在替一条真实的数据完整性要求站岗。

## T2 --contract-change--> T7

T2 给 `mailbox-provision.js` 新增了三个 export（`resolveNonAdminAccountQuota` / `accountQuotaPredicateSql` / `accountQuotaPredicateBinds`），构成 create 路径上一条新的、原子的配额契约；T7 是规范面，负责让下一轮 reviewer 有判据。
**合起来看可能出什么问题**：capability design 的错误码表只写到「账号侧不可用（已删/他人/配额/角色域名权限）→ `SHARE_ACCOUNT_FORBIDDEN`」，没有任何一条 AC 描述「配额判定必须与 account INSERT 同批原子生效」这个新性质，也没描述 admin 与 `accountCount<=0` 两条豁免。实现里多了一道 spec 不知道的闸门，下一轮既无法判断它该不该在，也无法判断它被改坏时算不算回归。

## T3 --contract-change--> T5

`/s/:lid` 文档入口现在会返回空 body 429，而这条路径的唯一消费方就是访客 SPA 本身（T5 所在的页面）。SPA 侧的 `rateLimited` 状态处理的是访客 API 那种带 JSON 信封的 429。
**合起来看可能出什么问题**：限流命中在**文档**这一跳时，SPA 根本没有机会加载，访客看到的是浏览器自己的错误页 —— 与 gone 的裸 404 视觉上完全一致。「链接被销毁了」和「你刷太快了」在访客眼里变成同一件事，而后者是可恢复的、前者不是。SPA 里那套 `rateLimited` 提示在这一跳上够不着。

## T5 --shared-ssot--> T3

`SHARE_READ_RATE_LIMITER`（`wrangler.toml`：100 次 / 60 秒）现在同时是访客四个读 API（`/share/mails`、`/share/mailboxes/status`、`/share/mail`、`/share/attachment`）和文档入口 `/s/:lid` 的共同配额；T5 所在页面的轮询节奏是 `POLL_INTERVAL_MS = 3000`。
**合起来看可能出什么问题**：轮询消耗的是同一个桶。访客开着页面、切几个邮箱 Tab、点几次手动刷新、下一个附件，再刷新一下页面 —— 页面刷新这一跳就可能被自己刚才的轮询挤掉。共享 NAT 出口下多个访客共用一个 IP 桶时更早触顶。这个配额此前只服务 API，现在多了一个消费方，但数值没动。

## T4 --ordering--> T3

T4 的 SPA 退场路径是「清会话 → `markShareGone` → reload」，reload 之后要落到 T3 的 worker 文档拦截才能变成浏览器原生 404。T4 的正确性依赖 T3 先生效。
**合起来看可能出什么问题**：两个方向都会坏。若访客停在 `/S/<lid>` 而 worker 侧的大小写对齐没覆盖到（或 Vue 的 `alias` 让 SPA 侧把两种写法都渲染而 worker 侧不归一化），reload 后又是 200 业务壳，SPA 再触发一次 gone、再 reload —— 唯一的防循环是 `markShareGone` 那个 sessionStorage 标记，而 T4 这次改动的前提恰恰是「sessionStorage 可能写不进去」。若 reload 那一跳撞上 T3 新加的限流，落到的是空 body 429 而不是 404，SPA 同样认不出自己已经退场成功。

## T4 --same-file--> T5

两组改动落在 `mail-vue/src/views/share/index.vue` 的同一批出口函数上：T4 改 `handleShareGone` 与会话清理并在 scoped 样式段加 `overflow-wrap`；T5 在 `exitShare` / `resetMailbox` / `onUnmounted` 三处各加一行 `clearNewMailNotice()`，并在同一段样式里加 `.share-new-mail`。
**合起来看可能出什么问题**：这三个函数是两批改动共同的「清干净」汇合点，各自维护自己的一份清理清单。任一批新增出口时漏掉一个（例如 gone 退场路径没走这三者之一），另一批的不变量跟着漏 —— 表现为切换 lid 后上一个 lid 的新邮件横幅还挂着，或者 gone 之后计时器还在跑。样式段同理：两批各自加规则，`overflow-x: hidden` 与新横幅的 `translateY` 入场动画在同一个容器里。

## T7 --shared-ssot--> T3

`docs/specs/mail-share/design.md` 的错误码注册表与 P-AUTH-01 / P-TRANS-01 是「哪些响应形态合法、gone 与 unavailable 怎么分族」的唯一真源。T3 新造了一种形态：空 body 的 429。
**合起来看可能出什么问题**：spec 里的 P-TRANS-01 描述的 429 是带 JSON 信封的那种（`shareResult.fail('RATE_LIMITED', 429)`），文档入口这条空 body 429 既不属于 gone 族（那是 404）、也不属于 P-AUTH-01 的 unavailable 族、又不符合 P-TRANS-01 已描述的形状。下一轮 reviewer 拿注册表去核对时，会发现一个 spec 里不存在的响应形态，无从判断它是有意设计还是漂移。

## T8 --ordering--> T1 / T2 / T3 / T4

T1–T4 修改的文件几乎全部由 `864358d` 这次 merge 引入 main。这些主题的「回归确认」结论，前提是 merge 引入的内容与已审分支 tip 逐字一致。
**合起来看可能出什么问题**：若解冲突时夹带了手改，那些手改既不在 2026-08-26-r1 的审查范围里（当时还没 merge），也不在本轮四个 fix 提交的 diff 里（它们只改自己那几段），会形成一段两轮都没看过的代码。所以 merge 保真必须先于 T1–T4 的任何回归结论确立。
