# Recon · T-19 Checkpoint 后端收口 + share-integration 多邮箱/配额/AuthKey 扩展

| 字段 | 值 |
|---|---|
| 范围 Scope | T-19(W3 收口 checkpoint),`docs/specs/mailbox-share-capability/tasks.md:434` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`,HEAD `af94a22`(T-17 `d18f027` 已入库,T-18 未入库);工作树无生产代码改动 |
| 侦察日期 | 2026-08-24 |
| 依据 AC | AC-CAP-01/02/03/05/07、AC-BIND-02/03/04/08、AC-MAIL-01/02/08、AC-SESS-01/02/06/07/09/10、AC-AUTH-01/02/07/08、AC-ADMIN-03/04/05/07/09、AC-EDGE-01/02/04/05/12/14、AC-LIFE-04/11、AC-SEC-09 |
| 热区状态 | T-19 只写 `mail-worker/test/share-integration.spec.js` **一个文件**。T-18 的四个文件(两生产两 spec)与之零交集 |
| 性质 | 只读侦察。**未改任何生产/测试/规格文件、未提交**;本文件是唯一产物 |

**基线已亲跑核实**(不是抄来的数字):`pnpm --dir mail-worker test` → **EXIT=0,18 文件 / 577 测试**,耗时 30.4s。与 `tasks.md:522` / `session-ledger.md:136` 记录的 18/577 一致。`share-integration.spec.js` 现 912 行 / 2 个 describe / **17 条用例**。

---

## 0. 一句话结论

现有 `share-integration.spec.js` 是一份**单邮箱、无配额、无 AuthKey** 的端到端卷:17 条用例里有 16 条只挂一个邮箱,唯一的双 Binding 用例(`:798`)还是**绕过 create API 直接 `INSERT INTO mail_share_binding`** 写出来的,所以「多邮箱经 HTTP 创建 → 访客合并读」这条主干**一次都没被端到端走过**;`maxSessions`/`ACCESS_LIMIT_REACHED` 与 AuthKey 在这个文件里的出现次数是 **0**(grep 逐字核实)。T-19 要补的不是零散断言,是三条从 Owner HTTP 写入贯穿到 Visitor HTTP 读取的**整链**。

三条必须先知道的物理事实,否则新用例会以最难查的方式假绿或假红:

① **多邮箱 create、`authKeyEnabled`、`maxSessions`、`messageLimit`、bindings 1→N、`resetAuthKey enable` 六条写入路径全部被 `SHARE_CAPABILITY_V2` 栅栏挡着**(`mail-share-service.js:355-366,904-909,1045-1046,1277-1278`),而 `wrangler-vitest.toml:41` 的基线是 `"false"`。也就是说 T-19 的**几乎每一条**新用例都必须先翻开关。

② **翻开关必须走 `jsonWorker`(`worker.fetch(req, env)`),不能走 `jsonApi`(`SELF.fetch`)**。改测试进程里的 `env` 对象不会传导给 `SELF.fetch` 派发的那个 Worker 实例 —— 这条已被 T-16 用血换出来并写成裁决 T16-HTTP(`session-ledger.md:115`),范本在 `mail-share-service.spec.js:3260-3272`。好消息:这个文件里 `jsonWorker` 已经现成(`:71-98`),且已被证明可以和 `jsonApi` 的响应混进同一个 `expectIdenticalUnavailable`(`:389-402`)。

③ **「多邮箱删掉其中一个邮箱」这条用例今天必红,且红的原因是 T-18 还没做**(级联仍是纯主表 `account_id` 直查,删主 Binding 的邮箱会把整条多邮箱分享撤掉)。它属于 T-18.1 的红灯,**不属于 T-19**。T-19 若把它写进来,就是把 checkpoint 的绿灯换成别人任务的红灯。

---

## 1. 问题直答(六问)

| # | 问题 | 结论 | 详见 |
|---|---|---|---|
| 1 | 现有 spec 覆盖什么、缺什么 | 覆盖单邮箱访客全链 + 幂等 + 索引计划 + 开关 + 撤销密封;**多邮箱经 API 创建 = 0、配额 = 0、AuthKey = 0、bindings 增删 = 0、Owner get/update/delete 三个端点 HTTP 面 = 0** | §2 |
| 2 | T-19 允许碰哪些 worker 文件 | **只有 `mail-worker/test/share-integration.spec.js` 一个**。不需要 fixtures 改动(`test/setup.js` 的 `seedShareRow`/`seedBindingRow` 本文件用不上 —— 它全程走 HTTP,直接写库反而会绕开被测的栅栏) | §7 |
| 3 | 与 T-18 是否撞车 | **零交集**。T-18 写 `mail-share-service.js` / `mail-share-cleanup-service.js` / `account-delete-share.spec.js` / `mail-share-cleanup.spec.js`;T-19 写 `share-integration.spec.js`。唯一耦合是**全量绿的时间点**与一条 gated 用例 | §8 |
| 4 | 单测已覆盖 vs 集成缺口 | 三条能力的**服务层**都已被单测钉死(`mail-share-service.spec.js` 3301 行、`share-auth-service.spec.js` 1871 行);缺的全是**HTTP 面 + 跨端点串联**。`AC-ADMIN-10` perm 面已由 `security-share.spec.js:209-238` 覆盖,**T-19 不要重复补** | §3 |
| 5 | 命令与基线 | `pnpm --dir mail-worker test` = 18/577(亲跑 EXIT=0);`pnpm --dir mail-vue test` = 17/95;`node tests/e2e/run.mjs` = 13(后两者取 `tasks.md:522`) | §6 |
| 6 | 是否等 T-18 APPROVED | **收口跑与勾选:等。起草与写码:三组里有两组半可以先写**(不含 account 删除的部分 100% 落在已入库 API 上) | §8 |

---

## 2. 现有 `share-integration.spec.js` 覆盖面盘点

### 2.1 逐条清点(17 条)

`describe('T-24 mail share backend integration')` — 13 条(`:279-773`):

| # | 行 | 用例 | 邮箱数 | 备注 |
|---|---|---|---|---|
| 1 | `:280` | 访客全链 + revoke 后四路密封 | 1 | 含 `assertSecAbsentFromDatabase`、附件字节、OTP `code` |
| 2 | `:363` | 九种非法输入字节级同形 `SHARE_UNAVAILABLE` | 1 | 含 `SHARE_ENABLED=0`(经 `jsonWorker`) |
| 3 | `:405` | `account_id=0` / 中途写入 / 窗口下 / 他箱邮件全部隔离 | 1 |  |
| 4 | `:466` | 轮询查询走 `idx_email_account_id_email_id` | 1 | EXPLAIN QUERY PLAN |
| 5 | `:543` | Owner 列表走 `idx_mail_share_user_id_status` | 1 |  |
| 6 | `:576` | 并发 create 不超 `SHARE_ACTIVE_LIMIT` | 1 |  |
| 7 | `:603` | `Idempotency-Key` 重放 + 异体冲突 | 1 |  |
| 8 | `:623` | 同 key 并发 create 只出一条分享 | 1 |  |
| 9 | `:645` | 无 cron 计算过期 + Owner 列表仍显 `effectiveStatus=EXPIRED` | 1 |  |
| 10 | `:679` | 开关关→开,老链接恢复 | 1 |  |
| 11 | `:700` | **删邮箱后访客同形失败 + 行 REVOKED** | **1** | ← 单邮箱路径,T-18 不会改动它的期望 |
| 12 | `:721` | 访客 token 打五个写端点全 401 | 1 |  |
| 13 | `:749` | 重连重读同游标不重复 | 1 |  |

`describe('GET /share/mailboxes/status')` — 4 条(`:778-912`):

| # | 行 | 用例 | 邮箱数 | 备注 |
|---|---|---|---|---|
| 14 | `:798` | 一次轮询回答全部 Binding 的水位、零配额 | **2** | 🔴 第二条 Binding 由 `addBinding()`(`:779-786`)**直接 INSERT**,注释自陈「多邮箱 create 走 V2 栅栏」 |
| 15 | `:826` | 游标形参不改变水位 | 1 |  |
| 16 | `:848` | 窗口外/滚出/他箱不推水位 | 1 | `message_limit` 也是**直接 UPDATE 写库**(`:853`) |
| 17 | `:889` | revoke 后 status 与其它路由同形密封 | 1 |  |

### 2.2 缺口(用户点名的五项,逐项判定)

| 项 | 现状 | 判定 |
|---|---|---|
| **多邮箱** | 只有 #14 有两条 Binding,且**绕过 create API 直插库**;`createShare()`(`:212-224`)只发单个 `accountId`,从不发 `accountIds` | 🔴 **完全缺失**。经 `POST /mailShare/create {accountIds:[X,Y]}` 的整链(响应 `shareType='multi'`/`bindings`、session `mailboxes` 两条、`/share/mails` 合并两箱)零覆盖 |
| **配额 `maxSessions` / `ACCESS_LIMIT_REACHED`** | 全文件 grep `maxSessions`/`ACCESS_LIMIT_REACHED`/`usedSessions` → **0 命中** | 🔴 **完全缺失** |
| **AuthKey enable/reset/disable** | 全文件 grep `authKey`/`auth_key` → **0 命中**;`openSession()`(`:226-230`)不发 `authKey` | 🔴 **完全缺失** |
| **bindings 增删(`PUT /mailShare/bindings`)** | 零调用 | 🔴 **完全缺失**。AC-BIND-08「下一次拉取即刻生效、不依赖 Session 重建」在 HTTP 面无证据 |
| **级联残留(删邮箱后 Binding 剩余)** | #11 是单邮箱,断言只看 `mail_share.status`,不看 `mail_share_binding` 行数 | 🟡 **归 T-18**(`account-delete-share.spec.js` 是它的主场);T-19 只在 T-18 入库后加**一条**多邮箱 HTTP 面回归,见 §5-A8 |

另外两个**未被用户点名但同样为零**的 HTTP 缺口,建议顺手收进来(它们与三条主线共用同一批脚手架,边际成本极低):

- `GET /mailShare/get` 与 `PUT /mailShare/update` 与 `DELETE /mailShare/delete` 三个端点**在本文件里一次都没被调用过**(T-15 的单测覆盖在 `mail-share-service.spec.js`,HTTP 面只在那里零星验过)。配额组的 B5 与多邮箱组的 A7 天然会用到它们。
- `AC-ADMIN-09`「非 ACTIVE 计算态仍在列表里可审计」现只覆盖 `EXPIRED`(#9),`ACCESS_LIMIT_REACHED` 一态无覆盖。

---

## 3. 单测已有覆盖 vs 集成缺口(AC 对照)

**原则:T-19 补的是「跨进程边界 + 跨端点串联」,不是把单测再抄一遍 HTTP 版。** 下表左列已绿的部分,新用例只需要**顺带经过**,不需要为它单列一条。

| 能力 | 单测已钉死的(不要重复) | 集成面真空(T-19 的目标) |
|---|---|---|
| 多邮箱 | `mail-share-service.spec.js` 的 create 多 `accountIds`、`SHARE_BINDING_LIMIT=50`、`SHARE_ACCOUNT_FORBIDDEN`、CAS 快照、绑定参数预算;`share-scoped-email-repository.spec.js` 的集合化 `inArray` + per-binding 下界 | ① `POST /mailShare/create` → `POST /share/session` → `GET /share/mails` 的**合并可见集与 DESC 次序**;② `PUT /mailShare/bindings` 后**同一 token 下一次拉取即刻生效**(AC-BIND-08);③ session 响应的 `mailboxes[]`(bindingId + 掩码地址)与 `/share/mails` 行上的 `bindingId` **互相对得上** |
| 配额 | `share-auth-service.spec.js`(32 处 `ACCESS_LIMIT_REACHED`/配额断言):`effectiveStatus` 优先级、条件 UPDATE 单一线性化点、`RETURNING` 空即拒发、KV 幂等重放 | ① 经真实 HTTP 把配额**用光**并证明第 N+1 次 `POST /share/session` 失败而**既有 token 的 mails/status 仍 200**(AC-SESS-06 + AC-LIFE-04 的组合,这个组合只有集成面能证);② 轮询 N 次 `access_count` 不动(AC-EDGE-01);③ `PUT /mailShare/update` 设 `maxSessions` 后**配额纪元**对访客侧的实际效果(AC-EDGE-14 的端到端面) |
| AuthKey | `mail-share-service.spec.js:3167-3301`(服务层 + 三条 HTTP 面 resetAuthKey);`share-api.spec.js:363-410`(session 带 Key —— 但 `auth_key_hash` 是**直接 UPDATE 写进去的**,不是经 create/resetAuthKey 铸的) | ① **铸钥与验钥同源**:create/resetAuthKey 下发的明文,拿去 `POST /share/session` 真能过(今天没有任何一条用例把这两端接起来);② reset 杀 session 之后,**新 Key 重进要重新消耗一格配额**(AC-EDGE-05 后半句,与配额组交叉);③ 明文不出现在 `get`/`list` 投影与全库文本列(复用现成的 `assertSecAbsentFromDatabase`) |
| perm | ✅ `security-share.spec.js:209-238` 已覆盖八条路由 + `AC-ADMIN-10` | **无缺口 —— 不要补**。重复覆盖只会让 T-17 的围栏用例多一个漂移源 |

---

## 4. 🔴 写用例前必须知道的六条环境事实

**(E1) V2 栅栏拦的是六条写入路径,不是读路径。** 逐条位置:

```
mail-share-service.js:355-356   accountIds.length > 1        → MULTI_CREATE
mail-share-service.js:358-359   authKeyEnabled               → AUTH_KEY_ENABLE
mail-share-service.js:361-362   maxSessions != null          → FINITE_MAX_SESSIONS
mail-share-service.js:364-365   messageLimit != null         → MESSAGE_LIMIT
mail-share-service.js:904-909   update 设有限 maxSessions / messageLimit
mail-share-service.js:1045-1046 bindings 使 Binding 数变大且 > 1 → BINDING_EXPAND
mail-share-service.js:1277-1278 resetAuthKey action='enable'
```

拒绝码统一是 `SHARE_INVALID_CONFIG`。**访客侧读路径不过栅栏** —— session/mails/status/attachment 在 V2=false 下照常服务已经落库的多邮箱行。所以典型用例形状是:「翻开关 → 经 `jsonWorker` 写 → 关回去 → 经 `jsonApi` 读」,这样读侧顺带证明了「栅栏回退不影响已发出的链接」。

**(E2) `SELF.fetch` 看不见测试进程改的 `env`。** 必须 `jsonWorker`(`:71-98`,内部 `worker.fetch(new Request(...), env, {})`)。裁决 T16-HTTP,范本 `mail-share-service.spec.js:3260-3272`。**同时:`vitest.config.js:11-21` 是 `singleWorker: true`,env 是整个进程共享的**,翻开关必须 `try/finally` 还原,否则会污染同文件后续用例乃至同 worker 里的其它 spec 文件。

**(E3) `savedEnv`(`:30-33`)只存了 `SHARE_ENABLED` 与 `SHARE_ACTIVE_LIMIT`,没有 `SHARE_CAPABILITY_V2`。** 建议照现有形状把它加进 `savedEnv` 与 `cleanup()`(`:261-273`),这样即使某条用例中途抛异常,`afterEach` 也能兜住。这是对既有 helper 的**追加**,不改任何既有断言 —— 允许。

**(E4) Owner 的 perm 已经够用,不用改种子。** `seedUser(OWNER_EMAIL, 1)`(`:157`)给的是 `role_id=1`,而 `init.js:211-222` 把 `share:manage` 灌给了 role 1,`security.js:112-121` 让这把钥匙精确匹配八条路由。所以 `get`/`update`/`bindings`/`delete`/`resetAuthKey` 五个**本文件从未调用过**的端点,用现成的 `ownerJwt` 就能打通,不需要新种子。

**(E5) `cleanup()` 不删 `mail_share_binding`,也不删他人 user 的 account。** `:268-272` 删的是 `share_idempotency` / `mail_share` / `attachments` / `email` / `account`(按 `t24-` 前缀)。今天没炸是因为 `isolatedStorage` 默认每条用例回滚。但**一旦用例内自己造多条 Binding 再断言行数**,同一条用例内的后续断言会被上一步残留污染。建议在 `cleanup()` 里补一条 `DELETE FROM mail_share_binding WHERE share_id NOT IN (SELECT share_id FROM mail_share)`。新账号也必须走 `t24-*@example.com` 命名,否则漏出 `cleanup` 的 `LIKE` 网。

**(E6) 同一用户名下需要第三、第四个邮箱。** 现有常量只有 `MAILBOX`/`OTHER_BOX` 两个(`:10-11`),`insertAccount()`(`:161-169`)可以任意加,但记得前缀。多邮箱组要「加一个再删一个」,至少需要三个。

---

## 5. 推荐用例清单(命名 + 关键断言 + AC)

命名沿用本文件既有风格(小写祈使句 + 括注 AC)。**建议新开两个 `describe`,追加在文件末尾,既有 17 条一行不动** —— 与 T-14 追加 `describe('GET /share/mailboxes/status')`(`:775-778`)的做法同形。

### 5.1 组 A · 多邮箱端到端(建议 `describe('multi mailbox share over HTTP (T-19)')`)

| # | 用例名 | 关键断言 | AC |
|---|---|---|---|
| A1 | `creates a two mailbox share and merges both inboxes into one visitor list` | create 响应 `shareType='multi'` + `bindings` 两条;session 响应 `shareType='multi'`、`mailboxes` 两条且地址为**掩码**形状;`/share/mails` 同时含两箱邮件且按 `mailId` DESC;每行 `bindingId` ∈ session 的两个 bindingId | AC-CAP-01/02 · AC-MAIL-01 · AC-MAIL-08 · AC-SESS-09 |
| A2 | `applies each binding's own window lower bound` | 两箱各自在 create **之前**塞一封、**之后**塞一封;可见集恰是两封「之后」的,两封「之前」的一封都不出现(证明下界是 per-binding 而非单标量) | AC-CAP-07 · AC-MAIL-02 |
| A3 | `lets the owner add and remove a binding without the visitor rebuilding its session` | `PUT /mailShare/bindings {add:[Z]}` → **同一枚 sessionToken** 下一次 `/share/mails` 出现 Z 的新邮件、`/share/mailboxes/status` 多一条水位;`{remove:[bindingId(Y)]}` → 下一次拉取不含 Y 的任何邮件,且直接 `GET /share/mail?mailId=<Y 的>` 为 `SHARE_UNAVAILABLE` | AC-BIND-02/03/08 · AC-EDGE-04 · AC-MAIL-05 |
| A4 | `revokes the share when the owner removes the last binding` | 逐条 remove 到 0 → 响应 `status='REVOKED'`;访客四路(session/mails/mail/attachment)字节同形 `SHARE_UNAVAILABLE`;库里 `revoked_at` 非空 | AC-BIND-04 |
| A5 | `refuses the multi create and the 1 to N expansion while the capability flag is off` | 同样两个请求改走 `jsonApi`(V2=false 基线)→ `SHARE_INVALID_CONFIG`;`mail_share` 与 `mail_share_binding` **零新增行** | AC-LIFE-11 |
| A6 | `keeps a foreign mailbox out of a multi mailbox share` | `accountIds` 里混一个属于另一 user 的 accountId → `SHARE_ACCOUNT_FORBIDDEN`;**零部分写入**(该 lid 无 share 行、无 binding 行) | AC-CAP-03 · AC-BIND-10 |
| A7 | `deletes a multi mailbox share with all of its bindings and idempotency rows` | 带 `Idempotency-Key` 建多邮箱 share → `DELETE /mailShare/delete` → `mail_share` / `mail_share_binding` / `share_idempotency` 三表该 shareId 全部零行 | AC-ADMIN-07 |
| **A8** | `keeps a multi mailbox share alive when only one of its mailboxes is deleted` | ⛔ **gated on T-18**:删 X(多邮箱之一)后 share 仍 `ACTIVE`、访客仍能读 Y 的邮件、binding 只剩 Y。**T-18 入库并 APPROVED 之前不要写**(今天必红,且红的是 T-18 的账) | AC-BIND-05 · AC-EDGE-04 |

### 5.2 组 B · 配额端到端(建议并入 `describe('session quota over HTTP (T-19)')`)

| # | 用例名 | 关键断言 | AC |
|---|---|---|---|
| B1 | `stops issuing sessions at max_sessions while an already issued token keeps reading` | create `maxSessions=2` → 两次 `POST /share/session` 200、第三次 `SHARE_UNAVAILABLE`;**第一枚 token 的 `/share/mails` 与 `/share/mailboxes/status` 仍 200**;库里 `access_count=2` | AC-SESS-01/06/07 · AC-LIFE-04 |
| B2 | `never overshoots the last quota slot under concurrent session requests` | `maxSessions=1`,两路 `Promise.all` 并发 → 恰 1 成功 1 失败;`access_count=1` | AC-EDGE-02 · AC-SEC-08 |
| B3 | `replays one session Idempotency-Key on the last slot without consuming a second` | `maxSessions=1`,同一 `Idempotency-Key` 连发两次 → 同一个 `sessionToken`;`access_count` 恒 1(AC-SESS-10 原文点名「E2E SHALL 覆盖」这条) | AC-SESS-10 |
| B4 | `keeps polling free of quota` | 同一 token 连打 status/mails 各数次 → `access_count` 与 `last_access_at` 之外的配额量不变(注意:`last_access_at` **允许**变) | AC-EDGE-01 · AC-SESS-02 |
| B5 | `resets the quota epoch on the first finite max_sessions and honours resetUsedSessions=false` | 先建无限配额 share 并消耗 2 次;`PUT /mailShare/update {maxSessions:2}`(默认)→ `usedSessions=0`、`effectiveStatus='ACTIVE'`、访客可再建两次;另一条 share 提交 `{maxSessions:1, resetUsedSessions:false}` → 立刻 `effectiveStatus='ACCESS_LIMIT_REACHED'` 且 `POST /share/session` 被拒 | AC-EDGE-14 · AC-ADMIN-03/04 |
| B6 | `keeps the capped share visible and filterable in the owner list` | `GET /mailShare/list?status=ACCESS_LIMIT_REACHED` 命中该行;行上 `usedSessions`/`maxSessions`/`shareType` 齐全;整个响应体不含 `sec` 明文 | AC-ADMIN-01/09 |

### 5.3 组 C · AuthKey 端到端(建议并入 `describe('AuthKey over HTTP (T-19)')`)

| # | 用例名 | 关键断言 | AC |
|---|---|---|---|
| C1 | `mints an AuthKey at create and only lets the keyed visitor in` | create `{authKeyEnabled:true}` → 响应 `authKey` 匹配 `/^[A-Za-z0-9_-]{22}$/`;不带 Key / 带错 Key → `SHARE_AUTH_REQUIRED`(**不是** `SHARE_UNAVAILABLE`)且 `access_count` 不变;带正确 Key → 200 且 `access_count` +1 | AC-CAP-05 · AC-AUTH-01 · AC-EDGE-12 |
| C2 | `only reveals that a key is needed after lid and sec already matched` | 错 `sec` + 正确 Key、以及不存在的 `lid` + 任意 Key → 都是字节同形 `SHARE_UNAVAILABLE`;正确 `sec` + 无 Key 才是 `SHARE_AUTH_REQUIRED` | AC-AUTH-02 |
| C3 | `rotates the key over resetAuthKey and kills the live session on the spot` | `POST /mailShare/resetAuthKey {action:'reset'}` → 旧 token 的 mails/status 全 `SHARE_UNAVAILABLE`;旧 Key 建 session → `SHARE_AUTH_REQUIRED`;新 Key → 200,**且再消耗一格配额**(与 `maxSessions` 组合断言) | AC-ADMIN-05 · AC-EDGE-05 |
| C4 | `enables without retroactively killing a session and disables without asking for a key again` | 无 Key 的 share:建 session → `enable`(需翻开关)→ 旧 token 仍 200、新 session 要 Key;再 `disable`(**不需要**开关)→ 旧 token 失效、新 session 无 Key 也过、多余的旧 Key 被忽略不报错 | AC-AUTH-07/08 · AC-LIFE-11 |
| C5 | `never lets the AuthKey plaintext out of the minting response` | 明文不出现在 `GET /mailShare/get`、`GET /mailShare/list`、`POST /share/session` 响应体里;复用 `assertSecAbsentFromDatabase(authKey)`(`:240-259`)扫全库文本列 | AC-CAP-05 · AC-SEC-09 |
| C6 | `refuses enable but allows disable while the capability flag is off` | 经 `jsonApi`(V2=false)`action:'enable'` → `SHARE_INVALID_CONFIG` 且 `auth_key_enabled` 不动;同一上下文 `action:'disable'` 放行(AC-LIFE-10 路径③:不能把 Owner 锁死在关不掉的第二因子上) | AC-LIFE-11 |

### 5.4 建议不写的

- **perm / `SHARE_FORBIDDEN`**:`security-share.spec.js:209-238` 已覆盖八条路由。重复即漂移源。
- **`message_limit` 的 HTTP 面**:`share-status.spec.js:156` 与 `share-mail-service.spec.js` 已覆盖;#16(`:848`)在集成面也已借直写库覆盖了滚动语义。除非顺手(A1 里加一个字段),不单列。
- **任何 `account` 删除 / cleanup 相关**:归 T-18,见 §8。

**规模估计**:A 组 7 条(A8 gated)+ B 组 6 条 + C 组 6 条 = **19 条**,全量从 577 涨到 ~596。文件从 912 行涨到 ~1500 行 —— 已经接近本仓单 spec 的舒适上限,**不建议再往里塞**。

---

## 6. 命令与基线

```bash
# 定点(红→绿循环用)
pnpm --dir mail-worker exec vitest run test/share-integration.spec.js --no-cache

# 邻接回归(T-19 新用例最可能误伤的三个)
pnpm --dir mail-worker exec vitest run test/share-api.spec.js test/mail-share-service.spec.js test/security-share.spec.js --no-cache

# checkpoint 收口:三套全量
pnpm --dir mail-worker test        # 基线 18 文件 / 577(2026-08-24 亲跑 EXIT=0,30.4s)
pnpm --dir mail-vue test           # 基线 17 文件 / 95
node tests/e2e/run.mjs             # 基线 13
```

| 套件 | 基线 | 来源 |
|---|---|---|
| worker | **18 文件 / 577** | 本次侦察亲跑 `pnpm --dir mail-worker test` → EXIT=0;与 `tasks.md:522`、`session-ledger.md:136` 一致 |
| vue | **17 文件 / 95** | `tasks.md:522`(自 W0 起未变过,`setup.js:18-25` 记为历史地板) |
| E2E | **13** | `tasks.md:522` |

**地板规则**(`test/setup.js:18-25`):历史地板 worker 16/138、vue 17/95、E2E 13,**只增不减**。T-19 是纯加用例任务,worker 数只涨;vue 与 E2E 必须**分毫不动**(T-19 不碰前端)。

⚠️ **577 这个数会被 T-18 改掉**(T-18.1 要加 ~14 条到另外两个 spec)。T-19 的 Evidence 里写的必须是**自己跑那一刻**的数,并且这一刻应当在 T-18 入库之后 —— 否则清单上会留下两个互相矛盾的「全量」数字。

---

## 7. 文件白名单

### 7.1 允许写(1 个)

| 文件 | 改动 | 约束 |
|---|---|---|
| `mail-worker/test/share-integration.spec.js` | 末尾追加 2 个 `describe`(§5);`savedEnv`(`:30-33`)+`cleanup()`(`:261-273`)追加 `SHARE_CAPABILITY_V2` 还原与 binding 清理;`createShare()`(`:212-224`)可加 `accountIds`/`authKeyEnabled`/`maxSessions` 透传;`openSession()`(`:226-230`)可加 `authKey`/`Idempotency-Key` 可选参 | **现有 17 条用例的断言一字不改**。helper 只允许**加可选参数与默认值**,不允许改变已有调用者看到的行为 |

### 7.2 明确不碰

| 文件 | 归属 / 理由 |
|---|---|
| `mail-worker/src/**`(全部) | T-19 是 checkpoint,**目标生产代码改动 = 0 行**。若发现非改不可(说明前面某个任务漏了 AC),**停下交主 AI 裁决**,不要自己在 checkpoint 里补生产代码 |
| `mail-worker/src/service/mail-share-service.js` | 🔴 **T-18 正在写**。波次内单写者(`session-ledger.md:129`) |
| `mail-worker/src/service/mail-share-cleanup-service.js` | 🔴 **T-18 正在写** |
| `mail-worker/test/account-delete-share.spec.js` | 🔴 **T-18.1 正在写**(要加 A1–A11 共 ~11 条)。T-19 的 account 删除用例**不许**写到这里,也不许在 share-integration 里抢跑 |
| `mail-worker/test/mail-share-cleanup.spec.js` | 🔴 **T-18.1 正在写**(种子要换成合法 account/user) |
| `mail-worker/wrangler-vitest.toml` | 🔴 **绝不能把 `SHARE_CAPABILITY_V2` 改成 `"true"`**。它是全仓「栅栏关闭态」基线,一改就把 `mail-share-service.spec.js:1224-1288` 那一整族 V2=false 用例的前提翻掉。裁决 W0-R5 + T16-HTTP 的注释(`mail-share-service.spec.js:3260-3261`)都点了名 |
| `mail-worker/wrangler.toml` | W0-R5:只写注释声明,禁止硬值覆盖 dashboard |
| `mail-worker/test/setup.js` | T-04 收口。`seedShareRow`/`seedBindingRow` 是**直写库**工厂,而 T-19 的价值恰恰在于**经 HTTP 写**;用它反而会绕过被测的栅栏。除非发现 helper 缺陷,否则零改动 |
| `mail-worker/test/security-share.spec.js` | T-17 已入库。perm 面已覆盖,不重复 |
| `mail-worker/test/share-api.spec.js` · `share-auth-service.spec.js` · `mail-share-service.spec.js` | 作为「不许改坏」的邻接回归跑,不加 T-19 用例 |
| `mail-vue/**` · `tests/e2e/**` | W4/W5/W6。T-19 只跑它们、不改它们 |
| `docs/specs/**` | 主 AI 收口回写(Evidence / Update Log)。执行者不动 |

---

## 8. 与 T-18 的时序:T-19 该不该等 APPROVED

### 8.1 结论

**分两段:**

- **写码段(A1–A7 / B1–B6 / C1–C6 共 19 条中的全部 19 条)—— 不必等。** 逐条核对过:这三组用到的端点是 `POST /mailShare/create`(T-12,`b6f5a28`)、`PUT /mailShare/bindings`(T-13,`ee2db41`+`22d9832`)、`GET /mailShare/get` · `PUT /mailShare/update` · `DELETE /mailShare/delete` · `GET /mailShare/list`(T-15,`1d49bb4`+`cccb3bb`)、`POST /mailShare/resetAuthKey`(T-16,`3bb1d55`)、perm 门(T-17,`d18f027`),以及访客侧 T-05→T-11/T-14 全链 —— **全部已入库且已 APPROVED**。T-18 改的 `revokeByAccountIds` 与 `cleanupExpired` **不在这 19 条的任何一条路径上**(它们只在 account 删除与 cron 两个入口被调用,这两个入口 T-19 都不碰)。
- **收口段(全量三套跑 + Evidence 回写 + 勾选)—— 必须等 T-18 入库。** 两条理由:① T-19 的任务书原文就是「`pnpm --dir mail-worker test` 全绿」,而 T-18 正在同一套件里加 ~14 条用例、改两个生产文件,T-19 提前跑出的绿与数字在 T-18 落地那一刻就作废;② 波次图(`tasks.md:503-504`)把 T-19 定义为 W3 的 checkpoint,checkpoint 的语义就是「本波次全部任务的联合验收」,T-18 未收口的 checkpoint 是空头支票。

- **A8 一条单独 gated**:必须等 T-18 **入库且 APPROVED** 之后再写。今天写它 = 写 T-18.1 的红灯。

### 8.2 若主 AI 要严格串行

也完全可行,代价只是把 19 条用例的编写推后。**没有任何技术理由要求 T-19 等** —— 文件零交集,git 层面不会冲突。真正的风险只有一条:T-19 若在 T-18 之前跑全量并把 577 写进 Evidence,清单上会留下一个立刻过期的数字。**处置:无论并行与否,T-19 的 Evidence 必须在 T-18 入库后重跑一次并以那次为准。**

### 8.3 并行时的协议

```
T-18 执行者 → mail-share-service.js · mail-share-cleanup-service.js
              account-delete-share.spec.js · mail-share-cleanup.spec.js
T-19 执行者 → share-integration.spec.js                      ← 只有这一个
```

两侧都**不许**碰对方的文件。T-19 若在自己的用例里发现级联/清理相关的疑似缺陷,**记进 exec note 交主 AI**,不要顺手在 share-integration 里加断言 —— 那会变成两个任务对同一条 AC 各写一套期望。

---

## 9. 风险与陷阱

| # | 风险 | 说明与处置 |
|---|---|---|
| **T1** | **用 `jsonApi`(`SELF.fetch`)翻 V2 开关** | §4-E2。现象极具迷惑性:开关翻了,请求却仍被 `SHARE_INVALID_CONFIG` 拒 —— 看起来像栅栏 bug,实际是 env 没传导。凡是需要 V2=true 的请求,一律 `jsonWorker` |
| **T2** | **忘记 `try/finally` 还原开关** | `singleWorker: true` 下 env 是进程级共享。漏还原会让**同一个 worker 进程里的其它 spec 文件**(尤其 `mail-share-service.spec.js:1224-1288` 那族 V2=false 用例)随机变绿/变红,且报错点离肇事点很远 |
| **T3** | **把 `wrangler-vitest.toml` 改成 `"true"` 图省事** | §7.2。这是最省事也最致命的一刀:它把全仓的「栅栏关闭」基线翻了个面,一批 V2=false 的负向用例会**因为错误的原因变绿** |
| **T4** | **在 T-18 之前写 A8** | §8。今天必红。红的原因是级联纯主表直查,不是 T-19 写错了 |
| **T5** | **多邮箱用例用 `addBinding()` 直插库** | 那正是 #14 的做法,也正是本次要补的缺口本身。**直插库的 Binding 绕过了 `prepareBindingInsert` 的 account 门禁 JOIN 与 CAS 快照** —— 用它写出来的「多邮箱可见集」证明不了 create 这条路是通的 |
| **T6** | **配额断言把 `last_access_at` 也钉成不变** | `last_access_at` 在**成功建立 session** 时会写(AC-SESS-09,fire-and-forget)。B4 的「轮询零消耗」只该断言 `access_count`,别顺手把 `last_access_at` 一起钉死 |
| **T7** | **`SHARE_AUTH_REQUIRED` 与 `SHARE_UNAVAILABLE` 断言写反** | 裁决 T08-AUTH:过了 `lid`+`sec` 才暴露 `SHARE_AUTH_REQUIRED`;`lid` 不存在 / `sec` 错 / 过期 / 撤销 / 配额触顶一律 `SHARE_UNAVAILABLE`。C1 与 C2 是这条边界的正反两面,写反了两条都还是绿的 |
| **T8** | **`enable` 与 `reset`/`disable` 的栅栏不对称** | 只有 `enable` 过 V2 栅栏(`:1277-1278` + `move.gated`)。C4/C6 若给 `disable` 也套上开关,会把「Owner 关不掉第二因子」这个已被 T-16 明确拒绝的行为写成期望 |
| **T9** | **`resetUsedSessions` 的默认是 `true`** | `:1219-1222`:只有当 patch 里 `maxSessions` 被设成非 null 时才触发,且默认按 1(reset)处理。B5 若不显式发 `resetUsedSessions:false`,拿到的就是归零后的计数 |
| **T10** | **新账号没走 `t24-` 前缀** | `cleanup():272` 按 `LIKE 't24-%@example.com'` 删 account。漏网的 account 会在同 worker 后续文件里制造「同用户名下多出一个邮箱」的幽灵 |
| **T11** | **`expectIdenticalUnavailable` 混用两种 fetch** | 可以混(`:389-402` 已有先例),但**必须确认两侧的 `content-type` 一致** —— 该 helper 自己会比 `content-type`(`:109`),混错了会报一个和业务无关的头部差异 |
| **T12** | **A7 的三表清零断言漏掉 `share_idempotency`** | `delete()` 的三条语句是子表在前主表在后(`mail-share-service.js:1231-1257`)。只断言 binding 清零会漏掉幂等行这一半 |
| **T13** | **B2 并发用例只断言「1 成功 1 失败」不查库** | 超发的典型形态是「两条都成功但 `access_count` 只加了 1」或反过来。必须同时断言库里的 `access_count` |
| **T14** | **文件已 912 行,再加 19 条会破 1500** | 用 `describe` 分组 + 复用现成 helper,不要为每条用例复制一遍种子代码。如果写着写着发现要造第三个 `describe` 级脚手架,停下来问主 AI 该不该另开 spec 文件 |
| **T15** | **T-19 顺手改了生产代码** | checkpoint 的语义是**验收**,不是补丁窗口。发现缺陷→登记→交主 AI 裁决是否开新任务。在 checkpoint 里悄悄改生产代码,等于让本波次的全部审查结论失效 |

---

## 10. 执行前自检清单(给 T-19 执行者)

- [ ] 确认 T-18 状态:若未 APPROVED,**A8 不写**,且收口全量跑推迟到 T-18 入库后
- [ ] 只改 `mail-worker/test/share-integration.spec.js` 一个文件;`git status` 在提交前确认无第二个文件
- [ ] 所有需要 V2=true 的写请求走 `jsonWorker`,不走 `jsonApi`
- [ ] 每处翻开关都有 `try/finally` 还原;`SHARE_CAPABILITY_V2` 已进 `savedEnv` 与 `cleanup()`
- [ ] `wrangler-vitest.toml` 一字未动(`git diff` 确认)
- [ ] 多邮箱 Binding 全部经 `POST /mailShare/create` 或 `PUT /mailShare/bindings` 产生,零 `INSERT INTO mail_share_binding`
- [ ] 新建账号一律 `t24-*@example.com`;`cleanup()` 已补 binding 清理
- [ ] 现有 17 条用例断言一字未改(`git diff` 里 `:1-912` 只有 helper 的追加行)
- [ ] `SHARE_AUTH_REQUIRED` / `SHARE_UNAVAILABLE` 的边界按 T08-AUTH 写:过了 lid+sec 才暴露前者
- [ ] 配额用例同时断言 HTTP 结果与库里 `access_count`
- [ ] `disable` 路径没有被套上 V2 栅栏期望
- [ ] 定点 `share-integration.spec.js` EXIT=0;邻接三 spec EXIT=0
- [ ] 三套全量:worker EXIT=0(≥ 577,且是 T-18 之后的那次)、vue 17/95 EXIT=0、E2E 13 EXIT=0
- [ ] Evidence 四要素齐全:verify(含 EXIT)/ files:lines / AC / commit(裁决 W0R-P0-1)

---

## 11. 参考锚点索引

```
任务   docs/specs/mailbox-share-capability/tasks.md:434(T-19 正文)
       :503-504(W3 波次图,T-19 = checkpoint)、:215-221(T-09 checkpoint 的 Evidence 范式)
       :519-522(Update Log,三套基线来源)
契约   docs/specs/mailbox-share-capability/requirements.md:55-68(AC-CAP-01→14)
       :76-87(AC-BIND-01→12)、:95-105(AC-SESS-01→11)、:106-107(AC-AUTH-01/02)
       :121-129(AC-MAIL-01→09)、:155-164(AC-ADMIN-01→10)、:172-181(AC-SEC)
       :189-197(AC-LIFE-01→09)、:208-222(AC-EDGE-01→14)
被测   mail-worker/test/share-integration.spec.js:30-33(savedEnv,缺 V2)
       :46-69(jsonApi = SELF.fetch)、:71-98(jsonWorker = worker.fetch + env)★
       :100-112(expectIdenticalUnavailable)、:114-132(expectVisitorDto)
       :134-159(seedUser/jwtFor/beforeAll,role_id=1)、:161-210(insertAccount/Email/Attachment)
       :212-230(createShare/openSession,均需扩参)、:240-259(assertSecAbsentFromDatabase,C5 复用)
       :261-277(cleanup,不删 binding)、:279-773(13 条基线)、:778-912(status 4 条)
       :779-786(addBinding 直插库 —— T-19 要替换掉的做法)
栅栏   mail-worker/src/service/mail-share-service.js:31-38(SHARE_V2_INTENT)、:67-81(assertCapabilityV2)
       :355-366(create 四条栅栏)★、:904-909(update 两条)、:1045-1046(bindings 1→N)
       :1277-1278(resetAuthKey enable)
形状   :424-456(projectOwnerRow:usedSessions/maxSessions/effectiveStatus/shareType/bindings)
       :474-484(shareTypeOf/loadBindings)、:491-526(loadBindingSummaries/loadOwnerDetail)
       :528-543(firstCreateResponse:shareType/bindings/authKey)
       :1124-1203(updateBindings 返回 status/shareType/bindings)、:1212-1229(update + resetUsedSessions)
       :1236-1262(delete 三表同批)、:1270-1300(resetAuthKey 状态机)
配额   mail-worker/src/service/share-auth-service.js:44-60(effectiveStatus 优先级 + ACCESS_LIMIT_REACHED)
       :276-284(ESTABLISH_ALLOWED / RESOLVE_ALLOWED —— AC-SESS-06 的实现)★
       :508-547(replay → loadLiveBindings → AuthKey → denyQuota 的顺序)
       :390-405(session 响应 shareType / mailboxes / 掩码地址)
路由   mail-worker/src/api/mail-share-api.js:23-68(八条 Owner 路由)
       mail-worker/src/api/share-api.js:55-63(session 读 body.authKey + Idempotency-Key 头)
权限   mail-worker/src/security/security.js:72-81(requirePermsExact)、:112-121(premKey share:manage)
       mail-worker/src/init/init.js:192-222(perm 37 + role_perm role_id=1 → share:manage)
配置   mail-worker/wrangler-vitest.toml:41(SHARE_CAPABILITY_V2 = "false" —— 禁改)★
       mail-worker/vitest.config.js:11-21(singleWorker,env 进程级共享)
范本   mail-worker/test/mail-share-service.spec.js:3260-3272(env 翻转 + finally 还原,照抄这段)★
       :3167-3221(resetAuthKey vs live session,C3/C4 的服务层对照组)
       :3223-3301(resetAuthKey HTTP 面)
已覆盖 mail-worker/test/security-share.spec.js:209-238(AC-ADMIN-10 八路由 perm —— 不要重复)
       mail-worker/test/share-api.spec.js:329-361(session 幂等)、:363-410(AuthKey,但 hash 直写库)
裁决   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/session-ledger.md:115(T16-HTTP)
       :96(T08-AUTH 边界)、:110(T15-V2)、:119(T18-DUAL)、:129(mail-share-service.js 下一写者 = T-18)
前锋   .../recon-t18-cascade.md:317-341(T-18 文件白名单 —— 与本文件的白名单互斥)
       .../recon-t16-authkey.md(AuthKey 状态机)· .../recon-t15-owner-api.md(Owner 端点契约)
```
