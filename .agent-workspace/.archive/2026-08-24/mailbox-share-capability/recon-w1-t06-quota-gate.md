# Recon · W1 / T-06 配额闸门 可执行修改范围

- **模式**:Mode R(reality recon)· 下一波侦察,只服务 T-06,不重写 `recon-w1-auth-chain.md`
- **日期**:2026-08-24
- **分支**:`cursor/mailbox-share-capability-dcb6` · 派单基线 HEAD `3834456`
- **⚠️ 侦察期间基线前移,已全程跟踪并复核**:派单时说「T-05 即将改 `share-auth-service.js`,按 pre-T-05 处理」。侦察进行中 T-05 先是以未提交改动落全,**收尾时已 commit 为 `c7789e6` `feat(worker): add ACCESS_LIMIT_REACHED four-state gate`**(改 4 文件:`share-auth-service.js` +15-2、`share-auth-service.spec.js` +171-13、`package.json` 钉 `fast-check@4.9.0`、`pnpm-lock.yaml`)。
  **故本报告的 post-T-05 锚点已在真实 commit 上二次核实,是稳定值,不是预测值**:`ESTABLISH_ALLOWED:230` / `RESOLVE_ALLOWED:231` / `assertAllowed:233` / `recordAccess:249` / `establishSession:256` / `resolveSession:287`。**T-06 执行者可直接用这些行号开工**(仍建议按符号名定位以防后续微调)。报告同时保留 HEAD `3834456` 的 pre-T-05 锚点作对照。T-05 执行说明见同目录 `exec-t05-note.md`。
- **本次实跑基线**:
  - `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js` @HEAD → **11 passed**
  - 同命令 @post-T-05 工作树 → **16 passed**(T-05 新增 5 条)
  - T-05 执行者复跑全量 `pnpm --dir mail-worker test` → **17 files / 185 tests, EXIT=0**(`exec-t05-note.md:36`)
- **本次侦察写了什么**:仅本报告。**零业务代码改动、零 commit**。侦察期间为取证创建过 5 个 `test/__recon_*` 临时探针文件,**已全部删除**(`git status` 已复核,无 `??` 残留于 `mail-worker/`)。探针输出逐条引在下文,可复现。

---

## 问题速查索引(派单 7 问 → 本报告章节)

| # | 派单问题 | 答在 |
|---|---|---|
| 1 | `establishSession`/`recordAccess` 现坐标 + T-05 之后的精确改写序列 | §2.1 + §5.2 |
| 2 | 怎么用现有 helper(`insertShare` / `ctx` / deps seam)写 T-06 红灯 | §3.1 + §5.3 |
| 3 | `last_access_at` 该不该进配额 UPDATE(要带证据的单一推荐) | §4.1 |
| 4 | 这台 Miniflare D1 上可行的「抢最后名额」并发测法 | §3.2 |
| 5 | 文件冲突图:T-06 写什么 vs T-05 刚写完什么 | §7.1 |
| 6 | 会逼改 spec 的风险(停下上报,不许自造绕法) | §4.3 |
| 7 | T-06 执行者的并行拆分方案 | §6 |

---

## 1. 计划假设清单(T-06 相关,可被现实推翻的)

| # | tasks.md / design.md 的假设 | 出处 |
|---|---|---|
| A1 | `recordAccess`(`:236-241`)可被条件 UPDATE 原地取代 | tasks.md:104 · design.md:280 |
| A2 | `last_access_at` **保持 fire-and-forget** | tasks.md:104 |
| A2' | `last_access_at` **在闸门 SQL 里** | design.md:280 原文 |
| A3 | 闸门 WHERE 含 `credentials_version = :cv`,cv 来自读快照 | design.md:280,357 · AC-SESS-01 |
| A4 | 单语句原子性可复用 `transaction.spec.js` 先例验证 | tasks.md:100 · design.md:287 |
| A5 | 「读请求序列(mails/mail/attachment/**status**)零配额消耗」可在 T-06 内测 | tasks.md:100 |
| A6 | 拒绝路径打 `share.session.denied_quota` 日志 | tasks.md:104 |
| A7 | 「无先读后写两步」(AC-SEC-08)—— 但 design.md:357 又要求先读快照 | AC-SEC-08 vs design.md:357 |
| A8 | AC-LIFE-14 是本 charter 的 AC,改写它即改本 charter | 派单裁决 |
| A9 | T-06 只写 `share-auth-service.js` + 其 spec | tasks.md:23 |

---

## 2. 现实核实(plan vs reality)

### 2.1 两个目标函数的坐标(问题 1 前半)

| 函数 | HEAD `3834456` | post-T-05 工作树 | 变化 |
|---|---|---|---|
| `effectiveStatus(row, now)` | `share-auth-service.js:25-33`(三态) | `:25-38`(四态,cap 分支在 `:32-36`) | T-05 已加 `row.maxSessions != null && row.accessCount >= row.maxSessions` |
| `assertShareActive(row)` | `:222-226` | **已不存在** | T-05 拆为下一行 |
| `ESTABLISH_ALLOWED` / `RESOLVE_ALLOWED` | — | `:230` / `:231` | T-05 新增 |
| `assertAllowed(row, allowed)` | — | `:233-239`,**返回算得的 state** | T-05 新增 |
| `loadLiveAccount(c, accountId)` | `:228-234` | `:241-247` | 仅平移 |
| **`recordAccess(c, shareId)`** | **`:236-241`** | **`:249-254`** | 内容零变化 |
| **`establishSession(c, lid, sec, deps = {})`** | **`:243-272`** | **`:256-285`** | 只有 `:269` 由 `assertShareActive(row)` 改为 `assertAllowed(row, ESTABLISH_ALLOWED)` |
| `resolveSession(c, sessionToken)` | `:274-295` | `:287-308` | `:299` 用 `RESOLVE_ALLOWED`;`:306` 返回算得 state(不再硬编码 `'ACTIVE'`) |
| 默认导出对象 | `:297-302` | `:310-315` | 键集合未变(`digestShareSecret` / `effectiveStatus` / `establishSession` / `resolveSession`) |

**post-T-05 `establishSession` 逐行现状(T-06 要改写的正是这段)**:

```
256  async function establishSession(c, lid, sec, deps = {}) {
257-259   isShareDisabled 守卫
260-261   lidText / secText 归一
262-264   ★读快照:orm(c).select().from(mailShare).where(eq(mailShare.lid, lidText)).get()
265-268   matchSec(不可区分性:row 为 null 时也跑一次 HMAC)+ 失败即 throwUnavailable
269       assertAllowed(row, ESTABLISH_ALLOWED)      ← 快照态判定(含 T-05 的 cap 分支)
270       const accountRow = await loadLiveAccount(c, row.accountId)
271       ★const sessionToken = await issueToken(c, row)      ← 现在在计数之前
272-279   ★try { await (deps.recordAccess || recordAccess)(c, row.shareId) } catch { console.error(...) }
280-284   return { sessionToken, mailbox: accountRow.email, expiresAt: row.expiresAt }
285  }
```

三处 ★ 就是 T-06 的全部战场。精确改写序列见 §5.2。

### 2.2 [deviation · P0] A2 与 A2' 直接互斥,`tasks.md:104` 的原文与 design.md 打架

- `tasks.md:104`(T-06.2)白纸黑字:「`last_access_at` **保持 fire-and-forget**」。
- `design.md:280` 的 SQL 原文:`UPDATE mail_share SET access_count = access_count + 1, last_access_at = ? WHERE ...`,`last_access_at` **在闸门语句里**。

派单已裁决「`last_access_at` may live on the same success statement」,即采纳 design.md。**后果:`tasks.md:104` 的这句话必须改**,否则 T-06 执行者照 tasks.md 做就会落到与 design.md 冲突的实现上。详见 §4.1 与 §4.3 R1。

### 2.3 [deviation · P0] AC-LIFE-14 与 AC-LIFE-10 **不是本 charter 的 AC**,它们属于上一份已收口的 charter

全仓 grep 结果:

| AC | 定义在 | 本 charter `mailbox-share-capability/requirements.md` 里有没有 |
|---|---|---|
| AC-LIFE-14「统计写失败仍签发」 | `docs/specs/mail-share/requirements.md:120` | **没有**(全文 0 命中) |
| AC-LIFE-10「更新 last_access_at 与 access_count」 | `docs/specs/mail-share/requirements.md:121` | 有一条 **AC-LIFE-10,但内容完全不同** —— 本 charter 的 AC-LIFE-10 是「发布协议双写栅栏」(`requirements.md:197`) |

而 `share-auth-service.spec.js` 里两条用例的标题正引用这两个 id:
- `:254` `still issues a session when access accounting fails (AC-LIFE-14)`
- `:269` `increments access_count only on successful establish (AC-LIFE-10)`

**这意味着**:派单说的「rewrite AC-LIFE-14」在物理上是**修改上一份 charter 的需求**(`docs/specs/mail-share/requirements.md:120`),不是修改本 charter。同时 `:269` 那条用例的 AC 标签与本 charter 的 AC-LIFE-10 **同名异义**,留着会让后续读者对错需求。A8 **[deviation]**。处置建议见 §4.3 R1。

### 2.4 [deviation] A5 的「status 端点」在 T-06 时点不存在,该子句必须收窄

`tasks.md:100` 要求测「读请求序列(mails/mail/attachment/**status**)零配额消耗」。但 `GET /share/mailboxes/status` 由 **T-14**(W2)新建(`tasks.md:140` · `design.md:336`),T-06 时点全仓无此路由(`share-api.js` 只有 `:54` session、`:60` mails、`:71` mail、`:81` attachment)。

**好消息:四条读路径共用同一个咽喉。** 实测四处调用点:

| 路径 | resolveSession 调用点 |
|---|---|
| `GET /share/mails` | `share-api.js:62` |
| `GET /share/mail` | `share-api.js:73` |
| `GET /share/attachment` | `share-attachment-service.js:96`(经 `share-api.js:83`) |
| `GET /share/mailboxes/status`(T-14) | 未来同样会走 resolveSession |

并且**全部 `share-*` 服务里只有一处写库**:`rg '\.update\(|UPDATE |\.insert\(|INSERT ' src/service/share-*.js` → 唯一命中 `share-auth-service.js:250`(即 `recordAccess`)。所以 P-SESS-02 在结构上是「resolveSession 无写路径」这一条命题。**T-06 应把该子句收窄为「resolveSession × N + 现存三条读端点零配额消耗」,并加一条源码级护栏断言(仿 `mail-share.schema.spec.js:143-151` 的 `?raw` 正则计数法)钉死 resolveSession 之后无写语句**;status 端点那一份挪进 T-14 的验收。A5 **[deviation,需收窄]**。

### 2.5 [match] A7 的「先读后写」不构成矛盾,不要让执行者在这里自我怀疑

AC-SEC-08 原文(`requirements.md:178`)是「**配额等一切服务端状态变更** SHALL 以单条原子条件写实现,SHALL NOT 采用先读后写两步」。约束对象是**状态变更**,不是「函数里不许有 SELECT」。`:262-264` 的读快照有两个不可替代的用途:① 取 `sec_hmac` / `pepper_kid` 做凭据校验(不读就没法验);② 取 `credentials_version` 喂进闸门 WHERE 作乐观并发守卫。状态变更本身仍是**一条** UPDATE。design.md:357 明写「读行快照(得 `credentials_version = cv`)→ 校验 → 条件 UPDATE」。**A7 [match],无需改动,但建议在 T-06 的实现注释里写一句,免得复审者误报。**

### 2.6 [match] 闸门谓词与 T-05 的 `effectiveStatus` 严格互补(已实测)

| 维度 | `effectiveStatus`(T-05,`:25-38`)判「不可用」 | 闸门 WHERE 判「可放行」 | 互补? |
|---|---|---|---|
| 撤销 | `row.status === 'REVOKED'` | `status = 'ACTIVE'` | ✅ |
| 过期 | `row.expiresAt <= now` | `expires_at > ?` | ✅ |
| 触顶 | `row.maxSessions != null && row.accessCount >= row.maxSessions` | `(max_sessions IS NULL OR access_count < max_sessions)` | ✅ |

**探针实测(`PROBE_Q3` / `PROBE_Q4` / `PROBE_Q5`)**:

```
PROBE_Q3 {"unlimited":1,"revoked":0,"expired":0,"cvDrift":0}
PROBE_Q4 {"zero":0,"over":0}          # max_sessions=0 拒;access_count 已超上限拒
PROBE_Q5 {"before":1,"after":0}       # 'YYYY-MM-DD HH:mm:ss' 字符串比较的时序语义正确
```

- `max_sessions IS NULL` 走 SQL 三值逻辑正确豁免(`unlimited:1`),与 JS 侧 `!= null` 一致。
- `access_count` 列是 `NOT NULL DEFAULT 0`(`entity/mail-share.js:17`),所以 `access_count < max_sessions` 不会退化成 NULL。
- `expires_at` 是 TEXT,`>` 走字典序;因格式定长零填充,字典序等价于时序。**已实测,不是推断。**

### 2.7 [match] `RETURNING` 判定可用,且**仓内已有「条件 UPDATE + 自增 + RETURNING」的现成先例**

`transaction.spec.js:83-104` 已在本机验证 raw `prepare().all()` 的 `meta.changes` / `results` 判定。

**更值钱的是内部先例:`verify-record-service.js:62-65` 已经在写与 T-06 同构的语句**——

```js
orm(c).update(verifyRecord).set({
    count: sql`${verifyRecord.count} + 1`, updateTime: now
}).where(and(eq(...), eq(...))).returning().get();
```

`sql` 模板自增 + 多谓词 `and` + `.returning()`,一个不缺。全仓 `.returning(` 共 14 处(`email-service.js` 5 · `verify-record-service.js` 4 · `account-service.js` 2 · `oauth-service.js` 2 · `user-service.js` / `role-service.js` / `setting-service.js` 各 1),其中 `update().returning()` 5 处。**T-06 不是首次使用,照本仓既有写法即可。**

本次仍补验了带列选择的形式(仓内均为无参 `.returning()`):

```
PROBE_Q2 {"first":[{"accessCount":1,"cv":0}],"second":[],"firstIsArray":true}
```

⚠️ **两种收尾方式的判空语义不同,执行者必须选定一种并在注释里写清**:

| 写法 | 命中 | 未命中 |
|---|---|---|
| `.returning({ accessCount: ... })`(无 `.get()`) | 长度 1 的数组 | **长度 0 的数组** |
| `.returning().get()`(仓内既有风格) | 行对象 | **`undefined`** |

**推荐前者**(`if (!applied.length)`):判空是显式的长度检查,不依赖 `undefined` 的 falsy 语义,读的人不会把「未命中」和「命中但字段为 0」混起来。生成的 SQL 与 design.md:280 逐字同义(探针 `PROBE_S1` 打印的实际语句):

```sql
update "mail_share" set "access_count" = "mail_share"."access_count" + 1, "last_access_at" = ?
where ("mail_share"."share_id" = ? and "mail_share"."status" = ? and "mail_share"."expires_at" > ?
  and "mail_share"."credentials_version" = ?
  and ("mail_share"."max_sessions" is null or "mail_share"."access_count" < "mail_share"."max_sessions"))
returning "access_count"
```

**结论:T-06 用 drizzle 写闸门,不必降级到 `c.env.db.prepare` 手写 SQL。** 两条理由:① 仓内已有同构先例(`verify-record-service.js:62-65`),不是新路子;② 避开 §7.2 的源码正则护栏风险(手写 SQL 更容易误触 `mail_share.account_id` 之类的字面量)。

### 2.8 [deviation · 但是好消息] A1 说「原地取代」,实际是**流程重排**,`issueToken` 必须换位

现在 `issueToken` 在 `:271`,计数在 `:272-279` —— **先签发后计数**。design.md:280 与 AC-SESS-01 都要求 **「RETURNING 非空才 issueToken」**。T-06 必须把 `issueToken` 移到闸门**之后**。这不是「取代一个函数调用」,是调换两个语句的顺序 + 插入一个拒发分支。

**换位后的一个残余(已核,属既定行为,不是新风险)**:`issueToken` 自身在 `exp <= iat` 时会 `throwUnavailable()`(`:172-174`)。换位后若它抛错,名额已消耗且不退还。但闸门 WHERE 已含 `expires_at > now`,过了闸门就必有 `shareExp > iat`,该分支实际不可达;即便可达,「UPDATE 已提交、issueToken 之前失败 → 名额不退还」正是 AC-EDGE-13 逐字文档化的 TOCTOU 语义(`requirements.md:219`),**在 spec 之内,不需要额外补偿**。

---

## 3. 重复实现与可复用扫描

### 3.1 内部复用 · 测试侧:该用什么、**不该重造什么**(问题 2)

| 需求 | 现成设施 | 位置(post-T-05) | T-06 该怎么办 |
|---|---|---|---|
| 种一行带配额的 share | `insertShare({..., maxSessions, accessCount })` | `share-auth-service.spec.js:98-137` | **T-05 已经加好了这两个可选形参,T-06 不要再加一遍。** 默认不写这两列 → 既有用例保持 NULL/0 |
| 种 `credentials_version` | ❌ 没有 | — | **T-06 唯一需要扩的一个形参**,照 T-05 的动态列拼接写法追加 4 行 |
| 造 `sec` 的 HMAC | `hmacHex(key, message)` | `:39-49` | 直接用 |
| 造 ctx / 覆盖 env | `ctx(overrides)` → `{ env: { ...env, ...overrides } }` | `:35-37`、`:18-33` | **这是 T-06 的注入总阀,见 §3.3** |
| 字节相同失败包体断言 | `catchFail(promise)` → `failEnvelope` | `:51-62` | 直接用 |
| 行清理 | `seededLids` + `afterEach(cleanup)` | `:86`、`:123-137` | 新种的行**必须**经 `insertShare` 才会入清理名单 |
| 解 token payload | `decodeTokenPayload` | `:77-84` | T-08 用得上,T-06 一般不需要 |
| 含全新列的行工厂 | `seedShareRow(overrides)` | `test/setup.js:69-110` | **不推荐 T-06 用**:它写死 `sec_hmac = '<tag>-hmac'`(假 HMAC),`establishSession` 的 `matchSec` 必然失败;要用就得同时覆盖 `lid`/`secHmac`/`pepperKid` 并自己管清理 —— 比扩本地 `insertShare` 更贵。它是给 `mail-share-service.spec.js` 那种不走 establish 的场景用的(`mail-share-service.spec.js:15,531`) |

### 3.2 内部复用 · 并发测法:**必须走 `establishSession`,不能只测裸 SQL**(问题 4)

先给结论,再给证据。

**结论:用 `Promise.allSettled` 并发调 `establishSession`,种子设 `accessCount = maxSessions - 1`。这台 Miniflare D1 真的会交错,红灯是真红。**

**证据 A · 当前(post-T-05,无闸门)代码会大幅超发。** 探针直接打真实 `establishSession`:

```
PROBE_R1 {"fulfilled":6,"rejected":0,"accessCount":6}   # max_sessions=1,6 路并发 → 发了 6 张 token
PROBE_R2 {"fulfilled":6,"rejected":0,"accessCount":8}   # max_sessions=3 种子 2,6 路并发 → access_count 冲到 8
PROBE_R3 {"fulfilled":1,"accessCount":1}                # 同样 6 次但串行 await → 恰好 1 次成功
```

R1/R3 的对比就是全部答案:**串行时 T-05 的快照判定已经够用(R3 = 1),只有并发才暴露缺口(R1 = 6)。** 所以
- T-06 的并发用例在实现前**一定红**(拿到 6 而不是 1),不存在假绿;
- 反过来,**任何用串行 `await` 写的「抢名额」用例都是假绿**,它在 T-06 之前就通过了,一行代码也驱动不出来。这是本节最重要的一句话。

**证据 B · 闸门本身在并发下恰好放行 max 次。** 探针用 design.md:280 同义 SQL,12 路 `Promise.all`:

```
PROBE_Q1 {"applied":3,"denied":9,"finalCount":3,"returned":[1,2,3]}
```

RETURNING 回来的 `access_count` 是 `[1,2,3]` —— 严格递增无重复,说明 D1 把这 12 条语句真正串行化了,没有丢失更新。

**证据 C · `Promise.all` 并发调 `establishSession` 在本 spec 里已有先例**,不是新发明:`share-auth-service.spec.js:160-167` 就是 `Promise.all([...6 个 catchFail(establishSession(...))])`。

**推荐的两条用例(都必须并发):**

| 用例 | 种子 | 并发数 | 断言 | 覆盖 |
|---|---|---|---|---|
| 抢最后一个名额 | `maxSessions: 3, accessCount: 2` | 6 | 恰 1 个 fulfilled;其余 5 个字节相同 `SHARE_UNAVAILABLE`;`access_count === 3` | AC-EDGE-02 · P-SESS-01 |
| 空闲配额并发不超发 | `maxSessions: 3, accessCount: 0` | 8 | 恰 3 个 fulfilled;`access_count === 3` | AC-SESS-01 · AC-SESS-07 |

第一条是关键:种子设在 `max-1` 时**全部并发请求的快照都读到 `max-1 < max`**,于是全部通过 `assertAllowed`,只能由闸门来分胜负 —— 它单独隔离出闸门的功劳,`assertAllowed` 帮不上忙。

**注意事项(会咬人的三点):**
1. 断言用 `Promise.allSettled` 不要用 `Promise.all`(后者第一个 reject 就短路,拿不到计数)。
2. `vitest.config.js:17` 是 `singleWorker: true` + 默认 `isolatedStorage`,同一 spec 内的并发跑在同一个 workerd 运行时上 —— 这正是 R1 能交错的原因。**不要为这条用例改 vitest 配置**(那是全仓共享文件)。
3. 断言 `access_count` 用 `env.db` 直读,不要经 `orm`,与本 spec 既有写法一致(`:276-278`)。

### 3.3 内部复用 · TOCTOU 注入:**用 D1 绑定代理,不要往生产代码里加新 seam**

`tasks.md:100` 要求两条注入用例:「条件 UPDATE **前**状态变更注入 → 正确拒发」「UPDATE **后** TOCTOU 注入 → token 首次回源失败、名额不退还」。

最容易想到的做法是往 `options` 里加 `beforeQuotaUpdate` / `afterQuotaUpdate` 钩子 —— **不需要。** `ctx(overrides)`(`:35-37`)把 overrides 展开进 `env`,而 `orm(c)` 就是 `drizzle(c.env.db)`(`entity/orm.js:4`),所以 `ctx({ db: <代理> })` 能把 drizzle 的每一条语句都截下来。四条探针全绿:

```
PROBE_S1 {"intercepted":1, sqlSample:"update \"mail_share\" set \"access_count\" = ... returning \"access_count\"", "out":[{"accessCount":1}]}
PROBE_S2 {"returned":[],"accessCount":0}                      # UPDATE 前注入 revoke → 闸门拒发、零消耗
PROBE_S3 {"returned":[{"accessCount":1}],"row":{"access_count":1,"status":"REVOKED"}}  # UPDATE 后注入 → 名额已耗不退还
PROBE_S4 {"thrown":"d1 write failed","accessCount":0}         # 闸门语句抛错 → 零消耗
```

代理形状(探针里跑通的版本,供执行者照抄进 spec 的 helper 区):对 `prepare` 做 `Proxy`,匹配到闸门语句时把 `bind` 递归包一层,在 `all`/`run`/`first`/`raw` 前后各插一个 async 钩子。**关键点:`bind()` 返回的是新对象,必须递归包装,否则钩子会丢。**

**三个收益**:① 生产代码零测试专用参数;② `deps.recordAccess` 这个老 seam 可以随 `recordAccess` 一起删干净,不留半个;③ `PROBE_S4` 顺带给出「闸门写失败」的注入法 —— 这正是改写后的 AC-LIFE-14 用例要断言「**拒发**」的地方。

### 3.4 内部复用 · `share.session.denied_quota` 日志:常量已存在,但有一个**循环 import**要先想清楚(A6)

事实:
- `SHARE_EVENT.SESSION_DENIED_QUOTA = 'share.session.denied_quota'` 与 `logShareEvent(event, fields)` 都已由 T-03 落在 **`mail-share-service.js:27-34, 73-82`**(commit `e878760`)。
- 而 `mail-share-service.js:7` 已经 `import shareAuthService from './share-auth-service'`。
- 所以 T-06 若从 `share-auth-service.js` 反向 import,就形成 **A↔B 循环**。
- 常量清单被 `mail-share-service.spec.js:635-643` 逐字冻结,`logShareEvent` 的输出形状被 `:645-668` 冻结 —— **搬家会打别人的 spec,出 T-06 的车道**。

**实测循环安全性**(用与真实两文件同形状的探针模块,两个入口顺序各跑一次):两条用例全绿。原因:两边对彼此的引用都只发生在函数体内(`mail-share-service.js:173`、`:403` 都在函数里),模块求值期没有任何顶层解引用,不触发 TDZ。

**裁决:T-06 直接 `import { SHARE_EVENT, logShareEvent } from './mail-share-service'`,不搬家、不复制字符串。** 理由是三选一里唯一既满足 SSOT 又不越车道的:
- 复制字面量 `'share.session.denied_quota'` → 破 SSOT,且日志形状(`requestId`/`shareId`/`ts`)会与 `logShareEvent` 漂移。否。
- 抽到 `src/const/share-event.js` → 干净,但必须同时改 `mail-share-service.js`(W2/W3 单 owner 热区)和它的 spec。**出车道,否。**
- 直接 import → 循环已实测安全。**是。** 请在 import 行上留一句注释说明这是已知循环、安全依据是「双向引用均在函数体内」。

架构层面这仍是个轻微异味,清理建议见 §4.2。

### 3.5 内部复用 · `denied_quota` 会有**两个**触发点,别只打一个

这是最容易漏的一处。T-06 之后,「配额不足」在 `establishSession` 里会从**两条不同路径**返回:

| 路径 | 何时发生 | 现在谁拦 |
|---|---|---|
| 快照即已触顶(**绝大多数真实情况**) | 上一个访客早就把名额用完了 | `assertAllowed(row, ESTABLISH_ALLOWED)`(`:269`),T-05 的 cap 分支 |
| 快照未触顶但闸门落空(**并发抢名额**) | 两人同时读到 `max-1` | 新增的闸门 RETURNING 为空 |

如果只在闸门空返回时打日志,**日常最常见的触顶拒绝一条日志都不会有** —— A6 名义达成、实质落空。

**建议**:加一个文件内小助手 `denyQuota(shareId, reason)`,先 `logShareEvent(SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId, reason })` 再 `throwUnavailable()`,两处都调,用 `reason` 区分(`'quota_snapshot'` / `'quota_race'`)。`logShareEvent` 支持任意附加字段(`mail-share-service.js:74` 的 `...rest`),且 `reason` 已是既有约定用法(`mail-share-service.spec.js:650` 就传 `reason: 'quota_exhausted'`)。

**实现顺序要点**:`assertAllowed` 是**抛出**而非返回 `'ACCESS_LIMIT_REACHED'`,所以快照侧要先自己算一次态:`const state = effectiveStatus(row, nowText()); if (state === 'ACCESS_LIMIT_REACHED') denyQuota(row.shareId, 'quota_snapshot'); assertAllowed(row, ESTABLISH_ALLOWED);`。`effectiveStatus` 是纯函数,多算一次零代价(T-05 的 property 用例 `:355-396` 已把幂等性钉死)。

**顺带的护栏**:`share-auth-service.spec.js:282-303`(AC-LEAK-05)同时接管 `console.log` 与 `console.error` 并断言不含 `sec`/token。`logShareEvent` 走 `console.log`,所以 **`denyQuota` 的 fields 里绝不能带 `sec` / `lid` / token**(只放 `shareId` + `reason`)。

### 3.6 外部(open-source)扫描

- **有没有现成的「D1 配额闸门」库?** 没有,也不该有 —— 这是一条 SQL。不引入依赖。
- **平台陷阱核查 · D1 读复制会不会让快照过期?** 查了 Cloudflare 官方文档 [Global read replication · Cloudflare D1 docs](https://developers.cloudflare.com/d1/best-practices/read-replication/):「**To use read replication, you must use the D1 Sessions API, otherwise all queries will continue to be executed only by the primary database.**」本仓 `orm(c) = drizzle(c.env.db)`(`entity/orm.js:4`),全仓 `withSession(` 命中 0 → **所有查询都打主库,快照不可能读到复制滞后的旧值。当前无风险。**
- **而且这个设计天然抗复制。** 假设将来有人开了 Sessions API:快照 SELECT 可能落到副本、闸门 UPDATE 必然落到主库(写永远转发主库,同上文档)。此时闸门 WHERE 里的 `credentials_version = :cv` 会拿**快照时刻的旧 cv** 去比**主库的新 cv**,不匹配即拒发 —— 连「用过期的 `sec_hmac` 通过校验」这种最坏情况都被自动挡住。**这一点值得写进 T-06 的实现注释**:单语句闸门不只是防超发,它同时是快照新鲜度的守卫。零代码代价,只是记下来。
- **`fast-check`**:T-05 已装 `4.9.0`(精确钉版,`package.json:14`),`node_modules/fast-check` 实存。T-06 若要写 property 用例可直接 import,**不要再动 `package.json` / `pnpm-lock.yaml`**(§7.1)。

---

## 4. 架构 / 前提挑战 + 业务现实核对 + 更优做法

### 4.1 `last_access_at` 该不该进闸门 UPDATE —— **推荐:进。**(问题 3)

**推荐 (A):闸门成功语句里同时写 `access_count = access_count + 1, last_access_at = ?`,establish 路径上不再保留任何 fire-and-forget 的库写。**

支撑证据,由强到弱:

1. **语义完全等价,不是妥协。** 今天的 `recordAccess`(`:249-254`)只在 `establishSession` 成功路径上被调用一次(`:273`),失败路径根本走不到。也就是说 `last_access_at` 现在的含义已经就是「最后一次**成功建立会话**的时刻」。挪进闸门后含义一字不变 —— 闸门也只在成功时命中。**这不是「为了省一次写而牺牲语义」,两者写入时机本来就同集合。**
2. **design.md:280 的 SQL 原文就是这样写的**,`tasks.md:104` 是那条唯一的反对意见,而它已被派单裁决推翻(§2.2)。采纳 (A) = 让实现回到 design。
3. **少一次 D1 写。** establish 是访客面唯一的写路径,也是配额闸门所在;两条语句变一条,直接砍掉一次往返。
4. **消灭一个不一致窗口。** 若拆成两条,存在「配额已 +1 但 `last_access_at` 写失败」的状态,Owner 列表(`design.md:301` 要求行含 `lastAccessAt`)会显示一个与 `usedSessions` 对不上的时间。一条语句则两列同生共死。
5. **AC-SEC-08 不构成反对理由。** 它禁的是「先读后写两步」(§2.5),不是「禁止第二条写语句」。所以 (A) 与 (B) 在 AC-SEC-08 面前是平局 —— 它不是决定因素,别拿它当论据。

**采纳 (A) 的连带后果(必须一并交待,否则 T-08 会撞墙):**

- establish 路径上**不再有任何 fire-and-forget 的数据库写**,`recordAccess` 函数与 `deps.recordAccess` seam 一起删除。
- 于是 `tasks.md:114`(T-08.1)要求的「**统计写失败注入仍签发**」在 T-08 时点**没有挂载点**。按派单裁决「If a 'stats write fail still issues' test remains, it must be outside the quota UPDATE」,唯一合法的挂载点是 **T-07 的 KV 写**(`design.md:242` 明写 KV 读/写不可用时 fail-open 仍签发 + 记 `share.system.error`)。
- **行动项**:T-06 交付时须在 tasks.md 的 T-08.1 条目里把「统计写失败注入仍签发」改述为「**KV 写失败注入仍签发**(fail-open,与 T-07.1 的 KV 故障用例合并)」。这是文档改动,归主 AI(§4.3 R1)。

**被否的 (B):闸门只 `access_count + 1`,`last_access_at` 另起一条 fire-and-forget UPDATE。** 唯一好处是给「统计写失败仍签发」保住一个挂载点。但那个断言本身已被派单判定为「对配额闸门不再成立」,为了留一个已被判废的测试而多一次写、多一个不一致窗口、并且违背 design.md 原文 —— 不划算。**不推荐。**

### 4.2 架构 / 前提挑战

**结论:不构成架构级问题,T-06 不是在错骨架上贴瓷砖。**

XY 回溯:用户要的表层修复(Y)是「加一个 `max_sessions` 上限」;真问题(X)是「**授权、凭据版本、配额三者必须在同一个可线性化的点上提交**」。design.md 的 R1-A4 / R2-A3 两轮裁决已经把 X 找准并收敛成一条 SQL —— 这是正确的根因级设计,不是补丁。`PROBE_R1`(6 路并发发出 6 张 token)恰好证明:如果只做表层的 Y(在读快照后加个 if),问题根本没解决。**无架构级建议。**

**一条轻微异味(不阻塞 T-06)**:§3.4 引入的 `share-auth-service ↔ mail-share-service` 循环 import。实测安全,但两个 service 互引在结构上不干净。**建议归属**:W2 收口时(T-13 或 T-14,反正那时 `mail-share-service.js` 已在同一 owner 手上)把 `SHARE_EVENT` / `logShareEvent` 抽到 `src/const/share-event.js`,两侧改 import,`mail-share-service.spec.js:635` 的冻结断言改指向新模块。**这是一次纯搬迁,零行为变更,不要塞进 T-06。**

### 4.3 业务现实核对(§0.17)

T-06 只有**一个**新建项:`consumeSessionQuota` 条件 UPDATE 闸门。逐条过四问:

| 四问 | 回答 |
|---|---|
| ① 真实场景 | Owner 把一条带 `max_sessions=1` 的分享链接私发给某一个人。第二个拿到链接的人不该能打开。 |
| ② 缺了真实用户损失什么 | **实测的超发数据**:`PROBE_R1` 显示当前代码在 6 路并发下对 `max_sessions=1` 的分享发出 **6 张有效 token**。这不是「接口不对称」,是**付费/私密链接被 6 个人同时用**。 |
| ③ 系统里有没有别的机制已经解决 | 没有。全仓唯一相关写路径是 `share-auth-service.js:250` 的 fire-and-forget `recordAccess`,它无上限、无条件、无原子性(`recon-w1-auth-chain.md` §2.1 同结论)。既有的 `SHARE_SESSION_RATE_LIMITER`(`share-api.js:54`)是 IP 边缘限流,按 `requirements.md:292`(AC-AUTH-06)属独立运输层,**不承担配额语义**。 |
| ④ 分类 | **A 类业务关键。** |

**无 D 类技术整洁项混入,无「技术缺口冒充业务需求」。** 顺带核一条:T-06 不新建 `ShareAccessEvent` / `auth_fail` 表(派单已定),与 `design.md:289`(R2-A6 删除 `mail_share_auth_fail`)一致 —— 那两张表正是被判为 D 类而删掉的,不要复活。

### 4.4 会逼改 spec / 需要上报的风险(问题 6)

按严重度排序。**执行者遇到这些必须停下上报,不许自造绕法。**

#### R1 · [P0 · 文档必须改,归主 AI] 三处文档与已裁决的实现互相矛盾

| # | 位置 | 现文 | 与裁决冲突在哪 | 建议改法 |
|---|---|---|---|---|
| a | `tasks.md:104`(T-06.2) | 「`last_access_at` 保持 fire-and-forget」 | 派单裁决 + design.md:280 要求它进闸门语句(§2.2 / §4.1) | 改为「`last_access_at` 与 `access_count` 同在闸门成功语句;establish 路径不再保留 fire-and-forget 库写」 |
| b | `tasks.md:114`(T-08.1) | 「统计写失败注入仍签发」 | 采纳 (A) 后此断言在 T-08 时点无挂载点(§4.1) | 改为「KV 写失败注入仍签发(fail-open),与 T-07.1 合并」 |
| c | `tasks.md:100`(T-06.1) | 读请求序列含 **status** 端点 | `GET /share/mailboxes/status` 由 T-14 新建,T-06 时点不存在(§2.4) | 收窄为「mails/mail/attachment 三端点 + resolveSession 源码级无写护栏」,status 那份挪进 T-14 |

**为什么必须先改再派**:执行者读 tasks.md 是照令行事;a 与派单裁决直接冲突,c 描述的端点不存在。不改的话执行者要么照 tasks 做出错误实现,要么停下来问 —— 两种都比先改文档贵。

#### R2 · [P0 · 需用户/主 AI 拍板] 「改写 AC-LIFE-14」改的是**上一份 charter**

§2.3 已证:AC-LIFE-14 定义在 `docs/specs/mail-share/requirements.md:120`,本 charter 的 requirements.md 里根本没有这条 AC。所以「rewrite AC-LIFE-14」有三种可能的落法,**必须选一种,不能让执行者自己猜**:

| 选项 | 做法 | 代价 |
|---|---|---|
| **(i) 推荐** | 不动旧 charter 的文本;在**本** charter 的 `requirements.md` 里新增一条 AC(如 AC-SESS-11)明写「配额 UPDATE 失败 SHALL 拒发」,并在 `docs/specs/mail-share/requirements.md:120` 的 AC-LIFE-14 行尾追加一句 `— superseded by <本 charter AC-SESS-11>(配额闸门引入后不再成立)` | 一处交叉引用;旧 charter 的历史记录保持可读 |
| (ii) | 直接改写旧 charter 的 AC-LIFE-14 正文 | 改一份已收口 charter 的需求正文,历史断层,后来者读不出为什么变 |
| (iii) | 只改测试,文档不动 | 留下一条与实现矛盾的在册 AC,下一次审查必然复报。**否** |

**连带项**:`share-auth-service.spec.js:269` 那条 `increments access_count only on successful establish (AC-LIFE-10)` 的标签指的是**旧** charter 的 AC-LIFE-10,与本 charter 同名异义的 AC-LIFE-10(发布协议双写,`requirements.md:197`)撞车。建议在同一次动作里把标题标签改为 `(mail-share AC-LIFE-10)` 或指向新 AC。**这条用例本身在 (A) 方案下无需改断言** —— 它断言两次 establish 后 `access_count === 2` 且 `last_access_at` 是字符串,闸门方案下依然成立。

#### R3 · [P1 · 建议主 AI 拍板,不阻塞] `denied_quota` 是否要两处都打

§3.5 已论证「只打闸门那一处 = 日常触顶零日志」。侦察倾向是两处都打 + `reason` 区分。这属实现细则,不改 spec 文字,**但如果主 AI 认为「denied_quota 应当只表示并发竞争失败」,语义就完全不同了,请明确一句**。

#### R4 · [P1 · 已知洞,不归 T-06,但 T-06 别去碰] 触顶后附件下载被误拒

`share-attachment-service.js` 的 `assertActiveShareContext` 写死 `shareContext.effectiveStatus !== 'ACTIVE'` 即拒。T-05 落地后 `resolveSession` 会对触顶行返回 `'ACCESS_LIMIT_REACHED'`,于是 `/share/attachment` 在触顶后失效,而 `/share/mails`、`/share/mail` 正常 —— AC-SESS-06「关门不清场」在附件面上部分未达成。T-05 执行者已把它记为遗留风险并归给 T-08(`exec-t05-note.md:60`),`recon-w1-auth-chain.md` §8.2-3 也已裁决。**T-06 只需知道:写 P-SESS-02 用例时,附件路径在触顶状态下会拒,这是已知洞不是 T-06 的 bug;把零配额消耗的断言种在未触顶的行上即可绕开,不要去改那个文件。**

#### R5 · [P2] 生产侧至今无法真的写出 `max_sessions`

`mail-share-service.js` 的 create SQL 不写 `max_sessions`,Owner 面 update 端点要到 T-15 才有。所以 T-06 的全部证据只能来自 service 层直测 + 手写 seed,**端到端(建带配额分享 → 触顶 → 老 token 仍能读)要等 T-15**。不阻塞 T-06,但 T-06 的 Evidence 里应当写明这一层限制,别声称已端到端验证。

---

## 5. 真实修改范围

### 5.1 T-06 允许写的文件(白名单,除此之外一律不许动)

| 文件 | 写什么 |
|---|---|
| `mail-worker/src/service/share-auth-service.js` | 闸门 + 流程重排 + 删 `recordAccess` + `denyQuota` 助手 + import 事件常量 |
| `mail-worker/test/share-auth-service.spec.js` | T-06 红→绿用例;`insertShare` 加 `credentialsVersion` 形参;D1 代理 helper;**改写 `:254-267` 的 AC-LIFE-14 用例** |
| (文档,按 §4.3 R1/R2 的裁决结果)`docs/specs/mailbox-share-capability/tasks.md` 与 `requirements.md` | **建议由主 AI 在派单前改完**,不要让执行者顺手改 spec |

### 5.2 精确改写序列(问题 1 后半 · 以 post-T-05 工作树为基准)

> 行号已在 T-05 的正式 commit **`c7789e6`** 上核实,是稳定值。执行者开工前跑一次 `git log --oneline -1` 确认 HEAD 仍是 `c7789e6`;若已前移则按符号名重新定位。

**Step 0 · 签名**:`establishSession(c, lid, sec, deps = {})`(`:256`)→ `establishSession(c, lid, sec, options = {})`。这是 `recon-w1-auth-chain.md` §2.2 与主 AI 已裁决的形状(T-07 的 `idempotencyKey`、T-08 的 `authKey` 都要进这个对象)。**T-06 落地时 `options` 暂无 T-06 自用的键**(注入靠 §3.3 的 D1 代理),但改名要在这一步做完,免得 T-07 再动一次签名。

**Step 1 · 保留不动**(`:257-270`):`isShareDisabled` 守卫、`lid`/`sec` 归一、读快照、`matchSec` 不可区分性、`loadLiveAccount`。**尤其:`:262-264` 的读快照必须保留** —— 它现在多承担一个职责,即向闸门提供 `row.credentialsVersion`(§2.5)。

**Step 2 · 在 `:269` 的 `assertAllowed` 之前插入快照侧配额日志**(§3.5):

```
const state = effectiveStatus(row, nowText());
if (state === 'ACCESS_LIMIT_REACHED') denyQuota(row.shareId, 'quota_snapshot');
assertAllowed(row, ESTABLISH_ALLOWED);          // 保留 T-05 原样,负责 REVOKED/EXPIRED/accountId
```

**Step 3 · 删除 `recordAccess`**(`:249-254`)整个函数,连同 `:272-279` 的 try/catch 与 `deps.recordAccess` 取值。

**Step 4 · 新增 `consumeSessionQuota(c, shareId, expectedCv, now)`**,放在原 `recordAccess` 的位置。用 drizzle,写法照抄仓内先例 `verify-record-service.js:62-65`(同为「多谓词 `and` + `sql` 模板自增 + `.returning()`」),收尾用 `.returning({ accessCount: mailShare.accessCount })` 取数组而非 `.get()`(判空语义见 §2.7):

```
and(
  eq(mailShare.shareId, shareId),
  eq(mailShare.status, 'ACTIVE'),
  gt(mailShare.expiresAt, now),
  eq(mailShare.credentialsVersion, expectedCv),
  or(isNull(mailShare.maxSessions), sql`${mailShare.accessCount} < ${mailShare.maxSessions}`)
)
```
`.set({ accessCount: sql`${mailShare.accessCount} + 1`, lastAccessAt: now })`(§4.1 采纳 (A))。
需要新增的 drizzle import:`and` / `gt` / `isNull` / `or`(当前该文件 `:1` 只 import 了 `eq, sql`)。

**Step 5 · 闸门与 `issueToken` 换位**(§2.8),替换原 `:271-279`:

```
const now = nowText();
const applied = await consumeSessionQuota(c, row.shareId, row.credentialsVersion, now);
if (!applied.length) denyQuota(row.shareId, 'quota_race');
const sessionToken = await issueToken(c, row);
```

**Step 6 · 返回体不变**(`:280-284`)。`{ sessionToken, mailbox: accountRow.email, expiresAt: row.expiresAt }` —— session 响应扩四件(`shareType`/`mailboxes`/`config`)是 **T-08** 的活,T-06 不碰。

**Step 7 · 新增文件内助手** `denyQuota(shareId, reason)`:`logShareEvent(SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId, reason })` 然后 `throwUnavailable()`。import 见 §3.4。**fields 里绝不放 `sec`/`lid`/token**(AC-LEAK-05,§3.5)。

**Step 8 · `resolveSession`(`:287-308`)零改动。** 它是 T-05 的成果,也是 T-08 的战场,T-06 只读不写。

**Step 9 · 默认导出对象(`:310-315`)零改动。** `recordAccess` 本来就没导出,删它不影响外部契约。

### 5.3 T-06 该写哪些红灯用例(问题 2 后半)

按 `tasks.md:100` 逐条落地,标注每条该用哪个 helper、以及它**为什么在实现前会红**:

| # | 用例 | 用什么 helper | 断言 | 覆盖 AC | 红在哪 |
|---|---|---|---|---|---|
| 1 | 成功建会话 `access_count` 恰 +1 | `insertShare({maxSessions:5})` | `access_count===1`;`last_access_at` 非空 | AC-SESS-01 | 不红(回归护栏,钉住 (A) 方案下 `last_access_at` 仍被写) |
| 2 | **并发抢最后名额** | `insertShare({maxSessions:3, accessCount:2})` + `Promise.allSettled`×6 | 恰 1 成功;`access_count===3` | AC-EDGE-02 · P-SESS-01 | **真红**:`PROBE_R2` 实测当前 6 成功 / `access_count===8` |
| 3 | 空闲配额并发不超发 | `{maxSessions:3, accessCount:0}` ×8 并发 | 恰 3 成功;`access_count===3` | AC-SESS-07 | **真红**:同上机制 |
| 4 | 触顶拒发零变更 | `{maxSessions:1, accessCount:1}` | 字节相同 `SHARE_UNAVAILABLE`;`access_count` 不变 | AC-SESS-07 | 不红(T-05 的 `assertAllowed` 已覆盖)——**保留为回归护栏,并加断言:日志里出现 `share.session.denied_quota`** ← 这半边红 |
| 5 | 撤销 / 过期拒发零变更 | `{status:'REVOKED'}` / `{expiresAt:'2001-...'}` | 同上 | AC-EDGE-13 | 不红(护栏) |
| 6 | **cv 已变 → 拒发** | `insertShare({credentialsVersion: 7})` ← **需扩形参** | 拒发;`access_count===0` | AC-SESS-01 | **真红**:当前无 cv 谓词。注意 W1 内无 cv 写入方(T-16 才有),**必须直接种库造 cv** |
| 7 | **UPDATE 前状态变更注入 → 正确拒发** | `ctx({ db: injectingDb(env.db, { before: revoke }) })`(§3.3) | 拒发;`access_count===0` | AC-EDGE-13 | **真红**:`PROBE_S2` 验证机制可行 |
| 8 | **UPDATE 后 TOCTOU 注入 → 首次回源失败、名额不退还** | 同上,用 `after` 钩子 | `establishSession` 返回 token;随后 `resolveSession` 抛 `SHARE_UNAVAILABLE`;`access_count===1` **不回退** | AC-EDGE-13 | **真红**:`PROBE_S3` 验证 |
| 9 | **配额 UPDATE 失败 → 拒发**(改写后的 AC-LIFE-14) | `ctx({ db: injectingDb(..., { before: throw }) })` | 抛出;`access_count===0`;**零 token** | §4.3 R2 的新 AC | **真红且是语义反转**:`spec:254-267` 现在断言的是「仍签发」 |
| 10 | 读请求零配额消耗 | 已建会话 + `resolveSession`×N + `/share/mails`、`/share/mail` | `access_count` 恒定 | AC-SESS-02 · AC-EDGE-01 | 不红(护栏)。**收窄掉 status 端点(§2.4);建议补一条 `?raw` 源码断言钉死 resolveSession 之后无写语句** |
| 11 | `max_sessions IS NULL` 不受闸门约束 | `insertShare({})` 默认 | 连建 3 次全成功;`access_count===3` | AC-SESS-01 | 不红(护栏)。**必须有** —— 这是「不破既有无限额分享」的底线 |

**第 9 条要特别说明**:它是唯一一条**改写而非新增**的用例。现文 `spec:254-267` 用 `deps.recordAccess` 注入抛错并断言仍签发。改写后 seam 从 `deps` 换成 D1 代理,断言从「仍签发」翻成「拒发 + 零 token + 零消耗」。执行者要在 Evidence 里显式记一句「本条为语义反转,依据 §4.3 R2 的裁决」,不要静默改掉。

---

## 6. 可执行拆分(问题 7)

### 6.1 结论:**T-06 是一个不可再分的工作包,派一个执行者。**

逐个候选切法反证:

| 候选切法 | 为什么不行 |
|---|---|
| 「闸门 SQL」/「日志」分两人 | `denyQuota` 有两个调用点,其中一个(`quota_snapshot`)在闸门**之前**、另一个在闸门**之后**(§3.5)。两人会同时重排 `establishSession:256-285` 这同一段线性流程。 |
| 「生产代码」/「测试」分两人 | TDD 红→绿是同一人的单次循环;而且测试侧要写 D1 代理 helper(§3.3),它的正则必须匹配生产侧实际生成的 SQL(`PROBE_S1` 的语句形状),两边强耦合。 |
| 「并发用例」单独派 | 并发用例是驱动闸门实现的**主红灯**(`PROBE_R1`:6 vs 1),它和实现是一体的。 |
| T-06 与 T-07 并行 | `recon-w1-auth-chain.md` §6.1 已逐对论证:T-07 的 KV early-return 插在 T-06 闸门**之前**,是同一函数体的控制流嵌套。结论不变。 |

### 6.2 工作包表

| 包 | 范围(文件) | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|
| **T-06-P0(前置 · 主 AI 自己做)** | `tasks.md:100,104,114`、`requirements.md`(新增 AC)、旧 charter `mail-share/requirements.md:120` 追加 superseded 注 | 关掉 §4.3 R1 三处文档矛盾 + R2 的 AC 归属裁决 | 无(T-05 已 commit `c7789e6`) | — | 0(主 AI) |
| **T-06-A(唯一执行包)** | `src/service/share-auth-service.js`、`test/share-auth-service.spec.js` | §5.2 九步 + §5.3 十一条用例 | T-06-P0 | ❌ | 1 |
| **T-06-B(验收 · 主 AI)** | 无(只跑) | `pnpm --dir mail-worker test` ≥ 17 files / 185 tests 且 EXIT=0 | T-06-A | — | 主 AI |

### 6.3 与其它任务的并行度(在 T-06 期间)

| 任务 | 能不能与 T-06 并行 | 依据 |
|---|---|---|
| **T-07 / T-08** | ❌ | 同一函数体串行,`recon-w1-auth-chain.md` §6.1 |
| **T-10**(`share-scoped-email-repository.js` + 其 spec) | ✅ **有条件** | 与 T-06 白名单零重叠。前置条件不变(见 `recon-w1-auth-chain.md` §7.3):ShareContext 兼容标量已裁决(主 AI 已定「保留 `bindings[0]` 派生标量至 T-11」,`tasks.md:281`)、T-10 的 spec 自造 ctx、且必须与 T-08 同批验收 |
| **T-12** | ✅ **现在可以了** | `recon-w1-auth-chain.md` §7.3 当时判定「卡在 W0 未提交的 `mail-share-service.js`」。**该阻塞已解除**:W0 全部 commit 于 `e878760`,当前 `git status` 中 `mail-share-service.js` 干净。T-12 与 T-06 白名单零重叠,可起跑 |
| **T-14** | ❌ | 抢 `share-api.js`(W1 的 T-07/T-08 要写 `:54-58`) |

---

## 7. 风险交叉区 + 对主 AI 的派发建议

### 7.1 文件冲突图:T-06 写什么 vs T-05 刚写完什么(问题 5)

| 文件 | T-05 已写(**已 commit `c7789e6`**) | T-06 要写 | 冲突判定 |
|---|---|---|---|
| `src/service/share-auth-service.js` | `:25-38` 四态分支 · `:230-231` 两张 allow list · `:233-239` `assertAllowed` · `:269` establish 改调 · `:299,306` resolve 改调 | `:1` 加 drizzle import · `:249-254` **删 `recordAccess`** · 同位置新增 `consumeSessionQuota` + `denyQuota` · `:256-285` **重排 establishSession** · 新增 `mail-share-service` import | **无内容冲突,但严格串行**。T-06 只碰 `:249-285`;T-05 的 `:25-38` / `:230-239` / `:299-306` **T-06 一行都不改**。`:269` 是唯一相邻点:T-05 刚把它改成 `assertAllowed(...)`,T-06 在它**上方**插两行(§5.2 Step 2),不改它本身 |
| `test/share-auth-service.spec.js` | `:2` import fast-check · `:98-137` `insertShare` 加 `maxSessions`/`accessCount` · `:355-491` 新增 5 条用例 | `:98-137` **再加 `credentialsVersion`**(同一函数,同一模式)· 新增 D1 代理 helper · 追加 §5.3 的 8 条新用例 · **改写 `:254-267`** | ⚠️ **两处真实交叉**:① `insertShare` 工厂两人先后改同一函数 —— T-06 照 T-05 的动态列拼接模式追加即可,零结构冲突;② `:254-267` 是 T-05 **明确未动**的老用例(`exec-t05-note.md:56` 逐字确认「AC-LIFE-14 用例未改」),由 T-06 独占改写 |
| `package.json` | `:14` `"fast-check": "4.9.0"` | **零改动** | ✅ T-05 已装好。**T-06 绝不能再跑 `pnpm add`**,否则重写 lock |
| `pnpm-lock.yaml` | T-05 的 `pnpm add` 产物 | **零改动** | ✅ 同上 |
| `src/service/mail-share-service.js` | 零(W0 `e878760` 已入库) | **只读 import**,零改动 | ✅ 单向只读,不占写权 |
| `src/api/share-api.js` | 零 | **零改动**(T-07/T-08 才写 `:54-58`) | ✅ |
| `test/mail-share-service.spec.js` | 零 | **零改动**(§3.4:常量不搬家) | ✅ |
| `test/setup.js` | 零 | **零改动**(§3.1:不用 `seedShareRow`) | ✅ |

**一句话**:T-05 与 T-06 在 `share-auth-service.js` 上是**上下半场**关系 —— T-05 改的是**判定层**(`:25-239`),T-06 改的是**执行层**(`:249-285`),中间只有 `:269` 一个接缝,且 T-06 只在其上方插入。**前提是严格串行**:T-05 必须先 commit,T-06 再起跑。

### 7.2 会被误伤的三道既有护栏(T-06 必须知道)

| 护栏 | 位置 | 会不会被 T-06 踩 |
|---|---|---|
| **`row.accountId` 读取数冻结为 4** | `mail-share.schema.spec.js:143-147`,正则 `/\brow\.accountId\b\|\bmailShare\.accountId\b\|mail_share\.account_id\|\bms\.account_id\b/g` 扫 `share-auth-service.js?raw` | **不会,但只在用 drizzle 写闸门的前提下**。闸门谓词只涉及 `shareId`/`status`/`expiresAt`/`credentialsVersion`/`accessCount`/`maxSessions`,零 `accountId`。⚠️ **若执行者改用手写 raw SQL 且写成 `WHERE mail_share.account_id ...` 之类,立刻破这条护栏** —— 又一个用 drizzle 的理由(§2.7) |
| **AC-LEAK-05 日志不含 sec/token** | `share-auth-service.spec.js:282-303`,同时接管 `console.log` 与 `console.error` | ⚠️ **会,如果 `denyQuota` 的 fields 里放了 `lid`/`sec`。只放 `shareId` + `reason`**(§3.5) |
| **P-AUTH-01 六路失败包体字节相同** | `share-auth-service.spec.js:140-174` | **不会**。`denyQuota` 抛的仍是 `throwUnavailable()` → `BizError('SHARE_UNAVAILABLE')`,包体不变。该用例的六条路径也都不经过闸门(全部在快照校验阶段就被拒) |

### 7.3 派发建议(给主 AI 的执行顺序)

1. **T-05 已 commit(`c7789e6`),这道前置已自然关闭**,本报告的 post-T-05 锚点已在该 commit 上核实,T-06 可直接开工。
2. **关掉 §4.3 R1(三处 tasks.md 矛盾)与 R2(AC-LIFE-14 归属)两道门**,再派 T-06。R1-a 与派单裁决直接冲突,不改就是明知故派。
3. **顺手裁一下 R3**(`denied_quota` 打一处还是两处),一句话的事,省得执行者停下来问。
4. **T-06 派一个执行者,不拆**(§6.1)。
5. **并行位现在有两个**:T-10(需先满足 `recon-w1-auth-chain.md` §7.3 的两个前置)与 **T-12(阻塞已解除,W0 已于 `e878760` 全量入库)**。T-14 仍不可放。
6. **写进 T-08 的输入**:① `last_access_at` 已进闸门,establish 路径无 fire-and-forget 库写,T-08.1 的「统计写失败仍签发」改挂 T-07 的 KV 写(§4.1);② `share-attachment-service.js` 的 `effectiveStatus !== 'ACTIVE'` 硬判定必须随 ShareContext 冻结一起处置(§4.3 R4)。
7. **写进 W2 收口的输入**:把 `SHARE_EVENT`/`logShareEvent` 抽到 `src/const/share-event.js`,消掉 §3.4 引入的 service↔service 循环(§4.2)。

---

## 8. Domain-Model 对账

`docs/` 下只有 `architecture/` 与 `specs/`,**`docs/domain/` 不存在**(实测 `ls docs/`)。与 `recon-w1-auth-chain.md` §8.4 的结论一致:本 charter 的 `design.md` 已承担 domain-model 职责 —— 状态机(`design.md:246-274`)、精确语义表(`:276-292`)、形式化前后置条件(`:353-358`)三件齐全。**不另建 `docs/domain/share-model.md`。**

T-06 对该模型的对账:

| 维度 | design.md 的约定 | T-06 实现 | 判定 |
|---|---|---|---|
| 配额消耗事件 | 唯一事件 = 成功建立 Session(`:283`) | 闸门命中即 +1,读路径零写 | **[match]** |
| 线性化点 | 条件 UPDATE 成功时刻(`:280` R2-A3) | 单语句 UPDATE...RETURNING | **[match]**,`PROBE_Q1` 实测 |
| 状态机 | REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE(`:262`) | 闸门 WHERE 与 T-05 的 `effectiveStatus` 严格互补 | **[match]**,§2.6 逐条实测 |
| 不可恢复性 | 累计上限,无滑动窗口(`:286`) | `access_count` 单调 +1,无重置路径 | **[match]**(重置只在 T-13 的 `resetUsedSessions`) |
| `last_access_at` 归属 | 在闸门 SQL 内(`:280`) | 采纳 (A),进闸门 | **[match]** —— 但 `tasks.md:104` 说反了,**[需改文档]**,§4.3 R1-a |
| cv 谓词 | `credentials_version = :cv`(`:280`) | 进闸门 WHERE,cv 取自读快照 | **[match]**;W1 内无写入方(T-16 才有),测试直接种库 |
| 跨切维度表(新写路径需登记) | `design.md` Link table | T-06 不新增 job/接口/实体,只把既有写路径收紧为条件写 | **不适用**(无新行要加) |

**无 [invariant violated]。** 唯一的模型级偏差是文档内部矛盾(`tasks.md:104` vs `design.md:280`),已在 §4.3 R1 列为待改项。

---

## 9. 链路完整性扫描(§0.16 · T-06 交付契约的唯一权威来源)

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| `max_sessions` 列值 | Owner create/update(**to-build,T-12/T-15**) | 闸门 WHERE(to-build,T-06)· `effectiveStatus`(`share-auth-service.js:32-36`,T-05 已落) | ⛔ **断:W1 内无生产者**。T-06 只能靠测试直接种库(`insertShare({maxSessions})`,`spec:104-133` 已就位)。**不是 T-06 的洞**,记为 §4.3 R5 |
| `credentials_version` 列值 | `POST /mailShare/resetAuthKey`(**to-build,T-16 · W3**) | 闸门 WHERE(to-build,T-06)· resolveSession 回源比对(to-build,T-08) | ⛔ **断:W1 只有读侧**。W1 期间 cv 恒 0(`entity/mail-share.js:31` default 0)。T-06 的 cv 用例**必须直接 UPDATE 库造 cv**,不要去找一个还不存在的接口 |
| `access_count` +1 | 闸门 UPDATE(to-build,T-06) | Owner 列表 `usedSessions`(to-build,T-15)· `effectiveStatus`(`:32-36`,已在) | ⚠️ **半断**:JS 侧消费者已在(T-05),API 侧消费者在 T-15。T-06 内可自闭合验证(直读 `env.db`) |
| `last_access_at` | 闸门 UPDATE(to-build,T-06) | Owner 列表 `lastAccessAt`(to-build,T-15,`design.md:301`) | ⛔ 断:消费者在 W3。T-06 内断言「非空字符串」即可(`spec:276-280` 已有先例) |
| RETURNING 空 → 拒发 | 闸门(to-build,T-06) | `establishSession` 自身(to-build,T-06) | ✅ **同任务内自闭合**。判定形状已实测(`PROBE_Q2`:命中长度 1 / 未命中长度 0) |
| `share.session.denied_quota` 事件 | `denyQuota`(to-build,T-06)×2 处 | `logShareEvent`(`mail-share-service.js:73-82`,**已在**)→ stdout | ✅ **消费者已就位**。常量 `mail-share-service.js:28` 已在,形状被 `mail-share-service.spec.js:635-668` 冻结 |
| token 签发时序 | 闸门命中后 `issueToken`(to-build,T-06) | `resolveSession` 回源(`share-auth-service.js:287-308`,T-05 已落) | ✅ 自闭合 |
| `deps.recordAccess` 注入 seam | `spec:259-263`(**现存**) | `share-auth-service.js:273`(现存) | ⛔ **T-06 双侧同时删除**。删生产侧而漏删测试侧 = 测试静默失去注入能力(传一个没人读的 key,用例假绿)。**这是 T-06 最容易漏的一处 CCV** |
| D1 代理注入 seam | `ctx({ db })`(`spec:35-37` 已支持) | `orm(c)` → `drizzle(c.env.db)`(`entity/orm.js:4`) | ✅ **通路已在,零生产改动**。`PROBE_S1` 实测 drizzle 的语句确实经过代理 |

**成功状态取源(下游消费者的真实前置条件,均可独立核验,带 `file:line`)**:

- 闸门放行的充要条件 = `status='ACTIVE'` ∧ `expires_at > now` ∧ `credentials_version = :cv` ∧ (`max_sessions IS NULL` ∨ `access_count < max_sessions`) —— `design.md:280` 原文;实测互补性见 §2.6
- 判定「命中」的形状 = `.returning()` 数组长度 ≥ 1(drizzle)/ `meta.changes === 1`(raw)—— `transaction.spec.js:94,102` + 本次 `PROBE_Q2`
- 读路径零配额的结构性根据 = 全部 `share-*` 服务中唯一写语句在 `share-auth-service.js:250`,四条读端点均只经 `resolveSession`(`share-api.js:62,73` · `share-attachment-service.js:96`)
- 失败包体恒为 `{code:501, message:'SHARE_UNAVAILABLE'}` —— `error/biz-error.js` 默认 501 + `model/share-result.js`;P-AUTH-01 字节相等断言(`share-auth-service.spec.js:169-173`)依赖此
- `row.accountId` 读取数必须恰为 4 —— `mail-share.schema.spec.js:146`
- 日志不得含 `sec`/token(同时覆盖 `console.log` 与 `console.error`)—— `share-auth-service.spec.js:282-303`

---

## 10. 给主 AI 的执行摘要

1. **T-05 已 commit(`c7789e6`),16/16 绿,T-06 可立即开工。** 本报告全部 post-T-05 行号已在该 commit 上核实。§7.1 给出两人在 `share-auth-service.js` 上的上下半场分工:T-05 占判定层(`:25-239`),T-06 占执行层(`:249-285`),唯一接缝在 `:269` 且 T-06 只在其上方插入。
2. **派发前关三道门**:`tasks.md:100/104/114` 三处与已裁决实现矛盾(§4.3 R1);AC-LIFE-14 其实属于**上一份 charter**,「改写」该落在哪份文档上要拍板(§4.3 R2);`denied_quota` 打一处还是两处(§4.3 R3)。
3. **`last_access_at` 进闸门(方案 A)**,五条证据见 §4.1;连带后果是 T-08.1 的「统计写失败仍签发」必须改挂 T-07 的 KV 写。
4. **并发测法已实测可行且红灯是真红**:当前代码 6 路并发对 `max_sessions=1` 发出 **6 张 token**(`PROBE_R1`)。**串行 `await` 写的抢名额用例是假绿**(`PROBE_R3` 恰好 1),这条务必写进派单。
5. **TOCTOU 注入不需要新的生产 seam**:`ctx({ db: <代理> })` 即可,四条探针全绿(§3.3)。同时 `deps.recordAccess` 老 seam 要生产侧与测试侧**同时**删干净(§9 最后一行)。
6. **用 drizzle `.returning()` 写闸门**,不要手写 raw SQL:已实测可用(§2.7),且能避开 `mail-share.schema.spec.js:146` 的源码正则护栏(§7.2)。
7. **事件常量直接 import,不搬家**:循环 import 已实测两个入口顺序都安全(§3.4);搬家会打 `mail-share-service.spec.js`,出车道。清理留给 W2(§4.2)。
8. **并行位**:T-10(前置条件同 `recon-w1-auth-chain.md` §7.3)与 **T-12(阻塞已解除 —— W0 已于 `e878760` 全量入库,`mail-share-service.js` 工作树干净)**。T-07/T-08/T-14 仍不可并行。

---

## Update Log

- 2026-08-24 · plan-reality-recon(Mode R):T-06 配额闸门侦察落盘,只服务 T-06,未改写 `recon-w1-auth-chain.md`。侦察期间 T-05 由并行执行者完整落地并于收尾时 commit 为 `c7789e6`,本报告同时给出 pre-T-05(HEAD `3834456`)与 post-T-05(`c7789e6`,**已二次核实,为稳定值**)双套锚点。核实 9 条计划假设 → 5 处 deviation,其中 2 处 P0:①`tasks.md:104`「`last_access_at` 保持 fire-and-forget」与 `design.md:280` 原文直接矛盾;②AC-LIFE-14 / AC-LIFE-10 实为**上一份 charter**(`docs/specs/mail-share/requirements.md:120-121`)的 AC,本 charter requirements.md 无 AC-LIFE-14 且 AC-LIFE-10 同名异义 —— 「改写 AC-LIFE-14」的落点需拍板。另发现 A5 的 status 端点在 T-06 时点不存在需收窄、`issueToken` 必须与闸门换位、`denied_quota` 有两个触发点(只打一个则日常触顶零日志)。为取证跑了 5 个临时探针 spec(**已全部删除**,`git status` 已复核):`PROBE_Q1-Q5` 钉死闸门谓词与 `RETURNING` 语义;`PROBE_S1-S4` 证明 `ctx({db:代理})` 可在零生产改动下注入 UPDATE 前/后/失败三态;`PROBE_R1-R3` 证明本机 Miniflare D1 真会交错(6 路并发对 `max_sessions=1` 发出 6 张 token,串行则恰 1)——**串行写法是假绿**,这是本次最重要的单条发现。内部复用扫描找到关键先例:`verify-record-service.js:62-65` 已是「多谓词 `and` + `sql` 自增 + `.returning()`」的同构写法(全仓 `.returning(` 14 处,其中 `update().returning()` 5 处),T-06 不必自创写法,也不必降级到手写 raw SQL;并钉死 `.returning({cols})` 返回空数组 vs `.returning().get()` 返回 `undefined` 两种判空语义,推荐前者。事件常量 `SHARE_EVENT.SESSION_DENIED_QUOTA` 与 `logShareEvent` 已由 T-03 落在 `mail-share-service.js:27-34,73-82`,反向 import 形成的 A↔B 循环经同形状探针实测在两个入口顺序下均安全(双向引用均在函数体内,无顶层解引用),裁决为直接 import 不搬家(搬家会打 `mail-share-service.spec.js:635` 的冻结断言、出车道)。外部核 Cloudflare 官方文档确认 D1 读复制需显式 `withSession()`,本仓命中 0,快照不会陈旧,且单语句闸门天然抗复制。零业务代码改动、零 commit。
