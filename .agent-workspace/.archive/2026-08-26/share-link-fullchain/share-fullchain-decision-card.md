# Decision Card · 分享链接全链路整改（P1–P5）

> Engineering Mode A · Charter 闸门未触发（`docs/specs/mailbox-share-capability/` 已 shipped，本轮是整改增量，不新建 requirements/design/tasks 三件套）。
> 本文件是 Step 3.5-lite 送审对象。审查 = 审本文档，不是审工作区里未批准的代码。
> 工作区现存 P1 半成品（`status.js` / `ShareIndicator.vue` 等）**不是契约**；executor 只按本卡审后正文收口或重写。

---

## 原始用户目标（五条，逐字意图，编号沿用用户口中的问题号）

| ID | 角色 + 操作 | 期望业务结果 | 负向条件 | 来源 |
|---|---|---|---|---|
| P1 | Owner 看收件箱徽章或分享管理列表 | 链接过期后，刷新页面或回到这些面即可看到「已过期」；停在页上跨过过期时刻也会翻 | 不得再依赖重新登录；不得只改后端却前端仍展示 ACTIVE | 用户原话：过期后前端不自动更新；手动刷新仍旧状态；只有重新登录才同步。排查所有展示分享状态的面 |
| P2 | Owner 在分享管理向导里建分享 | **无条件（不依赖 V2）**：不预注册，输入一个完整邮箱即可建分享。**批量**：粘贴多个完整地址一次提交也能拿到可复制链接（V2 关闭时不得静默被栅栏挡住，见契约「批量分流」） | 后台未配置该域名时友好提示、不崩溃；旧「前缀+域名拼接 / 先加账号再选账号」不得再作为创建分享前置 | 用户原话：新建分享逻辑重构【重点】；接口/参数废弃旧拼接；接口文档同步并标注废弃 |
| P3 | Owner 创建成功后关掉结果弹窗 | 关掉即走 | 不得再弹出「只显示一次 / 关闭后无法再看到」确认框（凭据已可从详情取回） | 用户原话：该弹窗应直接删掉 |
| P4 | 任何人用浏览器打开已被销毁的分享 URL | 浏览器原生 404（空 body，无业务 HTML） | 禁止业务系统自定义「不再可用」页渲染；访问/跳转/内部转发/接口转发全部统一原生 404 | 用户原话：销毁后禁止自定义页面；直接返回浏览器原生 404；全量梳理入口 |
| P5 | 访客打开仍有效的 `/s/:lid#sec` | 按已落盘 UI 设计卡收码：OTP 大字可复制、空箱等待、桌面卡片/移动全宽 | 禁止改 `data-share-*`；禁止给销毁态做自定义插画页（销毁走 P4 原生 404） | 用户原话：先 UI SUB 出完整设计再实现 |

**总成功状态（用户视角，派发/复审原样保留）**：

NOT「接口多字段 / 组件再 list 一次 / 单测绿」，BUT Owner 刷新即可看到过期；不预注册、输入完整邮箱即可建分享，域名未配置有友好提示；创建后关闭不再二次「只显示一次」弹窗；销毁链接是浏览器原生 404；访客页按新视觉可收码。不得发生：重登才更新过期、向导仍拼域名、关结果区再确认、销毁 URL 仍出 SPA 文案、改坏 e2e 钩子。

来源：用户原话（五条）。

---

### 🏗️ 1. Boundary Decisions

- **Core domain**：MailShare 创建、Owner 展示态、Visitor 文档/API 入口。
- **基础设施**：Worker `fetch` 在 `env.assets.fetch` 之前的文档拦截；Owner axios；访客匿名 axios；Vue keep-alive。
- **状态机（持久化不变）**：DB 仍只有 `ACTIVE` / `REVOKED`。`EXPIRED` 仍是计算态（`expires_at ≤ now`），不写库。
  - Owner 展示：客户端可按 `expiresAt` 把过期行覆盖成 `EXPIRED`（P1），服务端 list 算法不改。
  - 销毁 = 无 `mail_share` 行 **或** `status='REVOKED'` → 文档 GET/HEAD 与访客 API 一律 HTTP 404 空 body。
  - `EXPIRED` **不是**销毁：仍走 SPA + `SHARE_UNAVAILABLE`。
- **Invariants**：
  1. 向导创建：有非空 `emails[]` 则以完整地址为准，**禁止**前缀+域名拼接。`accountId` / `accountIds` 仍留给「分享当前邮箱」快捷入口（AC-CAP-10）。
  2. 邮箱域名必须 ∈ `configuredDomains(c)`（解析 `c.env.domain` 为数组后**精确匹配**）。禁止对可能是 JSON 字符串的 `c.env.domain` 做 `String.includes` 子串判断。
  3. 销毁链接禁止任何业务 HTML 错误页；只允许浏览器原生 404。
  4. 关闭创建结果区不再二次确认。链接可从详情 `revealSec` 取回（ADR-share-credential-recoverability）。AuthKey 仍只展示一次（哈希不可逆），结果区内的 AuthKey 警告保留，但**不再**用关闭确认框承担这件事。
  5. 访客页视觉只改包裹 class / scoped CSS / `ShareOtpCard` 外观；`data-share-*` 零改。
  6. V2=false 时批量不得被能力栅栏挡死，也不得写多 Binding；account 创建不变量只存在于 `mailbox-provision.js`。
- **契约变更（shipped spec 追加 dated changelog，不新开 ADR）**：
  - P4 **推翻** `docs/specs/mail-share` 的 AC-VISIT-04 中「不存在 / 已销毁」与「过期 / 错 sec」不可区分的一支。新口径：gone → 原生 404；EXPIRED / 错 sec / 功能关 / 死账号 → 仍 `SHARE_UNAVAILABLE`。
  - P1 **局部修订** Owner 展示侧 AC-LIFE-08「只信 API `effectiveStatus`、前端不重算过期」：Owner 展示改为 `liveEffectiveStatus`；鉴权与写入仍以服务端为准。
  - P2 给 `docs/specs/mailbox-share-capability/design.md` API 表追加 `emails[]`，并标注向导侧账号下拉/拼接路径 **deprecated**。
- **ADR admission**：no。实现/契约增量，不改不可逆技术选型。P4 的不可区分性收缩写入 shipped spec changelog，不新开 ADR。
- **业务分类（§0.17，防把技术缺口当需求）**：

| 项 | 场景 | 缺失影响 | 分类 |
|---|---|---|---|
| P1 live 状态 | Owner 盯着已过期链接仍显示可分享 | 把失效链接继续发出去 | A 业务刚需 |
| P2 emails 创建 | Owner 要给临时码地址建分享却必须先走「加账号」拼接 | 无法按完整地址建分享 | A 业务刚需 |
| P3 删确认框 | 创建后关窗被二次恐吓，但详情已能取回链接 | 误导 + 多余操作 | A（与已落地可恢复性冲突的错误 UX） |
| P4 原生 404 | 销毁后仍渲染业务「不可用」页 | 用户明确禁止的自定义页 | A 业务刚需 |
| P5 访客视觉 | 访客收码页难用 | 收码效率 | C 商业/体验，但用户已拍板本期做 |
| 新建 `configuredDomains()` | 域名配置可能是数组或 JSON 字符串 | 子串匹配会误判/漏判导致崩溃或错放行 | B 稳定性（P2 的正确校验，不是新业务） |

禁止本期做：无 account 行的「虚拟邮箱」（邮件投递仍键在 account 上 = 第二真源）；WebSocket 推过期；给销毁做自定义 404 插画；改 `addEmail` 开关/Turnstile 去迁就分享创建。

---

### 🔍 2. Existing-Implementation Search

**Internal（侦察已核实，评审器无需再查源码；下列为本文自带事实）**：

- Owner 过期：`mail-share-service` list 已用 `nowText()` UTC 裸串 + `OWNER_STATUS_CASE` 实时算 `effectiveStatus`；Owner API 已 `Cache-Control: no-store`。根因在前端：收件箱 `defineOptions({ name: 'email' })` 在 layout keep-alive include 里；`ShareIndicator` 只在 `onMounted` / `accountId` 变化时 `listMailShares()`；展示信 `row.effectiveStatus` 快照。侧栏再点收件箱不走 `onMounted`；重登才拆树。同源面：`ShareDialog`、`share-admin/index.vue`、`ShareDetailDrawer`、`ShareRowActions`。
- 创建：`POST /mailShare/create` 白名单只有 `accountId`/`accountIds` + 配置字段。向导 `ShareCreateWizard` 用账号下拉；加邮箱在 `layout/account/index.vue` 把前缀拼 `addForm.suffix` 再调 `account-service.add`。`account-service.add` 受 `addEmail`/`manyEmail` 开关、Turnstile、配额约束。`account-service.js` 已 import `mail-share-service.js`，反向再 import 会循环。
- 关闭确认：`ShareCreateWizard.onOpenChange` 在 `hasUnsavedSecret` 时 `ElMessageBox.confirm(shareWizardCloseConfirm)`；文案「关闭后将无法再看到这个链接（和密钥）」。规格测试 W15 断言会 `confirm` 一次。结果区已有 `shareSecretOnce`（日后可在详情查看）与独立的 `shareAuthKeyOnce`。
- 销毁文档：`wrangler.toml` `run_worker_first = true` + `not_found_handling = "single-page-application"`。`mail-worker/src/index.js` 非 `/api/` 且非 static/attachments 一律 `env.assets.fetch` → `GET /s/:lid` 永远 200 SPA。访客 API 当前对无行/撤销/过期/错 sec 返回字节相同的 `SHARE_UNAVAILABLE`（AC-VISIT-04）。
- 域名：`setting-service` 已把 `c.env.domain` 当 JSON 字符串 parse 成数组；`account-service.add` / `user-service` / `login-service` / `public-service` 仍写 `c.env.domain.includes(getDomain(email))`。若 vars 是 JSON 字符串，`.includes` 变成子串匹配。
- 指纹：`normalizeCreateBody` 12 字段；`legacyCompatibleBody` 要求单 `accountIds` 且新字段停在 DDL 默认。空键进入指纹会破坏滚动发布兼容。
- `hasFenceIntent`：只看 `accountIds.length > 1` 与若干 V2 字段，不看邮箱个数。
- 访客页：`views/share/index.vue` + `ShareOtpCard.vue`；e2e 靠 `data-share-*`。已有 UI 设计卡 `visitor-share-ui-design.md`。

**External**：

- Vue keep-alive 官方：缓存实例不重跑 `onMounted`，必须用 `onActivated` 回源。锚点：https://vuejs.org/guide/built-ins/keep-alive （tool: exa `web_search_exa` · query: `Vue 3 keep-alive onActivated refresh stale data vs onMounted best practice 2026` · top1: Vue.js KeepAlive guide）。
- 过期展示是时间谓词，客户端可在权威 `expiresAt` 上覆盖；服务端仍是写入/鉴权权威。
- 资源不存在 → HTTP 404；用户要的是**浏览器原生** 404 页，不是站点自定义 HTML。MDN 提到永久删除可用 410 Gone，但用户明确要原生 404，故不采用 410（见替代方案）。锚点：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/404 （tool: tavily_search · query: `HTTP 404 empty body vs custom error page for deleted share links RFC 7231 gone resource`）。

**Hit → 扩展现有 create / 文档入口 / Owner 展示 SSOT，禁止平行造第二套分享服务或无 account 的虚拟邮箱。**

---

### 📐 3. Interface Contract

#### P2 · `POST /mailShare/create`

- 新增 `emails: string[]`：完整地址，trim + 小写 + 去重；分隔符 `[\s,;]+`（前端先解析；后端再校验）。
- **优先级**：`emails` 非空 → 忽略本次请求里的 `accountIds`/`accountId`（向导只走 emails）。`emails` 缺省或空 → 走旧 `accountId(s)`（ShareDialog / AC-CAP-10）。
- **生产可达 · 批量分流（纠正 DC-P0-1）**：`SHARE_CAPABILITY_V2` 在 `wrangler.toml` 仅注释声明，代码缺省 **false**，生产默认关。因此：
  - `emails.length === 1`：一条单邮箱分享；**不**走 V2 栅栏。这是 P2 无条件必达路径。
  - `emails.length > 1` 且 V2=true：一条 multi 分享（现有 AC-LIFE-11 语义），`hasFenceIntent` 为真。
  - `emails.length > 1` 且 V2=false：**禁止**用 `SHARE_CAPABILITY_NOT_ENABLED` 吞掉用户的批量目标；改为同一请求内为每个地址各建 **一条单邮箱分享**（各 lid/sec，不写多 Binding）。响应 `{ shares: [...] }`。向导结果区列出全部链接。
  - **禁止**：V2=false 时写 `mail_share_binding` 多行（旧 Worker 安全窗口，AC-LIFE-11 不可破）。
- **Account 写边界（纠正 DC-P0-2）**：新建 `mail-worker/src/service/mailbox-provision.js`（无依赖 mail-share / account-service，打破循环）。`account-service.add` 与分享创建都调用它。
  - **共享不变量（单一真源）**：`configuredDomains` 精确匹配、前缀长度/黑名单、角色域名权限、配额、邮箱 UNIQUE、已删/他人 → `SHARE_ACCOUNT_FORBIDDEN`。
  - **分享入口经批准的差异**（用户原话「不需预注册」）：不检查 `addEmail`/`manyEmail` 开关、不跑 Turnstile / 加邮验证计数。`addEmail` 管的是设置页「添加账号」产品开关，不是 account 行的全局禁写；Turnstile 是该匿名/设置流的人机验证，Owner 已持 JWT。
  - `account-service.add` 仍先检查开关 + Turnstile，再调同一 provision。
  - **禁止**在 `mail-share-service.js` 复制一份 SQL 当第二写路径。
- **多步写入（纠正 DC-P0-3）**：现有 create 注释已写明「D1 没有 BEGIN，batch 一旦提交没有回头路，只有语句报错才回滚」。
  1. **先全量预校验、零写入**（格式/域名/前缀/权限/配额/归属）。任一项失败 → 整单稳定码、零 INSERT。
  2. 读已有 account；为缺失邮箱准备 INSERT 语句。
  3. account INSERT + share INSERT + binding INSERT **进入同一个** `c.env.db.batch()`。share 失败则 account 一并回滚，无孤儿邮箱。
  4. 并发抢同一邮箱：UNIQUE 冲突 → 再读一行；属当前用户则复用；属他人/已删 → `SHARE_ACCOUNT_FORBIDDEN`。整批重试至多一次。
  5. N 条单分享（V2=false 批量）同样一个 batch、一把幂等键；指纹对 **规范化后的 sorted emails + 配置字段**，禁止空 `emails: []` 入指纹。单条且默认值对齐仍可走 `legacyCompatibleBody`（resolve 后的单个 accountId）。
- 前端：`CREATE_BODY_KEYS` / `CREATE_OPTIONAL_FIELDS` 增加 `emails`；`createMailShare` 转发 `emails` 且不附带 `accountIds`。`hasFenceIntent`：仅当「将写成多 Binding 的一条分享」时为真（V2 路径），N 条单分享不为真。
- 向导：去掉账号下拉；tag + 批量 textarea；提交 `emails`、不含 `accountIds`。V2 关 + 多地址：消费 `shares[]` 结果区。V2 未知：按响应形状渲染，收到 `SHARE_CAPABILITY_NOT_ENABLED` 时不得出现在「V2=false 批量」路径上。
- **废弃（文档标注，行为删除）**：向导「选已注册账号 / 前缀+域名拼接」作为创建分享前置。设置页「添加账号」拼接 UI **保留**。

#### P1 · Owner 展示（无新 HTTP 字段）

- SSOT：`mail-vue/src/views/share-admin/status.js` 的 `expiresAtUtcMs` + `liveEffectiveStatus(row, nowMs)`。
  - 优先级：REVOKED（`status` 或 `effectiveStatus`）> 客户端 `expiresAtUtcMs <= nowMs` → EXPIRED > API `effectiveStatus`。
  - UTC 解析：`Date.parse(text.replace(' ','T')+'Z')`，与访客页 `expiresMs` / `tzText` 同口径。
- 刷新触发：`onActivated`、`visibilitychange`、`window focus`；email 页 `onActivated` 调 `shareIndicator.refresh()`。
- 轻量 tick（约 1s）驱动 `nowMs`，停页跨过 `expiresAt` 也会翻徽章。`useShareClock` 在 `onUnmounted`/`onDeactivated` 清 interval 与 window 监听。
- **五面接线清单（纠正 DC-P1-1）**：共享函数存在 ≠ 已消费。每面必须读 live 状态、订阅同一时钟语义、有回源、有测试。

| 面 | 状态 consumer | 时钟 producer | 回源 | 动作判断 | 测试 |
|---|---|---|---|---|---|
| `ShareIndicator.vue` | `liveEffectiveStatus(row, nowMs)` 计 ACTIVE | 组件内 `useShareClock` | `onActivated` + visibility + focus；email 页再 `refresh()` | 仅徽章 | `ShareIndicator.spec.js` 冻结时钟 + 激活再拉 |
| `ShareDialog.vue` | 列表行 live | 打开期间 `useShareClock` | 打开时 `loadList`；打开中 tick | 展示 tag；revoke 仍允许 EXPIRED | 改写旧 AC-LIFE-08 用例 |
| `share-admin/index.vue` | 模板 `data-status` **与** tag 都走 `liveStatus(row)`，禁止绑 `row.effectiveStatus` | 页面级 `useShareClock` | 进入页 `fetchList`；visibility/focus | 卡片展示 | `index.spec.js` 过期行 data-status=EXPIRED |
| `ShareDetailDrawer.vue` | 徽章 live；`isMutableStatus(liveStatus)` | 抽屉打开期间时钟 | 打开拉 get；tick | 可写控件跟 live | 抽屉 spec |
| `ShareRowActions.vue` | 按钮显隐用 live | 继承父时钟或自身 | 随列表 tick | 禁止只信 API 快照 | 行操作 spec |

- 不改后端 list 算法。revoke 按钮在 EXPIRED 仍可用（持久化仍是 ACTIVE）。

#### P3 · 无 API

- 删除 `onOpenChange` 里 `hasUnsavedSecret` 的 `ElMessageBox.confirm`。关闭即 `closeNow()`。
- 结果区复制链接 / AuthKey 一次警告保留。W15 改为：关闭不调 `confirm`。

#### P4 · Visitor 文档 + API

- 新建 `mail-worker/src/security/share-document-gone.js`：`parseShareLidPath`、`nativeGoneResponse`、`shareDocumentIfGone`。
- `index.js` 在 `env.assets.fetch` **之前**拦截 `GET|HEAD /s/:lid`。无行或 `REVOKED` → `Response(null, {status:404, headers:{'Cache-Control':'no-store'}})`。EXPIRED 仍交给 assets。
- DB 异常 **fail-open** 到 assets（活链接不得被误打成 404）。catch 必须走既有 `logShareEvent(c, SHARE_EVENT.SYSTEM_ERROR, { reason: 'gone-check-failed' })`（禁止 lid/sec/邮箱；`shareId` 未知则保持 null）。**不新开**监控产品；复用 `share.system.error` 信封，与已有告警规则同一事件名。正常 gone 404 **不**打这条（404 是成功态）。
- `share-auth-service`：无行或 `status===REVOKED` → `throwDestroyed()` = `new BizError('SHARE_DESTROYED', 404)`，**不**依赖 sec 是否匹配。EXPIRED / 错 sec / 功能关 / 死账号仍 `SHARE_UNAVAILABLE`。
- `share-api.js` `withShare`：对该错误返回真正 HTTP 404 空 body（不是 JSON envelope）。
- SPA：`shareHttp` 把 HTTP 404 映射 `ShareGoneError`；`sessionStorage['share:gone:'+lid]` 只 reload 一次（生产 reload 打到文档拦截）；vite:3001 不经 worker 则清空 `document.documentElement` 避免死循环。
- 不改前端路由表。Owner `/mailShare/*` 仍返回业务 JSON（Owner 管理自己的行）。

#### P5 · 无 API

- 按 `visitor-share-ui-design.md`：token 挂 `.share-shell`；桌面 max-width 640px；移动去浮层、复制全宽、tab 横滚、44px 触控；OTP `clamp(30px,8vw,40px)` mono；`prefers-reduced-motion`；倒计时无 `aria-live`；销毁不设计自定义页。

#### Goal → Outcome 链路表

每一跳：producer → 产出物 → consumer → 消费后用户可见结果 → 失败行为。

**P1 过期展示**

| 节点 | producer | artifact | consumer | result | failure |
|---|---|---|---|---|---|
| 权威时间 | Worker list（已有，不改） | `expiresAt` UTC 裸串 + `effectiveStatus` | Owner 前端 | 快照到达浏览器 | API 错 → 现有 list 错误态 |
| 本地覆盖 | `liveEffectiveStatus`（改/建） | 展示用状态 | ShareIndicator / ShareDialog / share-admin / ShareDetailDrawer / ShareRowActions | 过期行显示 EXPIRED | 解析错 TZ → 多/少显示 ACTIVE，必须用 `...T...Z` |
| 回源 | 五面各自 onActivated/open/visibility（改） | 重新 `listMailShares` | 五面，见接线表 | 硬刷新或再进页看到服务端最新撤销/过期 | 只修徽章不修管理页 = 本需求失败 |
| tick | `useShareClock` ~1s（建） | `nowMs` | 五面 computed / liveStatus | 停页跨过时刻徽章与 tag 翻掉 | 冻结 tab 靠 visibility 回源；未 unmount 清监听会泄漏 |

最终 sink：收件箱徽章 `[data-test=share-active-count]` + 分享管理卡片 `data-status` + 详情徽章。  
必做验收：五面 vitest 冻结时钟；Owner 短 TTL 分享后刷新/再进收件箱与打开管理页均见 EXPIRED（浏览器；环境不可用则截图+HAR 记入 Evidence，不得静默跳过）。

**P2 完整邮箱创建**

| 节点 | producer | artifact | consumer | result | failure |
|---|---|---|---|---|---|
| 输入 | ShareCreateWizard（改） | `emails[]` 完整地址 | `createMailShare` | 请求不再带拼接前缀、不带账号下拉 id | 空列表本地拦 |
| 传输 | `createMailShare`（改） | POST body `emails` | `normalizeCreateBody` | 白名单接受 | 未注册 `emails` 被丢弃 = 孤儿字段 |
| 解析 | `mailbox-provision.js`（建） | 预校验通过的邮箱清单 | create 的 batch 组装 | 不预注册也能建分享 | 未知域名 `SHARE_DOMAIN_NOT_CONFIGURED` 整单 0 写入 |
| 持久化 | 同一 `c.env.db.batch()`（改） | account 新行（如需）+ share + binding | list/get/向导结果区 | 单地址一条链接；V2 关批量则 N 条单分享链接 | 预校验后才写；batch 报错整单回滚；空 emails 入指纹 → CONFLICT |
| 批量分流 | `isCapabilityV2Enabled`（已有） | 一条 multi **或** N 条单分享 | 向导结果区 | V2 关时批量仍拿到链接，不被栅栏挡住 | V2 关写多 Binding = 违反 AC-LIFE-11 |
| 文档 | design.md dated changelog（改） | API 表 + deprecated + 批量分流 | 人类/后续 agent | 旧拼接被标废弃 | 只改代码不改文档 = 用户 P2 未完成 |

最终 sink：向导提交成功出可复制链接（单条或 `shares[]`）；未知域名出友好错误、DB 无新行。  
必做验收：worker vitest 覆盖 单 emails + V2=false 多 emails→N 条单分享 + V2=true 多 emails→一条 multi + 未知域名零写入 + UNIQUE 竞态；向导 spec 提交不含 `accountIds`，多地址结果区列出多链接。

**P3 去确认框**

| 节点 | producer | artifact | consumer | result | failure |
|---|---|---|---|---|---|
| 关闭 | `onOpenChange`（改） | 无 confirm | Owner | 关掉结果区即走 | W15 仍期望 confirm = 测试与产品打架 |

最终 sink：关闭向导不再出现第二层 MessageBox。

**P4 销毁原生 404**

| 节点 | producer | artifact | consumer | result | failure |
|---|---|---|---|---|---|
| 文档 | `shareDocumentIfGone` + `index.js`（建/改） | HTTP 404 空 body | 浏览器 GET/HEAD `/s/:lid` | 原生 404 页 | 仍 `assets.fetch` → 200 SPA = 本需求失败 |
| API | `throwDestroyed` + `withShare`（改） | HTTP 404 空 body | `share.js` / 任何访客 API 客户端 | 轮询/会话不再拿到 JSON 不可用页 | 仍 200+SHARE_UNAVAILABLE JSON |
| 已打开 SPA | `ShareGoneError` + 单次 reload（改） | reload 或清空 document | 访客当前页 | 生产打到文档 404 | vite 直出死循环（用清空 document 兜） |

最终 sink：用户在目标浏览器地址栏打开已销毁/不存在 lid 后，看到**浏览器原生 404 页**（无 `[data-share-shell]`、无业务「不再可用」文案）。  
必做验收（纠正 DC-P1-2）：Playwright 经 wrangler `:8788` **真实导航** `page.goto`：missing 与 revoked 的 `response.status()===404`、body 空、无业务 DOM；EXPIRED 仍 unavailable SPA。已打开页撤销后 reload，生产落到原生 404。`visitor-headers.spec.js` 改打**活链接**。环境不可用则人工导航截图进 Evidence，不得写「能跑则」后静默跳过。

**P5 访客视觉**

| 节点 | producer | artifact | consumer | result | failure |
|---|---|---|---|---|---|
| 设计 | `visitor-share-ui-design.md`（已有） | token/布局/状态 | `views/share/index.vue` + `ShareOtpCard.vue` | 访客按新视觉收码 | 改 `data-share-*` → e2e 全红且违反硬约束 |
| 样式 | scoped CSS + 包裹 class（改） | 新视觉 | 浏览器 | OTP 大字可复制 | 引入 Element Plus / 主 layout = 包体积+鉴权泄漏风险 |

最终 sink：访客页 OTP 区。  
必做验收：现有 `data-share-*` visitor specs 全绿；桌面 1280 与移动 390 视口对照设计卡（OTP 字号、复制全宽、token 色）。环境无 GUI 则渲染截图进 `/opt/cursor/artifacts/`，不得只靠钩子测试宣称 P5 完成。

#### 断链 / 孤儿产出 / 错误消费者（开工前必须封上）

| 风险 | 为何会断 | 封法 |
|---|---|---|
| V2=false 时批量被栅栏挡住 | 把「复用 V2」当成接线完成 | 批量分流：关则 N 条单分享，不开多 Binding |
| provision SQL 写在 mail-share-service | 循环 import 逼出第二写路径 | 下沉 `mailbox-provision.js`，add 与 create 共用 |
| account 先写 share 后失败 | 把 accountIds 当无副作用解析 | 预校验 + 同一 D1 batch |
| `emails` 后端收了、向导仍提交 `accountIds` | 页面入口没改，新字段无人调用 | 向导去掉下拉，spec 断言 body 含 emails 不含 accountIds |
| `emails` 向导发了、`createMailShare` 不转发 | 前端客户端白名单遗漏 | `CREATE_OPTIONAL_FIELDS` / 显式 emails 分支 |
| `liveEffectiveStatus` 只接到 ShareIndicator | 管理页模板仍绑 `row.effectiveStatus` | 五处展示面同一函数；模板 `data-status` 也走 live |
| 文档 404 做了、API 仍 200 JSON | 已打开的 SPA 继续画自定义不可用页 | `withShare` 真 404 + ShareGoneError |
| API 404 做了、文档仍 SPA | 用户直接贴 URL 仍见业务页 | `index.js` 拦截必须在 assets 之前 |
| 半成品 P1 模板/脚本不一致 | 先前未审代码留下的断链 | executor 按本卡收口，不以半成品为完成 |
| AC-VISIT-04 测试仍要求三种 lid 同文案 | 测试把旧契约当真理 | 拆：missing/revoked = 404；expired = unavailable SPA |

---

### 🧪 4. Test Boundaries (TDD Red)

先写失败测试再写实现。名称 = 业务场景。

**P1**

- 冻结时钟：`expiresAt` 已过、API 仍报 ACTIVE → 徽章/tag 显示 EXPIRED
- keep-alive 再激活：`onActivated` 会再调 `listMailShares`
- UTC：`YYYY-MM-DD HH:mm:ss` 按 UTC 解析，不按本地
- REVOKED 不被过期覆盖成 EXPIRED
- 改写 `ShareDialog.spec.js` 中「只渲染 API effectiveStatus、不重算」（旧 AC-LIFE-08 Owner 展示口径）

**P2**

- create `emails` 单地址 find-or-create 后插入分享（V2=false 必成功）
- V2=false 且 `emails.length>1` → N 条单分享、零多 Binding、同一 batch
- V2=true 且 `emails.length>1` → 一条 multi
- 未知域名 `SHARE_DOMAIN_NOT_CONFIGURED` 且零写入（含零新 account）
- 非法地址 `SHARE_EMAIL_INVALID` 零写入
- UNIQUE 竞态：后到同主复用，他人 FORBIDDEN
- 仅 `accountId` 的旧 ShareDialog 载荷仍成功（AC-CAP-10）
- 向导提交 `emails` 不含 `accountIds`；不再渲染 mailbox-select；多地址列出多链接
- 空 `emails` 不进入指纹

**P3**

- 创建出链接后关闭向导：**不**调用 `ElMessageBox.confirm`
- 提交中仍不可关闭（现有 submitting 锁保留）

**P4**

- 文档 GET/HEAD 缺行 → 404 空 body + `Cache-Control: no-store`
- 文档 GET `REVOKED` → 404；`EXPIRED` 仍 200 交给后续 SPA
- `POST /share/session` 及 mails/status/mail/attachment：gone → HTTP 404 空 body
- EXPIRED / 错 sec 仍 `SHARE_UNAVAILABLE` JSON
- e2e 真实导航：`visitor-unavailable.spec.js` 拆成过期 SPA / 销毁 404；missing 与 revoked 用 `page.goto` 断言 status 404、无 `[data-share-shell]`；`visitor-headers.spec.js` 对活链接测头；`visitor-revoke-live.spec.js` 销毁后落到原生 404 而非 unavailable shell
- DB 失败时文档拦截 fail-open（spy assets.fetch 仍被调用）且打出 `share.system.error` / `gone-check-failed`

**P5**

- 现有 `data-share-*` visitor specs 全绿（零钩子改名）
- 不引入 Element Plus 到 share chunk（既有入口拆分约束）
- 纯视觉：对照设计卡 token；桌面 1280 与移动 390 必做截图或 GUI 验收，不得只靠钩子测试收尾

≥3 边界（空数据 / 并发 / 超时）：未知域名整单失败；create 中途关窗仍锁；文档拦截 DB 异常 fail-open。

---

### 🛡️ 5. Anti-Corruption Layer & Registration

- 第三方 SDK：无。
- 域名解析收口 `configuredDomains(c)`，P2 创建路径必须走它。本期不强制改造 `account-service.add` 的 `.includes`（设置页加账号是另一条路径）；若 executor 顺手改四条 `.includes` 须单独回归登录/加账号，默认 **不扫射**，只保证分享创建不走子串匹配。
- **注册清单（缺一项 = 未接线）**：

| 项 | 动作 |
|---|---|
| create 白名单 | worker 消费 `emails`；V2=false 多地址走 N 条单分享响应 `shares[]` |
| provision 模块 | 新建 `mailbox-provision.js`；`account-service.add` 改为调用它（保留开关+Turnstile 包装） |
| Owner 客户端 | `CREATE_BODY_KEYS` / `createMailShare` / `hasFenceIntent`（仅多 Binding 为真） |
| 错误码 i18n | `SHARE_DOMAIN_NOT_CONFIGURED` / `SHARE_EMAIL_INVALID` 中英 |
| 向导 i18n | 完整邮箱/批量粘贴；删除关闭确认路径；多链接结果区 |
| 权限 | 不新开 perm；仍 `share:manage` |
| feature flag | 不新开；**不**把用户批量成功绑死在 V2=true；multi-Binding 仍 `SHARE_CAPABILITY_V2` |
| 路由 | 不新开前端路由；Worker fetch 增加 `/s/:lid` 分支 |
| 监控 | 不新开产品；gone 检查失败复用 `share.system.error`；正常 404 不打点 |
| spec | `mailbox-share-capability/design.md` API 表 dated changelog + deprecated；`mail-share` AC-VISIT-04 / AC-LIFE-08 Owner 展示口径 dated changelog |
| 测试矩阵 | 上节 Red 列表全部有名字 |

---

## 替代方案与停止条件

每条需求至少：沿用现状 / 局部调整 / 边界重构。推荐 = 局部调整（在现有 MailShare 上扩展）。

**P1**

| 方案 | 用户得到什么 | 成本 | 风险 | 可逆 |
|---|---|---|---|---|
| 沿用 | 仍要重登才看到过期 | 0 | 需求失败 | — |
| 去掉 email keep-alive | 再进收件箱必挂载，状态会新，但滚动/选中丢失 | 小 | 伤收件箱 UX | 易 |
| **推荐：live overlay + onActivated + tick** | 刷新/再进/停页都能看到过期 | 中 | 与旧 AC-LIFE-08 测试冲突，需改口径 | 易 |
| WebSocket 推送 | 实时但无现成通道 | 大 | 过度工程 | 难 |

停止：若有人要求「过期也写库成 EXPIRED」→ 停，那是状态机重构，超出本期。

**P2**

| 方案 | 用户得到什么 | 成本 | 风险 | 可逆 |
|---|---|---|---|---|
| 沿用账号下拉 | 仍必须先注册 | 0 | 需求失败 | — |
| 只改加账号表单为完整邮箱，向导仍选账号 | 少一步拼接，但仍要预注册 | 小 | 不满足「不需预注册」 | 易 |
| ~~在 mail-share-service 复制 SQL find-or-create~~ | 看似避开循环 import | 中 | **account 第二写路径**（DC-P0-2，已弃） | — |
| ~~多地址一律走 V2 栅栏~~ | 复用 AC-LIFE-11 | 小 | 生产 V2 默认 false，批量不可达（DC-P0-1，已弃） | — |
| **推荐：mailbox-provision 单真源 + 批量分流** | 单地址无条件成功；V2 关批量 = N 条单分享；V2 开 = 一条 multi | 中 | 结果区要能渲染 `shares[]`；不打开未激活 V2 | 中 |
| 无 account 虚拟邮箱 | 看起来更轻 | 大 | 收信/OTP 仍键 account = 第二真源 | 拒 |
| V2=false 仍写多 Binding | 批量也是一条链接 | 小 | 违反 AC-LIFE-11，旧 Worker 窗口不安全 | 拒 |

停止：若产品改为「分享未落地的地址、不建 account」→ 必须先改投递模型，本期拒绝。若有人要求「V2=false 也写多 Binding 一条链接」→ 停，与 AC-LIFE-11 互斥，批量已用 N 条单分享闭环。

**P3**

| 方案 | 结果 |
|---|---|
| 沿用 confirm | 与凭据可恢复 ADR 矛盾，用户已否决 |
| **推荐：删除关闭确认** | 关即走 |
| 连结果区一起改成「去详情看」 | 超出「删多余弹窗」 |

**P4**

| 方案 | 用户得到什么 | 风险 |
|---|---|---|
| 沿用 SPA unavailable | 自定义页，用户已否决 | — |
| HTTP 410 Gone | 语义更「永久删除」，但浏览器原生页不如 404 家喻户晓，用户点名 404 | 偏离原话 |
| **推荐：Worker 拦截 GET/HEAD → 404 空 body** | 原生 404；EXPIRED 仍 SPA | 打破 AC-VISIT-04 不可区分性（**有意**，changelog 记录） |
| 只改 SPA 成空白 | vite 能空白，生产仍 200 HTML | 假完成 |

停止：若安全要求「销毁与过期必须字节不可区分」复活 → 与用户 P4 互斥，必须问用户；**当前用户原话优先，不可区分性让路**。

**P5**：沿用旧皮 / 按设计卡改视觉（推荐）/ 换成 Element Plus（禁止，破入口拆分）。

---

## 生产业务场景推演

1. **典型**：Owner 在向导粘贴 `a@configured.com, b@configured.com` → 成功出链接 → 关掉结果区无第二弹窗 → 把链接发给访客 → 访客在新皮页复制 OTP。过期后 Owner 按 F5 或再点收件箱，徽章变过期。Owner 销毁后访客再打开，浏览器原生 404。
2. **复杂**：其中一枚邮箱域名未配置 → 整单失败、一条分享都没有、页面提示域名未配置。V2 关闭时粘贴两个已配置邮箱 → 得到两条单邮箱链接而非栅栏错误。ShareDialog 从当前已打开邮箱一键分享仍只发 `accountId`。两个 Owner 并发抢同一新地址 → UNIQUE 后复读，先到者建号，后到者若属他人则 FORBIDDEN。
3. **极端**：销毁后访客页已打开并在轮询 → API 404 → 单次 reload → 生产打到文档 404。DB 抖动时文档拦截 fail-open，活链接不误 404。keep-alive 收件箱停开一夜跨过 `expiresAt`，tick 把徽章翻成过期；后台冻结 tab 靠 focus/visibility 回源。
4. **错误消费者**：e2e 仍用未知 lid 当「200 测头」会红——那是测试契约要改，不是把 404 改回 200。

已知本轮不处理：后台冻结 interval 暂停（靠 visibility）；设置页加账号仍拼接；`account-service.add` 的 `.includes` 子串问题（非分享创建路径）；AuthKey 明文关闭后不可恢复（设计如此）。

---

## 架构判决

**边界成立，已按评审调整写边界后开发。** 不把 MailShare 拆成新服务；不把过期写成持久化状态；不在 SPA 里模拟 404；不在分享域复制 account SQL。P2 以 `mailbox-provision.js` 为唯一建号不变量；批量在 V2 默认关闭下改为 N 条单分享，不开多 Binding。P4 fail-open 保留，异常走既有 `share.system.error`。

---

## 开工前必核

1. 决策卡本轮 `artifact-decision-card` 评审已过筛；P0 三条已改方向（见 Update Log）。
2. 五条成功状态仍能用「不看代码的人」判真假；P2 批量在 V2=false 下的可见结果是 N 条单分享链接。
3. 链路表每个 `待建` 都有对应任务；每个 `已有` 有文件锚点。
4. 注册清单每一行有执行项；`mailbox-provision.js` 已列入。
5. P5 实现对照 `visitor-share-ui-design.md`，禁止改 `data-share-*`。
6. 工作区 P1 半成品：对照五面接线表收口；模板与脚本不一致视为未完成。
7. 不新建 charter；契约变更只追加 dated changelog。
8. P2 不把 `emails.length>1` 无条件挂 V2；P4 gone 检查失败打 `share.system.error`。

---

## 落地决定

**立即开发**（文档 P0 已改方向）。派 executor（Claude Fable 5）按本卡 TDD 实现。主调度不写生产代码。

实现顺序：P3 → P1（五面收口）→ P2（provision 模块 + 批量分流 + batch）→ P4（文档/API 404 + 浏览器导航验收 + SYSTEM_ERROR）→ P5。P2 与 P4 分 commit。

---

## 任务清单

- [x] DOC 决策卡补全 Goal→Outcome 并送 `artifact-decision-card` 审查
  - **Evidence**: verify: `review_spec.py --template artifact-decision-card --emit-prompt` → JSON ok · files: `share-fullchain-decision-card.md` + `prompt.round1.sub.txt` · AC: 3.5-lite · commit: pending
  - ✅ 2026-08-26: 用 skill 模板 F/H 送审，未自造评审清单
- [x] REV 过筛评审；P0 改方向写回本卡 Update Log
  - **Evidence**: verify: `--import-review` → NEEDS_CHANGES p0=3 p1=4 validation.ok · files: `share-fullchain-decision-card.review1.sub.md` · AC: 过筛后改方向 · commit: pending
  - ✅ 2026-08-26: 三条 P0 全部改方向（批量分流 / provision SSOT / D1 batch）
- [x] P3 删除创建后关闭确认弹窗
  - **Evidence**: verify: `pnpm -C mail-vue test` → 370 passed；e2e `owner-share-lifecycle` 关窗无 confirm → EXIT=0 · files: `ShareCreateWizard.vue` · AC: P3 · commit: fabe6e8
- [x] P1 Owner 过期状态 live SSOT + 五面接线（收口或重写半成品）
  - **Evidence**: verify: vue 370 passed；e2e 短 TTL 停页翻 EXPIRED → EXIT=0 · files: `status.js` `use-share-clock.js` 五面 · AC: P1 · commit: b365810
- [x] P2 `emails[]` + `mailbox-provision.js` + V2=false 批量 N 条单分享 + API 文档 deprecated
  - **Evidence**: verify: worker 854 passed（含 `mail-share-emails.spec.js`）；e2e 粘贴两地址出两条链接 → EXIT=0 · files: `mailbox-provision.js` `mail-share-service.js` 向导 · AC: P2 · commit: fabe6e8
- [x] P4 销毁/不存在 → 原生 404（文档+API+已打开 SPA+浏览器导航验收）
  - **Evidence**: verify: e2e visitor-unavailable/revoke-live status 404 空 body → 23 passed · files: `share-document-gone.js` `index.js` `share-auth-service.js` · AC: P4 · commit: d602ec6
- [x] P5 按 UI 设计卡改访客视觉（桌面+移动验收）
  - **Evidence**: verify: visitor specs 绿；截图 desktop 1280 / mobile 390 · files: `views/share/index.vue` `ShareOtpCard.vue` · AC: P5 · commit: e309ad4
- [x] SPEC shipped spec dated changelog（AC-VISIT-04 / AC-LIFE-08 Owner 展示 / create emails / 批量分流）
  - **Evidence**: files: `docs/specs/mail-share/*` `docs/specs/mailbox-share-capability/*` · commit: 82f330e
- [x] VERIFY 五条成功状态各至少一条真实入口→sink 验收；环境不可用必须写 Evidence 阻塞原因，禁止静默跳过 e2e
  - **Evidence**: verify: `pnpm -C mail-worker test` → 25 files / 854 passed；`pnpm -C mail-vue test` → 26 files / 370 passed；`SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs` → 23 passed · commit: 3706222

## Update Log

- 2026-08-26 · 初稿过薄（只写了 P2/P3/P4 边界，缺 Goal→Outcome / P1 / P5 / 替代方案 / 注册清单）。
- 2026-08-26 · 按工程 skill 3.5-lite 重写为本卡后送审。
- 2026-08-26 · spec-cross-review 模板 H：`--template artifact-decision-card` → SUB 读 skill+模板+emit-prompt，落 `share-fullchain-decision-card.review1.sub.md`。`--import-review`：NEEDS_CHANGES，p0=3，p1=4，validation.ok，锚点全部命中。
- 2026-08-26 · R1 · DC-P0-1 批量被默认关闭的 V2 截断 → **采纳（改方向）**：核实 `wrangler.toml` 仅注释声明、`isCapabilityV2Enabled` 缺省 false。单地址无条件成功；V2=false 批量改为 N 条单分享；禁止 V2=false 写多 Binding。
- 2026-08-26 · R1 · DC-P0-2 分享域复制 account SQL → **采纳（改方向）**：下沉 `mailbox-provision.js` 为唯一建号不变量。`addEmail`/Turnstile 仅包装设置页入口（用户「不预注册」是经批准差异，不是第二套规则）。**rejected 原建议里「先停工问用户 addEmail 是否全局禁写」**：用户原话已裁定分享创建不走预注册。
- 2026-08-26 · R1 · DC-P0-3 多步写入无原子性 → **采纳**：全量预校验 + 与现有 create 相同的 `c.env.db.batch()`（语句报错才回滚）+ UNIQUE 复读一次。
- 2026-08-26 · R1 · DC-P1-1 五面未逐条接线 → **采纳**：补五面接线表。
- 2026-08-26 · R1 · DC-P1-2 HTTP 中间态当完成 → **采纳**：Playwright 真实导航为 P4 必做验收。
- 2026-08-26 · R1 · DC-P1-3 fail-open 无观测 → **采纳（改法不同）**：不新开监控产品；复用已有 `logShareEvent` / `share.system.error`。
- 2026-08-26 · R1 · DC-P1-4 「能跑则 e2e」 → **采纳**：VERIFY 改为五条 sink 必做，跳过必须写 Evidence。
- 2026-08-26 · 落地决定改为 **立即开发**；P0 已在文档侧闭合。
- 2026-08-26 · executor 按审后正文 TDD 落地；主调度独立复跑 worker 854 / vue 370 / e2e 23 全绿后勾任务清单。
