# Recon · W1 授权链(T-05 → T-08)可执行修改范围

- **模式**:Mode R(reality recon)
- **日期**:2026-08-24
- **分支**:`cursor/mailbox-share-capability-dcb6` · HEAD `bf1eaf9`(工作树 clean,`git status --short` 零输出)
- **权威来源**:`docs/specs/mailbox-share-capability/tasks.md` W1 · `design.md`(Session / effectiveStatus / AuthKey / KV 幂等)· 工作树实码
- **基线(本次实跑)**:`pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-attachment-service.spec.js test/share-scoped-email-repository.spec.js` → 3 files / **29 passed**;其中 `share-auth-service.spec.js` 单独跑 **11 passed**
- **W0 在途说明(侦察期间发生变化,已复核)**:开工时工作树 clean、HEAD 无 T-02/T-03 产物;侦察进行中 W0 执行者落下**未提交**改动 —— `mail-share-service.js`(+71,已含 `SHARE_BINDING_LIMIT:16`、`assertCapabilityV2:64`、`syncPrimaryAccountId:275`)、`mail-share-service.spec.js`(+208)、`mail-share.schema.spec.js`(+25)、`wrangler.toml`、`wrangler-vitest.toml`。**T-02/T-03 助手现已存在但未提交,T-04 仍未落**。
- **复核结论**:W1 白名单文件(`share-auth-service.js` / `share-api.js` / `kv-const.js` / `package.json`)在这批在途改动中**零改动**(`git diff --name-only` 无命中),故本报告全部 W1 结论不受影响;仅 §7.3 的 T-12 判断按新事实收窄(见该节)。本报告对 `mail-share-service.js` 全程只做只读引用。

---

## 问题速查索引

| 用户问题 | 答在本报告 |
|---|---|
| 1. 四个函数当前 file:line | §2.1 |
| 2. W1 可写文件清单 + T-05..T-08 不可并行论证 | §5 + §6 |
| 3. 加 ACCESS_LIMIT_REACHED 不破三态测试 | §3.1 |
| 4. Idempotency-Key 读在 API 还是 service | §3.2 |
| 5. 会逼改 spec 的风险 | §4 |
| 6. T-09 必须冻结的 ShareContext 形状 | §8 |
| 7. T-10/T-12 能否早于 T-08 起跑 | §7.3 |

---

## 1. 计划假设清单(可被现实推翻的)

| # | tasks.md / design.md 的假设 | 出处 |
|---|---|---|
| A1 | `effectiveStatus` 在 `share-auth-service.js:25-33`,加一个分支即可 | tasks.md:74 · design.md:43 |
| A2 | `establishSession` 在 `:243-272`,可加 `authKey` 作第 4 个位置参数 | tasks.md:96 · design.md:355 |
| A3 | `resolveSession` 在 `:274-296`,ShareContext 可直接换成集合形状 | tasks.md:96 · design.md:362,364 |
| A4 | `recordAccess`(`:236-241`)可被条件 UPDATE 直接取代 | design.md:659 |
| A5 | W1 只写 `share-auth-service.js` + `kv-const.js` + 自身 spec | tasks.md:23,67 |
| A6 | `c.env.kv` 在测试环境可用,TTL = min(120s, token 剩余寿命) 可直接落 | design.md:241 · tasks.md:88 |
| A7 | 属性测试用 fast-check ≥100 轮 | tasks.md:70 |
| A8 | T-09 能在 W1 结束时跑到「基线 138 只增不减」全绿 | tasks.md:99 |
| A9 | T-05 加的四态会让 Owner 列表显示 `ACCESS_LIMIT_REACHED` | design.md:301 |
| A10 | `last_access_at` 保持 fire-and-forget | tasks.md:82 |

---

## 2. 现实核实(plan vs reality)

### 2.1 四个函数的当前坐标(问题 1 的直接回答)

| 函数 | 当前 file:line | 现状要点 |
|---|---|---|
| `effectiveStatus(row, now)` | `mail-worker/src/service/share-auth-service.js:25-33` | 纯函数三态:`!row \|\| status==='REVOKED'` → REVOKED;`row.expiresAt <= now` → EXPIRED;否则 ACTIVE。**零写库,已满足 P-LIFE-02 的纯函数半边** |
| `establishSession(c, lid, sec, deps = {})` | `:243-272` | 签名第 4 参是 `deps`(注入 seam),不是 `authKey`。流程:`isShareDisabled` → 查行 → `matchSec`(row 为 null 时也跑一次 HMAC,不可区分性)→ `assertShareActive` → `loadLiveAccount` → `issueToken` → try/catch 调 `recordAccess`(fire-and-forget)→ 返回 `{sessionToken, mailbox, expiresAt}` |
| `resolveSession(c, sessionToken)` | `:274-295` | `verifyToken` → 按 `payload.shareId` 查行 → 比 `lid` → `assertShareActive` → `loadLiveAccount` → 返回**标量** `{shareId, accountId, windowStartEmailId, expiresAt, effectiveStatus:'ACTIVE'}` |
| `recordAccess(c, shareId)` | `:236-241` | 单条 `UPDATE ... SET access_count = access_count + 1, last_access_at = ?`,**无 WHERE 条件除 shareId**,无 RETURNING,无配额判定 |
| (相关)`assertShareActive(row)` | `:222-226` | `!(row.accountId > 0) \|\| effectiveStatus(...) !== 'ACTIVE'` → throw。**两个调用方共用同一份判定**,正是 T-05 要拆的点 |
| (相关)`digestShareSecret(sec, pepper)` | `:86-89` | HMAC-SHA256 + pepper → hex。T-08 复用它做 AuthKey 摘要,设施已就位 |
| (相关)`loadLiveAccount(c, accountId)` | `:228-234` | 单值 account 存活校验,T-08 需改「至少一 Binding 的 account 存活」 |

**结论**:A1/A3 的行号 [match](A3 实为 `:274-295`,doc 写 `:274-296`,差一行,无实质影响)。A2 **[deviation]** — 见 §2.2。A4 **[deviation]** — 见 §2.3。

### 2.2 [deviation] 第 4 个位置参数已被 `deps` 占用

`share-auth-service.js:243` 现签名 `establishSession(c, lid, sec, deps = {})`;`:260` 是 `await (deps.recordAccess || recordAccess)(c, row.shareId)`。
`test/share-auth-service.spec.js:259-263` 正是靠这个 seam 注入失败:

```js
const established = await shareAuthService.establishSession(ctx(), lid, sec, {
    recordAccess: async () => { throw new Error('d1 write failed'); }
});
```

**考古(§2.6)**:`git log -L 243,272:...share-auth-service.js` → 该 `deps = {}` 自文件诞生(`7544d97 feat(worker): Mail Share 后端`)就存在,**是为 AC-LIFE-14 故意留的故障注入 seam**,不是历史垃圾。design.md:355 写 `establishSession(c, lid, sec, authKey?)` 是在这个事实之上直接覆盖第 4 位。

**执行指令**:第 4 参改为**单一 options 对象** `establishSession(c, lid, sec, options = {})`,`options = { authKey?, idempotencyKey?, ...注入 seam }`。理由:W1 到 T-08 为止要往这个函数塞 `authKey`(T-08)与 `idempotencyKey`(T-07)两个新入参,位置参数会排到第 5 位且与 seam 打架;options 对象一次容纳三者且旧注入调用 `{recordAccess: fn}` 形状不变(是否保留该 key 见 §4 R1)。

### 2.3 [deviation] `recordAccess` 的取代不是等价替换,它改变了失败语义

现在:accounting 失败 → catch 吞掉 → **仍签发**(`:259-266`,AC-LIFE-14)。
T-06 后:配额 UPDATE 是闸门,RETURNING 空 → **必须拒发**。

也就是说 `test/share-auth-service.spec.js:254-267`「still issues a session when access accounting fails」的语义在 T-06 后**反转**,不是扩展。这条踩在 tasks.md:16「单邮箱旧断言只扩展不改写」的红线上,也踩在 T-09「有疑问(如旧 spec 断言需要语义扩展)先问用户再动」的门上。详见 §4 R1。

### 2.4 [deviation · 最高优先级] ShareContext 换形会打断下游读路径,T-09 不可能自动全绿

resolveSession 的返回值有**两个结构性消费者**,都读标量:

| 消费者 | file:line | 读的字段 |
|---|---|---|
| `share-scoped-email-repository.js` | `:25-27`(`resolveShareScope`)· `:62-64`(`visibleWindowConditions`) | `ctx.accountId`、`ctx.windowStartEmailId`;`!(accountId > 0)` → 返回 `null` → list/getById **静默返回空集** |
| `share-attachment-service.js` | `:105`(`!(shareContext.accountId > 0)` → throw)· `:139`、`:145` | `shareContext.accountId` |

design.md:364 冻结的新形状 `{shareId, bindings:[...], messageLimit, otpExtractionEnabled, showFullAddress, expiresAt}` **不含** `accountId` / `windowStartEmailId`。

后果链(实测可验证):T-08 落地当刻,`GET /share/mails` 返回空集、`GET /share/attachment` 抛 `SHARE_UNAVAILABLE`;而 `test/share-integration.spec.js:311-338,432-457,532-533` 与 `test/share-api.spec.js:205,315-334,344-359` 走的正是 `POST /share/session → GET /share/mails → /share/mail → /share/attachment` 全链。**T-09「基线 138 只增不减」在 T-10/T-11 落地前物理上做不到**,除非 T-08 保留兼容标量(§8 的裁决点)。A8 **[deviation]**。

### 2.5 [deviation] `effectiveStatus` 有第二个调用方,且它喂进来的行没有 `maxSessions`

`mail-share-service.js:122` 在 Owner 列表投影里调 `shareAuthService.effectiveStatus(row, now)`。而 `mail-share-service.js:354-364` 的 SELECT **没有取 `max_sessions`**,`:366-381` 手工 snake→camel 映射也自然没有 `maxSessions`。

后果:T-05 加完分支后,Owner 列表对已触顶的分享**永远显示 ACTIVE**(`row.maxSessions === undefined` → 分支不进)。design.md:301 要求 list 行含四态 `effectiveStatus`。这个洞由 T-05 制造、要到 W3 T-15 才补(T-15.2 明写 list 改经 Binding JOIN)。A9 **[deviation]**:T-05 **不得**顺手去修 `mail-share-service.js`(热区他人文件,tasks.md:25)。

### 2.6 [deviation] `share-api.js` 是 W1 必写文件,但不在冲突热区表里

- T-07 要读 `Idempotency-Key` 头 → 必须改 `share-api.js:54-58`(见 §3.2)
- T-08 要把 `authKey` 从 body 透传 → 同一处
- 而 W2 的 **T-14.2 也写 `share-api.js`**(新增 `GET /share/mailboxes/status`,tasks.md:140)

tasks.md:20-26 的热区表列了 `init.js` / `share-auth-service.js` / `security.js` / `mail-share-service.js` / i18n,**唯独漏了 `share-api.js`**。A5 **[deviation]**。

### 2.7 [match] 三项基建现实已就位,W1 不被 W0 阻塞

| 检查 | 结果 |
|---|---|
| T-01 列是否齐 | `entity/mail-share.js:21-31` 已有 `maxSessions` / `messageLimit` / `otpExtractionEnabled` / `showFullAddress` / `autoRefresh` / `refreshIntervalMs` / `authKeyEnabled` / `authKeyHash` / `authKeyKid` / `credentialsVersion`;`entity/mail-share-binding.js:4-10` 已有。**W1 全部字段可用** |
| 测试环境有没有 KV | `wrangler-vitest.toml:18-20` `binding = "kv"` 存在。A6 前半 [match] |
| 测试库有没有新表/新列 | `test/setup.js:12` 打 `/api/init/<secret>`,`init.js:33` 链尾已挂 `v3_2DB(c)` → 测试库自带新列与 binding 表。**W1 写测试不必等 T-04** |
| `RETURNING` 判定可用性 | `test/transaction.spec.js:83-106`「RETURNING and meta.changes distinguish applied from not applied」+ `:150-163` 条件 `INSERT...SELECT COUNT` 已在本机 Miniflare D1 验证。T-06 的单语句闸门有现成先例 |

### 2.8 [doc-missing] fast-check 未安装

`mail-worker/package.json` devDependencies 只有 `@cloudflare/vitest-pool-workers` / `vitest` / `wrangler`;`mail-worker/pnpm-lock.yaml` 内 `fast-check` 命中数 **0**;`node_modules/fast-check` 不存在。tasks.md:70 的「property,fast-check ≥100 轮」**当前跑不了**。

可达性已验:`pnpm view fast-check version` → `4.9.0`(registry 通)。A7 **[doc-missing]**:安装动作没有被写进任何任务。

---

## 3. 重复实现与可复用扫描

### 3.1 内部复用:加 ACCESS_LIMIT_REACHED 而不破三态测试(问题 3)

先把「现存三态断言」逐条钉死:

| # | 断言位置 | 断言内容 | 该行的 `max_sessions` |
|---|---|---|---|
| 1 | `share-auth-service.spec.js:188-193` | resolveSession → `effectiveStatus:'ACTIVE'` | 未写入 → NULL(`insertShare` `:110-118` 不含该列) |
| 2 | `share-auth-service.spec.js:266` | 同上 | NULL |
| 3 | `share-auth-service.spec.js:331` | 同上 | NULL |
| 4 | `share-auth-service.spec.js:203-212` | 过期算计算态、落库 status 仍 ACTIVE | NULL |
| 5 | `share-auth-service.spec.js:140-174` | 六路失败包体字节相同 | NULL |
| 6 | `mail-share-service.spec.js:246-253` | Owner 列表 `effectiveStatus:'ACTIVE'` | create SQL(`mail-share-service.js:189-201`)**不写 `max_sessions`** → NULL |
| 7 | `mail-share-service.spec.js:352` / `share-integration.spec.js:671` | `EXPIRED` | NULL |
| 8 | `share-attachment-service.spec.js:34,128-131` | ctx 自造 `effectiveStatus`,REVOKED → 拒 | 不经 DB |
| 9 | `share-scoped-email-repository.spec.js:47` | ctx 自造 ACTIVE | 不经 DB |

**关键事实:现存全部路径的 `max_sessions` 都是 NULL** —— T-01 才加的列,`insertShare` 与 create SQL 都不写它。

**因此不破测试的充要做法**:

1. 新分支的**第一个谓词必须是 `row.maxSessions != null`**,严格照 design.md:257-258 的 `max_sessions IS NOT NULL AND used_sessions >= max_sessions`。用 `!= null`(松等,同时排除 `undefined`),**不要**用 `Number(row.maxSessions) > 0` 之类会把 `undefined` 变 `NaN` 再走进比较的写法。
2. **分支插在 EXPIRED 之后、ACTIVE 之前**,顺序即优先级(REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE),与现有 early-return 结构同构,不需要重排已有两个分支 → 断言 1-7 全部零改动。
3. **`assertShareActive`(`:222-226`)必须拆,而不是改**。它现在被 establish 与 resolve 共用。拆法:保留一个内部 `assertAllowed(row, allowedStates)`,`establishSession` 传 `['ACTIVE']`、`resolveSession` 传 `['ACTIVE','ACCESS_LIMIT_REACHED']`。断言 1-4 用的都是 NULL 行 → 恒 ACTIVE → 两条路径都过。
4. **`row.accountId > 0` 这半边先原样留在 establish 侧**,到 T-08 再随 Binding 集合化一起换(见 §8)。T-05 只动状态判定,不动 account 判定 —— 否则 `:140-174` 的 deadLid 用例(`accountId=800099` 但 account `is_del=DELETE`)行为会飘。
5. `share-attachment-service.js:108` 的 `shareContext.effectiveStatus !== 'ACTIVE'` → **T-05 阶段不要碰**(它是另一文件),但必须记进 T-08 的交付契约:一旦 resolveSession 开始对触顶行返回 `effectiveStatus:'ACCESS_LIMIT_REACHED'`,附件下载会被这行拒掉,直接违反 AC-SESS-06「关门不清场」。裁决见 §8。

**新增测试落在 `test/share-auth-service.spec.js`,`insertShare` 工厂加可选 `maxSessions` / `accessCount` 形参(默认不写该列)** —— 默认值不变即保证 1-7 不动。

### 3.2 内部复用:`Idempotency-Key` 读在哪一层(问题 4)

**本仓已有确定答案,照抄即可,不要新发明。**

```
mail-share-api.js:25   const idempotencyKey = c.req.header('Idempotency-Key') || '';
mail-share-api.js:26   await mailShareService.create(c, { ...body, idempotencyKey }, userContext.getUserId(c));
mail-share-service.js:312-313   const idempotencyKey = params && params.idempotencyKey != null && String(params.idempotencyKey) !== '' ? String(params.idempotencyKey) : '';
```

**API 层读头、service 层只收普通参数**。三条支撑:

1. **一致性**:create 已经这么做了。session 换个层去读,同一个 header 在同一个 worker 里出现两种读法。
2. **可测性(硬约束)**:`test/share-auth-service.spec.js` 全部用例都直接调 `shareAuthService.establishSession(ctx(), lid, sec)`,而 `ctx()`(`:35-37`)是 `{ env: authEnv() }` —— **根本没有 `c.req`**。若 establishSession 内部调 `c.req.header(...)`,T-07 的全部单测都得先造假 `c.req`,11 条既有用例也要连坐改造。
3. **归一化的唯一点**:`|| ''` 空串归一在 API 层做一次,service 只判 truthy。

**落点**:`share-api.js:54-58` 改成

```
const body = await c.req.json();
const idempotencyKey = c.req.header('Idempotency-Key') || '';
const data = await shareAuthService.establishSession(c, body.lid, body.sec, { authKey: body.authKey, idempotencyKey });
```

`authKey` 走 body(design.md:335 `{lid, sec, authKey?}`),`Idempotency-Key` 走头。两者在同一次改动里进 options 对象 —— 这是 T-07 与 T-08 都要改 `share-api.js` 却又串行的原因。

### 3.3 内部复用:其它已在位、W1 不要重造的设施

| 需求 | 已有设施 | file:line |
|---|---|---|
| AuthKey 摘要 | `digestShareSecret`(HMAC+pepper) | `share-auth-service.js:86-89` |
| 常量时间比较 | `timingSafeEqualString` / `timingSafeEqualBytes` | `:62-73` |
| pepper 双 kid 环 | `pepperRing` + `selectKeyedSecret` | `:106-126` |
| KV 带 TTL 写 | `c.env.kv.put(key, val, { expirationTtl: n })` | `security.js:178` · `email-service.js:369` |
| KV JSON 读 | `c.env.kv.get(key, { type: 'json' })` | `security.js:135` |
| 单语句条件 UPDATE + RETURNING 判定 | 已在本机 D1 验证 | `test/transaction.spec.js:83-106` |
| 条件写 + 上限判定先例 | create 的 `INSERT...SELECT ... WHERE (SELECT COUNT(*)...) < ? RETURNING` | `mail-share-service.js:189-201` |

### 3.4 外部(open-source)扫描

- **KV 幂等/结果重放**:Cloudflare 生态无值得引入的成品库,设计本身就是「一次 get + 一次 put」的 20 行逻辑。结论:**自建,零依赖**。
- **fast-check**:属性测试无本仓先例(全仓 `fc.assert` 命中 0)。registry 可达(4.9.0)。结论:**引入 fast-check**,不要手搓伪随机枚举。
- **已知陷阱(必须写进 T-07)**:Cloudflare Workers KV 的 `expirationTtl` **最小值是 60 秒**,小于 60 秒的过期目标直接报错([Cloudflare KV docs · Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/):「`expirationTtl` ... The minimum value is 60」「Expiration targets that are less than 60 seconds into the future are not supported」)。design.md:241 的 `TTL = min(120s, token 剩余寿命)` 在「分享临到期、token 剩余寿命 < 60s」时会**必然抛错**,被 fail-open 吞成 `share.system.error`,幂等保护静默消失。见 §4 建议 S1。
- **第二个陷阱**:KV 写「立即对同一网络位置可见,但传播到其它位置最长 60 秒」(同一篇文档)。重放请求若落到另一个 PoP 可能读不到 → 退化为再消耗一次配额。这在 design.md:242 的 fail-open 风险窗口里其实没被点名,建议在 T-07 的实现注释与 AC-SESS-10 的测试说明里显式记一句(纯文档动作,不改行为)。

---

## 4. 架构 / 前提挑战 + 业务现实核对 + 更优做法(问题 5:会逼改 spec 的风险)

**前提挑战结论:不构成架构级问题。** W1 是在一条既有的、边界清楚的授权链上做定向扩展(状态判定 / 配额闸门 / 幂等 / 第二因子),不是在错误骨架上贴瓷砖;design.md 的 R1-A4 / R2-A3 / R3-A3 三轮裁决已经把「单一线性化点」这个真问题(X)找准了,没有 XY 错位。**无架构级建议。**

**业务现实核对(§0.17)**:W1 四项均为 **A 类业务关键**,无 D 类技术整洁项混入 —— `ACCESS_LIMIT_REACHED`(Owner 设的配额必须真的关门,AC-SESS-06)、配额闸门(超发 = 付费/私密链接被多人用,AC-EDGE-02)、KV 幂等(`max_sessions=1` 时一次响应丢失永久废掉链接,design.md:238 已给出真实业务场景)、AuthKey+cv(重置 Key 后旧 Session 必须断,AC-AUTH-04)。四项都答得出「谁在什么场景需要 / 缺了真实用户损失什么」。**无「技术缺口冒充业务需求」的项。**

以下五条是**会逼改 spec 或需要用户拍板**的风险,按严重度排序。

### R1 · [P0 · 需用户裁决] AC-LIFE-14 的现有断言在 T-06 后语义反转

- **事实**:`test/share-auth-service.spec.js:254-267` 注入 `recordAccess` 抛错并断言**仍签发**。T-06 后配额 UPDATE 是闸门,失败必须**拒发**。
- **叠加矛盾**:tasks.md:82 说「`last_access_at` 保持 fire-and-forget」,但 design.md:280 的 SQL 原文是 `UPDATE mail_share SET access_count = access_count + 1, last_access_at = ? WHERE ...` —— `last_access_at` **在闸门语句里**。两处不能同时为真。
- **为什么必须现在裁**:T-08.1(tasks.md:92)还要求「统计写失败注入仍签发」。若 `last_access_at` 进了闸门 SQL,establish 路径上就**不再有任何 fire-and-forget 的统计写**,这条断言失去挂载点(只剩 KV 写与日志两个 fail-open 点)。
- **两个可选裁决**(不由侦察决定):
  - **(a) 照 design.md:280 原文** —— `last_access_at` 进闸门 SQL。则 AC-LIFE-14 的现有用例必须**改写**(不是扩展),T-09 需按 tasks.md:100 停下问用户;T-08.1 的「统计写失败」改挂 KV 写失败(与 T-07 的 fail-open 用例合并)。
  - **(b) 照 tasks.md:82** —— 闸门 SQL 只 `access_count + 1`,`last_access_at` 另起一条 fire-and-forget UPDATE。则 AC-LIFE-14 的注入 seam 改名保留(`deps.recordLastAccess`),旧断言语义**得以保住**;代价是每次建会话多一次 D1 写,且 design.md:280 的 SQL 原文要跟着改一个字段。
- **侦察倾向**:(b) 更省事且保住基线守恒,但它要动 design.md 的 SQL 原文 —— **属于改 spec,必须用户点头**。

### R2 · [P0 · 需用户裁决] ShareContext 换形 vs T-09 全绿,二者不可兼得

见 §2.4。三条出路,请用户/主 AI 在**派 T-08 之前**选定(否则执行者必然自己乱选):

| 方案 | 做法 | 代价 |
|---|---|---|
| **(i) 兼容标量** | ShareContext 同时带 `bindings[]` 与派生标量 `accountId = bindings[0].accountId`、`windowStartEmailId = bindings[0].windowStartEmailId` | T-09 可全绿;T-10/T-11 落地后需再删这两个键 —— 但那时 `share-scoped-email-repository.js` 已改集合化,删除是安全的。**与 T-02.1 的 grep 门不冲突**:标量派生自 `mail_share_binding.account_id`,不是 `mail_share.account_id` |
| (ii) 硬切 + 顺手改下游 | T-08 同时改 `share-scoped-email-repository.js` 与 `share-attachment-service.js` | 直接踩 T-10/T-11 的文件,W1/W2 owner 边界崩塌。**不推荐** |
| (iii) 硬切 + T-09 允许红 | T-09 checkpoint 降级为「W1 单文件 spec 绿,集成 spec 允许红到 T-11」 | 违背 tasks.md:99「基线 138 只增不减」,且 W2 期间无绿基线可回归。**不推荐** |

**侦察倾向:(i)**,并在 T-09 的冻结公告里把这两个键显式标注为 `@deprecated 兼容垫片,T-11 收尾删除`。

### R3 · [P1] `expirationTtl < 60` 会让 KV 写必然失败

见 §3.4。design.md:241 的公式在临期分享上直接违反平台约束。**建议(不改语义,只补边界)**:`remaining < 60` 时**跳过 KV 写**(token 寿命本就不足以让重放有意义),`60 ≤ remaining` 时 `expirationTtl = Math.min(120, remaining)`。这是对 design.md 公式的边界补全,建议在 T-07 落地时同步在 design.md 的该行追加一句括注 —— **算改 spec 文字,请主 AI 决定是「实现细则」还是「需回写 design」**。

### R4 · [P1] Owner 列表看不到 ACCESS_LIMIT_REACHED,横跨 T-05 与 T-15 两个波次

见 §2.5。不逼改 spec,但**必须写进 T-15 的输入**,否则 W3 执行者只会照 tasks.md:146「行含 effectiveStatus 四态」改 JOIN,不会意识到 `SELECT` 少了 `ms.max_sessions` 这一列。**T-05 执行者不得越界去修。**

### R5 · [P2] fast-check 安装动作无归属

见 §2.8。`mail-worker/package.json` + `mail-worker/pnpm-lock.yaml` 是全波次共享文件,谁先动谁制造 lock 冲突。**建议:在派 T-05 之前由主 AI 一次性安装并单独提交**,W1 执行者只 import 不装。若坚持放进 T-05,则须在热区表里把这两个文件登记为 T-05 单写。

---

## 5. 真实修改范围(问题 2:W1 到底能写哪些文件)

### 5.1 允许写(白名单,除此之外一律不许动)

| 文件 | 由谁写 | 写什么 |
|---|---|---|
| `mail-worker/src/service/share-auth-service.js` | T-05 → T-06 → T-07 → T-08 **依次独占** | 四态 / 闸门 / KV 幂等 / AuthKey+cv+ShareContext |
| `mail-worker/test/share-auth-service.spec.js` | 同上,依次独占 | 四任务的红灯与绿灯断言 |
| `mail-worker/src/const/kv-const.js` | **仅 T-07** | 加 `SHARE_EST: 'share:est:'` 一个前缀常量 |
| `mail-worker/src/api/share-api.js` | **仅 T-07(读头)与 T-08(透传 authKey)**,两次改动落在同一处 `:54-58` | 见 §3.2。**热区表遗漏项,须补登记** |
| `mail-worker/package.json` + `mail-worker/pnpm-lock.yaml` | 建议前置由主 AI 装,否则 **仅 T-05** | 加 `fast-check` devDependency(§4 R5) |

### 5.2 只读 / 明令禁改(W1 内 don't touch)

`mail-worker/src/service/mail-share-service.js`(W0 T-02/T-03 在途 + W2/W3 owner)· `mail-worker/src/service/share-scoped-email-repository.js`(T-10)· `mail-worker/src/service/share-attachment-service.js`(T-11.4)· `mail-worker/src/service/share-mail-service.js`(T-11)· `mail-worker/src/security/security.js`(T-14/T-17)· `mail-worker/src/init/init.js`(T-01 已锁)· `mail-worker/src/entity/*`(T-01 已锁)· `mail-worker/test/setup.js`(T-04)· 除 `share-auth-service.spec.js` 外的全部 spec。

### 5.3 比 charter 多出来的两项

1. `share-api.js`(§2.6)—— charter 未列,实为必写。
2. `package.json`/`pnpm-lock.yaml`(§2.8)—— charter 未列,实为必写(或前置)。

### 5.4 比 charter 少的:零

W1 四任务全部有真实工作量,无「文档说要建、实码里已经有」的重复项。

---

## 6. 可执行拆分 · T-05..T-08 不可并行的论证(问题 2 后半)

### 6.1 结论:**不可并行,必须 T-05 → T-06 → T-07 → T-08 严格串行**,论证如下(逐对反证)

| 任务对 | 是否只是「同文件」这一种冲突 | 硬依赖 |
|---|---|---|
| T-05 ↔ T-06 | 否,是**语义依赖** | T-06 的闸门 WHERE 里的配额谓词 `(max_sessions IS NULL OR access_count < max_sessions)` 必须与 T-05 的 `effectiveStatus` 分支**表达同一条规则**。若并行,两人各写一份「触顶」定义,SQL 与 JS 漂移即产生「闸门放行但 effectiveStatus 说触顶」的不一致态。且 T-06 的拒发路径需要 T-05 拆好的 `assertAllowed(row, ['ACTIVE'])` |
| T-06 ↔ T-07 | 否,是**控制流嵌套** | design.md:357 规定顺序:校验 ①③④ → **查 KV 命中则直接 return** → 未命中才走条件 UPDATE。T-07 的 KV 分支是插在 T-06 闸门**之前**的 early-return,两者共享 establishSession 的同一段线性流程。并行 = 两人同时重排同一函数体 |
| T-07 ↔ T-08 | 否,是**数据依赖 + 同一处 API 改动** | ① T-07 的 KV 查询必须在「①③④ 校验通过后」,而 ④(authKey 校验)由 T-08 引入 —— T-07 落地时 ④ 还不存在,T-08 必须把 authKey 校验**插到 KV 查询之前**;顺序错了就成了「不给 Key 也能重放拿 token」的绕过。② 两者都改 `share-api.js:54-58` 同一个调用点 |
| T-05 ↔ T-08 | 否 | T-08 的 `resolveSession` 扩展要在 T-05 拆出的「按调用方区分」结构上加 cv 比对与 Binding 集合化;T-05 未拆则无处可加 |
| T-06 ↔ T-08 | 否 | T-06 的闸门 WHERE 含 `credentials_version = :cv`,而 cv 的**写入方**(token payload 带 cv)与**校验方**(resolveSession 回源比对)在 T-08。T-06 先落 cv 谓词、T-08 再补 payload,是 design.md:280 → :234 的既定顺序 |

**一句话**:这四个任务不是「四段互不相干的代码恰好住在同一个文件」,而是**同一个函数(`establishSession`)的四次连续重写 + 同一个纯函数(`effectiveStatus`)的语义扩散**。文件锁只是表象,真正的约束是控制流与语义的单向依赖。**任何形式的并行(含 worktree 分叉后合并)都会在 `establishSession` 函数体上产生语义级冲突,不是 git 能合的那种冲突。**

### 6.2 工作包表

| 包 | 范围(文件) | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|
| **W1-P0(前置,建议主 AI 自己做)** | `mail-worker/package.json`、`pnpm-lock.yaml` | 装 `fast-check@4`,单独提交 | 无 | — | 0(主 AI) |
| **W1-A = T-05** | `share-auth-service.js`、`test/share-auth-service.spec.js` | 四态 + establish/resolve 差异放行;`assertShareActive` 拆为按调用方 | W1-P0 | ❌ | 1 |
| **W1-B = T-06** | 同上两文件 | `consumeSessionQuota` 单语句闸门取代 `recordAccess`;`share.session.denied_quota` | T-05 完成 | ❌ | 1 |
| **W1-C = T-07** | 同上两文件 + `src/const/kv-const.js` + `src/api/share-api.js` | KV `share:est:<lid>:<key>` 结果重放;API 层读 `Idempotency-Key` | T-06 完成 | ❌ | 1 |
| **W1-D = T-08** | 同上四文件 | AuthKey 第二因子 + token `cv` + ShareContext 集合化 + session 响应四件 | T-07 完成 | ❌ | 1 |
| **W1-E = T-09** | 无(只跑测试 + 写公告) | `pnpm --dir mail-worker test` 全绿 + ShareContext 契约冻结 | T-08 完成 | ❌ | 主 AI |

**推荐派发**:**单一执行者按 A→B→C→D 连续做完**。理由:四包共用一个函数体的心智模型,换人 = 每次重建上下文 + 每次可能推翻上一包的局部结构。若坚持一包一 AI,则每包交接必须附带 §8 的 ShareContext 决议与 §4 R1 的裁决结果。

---

## 7. 风险交叉区 + 对主 AI 的派发建议

### 7.1 交叉点清单

| 交叉点 | 涉及方 | 处置 |
|---|---|---|
| `share-auth-service.js` | T-05/06/07/08 | 单执行者串行(§6) |
| `share-api.js` | **W1 的 T-07/T-08** ↔ **W2 的 T-14** | **补进热区表**;T-14 必须等 W1 收口后再起跑,或由主 AI 精确切分(T-14 只加新 `app.get(...)` 块、绝不动 `:54-58`) |
| `effectiveStatus` 纯函数 | T-05(写)↔ `mail-share-service.js:122`(W0/W2/W3 在读) | T-05 只改函数本身;调用方适配写进 T-15 输入(§2.5) |
| ShareContext 形状 | T-08(写)↔ T-10/T-11(读) | §8 冻结;派 T-10 前必须已裁决 R2 |
| `package.json`/`pnpm-lock.yaml` | 全波次 | 前置一次装完(§4 R5) |
| `test/share-auth-service.spec.js` | T-05/06/07/08 全部追加 | 随主文件串行,无额外风险 |
| `test/setup.js` | W0 T-04 在途 | W1 **不要**改它;W1 的行工厂就地放在 `share-auth-service.spec.js` 里 |

### 7.2 派发前必须先关掉的两个门(否则执行者会自行乱猜)

1. **§4 R1**:`last_access_at` 进不进闸门 SQL、AC-LIFE-14 旧断言改写还是保留 → 决定 T-06 的 SQL 与测试形状。
2. **§4 R2**:ShareContext 保不保兼容标量 → 决定 T-08 的返回形状与 T-09 能否全绿。

这两条都触及「旧 spec 断言语义变更」,按 tasks.md:100 属于**先问用户**的范畴。

### 7.3 T-10 / T-12 能否早于 T-08 起跑(问题 7)

| | 结论 | 依据 |
|---|---|---|
| **T-10**(`share-scoped-email-repository.js` + 其 spec) | **有条件可以** | 文件与 W1 白名单**零重叠**(§5.1)。ShareContext 的形状其实已在 design.md:364 与 tasks.md:96 逐字固定,T-08 只是「实现」而非「设计」它 —— 所以 T-10 可以照文档写集合化 repo。**两个前置条件**:① §4 R2 必须先裁决(T-10 要知道 ctx 里还有没有兼容标量,以及自己是否负责在 T-11 收尾时删它);② T-10 的 spec 必须**自造 ctx** 而不是调 `resolveSession` 拿真 ctx(现有 `share-scoped-email-repository.spec.js:47` 已经是自造 ctx 的写法,先例现成)。**残余风险**:T-10 落地后、T-08 落地前,`share-integration.spec.js` 会因 repo 已集合化而 resolveSession 仍给标量 ctx 而红 —— 所以 T-10 若早起跑,**必须与 T-08 在同一次绿灯里收口**,不能各自宣布完成 |
| **T-12**(`mail-share-service.js` + `mail-share-api.js` + `mail-share-service.spec.js`) | **不可以,但卡点不是 T-08** | T-12 与 share-auth-service 确实零重叠,tasks.md:237 也说「文件不冲突时可与 W1 后半并行起跑」。**真正的阻塞在 W0**,且侦察期间刚刚变化:T-02/T-03 的三个助手(`SHARE_BINDING_LIMIT:16`、`assertCapabilityV2:64`、`syncPrimaryAccountId:275`)现已写进工作树但**尚未提交**,T-04 未落,`mail-share-service.spec.js` 仍在被 W0 执行者持续追加(当前 +208 行未提交)。T-12.2 要调用的正是这两个助手(tasks.md:127)。**在 W0 提交前放 T-12 进场 = 两个执行者同时改同一个未提交的文件,冲突不可控。**结论:T-12 等 **W0(含 T-04)提交**,与 T-08 无关 |
| **T-14**(顺带,虽未问) | **不可以** | 与 W1 抢 `share-api.js`(§2.6),且 T-14.2 依赖 T-10 的 scoped repository 集合化 |

**给主 AI 的一句话**:W1 期间**唯一**值得并行起跑的是 T-10,且必须先裁 R2、且必须与 T-08 同批验收。T-12 的阻塞源是 W0 不是 W1,不要因为 T-08 提前完成就放它进场。

---

## 8. ShareContext 契约冻结 · T-09 必须冻结什么(问题 6)

T-09 的冻结公告必须把下列**五件**逐条写死。少写任何一条,W2 的三个消费者(`share-scoped-email-repository.js`、`share-attachment-service.js`、W2 新增的 status 端点)就会各自补一套猜测。

### 8.1 键集合与类型(design.md:364 原文 + 本次侦察补全)

```
ShareContext = {
  shareId: number,                    // > 0
  bindings: Array<{                   // 长度 ≥ 1;为空时 resolveSession 直接 throw SHARE_UNAVAILABLE
    bindingId: number,                // > 0,来自 mail_share_binding.binding_id
    accountId: number,                // > 0,来自 mail_share_binding.account_id(不是 mail_share.account_id)
    windowStartEmailId: number        // 有限数,0 合法
  }>,
  messageLimit: number | null,        // null = 不截断
  otpExtractionEnabled: boolean,      // 由 integer 0/1 归一为 boolean —— 必须在此归一,不许下游各自转
  showFullAddress: boolean,           // 同上
  expiresAt: string                   // 'YYYY-MM-DD HH:mm:ss',与 mail_share.expires_at 同格式
}
```

### 8.2 必须一并冻结的四条语义约定(光冻结键名不够)

1. **`bindings` 的排序**:按 `bindingId` 升序。主 Binding = `bindings[0]`,与 T-02 双写「主 Binding = 最小 binding_id」(tasks.md:53)同一口径。不冻结排序,前端 Tab 顺序会每次请求抖动。
2. **`bindings` 已过存活过滤**:只含 account 存活(`is_del = NORMAL`)的 Binding。消费者**不得**再做存活校验,也不得假设 `bindings.length` 等于 DB 里的绑定总数。
3. **`effectiveStatus` 在不在里面 —— 必须明确表态**。design.md:364 的形状里**没有**它,但 `share-attachment-service.js:108` 现在正读它。二选一,不能含糊:
   - **(推荐)不返回 `effectiveStatus`**,并在冻结公告里注明「resolveSession 返回即代表已通过 ACTIVE ∪ ACCESS_LIMIT_REACHED 判定,消费者不再二次判态」。此时 `share-attachment-service.js:108` 的 `if (shareContext.effectiveStatus && ...)` 因短路而自然失效(它已经写成了可选判定),**但 T-11.4 必须把这行删掉或改成别的守卫**,否则留下一行永假的死代码。
   - 若返回,则**必须**同时改 `share-attachment-service.js:108` 放行 `ACCESS_LIMIT_REACHED`,否则触顶后附件下载被拒 → 直接违反 AC-SESS-06「关门不清场」与 AC-EDGE-01。**这是本次侦察发现的最隐蔽的一处链路断点。**
4. **兼容标量的去留(§4 R2)**:若采纳方案 (i),冻结公告必须把 `accountId` / `windowStartEmailId` 两个顶层键写成「**deprecated 垫片,派生自 `bindings[0]`,T-11 收尾时删除**」,并指名 T-11 为删除责任人。不写清楚,它们会永久留下来变成第二套授权源 —— 那正是 design.md:217 R3-A1 花大力气消灭的东西。

### 8.3 链路完整性扫描(§0.16)

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| `Idempotency-Key` 头 | 访客页 bootstrap(to-build,T-26) | `share-api.js:54-58`(to-build,T-07) | ⛔ 断:前端到 W5 才有。**后端必须容忍无头**(design.md:335「可选」),T-07 的「无 key → 正常消耗」用例即是这段的守卫 |
| `authKey` body 字段 | 访客页 authRequired 态(to-build,T-26) | `share-api.js:54-58` → `establishSession`(to-build,T-08) | ⛔ 断:同上。后端必须容忍缺省 |
| KV `share:est:<lid>:<key>` | `establishSession` 成功后写(to-build,T-07) | `establishSession` 重放查询(to-build,T-07) | ✅ 同任务内自闭合。绑定 `wrangler-vitest.toml:18-20` 已在 |
| token payload `cv` | `issueToken`(`share-auth-service.js:170-176`,T-08 扩展) | `resolveSession` 回源比对(`:274-295`,T-08 扩展) | ✅ 同任务内自闭合;旧 token 无 `cv` 按 0 处理(design.md:234) |
| `credentials_version` 列 | `POST /mailShare/resetAuthKey`(to-build,**T-16 · W3**) | T-06 闸门 WHERE + T-08 回源比对(to-build,W1) | ⛔ 断:**W1 只有读侧,写侧在 W3**。W1 期间 cv 恒为 0(`entity/mail-share.js:31` default 0),P-AUTH-02「单调失效」在 W1 内**只能靠测试直接 UPDATE 库里的 cv 来验**,不能靠调 resetAuthKey。T-08.1 的执行者必须知道这点,否则会去找一个还不存在的接口 |
| `auth_key_hash` / `auth_key_kid` | create + resetAuthKey(to-build,T-12/T-16) | `establishSession` 第二因子(to-build,T-08) | ⛔ 断:同上,W1 内测试直接插库造 hash(可复用 spec 里现成的 `hmacHex` 工具,`share-auth-service.spec.js:39-49`) |
| ShareContext `bindings` | `resolveSession`(to-build,T-08) | `share-scoped-email-repository.js:25-27`(T-10)· `share-attachment-service.js:105,139,145`(T-11.4) | ⛔ **断,且是当前最大风险**:见 §2.4 / §4 R2 |
| `effectiveStatus` 四态 | `share-auth-service.js:25-33`(T-05) | `mail-share-service.js:122` → list SELECT(`:354-364` 缺 `max_sessions`,T-15) | ⛔ 断:见 §2.5 |
| session 响应 `mailboxes`/`config` | `establishSession`(to-build,T-08) | 访客页(to-build,T-26) | ⛔ 断:前端在 W5。W1 内由 `share-auth-service.spec.js` 断言形状即可,`share-api.js` 只透传不需改响应结构 |

**成功状态取源(可独立核验的下游前置条件,均带 file:line)**:
- 读路径要求 `ctx.accountId > 0` 且 `windowStartEmailId` 有限,否则静默空集 —— `share-scoped-email-repository.js:27`
- 附件下载要求 `shareContext.accountId > 0`,否则 `SHARE_UNAVAILABLE` —— `share-attachment-service.js:105`
- 附件下载当前额外要求 `effectiveStatus` 缺省或 `=== 'ACTIVE'` —— `share-attachment-service.js:108`
- token 校验要求四段且首段 `s1` —— `share-auth-service.js:187`
- 失败包体恒为 `{code:501, message:'SHARE_UNAVAILABLE'}`(`BizError` 默认 501,`error/biz-error.js:4`;`shareResult.fail`,`model/share-result.js:5`)—— P-AUTH-01 的字节相等断言(`share-auth-service.spec.js:169-173`)依赖这两处

### 8.4 Domain-Model 对账

`docs/domain/` 目录不存在(`ls docs/` 无该项)。本次变更触及跨切中间层(授权 / 会话 / 配额),但本 charter 的 design.md 已经承担了 domain-model 的职责:状态机(`design.md:246-274`)、不变量(`:327` AuthKey 字段不变量、`:609` P-SESS-04、`:645` P-LIFE-02)、跨切维度(`:659-666` Link table)三件齐全。**结论:不另建 `docs/domain/share-model.md`**,W1 以 design.md 对应小节为准。若主 AI 判断需要独立 model 文档,基线可直接从 design.md:246-274 + :353-378 提取,无需重建。

---

## 9. 给主 AI 的执行摘要

1. **派发前先关两个门**:§4 R1(`last_access_at` 与 AC-LIFE-14 旧断言)与 §4 R2(ShareContext 兼容标量)。两者都属「旧断言语义变更」,按 tasks.md:100 应先问用户。
2. **前置装 fast-check**(§4 R5),别让 T-05 顺手改 lock。
3. **补热区表两行**:`share-api.js`(W1 T-07/T-08 独占,T-14 让路)、`package.json`/`pnpm-lock.yaml`。
4. **W1 派一个执行者,A→B→C→D 走完**,§6.1 已逐对论证不可并行。
5. **并行只放 T-10**,且须先裁 R2、与 T-08 同批验收;**T-12 不放**(卡在 W0 未提交的 `mail-share-service.js`,不是卡在 T-08)。
6. **写进 T-15 的输入**:`mail-share-service.js:354-364` 的 SELECT 要补 `ms.max_sessions`,否则 Owner 列表永远看不到 `ACCESS_LIMIT_REACHED`。
7. **写进 T-11.4 的输入**:`share-attachment-service.js:108` 那行 `effectiveStatus` 守卫必须随 ShareContext 冻结一起处置(删除或放行 `ACCESS_LIMIT_REACHED`),否则触顶后附件下载会被误拒。
8. **T-07 补一句边界**:KV `expirationTtl` 最小 60 秒,`remaining < 60` 时跳过写入。

---

## Update Log

- 2026-08-24 · plan-reality-recon(Mode R):W1(T-05→T-08)侦察落盘。核实 4 个目标函数坐标全部命中(`effectiveStatus:25-33` / `establishSession:243-272` / `resolveSession:274-295` / `recordAccess:236-241`);发现 6 处 deviation,其中 2 处为 P0 需用户裁决(AC-LIFE-14 语义反转、ShareContext 换形使 T-09 无法全绿);2 项 charter 遗漏(`share-api.js` 未登记热区、fast-check 未安装且无任务归属);1 项平台陷阱(KV `expirationTtl` 最小 60 秒,已核 Cloudflare 官方文档)。逐对论证 T-05..T-08 不可并行(依赖为控制流与语义,非文件锁)。T-10 有条件可提前、T-12 不可(阻塞源在 W0 而非 T-08)。基线实跑:`share-auth-service.spec.js` 11 passed、三文件合计 29 passed。零业务代码改动,零 commit。侦察末尾复核工作树:W0 执行者已落下 T-02/T-03 未提交改动(5 文件 +307),W1 白名单文件零改动,全部 W1 结论有效,仅 §7.3 的 T-12 阻塞理由按新事实收窄为「等 W0 提交」。
