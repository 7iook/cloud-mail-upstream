# Themes · 2026-08-26-r1 · Mode R 变更聚类侦察

range: `12cec61a0d4a1e7c99d1316b9ef9b75715c893b3..9b6eb8072fe73c93518e872037702a2e8e54056b`
ref: `origin/cursor/share-link-fullchain-8a38` @ `9b6eb8072fe73c93518e872037702a2e8e54056b`
commits: 8 → themes: 9（`fabe6e8` 拆 3 处归属、`e309ad4` 拆 2 处归属）
读码工作树: `/tmp/review-share-fullchain`（detached at reviewed HEAD）

判据源（本轮实际打开）：
`docs/specs/mail-share/design.md`、`docs/specs/mail-share/requirements.md`、
`docs/specs/mailbox-share-capability/design.md`（create 契约表 + 错误码表 + Update Log 段）、
`docs/specs/mailbox-share-capability/requirements.md`、
`docs/architecture/ADR-share-credential-recoverability.md`，
以及本轮入库的决策产物 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/{share-fullchain-decision-card.md, p4-destroyed-entrypoints.md, share-expired-status-rca.md}`。

机械闸门说明：本仓唯一 CI 是 `deploy-cloudflare.yml`（push main 触发部署），**不跑单测/lint/类型/密钥扫描**。本轮全部「已测过」的说法只来自决策卡里 executor 自填的 Evidence，没有任何机械闸门为其背书 —— 主题内凡引用「854/370/23 全绿」的地方一律按未验证事实处理。

---

## 提交 → 主题 归属总表（覆盖性自检）

| sha | 主题归属 |
|---|---|
| `1288ac85af8d51329862355cbc8d07b1ad7d22b9` | T9 |
| `b36581046fcf40d6d2476facfed78f05f3115d93` | T5 |
| `fabe6e841109dfb84b8b4da651c7caa03a5d7db4` | T2（worker 建号层）+ T3（分享创建 emails 链路）+ T4（向导关窗确认） |
| `d602ec6690e9671487ecd735c7fa640d41496bde` | T1 |
| `e309ad4a17c46dcfff896b9d967b322cca4389a7` | T1（访客页 gone 消费端接线）+ T6（P5 视觉） |
| `82f330e720acb70069e77dda1f84ee0360b96c67` | T7 |
| `37062220afc2be6dd4002a74c0dc8f20f03578f6` | T8 |
| `9b6eb8072fe73c93518e872037702a2e8e54056b` | T9 |

8/8 提交已归入主题，无遗留簇。

**两处拆分的事实依据（不是分类偏好）**

- `fabe6e8` 的 commit message 自己承认横跨两件事（"emails[] find-or-create…" + "向导关闭不再弹出确认框"），且它还顺带把 `account-service.add` 这条**与分享无关的既有注册写路径**整个改道到新模块 —— 三件事的用户面、回归面、判据源都不同。
- `e309ad4` 的 subject 只说「重做访客收码页视觉」，但 `views/share/index.vue` 的 diff 里同时落了 P4 的 `handleShareGone` / `isShareGone` / `markShareGone` / `blankShareDocument` 接线。**`d602ec6` 只导出了这些函数、没有任何页面消费它们**；已打开 SPA 的销毁出口是在这个「视觉」提交里才接上的。这条拆分对 reviewer 有直接后果：单看 `d602ec6` 会误判 P4 已收口。

---

## T1 · 已销毁 / 不存在的分享链接从「业务不可用页」改成浏览器原生 404

- **theme_id**: T1
- **name**: 访客拿到一条已被销毁或根本不存在的分享 URL 时，不再看到本站画的「链接不可用」页面，而是交还给浏览器自己的 404 —— 并且文档入口、五个访客 API、已打开的页面三条路都改成同一个终局
- **commits**:
  - `d602ec6690e9671487ecd735c7fa640d41496bde`（worker 文档拦截 + API 404 + 请求层 `ShareGoneError` + session 记账 + 轮询终局出口）
  - `e309ad4a17c46dcfff896b9d967b322cca4389a7`（**部分**：`mail-vue/src/views/share/index.vue` 里的 `handleShareGone` / `recoverFromUnavailable` gone 前置 / `logShareFailure` 的 `SHARE_DESTROYED` 分支 / `isLostResponse` 排除 gone）
- **intent**: Owner 销毁一条分享之后，原来的实现仍然让持链者看到一个由本站渲染的、带品牌与文案的「不再可用」页面 —— 用户（项目所有者）点名要求销毁后的 URL 不得出现**任何**业务 HTML。这需要把「gone（无行 / `REVOKED`）」从原本刻意不可区分的失败族里单独切出来，并保证它在浏览器直接导航、访客 API 调用、以及页面已经打开后 Owner 才销毁这三种时序下都落到同一个原生 404。
- **surfaces**:
  - Worker 裸 `fetch` 入口（`mail-worker/src/index.js`，`env.assets.fetch` 之前）
  - 新增的请求前置层 `mail-worker/src/security/share-document-gone.js`（与 `share-rate-limit` 同层，不进 hono、不进业务域）
  - 访客 API 错误信封层 `mail-worker/src/api/share-api.js` 的 `withShare`
  - 授权服务 `mail-worker/src/service/share-auth-service.js`（`establishSession` / `resolveSession` / `assertAllowed` 三个判定点）
  - 前端访客请求层 `mail-vue/src/request/share.js`（HTTP 404 → `ShareGoneError`）
  - 前端访客会话记账 `mail-vue/src/views/share/session.js`（`share:gone:<lid>`、`reloadShareDocument`、`blankShareDocument`）
  - 前端轮询终局 `mail-vue/src/composables/useSharePolling.js` 与页面出口 `mail-vue/src/views/share/index.vue`
  - 结构化观测 `mail-worker/src/service/share-event.js`（`share.system.error` / `reason=gone-check-failed`）
- **refs**:
  - `docs/specs/mail-share/requirements.md` AC-VISIT-04（本轮 revised）、AC-LIFE-03（本轮 revised）、AC-VISIT-07/09、AC-LEAK-02/06
  - `docs/specs/mail-share/design.md` P-AUTH-01「失败不可区分」、Error Handling 表、错误码稳定注册表、2026-08-26 Update Log
  - `docs/specs/mailbox-share-capability/requirements.md` AC-AUTH-02（revised）、AC-EDGE-03（revised）、AC-SEC-07（amended）、AC-SEC-03/10
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md`（十个入口的勾销清单）
- **review_focus**:
  1. **拦截面窄于 SPA 可达面 → 销毁链接仍出 200 壳**。查 `share-document-gone.js:SHARE_DOC_PATH = /^\/s\/([^/]+)\/?$/` 与前端路由表 `mail-vue/src/router/index.js` 里 `name === 'share'` 的实际 path 形态（是否允许 `/s/<lid>` 之外的子段、是否有 query/hash 变体、SPA fallback 覆盖到哪些形状）。判据：p4 清单 #1/#2/#10 要求文档入口**全量**收口；任何一个能落到 `env.assets.fetch` 的销毁 URL 形态都是 P4 的成功状态原话没有兑现。
  2. **`SHARE_DESTROYED` 内部码的逃逸面**。`withShare` 只按 `err.message === 'SHARE_DESTROYED'` 拦，且 `throwDestroyed()` 造的是 `BizError('SHARE_DESTROYED', 404)`。查 `share-api.js` 里是否存在未被 `withShare` 包裹的 handler、以及 `mail-worker/src/hono/hono.js` 的全局 `onError`（design.md 记载它 `c.json(...)` 不设 HTTP status）会不会把这个错误吐成 `{code:404, message:'SHARE_DESTROYED'}` 的 200 JSON。判据：AC-VISIT-04 修订文明写「内部错误码 `SHARE_DESTROYED` 不出现在响应体中」。
  3. **`assertAllowed` 的 REVOKED 前置是否溢出到 Owner 面**。`share-auth-service.js` 的 `assertAllowed` 现在把 `state === 'REVOKED'` 提到 `row.accountId > 0` 之前直接 `throwDestroyed()`。查 `mail-share-service.js` 的 Owner 写/读路径（revoke / delete / update / bindings / resetAuthKey / get / list）有没有任何一条穿过 `assertAllowed` 或复用同一 `effectiveStatus` 判定。判据：p4 清单末行「不在范围：Owner `/mailShare/*`（管理自己的行，仍返回业务 JSON）」；AC-ADMIN-09 要求撤销行仍向 Owner 展示。
  4. **gone 判定移到 `sec` 校验之前，原有的时序不可分性质是否被牺牲**。`establishSession` 现在 `if (!row || row.status === 'REVOKED') throwDestroyed()` 排在 `matchSec` 之前，被删掉的正是「`matchSec` 恒跑」这条时序防护（旧注释自陈其目的）。查 `lid` 存在但 `sec` 错 与 `lid` 不存在 两条路径的 HMAC 计算量差异，判断是否给出一个比 404 本身更廉价的 `lid` 存在性预言机。判据：AC-VISIT-03 常量时间比较、P-AUTH-01 族内不可区分（gone 出族是有意的，族内时序不是）。
  5. **fail-open 的敞口与观测**。`shareDocumentIfGone` 的 `try` 包住了 `env.db` 解引用在内的一切异常并静默回落 assets；`catch` 里 `err` 未被使用，且调用的是 `logShareEvent({ env }, ...)`。查 `share-event.js:shareRequestId` 对无 `c.get` 的入参确实返回 `null` 而不是抛错（否则 catch 内二次抛异常会把 fail-open 变成 500）、以及 `env.db` 绑定缺失这类**持续性**故障会不会让所有销毁链接无限期复活且只留一条无 lid、无 shareId 的事件。判据：决策卡 P4「DB 异常 fail-open」+ DC-P1-3「复用 `share.system.error`，正常 404 不打事件」。
  6. **已打开 SPA 的清理顺序与降级形态**。`handleShareGone` 依赖 `clearMailboxView()` 去清 `share:session:<lid>` 与 `share:est-key:<lid>`，然后才 `markShareGone` → reload/blank。查两件事：(a) 清理确实发生在 reload 之前（AC-SEC-07 amended 要求「先清除再离开页面」）；(b) `markShareGone` 在 `sessionStorage` 不可用时直接返回 `'blank'`，这会让**生产环境**（本可 reload 落到文档 404）退化成一张空白文档 —— 判断这是有意的保守还是把成功状态从「浏览器原生 404」降级成「白屏」。

- **risk**: **high** —— 它同时反转了一条写进 spec 三轮的安全性质（失败不可区分）、在 hono 之前的裸 fetch 入口新增了一条每次分享文档请求都跑的 DB 查询、并且用 fail-open 兜底；三者任意一处判断错，后果分别是「可探测面扩大」「文档入口延迟/故障放大」「销毁不生效」。
- **risk_spread_budget**:
  - name: `gone-码在错误信封里的逃逸路径`
    origin: `mail-worker/src/api/share-api.js:withShare`
    allowed_hops: 2
    allowed_surfaces: `mail-worker/src/hono/hono.js`（全局 onError）、`mail-worker/src/error/biz-error.js`、`mail-worker/src/api/share-api.js` 内其余 handler
    stop_when: 已确认所有能产出 `SHARE_DESTROYED` 的调用点都被 `withShare` 覆盖，或已定位到一条会把它 JSON 化的路径
  - name: `Owner 面被裸 404 波及`
    origin: `mail-worker/src/service/share-auth-service.js:assertAllowed`
    allowed_hops: 2
    allowed_surfaces: `mail-worker/src/service/mail-share-service.js`、`mail-worker/src/api/mail-share-api.js`
    stop_when: 已列出 `assertAllowed` / `effectiveStatus` 的全部调用方并确认 Owner 端点不在其中
  - name: `文档拦截面 vs SPA 可达路径`
    origin: `mail-worker/src/security/share-document-gone.js:SHARE_DOC_PATH`
    allowed_hops: 1
    allowed_surfaces: `mail-vue/src/router/index.js`、`mail-worker/src/index.js`、`mail-worker/wrangler.toml`（SPA fallback 配置）
    stop_when: 两侧的 `/s/*` 形态集合已对齐或已找出差集

---

## T2 · 「开一个邮箱账号」的全部不变量下沉成单一真源，设置页的既有注册路径随之改道

- **theme_id**: T2
- **name**: 把散在 `account-service.add` 里的建号校验（格式、域名、前缀、归属、配额、角色域名权限）整体搬进一个谁都能调的新模块，让「设置页手动加邮箱」和「创建分享时顺手开邮箱」用同一套规则，而不是各写一份
- **commits**: `fabe6e841109dfb84b8b4da651c7caa03a5d7db4`（**部分**：`mail-worker/src/service/mailbox-provision.js` 新建 + `mail-worker/src/service/account-service.js` 改道）
- **intent**: T3 需要在创建分享时给不存在的地址建号。如果直接在 `mail-share-service` 里复制一份 INSERT 和校验，就会出现第二条 account 写路径，两份规则迟早分叉成一次越权或一行脏数据（决策卡 DC-P0-2 就是因为初稿这么写才被打回）。所以先把不变量抽出来变成唯一居所，代价是**既有的、与分享毫无关系的注册入口被动改道**。
- **surfaces**:
  - 新增服务层模块 `mail-worker/src/service/mailbox-provision.js`（显式声明不得反向 import `mail-share-service` / `account-service`，以避免与既有 `account-service → mail-share-service` 边成环）
  - 既有注册写路径 `mail-worker/src/service/account-service.js:add`（校验段整体删除，改为 `planMailboxProvision` + `provisionMailbox`，并新增 `PROVISION_TO_ADD_ERROR` 机器码→本地化文案映射表）
  - 环境配置解析 `c.env.domain`（新增 `configuredDomains`：容忍 JSON 字符串形态、全部小写、精确匹配，明确禁止对字符串做 `.includes` 子串匹配）
  - 依赖读取：`settingService.query`、`userService.selectById`、`roleService.selectById` / `hasAvailDomainPerm`
- **refs**:
  - 无直接 AC —— 设置页建号不在两份 share charter 的范围内，判据只能是**改前的既有行为**与 `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-03 / AC-BIND-10（account 归属与存活条件）
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` §3「Account 写边界（纠正 DC-P0-2）」与「共享不变量（单一真源）」条目
- **review_focus**:
  1. **域名匹配口径被换掉**。旧代码是 `c.env.domain.includes(emailUtils.getDomain(email))`（数组语义、大小写敏感；若 `c.env.domain` 是字符串则退化为子串匹配）；新代码是 `configuredDomains(c)` 先 `JSON.parse`（失败抛 `BizError(t('notJsonDomain'))`）再全小写精确匹配。逐条比对拒绝集：大写域名从「拒绝」变成「接受」、字符串形态配置从「子串误命中」变成「解析失败直接抛」。判据：设置页改前行为 + 决策卡「`configuredDomains` 精确匹配、禁子串」。
  2. **前缀黑名单从大小写敏感变成不敏感**。旧 `emailPrefixFilter.some(content => getName(email).includes(content))` vs 新 `prefix.toLowerCase().includes(String(token).toLowerCase())`。这是收严（会命中更多注册请求）。查这是决策卡授权的不变量统一，还是搬迁时顺手改的行为，以及是否有既有测试固定了旧语义。
  3. **配额判据换了形状**。旧 `userAccountCount >= roleRow.accountCount → 拒`（计数来自 `accountService.countUserAccount`）；新 `owned + missing.length > roleRow.accountCount → 拒`，且 `owned` 来自新写的裸 SQL `countOwnedMailboxes`（`WHERE user_id = ? AND is_del = NORMAL`）。核对：单条路径两式是否严格等价、`countUserAccount` 是否还有本次未复制的额外谓词、以及 `roleRow` 为 falsy 时新代码整段跳过配额与域名权限（旧代码取不到 role 会怎样）。
  4. **`plan` 与 Turnstile 的先后，以及 `plan` 跑两遍**。新 `add` 的次序是 `planMailboxProvision(requireNew)` → Turnstile/加邮验证 → `provisionMailbox`，而 `provisionMailbox` 内部**又跑一次** `planMailboxProvision`。查：(a) 注释声称的旧序（校验 → Turnstile → 写入）与改前代码是否一致；(b) 两次 plan 之间多出的 `settingService.query` 与 account 全表 `lower(email) IN (...)` 查询是否引入可被匿名/半匿名流量放大的成本；(c) 两次 plan 之间的 TOCTOU 窗口是否比改前更宽。
  5. **UNIQUE 撞车分支的收尾**。`provisionMailbox` 的 `catch` 里，命中 `isUniqueConflict` 就重跑 plan（期望它以 `ACCOUNT_EXISTS`/`ACCOUNT_TAKEN`/`ACCOUNT_DELETED` 抛出）；如果 plan 意外通过，控制流会走到裸 `throw err`，把 D1 原始的 `UNIQUE constraint failed` 字符串扔给前端。查这条路径的用户可见形态与 `BizError` 契约（`biz-error.js` 默认 code 501）。
  6. **反向依赖禁令是否真的成立**。模块头注明不得 import `mail-share-service` / `account-service`。顺着 `userService` / `roleService` / `settingService` 的 import 图确认没有把这条边间接接回来（成环会在冷启动期表现为未定义导出，而不是构建错误）。

- **risk**: **high** —— 唯一让人担心的不是新功能，而是它**重写了一条既有的、与本次需求无关的用户注册写路径**，而这条路径没有任何 AC 或 CI 兜底（本仓 CI 只部署）。上面 1–3 每一条都是已经能看出的行为差异，需要判定哪些是有意的。
- **risk_spread_budget**:
  - name: `设置页建号行为等价性`
    origin: `mail-worker/src/service/account-service.js:add`
    allowed_hops: 1
    allowed_surfaces: `mail-worker/src/service/mailbox-provision.js`、`mail-worker/src/utils/verify-utils.js`、`mail-worker/src/utils/email-utils.js`、`mail-worker/src/service/role-service.js`
    stop_when: 旧 add 的每一条拒绝分支都已在新链路里找到对应项，差异已逐条判定为有意 / 回归
  - name: `c.env.domain 形态假设`
    origin: `mail-worker/src/service/mailbox-provision.js:configuredDomains`
    allowed_hops: 1
    allowed_surfaces: `mail-worker/wrangler.toml`、全仓其余读取 `env.domain` 的位置
    stop_when: 已确认全仓对 `env.domain` 的解析口径一致，或已列出仍在用旧口径的调用点
  - name: `provision 模块的依赖方向`
    origin: `mail-worker/src/service/mailbox-provision.js` import 段
    allowed_hops: 2
    allowed_surfaces: `user-service.js`、`role-service.js`、`setting-service.js` 及其一层依赖
    stop_when: 已确认不存在回到 `mail-share-service` / `account-service` 的环

---

## T3 · 直接粘贴完整邮箱地址就能开分享（不预注册），V2 关闭时一次粘贴多个地址出多条独立链接

- **theme_id**: T3
- **name**: Owner 在创建向导里不再需要「先注册账号、再从下拉里挑」，而是直接把完整地址（可批量粘贴）贴进去；不存在的地址在创建分享的同一个事务里顺手开出来；发布开关关着的时候，多地址不再被挡回，而是拆成每个地址一条独立分享链接
- **commits**: `fabe6e841109dfb84b8b4da651c7caa03a5d7db4`（**部分**：`mail-share-service.js` 的 `createFromEmails` 全链路 + `mail-vue` 向导 emails 输入 / 结果区 / `presets.js:parseShareEmails` / `request/mail-share.js` 转发 / zh·en 文案）
- **intent**: 用户的原话诉求是「不需要预注册」—— 原来的向导把「这个邮箱必须先作为 account 存在」当成创建分享的前置，Owner 得跳到设置页建号再回来。同时，`SHARE_CAPABILITY_V2` 生产默认为 false，如果批量地址走多 Binding 就会被这个与用户无关的发布栅栏吞掉，所以改成「V2 关 → 同一请求出 N 条单邮箱分享」（决策卡 DC-P0-1 的改向）。
- **surfaces**:
  - 分享服务写路径 `mail-worker/src/service/mail-share-service.js`：`toEmailList` / `normalizeCreateBody` 的 `emails` 键、`emailCreateFingerprints`、`assertCreateBody` 的 emailMode 分支、`prepareShareInsertByEmails` / `prepareBindingInsertByEmails` 两条邮箱定位 SQL、`createFromEmails` 的单 batch 组装与重试、`batchReplayLids` / `replayBatchFromLids` 批量重放
  - 与 T2 的接缝：`planMailboxProvision`（零写入预校验）+ `prepareAccountInsert`（带调用方注入 guard 的 account INSERT）
  - 幂等表 `share_idempotency` 的 `response_fingerprint` 语义扩展（`{lid}` → 批量时 `{lids:[...]}`）
  - 发布栅栏 `SHARE_CAPABILITY_V2` 的判定分叉（emails 个数**不过** MULTI_CREATE 栅栏；AuthKey / 有限配额栅栏照旧）
  - 错误码注册面：新增 `SHARE_EMAIL_INVALID`、`SHARE_DOMAIN_NOT_CONFIGURED`；其余账号侧拒绝折进既有 `SHARE_ACCOUNT_FORBIDDEN`
  - 前端：`ShareCreateWizard.vue`（textarea + tag 回显 + 批量结果区 + 独立的 `emailsInput` 幂等键轮换 watcher）、`presets.js`（`CREATE_BODY_KEYS` 加 `emails`、`parseShareEmails` 解析文法、`hasFenceIntent` 明确排除 emails、`createErrorKey` 新码映射）、`request/mail-share.js`（emails 在场则不带 accountIds）
- **refs**:
  - `docs/specs/mailbox-share-capability/design.md` API 契约表 create 行（本轮 82f330e 扩写）、错误处理表新增三行、2026-08-26 Update Log P2 段
  - `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-01/03/09/10/13、AC-LIFE-10/11（V2 全能力栅栏与双写）、AC-BIND-01/07/10、AC-EDGE-02
  - `docs/specs/mail-share/requirements.md` AC-SHARE-11/12/14/15（幂等语义、单条件 INSERT、batch 原子提交）、AC-SHARE-06（窗口快照线性化切点）
  - `docs/specs/mail-share/design.md`「开工前核实清单」D1 行（drizzle `.transaction()` 不可用、`batch()` 可回滚、batch 内语句不得消费前序结果）
- **review_focus**:
  1. **`manyEmail` 产品开关在分享入口被绕过**。`mailbox-provision.js` 模块头把 `addEmail`/`manyEmail`/Turnstile 归为「包装层差异」，只有 `account-service.add` 检查。但 `manyEmail` 管的是「一个用户能不能拥有多个邮箱」这条**归属侧**策略，不是「加账号这个按钮开不开」。查：站点把 `manyEmail` 关掉之后，Owner 能否通过分享向导给自己开出第二、第三个邮箱；剩下的唯一量化闸门是否只有 `roleRow.accountCount`。判据：`account-service.add` 改前对 `manyEmail` 的用法 + 决策卡「经批准的差异只在包装层，不在不变量」。
  2. **account 配额没有原子谓词**。`planMailboxProvision` 里的 `owned + missing.length > accountCount` 是**零写入预检**；而 batch 内 `prepareAccountInsert` 注入的 `accountGuardSql` 只带「分享活跃数余量」，**不带 account 配额**。查两个并发 create 请求能否把 `roleRow.accountCount` 顶穿。判据：`docs/specs/mail-share/requirements.md` 幂等与并发语义段明写「活跃数量上限不得采用『先 SELECT COUNT 再 INSERT』的两步模式」—— 分享数遵守了这条，account 数没有。
  3. **D1 batch 内「后续语句能否看见前序 INSERT」这条硬假设**。`prepareShareInsertByEmails` 的 `(SELECT MIN(pa.account_id) FROM account WHERE lower(pa.email) IN (...))` 和归属计数谓词，都要求解析到同 batch 更早的 `prepareAccountInsert` 刚落下的行；而同一段注释又声称「batch 内状态冻结」。这是两个不同的性质，需要分别取证。判据：design.md 记载的 T-02 结论**只**证了「`batch()` 可回滚」与「batch 内语句不得消费前序语句的**结果**」，没有证语句间的**行可见性**；查是否有 miniflare 之外的证据，以及 `mail-worker/test/mail-share-emails.spec.js` 用的是真 D1 还是 mock。
  4. **幂等指纹跨入口互认的边界**。`emailCreateFingerprints` 在「单地址 + 默认配置 + 该地址已解析到自己的存量账号」时，把 `stored` 换成 legacy 四字段 hash（用 resolve 后的 accountId），accepted 同时收 modern。这让 ShareDialog（`accountId` 形状）与向导（`emails` 形状）用同一把 `Idempotency-Key` 时互认为重放。查：两个形状真的语义等价吗（`emails` 路径会顺手建号、`accountId` 路径不会），以及 AC-SHARE-14「同 Key 异请求体 → `SHARE_IDEMPOTENCY_CONFLICT`」在这里是被有意放宽还是被绕过。另查 `normalizeCreateBody` 里 `emails` 非空时强制 `accountIds: []`（忽略发生在指纹之前）与「空 `emails` 绝不入指纹」这两条滚动发布硬约束是否都成立。
  5. **批量重放的回读语句缺 owner 谓词**。`replayBatchFromLids` 是 `WHERE ms.lid IN (SELECT value FROM json_each(?))`，没有 `ms.user_id = ?`；lid 清单虽然来自按 `user_id` 取到的幂等行，但这是「靠上游过滤」而不是「资源谓词自带」。同时查 `batchReplayLids` 要求 `lids.length > 1` 才走批量分支 —— N=1 的批量（groups.length===1）写的是 `{lid}`，分叉是否闭合。判据：AC-ADMIN-02 / AC-MGMT-07「他人 shareId → `SHARE_NOT_FOUND`」的资源谓词纪律。
  6. **限额余量折算的边界算术**。写入语句各带 `limit - (groups.length - 1 - index)`，account INSERT 带 `limit - (groups.length - 1)`，外加一条 `active.n + groups.length > limit` 的预检。查 `base + N` 恰好等于 `limit` 的边界、以及「全有或全无」在 batch 中途某条 share 零行时是否真的整批零残留（零行 INSERT 不报错也就不触发回滚 —— 这正是 `prepareBindingDelete` 注释里点明过的陷阱）。判据：AC-SHARE-12 / AC-CAP-13「整单拒绝、SHALL NOT 部分写入」。

- **risk**: **high** —— 一条全新的、会**创建 account 行**的写路径，同时叠加：并发抢注、幂等跨入口互认、D1 batch 语义假设、发布栅栏分叉、以及一个绕过既有产品开关的授权面。任意一条判断错，后果是脏账号、配额穿透、或滚动发布窗口内的策略降级。
- **risk_spread_budget**:
  - name: `account 写路径的授权与配额闸门`
    origin: `mail-worker/src/service/mail-share-service.js:createFromEmails`
    allowed_hops: 2
    allowed_surfaces: `mailbox-provision.js`、`role-service.js`、`setting-service.js`、`account-service.js`（仅读改前语义）
    stop_when: 已判明「分享入口能开出的 account 集合」是否严格不大于「设置页入口能开出的集合」，差集已逐项定性
  - name: `D1 batch 语句间行可见性`
    origin: `mail-worker/src/service/mail-share-service.js:prepareShareInsertByEmails` 的 account 子查询
    allowed_hops: 1
    allowed_surfaces: `mail-worker/test/mail-share-emails.spec.js`、`mail-worker/test/transaction.spec.js`、`docs/specs/mail-share/design.md` T-02 段
    stop_when: 已确认该假设有真 D1 证据，或已记为 unverified 交由 reviewer 判定
  - name: `幂等指纹在 create 两个入口之间的互认`
    origin: `mail-worker/src/service/mail-share-service.js:emailCreateFingerprints`
    allowed_hops: 1
    allowed_surfaces: `legacyCompatibleBody` / `createFingerprints` / `replayOrConflict`、`mail-vue/src/request/mail-share.js`
    stop_when: 已枚举「同 Key 不同形状」的全部组合并判定各自落在重放 / CONFLICT 的哪一侧
  - name: `V2 栅栏的分叉正确性`
    origin: `mail-worker/src/service/mail-share-service.js:assertCreateBody` 的 emailMode 分支
    allowed_hops: 1
    allowed_surfaces: `isCapabilityV2Enabled` / `assertCapabilityV2`、`mail-vue/src/views/share-admin/presets.js:hasFenceIntent`
    stop_when: 已确认 V2=false 下不存在任何路径写出 >1 条 Binding（AC-LIFE-11 不可破）

---

## T4 · 创建结果区关闭时不再弹「关掉就再也看不到了」的二次确认

- **theme_id**: T4
- **name**: Owner 关闭创建向导的结果面板时直接关掉，不再被一个「确认已保存链接？」的对话框拦一次 —— 理由是链接现在可以从详情里取回，不再是一次性的
- **commits**: `fabe6e841109dfb84b8b4da651c7caa03a5d7db4`（**部分**：`ShareCreateWizard.vue` 的 `onOpenChange` / `hasUnsavedSecret` 删除 + `ElMessageBox` import 移除 + zh·en 的 `shareWizardCloseConfirm` 文案删除）
- **intent**: 用户报告这个二次确认是纯摩擦：链接本来就能复制、也不再是唯一副本。它的存在前提（「明文恰一次」）已经被 `ADR-share-credential-recoverability` 部分推翻。
- **surfaces**:
  - 向导关闭生命周期 `mail-vue/src/views/share-admin/ShareCreateWizard.vue:onOpenChange` / `closeNow` / `acknowledgeSecret`
  - i18n 文案表 `mail-vue/src/i18n/{zh,en}.js` 与组件内的 `PENDING_COPY` 兜底表（两处都删了同一个键）
  - 与之相邻但**未动**的：AuthKey 一次性告警 `data-test="wizard-authkey-once"`、未知结果冻结态 `unknownResult`
- **refs**:
  - `docs/architecture/ADR-share-credential-recoverability.md`（Status: **Proposed**；「取代范围**仅限 `sec`**；AuthKey 的『明文恰一次』(AC-CAP-05) 不受影响，继续有效」）
  - `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-05（AuthKey 明文恰好一次）、AC-CAP-14（首次响应丢失后的引导流程）
  - 决策卡 §3「P3 · 无 API」：「结果区复制链接 / AuthKey 一次警告保留。W15 改为：关闭不调 confirm」
- **review_focus**:
  1. **AuthKey 仍然是不可恢复的，而拦它的那道确认没了**。ADR 明写 AuthKey 不在可恢复范围内。查 `authKeyEnabled=true` 创建成功后关闭结果区，AuthKey 明文是否就此永久丢失，而 Owner 得到的唯一提示是一行静态 `shareAuthKeyOnce` 文案（不是模态拦截）。这是本主题里唯一一条「删掉的防护对应的风险并未同时消失」的地方。
  2. **P3 的理由依赖一个 Proposed 的 ADR 和一条只覆盖新建行的能力**。ADR 轨一（可逆加密存储）只对上线后新建的分享生效。查本轮 create 路径（含 T3 的 `prepareShareInsertByEmails`）是否确实写入了 `sec_cipher` / `kek_kid`，以及详情抽屉的取回端点在**批量**创建出的 N 条分享上是否都可用 —— 若任一条走不通，关闭即永久失去链接，P3 的前提不成立。
  3. **未知结果（`unknownResult`）下现在可以直接关窗**。`onOpenChange` 只在 `submitting` 时 return；结果未知时表单被冻结但对话框可关。查 AC-CAP-14 要求的「引导 Owner revoke/delete 后重新 create、禁止换 `Idempotency-Key` 盲建」这条流程会不会因为一次随手关窗而被绕过（关掉后 `rotateIdempotencyKey` 在下次 `openDialog` 里会换新钥匙）。
  4. **测试契约的方向**。决策卡 W15 从「关闭要 confirm」改成「关闭不调 confirm」。查 `ShareCreateWizard.spec.js` 里旧断言是被**改写成反向断言**（关闭时 `ElMessageBox.confirm` 未被调用）还是被直接删掉 —— 后者会让这条行为此后无人看守。

- **risk**: **medium** —— 改动本身只有十几行且是用户点名要求的，但它删掉的是一个凭据丢失的最后拦截点，而 AuthKey 的不可恢复性并未随之改变。
- **risk_spread_budget**:
  - name: `凭据可恢复性的实际覆盖面`
    origin: `mail-vue/src/views/share-admin/ShareCreateWizard.vue:onOpenChange`
    allowed_hops: 2
    allowed_surfaces: `ShareDetailDrawer.vue`（reveal 入口）、`mail-worker/src/service/mail-share-service.js`（`mintShareCredentials` / `sec_cipher` 写入 / reveal 端点）、`docs/architecture/ADR-share-credential-recoverability.md`
    stop_when: 已确认本轮全部 create 路径产出的分享都能从详情取回 `sec`，且 AuthKey 的不可恢复性已单独定性

---

## T5 · Owner 侧的过期状态改成按 `expiresAt` 本地实时翻转，不再只信一次 API 快照

- **theme_id**: T5
- **name**: 分享到期之后，Owner 不用重新登录也能看到状态变成「已过期」—— 收件箱徽章、分享管理列表、详情抽屉、行操作、快捷对话框五个地方都改成读一个带秒级时钟的实时状态
- **commits**: `b36581046fcf40d6d2476facfed78f05f3115d93`
- **intent**: 用户报告的现象是「链接过期了，前端还显示 ACTIVE，只有重新登录才变」。RCA 定位到收件箱页在 `layout` 的 keep-alive 里，侧栏再点进来不会走 `onMounted`，而所有展示面都把 API 返回的 `effectiveStatus` 当死值用。修法有两半：回源触发（`onActivated` / visibility / focus）与本地覆盖（拿权威 `expiresAt` 和一个 1 秒 tick 自己算）。
- **surfaces**:
  - 新增展示态 SSOT `mail-vue/src/views/share-admin/status.js`：`expiresAtUtcMs`（把裸 `YYYY-MM-DD HH:mm:ss` 当 UTC 解析）+ `liveEffectiveStatus(row, nowMs)`
  - 新增共享时钟 `mail-vue/src/views/share-admin/use-share-clock.js`（1s interval + focus/visibility 同步 + `onMounted/onActivated/onDeactivated/onUnmounted` 四钩子）
  - 五个消费面：`views/email/ShareIndicator.vue`、`views/email/ShareDialog.vue`、`views/share-admin/index.vue`、`views/share-admin/ShareDetailDrawer.vue`、`views/share-admin/ShareRowActions.vue`
  - keep-alive 宿主 `views/email/index.vue`（新增 `onActivated` → `shareIndicator.refresh()`）
- **refs**:
  - `docs/specs/mail-share/requirements.md` AC-LIFE-08（本轮 amended：展示层以 `liveEffectiveStatus` 为准，鉴权与写入仍以服务端每请求实时计算为唯一真源）、AC-LIFE-01、AC-MGMT-04
  - `docs/specs/mailbox-share-capability/requirements.md` AC-LIFE-02（四态优先级 `REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE`）、AC-ADMIN-04/09
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-expired-status-rca.md`（假设账 A/B falsified、C confirmed）
  - 决策卡 §3「P1 · 五面接线清单（纠正 DC-P1-1）」表格
- **review_focus**:
  1. **每行一个 1 秒定时器**。`ShareRowActions.vue` 是列表里**每行一个组件实例**，而它在 `setup` 里各自 `useShareClock()` → 各自一个 `setInterval(1000)` 加一对 `window`/`document` 监听。查 20 行列表下的定时器与监听器数量，以及它与页面级 `share-admin/index.vue` 自己那对 `focus`/`visibilitychange` → `fetchList` 叠加后，一次窗口聚焦会打出几个请求（`fetchList` 无去抖）。判据：决策卡接线表允许 `ShareRowActions`「继承父时钟或自身」，但没有授权 N 份心跳。
  2. **UTC 解析口径与失败时的静默回退**。`expiresAtUtcMs` 只认 `YYYY-MM-DD HH:mm:ss`（`replace(' ','T') + 'Z'`）。核对 `GET /mailShare/list` 与 `/mailShare/get` 实际下发的 `expiresAt` 字符串形态；一旦解析出 NaN，`liveEffectiveStatus` 会**静默退回 API 快照**，也就是退回本次要修的那个 bug，且没有任何可见信号。判据：决策卡失败列「解析错 TZ → 多/少显示 ACTIVE，必须用 `...T...Z`」。
  3. **四态优先级与缺字段兜底**。`liveEffectiveStatus` 只覆盖 REVOKED 与过期两支，`ACCESS_LIMIT_REACHED` 原样透传，且末尾 `return row.effectiveStatus || 'ACTIVE'`。查 row 缺 `effectiveStatus`（例如某个面传的是精简对象）时会不会把一个服务端已拒绝的分享画成 ACTIVE。判据：AC-LIFE-02 的四态优先级。
  4. **本地结果绝不回写**。AC-LIFE-08 amended 明写「前端结果不得回写」。查 `ShareDetailDrawer.writable`（`isMutableStatus(liveStatus(...))`）与 `ShareRowActions.canRevoke` 只影响控件显隐，请求体里没有夹带本地算出的状态；同时确认 EXPIRED 行**仍可 revoke**（持久化仍是 ACTIVE，后端谓词是 `status='ACTIVE'`）—— 这正是注释里点明的、容易被「过期就禁用按钮」改回去的地方。
  5. **keep-alive 下的监听器生命周期不对称**。`useShareClock` 的 start/stop 挂了 `onMounted/onActivated` 与 `onDeactivated/onUnmounted` 四个钩子；但 `ShareIndicator.vue` **自己另加**的 `visibilitychange`/`focus` 监听只在 `onUnmounted` 摘除。查它在 keep-alive deactivate（不卸载）时是否留下监听，以及反复进出收件箱是否累加。
  6. **列表筛选与实时状态打架**。`share-admin/index.vue` 的 `status` 筛选参数走服务端，卡片显示走 `liveStatus`。查「筛选 ACTIVE」的结果集里出现被本地翻成 EXPIRED 的卡片时的表现，以及翻转后是否需要 refetch 才能与筛选条件自洽。

- **risk**: **medium** —— 纯展示层、不改鉴权，且 AC-LIFE-08 已为此做了行内 amend；主要暴露在定时器/监听器规模与时区解析这两处工程细节上。
- **risk_spread_budget**:
  - name: `展示态本地覆盖是否溢出到写路径`
    origin: `mail-vue/src/views/share-admin/status.js:liveEffectiveStatus`
    allowed_hops: 1
    allowed_surfaces: 五个消费面组件 + `mail-vue/src/request/mail-share.js`
    stop_when: 已确认无任何请求体/查询参数携带本地计算出的状态
  - name: `时钟与回源监听的实例规模`
    origin: `mail-vue/src/views/share-admin/use-share-clock.js`
    allowed_hops: 1
    allowed_surfaces: `ShareRowActions.vue`、`share-admin/index.vue`、`ShareIndicator.vue`、`views/email/index.vue`
    stop_when: 已数清一屏列表下的 interval / listener 数量并判定可接受与否
  - name: `expiresAt 序列化口径`
    origin: `mail-vue/src/views/share-admin/status.js:expiresAtUtcMs`
    allowed_hops: 1
    allowed_surfaces: `mail-worker/src/service/mail-share-service.js`（list/get 的时间列输出）、`mail-vue/src/utils/day.js:tzText`、`views/share/index.vue` 的访客侧 `expiresMs`
    stop_when: 两侧字符串形态已对齐，或 NaN 回退路径已定性

---

## T6 · 访客收码页按设计卡重做视觉

- **theme_id**: T6
- **name**: 访客打开分享链接后看到的是一张居中的卡片式收码页，验证码用大号等宽字、复制按钮在手机上全宽可点，而不是原来那张贴边的裸文档
- **commits**: `e309ad4a17c46dcfff896b9d967b322cca4389a7`（**部分**：`.share-card` 包裹层、`.share-shell` 上的 CSS 变量 token、状态态样式、spinner/呼吸动画、`ShareOtpCard.vue` 全量样式；不含同提交内的 P4 gone 接线，那部分归 T1）
- **intent**: 收码这件事的 P0 信息是「验证码 + 复制」，原页面把它和其它信息平铺在一起、移动端触控区不足。设计卡 `visitor-share-ui-design.md` 定了 token、断点、字号与动效降级；硬约束是**不许动 `data-share-*` 钩子**（既有 visitor e2e 全靠它）也不许引入 Element Plus 或任何第三方（匿名 chunk 隔离）。
- **surfaces**:
  - 访客页壳 `mail-vue/src/views/share/index.vue` 的模板包裹层与 scoped CSS（新增 `--sh-*` 设计 token 挂在 `.share-shell`）
  - 验证码卡片 `mail-vue/src/views/share/ShareOtpCard.vue` 的 scoped CSS（含手动选中降级元素 `.share-otp-select`）
  - 按 `data-share-state` 分支的终态卡片样式（unavailable / timedout / exited；注释声明销毁态不经过这里）
- **refs**:
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md`
  - `docs/specs/mailbox-share-capability/requirements.md` AC-SEC-06（匿名 chunk 隔离，守护测试 `assert-share-chunk.js`）
  - `docs/specs/mail-share/requirements.md` AC-VISIT-10（分享页零第三方脚本）、AC-OTP-08/09（复制与手动选中降级）、AC-OTP-14/15、AC-SEC-22（HTML 模式固定高度 + 内层滚动）
- **review_focus**:
  1. **`data-share-*` 钩子零改这条硬约束**。新增的 `.share-card` 在 `[data-share-shell]` 与原有内容之间插了一层 DOM。查既有 visitor e2e / 组件 spec 里有没有依赖直接子元素关系或层级的选择器，以及 `data-share-state` 仍挂在最外层 shell（状态 CSS 选择器 `.share-shell[data-share-state="..."] .share-card` 依赖这一点）。
  2. **匿名 chunk 隔离不得被视觉改动破坏**。查本次是否引入了任何 `element-plus`、图标库或字体外链（`font-family` 只用系统栈是安全的，但 `@font-face` / CDN 引用不是）。判据：AC-SEC-06 + AC-VISIT-10 + `assert-share-chunk.js` 的依赖图断言是否覆盖到本次改动的模块。
  3. **销毁态确实不经过这套样式**。CSS 注释断言「销毁态不经过这里（P4 原生 404），所以本页不设计 gone 插画」。查 `data-share-state` 的取值集合里有没有任何一个会在 404 抵达之前先渲染出业务卡片（这条与 T1 的第 6 点是同一个接缝的两侧）。
  4. **复制降级路径仍然可用**。`.share-otp-select`（Clipboard 不可用时的手动选中元素）本次改了 `box-sizing` / `border` / `border-radius`。查它在 `clip: auto; overflow: visible` 之后仍然可见、可聚焦、可全选。判据：AC-OTP-09「不得只提示复制失败」。
  5. **设计卡的可测条款逐条对账**。OTP `clamp(30px, 8vw, 40px)` 等宽、移动端复制按钮全宽且 `min-height: 44px`、`prefers-reduced-motion` 包住全部动画、桌面 `max-width: 640px`。决策卡要求 1280 与 390 两个视口的实际截图作为 Evidence —— 查这份证据是否真的存在（`9b6eb80` 的 Evidence 行只写了「截图 desktop 1280 / mobile 390」，未给路径）。

- **risk**: **low** —— 纯 scoped CSS 与一层 DOM 包裹，无逻辑改动、无网络面；风险集中在钩子稳定性与「视觉提交夹带了 P4 逻辑」这一点（后者已拆到 T1）。
- **risk_spread_budget**:
  - name: `DOM 层级变化对既有钩子的影响`
    origin: `mail-vue/src/views/share/index.vue` 新增的 `.share-card` 包裹层
    allowed_hops: 1
    allowed_surfaces: `tests/e2e/specs/visitor-*.spec.js`、`mail-vue/src/views/share/index.spec.js`
    stop_when: 已确认无选择器依赖被插入层打断

---

## T7 · 把两项已推翻的对外契约写回 shipped spec

- **theme_id**: T7
- **name**: 把「销毁即原生 404」和「创建分享可以直接给完整邮箱地址」这两条已经落地的行为，作为带日期的修订记进两份已发布的规格，而不是新开 ADR
- **commits**: `82f330e720acb70069e77dda1f84ee0360b96c67`
- **intent**: 本轮有两处**有意推翻**既有 AC 的改动（P4 反转了三轮评审确立的「失败不可区分」一支；P2 给 create 加了新入参与新错误码）。规格是下一轮 reviewer 与后续 agent 的判据源，不回写就会让下一轮把有意的推翻当成实现漂移。
- **surfaces**:
  - `docs/specs/mail-share/requirements.md`：AC-VISIT-04、AC-LIFE-03 行内 revised；AC-LIFE-08 行内 amended
  - `docs/specs/mail-share/design.md`：新增 2026-08-26 Update Log 段（P4 口径 + 入口清单 + 测试契约同步；P1 展示纪律局部修订）
  - `docs/specs/mailbox-share-capability/requirements.md`：AC-AUTH-02 / AC-EDGE-03 revised、AC-SEC-07 amended
  - `docs/specs/mailbox-share-capability/design.md`：create 契约表整行重写（emails 语义、批量分流、新错误码、Deprecated 标注）、错误处理表新增三行、Update Log 新增 2026-08-26 条目
- **refs**: 上述四份文件自身；被引用的 ADR：`ADR-mail-share-capability-boundary.md`、`ADR-mailbox-share-capability-extension.md`、`ADR-share-credential-recoverability.md`
- **review_focus**:
  1. **锚点漂移**。`mail-share/design.md` 的 2026-08-26 Update Log 写的是 `mail-vue/src/views/share/status.js`，实际落地的文件是 `mail-vue/src/views/share-admin/status.js`（`views/share/` 是访客页目录，`views/share-admin/` 才是管理面）。查这一处以及同段落里其余路径锚点是否都对得上真实文件。
  2. **改了的 AC 与没改的相邻条款是否自洽**。P4 把 gone 切出不可区分族，但：`mail-share/design.md` 的 **P-AUTH-01**「失败不可区分」性质段正文未改（只在 AC 行内标了 revised）；「错误码（稳定注册表）」一段**没有收录** `SHARE_DESTROYED`、`SHARE_EMAIL_INVALID`、`SHARE_DOMAIN_NOT_CONFIGURED`；Traceability 矩阵里 AC-VISIT-04 的验证手段仍写「四种非法输入响应逐字节相同 / P」。逐条查这些未同步项。
  3. **front-matter 与正文的状态打架**。`mail-share/design.md` 的 front-matter 仍是 `status: converged`、`last_review_status: NEEDS_CHANGES`、`shipped_commit: null`，而正文的 Update Log 已经在记 shipped 之后的整改波次。查两份 charter 的 front-matter 与本轮改动是否需要同步（`mailbox-share-capability` 侧已记 `status: converged → shipped`）。
  4. **契约表与实现的逐字对账**。capability design 的 create 行现在声明：`emails.length===1` 不过 V2 栅栏、`emails.length>1 且 V2=false` → `{shares:[...]}`、单地址与 V2 multi 响应含 `mailbox`。对照 `buildEmailCreateResponse`（`shares.length === 1` 时返回单对象且挂 `share.mailbox`）与 `assertCreateBody` 的实际分支，确认文档描述的是落地行为而不是意图。
  5. **「不新开 ADR」这个判断本身**。P4 改变的是对外可观测的失败分族（一条经过 R1–R3 三轮确立的安全性质），P2 新增了两个对外错误码并让 create 具备建号副作用。查这两项是否落进本仓 ADR 门槛（`mail-share/design.md` Decision 8 对「边界定义型且难以反转」的判据），还是确实属于 dated changelog 的范围。

- **risk**: **medium** —— 文档不影响运行时，但它是下一轮的判据源；漏同步的条款会让后续 reviewer 拿着自相矛盾的 spec 判代码。
- **risk_spread_budget**:
  - name: `spec 内部一致性（AC ↔ 性质段 ↔ 错误码注册表 ↔ Traceability）`
    origin: `docs/specs/mail-share/requirements.md` AC-VISIT-04 / AC-LIFE-03
    allowed_hops: 1
    allowed_surfaces: `docs/specs/mail-share/design.md`、`docs/specs/mailbox-share-capability/{requirements,design}.md`
    stop_when: 与 gone 分族相关的全部条款已逐条对齐或已列出未同步项
  - name: `文档锚点 ↔ 真实文件路径`
    origin: `docs/specs/mail-share/design.md` 2026-08-26 Update Log
    allowed_hops: 1
    allowed_surfaces: `mail-vue/src/views/share-admin/`、`mail-vue/src/views/share/`、`mail-worker/src/security/`
    stop_when: 该段落引用的每个路径都已在工作树中命中

---

## T8 · 补 Owner 侧的浏览器验收，并给 e2e 环境补上 Owner 本人的邮箱行

- **theme_id**: T8
- **name**: 之前的端到端测试全是访客视角，Owner 根本登不进去（种子数据缺了 Owner 自己的邮箱行）；这一提交把它补上，并加了两条从浏览器里跑的 Owner 用例：批量粘贴出两条链接、短有效期分享停在页上自己翻成过期
- **commits**: `37062220afc2be6dd4002a74c0dc8f20f03578f6`
- **intent**: 决策卡的 VERIFY 条目要求「五条成功状态各至少一条真实入口→sink 验收，环境不可用必须写 Evidence 阻塞原因，禁止静默跳过 e2e」。P1/P2/P3 的 sink 全在 Owner 界面上，而既有 harness 从没让 Owner 登录过 —— `loginUserInfo` 会解引用 Owner 的 account 行，缺了它 Owner UI 根本起不来。
- **surfaces**:
  - e2e 种子 `tests/e2e/harness/worker-entry.js:seedOwner`（新增 Owner 本人 account 行 + 导出 `ownerAccountId`）
  - 新增用例 `tests/e2e/specs/owner-share-lifecycle.spec.js`（两条：P2 批量分流 + P3 关窗无确认；P1 停页翻转 + 刷新保持 + 徽章归零）
  - 被这两条用例间接固定的前端契约：`[data-test]` 钩子集合（`wizard-open` / `wizard-emails` / `share-url` / `share-row` 的 `data-status` / `share-active-count`）
- **refs**:
  - 决策卡 §「任务清单」VERIFY 条目与各 P 的「必做验收」段
  - `docs/specs/mail-share/requirements.md` AC-MGMT-04（邮箱界面展示 ACTIVE 分享数量，层级 E）、AC-LIFE-08 amended
  - `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-01/13、AC-ADMIN-01/09
- **review_focus**:
  1. **种子改动对既有用例的副作用**。`seedOwner` 现在多插一行 `account`（`OWNER_EMAIL`，归属同一 `userId`）。查它是否改变了其它 spec 依赖的 account 计数、`accountList` 分页结果、role `accountCount` 余量，或任何按「该用户有几个邮箱」断言的地方 —— 尤其是 T3 引入的配额谓词现在会把这一行计进 `owned`。
  2. **P1 用例无法区分两条修复路径**。用例先等 `data-status` 变 `EXPIRED`（30s 超时），再 reload 再断言。但 `use-share-clock` 的 tick 与 `share-admin/index.vue` 的 focus/visibility 回源**都会**导致状态翻转，用例没有隔离时钟（例如冻结 `Date.now` 或断言期间不触发 focus）。查它是否真的验证了「停在页上跨过 `expiresAt`」这条决策卡点名的路径，还是只验证了「某种方式最终会变」。
  3. **P2 用例的断言止步于 UI**。只断言出现两个 `share-url` 且形如 `/s/<lid>#`。查是否有配套的 DB 侧断言（两条独立 `mail_share` 行、两个新 `account` 行、零多 Binding），以及决策卡点名的反向用例（未知域名 → 零写入、UNIQUE 竞态）是否确实落在 `mail-worker/test/mail-share-emails.spec.js` 而不是无人覆盖。
  4. **flake 面**。`page.waitForTimeout(500)` 后断言 `.el-message-box` 数量为 0（用固定等待证明「某个东西不出现」）、`.el-dialog__headerbtn:visible` 在可能有多层弹窗时的唯一性、以及注释自陈的「D1 状态跨 run 持久（`--persist-to`）」下靠 `Date.now()` runTag 过滤的隔离强度。
  5. **决策卡「必做验收」逐条对账**。P4 要求 Playwright **真实导航**断言 `response.status() === 404` 与空 body、P5 要求 1280/390 截图。本提交只覆盖 Owner 侧；查这两项是落在既有 `visitor-unavailable` / `visitor-revoke-live`（由 `d602ec6` 改写）里，还是只存在于 `9b6eb80` 的 Evidence 文字中。

- **risk**: **medium** —— 测试代码本身不上生产，但种子改动会横向影响整个 e2e 套件的前提；而这几条用例是本轮**唯一**为 P1/P2/P3 提供的端到端证据（CI 不跑测试，没有第二道闸门）。
- **risk_spread_budget**:
  - name: `e2e 种子变更的横向影响`
    origin: `tests/e2e/harness/worker-entry.js:seedOwner`
    allowed_hops: 1
    allowed_surfaces: `tests/e2e/specs/**`、`tests/e2e/fixtures/share.js`
    stop_when: 已确认既有用例的前提不受新增 account 行影响
  - name: `Owner 侧断言与实现细节的耦合`
    origin: `tests/e2e/specs/owner-share-lifecycle.spec.js`
    allowed_hops: 1
    allowed_surfaces: `ShareCreateWizard.vue`、`share-admin/index.vue`、`ShareIndicator.vue` 的 `data-test` 钩子
    stop_when: 已判明断言锁的是业务结果还是当前 DOM 形状

---

## T9 · 本轮整改的决策产物入库与任务清单回写

- **theme_id**: T9
- **name**: 把这一轮五条整改的目标、备选方案、入口清单、RCA 与审后改向整理成可追溯的决策卡落盘，最后再把每条任务勾掉并附上自测证据
- **commits**:
  - `1288ac85af8d51329862355cbc8d07b1ad7d22b9`（决策卡 413 行 + P4 入口清单 + 过期状态 RCA + 访客 UI 设计卡 + 第一轮异构评审 + round1 prompt 存档，共 1381 行、6 文件）
  - `9b6eb8072fe73c93518e872037702a2e8e54056b`（任务清单 8 项 `[ ]` → `[x]`，逐项挂 Evidence 与 commit；Update Log 补一行）
- **intent**: 这两个提交本身不改任何运行时行为，但它们是本轮其余七个主题的**判据源与验收账本** —— 决策卡定义了每条改动的成功状态、Goal→Outcome 链路表、断链风险表与必做验收；回写提交声称这些验收都已完成。reviewer 判断 T1–T8 是否兑现意图时，读的就是这两份东西。
- **surfaces**:
  - `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md`（Boundary Decisions / Interface Contract / Goal→Outcome / TDD Red / 断链表 / 任务清单 / Update Log）
  - 同目录 `p4-destroyed-entrypoints.md`（十个入口的勾销表）、`share-expired-status-rca.md`（含假设账 A/B/C 的证伪证据）、`visitor-share-ui-design.md`、`share-fullchain-decision-card.review1.sub.md`（NEEDS_CHANGES p0=3 p1=4）、`prompt.round1.sub.txt`（644 行）
  - 不触碰 `docs/` 与任何源码
- **refs**: `docs/specs/mail-share/design.md` 与 `docs/specs/mailbox-share-capability/design.md` 的 2026-08-26 Update Log 均反向引用这张决策卡为依据（T7 的回写就是照它写的）
- **review_focus**:
  1. **Evidence 与提交内容对账**。逐条核 `9b6eb80` 里八个 `[x]` 的 `files:` / `commit:` 字段是否真的覆盖对应改动。已可见的一处缺口：P4 的 Evidence 只列了 `share-document-gone.js` / `index.js` / `share-auth-service.js` 三个 worker 文件与 commit `d602ec6`，**没有提到访客页 `views/share/index.vue` 的 gone 接线其实是在 `e309ad4` 里才落的** —— 按这份 Evidence，P4 的 SPA 出口看起来像是 `d602ec6` 就闭合了。
  2. **三条 P0 改向是否逐条兑现**。review1 判 NEEDS_CHANGES（p0=3：批量分流不绑默认关闭的 V2 / account 下沉 `mailbox-provision` / 多步写入进同一 D1 batch）。对照 T3 与 T2 的实现，确认三条都落地且没有留半条（例如「同一 batch」是否真的把 account INSERT 也纳入 —— 从代码看纳入了，但配额谓词没进，见 T3 focus 2）。
  3. **测试数字的可核验性**。回写声称 worker 854 / vue 370 / e2e 23 全绿。本仓 CI 不跑测试，这些数字没有任何机械闸门背书。查是否有可复跑的命令与产物路径（决策卡 VERIFY 条目明写「环境不可用必须写 Evidence 阻塞原因，禁止静默跳过」，那么反过来，声称跑过的也应能被复跑）。
  4. **判据只留在 archive 里**。`p4-destroyed-entrypoints.md`（gone 的入口全集）与 `visitor-share-ui-design.md`（P5 的可测条款）实际上是本轮的验收判据，却只存在 `.agent-workspace/.archive/2026-08-26/` 下，`docs/specs/` 侧只以一句 Update Log 提及。查后续 agent 按 `docs/` 找判据时是否会漏掉它们。
  5. **存档内容的卫生**。`prompt.round1.sub.txt` 是 644 行原始 prompt 入库。查其中是否含凭据、密钥、内网地址或不该长期留存的环境信息。

- **risk**: **low** —— 纯文档，无运行时影响；但它是本轮唯一的验收账本，Evidence 与实际提交对不上会直接误导后续判断（第 1 点已经是一例）。
- **risk_spread_budget**:
  - name: `Evidence ↔ 实际提交内容`
    origin: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` 任务清单段
    allowed_hops: 1
    allowed_surfaces: 本轮八个提交的 diff、`docs/specs/**` 的 Update Log
    stop_when: 八条 Evidence 的 files/commit 字段已逐条与 diff 对上，不符项已列出

---

## 耦合边表

> 关系类型：`contract-change`（A 改了契约，B 是消费方）／`shared-ssot`（A/B 动了同一个真源）／`same-file`（A/B 改了同一文件的邻近区域）／`ordering`（A 的正确性依赖 B 先生效）

### 1. `T1 --ordering--> T6`（准确说：T1 的 SPA 出口依赖 e309ad4 才生效）

`d602ec6` 导出了 `markShareGone` / `reloadShareDocument` / `blankShareDocument` / `ShareGoneError`，但**没有任何页面调用它们**；`views/share/index.vue` 里的 `handleShareGone` 与 `recoverFromUnavailable` 的 gone 前置，是在被标为「重做访客视觉」的 `e309ad4` 里落的。
**合起来看可能出什么问题**：任何只回滚 `e309ad4`（比如觉得这一版视觉不好看）的操作，会同时把 P4 已打开页那一支静默摘掉 —— 访客页会退回用 `SHARE_UNAVAILABLE` 的通路处理 404，而 `useSharePolling` 里 `isShareGone` 的终局出口仍在，结果是轮询停了但页面停在业务壳上，正是 P4 明令禁止的形态。按提交 subject 做变更影响分析的人看不到这条依赖。

### 2. `T1 --same-file--> T6`

两者改的都是 `mail-vue/src/views/share/index.vue`，且在同一个提交里 —— 一个改 `<script setup>` 的失败处理与 import 段，一个改模板包裹层与 scoped CSS。
**合起来看可能出什么问题**：CSS 注释断言「销毁态不经过这里，所以本页不设计 gone 插画」，这个断言的正确性完全由同文件另一半（`handleShareGone` 抢在 `showDeadShare` 之前）保证。任一半改动都会让另一半的注释变成谎言，而它们没有任何测试把这条关系钉住。

### 3. `T2 --shared-ssot--> T3`

`mailbox-provision.js` 是「什么样的邮箱可以被开出来」的唯一真源；T3 的 `planShareMailboxes` 与 batch 里的 `prepareAccountInsert` 是它的第一个新消费方，T2 里改道后的 `account-service.add` 是第二个。
**合起来看可能出什么问题**：两个消费方对同一组不变量做了**不同的裁剪** —— 设置页保留 `addEmail`/`manyEmail`/Turnstile，分享入口全部不查；配额在设置页是「plan 后立即单条写入」，在分享入口是「plan 预检 + batch 内只带分享数余量的 guard」。真源统一了，但真源之外的闸门没有统一，于是「同一个用户，同一个地址，走两个入口结果不同」这件事从两份复制的 SQL 变成了两份不同的包装 —— 更难发现，因为它现在看起来像是一个 SSOT。

### 4. `T2 --contract-change--> （设置页注册路径）`

`account-service.add` 是消费方：它的全部校验语义现在由 `mailbox-provision.js` 决定。域名匹配（大小写 + JSON 解析）、前缀黑名单（大小写）、配额算式三处已可见行为差异。
**合起来看可能出什么问题**：这条边指向的是**本轮需求之外的功能**。用户要的是「分享时不用预注册」，代价却是站点注册入口的拒绝集被改了三处；这三处都没有 AC 覆盖，本仓 CI 也不跑测试，因此唯一的守护是 reviewer 自己去比对改前行为。

### 5. `T3 --shared-ssot--> T1`（`share_idempotency` 与 create/visitor 两侧的错误码族）

两者都往「访客/Owner 看到什么错误码」这一张对外契约表上加东西：T1 切出 `SHARE_DESTROYED`（不入响应体、翻成裸 404），T3 加 `SHARE_EMAIL_INVALID` / `SHARE_DOMAIN_NOT_CONFIGURED`（Owner 侧业务 JSON）。
**合起来看可能出什么问题**：`mail-share/design.md` 的「错误码（稳定注册表）」段落是这张表的真源，本轮**三个新码一个都没进去**（只进了 capability design 的错误处理表两行）。下一轮拿注册表当判据的人会把三个码都判成未注册的野码；反过来，真正需要「注册表即全集」这条性质的地方（例如前端 `createErrorKey` 的 default 分支）也没有依据可查。

### 6. `T3 --same-file--> T4`

同一提交、同一文件 `ShareCreateWizard.vue`：T3 重写了结果区（新增批量面板 `createdShares` / `replayShares`），T4 删掉了 `onOpenChange` 里的关闭确认。两处在同一个「结果区生命周期」的语义邻域内。
**合起来看可能出什么问题**：这是本表里最值得当心的一条。批量路径一次产出 **N 条**链接、全部只在这个面板里出现一次，而拦住「随手关掉」的那道确认恰好在同一个提交里被删了。P3 的正当性建立在「链接可从详情抽屉取回」上；如果这条取回路径对批量建出的 N 条分享有任一条不成立（见 T4 focus 2），那么「一次关窗丢 N 条链接」就是可达的，而且比原来只丢 1 条严重 N 倍。

### 7. `T5 --contract-change--> T8`

T5 把 `data-status` 属性的取值改成由本地时钟驱动；`owner-share-lifecycle.spec.js` 的 P1 用例直接断言这个属性。
**合起来看可能出什么问题**：用例把「翻转」当成成功信号，但翻转有两条来源（tick / focus 回源），用例没有隔离。若将来只保留回源、砍掉 tick（或反之），这条 e2e 仍然会绿 —— 它守不住决策卡真正点名的那条路径（「停在页上跨过 `expiresAt`」）。

### 8. `T3 --ordering--> T8`，`T4 --ordering--> T8`

`owner-share-lifecycle.spec.js` 的第一条用例在同一个测试里同时验证 P2 的批量分流与 P3 的关窗无确认，且依赖 T3 的 `wizard-emails` textarea 钩子与 T4 删掉的确认框；它还依赖 T8 自己新加的 Owner account 种子行。
**合起来看可能出什么问题**：这条用例是 P2 与 P3 唯一的端到端证据，三个主题任一回滚都会让它红，但**红的原因会指向错误的主题**（例如 T4 回滚后，失败断言是 `.el-message-box` 计数，看起来像 P3 的问题，实际可能是 T3 的结果区形状变了导致对话框没关成）。

### 9. `T7 --shared-ssot--> T1 / T3 / T5`

`docs/specs/**` 是这三个主题共同的契约真源：T1 改了 AC-VISIT-04 / AC-LIFE-03 / AC-AUTH-02 / AC-EDGE-03 / AC-SEC-07，T3 改了 capability design 的 create 契约表与错误处理表，T5 改了 AC-LIFE-08。
**合起来看可能出什么问题**：三处修订都用**行内标注**（`{revised:}` / `{amended:}` + 删除线保留原文）的方式落在已 shipped 的规格里，但相邻的**性质段**（P-AUTH-01）、**Traceability 矩阵**、**错误码注册表**、**front-matter** 都没有跟着动。下一轮 reviewer 在同一份文件里会同时读到「gone 与 unavailable 两族可区分」（AC 行）与「全部非法输入响应逐字节相同」（矩阵行 + 性质段），两条都是现行文本 —— 判据源自己打架，无法用来判代码。

### 10. `T9 --ordering--> T1..T8`（判据源与验收账本）

决策卡先落盘（`1288ac8`），其余七个主题按它实现，最后由 `9b6eb80` 勾销。
**合起来看可能出什么问题**：验收账本与实现之间已经出现一处对不上（P4 的 Evidence 未包含 `e309ad4` 里那一半接线，见 T9 focus 1）。账本是本轮唯一的完成度声明 —— 一旦它与 diff 不符，后续 agent 会按账本认定「P4 全链路已闭合、可以在其上继续叠加」，而实际的 SPA 出口挂在一个 subject 写着「视觉」的提交里。
