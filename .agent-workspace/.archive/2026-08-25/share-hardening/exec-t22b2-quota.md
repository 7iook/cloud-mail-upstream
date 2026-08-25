# T-22B2 · maxSessions 只统计真人新打开

**成功状态(逐字抄自交付契约,未改写)**

> NOT「计数逻辑加了个分支」, BUT 管理员设「最多 3 个访问名额」时,得到的是「最多 3 个人能打开这条链接」,而不是「访客的浏览器自动续了 3 次会话就没了」—— 一个访客盯着页面看半小时,不该把名额吃掉两个。
> 不该发生: 访客能通过构造请求让自己永远不计数,从而绕过名额限制。
> 来源: 用户裁决(2026-08-25「把自动重建排除出配额计数」)+ 决策卡 §6 第 3 项

---

## 1. 续期判据:为什么不可伪造

**判据 = 访客交回「本分享自己签发过的 session token」。** 服务端只认自己用签名密钥环签出来的值,不认请求里任何一句「我是续期」。

`isRenewal(c, row, lidText, previousSessionToken)`(`share-auth-service.js` · `parseToken` 验签后四道绑定):

| 检查 | 挡住什么 |
|---|---|
| HMAC 验签(`signingRing`,含 prev kid) | 访客自造/改写的 token。签名密钥只在 worker env 里,访客手上没有 |
| `payload.shareId === row.shareId` 且 `payload.lid === lidText` | 拿一条无限额分享上白得的真 token,去给限额分享白嫖座位 |
| `payload.cv === row.credentialsVersion` | 撤销 / `resetAuthKey` 轮换后旧 token 立刻失去续期资格 |
| `payload.exp + RENEWAL_GRACE(3600s) > now` | 泄漏的死 token 无限期当免费座位;超窗口就退回计数 |

**为什么必须是服务端签名,而不能是任何客户端可控字段:** 同一条链接的每个访客手里的东西完全一样 —— `lid`、`sec`、(可选)AuthKey 全是共享的。所以**不存在任何访客能自己产生、而别的访客产生不出来的凭证**。要区分「同一个人续期」和「另一个人首次打开」,唯一可能的锚点就是「只有服务端能签、且服务端只签给已经付过名额的人」的那个值。`isRenewal: true` 之类的请求字段任何人都能带,带上就永不计数 —— `maxSessions` 当场归零。

**失败时的姿势是「退回计数」而不是「报错」。** 伪造判据不成立 → 当作一次普通的首次打开 → 走原来的计量路径 → 该占名额占名额、该被 cap 拒就被拒。这样伪造不是「被拦下」而是「毫无收益」,负向条件(构造请求永不计数)在结构上不成立。

**续期不跳过任何校验(交付契约要求 2):**

- 续期与首次开走**同一条 UPDATE 语句**(`consumeSessionQuota` 加 `renewal` 形参),没有第二个写入者。`status='ACTIVE'`、`expires_at > now`、`credentials_version = ?`、`auth_key_enabled = ?` 四条 WHERE 谓词对续期原样生效,并发的 revoke / 过期 / 轮换照样让续期拿到空 RETURNING 而被拒。
- 续期**唯一放开的是配额谓词** `access_count < max_sessions`,以及快照期的 `ACCESS_LIMIT_REACHED` 拒绝 —— 这正是要修的 bug 本身(名额满了不该把已经在房间里的人赶出去)。
- 续期路径**仍然要过 AuthKey 校验**。持有本分享签发的 token 不能替代第二因子。

## 2. 红绿证据

命令:`pnpm --dir mail-worker test share-auth-service`(工作目录 `F:\Email\cloud-mail-upstream`)

**RED**(实现前,退出码 1):

```
 × shareAuthService session renewal quota > spends no slot when a visitor renews with the token this share signed (T-22B2)
   → SHARE_UNAVAILABLE   (❯ denyQuota src/service/share-auth-service.js:423:2)
 × shareAuthService session renewal quota > meters a renewal presented long after its token died (T-22B2)
   → SHARE_UNAVAILABLE
 × shareAuthService session renewal quota > still demands the AuthKey when renewing a keyed share (T-22B2, AC-AUTH-01)
   → SHARE_UNAVAILABLE
 × shareAuthService session renewal quota > carries the visitor session token on POST /share/session so the page can renew (T-22B2)
   → expected 501 to be 200
      Tests  4 failed | 61 passed (65)
[ELIFECYCLE] Test failed.   exit code 1
```

红的原因是功能缺失(`denyQuota` 在 cap 处拒绝续期),不是语法/import 错误。

**GREEN**(实现后,退出码 0):`Tests 65 passed (65)`

**全量**(`pnpm --dir mail-worker test`,退出码 0):`Test Files 18 passed (18) · Tests 652 passed (652)`

基线核对:开工前实测 `18 files / 636 passed`(退出码 0)。本包 `share-auth-service.spec.js` 从 59 → 65(`git show HEAD:` 对比 `^\tit\(` 计数),+6 条全部是本包新增。652 − 636 = 16,其余 +10 来自并行执行者对 `mail-share-service.spec.js` 的改动(`git status` 确认该文件与 `mail-share-service.js` 被他人修改,本包未触碰)。只增不减。

### 2.1 反伪造测试确实有牙(变异验证)

「伪造仍计数」这条测试在实现前**也是绿的**(当时根本没有续期路径,所以是空过)。为了证明它不是摆设,做了两次故意变异,跑完即回滚:

| 变异 | 结果 |
|---|---|
| `isRenewal` 直接 `return true`(判据变成客户端可控) | `Tests 3 failed \| 62 passed` —— 反伪造、撤销/轮换、超窗口三条同时打红 |
| 保留验签、去掉 `shareId`/`lid` 绑定 | `Tests 1 failed \| 64 passed` —— 精确打红反伪造那条(跨分享 token 白嫖) |

两次变异后源码已还原,最终全量绿即在还原后的版本上跑出。

## 3. `ACCESS_LIMIT_REACHED` 既有语义未被破坏

三条既有断言未改动、未放宽,全部仍绿:

- `serves an already-issued keyed session after max_sessions is reached (AC-SESS-06, AC-AUTH-01)`(spec:1456)—— 名额用尽后已建立会话继续可读,且**不带续期 token 的重新 establish 仍被拒、`access_count` 仍是 1**。
- `keeps an issued session readable after the cap is reached while refusing a new session (AC-SESS-06, AC-LIFE-04, P-SESS-03)`(spec:622)。
- `lets an ACCESS_LIMIT_REACHED context still download an attachment (T05-attach, AC-SESS-06)`。

新增测试从正面补上了对称的另一半:cap 已满时,**不带 token = 被拒(仍是原语义)**,**带本分享签发的 token = 放行且不加计数**。两者在同一条测试里相邻断言,任何一边被改坏都会打红。

源码结构围栏 `expect(shareAuthSource.match(/\.(update|insert|delete)\(/g)).toEqual(['.update('])`(spec:1016)仍绿 —— 续期没有引入第二个写入者。

## 4. 前端重建行为的核实结论(⚠️ 本包交付后仍有一处未接线)

读了 `mail-vue/src/views/share/index.vue` 与 `mail-vue/src/request/share.js`(只读,未修改):

- `reestablishSession()`(index.vue:692-711)→ `postSession(lid, sec, '')`。
- `postSession`(index.vue:636-647)→ `createShareSession(lid, sec, { authKey, idempotencyKey })`。
- `createShareSession`(share.js:162-172)只组装 body `{lid, sec[, authKey]}` 和 `Idempotency-Key` 头;从不设置 `shareSessionToken`,于是请求拦截器(share.js:132-136)把 `Authorization` 置空。

**结论:今天的自动重建不会带上旧 token,后端会把它判为「首次打开」照常计数。** 后端判据本身是对的,但要真正生效,必须由前端补两处(**不在本包边界内,未改**):

1. `mail-vue/src/request/share.js:162` —— `createShareSession` 接受 `previousSessionToken`,写进 `config.shareSessionToken`(拦截器会自动转成 `Authorization: Bearer …`)。
2. `mail-vue/src/views/share/index.vue:698` —— `reestablishSession` 把 `sessionToken.value` 作为 `previousSessionToken` 传下去。

已核实第 2 点可行:重建发生在 `recoverFromUnavailable` 里,`sessionToken.value` 此刻**仍持有那枚刚过期的 token**(唯一清空它的 `clearMailboxView` 只在 `showDeadShare` / `showTimedOut` 里跑,都在重建失败之后);`sessionStorage` 里的 `readShareSession(lid)` 也还在。所以前端手上就有服务端要的那个值,只是没发出去。

传输层选 `Authorization` 头而不是 body:与其它 share 端点一致,且避免把 token 塞进网关默认会记日志的 body(AC-SEC-09)。

## 5. e2e 真跑一次

浏览器级 e2e 跑不通(前端未接线,见 §4)。在 worker HTTP 边界上真跑了一次等价链路 —— `carries the visitor session token on POST /share/session so the page can renew`,走 `SELF.fetch` 打真实路由:

1. `maxSessions=1` 的分享,`POST /share/session` 首次建立 → 200,拿到 token;
2. 同样的请求**不带 Authorization** = 第二个访客 → `code 501`(名额已满,原语义保持);
3. 同样的请求**带 `Authorization: Bearer <首枚 token>`** → 200,拿到新 token。

服务层另有 `spends no slot …` 覆盖契约描述的「TTL 过期后自动重建」姿势:mock `Date.now` 跨过 900s exp,确认旧 token 已 resolve 不动,再用它续期成功且 `access_count` 仍为 1;继续跨到第二个 15 分钟,用续期后的 token 再续一次,`access_count` 依旧是 1(链式续期不累积)。

## 6. Review Findings

- **任务文档锚点漂移(Tier 1,自行校正)**:契约写 `consumeSessionQuota` 在 `share-auth-service.js:430-442`,实际是 `:434-446`;`issueToken` 写 `:211-220`,实际 `:206-238`。均按实际代码执行,文档已提示「行号可能微移」。
- **越出声明的独占文件集:改了 `mail-worker/src/api/share-api.js`(+4 行)**。理由:`establishSession` 的 `options` 由这一个传输点组装,不改它则新参数永远收不到值 —— 后端自身就是断链的(E-052「建了没接线」)。该文件不在禁改清单上(禁的是 `mail-share-service.js` 及其 spec、`mail-vue/`),`git status` 确认并行执行者未触碰它,无冲突。改动是纯管道:复用已有的 `readSessionToken(c)`。
- **`verifyToken` 拆成 `parseToken` + 过期判断**,行为逐条等价(原来的 null 分支集合 `!payload || exp<=now || shareId==null || !lid` 原样保留,只是拆到两个函数)。`resolveSession` 一字未动,结构围栏(spec:1010-1023)仍绿。
- **刻意没做的事**:没有为「续期判据被拒」新增 `SHARE_EVENT` 遥测。它需要改 `share-event.js`(第三个文件),而伪造尝试在本设计里等价于一次普通的首次打开,不构成独立的拒绝事件。如果后续要做安全告警,这是个可加的钩子。
- **未上调 `SHARE_SESSION_TTL`**,仍为 900,按决策卡裁定。
- **潜在风险(已知、可接受、留档)**:续期链能被「持有 token 的任何人」延续。但这不是本次新增的能力面 —— 今天泄漏一枚活 token 就已经能通过 `resolveSession` 免费读全部内容;新增的只是「死 token 在 1 小时宽限内还能换新」。链条的绝对上界仍是分享自己的 `expires_at`(`issueToken` 的 `exp = min(shareExp, iat+ttl)` 加上 UPDATE 里的 `expires_at > now` 双重封顶),且 cv 一 bump 立刻断链。所以没有额外加链长计数器。
- 未 `git commit`,未 `git stash`。
