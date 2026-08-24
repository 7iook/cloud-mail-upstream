# Exec Note · T-17 perm 路径(`requirePermsExact` 3→8 + `premKey['share:manage']` 3→8)

- **日期**:2026-08-24 · **分支**:`cursor/mailbox-share-capability-dcb6` · **起点 HEAD**:`3488bf0`(T-16 `3bb1d55` 已入库)
- **未 commit / 未 push / 未 stash**;`tasks.md`、`docs/specs/**`、`mail-share-api.js`、`share-api.js`、`mail-share-service.js`、`init.js`、`wrangler*.toml`、`mail-vue/**`、`tests/e2e/**` 一字未动。
- **`excludeExact` / `excludePrefixes` / `requirePerms` 三张表零改动**(`git diff` 逐行核过,见下方 diff 全文)。
- **白名单内改动**(3 个文件,与派单一致):

| 文件 | 增/删 | 说明 |
|---|---|---|
| `mail-worker/src/security/security.js` | +19 / −2 | 只有两处数组字面量;中间件逻辑 `:107-185`、`matchesExact`、`permKeyToPaths` 一字未动 |
| `mail-worker/test/security-share.spec.js` | +168 / −21 | 删除的 21 行全部是 `owner routes require JWT and share:manage` 那 4 条硬编码用例,原地改写成 `it.each` 表驱动(断言逐字保留) |
| 本文件 | 新建 | — |

### 起跑闸门(recon §5)

两条判据起跑前实测**均命中**,因此走完整 8 条、无 P2 降级:

```
mail-worker/src/api/mail-share-api.js:53      app.post('/mailShare/resetAuthKey', withShare(async (c) => {
mail-worker/src/service/mail-share-service.js:1270   async resetAuthKey(c, params, userId) {
```

---

## 红 / 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 基线 | `pnpm --dir mail-worker exec vitest run test/security-share.spec.js --no-cache` | **36 passed** |
| 红(仅用例就位,`security.js` 未动) | 同上 | **5 failed / 143 passed(148)** |
| 绿 | 同上 | **148 passed(148)** |
| 全量 worker | `pnpm --dir mail-worker test -- --no-cache` | **18 files / 577 tests 全绿**(T-16 收口态 18/465,+112 全部来自本 spec) |
| 前端 | `pnpm --dir mail-vue test -- --no-cache` | **17 files / 95 tests 全绿** |

红的 5 条正是缺口的 5 条(`get` / `update` / `delete` / `bindings` / `resetAuthKey`),**全部来自 A2 负向组**,与 recon §3.5「红灯的唯一可靠来源是 A2」逐字吻合。失败断言是 `expected 501 to be 403` —— **收到 501 说明请求穿过中间件真的进了 handler**,即这 5 条端点当时完全没有权限闸。A1/A3/B/C/D 各组在红态即绿,它们是回归护栏而非红灯来源。

### 变异校验(证明两张表各自承重)

| 变异 | 结果 | 捕获者 |
|---|---|---|
| **M1** 只回滚 `premKey['share:manage']`(`requirePermsExact` 留 8 条)= **自锁** | **5 failed** | **A3 正向组** —— 持 `share:manage` 的 Owner 反被 403 |
| **M2** 只回滚 `requirePermsExact`(`premKey` 留 8 条)= **空转 / 无闸** | **5 failed** | **A2 负向组** —— 端点不进权限分支 |
| **M3** 把 `'/mailShare'` 加进 `requirePerms` 前缀表(recon N3 明令禁止) | **25 failed** | **D 组** —— 24 条近似路径从 404 退化成 403,外加 `GET /mailShare/List` |

M1 与 M2 由**不同断言组**捕获,这正是 T17-BOTH 拍板要的取证:任何「只改一张表」的后续改动都会当场变红,且红的位置直接指出坏的是哪一半。三次变异后 `security.js` 均已还原,`git diff` 回到绿态并重跑确认 148/148。

---

## 实现(最小 diff,两处数组字面量)

```diff
 const requirePermsExact = [
 	{ method: 'POST', path: '/mailShare/create' },
 	{ method: 'GET', path: '/mailShare/list' },
-	{ method: 'DELETE', path: '/mailShare/revoke' }
+	{ method: 'GET', path: '/mailShare/get' },
+	{ method: 'PUT', path: '/mailShare/update' },
+	{ method: 'DELETE', path: '/mailShare/delete' },
+	{ method: 'PUT', path: '/mailShare/bindings' },
+	{ method: 'DELETE', path: '/mailShare/revoke' },
+	{ method: 'POST', path: '/mailShare/resetAuthKey' }
 ];
```

```diff
-	'share:manage': ['/mailShare/create', '/mailShare/list', '/mailShare/revoke']
+	// Must stay in lockstep with requirePermsExact: that table decides which paths enter
+	// the exact-perm branch, this one decides which paths a holder can match. Adding to
+	// only one side either leaves the route ungated or locks out every non-admin owner.
+	'share:manage': [
+		'/mailShare/create',
+		'/mailShare/list',
+		'/mailShare/get',
+		'/mailShare/update',
+		'/mailShare/delete',
+		'/mailShare/bindings',
+		'/mailShare/revoke',
+		'/mailShare/resetAuthKey'
+	]
```

- 两表**同序**(create / list / get / update / delete / bindings / revoke / resetAuthKey),便于人工比对。
- method 逐条对照 `mail-share-api.js` 真实 verb(recon R4):create=POST、list=GET、get=GET、update=**PUT**、delete=**DELETE**、bindings=**PUT**、revoke=**DELETE**、resetAuthKey=POST。这条对照现在也由「路由枚举闭包」用例机器验证(见下 §用例 A4)。
- 那三行注释是 `security.js` 里**唯一**的新增说明性文字,写的是两张表的耦合约束(代码本身看不出来的东西),不解释 diff。

---

## 用例(`security-share.spec.js` 36 → 148)

顶部新增两张常量表 `OWNER_ENDPOINTS`(8 条,method + path)与 `VISITOR_READ_PATHS`(4 条),后续所有枚举都从它们派生,新增端点只需改一处。

### A 组 · Owner 8 条门控(AC-ADMIN-10),共 25 条

| 组 | 凭据 | 断言 | 条数 |
|---|---|---|---|
| A1 | 无 Authorization | `code === 401` | 8 |
| A2 | `noShareJwt`(role 99,无 `share:manage`) | `code === 403` **且** `message === 'SHARE_FORBIDDEN'` | 8 |
| A3 | `hasShareJwt`(role 98,有 `share:manage`) | `status === 200` **且** `code !== 403` **且** `code !== 401` | 8 |
| A4 | — | `mail-share-api.js?raw` 里抽出的 `/mailShare/*` 路由集合 `toEqual` `OWNER_ENDPOINTS` 集合(双向,再加长度) | 1 |

- **A2 的 message 断言不可省**(recon R6):`:168` 那条分支同样是 403(消息 `Unauthorized`),只断码分不出走的是哪条。
- **A3 的 `status === 200` 不可省**(recon R3):Hono 404 不走 `onError`、`body.json` 为 `null`,`json?.code !== 403` 在 `null` 上恒真 —— 少了这一句,「路由不存在」会伪装成正向通过。8 条实测返回 `code` 为 200(list)/ 501(其余业务错误,如 `SHARE_NOT_FOUND` / `SHARE_ACCOUNT_FORBIDDEN` / `SHARE_INVALID_CONFIG`),不断言具体错误码(那属 T-15/T-16 的 spec 领域)。
- **A4 是抗回归的关键**:T-19 之后再加 Owner 端点而漏登记,这条会直接变红,不必等有人想起来补一条硬编码用例。正则 `app\.(get|post|put|delete|patch)\(\s*'([^']+)'` 容忍格式化,不用整串 `toContain`(recon R9)。
- POST/PUT 一律带 `content-type: application/json` + `'{}'`,避免 `c.req.json()` 抛 `SyntaxError` 走进异常路径(recon R8)。

### B 组 · Owner / Visitor 凭据双向不互通(AC-SEC-02),共 17 条

- **B1(8 条)Visitor share token 打 8 条 Owner 端点 → `code === 401` + `message === 'Authentication has expired. Please sign in again'`**。⚠️ 断的是 **401 而非 `SHARE_FORBIDDEN`**(recon R2):4 段 `s1.*` token 走独立签名环,在 `jwtUtils.verifyToken` 就返回 `null`,**根本到不了 perm 分支**。
- **B1 用的是真 token,不是手搓的形状**:`beforeAll` 里新增 `mintVisitorSessionToken()` —— 给 `hasShareUser` 建一个 account,用 `hasShareJwt` 打 `POST /mailShare/create`,再拿 `lid`/`sec` 打 `POST /share/session` 取 `sessionToken`。配套一条断言钉住它确实是 4 段且以 `s1.` 开头,防止哪天 mint 失败退化成 `undefined` 让 B1 假绿(`undefined` 同样会拿 401)。
- **B2(4 条)** Owner JWT 打 4 条 Visitor 读端点 → `status === 200` + `code === 501` + `SHARE_UNAVAILABLE`。JWT 不构成 Visitor 凭据。
- **B3(1 条)** `POST /share/session` 带与不带 Owner JWT,同一 body 打两次 `toEqual` 整个响应对象。比断某个错误码更能证明「JWT 在 Visitor 面无任何效力」。
- **B4(1 条)** `share-api.js?raw` 不含 `jwt-utils` / `userContext` / `TOKEN_HEADER` —— AC-SEC-02「SHALL NOT 复用登录态设施」的结构证据。
- **B5(4 条)** 无任何凭据打 4 条 Visitor 读端点 → `SHARE_UNAVAILABLE`。证明豁免只是把闸门从 JWT 换成 share token,**不是开门**(既有 `notRequireJwt` 用例只证豁免生效,没证这一点)。

### C 组 · Visitor 面零写端点(AC-SEC-04),共 21 条

- 4 条读路径 × `POST/PUT/PATCH/DELETE` = 16 条,加 `/share/session` 的 `GET/PUT/PATCH/DELETE` 4 条,全部断 `code === 401`(不在 `excludeExact` → 落回 JWT 闸)。
- 1 条静态断言:`share-api.js` 的非 GET 路由集合 `toEqual([['POST', '/share/session']])`。Session 建立不是邮件写操作,这条把「Visitor 面只存在读端点」钉成可回归的结构事实。

### D 组 · 前缀封闭(AC-SEC-10),共 51 条(**Owner 侧此前完全没有**)

- 8 条路径 × 3 个近似变体(尾缀 `X` / 下级 `/extra` / 截断 `slice(0,-1)`)= 24 条,各跑两遍:无 JWT → `code === 401`;带 `noShareJwt` → **`status === 404`**。
- 断 **404 而不是 `SHARE_FORBIDDEN`** 是刻意的,也正是这条的价值:近似路径不在 `requirePermsExact` 里 → 不进权限分支 → Hono 兜底 404。**一旦有人把 `/mailShare` 塞进 `requirePerms` 前缀表,这 24 条会立刻变红**(M3 实测 25 failed)。
- 3 条大小写 / 尾斜杠变体:`/MAILSHARE/list`、`/mailShare/list/`、`/mailShare/List` → 404。实测 Hono 严格匹配,尾斜杠**不会**被折成 `/mailShare/list`(若会,`matchesExact` 全等比较就会漏掉它,是个真洞;现已钉死)。
- **`:84-111`(T-14 前缀基线)与 `:183-223`(既有前缀路由回归)`git diff` 为空**,一字未改。`AC-VISIT-08 writes stay JWT-gated` 那段也**保持原样未动** —— A1 组已在新 describe 里覆盖全 8 条,不必去改既有基线块。

---

## 行为变更登记(recon R10,供 T-20 / T-21 参照)

**4 条已上线端点从「裸 JWT」收编为「JWT + `share:manage`」**:`GET /mailShare/get`、`PUT /mailShare/update`、`DELETE /mailShare/delete`、`PUT /mailShare/bindings`。第 5 条 `POST /mailShare/resetAuthKey` 随 T-16 同波次落地,从未裸奔过。

- **收编前**:任意登录用户都能调这 4 条。数据面不越权(service 谓词恒带 `user_id`,他人 `shareId` 一律 `SHARE_NOT_FOUND`),破的是路由级权限语义 AC-ADMIN-10。
- **收编后**:不持 `share:manage` 的角色由「能调 4 条」变成「一条都不能调」,统一收到 **403 + `SHARE_FORBIDDEN`**。持 `share:manage` 的角色行为不变。
- 前端 `hasPerm('share:manage')`(`ShareIndicator.vue:26`)只控按钮可见性,现在服务端有了对应的硬闸。**T-20 的错误态需要能渲染 403 `SHARE_FORBIDDEN`**,而不只是 401 跳登录。
- `mail-share-service.spec.js` 的 T-13/T-15 HTTP 用例未被打红(recon R12 的最大跨文件回归面):`ownerJwt()` 的测试用户本来就挂着 role 98 + `share:manage`。全量 577/577 实跑确认。

---

## 未做事项 / 遗留

| # | 项 | 说明 |
|---|---|---|
| L1 | **未补 admin 后门的显式契约用例**(recon R5 的建议) | `security.js:164` 的 `authInfo.user.email !== c.env.admin` 让 `admin@example.com` 绕过一切 perm,目前**没有任何测试**钉住它 —— 将来有人「顺手修掉」这个 else 分支不会有测试变红。没做的原因:派单明令「不得用 `admin@example.com` 做负向种子」,而该用例需要以 `admin@example.com` 为种子(虽属正向),且 `init.js` 可能已占用该邮箱、`INSERT` 有撞唯一约束的风险。**建议单开一条任务裁决**,不要顺手塞进 T-17。 |
| L2 | 未动 `AC-VISIT-08 writes stay JWT-gated` 既有块 | 其中 3 条 Owner 路径与 A1 组重复。留着不改是为了让 T-14/T-05 的基线块 `git diff` 保持为空;代价是 3 条冗余断言。 |
| L3 | `beforeAll` 现在会真的建一条分享 | `mintVisitorSessionToken` 给 `t05-hasperm@example.com` 建了 1 个 account + 1 条 `mail_share`。vitest-pool-workers 的 `isolatedStorage` 默认开启,`beforeAll` 的写入只在本文件内可见、跨文件自动回滚,所以不需要 `afterAll` 清理,也不会污染 `mail-share-service.spec.js` / `share-status.spec.js` 的计数。**若将来有人关掉 `isolatedStorage`,这条会变成跨文件污染源。** |
| L4 | A3 不断言具体业务错误码 | 空参/空 body 下 8 条返回 `SHARE_NOT_FOUND` / `SHARE_ACCOUNT_FORBIDDEN` / `SHARE_INVALID_CONFIG` 等,那是 T-15/T-16 的 spec 领域(recon R7),在 security spec 里断会造成跨文件耦合。 |
| L5 | 未改 `tasks.md` | 派单要求。T-17 / T-17.1 / T-17.2 的勾选与 Evidence 留给主 AI。 |
| L6 | 未 commit | `git add` / `git commit` / `git stash` 一次都没跑。工作树内仅 `security.js` 与 `security-share.spec.js` 两个文件 modified。 |
