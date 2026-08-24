# Recon · T-17 perm 路径(`premKey['share:manage']` 3→8 + `requirePermsExact` 3→8)

| 字段 | 值 |
|---|---|
| 范围 Scope | T-17 / T-17.1 / T-17.2,`docs/specs/mailbox-share-capability/tasks.md:388-392` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`(HEAD `4fbf9a8`,`mail-worker/` 工作树干净) |
| 侦察日期 | 2026-08-24 |
| 依据 AC | AC-ADMIN-10、AC-SEC-02、AC-SEC-04、AC-SEC-10 |
| 唯一写者 | T-17 是 `mail-worker/src/security/security.js` 与 `mail-worker/test/security-share.spec.js` 的**下一唯一写者**(tasks.md:25、:470) |
| 性质 | 只读侦察。**未改任何文件、未提交**;本文件是唯一产物 |

---

## 0. 一句话结论

T-17 表面是「一行数组从 3 条改成 8 条」,实际有三个非平凡点:

① **要改的是两张表,不是一张**。`requirePermsExact:72-76` 决定「这条路径是否进入精确权限模式」,`premKey['share:manage']:104` 决定「持权者能匹配到哪些路径」。**只改其中一张都会坏**:只加 premKey → 端点根本不进权限分支(继续裸奔);只加 requirePermsExact → 连持有 `share:manage` 的 Owner 也被 403(自锁)。tasks.md:391 只写了 premKey,这是任务书的疏漏,`recon-t16-authkey.md:192-194` 已点名两处都要加。

② **「Visitor token 不能打 Owner」不会返回 `SHARE_FORBIDDEN`,而是 401**。Share session token 是 4 段 `s1.kid.payload.sig`、独立签名环(`share-auth-service.js:204-233`),进不了 `jwtUtils.verifyToken`(`security.js:129`)→ `null` → `authExpired` 401,**根本走不到 perm 分支**。红测断言若写死 `SHARE_FORBIDDEN` 会永远红。

③ **`/mailShare/resetAuthKey` 现在还不存在**(T-16 未落地,`mail-share-api.js` 只有 7 条)。第 8 条路径若先行写进 security.js,会造出一条**指向空路由的权限登记**;若先行写进红测,`hasShareJwt` 正向枚举会拿到 404。第 8 条必须等 T-16 的符号出现,见 §5。

---

## 1. Q1 · 两张表的现状与缺口

### 1.1 已落地的 Owner 端点(7 条,`mail-share-api.js`)

| # | Method | Path | 落地任务 | 在 `requirePermsExact:72-76` | 在 `premKey['share:manage']:104` |
|---|---|---|---|---|---|
| 1 | POST | `/mailShare/create` | T-12(`:23`) | ✅ `:73` | ✅ |
| 2 | GET | `/mailShare/list` | T-12(`:30`) | ✅ `:74` | ✅ |
| 3 | GET | `/mailShare/get` | T-15(`:35`) | ❌ **缺** | ❌ **缺** |
| 4 | PUT | `/mailShare/update` | T-15(`:40`) | ❌ **缺** | ❌ **缺** |
| 5 | DELETE | `/mailShare/delete` | T-15(`:46`) | ❌ **缺** | ❌ **缺** |
| 6 | PUT | `/mailShare/bindings` | T-13(`:51`) | ❌ **缺** | ❌ **缺** |
| 7 | DELETE | `/mailShare/revoke` | T-12(`:57`) | ✅ `:75` | ✅ |
| 8 | POST | `/mailShare/resetAuthKey` | **T-16 待落地** | ❌(路由尚不存在) | ❌(路由尚不存在) |

- **`requirePermsExact` 现状 3 条**:`POST /mailShare/create`、`GET /mailShare/list`、`DELETE /mailShare/revoke`。**缺 5 条**:`GET /mailShare/get`、`PUT /mailShare/update`、`DELETE /mailShare/delete`、`PUT /mailShare/bindings`、`POST /mailShare/resetAuthKey`。
- **`premKey['share:manage']` 现状 3 条**(路径,无 method):`/mailShare/create`、`/mailShare/list`、`/mailShare/revoke`。**缺同样 5 条**路径名。
- 缺口来源与前锋登记完全一致:`exec-t13-note.md:85`/`:91`(bindings 1 条)、`exec-t15-note.md:113` L1(get/update/delete 3 条,并已给出与本表逐字相同的 8 条清单)、`recon-t16-authkey.md:192-194`(resetAuthKey 1 条 + 明写「两处」)。
- **当前风险面**:4 条已上线端点只被 JWT 兜住,任意登录用户可调。数据面不越权(service 谓词恒带 `user_id`,他人 shareId 一律 `SHARE_NOT_FOUND`),破的是**路由级权限语义 AC-ADMIN-10**。

### 1.2 两张表的耦合语义(改一半即坏)

`security.js:146-171` 的判定链:

```
shareOwner = matchesExact(method, path, requirePermsExact)      // :146  方法+路径全等
permIndex  = requirePerms.findIndex(item => path.startsWith(item))  // :147-149  前缀
if (permIndex > -1 || shareOwner) {                              // :151  只有其一命中才查权限
    userPaths = permKeyToPaths(await permService.userPermKeys(...))  // :153-155
    hit = userPaths.findIndex(item => shareOwner ? path === item : path.startsWith(item))  // :157-162
    if (hit === -1 && user.email !== c.env.admin) {              // :164
        throw shareOwner ? BizError('SHARE_FORBIDDEN', 403) : BizError(t('unauthorized'), 403)  // :166-168
    }
}
```

四种组合的真值表:

| requirePermsExact | premKey | 结果 |
|---|---|---|
| 有 · 有 | | ✅ 目标态:无权 → `SHARE_FORBIDDEN` 403;有权 → 放行 |
| 无 · 无 | | 🔴 现状(4 条):`shareOwner=false` 且 `/mailShare` 不在 `requirePerms:32-70` 前缀表 → `permIndex=-1` → **完全跳过权限分支**,只剩 JWT |
| 有 · 无 | | 🔴 **自锁**:`shareOwner=true` 进分支,但 `userPaths` 里没有该路径 → `path === item` 恒 false → **连持 `share:manage` 的 Owner 也 403**,只有 `c.env.admin` 能用 |
| 无 · 有 | | 🟡 空操作:不进分支,premKey 多出的路径不被消费(也**不会**误放宽别处 —— 前缀模式的方向是「请求路径 startsWith 授权路径」,`/user/list`.startsWith(`/mailShare/get`) 恒 false) |

> 结论:**两张表必须同一个 commit 同时加同样 5 条**,不存在「先加一半」的安全中间态。

### 1.3 三个易踩的细节

- **`premKey` 无 method 维度**:`permKeyToPaths:195-206` 只吐路径,`:159` 的比较是 `path === item`。method 维度**只由 `requirePermsExact` 提供**。因此 `PUT /mailShare/update` 与假想的 `POST /mailShare/update` 在 premKey 侧无法区分 —— 但后者不在 `requirePermsExact` 里 → 不进权限分支 → 由 Hono 404 兜底。这不是漏洞(无路由),但意味着**method 写错会静默降级成「无权限门」**,而不是报错。红测必须逐条按真实 method 打。
- **admin 后门**:`:164` 的 `authInfo.user.email !== c.env.admin` 让管理员邮箱绕过一切 perm。`wrangler-vitest.toml:32` 的 `admin = "admin@example.com"`;`security-share.spec.js` 现有种子用 `t05-noperm@example.com` / `t05-hasperm@example.com`,安全。**T-17 新种子绝不能用 `admin@example.com`**,否则 8 条负向用例会假绿。
- **perm 无缓存**:`permService.userPermKeys:26-34` 每请求实查 DB(`user → role → role_perm → perm`,且 `perm.type = BUTTON`)。所以「移除 `share:manage`」既可以删 `role_perm` 行,也可以用现有的双角色种子(role 99 无权 / role 98 有权,`security-share.spec.js:63-80`)。**推荐沿用双角色**:无跨用例顺序耦合,也不污染其它 spec。
- **行号漂移**:tasks.md:391 写的是「`security.js:103` premKey」,实际 `premKey` 起于 `:78`、`share:manage` 那行是 **`:104`**。按符号名定位,别按行号。

---

## 2. Q2 · `excludeExact` 现状(T-17 不得改其豁免语义)

`security.js:23-30`,6 条,method + path 全等匹配(`matchesExact:187-189`),命中即 `next()`,**完全跳过 JWT 与 perm**:

| # | Method | Path | 来源 | T-17 立场 |
|---|---|---|---|---|
| 1 | GET | `/setting/websiteConfig` | 仓内既有 | 不碰 |
| 2 | POST | `/share/session` | T-05 | 不碰 |
| 3 | GET | `/share/mailboxes/status` | T-14 | 不碰 |
| 4 | GET | `/share/mails` | T-05 | 不碰 |
| 5 | GET | `/share/mail` | T-05 | 不碰 |
| 6 | GET | `/share/attachment` | T-05 | 不碰 |

配套的 `excludePrefixes:11-21`(9 条:`/login` `/register` `/oss` `/webhooks` `/init` `/public/genToken` `/telegram` `/test` `/oauth`)同样**一字不动**。

三条硬约束:

1. **`excludeExact` 与 `excludePrefixes` 都是零改动区**。tasks.md:25 把 security.js 的两处改动登记为「T-14(excludeExact 一行)、T-17(premKey)」—— T-14 的那一行(`:26`)已经落地并被 `security-share.spec.js:101-110` 的近似路径用例钉死,T-17 增删该数组任何一行都会打红 T-14 的基线。
2. **Owner 端点与豁免表零交集**:`/mailShare/*` 从不出现在两张豁免表里,所以 Owner 面**天然只能走 JWT 通道**;T-17 的活是在 JWT 之后补 perm 闸,不涉及豁免。
3. **前缀封闭性由「精确匹配」这个机制本身保证,不是由某条数据保证**:`matchesExact` 是全等,`matchesPrefix` 只作用于 `excludePrefixes`。所以 `/share-evil`、`/share/mailboxes/statusX` 都不豁免(AC-SEC-10)。T-17 只要不把任何 `/share*` 或 `/mailShare*` 挪进 `excludePrefixes`,这条基线自动保持。

> 唯一允许的写点:`requirePermsExact:72-76` 与 `premKey['share:manage']:104` 两处数组字面量。`requirePerms:32-70`(前缀权限表)也不要动 —— 往里加 `/mailShare` 会把 Owner 面从「精确」降级为「前缀」,直接破坏 AC-SEC-10 的封闭性。

---

## 3. Q3 · 红测(T-17.1)应扩的用例

现状盘点:`security-share.spec.js`(225 行)已有 5 个 `describe`:前缀封闭(`:84-111`)、Visitor 豁免(`:113-131`)、写端点仍需 JWT(`:133-147`)、Owner 3 条 perm(`:149-181`)、既有前缀路由回归(`:183-223`)。**正向只覆盖 `POST /mailShare/create` 一条**(`:174-180`)。

### 3.1 A 组 · 8 条枚举(AC-ADMIN-10)

改造 `owner routes require JWT and share:manage`(`:149-181`)为 `it.each` 表驱动,**同一张表跑三遍**:

```
const OWNER_ENDPOINTS = [
  ['POST',   '/mailShare/create'],
  ['GET',    '/mailShare/list'],
  ['GET',    '/mailShare/get'],
  ['PUT',    '/mailShare/update'],
  ['DELETE', '/mailShare/delete'],
  ['PUT',    '/mailShare/bindings'],
  ['DELETE', '/mailShare/revoke'],
  ['POST',   '/mailShare/resetAuthKey']   // ← 见 §5,T-16 落地后才放开
];
```

| 组 | 凭据 | 断言 | 覆盖 |
|---|---|---|---|
| A1 | 无 Authorization | `code === 401` | 8 条都仍被 JWT 兜住(扩 `:133-147` 现有 3 条) |
| A2 | `noShareJwt`(role 99,无 `share:manage`) | `code === 403` **且** `message === 'SHARE_FORBIDDEN'` | **AC-ADMIN-10 主证**;这是「去掉 `share:manage` → 8 条全 `SHARE_FORBIDDEN`」的字面兑现 |
| A3 | `hasShareJwt`(role 98,有 `share:manage`) | `code !== 403` **且** `code !== 401` | 反证不自锁(§1.2 的「有·无」象限);沿用 `:174-180` 的宽松断言,不要断言 200 —— 空 body/空 query 会走进 service 的参数错误 |

- A2/A3 **必须成对**,只写 A2 无法区分「正确拒绝」与「两张表都没配、端点根本不存在」。
- A3 对 `POST /mailShare/create` / `PUT /mailShare/update` / `PUT /mailShare/bindings` 需要发一个合法 JSON body(哪怕 `'{}'`),否则 `await c.req.json()` 抛的是非 BizError → 500,`code` 仍 `!== 403/401`,断言能过但语义模糊;建议统一带 `content-type: application/json` + `'{}'`。
- 建议补一条**覆盖率闭包**用例,防止 T-19 之后再加端点又漏登记:用仓内已有的 `?raw` 源码导入模式(`share-auth-service.spec.js:4` 先例)

  ```
  import mailShareApiSource from '../src/api/mail-share-api.js?raw';
  // 从源码正则抽出所有 app.<verb>('/mailShare/...')，
  // 断言其集合恰等于 OWNER_ENDPOINTS（双向包含，不是单向）
  ```

  这一条把「新增端点必须同步登记」变成机器可验,比 8 条硬编码更抗回归。

### 3.2 B 组 · Visitor / JWT 双向交叉(AC-SEC-02)

| 组 | 场景 | 现有代码给出的**真实**结果 | 断言写法 |
|---|---|---|---|
| B1 | **Visitor share token 打 Owner 端点** | share token 形如 `s1.<kid>.<payload>.<sig>`(4 段,`share-auth-service.js:229-233`)。`security.js:129` 交给 `jwtUtils.verifyToken:49-85`:`split('.')` 取前 3 段 → 用 `jwt_secret` 对 `s1.<kid>` 验签 → 必败 → `null` → `:132` 抛 `authExpired` **401** | **`code === 401`**,`message === 'Authentication has expired. Please sign in again'`(`i18n/en.js:57`,spec 已发 `accept-language: en`)。⛔ **不要断言 `SHARE_FORBIDDEN`** —— 那条分支在 `:166`,需要先过 JWT,share token 永远到不了 |
| B2 | **Owner JWT 打 Visitor 读端点**(`/share/mails` 等 4 条) | 命中 `excludeExact` → 中间件整体跳过 → handler 调 `resolveSession(c, readSessionToken(c))`(`share-api.js:67`、`:41-45`)→ `share-auth-service.js:236-243` 见 3 段 token → `parts.length !== 4` → `null` → `throwUnavailable` | HTTP 200 + body `{ code: 501, message: 'SHARE_UNAVAILABLE' }`(`BizError` 默认码 501,`biz-error.js:3`;`share-api.js:33-35` 的 `withShare` 转 `shareResult.fail`)。核心语义:**JWT 不构成 Visitor 凭据** |
| B3 | **Owner JWT 打 `/share/session`** | `share-api.js:55-63` 只读 body 的 `lid/sec`,**完全不读 Authorization** | 断言结果与不带 JWT 时**逐字节相同**(同一 body 打两次,一次带 `hasShareJwt` 一次不带,`toEqual`)。这比断某个错误码更能证明「JWT 在 Visitor 面无任何效力」 |
| B4 | **静态封闭:Visitor 面不导入登录态设施** | `share-api.js:1-14` 的 import 里没有 `jwt-utils` / `constant.TOKEN_HEADER` / `user-context` | `import shareApiSource from '../src/api/share-api.js?raw'`(`share-auth-service.spec.js:4` 已在用),断言 `not.toContain('jwt-utils')` / `not.toContain('userContext')` / `not.toContain('TOKEN_HEADER')`。AC-SEC-02「SHALL NOT 复用登录态 JWT / `share:manage` / `/public/*` token」的**结构证据** |
| B5 | **无 share token 的裸请求** | 已被 `:113-131` 的 `notRequireJwt` 覆盖(证明豁免生效),但没证明「豁免 ≠ 放行」 | 补一条:`GET /share/mails` 无任何凭据 → `code === 501` / `SHARE_UNAVAILABLE`,证明豁免只是把闸门从 JWT 换成 share token,不是开门 |

### 3.3 C 组 · Visitor 面零写端点(AC-SEC-04)

`:133-147` 的 `AC-VISIT-08` 已覆盖 6 条 Visitor 写法 + 3 条 Owner。T-17 扩:

- 对 4 条 Visitor **读**路径逐一枚举非 GET 动词(`POST`/`PUT`/`PATCH`/`DELETE`),断言全部 `code === 401`(不在 `excludeExact` → 落回 JWT 闸)。`/share/session` 只豁免 `POST`,其 `GET`/`PUT`/`DELETE`/`PATCH` 同样断 401。
- 静态侧(与 B4 同一份 `shareApiSource`):断言 `share-api.js` 源码中 `app.post(` 恰好出现 **1** 次且只属于 `/share/session`,`app.put(` / `app.delete(` / `app.patch(` **0** 次。Session 建立不是邮件写操作,这条把「Visitor 面只存在读端点」钉成可回归的结构断言。

### 3.4 D 组 · 前缀封闭(AC-SEC-10)

- **保持** `:84-111` 现有 9 条(`/share-evil`、`/shareanything`、`/share/mailbox`、`/share/mails/extra` + T-14 的 5 条近似)一字不改 —— 这是 T-14 的基线。
- **新增 Owner 侧封闭**(现在完全没有):对每条 Owner 路径造 3 个变体 —— 尾缀(`/mailShare/listX`)、下级(`/mailShare/list/extra`)、截断(`/mailShare/lis`),断言:
  - 无 JWT → `code === 401`(未被任何豁免命中);
  - 带 `noShareJwt` → **不是 200**(应为 404,无路由)。⚠️ 这里**不能**断言 `SHARE_FORBIDDEN`:近似路径不在 `requirePermsExact` 里 → `shareOwner=false` → 不进权限分支 → 直接 404。这条用例的价值恰恰是钉住「精确匹配不外溢」,顺带证明 T-17 没有把 `/mailShare` 塞进 `requirePerms` 前缀表。
- 再加一条**大小写/尾斜杠**变体(`/MAILSHARE/list`、`/mailShare/list/`),断言不被当作 `/mailShare/list` 放行。

### 3.5 红灯预期

在只改测试、不改 `security.js` 的状态下,预期红灯数:A2 新增 4 条(get/update/delete/bindings)+ A3 新增 4 条中的「不自锁」项其实会**绿**(它们现在无门,天然通过)—— 所以**红灯的唯一可靠来源是 A2**。写红测时要确认 A2 的 4 条确实红、A1/B/C/D 各组预期绿(它们是回归护栏,不是红灯)。resetAuthKey 那条在 T-16 落地前**两组都红**(404),见 §5。

---

## 4. Q4 · 推荐最小 diff 与不要做的事

### 4.1 最小 diff(`security.js` 仅两处,+5 行 / 改 1 行)

```diff
 const requirePermsExact = [
 	{ method: 'POST', path: '/mailShare/create' },
 	{ method: 'GET', path: '/mailShare/list' },
+	{ method: 'GET', path: '/mailShare/get' },
+	{ method: 'PUT', path: '/mailShare/update' },
+	{ method: 'DELETE', path: '/mailShare/delete' },
+	{ method: 'PUT', path: '/mailShare/bindings' },
+	{ method: 'POST', path: '/mailShare/resetAuthKey' },
 	{ method: 'DELETE', path: '/mailShare/revoke' }
 ];
```

```diff
-	'share:manage': ['/mailShare/create', '/mailShare/list', '/mailShare/revoke']
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

- 两张表**同序**(create/list/get/update/delete/bindings/revoke/resetAuthKey 或任一固定序),便于人工比对与后续 `?raw` 断言。
- 缩进用 **Tab**(全文件既有风格)。
- `resetAuthKey` 两行的去留取决于 §5 的闸门。

### 4.2 文件白名单

| 文件 | 允许改动 | 约束 |
|---|---|---|
| `mail-worker/src/security/security.js` | 仅 `requirePermsExact:72-76` 与 `premKey['share:manage']:104` 两处数组字面量 | 波次内唯一写者;中间件逻辑 `:107-185`、`matchesExact:187-189`、`permKeyToPaths:195-206` 一字不动 |
| `mail-worker/test/security-share.spec.js` | 追加/改造 §3 的用例 | `:84-111`(T-14 前缀基线)与 `:183-223`(既有前缀路由回归)**只读不改**;`:149-181` 可重写为 `it.each` 表驱动,但三条既有断言的语义必须逐条保留 |
| `docs/specs/mailbox-share-capability/tasks.md` | 勾选 T-17 / 追加 Evidence | 仅状态与证据行 |

### 4.3 明确不要做的事

| # | 禁止 | 理由 |
|---|---|---|
| N1 | **动 `excludeExact:23-30` 的任何一行**(增、删、改、重排) | T-14 的成果,`security-share.spec.js:101-110` 与 `:113-131` 双侧钉死;T-17 的 AC(ADMIN-10)与豁免语义零关系 |
| N2 | **动 `excludePrefixes:11-21`** | 同上;把 `/mailShare` 或 `/share` 挪进来会一次性摧毁 AC-SEC-10 与 AC-SEC-02 |
| N3 | **把 `/mailShare` 加进 `requirePerms:32-70` 前缀表** | 会让 Owner 面从精确降级为前缀,`/mailShare/listX` 之流被纳入权限判定并可能匹配成功,破坏封闭性;精确模式是 T-12 起的既定设计 |
| N4 | **改 `mail-worker/src/api/share-api.js` 的 Visitor 路由**(含新增/删除/改 method/改路径) | Visitor 面在 W1/T-14 已冻结;T-17 只做**断言**,不做**改造**。若枚举中发现真的存在写端点,应记为发现项交主 AI 裁决,不得自行删路由 |
| N5 | **提前写 T-16 的 `POST /mailShare/resetAuthKey` 端点或 service 方法** | `mail-share-service.js` 是 T-16 的单写者(tasks.md:26,W3 串行 T-15→T-16→T-18);T-17 越界写会造成同文件双写者冲突 |
| N6 | **改 `mail-vue/src/request/mail-share.js` / `router/index.js`** | 前端 8 端点函数与 `meta.perm` 归 T-20(tasks.md:405) |
| N7 | **改 `init.js` 的 perm 种子**(`:192-222`) | `share:manage`(perm_id 37,type=2 BUTTON,role 1 绑定)已就位,T-17 不需要新 perm_key;动它会影响 `v3-1-db.spec.js` / `share-status.spec.js` |
| N8 | **改 `permService.userPermKeys` 或加缓存** | 无缓存是当前红测能「换角色即换权限」的前提 |
| N9 | **把 401 的用例改写成 403 / `SHARE_FORBIDDEN`** | 见 §3.2 B1:JWT 层与 perm 层是两个闸,错误码不同是设计而非缺陷。强行统一会掩盖「share token 被当成 JWT 解析」这类真问题 |
| N10 | **在红测里给测试用户用 `admin@example.com`** | `security.js:164` 的 admin 后门会让全部负向用例假绿(`wrangler-vitest.toml:32`) |

---

## 5. Q5 · T-16 未合并时,T-17 必须等的符号

**闸门符号(必须同时满足两条):**

1. **路由字面量已落库**:`mail-worker/src/api/mail-share-api.js` 中出现
   `app.post('/mailShare/resetAuthKey', withShare(...))`
   (`recon-t16-authkey.md:106-108` 给出的建议形态,落点在 `revoke` 之后,即当前 `:60` 之后)。
2. **service 入口已存在**:`mail-worker/src/service/mail-share-service.js` 导出对象上有
   `resetAuthKey(c, params, userId)`
   (`recon-t16-authkey.md:100`、`:215`)。

**一行判据**(T-17 执行者起跑前跑一次即可):

```
rg -n "app.post\('/mailShare/resetAuthKey'" mail-worker/src/api/mail-share-api.js
rg -n "async resetAuthKey" mail-worker/src/service/mail-share-service.js
```

两条都命中 → 走完整 8 条;任一未命中 → 走下面的降级方案。

**侦察时刻的实测**:两条 `rg` **均未命中** —— `mail-share-api.js` 只有 7 条路由,`mail-share-service.js` 无 `resetAuthKey`。但工作树中 `mail-worker/test/mail-share-service.spec.js` 已出现 **+471 行未提交改动**,内容是 `describe('mailShareService.resetAuthKey state machine (T-16)')` 等一整套 T-16.1 红测(调用 `mailShareService.resetAuthKey(ctx(), { shareId, action }, USER_A)`)。即 **T-16 正处于 16.1 红、16.2 未绿的中途**。这意味着闸门很快会打开,P1(等)的等待窗口很短,进一步压低了 P2 的性价比。T-17 执行者起跑前请**重跑上面两条 `rg`** 取当时真值,不要复用本报告的快照。

### 5.1 若 T-16 尚未合并的两种走法

| 方案 | 做法 | 代价 | 建议 |
|---|---|---|---|
| **P1 · 等**(推荐) | T-17 排在 T-16 之后起跑 | W3 内 T-17 失去与 T-15/T-16 并行的机会;但 T-17 体量极小(两处数组 + 一个 spec 文件),串行成本可忽略 | ✅ 首选。`recon-t16-authkey.md:297` 已给同款结论:「T-17.2 的 8 条清单需要 `/mailShare/resetAuthKey` 这个**路径名**已定」 |
| **P2 · 7+1** | T-17 先落 7 条(两张表都只加 4 条:get/update/delete/bindings),红测 8 条枚举里 resetAuthKey 那行用 `it.todo` 或 `describe.skip` 占位并写明「解锁条件 = §5 的两个符号」;T-16 落地时由 **T-16 执行者**补第 8 条(两张表 + 解锁 skip) | 把 security.js 的写者从 1 个变成 2 个,违反 tasks.md:25「同波次内禁止第二写者」;且 T-16 侦察 §7 的自检清单里写的是「`security.js` 一字未动」 | ⚠️ 仅在主 AI 显式裁决允许双写者时采用,并需同步改 T-16 的自检清单 |

**绝对不要的第三种**:在 T-17 里把 `/mailShare/resetAuthKey` 写进两张表但路由不存在。后果:该登记指向空路由,`hasShareJwt` 正向用例拿 404、`noShareJwt` 负向用例反而拿到 **403 `SHARE_FORBIDDEN`**(权限闸在路由解析之前触发)—— **负向用例会假绿**,给出「已保护」的错觉,直到 T-16 落地都无人发现。这是本次侦察风险最高的一条。

> 主 AI 若要抢并行,最轻的解法是**先冻结路径名**(仅在 tasks.md/design 上确认 `POST /mailShare/resetAuthKey`,已在 tasks.md:382 写死),然后仍按 P1 让 T-17 等 T-16 的两个符号 —— 路径名冻结解决的是「T-17 要写什么」,解决不了「写了之后测不出真值」。

---

## 6. 风险与陷阱

| # | 风险 | 说明与处置 |
|---|---|---|
| **R1** | **只改一张表** | §1.2 真值表。`requirePermsExact` 单加 → 全员自锁(只有 admin 能用),而 `security-share.spec.js:174-180` 现有的正向用例只覆盖 create,**发现不了** get/update/delete/bindings 的自锁。A3 组正向枚举是唯一护栏,必须写 |
| **R2** | **红测断言写死 `SHARE_FORBIDDEN` 打 B1** | share token 走不到 perm 分支,只会拿 401(§3.2)。这条错误在写 spec 时非常容易犯,因为任务书 T-17.1 的措辞是「share token 访问 Owner 端点 → 拒」,「拒」的具体形态是 401 不是 403 |
| **R3** | **resetAuthKey 提前登记 → 负向用例假绿** | §5 第三种走法。权限中间件在 Hono 路由匹配**之前**运行(`app.use('*')`),所以对不存在的路径也会照常抛 `SHARE_FORBIDDEN`。这意味着「A2 组全绿」**不能**证明端点存在 —— A3 正向组(要求 `code !== 401 && !== 403`,实际会拿 404 的 `code`)才是存在性证据。⚠️ Hono 的 404 走的不是 `onError`,`body.json` 可能为 `null`,A3 断言 `body.json?.code !== 403` 在 `json === null` 时**恒真** → 假绿。若采用 P2,A3 必须额外断言 `body.status === 200`(业务错误也走 200 + JSON body),才能真正区分「路由不存在」 |
| **R4** | **method 写错静默降级** | `premKey` 无 method 维度(§1.3),写错 method 的效果是「该端点无权限门」而非报错。逐条按 `mail-share-api.js` 的真实 verb 核对:create=POST、list=GET、get=GET、update=**PUT**、delete=**DELETE**、bindings=**PUT**、revoke=**DELETE**、resetAuthKey=POST |
| **R5** | **admin 后门污染用例** | `security.js:164`;`wrangler-vitest.toml:32` `admin = "admin@example.com"`。新种子邮箱须避开。反过来,建议**主动补一条**用例把该后门钉成显式契约:admin 邮箱 + role 99(无 `share:manage`)打 `/mailShare/list` → 不是 403。否则将来有人「修掉」这个 else 分支不会有任何测试变红 |
| **R6** | **改 `:149-181` 时丢掉既有断言语义** | 现有三条负向 + 一条正向的 `message === 'SHARE_FORBIDDEN'` 字面断言是 T-05 的成果;改成 `it.each` 时容易只留 `code === 403`。**403 与 `SHARE_FORBIDDEN` 必须同时断**,因为 `:168` 的另一条分支也是 403(消息为 `Unauthorized`),只断码分不出走的是哪条 |
| **R7** | **`GET /mailShare/get` 与 `DELETE /mailShare/delete` 的空参行为** | A3 正向组会真正进 service。`get`/`delete` 读 `c.req.query()`,缺 `shareId` → `SHARE_NOT_FOUND` 一类 BizError → HTTP 200 + `code !== 403/401`,断言可过。但**不要**顺手断言具体错误码,那属 T-15 的 spec 领域,在 security spec 里断会造成跨文件耦合 |
| **R8** | **`PUT /mailShare/bindings` / `update` / `create` 缺 body 抛非 BizError** | `await c.req.json()` 对空 body 抛 `SyntaxError` → `onError` 走 `result.fail(err.message, undefined)`。`result.fail` 的默认码需确认;稳妥做法是 A3 一律发 `content-type: application/json` + `'{}'`,避免依赖异常路径的码值 |
| **R9** | **`?raw` 源码断言的脆性** | B4/C 组与覆盖率闭包用例依赖源码文本。正则要宽松到能容忍格式化(如 `app.post(\s*'/mailShare/`),否则一次 prettier 就全红。仓内先例 `share-auth-service.spec.js:1526-1531` 用的是整串 `toContain`,较脆;T-17 建议用正则 + 集合比较而非整串 |
| **R10** | **前端已按 8 条端点在走** | `mail-vue` 侧 `hasPerm('share:manage')`(`ShareIndicator.vue:26`)只控按钮可见性,不构成服务端保护。T-17 落地后,持 `share:manage` 的角色行为不变;**不持有的角色会从「能调 4 条」变成「一条都不能调」** —— 这是预期修复,但应在 exec note 里显式登记为行为变更,供 T-20/T-21 的前端错误态设计参照 |
| **R11** | **`security-share.spec.js` 的 `beforeAll` 是全局种子** | `:58-81` 插入 perm 37 / role 98 / role 99 / role_perm / 两个 user。T-17 若新增第三个角色(如 admin 用例),沿用 `INSERT OR IGNORE` + 固定 id,别用自增,避免与 `mail-share-service.spec.js` 的种子撞 id |
| **R12** | **T-19 会重跑全量** | T-17 落地后 `pnpm --dir mail-worker test` 必须整体绿。特别注意 `mail-share-service.spec.js` 里 T-13/T-15 加的 HTTP 用例:`exec-t15-note.md:107` 说 `ownerJwt()` 已给测试用户挂上 role 98 + `share:manage`,所以 get/update/delete/bindings 收编后**不会**打红它们 —— 但这个结论**必须实跑验证**,它是 T-17 最大的跨文件回归面 |

---

## 7. 执行前自检清单(给 T-17 执行者)

- [ ] 起跑前跑 §5 的两条 `rg`,确认 `resetAuthKey` 符号在场;不在场则按 P1 等待或取得主 AI 对 P2 的显式裁决
- [ ] `requirePermsExact` 与 `premKey['share:manage']` **同一 commit** 各加同样 5 条(或 P2 下的 4 条),两表同序
- [ ] 8 条(或 7 条)的 method 逐条对照 `mail-share-api.js` 真实 verb(R4)
- [ ] `excludeExact` / `excludePrefixes` / `requirePerms` 三张表 `git diff` 为空
- [ ] A2 负向 8 条:`code === 403` **且** `message === 'SHARE_FORBIDDEN'`
- [ ] A3 正向 8 条:`code !== 403 && code !== 401`,且(若走 P2)加断 `status === 200` 防 404 假绿(R3)
- [ ] B1 share token 打 Owner:断 **401 / authExpired**,未误写成 `SHARE_FORBIDDEN`
- [ ] B2/B3 Owner JWT 打 Visitor:`SHARE_UNAVAILABLE`,且 `/share/session` 带不带 JWT 结果逐字节相同
- [ ] B4/C 静态断言:`share-api.js` 源码无 `jwt-utils`/`userContext`/`TOKEN_HEADER`,`app.post(` 仅 1 次、`app.put(`/`app.delete(`/`app.patch(` 0 次
- [ ] D 组 Owner 近似路径:无 JWT → 401,带 `noShareJwt` → 非 200(且**未**断成 `SHARE_FORBIDDEN`)
- [ ] `:84-111` 与 `:183-223` 两段既有 describe `git diff` 为空
- [ ] 新种子邮箱不等于 `admin@example.com`(R5)
- [ ] `mail-vue/**`、`mail-share-service.js`、`mail-share-api.js`、`share-api.js`、`init.js` 全部 `git diff` 为空
- [ ] 定点绿:`pnpm --dir mail-worker exec vitest run test/security-share.spec.js`
- [ ] 全量绿:`pnpm --dir mail-worker test`,重点确认 `mail-share-service.spec.js` 的 T-13/T-15 HTTP 用例未被收编打红(R12)
- [ ] exec note 登记:①「4 条端点从裸 JWT 收编为 `share:manage`」是行为变更;②(若 P2)第 8 条的遗留与解锁条件

---

## 8. 参考锚点索引

```
契约   docs/specs/mailbox-share-capability/tasks.md:25(security.js 热区)、:388-392(T-17)、:382-386(T-16)、:469-470(W3 并行说明)
       docs/specs/mailbox-share-capability/requirements.md:164(AC-ADMIN-10)、:173(AC-SEC-02)、:175(AC-SEC-04)、:181(AC-SEC-10)
安全   mail-worker/src/security/security.js:11-21(excludePrefixes)、:23-30(excludeExact · 零改动)
       :32-70(requirePerms 前缀表 · 零改动)、:72-76(requirePermsExact · T-17 写点 1)
       :78-105(premKey,share:manage 在 :104 · T-17 写点 2)
       :107-185(中间件)、:146-171(判定链)、:164(admin 后门)、:187-189(matchesExact)、:195-206(permKeyToPaths)
路由   mail-worker/src/api/mail-share-api.js:23/30/35/40/46/51/57(7 条 Owner 端点,resetAuthKey 缺席)
       mail-worker/src/api/share-api.js:1-14(import 无 JWT 设施)、:41-45(readSessionToken)、:55/65/79/85/95(5 条 Visitor 路由)
鉴权   mail-worker/src/utils/jwt-utils.js:49-85(verifyToken,3 段)
       mail-worker/src/service/share-auth-service.js:204-233(issueToken,4 段 s1)、:236-274(verifyToken)、:576-601(resolveSession)
       mail-worker/src/service/perm-service.js:26-34(userPermKeys · 无缓存)
错误   mail-worker/src/error/biz-error.js:1-7(默认码 501)· mail-worker/src/hono/hono.js:9-29(onError)
       mail-worker/src/model/share-result.js · mail-worker/src/i18n/en.js:57-58
种子   mail-worker/src/init/init.js:192-222(perm 37 share:manage + role 1 绑定)
配置   mail-worker/wrangler-vitest.toml:32(admin = admin@example.com)
用例   mail-worker/test/security-share.spec.js:36-81(种子)、:84-111(前缀基线 · 不改)
       :113-131(Visitor 豁免)、:133-147(写端点仍需 JWT)、:149-181(Owner perm · 待扩)、:183-223(前缀路由回归 · 不改)
       mail-worker/test/share-auth-service.spec.js:4 / :1526-1531(?raw 源码断言先例)
前锋   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t13-note.md:85 / :91(bindings 缺口)
       .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t15-note.md:107 / :113(L1 · 8 条清单)
       .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-t16-authkey.md:188-194(§2.8 两处都要加)、:297(并行前置)
       .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-t15-owner-api.md:188(T1 · 同款结论)
```
