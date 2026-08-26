# Themes · 2026-08-26-r1 · Mode R 变更聚类侦察

scope: `origin/main..origin/cursor/share-link-fullchain-8a38` (8) + leftover `6985f0e`
worktree: `/tmp/share-review` (detached 9b6eb80)
commits: 9 | themes: 8 | 跨主题拆分的提交: `e309ad4`(P5 视觉 / P4 SPA 收口)、`fabe6e8`(emails 建分享 / 关窗去确认)

判据源实际读过: `docs/specs/mail-share/{requirements,design}.md`、`docs/specs/mailbox-share-capability/{requirements,design}.md`、`.agent-workspace/.archive/2026-08-26/share-link-fullchain/{p4-destroyed-entrypoints,visitor-share-ui-design,share-fullchain-decision-card}.md`。ADR 三份按主题挑读(boundary / capability-extension / credential-recoverability)。

---

## T1 · 销毁与不存在的分享链接从「业务不可用页」改判为浏览器原生 404

- **theme_id**: T1
- **name**: 一条被 Owner 销毁(或从不存在)的分享 URL,不再回任何业务 HTML/JSON,访客与调用方一律看到浏览器自己的 404 空页
- **commits**:
  - `d602ec6690e9671487ecd735c7fa640d41496bde`(全部)
  - `e309ad4a17c46dcfff896b9d967b322cca4389a7`(**部分**:`views/share/index.vue` 的 `handleShareGone` / `isShareGone` 分支与 `isLostResponse` 收窄、`views/share/index.spec.js` 的 `share view gone link recovery (P4)` 一节。该提交其余内容归 T5)
- **intent**: 用户原话级诉求 —— 销毁后的链接必须「像不存在的网址一样死掉」。旧口径把不存在/错 sec/过期/撤销四种情况折成同一个 `SHARE_UNAVAILABLE` 业务壳,结果是 Owner 撤销之后访客仍然看到一个由本站渲染的页面,链接看上去还「属于这个站」。本主题要把 gone(无行 或 `status='REVOKED'`)从这个不可区分族里拆出来,让它在文档入口、访客 API、已打开的 SPA 三处同时终结,同时刻意不动 EXPIRED(过期仍走 SPA 提示)。
- **surfaces**:
  - Worker 裸 fetch 入口(hono 之前):`mail-worker/src/index.js`、新增 `mail-worker/src/security/share-document-gone.js`
  - 访客 API 错误信封层:`mail-worker/src/api/share-api.js` 的 `withShare`、`mail-worker/src/service/share-auth-service.js`(`assertAllowed` / `establishSession` / `resolveSession`)
  - 前端请求层与轮询状态机:`mail-vue/src/request/share.js`(`ShareGoneError` + 401/429 之外的 404 拦截)、`mail-vue/src/composables/useSharePolling.js`、`mail-vue/src/views/share/session.js`(`share:gone:<lid>` 记账 + reload/blank 两个可 mock 的导航接缝)
  - E2E 契约:`tests/e2e/specs/visitor-{unavailable,revoke-live,attachment,headers}.spec.js`
- **refs**:
  - `docs/specs/mail-share/requirements.md` AC-VISIT-04(revised)、AC-LIFE-03(revised)
  - `docs/specs/mailbox-share-capability/requirements.md` AC-AUTH-02(revised)、AC-EDGE-03(revised)、AC-SEC-07(amended)
  - `docs/specs/mail-share/design.md` Update Log 2026-08-26 P4 段
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md`(#1–#10 入口清单,实现声称按此表勾销)
  - `docs/architecture/ADR-mail-share-capability-boundary.md`(可探测面边界)
- **review_focus**:
  1. **lid 枚举与 D1 成本敞口**:`share-document-gone.js` 挂在 `index.js` 的裸 fetch 上,而 `shareRateLimit(...)` 只包在 hono 的 `/share/*` 路由上(`share-api.js:61-109`)。查:任意匿名 `GET /s/<猜的lid>` 是否现在都能无限速地打一次 `SELECT status FROM mail_share WHERE lid = ?`,且用 404/200 精确回答「这个 lid 存在且不是 REVOKED」。判据:AC-VISIT-04 修订只授权拆出 gone 一族,并未授权把「活链接的存在性」变成无限速可探测;`mail-worker/src/security/share-rate-limit.js` 的覆盖范围是不是真的够。
  2. **`establishSession` 的判定顺序被翻转**:原实现刻意让 `matchSec` 恒执行(注释自述是为了抹平「lid 不存在」与「sec 错」的时序差),新实现把 `if (!row || row.status === 'REVOKED') throwDestroyed()` 提到 `matchSec` 之前(`share-auth-service.js:606-616`)。查:剩余的可区分对(EXPIRED 行 + 错 sec vs ACTIVE 行 + 错 sec)是否仍常量时间;`assertAllowed` 里把 REVOKED 提到 `row.accountId > 0` 之前,是否让「REVOKED 且账号已删」这种组合泄露出比 AC-LIFE-09 更多的信息。判据:AC-AUTH-02 修订文本「其余 Visitor 失败 SHALL 统一返回不可区分」。
  3. **fail-open 与单次 reload 记账的相互作用**:gone-check 抛错时 fail-open 落 assets 出 SPA(`share-document-gone.js:48-56`),而 API 侧 404 不 fail-open。查:DB 抖动窗口内访客的实际路径 —— SPA 起来 → API 回 404 → `markShareGone` 写 `'1'` 并 reload → 文档拦截这次成功 → 原生 404;反之抖动持续则第二眼走 `blankShareDocument`。判据:p4-destroyed-entrypoints.md 第 20 行「fail-open 避免把活链接打成 404」与 #8「禁止 reload 循环」是否同时成立,尤其**活链接遇到一次抖动 404** 时 `share:gone:<lid>` 会被永久写死在 sessionStorage 里,该 lid 在本标签页内是否再也回不到可用态。
  4. **前端 404 拦截的宽度**:`request/share.js` 的响应拦截器把 `status === 404` 无条件翻成 `ShareGoneError`,注释理由是「分享面端点路径写死」。查:`shareHttp` 的 baseURL 与全部被它承载的请求(含 `/share/attachment` 的二进制分支、部署在子路径/反代下的 `/api` 前缀丢失场景),是否存在「非 gone 的 404」会被误判成销毁并触发 reload + 清空文档。判据:AC-EDGE-03 修订只把撤销一支交给 404 恢复路径。
  5. **文档拦截的匹配面 vs SPA 路由面**:`SHARE_DOC_PATH = /^\/s\/([^/]+)\/?$/` + `decodeURIComponent`。查:`mail-vue/src/router/index.js` 里 `name:'share'` 的实际 path/参数形状、lid 的字符集与后端存储形态,是否存在能命中 SPA 路由却逃过文档拦截的写法(尾随 query、多段路径、大小写、双重编码)。判据:p4-destroyed-entrypoints.md #9「不改路由表;完整导航走 #1」。
  6. **`/s/*` 安全响应头在 404 上是否仍成立**:`nativeGoneResponse()` 只给 `Cache-Control: no-store`,而原来 header 探针 spec 打的就是一个不存在的 lid,现在被改成打活链接(`visitor-headers.spec.js`)。查:AC-LEAK-02..04 声明的头是不是「`/s/*` 全部响应」都要有;若是,gone 的裸 404 现在少了哪些头,以及这次改探针是否把回归覆盖挪走了。
- **risk**: **high** —— 一条判定错误的分支要么把活链接打成永久 404(访客彻底打不开且无从排障),要么在无限速的路径上开出一个 lid 存在性预言机。
- **risk_spread_budget**:
  - name: `gone-oracle-ratelimit` / origin: `mail-worker/src/security/share-document-gone.js` / allowed_hops: 2 / allowed_surfaces: `mail-worker/src/index.js`、`mail-worker/src/security/share-rate-limit.js`、`mail-worker/src/hono/webs.js` / stop_when: 已确认文档入口的限流归属(有覆盖 or 明确无覆盖),不再追进 Owner 侧 `/mailShare/*`。
  - name: `frontend-404-overreach` / origin: `mail-vue/src/request/share.js` 拦截器 / allowed_hops: 2 / allowed_surfaces: `mail-vue/src/views/share/**`、`mail-vue/src/composables/useSharePolling.js` / stop_when: 枚举完 `shareHttp` 承载的端点集合,确认每个端点的 404 来源;不进 `mail-vue/src/request/` 下的登录态 axios。
  - name: `gone-sticky-session-flag` / origin: `mail-vue/src/views/share/session.js` `markShareGone` / allowed_hops: 1 / allowed_surfaces: `mail-vue/src/views/share/index.vue` / stop_when: 已判定 `share:gone:<lid>` 是否有清除路径。

---

## T2 · Owner 侧的过期状态改由前端时钟实时翻转,不再等重新登录

- **theme_id**: T2
- **name**: 分享过了 `expiresAt` 的那一刻,Owner 无论停在哪个页面都立刻看到 EXPIRED —— 不用刷新、更不用重新登录
- **commits**: `b36581046fcf40d6d2476facfed78f05f3115d93`
- **intent**: 用户报的是「分享明明过期了,管理页还写着有效,退出重进才对」。根因是 keep-alive 让页面长期停留,而所有五个 Owner 展示面都只信 API 快照里的 `effectiveStatus`。本主题引入一个显示层 SSOT(`liveEffectiveStatus` + 1 秒共享时钟),把「过期」这个纯时间函数从后端快照里解耦出来,同时明确它**只**管展示,鉴权与写入仍以服务端每请求计算为准。
- **surfaces**:
  - 新增展示层 SSOT:`mail-vue/src/views/share-admin/status.js`(`expiresAtUtcMs` / `liveEffectiveStatus`)、`use-share-clock.js`
  - 五个消费面:管理列表 `share-admin/index.vue`、行操作 `ShareRowActions.vue`、详情抽屉 `ShareDetailDrawer.vue`、邮箱页对话框 `email/ShareDialog.vue`、收件箱徽章 `email/ShareIndicator.vue`
  - keep-alive 生命周期与窗口事件:`email/index.vue` 的 `onActivated`、各面新增的 `focus`/`visibilitychange` 监听
- **refs**:
  - `docs/specs/mail-share/requirements.md` AC-LIFE-08({amended: 2026-08-26} 展示层改口径)、AC-LIFE-01(服务端不依赖定时任务)
  - `docs/specs/mail-share/design.md` Update Log 2026-08-26 P1 段
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-expired-status-rca.md`
- **review_focus**:
  1. **时间字符串的解析口径**:`expiresAtUtcMs` 假定 worker 一律回裸 `YYYY-MM-DD HH:mm:ss` 且语义为 UTC,自己补 `T...Z`。查:`mail-worker/src/service/mail-share-service.js` 的 list/get 序列化路径与 `utils/date-uitil.js` 的 `toUtc`,确认没有第二种形态(ISO 带偏移、带毫秒、null)。判据:同一行上展示用的是 `tzText(row.expiresAt)`,判定用的是 `expiresAtUtcMs(row.expiresAt)`,两者口径必须同源 —— 否则会出现「显示 15:00 到期、状态在 07:00 就翻了」。
  2. **展示层翻转是否越界成了写入闸门**:`ShareDetailDrawer.writable = isMutableStatus(liveStatus(detail))`,抽屉在过期瞬间自动变只读;`ShareRowActions.canRevoke` 则刻意让 EXPIRED 仍可撤销。查:这两处的前端判定与后端 patch/revoke/regenerate 的真实谓词是否一致。判据:AC-LIFE-04(销毁后拒绝一切状态变更)、AC-LIFE-11(EXPIRED/REVOKED 拒 regenerate 回 `SHARE_NOT_FOUND`),以及 AC-LIFE-08 修订里那句「前端结果不得回写」。
  3. **定时器数量与清理**:`useShareClock()` 是 per-component 实例,每个实例一个 1s `setInterval` + 两个窗口监听;`ShareRowActions.vue` 在**每一行**都调用它。查:`share-admin/index.vue` 默认 `size = 20` 时同屏有多少个 1s 时钟,以及列表翻页/过滤重渲染时旧实例是否都走到了 `stop`。判据:`use-share-clock.spec.js` 断言的幂等 start/stop 是否覆盖「非 keep-alive 子组件被 v-for 卸载」这一路径。
  4. **`start()` 里的裸 `window`/`document`**:`onVisibility` 有 `typeof document === 'undefined'` 守卫,`start()` 自身没有,直接用 `window.setInterval` / `document.addEventListener`。查:是否存在 SSR/非浏览器渲染路径会走到这里(这个仓库看起来纯 SPA,若确认无该路径就是可接受的不对称,但要点名)。
  5. **聚焦时的请求放大**:`ShareIndicator` 新增 `focus` → `refresh()`、`visibilitychange` → `refresh()`、`onActivated` → `refresh()`,`email/index.vue` 又额外在 `onActivated` 调一次 `shareIndicator.refresh()`;`share-admin/index.vue` 同时挂了 `focus` → `fetchList()`。查:一次窗口聚焦会打出几个 `listMailShares` 请求,`fetchList` 有没有 in-flight 守卫,乱序返回会不会用旧响应覆盖新状态。
  6. **徽章计数的口径**:`activeCount` 按 `liveEffectiveStatus(row) === 'ACTIVE'` 过滤,但列表本身是分页拉取的。查:`listMailShares` 在 `ShareIndicator` 里的调用参数,徽章统计的是「首页 20 条里的活跃数」还是「全部活跃数」。判据:E2E 断言徽章从 `1` 变 `0`,只能证明小数据集下正确。
- **risk**: **medium** —— 只动展示层,错了不会造成越权或脏数据;但 UTC 解析或时钟清理出错会稳定复现成「状态乱跳」或页面级性能退化,而这正是本次要修的用户投诉本身。
- **risk_spread_budget**:
  - name: `expiresAt-wire-format` / origin: `mail-vue/src/views/share-admin/status.js` `expiresAtUtcMs` / allowed_hops: 2 / allowed_surfaces: `mail-worker/src/service/mail-share-service.js`(list/get 序列化)、`mail-worker/src/utils/date-uitil.js`、`mail-vue/src/utils/day.js` / stop_when: 确认线上格式恰有一种;不追进邮件时间戳等其它时间面。
  - name: `clock-instance-leak` / origin: `mail-vue/src/views/share-admin/use-share-clock.js` / allowed_hops: 1 / allowed_surfaces: 五个消费面组件 + `mail-vue/src/views/email/index.vue` 的 keep-alive 配置 / stop_when: 每个消费面的 mount/unmount 路径都对上了 start/stop。

---

## T3 · Owner 直接粘贴完整邮箱地址就能建分享,地址不存在就顺手开通

- **theme_id**: T3
- **name**: 建分享不再要求「先去设置页注册邮箱、再回来从下拉里挑」,粘一串完整地址进去,系统按需建号并一次发出对应数量的链接
- **commits**:
  - `fabe6e841109dfb84b8b4da651c7caa03a5d7db4`(**主体**:`mailbox-provision.js`、`account-service.js`、`mail-share-service.js`、`request/mail-share.js`、`presets.js`、`ShareCreateWizard.vue` 的地址输入改造与 i18n 新键、`mail-share-emails.spec.js` 等。同提交内的「关窗去确认」归 T4)
- **intent**: 旧向导的隐含前置是「被分享的邮箱必须已经是本站注册账号」,用户要的是反过来 —— 地址就是入口。这带来两个必须同时解决的问题:建号不变量(格式/域名/前缀/归属/配额/角色域名权限)此前只长在 `account-service.add` 里,新入口若复制一份就是第二写路径;以及 `SHARE_CAPABILITY_V2` 默认关闭时的多地址批量,不能被一个与用户无关的发布开关吞掉,于是分流成同一请求里的 N 条单分享。
- **surfaces**:
  - 新的建号不变量 SSOT:`mail-worker/src/service/mailbox-provision.js`(`planMailboxProvision` 零写入预校验 / `prepareAccountInsert` 唯一 INSERT 文本 / `provisionMailbox` / `configuredDomains`)
  - 既有写入口改为包装层:`mail-worker/src/service/account-service.js`(设置页「添加账号」保留 addEmail 开关与 Turnstile,机器码 → 原文案映射)
  - 分享创建主链路:`mail-worker/src/service/mail-share-service.js`(`toEmailList` 归一化与指纹、`emailCreateFingerprints`、`createFromEmails` 的单 batch 多语句写入、`prepareShareInsertByEmails` / `prepareBindingInsertByEmails` 的邮箱定位谓词、批量重放 `response_fingerprint.lids`)
  - 向导前端:`ShareCreateWizard.vue` 的 textarea + tag 回显 + 批量结果面板、`presets.js` 的 `parseShareEmails` 与新错误码映射、`request/mail-share.js` 载荷构造
  - 错误码面:`SHARE_EMAIL_INVALID`、`SHARE_DOMAIN_NOT_CONFIGURED`,以及把账号侧四种拒绝折进既有 `SHARE_ACCOUNT_FORBIDDEN`
- **refs**:
  - `docs/specs/mailbox-share-capability/design.md` API 契约表 `POST /mailShare/create` 行(2026-08-26 扩展)、第 434 行错误码表、Update Log 2026-08-26 P2 段
  - `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-10(旧 `accountId` 兼容)、AC-CAP-13(50 上限)、AC-CAP-14(响应丢失恢复)、AC-LIFE-10/11(能力栅栏)
  - `docs/architecture/ADR-mailbox-share-capability-extension.md`
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` DC-P0-1(批量分流)/ DC-P0-2(provision SSOT)/ DC-P0-3(D1 batch 整单)
- **review_focus**:
  1. **搬家等价性,逐条对**:`account-service.add` 删掉的 6 段检查 vs `planMailboxProvision` 的新实现。重点三处口径漂移:`emailPrefixFilter` 旧代码是 `getName(email).includes(content)` 原样比较、新代码两端 `toLowerCase()`(过滤面变宽);配额旧代码走 `accountService.countUserAccount(c, userId)`、新代码是本模块内联的 `SELECT COUNT(*) ... is_del = NORMAL` 且判据从 `>=` 改成 `owned + missing.length > limit`;域名旧代码 `c.env.domain.includes(getDomain(email))`、新代码经 `configuredDomains()` 解析后小写精确匹配。判据:新模块自述「对老前端逐字不变」,以及 `mail-worker/test/` 下设置页建号的既有 spec 是否覆盖这三处。
  2. **`c.env.domain` 是否真的只剩一个解析口径**:`configuredDomains(c)` 声称是唯一口径并禁止对字符串形态做 `.includes`(子串匹配会让 `xample.co` 命中 `'["example.com"]'`)。查:全仓还有哪些地方直接读 `c.env.domain`(注册、发信、角色域名权限 `roleService.hasAvailDomainPerm`),它们是否仍是旧的宽匹配 —— 只搬一半的 SSOT 比不搬更危险。
  3. **D1 batch 的「全有或全无」是否真成立**:`createFromEmails` 把 `prepareAccountInsert`(带活跃额度 guard)、N 组 `share/binding/syncPrimaryAccountId`、幂等行塞进一个 `db.batch()`,并把余量按批内位次折进各自的 `limit` 绑定值(`limit - (groups.length - 1 - index)`)。查三件事:(a) `prepareShareInsertByEmails` 的归属谓词 `COUNT(*) FROM account WHERE lower(email) IN (...) AND user_id = ? AND is_del = 0 = ?` 在同批更早的 account INSERT 之后能否看到新行(batch 内可见性是整个设计的地基);(b) 限额竞态导致 share 零行时,同批 account 是否真的也零行(guard 用的是 `limit - (groups.length - 1)`,与 share 的逐条折算不是同一个数);(c) 零变更分支最后无条件抛 `SHARE_LIMIT_EXCEEDED`,是否会掩盖归属类失败。判据:decision card DC-P0-3 与 design.md「同一 D1 batch」表述。
  4. **幂等指纹在滚动发布与双入口下的一致性**:`emails` 仅非空时挂键(自述是为了不让旧载荷在新旧 Worker 上算出两个指纹);`emailCreateFingerprints` 在「单地址 + 默认配置 + 该地址已解析到自己的存量账号」时改落旧四字段 hash。查:同一语义从 `ShareDialog`(accountId 形状)与向导(emails 形状)提交时,`stored`/`accepted` 是否构成一一对应而不会把两个不同请求判成重放;以及首次以 modern 落库、重试时地址已被建出来(`plan.reused` 从 0 变 1)会不会让 `stored` 指纹在两次调用间漂移。判据:AC-CAP-14 与 design.md create 行的重放契约。
  5. **批量重放的响应形状与前端消费**:幂等行的 `response_fingerprint` 在批量时写 `{lids:[...]}`,`replayBatchFromLids` 按 lid 回读并整单 `SHARE_NOT_FOUND`(任一行被保留期清理即全灭)。查:向导 `replayShares` 面板是否覆盖 `{shares, idempotentReplay}` 与单条两种形状,以及「N 条里清理掉 1 条」时 Owner 看到的是不是「全部不存在」。判据:design.md 新写的「批量重放为 `{shares, idempotentReplay}`」。
  6. **50 这个上限现在计的是什么**:`assertCreateBody` 里 emails 模式下 `body.emails.length > SHARE_BINDING_LIMIT` 抛 `SHARE_BINDING_LIMIT_EXCEEDED`,但 V2=false 时 50 个地址 = 50 条**独立分享**,每条各占一个 `SHARE_ACTIVE_LIMIT` 名额。查:`SHARE_BINDING_LIMIT`(单分享绑定数)与 `SHARE_ACTIVE_LIMIT`(用户活跃分享数)两个量在批量路径下被混用的后果,以及错误码是否会让 Owner 读到与实际原因无关的提示。判据:AC-CAP-13 语义与 design.md 新增的 emails 上限句。
- **risk**: **high** —— 这是本轮唯一新增写路径的主题:它能凭一个分享请求创建 account 行,横跨归属校验、配额、幂等与 D1 事务语义,任何一处判定错误的后果是脏 account 行、越权绑定或配额绕过。
- **risk_spread_budget**:
  - name: `provision-invariant-parity` / origin: `mail-worker/src/service/mailbox-provision.js` / allowed_hops: 2 / allowed_surfaces: `mail-worker/src/service/account-service.js`、`mail-worker/src/service/role-service.js`、`mail-worker/src/utils/{email-utils,verify-utils}.js`、`mail-worker/test/` 下建号相关 spec / stop_when: 六条不变量逐条对完;不进注册/登录/OAuth 链路。
  - name: `env-domain-ssot` / origin: `configuredDomains(c)` / allowed_hops: 1 / allowed_surfaces: 全仓 `c.env.domain` 读点 / stop_when: 列清读点并标出仍是宽匹配的那些,不逐个改判。
  - name: `d1-batch-atomicity` / origin: `createFromEmails` / allowed_hops: 2 / allowed_surfaces: `mail-share-service.js` 内既有的 `insertShareAndIdempotency` / `prepareShareInsert` / `prepareBindingInsert`(作为「孪生语句」的对照基线)、`mail-worker/test/mail-share-emails.spec.js` / stop_when: 三条谓词(归属、限额、幂等)各自的零行语义都对上;不进 cleanup / patch / regenerate 链路。
  - name: `fingerprint-compat-window` / origin: `emailCreateFingerprints` / allowed_hops: 1 / allowed_surfaces: `normalizeCreateBody`、`legacyCompatibleBody`、`mail-vue/src/request/mail-share.js` / stop_when: 双入口指纹映射画清;不重审 T-2x 时期已冻结的旧兼容逻辑。

---

## T4 · 创建成功后关窗不再拦一道「只显示一次」确认

- **theme_id**: T4
- **name**: 建完分享想关就关 —— 链接后面还能从详情里取回,不值得为它拦一次弹窗
- **commits**: `fabe6e841109dfb84b8b4da651c7caa03a5d7db4`(**部分**:`ShareCreateWizard.vue` 的 `onOpenChange` 去掉 `ElMessageBox.confirm` 分支与 `hasUnsavedSecret` 依赖、`i18n/{zh,en}.js` 删除 `shareWizardCloseConfirm` 键、`ShareCreateWizard.spec.js` 对应断言重写)
- **intent**: 这个确认框是「明文恰一次」时代的产物。凭据可恢复性 ADR 之后,分享链接本身可以从详情抽屉重新取回,再拦一道「确认已保存?」就是纯粹的摩擦。用户明确点名要删。
- **surfaces**: 向导对话框的关闭流程(`ShareCreateWizard.vue`)、i18n 键面(zh/en + 组件内 `PENDING_COPY` 兜底表)
- **refs**:
  - `docs/architecture/ADR-share-credential-recoverability.md`(部分取代「明文恰一次」不变量 —— 这条 ADR 是本改动成立与否的唯一判据)
  - `docs/specs/mailbox-share-capability/requirements.md` AC-AUTH-03(AuthKey 明文不存储)、AC-CAP-14(重放不再给 sec)
- **review_focus**:
  1. **「可取回」这个前提对哪些凭据成立**:代码注释断言链接可从详情抽屉取回。查:`ShareDetailDrawer.vue` 的取回入口与后端对应端点,确认它给的是 `shareUrl`/`sec` 还是只有 `lid`。判据:ADR-share-credential-recoverability 划定的可恢复范围 —— 若只有 sec 可恢复而 AuthKey 不可,则删确认对启用 AuthKey 的分享是**不可逆的凭据丢失**。
  2. **AuthKey 明文这一支**:结果面板里 AuthKey 仍是一次性显示,且 AC-AUTH-03 明确不存明文。查:单条创建 + `authKeyEnabled=true` 时关窗无确认,Owner 是否会永久失去这把 key,以及组件内是否还留有针对 AuthKey 的单独一次性警示(注释声称「auth key 已在结果面板内自带一次性警告」,需核实这句在代码里对得上)。
  3. **批量面板与确认删除的交互**:T3 引入的批量结果面板一次给 N 条链接,只有一个「我已保存」按钮。查:批量场景下关窗即失(若不可取回)的放大效应,以及 `acknowledgeSecret` 在批量分支的行为。
  4. **残留清理**:`shareWizardCloseConfirm` 已从 zh/en/`PENDING_COPY` 移除,`hasUnsavedSecret` 是否还有引用(初查已无残留,请 reviewer 用仓库检索复核,并确认 `ShareCreateWizard.spec.js` 里原确认框的断言是被重写而不是被删掉)。
- **risk**: **medium** —— 改动面极小,但它移除的是一道防「不可逆凭据丢失」的护栏,正确性完全押在 ADR 声明的可恢复范围上。
- **risk_spread_budget**:
  - name: `credential-recoverability-scope` / origin: `ShareCreateWizard.vue` `onOpenChange` / allowed_hops: 2 / allowed_surfaces: `mail-vue/src/views/share-admin/ShareDetailDrawer.vue`、`mail-worker/src/service/mail-share-service.js` 的取回/重放端点、`docs/architecture/ADR-share-credential-recoverability.md` / stop_when: sec 与 AuthKey 各自的可恢复性已判定。

---

## T5 · 访客收码页按设计卡重做视觉

- **theme_id**: T5
- **name**: 把访客页从「默认样式的调试页」改成一张以验证码为主角的收码卡片,桌面居中、移动全宽
- **commits**: `e309ad4a17c46dcfff896b9d967b322cca4389a7`(**主体**:`views/share/index.vue` 的 `.share-card` 包裹层与整套 scoped CSS/token、`ShareOtpCard.vue` 的 OTP 大字与移动端触控尺寸、`index.spec.js` 里 OTP 排版断言的更新。同提交内 P4 gone 恢复逻辑归 T1)
- **intent**: 访客只有一个目标 —— 尽快看到验证码并复制。旧页面把 OTP、列表、Tab、附件平铺成同一优先级。设计卡把信息层级钉死(P0 = OTP 大字 + 复制 + 空收件箱等待),本主题按卡实现,并明确约束:只改包裹 class 与样式,不动 `data-share-*` 钩子、不动轮询/会话逻辑、不引入 Element Plus。
- **surfaces**: 访客页模板包裹层与 scoped 样式(`views/share/index.vue`)、OTP 卡片组件(`ShareOtpCard.vue`)、以 CSS 变量为界面的 token 层(挂在 `.share-shell`,子组件用 `var(--sh-*, fallback)` 消费)
- **refs**:
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md`(token 值、布局、逐状态设计、硬约束 —— 本主题的唯一判据)
  - `docs/specs/mailbox-share-capability/requirements.md` AC-SEC-06(匿名 chunk 隔离)
- **review_focus**:
  1. **`data-share-*` 钩子零改是否真成立**:新增了一层 `.share-card` 包裹整个内容区。查:`[data-share-shell]` 与 `[data-share-body]`/`[data-share-mail-list]` 之间的父子/兄弟关系有没有变,`tests/e2e/fixtures/share.js` 与各 visitor spec 里基于层级或 `innerText` 的选择器是否还成立。判据:设计卡硬约束第 1 条。
  2. **token 继承链**:token 定义在 `views/share/index.vue` 的 scoped `.share-shell` 上,`ShareOtpCard.vue` 用 `var(--sh-accent, #3b5bdb)` 这类带 fallback 的写法消费。查:OTP 卡片实际渲染位置是否恒在 `.share-shell` 子树内(CSS 变量继承靠 DOM 树而非 scoped 属性),以及 fallback 值与设计卡列出的 token 是否逐个一致 —— 不一致时组件会静默用 fallback,视觉对不上却不报错。
  3. **匿名 chunk 隔离**:查这轮新增的样式/结构有没有把 Element Plus、主 layout、`db.js` 或登录态 axios 拖进访客 chunk,以及守护测试 `mail-vue/src/views/share/assert-share-chunk.js` 是否仍覆盖改动后的入口。判据:AC-SEC-06 与设计卡硬约束第 2 条。
  4. **逐状态的可访问性约束**:设计卡点名了四条 —— 倒计时**不**加 `aria-live`、动画一律包在 `prefers-reduced-motion` 里、移动端触控目标 ≥ 44px、选中态不能只靠颜色。查:`.share-spinner`、`.share-empty::before` 两处动画的媒体查询包裹是否完整,`.share-otp-row button` 的 44px 只在 `max-width: 640px` 下生效是否够,`.share-tab[aria-selected="true"]` 是否仍是「字重 + 下划线」而不只是颜色。
  5. **样式断言的形态**:`index.spec.js` 用 `readFileSync` + 正则去匹配 `font-size: clamp(30px, 8vw, 40px)`。查:这类断言在改一次空格就会红的脆性,以及它到底在防什么回归 —— 是否有更靠谱的等价断言,或者这就是该文件既有的约定(T-24 时期就这么写)。
- **risk**: **low** —— 纯展示层,不触碰授权、状态机与数据写入;主要风险是把 E2E 依赖的 DOM 形状改坏,而那会当场变红。
- **risk_spread_budget**:
  - name: `share-dom-hook-stability` / origin: `mail-vue/src/views/share/index.vue` 的 `.share-card` 包裹层 / allowed_hops: 1 / allowed_surfaces: `tests/e2e/fixtures/share.js`、`tests/e2e/specs/visitor-*.spec.js`、`mail-vue/src/views/share/index.spec.js` / stop_when: 全部 `data-share-*` 选择器都能在新 DOM 上定位;不进样式细节的逐像素比对。

---

## T6 · Owner 侧首次具备浏览器级验收能力

- **theme_id**: T6
- **name**: 给 E2E 补上 Owner 自己的邮箱行,让「登录后台建分享、看它过期」这条路第一次能在真浏览器里跑
- **commits**: `37062220afc2be6dd4002a74c0dc8f20f03578f6`
- **intent**: 既有 E2E 全是访客视角,seed 里从来没有 Owner 本人的 account 行 —— 而 `loginUserInfo` 会解引用它,所以 Owner UI 在 E2E 里根本启动不了,这个洞一直被「访客 spec 不登录」掩盖着。本主题补上 seed,并用一条 lifecycle spec 把本轮 P1(停页翻 EXPIRED)、P2(粘两个地址出两条链接)、P3(关窗无确认)三件事在浏览器里钉住。
- **surfaces**: E2E 种子与世界对象(`tests/e2e/harness/worker-entry.js` 的 `seedOwner`,新增 `ownerAccountId`)、新增 `tests/e2e/specs/owner-share-lifecycle.spec.js`
- **refs**:
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` 的 VERIFY 条目(「五条成功状态各至少一条真实入口→sink 验收;环境不可用必须写 Evidence 阻塞原因,禁止静默跳过 e2e」)
  - `docs/specs/mail-share/requirements.md` AC-LIFE-08、`docs/specs/mailbox-share-capability/design.md` create 契约行(被这条 spec 断言的对象)
- **review_focus**:
  1. **seed 顺序变更的连带影响**:`ownerAccount` 的 INSERT 被插在 `account`/`account2` **之前**,account_id 的分配顺序因此改变。查:既有 visitor spec 与 harness 里有没有对 account_id 取值、排序或「首条账号」的隐含依赖。判据:`worker-entry.js` 里其余 seed 消费者与 `tests/e2e/fixtures/share.js`。
  2. **跨 run 的状态污染**:注释自己点明「D1 状态跨 run 持久(`--persist-to`)」,所以断言靠 `runTag` 过滤。查:每次 run 都会新建 2–3 条永不清理的 ACTIVE 分享,累积后是否会撞上 `SHARE_ACTIVE_LIMIT`,让这套 E2E 在第 N 次运行时开始红。判据:`activeLimit(c)` 的默认值与 harness 是否有 reset 路径。
  3. **时间敏感断言的稳定性**:P1 那条 spec 建了 `durationSeconds: 20` 的分享,然后等 `data-status` 在 30s 超时内翻成 EXPIRED。查:这个窗口在慢机器/并行度下的裕度,以及它与 `use-share-clock` 的 1s tick、`fetchList` 的刷新时机之间是否有隐含竞态。
  4. **反向断言的可靠性**:P3 用 `waitForTimeout(500)` 之后断言 `.el-message-box` 数量为 0。查:固定等待是否足以证明「弹窗不会出现」,还是只证明「500ms 内没出现」。
  5. **闸门归属**:仓库唯一的 CI 是 `deploy-cloudflare.yml`(只部署、不跑测试)。查:这三条新 E2E 断言由谁在什么时机执行 —— 若无自动闸门,它们的回归价值取决于人工复跑纪律,这一点该在评审里显式认领。
  6. **覆盖 vs 承诺**:决策卡 VERIFY 要求五条成功状态各有一条真实入口→sink 验收。查:P1/P2/P3 在本提交、P4/P5 在 `d602ec6`/`e309ad4`,五条是否真的都有一条浏览器级 sink,有没有哪条只有单测。
- **risk**: **medium** —— 测试代码不上生产,但 seed 是全部 E2E 共享的真源,改错会把回归网整体带偏;且这套 spec 是本轮唯一的浏览器级证据来源。
- **risk_spread_budget**:
  - name: `e2e-seed-ssot` / origin: `tests/e2e/harness/worker-entry.js` `seedOwner` / allowed_hops: 1 / allowed_surfaces: `tests/e2e/fixtures/share.js`、`tests/e2e/specs/**` / stop_when: 所有 seed 消费者对 account_id 的依赖都查清;不进 worker 业务代码。

---

## T7 · 把本轮所有口径改动回写进决策卡与 shipped spec

- **theme_id**: T7
- **name**: 让规范文档追上代码 —— 被有意推翻的验收条款逐条留痕(旧文划掉、注明何时被谁推翻),而不是悄悄改掉
- **commits**:
  - `1288ac85af8d51329862355cbc8d07b1ad7d22b9`(决策卡正文 + 过筛评审记录 + P4 入口清单 + UI 设计卡 + 过期状态 RCA + 本轮提示词归档)
  - `82f330e720acb70069e77dda1f84ee0360b96c67`(两份 shipped spec 的 requirements/design 行内修订与 dated changelog)
  - `9b6eb8072fe73c93518e872037702a2e8e54056b`(决策卡任务清单勾销 + 独立复跑证据回填)
- **intent**: 这四条 AC(AC-VISIT-04 / AC-LIFE-03 / AC-AUTH-02 / AC-EDGE-03)是**被用户指令有意推翻**的,不是漏写。文档侧要留下可追溯的推翻记录(`{revised: 2026-08-26, by: share-fullchain P4}` + 删除线原文),否则下一轮评审会把新行为当成回归 bug 报回来。同时把 create 的 emails 契约、批量分流、建号 SSOT 位置写进 API 契约表,并把「向导选已注册账号」标为 Deprecated(行为已删除)。
- **surfaces**: 两份 shipped spec 的验收条款与 API 契约表 + Update Log(`docs/specs/mail-share/*`、`docs/specs/mailbox-share-capability/*`);任务台账与设计证据归档(`.agent-workspace/.archive/2026-08-26/share-link-fullchain/*`)
- **refs**: 本主题自身即判据源;交叉 refs 见 T1/T2/T3 各自的 refs 段
- **review_focus**:
  1. **规范文本与代码实况逐句对**(这是本主题的主要工作,不是文风审查)。至少三处需要落到文件:AC-VISIT-04 写「文档 `GET|HEAD /s/:lid` 与**全部**访客 API 一致」—— 核对 `share-api.js` 的五个路由是否都经 `withShare`(初查是,含 attachment);design.md P1 段写 SSOT 落在 `mail-vue/src/views/share/status.js`,而代码实际在 `mail-vue/src/views/share-admin/status.js`(**路径对不上**,请判定是文档笔误还是遗漏了一次搬迁);AC-SEC-07 amendment 要求 gone 时先清 `share:session:<lid>` 与 `share:est-key:<lid>` 再离开页面 —— 核对 `handleShareGone` 的清理确实发生在 reload 之前。
  2. **「Deprecated(行为已删除)」的范围是否与代码一致**:design.md 说被删的是「向导选已注册账号下拉 / 前缀+域名拼接作为创建分享前置」,而 `accountId`/`accountIds` 路径仍活着供 `ShareDialog` 的「分享当前邮箱」使用(AC-CAP-10)。查:这句表述会不会被下游读成「accountIds 入参已废弃」,以及 `presets.js` 的 `CREATE_BODY_KEYS` 同时保留两个键是否与之自洽。
  3. **推翻记录的完整性**:P4 波及四条 AC(mail-share 的 AC-VISIT-04/AC-LIFE-03,capability 的 AC-AUTH-02/AC-EDGE-03/AC-SEC-07)。查:是否还有其它引用 `SHARE_UNAVAILABLE` 不可区分族的条款(如 AC-LIFE-09 账号已删、AC-LIFE-13 功能关停)在新口径下需要同步说明「仍属 unavailable 族」,以及 design.md 里的状态机/错误码表是否也跟着改了。
  4. **证据数字的可复算性**:`9b6eb80` 回填的 Evidence 声称 worker 854 / vue 370 / e2e 23 全绿。查:reviewer 在本 worktree 复跑能否得到同一组数字(仓库无测试 CI,这是唯一的通过性证据),不一致则 Evidence 失效。
  5. **归档物的内容安全**:`1288ac8` 把 644 行的 `prompt.round1.sub.txt` 提交进了仓库。查:`.agent-workspace/.archive` 是否是既定归档惯例(仓库里已有 2026-08-17 等同构目录,看起来是),以及该文件与决策卡里有没有夹带凭据、内网地址或第三方私有信息。
- **risk**: **medium** —— 文档不影响运行,但这几份 spec 是后续所有评审的判据源;一条与代码不符的 AC 会让下一轮评审基于错误基线做判断,而路径不符已经出现了一处。
- **risk_spread_budget**:
  - name: `spec-vs-code-drift` / origin: `docs/specs/mail-share/design.md` + `docs/specs/mailbox-share-capability/design.md` 的 2026-08-26 段 / allowed_hops: 1 / allowed_surfaces: 该段落点名的每个源码路径(`share-document-gone.js`、`share-auth-service.js`、`mailbox-provision.js`、`status.js` / `use-share-clock.js`、`ShareCreateWizard.vue`)/ stop_when: 点名的路径逐个存在且行为对上;不扩展到未被本轮文档提及的旧条款。

---

## T8 · Cloud Agent 开发环境配置(leftover,与分享链路无关)

- **theme_id**: T8
- **name**: 让 Cloud Agent 开机即能跑起整套 Cloud Mail(装依赖、构建 SPA、装 Chromium、起两个 dev server)
- **commits**: `6985f0ef09421798c6cac2495bc2f501dcf7c7e7`
- **intent**: 与本轮分享功能无关的基础设施提交,来自已合并 PR#1 的分支残留(scope.md 标为 leftover)。目的是把「新 VM 上从零到能跑测试」这件事固化成仓库自带的幂等脚本,而不是每次口口相传。
- **surfaces**: 仓库级开发环境声明(`.cursor/environment.json` 的 install 命令与两个终端)、安装脚本(`.cursor/install.sh`)
- **refs**: none(判据源清单里没有覆盖开发环境的规范文件;`deploy-cloudflare.yml` 只管部署)
- **review_focus**:
  1. **是否已在 main 上以另一形态存在**:scope.md 说它来自 `origin/cursor/setup-cloud-agent-env-3558`(PR#1 已 merged)却仍出现在 `origin/main..` 之外。查:`.cursor/environment.json` 与 `install.sh` 在 `origin/main` 上是否已存在(squash/cherry-pick 后 sha 不同),若已存在则本条属已审内容,不应重复评审 —— 这是本主题最先要确定的事。
  2. **`--frozen-lockfile` 的三个前提**:脚本对 `mail-worker`、`mail-vue`、`tests/e2e` 三处都用了 frozen 安装。查:三处 lockfile 都在版本控制内且与各自 `package.json` 同步,否则新 VM 上第一步就会硬失败。
  3. **构建产物与忽略规则**:install 会 `pnpm --dir mail-vue run build` 把 SPA 产出到 `mail-worker/dist`(worker 的 assets 绑定与 vitest-pool-workers 都依赖它)。查:`.gitignore` 是否覆盖该目录,避免构建产物被误提交。
  4. **失败语义**:脚本 `set -euo pipefail`,但 Playwright `--with-deps` 失败时降级为仅装浏览器、wrangler telemetry 失败时 `|| true`。查:这两处降级之后环境是否仍满足「能跑 e2e」的承诺,以及降级是否会被静默吞掉(它们会打印,但退出码仍为 0)。
- **risk**: **low** —— 不进生产构建路径,不被 `deploy-cloudflare.yml` 消费;最坏后果是新环境装不起来。
- **risk_spread_budget**: none —— 无需跨 diff 追查;唯一的外部动作是确认它是否已在 `origin/main` 上重复存在(属查证,不属扩散)。

---

## 耦合边表

> 关系读法:`T<a> --关系--> T<b>` = a 是上游/提供方,b 是下游/消费方或同源另一半。

| # | 边 | 关系 | 合起来看可能出什么问题 |
|---|---|---|---|
| E1 | `T1 --contract-change--> T5` | contract-change | T1 定义的 gone 契约(`ShareGoneError` / `markShareGone` / `reloadShareDocument` / `blankShareDocument`)落在 `d602ec6`,而**唯一的消费方** `handleShareGone` 却落在 `e309ad4` 的 `index.vue` 里。也就是说在 `d602ec6` 这一个提交的树上,访客页收到 404 时既不会 reload 也不会清空文档 —— 中间提交存在一个 gone 无人接管的窗口。按提交逐个 review 或 bisect/回滚到 `d602ec6` 时,P4 的 SPA 侧行为并不成立。 |
| E2 | `T1 --same-file--> T5` | same-file | 两个主题改的是 `views/share/index.vue` 与 `index.spec.js` 的同一批区域(script setup 的 import 块、样式块相邻)。P5 的 CSS 注释写着「销毁态不经过这里(P4 原生 404),所以本页不设计 gone 插画」—— 视觉侧**主动放弃**了 gone 的兜底外观。若 T1 的 fail-open 或前端 404 判定有偏差,访客会落进一个既没有原生 404 也没有设计过的空白页,两个主题各自看都「按设计做了」。 |
| E3 | `T1 --ordering--> T5` | ordering | 承 E2:T5 不画 gone 态的前提,是 T1 保证 gone 永远走不到这个页面。T1 的正确性是 T5 视觉完备性的先决条件,不能只验证「有 CSS 变量、卡片居中」就判 T5 通过。 |
| E4 | `T1 --shared-ssot--> T7` | shared-ssot | 同一批 AC(AC-VISIT-04 / AC-LIFE-03 / AC-AUTH-02 / AC-EDGE-03 / AC-SEC-07)被 T1 的代码与 T7 的文档同时改动。风险是文档写的口径比代码宽:AC-VISIT-04 说「与**全部**访客 API 一致」,而代码只在 `withShare` 的 `BizError` 分支翻译 `SHARE_DESTROYED` —— 任何绕过 `withShare` 的路径(或非 `BizError` 的抛出)都会让文档变成一句无法兑现的承诺。 |
| E5 | `T2 --shared-ssot--> T7` | shared-ssot | AC-LIFE-08 被 T2 的代码与 T7 的 amendment 同时改。文档 amendment 明确「前端结果不得回写、鉴权与写入仍以服务端为准」,而 T2 的 `ShareDetailDrawer.writable` 已经拿前端时钟当写入闸门用了。合起来看:文档划的线与代码落的线不在同一处,后续任何人按文档实现第六个消费面时会与现有五面不一致。 |
| E6 | `T3 --shared-ssot--> T7` | shared-ssot | create 的 API 契约表是 T3 代码与 T7 文档的共同真源,且这一行现在极长(emails 语义、批量分流、三个错误码、两种响应形状、Deprecated 标注)。合起来看:契约表里任一句与实现不符都会被下游当成可依赖的行为 —— 尤其「`emails` 数量 > 50 → `SHARE_BINDING_LIMIT_EXCEEDED`」这句,在 V2=false 批量下计的其实是分享条数而非绑定数。 |
| E7 | `T3 --same-file--> T4` | same-file | 两者同在 `fabe6e8` 且同改 `ShareCreateWizard.vue`:T3 重做了地址输入与结果面板,T4 删掉了关窗确认。合起来看:T3 新增的批量结果面板一次给 N 条链接,而 T4 恰好在此时移除了关窗前的最后一道拦截 —— 如果链接的可取回性不覆盖批量场景,风险被乘以 N。单独看任一主题都不会暴露这个乘积。 |
| E8 | `T3 --contract-change--> T6` | contract-change | `owner-share-lifecycle.spec.js` 直接消费 T3 的响应形状(V2=false 两地址 → 两个 `[data-test="share-url"]`)。合起来看:批量分流的响应形状(`{shares:[...]}` vs 单对象)一旦调整,E2E 会以「找不到两条链接」的形式报错,而真实故障可能是幂等重放路径 —— 断言形态掩盖了根因。 |
| E9 | `T2 --contract-change--> T6` | contract-change | E2E 断言 `data-status` 属性与 `[data-test="share-active-count"]` 的文本,这两个都是 T2 新接的 `liveStatus` 输出。合起来看:若 T2 的 UTC 解析口径有偏差,E2E 里 20 秒的短 TTL 恰好会掩盖它(8 小时的时区偏移在 20 秒窗口内表现为「一直 ACTIVE」直到超时,报错信息指向的是超时而不是时区)。 |
| E10 | `T6 --ordering--> T2, T3, T4` | ordering | 这条 spec 的每一句断言都要求 T2/T3/T4 已经生效,而 T6 的提交(`3706222`)排在它们之后。反向依赖同样成立:T2/T3/T4 的浏览器级证据只存在于 T6 里。合起来看:三个功能主题的「已验收」结论完全押在这一个文件上,它若因 seed 顺序或跨 run 污染而不稳定,三个主题会同时失去唯一的 sink 级证据。 |
| E11 | `T3 --shared-ssot--> T2` | shared-ssot | 建号/建分享(T3)是 `expires_at`、`status` 这些字段的写入方,Owner 展示(T2)是读取方,共享 `mail_share` 行这个真源。合起来看:T3 的批量路径为同一请求里的 N 条分享写入**同一个** `expiresAt` 字符串,若该字符串的格式与 T2 的 `expiresAtUtcMs` 假设不符,失效会同时命中一整批而不是一条,且在 Owner 眼里表现为「刚建好就过期」或「永不过期」。 |
| E12 | `T8` | 无耦合边 | 与本轮其余七个主题无共享文件、无契约关系、无顺序依赖;唯一待确认的是它是否已在 `origin/main` 上重复存在(见 T8 review_focus #1)。 |

---

## 提交覆盖核对

| sha | 归属主题 | 拆分说明 |
|---|---|---|
| `9b6eb8072fe73c93518e872037702a2e8e54056b` | T7 | 完整归属 |
| `37062220afc2be6dd4002a74c0dc8f20f03578f6` | T6 | 完整归属 |
| `82f330e720acb70069e77dda1f84ee0360b96c67` | T7 | 完整归属 |
| `e309ad4a17c46dcfff896b9d967b322cca4389a7` | **T5(主体) + T1(部分)** | T1 取 `index.vue` 的 gone 恢复分支与 `index.spec.js` 的 `gone link recovery (P4)` 一节;其余(`.share-card` 包裹、全部 scoped CSS、`ShareOtpCard.vue`、OTP 排版断言)归 T5 |
| `d602ec6690e9671487ecd735c7fa640d41496bde` | T1 | 完整归属 |
| `fabe6e841109dfb84b8b4da651c7caa03a5d7db4` | **T3(主体) + T4(部分)** | T4 取 `ShareCreateWizard.vue` 的 `onOpenChange` 去确认、`hasUnsavedSecret` 移除、zh/en 与 `PENDING_COPY` 中 `shareWizardCloseConfirm` 的删除及对应 spec;其余归 T3 |
| `b36581046fcf40d6d2476facfed78f05f3115d93` | T2 | 完整归属 |
| `1288ac85af8d51329862355cbc8d07b1ad7d22b9` | T7 | 完整归属 |
| `6985f0ef09421798c6cac2495bc2f501dcf7c7e7` | T8 | 完整归属(leftover,独立簇) |

9/9 提交已归入主题,无遗漏、无静默丢弃。
