# T-22b3 · 前端续期接线(自动重建不再扣访问名额)

执行者:executor SUB · 2026-08-25

## 成功状态(逐字抄自交付契约,未改写)

NOT「createShareSession 多了个参数」, BUT 一个访客打开分享链接后一直停在页面上看邮件,半小时里浏览器自动续了两次会话,管理员那边的「访问名额」只被扣了 1 个 —— 因为从头到尾只有这一个人打开过这条链接。

- 不该发生:续期请求把 token 放进请求体(网关默认会记录 body,那是一次性凭据泄漏面)。
- 来源:决策卡 §6 第 3 项用户裁决「把自动重建排除出配额计数」。

## 链路逐格核实

| 节点 | 契约给的锚点 | 实际核实结果 |
|---|---|---|
| 后端判定 | `share-api.js:57-64` `readSessionToken(c)`(已就绪) | ✅ 成立,锚点略偏:`readSessionToken` 定义在 `:41-45`,`:64` 是它作为 `previousSessionToken` 传给 `establishSession` 的消费点。不影响结论 |
| 请求装配 | `request/share.js:162` `createShareSession`(待改) | ✅ 原 `:162`,未传 `config.shareSessionToken` → 拦截器 `:132-136` 把 Authorization 置空 |
| 既有通道 | `shareSessionToken(config)` `:80-86` → 拦截器 `:132-136` | ✅ 已 trim、空值走 `setAuthorization(headers, '')` 删除头,不需要新造机制 |
| 前端重建 | `share/index.vue:692-737` `reestablishSession`(待改) | ✅ 函数体实为 `:692-711`;`:737` 是它唯一的调用点 `recoverFromUnavailable`。原先调 `postSession(lid, sec, '')` |
| 最终 sink | D1 `mail_share.access_count` 不再被自动续期递增 | 后端侧,本轮未验(不属本任务范围,见「未验证项」) |

## `sessionToken.value` 在重建时点的实际状态(任务要求的核实结论)

**结论:调用 `reestablishSession()` 那一刻,`sessionToken.value` 确实仍持有刚过期的旧 token,无需先存后清。**

依据(`index.vue` 读码):

- 唯一调用链是 `noteShareFailure(:766)` → `recoverFromUnavailable(:713)` → `reestablishSession(:737)`。
- 该链路上把 `sessionToken.value` 置空的只有三个函数:`clearMailboxView(:666)`(经 `showDeadShare(:674)` / `showTimedOut(:683)` 调用)与 `exitShare(:820)`。前两者在 `recoverFromUnavailable` 中**全部位于 `reestablishSession()` 之后**(`:739` / `:754` 失败分支、`:759` 兜底),`exitShare` 是访客主动退出的独立路径。
- 因此进入 `reestablishSession` 时旧值完好;成功后由 `:705` 覆写为新 token。
- 另有一条「刷新后从 sessionStorage 复活」路径 `bootstrap(:955)` 也会把 `sessionToken.value` 填成存量 token,同样满足前提。

## 改动

1. `mail-vue/src/request/share.js:158-178` —— `createShareSession` 增收 `previousSessionToken`,非空(trim 后)时写 `config.shareSessionToken`,由既有拦截器转成 `Authorization: Bearer <token>`。**不进 body**,与 `authKey` / `idempotencyKey` 同样保持「留空则请求形状完全不变」。注释说明了为什么复用 Authorization 头恰好绕开 AC-SEC-09。
2. `mail-vue/src/views/share/index.vue:637-647` —— `postSession` 增加第 4 参 `previousSessionToken = ''`,首发与丢包重放两次都带同一个值(幂等键不变,后端判据不成立时退计数,重放无副作用)。
3. `mail-vue/src/views/share/index.vue:692-716` —— `reestablishSession` 传 `sessionToken.value` 下去,并就地留下「此刻旧值仍在手、清理动作都在其后」的依据注释。首次打开(`bootstrap:934`)与 AuthKey 提交(`submitAuthKey:787`)**不传**,保持原请求形状。

## 测试

新增 3 条(2 request 层 + 1 视图层):

- `share.spec.js` · `renews with the previous session token on the Authorization header, never in the body` —— 断言 `Authorization: Bearer <旧token>`,且 body 恒为 `{lid, sec}`、URL / params / body 均不含该 token。
- `share.spec.js` · `leaves the request shape untouched on a first open and on a blank previous token` —— 无参 / `''` / `null` / `'   '` 四种输入都不设该头,且反向断言不得出现 `Bearer ` 这类畸形值。
- `index.spec.js` · `hands the expiring token to the rebuild so a renewal is not counted as a second visitor` —— 首开调用不带 `previousSessionToken`;轮询撞 `SHARE_UNAVAILABLE` 触发重建后,最后一次 `createShareSession` 带 `previousSessionToken: 'sess-a'`(即刚过期那个),且新 token 落盘。

### 红(实现前 · 因功能缺失而红,非语法错)

```
 ❯ src/request/share.spec.js (16 tests | 1 failed)
     × renews with the previous session token on the Authorization header, never in the body
       AssertionError: expected undefined to be 'Bearer sess-about-to-expire'
 ❯ src/views/share/index.spec.js (56 tests | 1 failed)
     × hands the expiring token to the rebuild so a renewal is not counted as a second visitor
       - "previousSessionToken": "sess-a"
       + "authKey": "",  "idempotencyKey": "919add9f..."
 Test Files  2 failed (2)      Tests  2 failed | 70 passed (72)
```

### 绿(实现后)

```
 Test Files  2 passed (2)      Tests  72 passed (72)
```

### 变异验证(两处分别变异 · 均已还原)

- 变异 A:删除 `share.js` 里 `config.shareSessionToken = previousSessionToken` 赋值块 → `Tests 1 failed | 15 passed (16)`,失败项正是新加的 Authorization 断言。已还原。
- 变异 B:`reestablishSession` 改回 `postSession(lid, sec, '')` → `Tests 1 failed | 55 passed (56)`,实际收到 `previousSessionToken: ""`。已还原。

### 还原后复跑(全量 · 任务要求贴出)

```
$ pnpm --dir mail-vue test
 Test Files  23 passed (23)
      Tests  283 passed (283)
```

基线 280 → 283,只增不减。还原态已用 `Read` 逐行确认:`share.js:174-176` 赋值块在位,`index.vue:698` 为 `postSession(lid, sec, '', sessionToken.value)`。

## Review Findings

- **锚点漂移(Tier 1 自纠,已按实际执行)**:契约写的 `share-api.js:57-64 readSessionToken(c)` 实际定义在 `:41-45`;`reestablishSession` 的 `:692-737` 实际是 `:692-711`,`:737` 属调用方。均为行号偏移,语义一致,不影响执行。
- **契约未列但必经的中间层**:`reestablishSession` 并不直接调 `createShareSession`,中间隔着 `postSession(:637)`(承载幂等键与丢包重放)。改动因此落在三处而非契约暗示的两处;`postSession` 的另外两个调用方(`bootstrap:934` 首开、`submitAuthKey:787` 提交 AuthKey)刻意不传新参,靠默认值 `''` 保持原形状。
- **测试文件发现**:`views/share/index.spec.js` 已存在(56 条),视图层断言直接并入,未新建文件。
- **潜在风险(未在本轮处理,登记)**:`bootstrap()` 在 lid 切换时不重置 `sessionToken.value`(`resetMailbox()` 也不清)。当前无害——首开路径本就不传 `previousSessionToken`;但若日后有人给 `bootstrap` 的 `postSession` 补上该参,就会把 lid-a 的 token 当作 lid-b 的续期凭据发出。后端有 `shareId` 绑定校验会拒掉并退回计数,不构成安全问题,但属于易踩的接线陷阱。
- **越界检查**:`git diff --stat` 确认本轮只动了 `mail-vue/src/request/share.js` · `mail-vue/src/request/share.spec.js` · `mail-vue/src/views/share/index.vue` · `mail-vue/src/views/share/index.spec.js`。`mail-worker/` 下的改动全部来自并行执行者,未触碰;`share-admin/` 与 `email/ShareDialog.vue` 未触碰。未 commit,未 stash。

## 未验证项

- `unverified: D1 mail_share.access_count 的实际不递增`——需要真实 Worker + D1 跑「maxSessions=1 分享 → 会话 TTL 过期 → 自动重建 → 查 access_count 仍为 1」的 e2e,后端计数逻辑在并行执行者的 `mail-share-service.js` / `share-auth-service.js` 里且本轮禁止触碰。本轮证据止于「前端把旧 token 送进了 Authorization 头,后端 `share-api.js:64` 正是从这里取值」这一衔接点。
