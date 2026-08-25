# T-20b2b · 查看链接端点(`POST /mailShare/revealSec`)

执行者:executor · 2026-08-25 · 基线 HEAD `3a3346a`(后端 19 files / 716 passed)

## 成功状态(逐字抄自交付契约,未改写)

> NOT「加了个返回明文的接口」, BUT 管理员在详情页点「查看链接」,能拿回这条分享当初创建时的那条完整链接;而当它取不回时,他看到的是一句能据以行动的话——「这条创建于功能上线前,可以重新生成」和「服务配置异常,请联系管理员」是两件不同的事,不能混成一句。
> 不该发生: 别人的分享被解出来 · 解密调用不留痕 · 部署事故被伪装成正常降级。
> 来源: ADR-share-credential-recoverability 轨一 · 决策卡 §1.4 四类失败表

### 链路逐格核实

| 节点 | 契约写的 | 核实结果 |
|---|---|---|
| 端点 | `POST /mailShare/revealSec` 待建 · `security.js` 权限双表待改 | 已建 `mail-share-api.js:74-81`;`security.js:82`(`requirePermsExact`)+ `:124`(`premKey['share:manage']`)双表同步 |
| 解密 | `decryptShareSec(env,{shareId: lid, envelope})` 已就绪 | 已就绪,未改动。**AAD 绑 `lid` 已核实**:写入侧 `mintShareCredentials`(`mail-share-service.js:1247`)传的是 `shareId: lid`,读取侧照传 `row.lid` |
| 审计 | 每次调用记事件 待建 | `SHARE_EVENT.SEC_REVEAL = 'share.sec.reveal'`(`share-event.js:11-14`),经统一出口 `logShareEvent`,`requestId` 自动带上 |
| 最终 sink | 管理台详情页(下一包) | 后端契约已定,错误码清单见下 |

**真跑过的 e2e**:`owner API surface for revealSec` 三条 —— HTTP 建分享 → HTTP 调 revealSec → `shareUrl` 逐字相等;另一 owner 调同一 `shareId` → `SHARE_NOT_FOUND`。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/service/mail-share-service.js` | 抽出 `shareUrlOf()`(create/regenerate/reveal 三处共用的链接拼装点)· 新增 `REVEAL_FAILURE` 映射表 + `loadShareCipher()` + `mailShareService.revealSec()` |
| `src/api/mail-share-api.js` | 新增路由 + `ownerRevealRateLimit()`(按 userId 计的 owner 侧限流) |
| `src/security/security.js` | `requirePermsExact` 与 `premKey['share:manage']` 各加一条 |
| `src/service/share-event.js` | 新增 `SEC_REVEAL` 事件名 |
| `wrangler.toml` | 新增 `[[ratelimits]] SHARE_REVEAL_RATE_LIMITER`(namespace_id 92603 · 20/60s) |
| `test/mail-share-service.spec.js` | 新增两个 describe(15 条)+ 事件名清单补一行 |
| `test/security-share.spec.js` | `OWNER_ENDPOINTS` 加一条(带动 11 条参数化用例) |

## 裁决:过期 / 已撤销的分享**可以**查看链接

**结论:允许,不设活跃状态门。** 归属校验走 `loadOwnerDetail` 的谓词(`share_id + user_id`),不是 `loadMutableShare` 的 `ACTIVE AND expires_at > now`。

理由三条,缺一条我就会选相反方向:

1. **取回的链接确实不可用。** 访客侧 `consumeSessionQuota` 的活跃谓词当场拒掉过期 / 撤销行 —— 「查看不等于使用」在这里不是修辞,是谓词层面的事实。
2. **没有任何路径能让它复活。** `regenerate` 与 `update`(含续期 `applyRenewal`)都经 `loadMutableShare`,只认 ACTIVE 且未过期的行。所以不存在「先取回链接、再把行救活」的组合拳。
3. **反过来会砍掉审计面。** AC-ADMIN-09 要求 EXPIRED / REVOKED 行仍可读可审计,`loadOwnerDetail:509-511` 的注释就是为这条专门写的。管理员恰恰是在这些行上排查「当初发出去的是哪一条」;套上活跃谓词,详情页的「查看链接」会在他最需要的那些行上莫名其妙地失败。

用例:`still reveals an expired or a revoked share, because that link can no longer be used`。

## 五类结果 → 对外错误码(前端下一包照此接)

HTTP 恒 200 + `Cache-Control: no-store`,业务码走 `withShare` → `{code: 501, message: <下表>}`,与 share 面其余端点同形。

| `SEC_CIPHER_FAILURE` | 对外 `message` | 事件 `outcome` | `alert` | 管理员该看到的话 |
|---|---|---|---|---|
| `ABSENT` | `SHARE_SEC_ABSENT` | `absent` | `false` | 此分享创建于功能上线前,不可恢复,可重新生成 |
| `KEK_MISSING` | `SHARE_SEC_UNAVAILABLE` | `kek_missing` | **`true`** | 服务配置异常,请联系管理员 |
| `UNKNOWN_KID` | `SHARE_SEC_KEY_RETIRED` | `unknown_kid` | `false` | 密钥已轮换退环,不可恢复,可重新生成 |
| `AUTH_FAILED` | `SHARE_SEC_CORRUPTED` | `auth_failed` | **`true`** | 凭据数据异常 |
| `MALFORMED` | `SHARE_SEC_CORRUPTED` | `malformed` | **`true`** | 凭据数据异常(同上) |
| — | `SHARE_NOT_FOUND` | `denied` | `false` | 分享不存在(他人 / 不存在共用,存在性探针封闭) |
| — | `RATE_LIMITED`(HTTP **429** + `Retry-After: 60`) | — | — | 操作过于频繁 |

成功:`{shareId, lid, shareUrl}`。⛔ **不单独回裸 `sec`** —— 管理员要的是能复制的那一条,多一个字段就多一处会被日志/埋点顺手带走的明文。

### 错误码新增的理由

四个 `SHARE_SEC_*` 全是新增。既有码没有一个能表达这些语义:`SHARE_NOT_FOUND` 是存在性、`SHARE_INVALID_CONFIG` 是请求值域、`SHARE_CAPABILITY_NOT_ENABLED` 是发布态、`SHARE_UPDATE_CONFLICT` 是并发。复用其中任何一个都会把「凭据取不回」说成别的事。

两处**刻意不折叠**、一处**刻意折叠**:

- `ABSENT` 与 `UNKNOWN_KID` 自助动作相同(都可重新生成)却各占一码 —— 合并会让「密钥环被误删」看起来像一批陈年老数据。
- `AUTH_FAILED` 与 `MALFORMED` 共用 `SHARE_SEC_CORRUPTED`:对管理员都是「凭据数据异常」、同一个自助动作,分开只会让他猜。差别在成因(篡改/搬行 vs 写入侧写坏),只有排障需要,所以留在事件的 `outcome` 里 —— 契约要求的「事件里要能分辨」由此满足。
- 未知成因(将来解密模块多一种)落 `REVEAL_UNKNOWN_FAILURE` = `SHARE_SEC_CORRUPTED` + `alert: true`,fail-loud。静默当成良性降级正是本包要防的那件事。

## 限流方案选择

**选:Cloudflare Rate Limiting 绑定,但 key 取 `userId` 而非 IP。**

owner 面此前零限流,所以这是新建。三个候选:

1. 直接复用 `shareRateLimit(binding, retryAfter)` —— key 恒为 `CF-Connecting-IP`(`share-rate-limit.js:37-46`)。
2. 本包选的:同一套机制(同样的绑定、同样的 429 + `Retry-After`、同样的绑定缺失即 fail-open、复用 `limitedShareResponse`),只把 key 换成 `userId`。
3. 自建 KV / D1 计数 —— 已被 `share-rate-limit.js` 的模块注释否掉(非原子增量 + 60s KV 缓存)。

选 2 不选 1:访客是匿名的,IP 是仅有的稳定标识;Owner 已经过了 JWT + `share:manage`,主体就是 `userId`。按 IP 计会同时出两个错 —— 换个出口 IP 就换来一份新配额,而同一间 NAT 后面的同事共用一份。用例 `expect(keys).toEqual([String(USER_A)])` 钉的就是这一点。

⛔ **没有改 `share-rate-limit.js`**(它不在本包独占清单里,另一执行者可能在动),中间件写在 `mail-share-api.js` 内,只 import 它的 `limitedShareResponse`。若后续要收敛,应把 key 提成 `enforceShareRateLimit` 的可选入参,而不是复制第二份 429 响应。

额度 20/60s:管理员开详情抽屉一分钟至多几次,20 留足误点空间,同时压住「被盗会话把整张分享列表走一遍变回明文链接」的速度。绑定缺失时中间件 fail-open 且运行时静默,所以另有一条用例断言 `wrangler.toml` 里声明了这个绑定 —— 「装了但没生效」只在 toml 里看得出来。

## 红→绿证据

**红**(实现前,测试先写):

```
 Test Files  2 failed | 17 passed (19)
      Tests  20 failed | 723 passed (743)
```
失败原因全是 `mailShareService.revealSec is not a function` / 路由 404 / `AC-ADMIN-10` 路由表不匹配 —— 是「功能不存在」,不是语法错。

**绿**(实现后,全量):

```
 Test Files  19 passed (19)
      Tests  744 passed (744)
```

基线 716 → 744,只增未减(+28:本包新增 15 条 + `OWNER_ENDPOINTS` 参数化带动 11 条 + 事件名清单等 2 条)。

## 变异验证(三处 · 均已还原并复跑)

| # | 变异 | 结果 | 打红的用例 |
|---|---|---|---|
| ① | 注释掉 `loadOwnerDetail` 归属校验 | **3 failed / 280 passed** | `refuses another owner exactly as it refuses a row that never existed` · `audits a refused call too` · `refuses a share that belongs to another owner over HTTP` |
| ② | 把 `KEK_MISSING` 折叠成 `SHARE_SEC_ABSENT` + `alert: false` | **2 failed / 281 passed** | `reports a missing KEK as a service fault with an alert` · `never folds the five outcomes into one undistinguishable answer` |
| ③ | 删掉成功路径的审计调用 | **1 failed / 282 passed** | `audits every call without ever writing the plaintext or the ciphertext` |

**还原后复跑(全量)**:

```
 Test Files  19 passed (19)
      Tests  744 passed (744)
```

变异②值得单说:五条失败用例**各自**看,把任意两类映射到同一个码时它们仍会全绿(每条只断言自己那一个码)。专门加的反折叠闸门 `never folds the five outcomes into one undistinguishable answer` 才是抓住它的那一条 —— 它一次性比对四个码并断言 `new Set(codes).size === 4`。

## Review Findings

- **无方向性偏差**,任务文档的路径 / 契约与真实代码一致。特别核实了文档着重提醒的那条坑:AAD 绑的确实是 `lid`(`mintShareCredentials:1247` 传 `shareId: lid`),读取侧照传 `row.lid`。
- **自行修正一处执行细节**:`lid` 与 `sec_cipher` 从**同一条** SELECT 取回(`loadShareCipher`)。分两次读的话,中间落地的一次 `regenerate` 会让新 `lid` 配旧密文,解出来是 `AUTH_FAILED` —— 把一次正常轮换报成数据完整性事故并触发误告警。
- **顺带收敛一处 SSOT**:链接拼装原本硬编码在 `firstCreateResponse` 里,已抽成 `shareUrlOf(c, lid, sec)`,create / regenerate / reveal 三处共用。这正是任务里「别自己拼」的要求,但既有代码没有可复用的出口,不抽就只能复制。
- **测试自身踩过一次坑**:最初用服务层 `workerCtx()` 建分享、用 HTTP 取回,两条 URL 因 `SHARE_PUBLIC_ORIGIN` 在 Worker env 里没配(回落请求 origin)而不等。那是测试造出来的差异不是产品的 —— 已改成两侧都走 HTTP,顺带把 e2e 姿势做成契约要求的那一种。
- **未触碰**:`share-sec-cipher.js` / `keyed-secret-ring.js` / `share-auth-service.js` / `share-rate-limit.js` / `mail-vue/`。未 `git commit`,未 `git stash`。
- **留给下一包的两条**:① 前端按上表四个 `SHARE_SEC_*` 码分支,⛔ 不要 `catch` 成一句「获取失败」,那等于在前端把后端刚分开的五类又折回去;② 告警规则钉 `event == 'share.sec.reveal' && alert == true`,不要枚举 `outcome` —— 解密模块加一种成因就会漏一类告警。

## Update Log

- 2026-08-25 · executor · T-20b2b 落地。红(20 failed / 723 passed)→ 绿(744 passed)→ 三处变异各自打红 → 还原复跑 744 passed。裁决「过期/撤销可查看」+ 限流按 userId 计,理由见正文。
