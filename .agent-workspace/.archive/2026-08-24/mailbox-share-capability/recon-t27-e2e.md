# T-27 侦察 · E2E 新场景（W6 第一根横杠）

- 侦察时间：2026-08-24
- HEAD：`530ee79`
- 分支：`cursor/mailbox-share-capability-dcb6`
- 侦察员只读代码 + 只写本文件；未改任何生产/测试文件，未 commit / push。
- ponytail 强度：**lite**（照派单造，但每处都在一行内点名更懒的替代，由主 AI 裁）。

---

## 0. 一句话结论

三条迷雾全部有**代码级证据**可裁，且**不需要动任何生产文件、不需要动 `wrangler-e2e.toml`、不需要第二个 worker 二进制**：

- **Fog-1**：抄 `worker-entry.js:20/22-35/169-178` 已有的 `sessionTtlOverride` 形态，加一个同构的 `capabilityV2Override` + `/__e2e__/capability-v2` 控制端点，`/seed` 里跟着复位。V2 默认 false（= 生产默认），需要的用例显式打开。一次 `node tests/e2e/run.mjs` 同进程内两态共存。
- **Fog-2**：唯一正确的注入层是**浏览器侧 `route.fetch()` 之后 `route.abort('failed')`**。worker 侧做不出「响应丢失」——从 worker 里出来的任何东西（含 500）都是一个 `err.response`，会被 `isLostResponse` 判否、不触发同 key 重试。零 harness 改动。
- **Fog-3**：AC-LIFE-10 路径④**不是** e2e 的活。它的命题是「写入侧栅栏使不可执行策略压根落不了库」，已被 worker 集成/单测钉死；e2e 只欠一条「真 HTTP + 真 D1 下四路受限写入被拒且零行落库」的薄 spec + 一行指向 worker 测试的注释。**不造第二个 worker 二进制。**

---

## 1. 基线现实校正（派单说「13 个 spec」，实测口径不同）

| 项 | 实测 | 证据 |
|---|---|---|
| spec **文件** 数 | **12** | `tests/e2e/specs/*.spec.js` |
| `test(...)` **声明**数 | **14** | 12 文件里 `visitor-headers` / `visitor-session-ttl` / `visitor-no-third-party` 各 2 条 |
| 报告口径「E2E 13」 | **13 passed + 1 skipped** | `visitor-headers.spec.js:24` 在本地 wrangler assets 下 `test.skip(true, ...)`（`_headers` 不生效，注了 `deploy-time` annotation） |

**只增不减的准确含义**：12 个文件字节不动、14 条声明一条不改；新增只能是新文件 + `fixtures/share.js` / `harness/*` 的**追加**。T-28 的新基线应写成 `13+N passed / 1 skipped`，不要写成「13→N」。

无 `[[ratelimits]]` 绑定 → `shareRateLimit` fail-open（`share-rate-limit.js:56-58`），**新 spec 不必为 429 做退避**，连续建会话不会被限流打红。

---

## 2. Fog-1 · V2=true 与 V2=false 如何活在同一次 `node tests/e2e/run.mjs`

### 2.1 现状证据

- `wrangler-e2e.toml:23-36` `[vars]` 里**没有** `SHARE_CAPABILITY_V2` → `c.env.SHARE_CAPABILITY_V2 === undefined` → `isCapabilityV2Enabled` 返回 false（`mail-share-service.js:67-70`）。今天 e2e 全程 V2=false。
- T-26 实测时是用 `--var SHARE_CAPABILITY_V2:1` 命令行覆盖跑的（`exec-t26-note.md:67`），**没进 toml**，但那是一次性人工跑，不能进 `run.mjs`。
- `playwright.config.js:24-29` 只有**一个** `webServer`；`harness/start.mjs:11` 只有**一个** `--persist-to .mf-state`。两者都不是 per-project 的。
- **已有同构先例**：`worker-entry.js:20` `let sessionTtlOverride = null`、`:22-35` `envWithSessionTtl` Proxy、`:169-178` `POST /__e2e__/session-ttl`、`:164` `/seed` 里复位。`SHARE_SESSION_TTL` 与 `SHARE_CAPABILITY_V2` 都是「worker 从 `c.env` 读的字符串开关」，读取路径完全同构。

### 2.2 选项

| 选项 | 做法 | 判决 |
|---|---|---|
| **A（推荐）** | `worker-entry.js` 把 `sessionTtlOverride` 泛化成一个 `envOverrides` 对象（新增 `SHARE_CAPABILITY_V2` 一格），加 `POST /__e2e__/capability-v2 {on:true\|false}`，`/seed` 复位为 null。控制面 `control.setCapabilityV2(on)` | **采纳**。纯 harness 文件；toml 零改；默认态 = 生产默认 false;`world` fixture 每条用例先 `seed` → 每条用例都从 false 起步，忘记打开的用例会**红**而不是静默放行 |
| B | `start.mjs` 加 `--var SHARE_CAPABILITY_V2:1`，V2=false 用例反向关 | **否**。把 harness 默认态翻成 true，与生产默认相反；任何忘记关的用例静默放行，正是 AC-LIFE-11 最怕的失败模式 |
| C | 两个 project + 两个端口 + 两个 wrangler | **否**。`webServer` 是全局的（config:24），要改成两条 + 两个 `--persist-to`（否则 D1 文件锁打架），启动成本 ×2，且两套 D1 让 `world.seed` 的幂等假设分叉 |
| D | `run.mjs` 里跑两次 playwright（两组 env） | **否**。两份报告、两次 chromium 冷启；且 `reuseExistingServer` 会让第二次复用第一次的 worker，env 根本不会变 |

### 2.3 A 的精确切割线

`tests/e2e/harness/worker-entry.js`：

- `:20` `let sessionTtlOverride = null` → 旁边加 `let capabilityV2Override = null`
- `:22-35` `envWithSessionTtl(env)` → 改成一个 Proxy 同时应答两个 prop（`SHARE_SESSION_TTL` / `SHARE_CAPABILITY_V2`），`null` 即透传。**不要开第二个 Proxy**（两层 Proxy 会让 `:268` 的调用点变成 `envA(envB(env))`，排障时看不出谁盖了谁）
- `:164` `/seed` 的 `sessionTtlOverride = null` → 同行下加 `capabilityV2Override = null`
- `:169-178` `/session-ttl` 之后追加 `/capability-v2`（约 8 行，形状照抄）
- `:268` 调用点函数名跟着改（一处）

`tests/e2e/harness/control.js`：`:60` 返回对象里加 `setCapabilityV2(on)`（POST `/__e2e__/capability-v2`）。

**`wrangler-e2e.toml` 一个字节都不改** —— 让「缺省 = false」这件事本身成为 T-27.3 的被测事实。

> ponytail(lite)：更懒的替代是「让 V2 恒为 true，V2=false 的四路拒绝改用 vitest 覆盖」。否掉的理由不是偏好——派单 T-27.3 明写「`SHARE_CAPABILITY_V2=false` 下四路受限写入被拒」是 E2E 项（design.md:566 矩阵 AC-LIFE-11 = `I+E`）。

---

## 3. Fog-2 · 「服务端已提交、响应丢失」怎么注入（AC-SESS-10）

### 3.1 为什么 worker 侧做不出来（证据链，不是偏好）

要让访客页重试，必须让 `isLostResponse` 为真。它的判据（`index.vue:625-632`）是：`err` 存在 且 `!err.response` 且 非 429 / 非 SHARE_UNAVAILABLE / 非 SHARE_AUTH_REQUIRED 且（是 `Error` 或没有自有 `code`）。

- worker 返回 500 / 503 / 空 body：axios 都会填 `err.response` → 判否 → **不重试**。
- worker 抛异常：wrangler 仍回 500 → 同上。
- worker 返回 `{code:501,...}` 业务信封：`share.js:147` reject 一个纯对象且自带 `code` → 判否 → **不重试**。

所以「响应丢失」在语义上只能发生在 **worker 之外、浏览器之内**的那一段。这不是分层洁癖，是 `isLostResponse` 的字面判据。

### 3.2 唯一正确、且最小的注入

```
page.route('**/api/share/session', async (route) => { ... })
  第 1 次：const res = await route.fetch()   // 真发到 worker：条件 UPDATE 已提交、KV 已写
           firstBody = await res.json()      // 顺手留证：第一次签发的 token
           await route.abort('failed')       // 浏览器只看到传输失败
  第 2 次起：await route.continue()
```

证据：`playwright-core@1.55.0` `types.d.ts:20978` —— `route.fetch()` 「Performs the request and fetches result **without fulfilling it**」，即 route 仍是未处置状态，随后 `abort()` 合法（不会触发 "route is already handled"）。

`route.fetch()` 默认原样带上原请求头，**包含 `Idempotency-Key`**（`request/share.js:168-170` 写在 `config.headers`）→ 第一发与重试同 key。

服务端侧这条路径已就绪、零改动：`share-auth-service.js:532-538` 的重放查询**排在**配额快照检查（`:544` `denyQuota`）之前，源码注释就写着「a max_sessions=1 first success leaves the snapshot ACCESS_LIMIT_REACHED，把 denyQuota 放前面会拒掉 AC-SESS-10 要救的那次重试」。TTL 侧也安全：`DEFAULT_SESSION_TTL=900`（`:21`）≥ `KV_MIN_TTL=60`（`:29`）→ `writeReplayCache` 一定会写（`:483`）。miniflare 本地 KV 单实例、无跨 PoP 传播窗口。

### 3.3 因此可断言的四条（全部可观测）

1. `POST /share/session` 恰 **2** 次（`page.on('request')` 计数）。
2. 两次的 `Idempotency-Key` 请求头**相等且非空**（`req.headerValue('idempotency-key')`）。
3. ready 后 `sessionStorage['share:session:<lid>']` **等于** `firstBody.data.sessionToken`（第一次那个被丢掉的 token 又回来了 = 真重放，不是重新签发）。
4. `GET /api/mailShare/get?shareId=` → `usedSessions === 1`。

**不需要**任何 harness 端点。R5（`exec-t26-note.md:91`）到此复核完毕：真实 axios 传输失败是 `AxiosError`（`instanceof Error` 为真、无 `response`）→ 判为丢响应，与单测两侧一致。

---

## 4. Fog-3 · AC-LIFE-10「随机路由新旧 Worker」是不是 e2e 的活

### 4.1 命题本身

requirements.md:198 路径④原文：「开关 false 期间 SHALL **不存在**任何旧 Worker 无法执行的已写入策略（AC-LIFE-11 拒绝写入），故 SHALL NOT 出现『新代码启用 AuthKey/有限配额/多 Binding，请求落旧 Worker 被绕过』的策略降级路径。」

这是一条**写入侧全称否定**：要证的是「库里没有这类行」，不是「旧 Worker 跑起来是什么样」。design.md:230 同义：「验收注入：V2=false 下四路受限写入全部被拒 + 随机路由新旧 Worker 混跑不产生策略差异」——后半句是前半句的**推论**，不是独立实验。

### 4.2 已有覆盖（不重复造）

| 断言 | 位置 |
|---|---|
| V2=false 下 multi create + bindings 1→N 被拒、`mail_share` / `mail_share_binding` 零行 | `test/share-integration.spec.js:1148-1167` |
| V2=false 下 resetAuthKey `enable` 被拒、`disable` 放行 | `test/share-integration.spec.js:1486` |
| 绕过 AUTH_KEY_ENABLE 栅栏的 enable = 随机路由绕过第二因子（注释即命题） | `test/mail-share-service.spec.js:3096` |
| `create under SHARE_CAPABILITY_V2=false` 全套 | `test/mail-share-service.spec.js:1224-1288` |
| 第五条 `message_limit` 的同构理由 | `test/mail-share-service.spec.js:1290` |
| 栅栏函数真值表（`'1'/1/true/'true'` 放行，其余拒） | `test/mail-share-service.spec.js:1289-1324` |
| 双写主 Binding / 绝不写 0（路径①②③） | `mail-share-service.spec.js:526-621` · `v3-2-db.spec.js:40,265` · `mail-share.schema.spec.js:142` |

仓库里**只有一个 worker 入口**（`mail-worker/src/index.js`，`worker-entry.js:1` 直接 import 它）。造「旧 Worker」需要从迁移前 commit 另建一份构建产物 + 第二个 wrangler 进程 + 一个随机分流器——派单明令禁止，且它验证的是一个**已被写入侧栅栏消解**的路径。

### 4.3 裁决建议

e2e 只做**薄的一层**：一个 `capability-v2-fence.spec.js`，在真 HTTP + 真 D1 上跑四路受限写入（V2=false），断言四条都回 `SHARE_INVALID_CONFIG` 且**没有任何行落库**；翻成 V2=true 后同样四条放行（AC-LIFE-11 的「WHEN 开关置 true 放行」半句）。文件头一行注释指向 §4.2 的 worker 测试，写明「路径④由写入侧栅栏消解，本仓库无第二个 worker 二进制，不在 e2e 造」。

> 第五条 `message_limit`（`SHARE_V2_INTENT.MESSAGE_LIMIT`，`mail-share-service.js:36`）在 requirements AC-LIFE-11 里是⑤，在 tasks/design 里被叫作「四路」。建议**只按派单断言四路**，第五条以一行注释点名存在即可——多断一条不算错，但改动派单口径需要主 AI 点头。

---

## 5. 可执行文件清单（含切割线）

### 5.1 新建 spec（6 个，全部新文件，既有 12 文件零改）

| # | 文件 | 覆盖 | 归属 |
|---|---|---|---|
| 1 | `tests/e2e/specs/visitor-multi-mailbox.spec.js` | AC-OTP-04 · AC-SEC-01（+AC-CAP-02 / AC-OTP-07 顺带） | T-27.1 |
| 2 | `tests/e2e/specs/visitor-session-quota.spec.js` | AC-SESS-04 · AC-SESS-07 | T-27.2 |
| 3 | `tests/e2e/specs/visitor-session-replay.spec.js` | AC-SESS-10 | T-27.2 |
| 4 | `tests/e2e/specs/visitor-revoke-live.spec.js` | AC-EDGE-03 | T-27.3 |
| 5 | `tests/e2e/specs/visitor-authkey.spec.js` | AC-AUTH-01 **+ AC-SEC-09** | T-27.3 |
| 6 | `tests/e2e/specs/capability-v2-fence.spec.js` | AC-LIFE-11 + AC-LIFE-10 路径④（薄） | T-27.3 |

> ponytail(lite)：AC-SEC-09 可以另开第 7 个文件求 traceability 整齐。**不建议**——AuthKey 流是全仓唯一一处 `sec` / authKey 明文 / sessionToken 三种凭据同时在场的时刻，泄露审计放在别处只能审到其中两种。标题里同时写 `AC-AUTH-01, AC-SEC-09` 即可。

### 5.2 `tests/e2e/harness/worker-entry.js`（切割线见 §2.3，另加 seed）

- `:132-137` 第二个 account：照抄第一个的 `SELECT … / INSERT … RETURNING account_id` 幂等形状，邮箱 `MAILBOX_2`
- `:147` return 追加 `accountId2` / `mailbox2` —— **`accountId` / `mailbox` 两个既有键名与值一个字节不动**

### 5.3 `tests/e2e/harness/control.js`（`:60` 返回对象内追加，既有方法零改）

| 新增 | 用途 |
|---|---|
| `api` （把内部 `api(method, path, opts)` 原样导出） | 栅栏 spec 要断言**错误信封**，而现有方法一律 `throw` |
| `setCapabilityV2(on)` | Fog-1 |
| `getShare(seed, shareId)` | `usedSessions` 观测（§7） |

**`createShare` 不动**：`:106-110` 的默认体保留 `accountId: seed.accountId`，`...body` 在后 → 新用例传 `{ accountIds: [a, b] }` 时 `toAccountIdSet`（`mail-share-service.js:188-190`）优先取 `accountIds`，两键并存无害；既有 12 文件的调用形状零变化。

### 5.4 `tests/e2e/harness/constants.js`（`:8` / `:11` 旁追加）

`MAILBOX_2 = 'e2e-box-2@example.com'`（必须同 `domain = ["example.com"]`）、`OTP_CODE_2 = '135790'`（两个盒子的码要能区分，否则多邮箱 spec 的 OTP 断言分不清是哪个 Tab 的）。

### 5.5 `tests/e2e/fixtures/share.js`（`:45` `sessionKeys` 之后追加，`:1-45` 与 `:47-63` 零改）

| 新 helper | 一句话 |
|---|---|
| `newVisitor(browser)` | `browser.newContext({ serviceWorkers: 'block' })` + `newPage()`，第二个隐身窗口（返回 `{context, page}`，用例负责 `close`） |
| `dropFirstResponse(page, urlGlob)` | Fog-2 的 route 拦截，返回 `{ firstBody, count }` |
| `recordApiRequests(page)` | 收集 `/api/` 请求的 `{url, headers}`，供 AC-SEC-09 审计 |

**`test` / `openShare` / `waitShareState` / `sessionKeys` / `hideTab` / `showTab` / `OTP_CODE` 七个既有导出一律不动。**

### 5.6 `tests/e2e/README.md`

追加控制端点一行（`/__e2e__/capability-v2`）。这是 T-27 唯一允许碰的 md。

### 5.7 生产文件

`mail-vue/**`、`mail-worker/**`、`wrangler-e2e.toml`、`run.mjs`、`playwright.config.js` —— **零改动**。侦察未发现任何「harness-only 文件必须改生产」的情形。

---

## 6. seed 要长什么（且不打破既有 12 文件）

现状 `seedOwner`（`worker-entry.js:121-148`）建 1 个 user + 1 个 account（`MAILBOX`），返回 `{userId, accountId, ownerJwt, mailbox, ownerEmail}`。

要加的只有一条：**同一个 `userId` 名下第二个 account**（`MAILBOX_2`），幂等形状照抄第一个（先 SELECT 再 INSERT —— `--persist-to .mf-state` 让 D1 跨 run 存活，非幂等会在第二次跑时 UNIQUE 撞库）。

不打破既有的四条理由（逐条核过）：

1. **返回值只增键**：`accountId` / `mailbox` 名与值不变；既有 spec 只读这两个（`createShare(seed)` 默认体）。
2. **既有分享仍是单 Binding**：`createShare` 默认只传 `accountId` → `bindings.length === 1` → `isMulti` 为 false → `[data-share-tabs]` 不渲染（`index.vue:81`），既有 spec 的 DOM 断言不受影响。
3. **投递默认不变**：`/__e2e__/email` 的 `to` 缺省仍是 `MAILBOX`（`:182`），第二个盒子必须显式 `injectEmail({ to: MAILBOX_2 })`。
4. **入站不会被拒**：`email.js:73` 对 `env.admin`（= `OWNER_EMAIL`）名下账号跳过 role/domain 校验，第二个 account 同属该 user → 不走 `:78` 的 reject 分支。

风险点一条：`harness-email-path.spec.js` 按 `to_email` 取最新行（`worker-entry.js:212-218` 的 SQL 本就带 `WHERE to_email = ?`），两个盒子互不干扰。

---

## 7. `used_sessions` 怎么观测

**推荐：`GET /api/mailShare/get?shareId=<id>` + `Authorization: seed.ownerJwt`**，读 `data.usedSessions`。

- 路由：`mail-share-api.js:35-38` → `mailShareService.get` → `loadOwnerDetail`（`mail-share-service.js:514-526`）
- 字段：`projectOwnerRow` 同时给 `accessCount` 与 `usedSessions` 两个键（`:440-443`，注释写明 `usedSessions` 是 `access_count` 的 DTO 别名）
- 落地：`control.getShare(seed, shareId)` 一个方法，复用现成的 `api()`（`control.js:34-58`），**零新 harness 端点**

配额耗尽后依然可读：`loadOwnerDetail` 的谓词只有 `share_id + user_id`，不带 ACTIVE（`:511-513` 注释即为此），所以 `ACCESS_LIMIT_REACHED` / `REVOKED` 行都取得到。

否掉的替代：新开一个 `/__e2e__/share-row` 直读 D1 `access_count`。它断言的是物理列而不是 Owner 面契约，多一个端点还少一层覆盖。

---

## 8. 成功状态 → 断言（逐条落到可观测面）

### 8.1 多邮箱访客页（spec 1，V2=true）

`setCapabilityV2(true)` → `createShare(seed, { accountIds: [accountId, accountId2] })` → **全新 context**（never-logged-in）→ `openShare` → `ready`。

| 成功状态 | 断言 |
|---|---|
| 原生 Tab | `[data-share-tabs]` 存在、`[data-share-tab]` 计数 2、`aria-selected="true"` 恰 1 |
| 切 Tab | 点第二个 `[data-share-tab]` → 该 tab `aria-selected="true"` |
| 真投递验证码邮件 | 先 `ready` 再 `injectEmail({ to: MAILBOX_2, code: OTP_CODE_2 })`（顺序见下） |
| OTP 复制 | `[data-share-code]` 含 `OTP_CODE_2` → 点 `[data-share-copy]` → `[data-share-copy-result]="copied"` → `navigator.clipboard.readText()` 相等 |
| 角标出现 | 停在 Tab A，往 B 投递 → 下一拍 `[data-share-tab-badge]` 计数 1 |
| 角标消费 | 点 B → `[data-share-tab-badge]` 计数 0 |
| AC-SEC-01 | `page.url()` 不含 `#`、不含 `accountId` / `accountId2` 的十进制串、不含两个邮箱地址的任何一段 |

**投递顺序是硬约束**：`reconcile`（`status-watermark.js:70-86`）在首帧把每个 Binding 的水位**播种到当前队头**，注释明写「so the visitor is not badged for mail that arrived before they opened the page」。ready 之前投的邮件**不会**产生角标。角标断言必须发生在 `ready` 之后。

`context` fixture 已带 `clipboard-read/write` 权限（`fixtures/share.js:14-21`）；若本 spec 用 `newVisitor` 另开 context，**要么**复用 fixture 的 `page`（推荐，它本来就是「从未登录的浏览器」），**要么**在 `newVisitor` 里补权限。

### 8.2 配额耗尽（spec 2，V2=true）

`createShare(seed, { maxSessions: 1 })`（有限配额受栅栏，`mail-share-service.js:361-363`）→ 访客 1 `ready` → `getShare().usedSessions === 1` → `newVisitor(browser)` 打开同链接 → **`unavailable`**（`denyQuota` → `throwUnavailable`，`share-auth-service.js:416-419`；前端 `bootstrap` catch → `noteShareFailure(err, true)` → `showDeadShare`）→ `usedSessions` 仍为 1（拒绝零消耗）→ 隐身页 sessionStorage 无 `share:session:` → 访客 1 的页面**仍是 ready**（配额耗尽不杀已签发会话）。

### 8.3 丢响应重放（spec 3，V2=true）

见 §3.3 四条。`maxSessions: 1`，`dropFirstResponse(page, '**/api/share/session')`。

### 8.4 浏览中撤销（spec 4，V2 无关，默认 false 即可）

`ready` → `world.api.revokeShare(seed, shareId)` → 等下一拍。

| 断言 | 说明 |
|---|---|
| `state = unavailable` | — |
| 停轮询 | 到达 `unavailable` **之后**再记 `/api/share/` 请求数，等 `POLL_INTERVAL_MS + 1500` → 恰 0。**不要**从测试开头计数 |
| 清 `share:session:<lid>` 与 `share:est-key:<lid>` | `sessionKeys(page)` 两者都不含 |
| 同一个不可用外壳 | 另开一页 `/s/not-a-real-lid#x` 取 `[data-share-shell]` innerText 作基线，两串相等（照抄 `visitor-unavailable.spec.js:14,29-30` 的手法，**不硬编码英文**） |

**已知的一次额外 POST**：`recoverFromUnavailable`（`index.vue:734-755`）在 `pageSecret` 仍在时会先试一次 `reestablishSession()`，该请求也会拿到 `SHARE_UNAVAILABLE` 后走 `showDeadShare`。所以撤销后到 `unavailable` 之间会多一次 `POST /share/session`，这是 T-26 已冻结的语义，**不是 bug，不许为它改生产**。

`share:status:<lid>` **必须仍在**（T26-STATUS HOLD，`exec-t26-note.md:100` / `recon-t26-session.md §7.3`）。建议顺手写一条正向断言把这条红线钉住。

### 8.5 AuthKey 流 + 凭据泄露审计（spec 5，V2=true）

`createShare(seed, { authKeyEnabled: true })` → 响应里 `authKey` 明文恰一次（`mail-share-service.js:1146,539-541`）→ 打开 → `authRequired`。

| 步 | 断言（全部走 T-26 冻结钩子） |
|---|---|
| 错 Key | `[data-share-auth-input]` fill 错值 → `[data-share-auth-submit]` click → 仍 `authRequired`、`[data-share-auth-error]` 可见 |
| 错 Key 零配额 | `getShare().usedSessions === 0`（AC-AUTH-01 的核心半句：SHALL NOT 消耗配额） |
| 对 Key | fill 真 key → `ready` |
| est-key 生命周期 | `authRequired` 期间 `share:est-key:<lid>` **在**；`ready` 后**不在** |
| AC-SEC-09 | `recordApiRequests` 收全程请求：任何 URL（含 query）不含 `sec` / `authKey` / sessionToken；任何请求头（含 `Referer`）不含三者；`Idempotency-Key` 头**允许**存在（它不是凭据） |
| 内存不落盘 | `sessionKeys(page)` 不含任何值等于 `sec` 或 `authKey` 的键（`index.vue:267-268` 明写 authKey 只在内存） |

日志侧的「无 sec/authKey/token」不在 e2e 做：wrangler 子进程是 `stdio: 'inherit'`（`start.mjs:31`），playwright 拿不到它的 stdout。那半句由 worker 侧的 `logShareEvent` 单测承担（`mail-share-service.js:86-96` 只放行诊断字段）。spec 里写一行注释指过去。

### 8.6 V2 栅栏（spec 6）

V2=false（seed 后的默认态，**显式**再 `setCapabilityV2(false)` 一次以自述意图）：

| 路径 | 调用 | 期望 |
|---|---|---|
| ① multi create | `POST /mailShare/create {accountIds:[a,b]}` | `SHARE_INVALID_CONFIG`，且随后 `GET /mailShare/list` 不含该 name |
| ② bindings 1→N | 先建单邮箱，再 `PUT /mailShare/bindings {shareId, add:[b]}` | `SHARE_INVALID_CONFIG`，`get().bindings` 仍 1 条 |
| ③ AuthKey 启用 | create `{authKeyEnabled:true}` 与 `POST /mailShare/resetAuthKey {action:'enable'}` 两处 | 均 `SHARE_INVALID_CONFIG`；`disable` 不在本条 |
| ④ 有限 maxSessions | create `{maxSessions:1}` 与 `PUT /mailShare/update {maxSessions:1}` 两处 | 均 `SHARE_INVALID_CONFIG` |
| 反向 | `setCapabilityV2(true)` 后四路各跑一次 | 全部 `code === 200` |

要点：`api()` 返回信封而不抛（`control.js:34-58`），错误码读 `out.json.message`（`share-result.fail(err.message, err.code)`，`share-api.js:34`；Owner 面同构）。断言「零行落库」用 `GET /mailShare/list` 的 `total`，**不要**新开 D1 探针。

---

## 9. i18n · T-27 不写 `zh.js` / `en.js`

- W5 遗留 **10 个**未落盘键（T-25 的 `shareVisitMailboxes` / `shareVisitNewMail` + T-26 的 8 个，`exec-t26-note.md:88`），全部走 `tx(key, English fallback)`（`index.vue:286-288`）。归 T-29。
- **对 T-27 的直接约束**：新 spec **禁止**断言任何界面文案字面量。理由不是洁癖——T-29 一旦把这 10 个键写进 `zh.js`/`en.js`，`te(key)` 转真，`tx` 就会返回 i18n 值而非英文回退，任何硬编码英文断言当场变红，而那时 T-29 无权改 e2e。
- 允许的文本断言只有两类：① 页面文本**与页面文本**相比（`visitor-unavailable.spec.js:29-30` 的手法）；② 来自数据的值（`OTP_CODE` / 邮箱地址 / 主题行）。
- 其余一律断 `data-*` 钩子、`aria-*`、元素计数、`sessionStorage` 键、请求账本。
- 另注：`applyShareLocale`（`index.vue:290-294`）按 `navigator.language` 选 zh/en。playwright `devices['Desktop Chrome']` 不设 locale → `en-US` → 走英文分支。**新 spec 不许改 `playwright.config.js` 的 locale**。

---

## 10. T-28 / T-29 不得侵占

| 谁 | 禁止 | 理由 |
|---|---|---|
| T-28 | 新增 / 修改 `tests/e2e/**` 任何文件 | T-28 是纯复跑 checkpoint（tasks.md:613）。新 spec 若在 T-28 手里发飘，**退回 T-27**，不许就地改断言把它调绿 |
| T-28 | 把基线写成「13」 | 新基线 = `13+N passed / 1 skipped`；`visitor-headers` 的 skip 是本地 assets 的既有事实，不是回归 |
| T-28 | 动 `wrangler-e2e.toml` / `start.mjs` 让某条 spec 好过 | 见 §2.3 |
| T-29 | 碰 `tests/e2e/**` | T-29 的清单（tasks.md:615-618）只有 ADR / spec front-matter / i18n / README / CHANGELOG / tech-debt |
| T-29 | 落 10 个 i18n 键后不复跑 e2e | 落键会改变 `tx` 的返回分支（§9）。必须复跑；若红，是 T-27 违反了「禁断文案字面量」，退回 T-27 |
| T-29 | 把 R1 存 token 复活路径的 config 降级当成 e2e 缺陷 | Fog-3 已裁接受，T-29 只**登记为已知限制**（`exec-t26-note.md:87`） |
| 任何人 | 把 `SHARE_CAPABILITY_V2` 写进 `mail-worker/wrangler.toml` | tasks.md:642 gate：置 true 是部署动作，不在本清单任何任务内 |

---

## 11. 冻结物复核（T-27 只消费，不改语义）

逐条对照 `exec-t26-note.md §6`，本侦察方案的消费面：

| 冻结物 | T-27 怎么用 |
|---|---|
| `[data-share-auth]` / `-input` / `-submit` / `-error` | spec 5 直接选，零改 |
| `[data-share-refresh]` / `[data-share-expires]` | 本轮不必断言（T-26 已在真浏览器验过）。要断也只读，不改 |
| `[data-share-state]` / `[data-share-code]` / tablist 钩子 | 沿用 `waitShareState`，零改 |
| `postSession` 是 `POST /share/session` 唯一出口 | Fog-2 的 route 只拦这一个 URL，因此拦得全 |
| `share:est-key:<lid>` 四时刻生命周期 | spec 5 断言「authRequired 期间在 / ready 后不在」，只观测 |
| `clampInterval` 下限 = `POLL_INTERVAL_MS` | 新 spec 沿用 `POLL_INTERVAL_MS + 1500` 的等待口径（`visitor-background-poll.spec.js:20` 已是此形） |
| `useSharePolling` 无 `autoStart`/`listStatus`/`mode` | 不碰 |
| **不发明第二条轮询路径** | 手动刷新与轮询共用 `pollTick`（`index.vue:409-426`）；spec 不为「取数」另走 `control.listMails` 冒充页面行为 |

P1-4 HOLD（外来 bindingId 停在空页）与 Fog-3 存 token 降级：本方案任何一条 spec 都不触及，无需重开。

---

## 12. 遗留风险 / 交接

| # | 风险 | 处置 |
|---|---|---|
| R1 | `route.fetch()` 之后 `abort()` 在 1.55.0 上的实际行为 | 类型文档明写 "without fulfilling it"（§3.2），但**实现期第一件事就是把这条跑通**再写其余断言。若真被拒（"already handled"），退路是 `route.fetch()` 后 `route.fulfill({ status: 599, body: '' })` —— **但那会给出 `err.response`，`isLostResponse` 判否、不重试**，等于 AC-SESS-10 在 e2e 无解，届时必须回主 AI 重裁，不许改 `isLostResponse` 迁就测试 |
| R2 | 角标 spec 对轮询节拍的时序依赖 | 水位首帧播种（§8.1）决定了「先 ready 再投递」；`expect` 超时 15s、轮询 3s，余量足够，但**不要**把投递和 `waitShareState` 并发 |
| R3 | 模块级 `capabilityV2Override` 是进程内全局态 | `playwright.config.js:6-7` `fullyParallel:false` + `workers:1` → 无并发。**若将来有人开并行，这个开关是第一个炸的东西**，README 里写一行 |
| R4 | `.mf-state` 跨 run 存活 | 第二个 account 必须幂等建（§6）；`setCapabilityV2` 是内存态、不落 D1，重启即 false，安全 |
| R5 | AC-SEC-09 的「日志采样」半句 | e2e 拿不到 wrangler stdout（§8.5），由 worker 侧承担。spec 注释指过去，不假装覆盖 |

---

## Update Log

- 2026-08-24 · 侦察落地。Fog-1 建议选项 A（harness env override，toml 零改）；Fog-2 判定唯一正确注入层为浏览器侧 `route.fetch()` + `abort()`；Fog-3 判定路径④非 e2e 职责，只留薄栅栏 spec + 指针。执行文件：6 新 spec + `worker-entry.js` / `control.js` / `constants.js` / `fixtures/share.js` / `tests/e2e/README.md` 追加，生产零改。

## 13. 主 AI 裁决（Fog 已裁 · 禁止重开）

| ID | 裁决 | 依据 |
|---|---|---|
| Fog-1 | **CHANGE A**：`capabilityV2Override` + **同一个** Proxy（扩 `envWithSessionTtl` 的 early-return：两 override 都 `null` 才透传）+ `POST /__e2e__/capability-v2` + `/seed` 复位。`wrangler-e2e.toml` / `start.mjs` / `playwright.config.js` / 生产 `wrangler.toml` **零改**。`setCapabilityV2(true)` 写 `'true'`，`false` 写 `'false'`（不要用 `null` 表示关，以免与「未覆盖」混淆）。 | `worker-entry.js:20-35,164,268` 已有同构先例；`isCapabilityV2Enabled` 认 `'true'`/`'1'`（`mail-share-service.js:67-70`）。否 B/C/D：默认翻 true 会让忘关的用例静默放行；双 project 撞 `.mf-state`；`reuseExistingServer` 让第二次跑不到新 env。 |
| Fog-2 | **CHANGE**：浏览器侧 `route.fetch()` 再 `route.abort('failed')`。**零 harness 端点**。实现期**第一件事**把这条跑通再写其余断言。若抛 "already handled" → **停下来报主 AI**，禁止改 `isLostResponse`，禁止 `fulfill({status:599})`（那会给 `err.response`，重试不会发生 = AC-SESS-10 在 e2e 无解）。 | `isLostResponse` 字面要求 `!err.response`（`index.vue:625-632`）；Playwright 文档：`fetch()` performs without fulfilling。`postSession` 只重试一次（`:637-646`）。 |
| Fog-3 | **CHANGE**：AC-LIFE-10 路径④不是 e2e 的活。e2e 只留薄 `capability-v2-fence.spec.js`：真 HTTP+真 D1 上**四路**（派单口径，不含 `message_limit`）V2=false 拒且零行落库，V2=true 放行。文件头注释指向 `share-integration.spec.js:1148` 等 worker 测试。**不造第二个 worker 二进制。** | 命题是写入侧全称否定，已被 worker 测试钉死；仓库只有一个 `index.js` 入口。 |
| T27-BASELINE | **CHANGE**：既有是 **12 个 spec 文件 / 13 条 `test()`**（仅 `visitor-session-ttl` 含 2 条）。侦察写的「14 条」不成立（`visitor-headers` / `visitor-no-third-party` 各 1 条）。最近一次主 AI 复跑是 **13 passed**。既有 12 文件字节不动。T-28 新基线 = 当时 `run.mjs` 打印的 passed/skipped，不要预先写成「13→N」。 | `tests/e2e/specs/*.spec.js` 实数；`t26_postcommit_verify.log` EXIT_E2E=0「13 passed」 |
| T27-FOUR | **HOLD**：栅栏 spec 只断派单四路，第五条 `message_limit` 一行注释即可。 | tasks.md T-27.3 原文「四路」 |
| T27-API | **CHANGE**：`control.js` 把内部 `api()` 导出，供栅栏 spec 读错误信封。不要为每个错误码再包一层。 | ponytail；现有 `createShare` 非 200 即 throw，不能用来断言拒绝 |
| T27-COPY | **HOLD**：多邮箱 OTP 复制走 `ShareOtpCard` 的 `[data-share-copy]` / `[data-share-copy-result]="copied"`，不断文案字面量。 | `ShareOtpCard.vue:12,29` |

硬约束（执行不得违反）：
- `mail-vue/**`、`mail-worker/src/**`、`mail-worker/wrangler.toml`、`wrangler-e2e.toml`、`run.mjs`、`playwright.config.js`、既有 12 个 spec 文件 **零改**。
- 新 spec **禁止**断言界面文案字面量（T-29 落 i18n 会打红且无权改 e2e）。
- 不重开 T-26 Fog-3（存 token 降级）/ T26-STATUS / T-25 P1-4。
- `SHARE_CAPABILITY_V2` 生产缺省保持 false。

