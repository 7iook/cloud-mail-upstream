# exec-t08-note · AuthKey 第二因子 + `credentials_version` + ShareContext 集合化 + session 响应扩展

| 字段 | 值 |
|---|---|
| 任务 | T-08(T-08.1 红 + T-08.2 绿) |
| 分支 | `cursor/mailbox-share-capability-dcb6` |
| 起点 HEAD | `a0f23eb`(含 T-07 `c2087ce`) |
| commit | `5a81065`（围栏 4→3 同 commit；Evidence `695394f`） |
| 白名单外改动 | 围栏 `mail-share.schema.spec.js` 4→3 已随 `5a81065` 收口（R-T08-1 **closed**）。其余白名单外零改动 |

---

## 1. 红 → 绿

红绿都在 `/workspace` 原地跑,只跑 T-08 触碰的三个 spec。`/workspace` 里同时有另一执行者
未提交的 T-12 改动(`mail-share-service.js` / `mail-share-service.spec.js`),本次未 stash、
未触碰;`share-api.spec.js` 在当前工作树下 8/8 全绿,T-07 note §5 记录的 create 污染已不复现。

### 红

`src/` 三个生产文件 `git checkout` 回 HEAD,`test/` 保留 T-08 新用例:

```
$ pnpm --dir mail-worker exec vitest run \
    test/share-auth-service.spec.js test/share-api.spec.js test/share-attachment-service.spec.js --no-cache
 Test Files  3 failed (3)
      Tests  17 failed | 62 passed (79)
EXIT=1
```

完整日志:`/opt/cursor/artifacts/t08_red.log`。17 条红点 = 15 条 service + 1 条 HTTP + 1 条 attachment。

红期**空过**(功能不存在时天然成立、绿后才有约束力)的护栏用例共 7 条,刻意保留:

- `accepts the right AuthKey, trims surrounding whitespace and still meters one slot`
- `ignores a supplied AuthKey while the factor is off`
- `keeps every pre-AuthKey visitor failure byte-identical ...`(P-AUTH-01,本就是不变式)
- `serves an already-issued keyed session after max_sessions is reached`
- `still refuses a keyed session when the quota UPDATE throws and still signs when the KV write fails`
- `leaves HTTP 429 to the transport layer ...`(源码围栏)
- `does not bind the token to the caller IP`(AC-SESS-08,本就是不变式)

### 绿

```
$ pnpm --dir mail-worker exec vitest run \
    test/share-auth-service.spec.js test/share-api.spec.js test/share-attachment-service.spec.js --no-cache
 Test Files  3 passed (3)
      Tests  79 passed (79)
EXIT=0
```

完整日志:`/opt/cursor/artifacts/t08_green.log`。

单文件基线守恒:

| spec | 前 | 后 |
|---|---|---|
| `share-auth-service.spec.js` | 34 | **56**(+22) |
| `share-api.spec.js` | 7 | **8**(+1) |
| `share-attachment-service.spec.js` | 14 | **15**(+1) |

零删除、零改写既有断言。

### 全量（历史 · 围栏未收口、T-12 未入库）

```
$ pnpm --dir mail-worker exec vitest run --no-cache
 Test Files  1 failed | 16 passed (17)
      Tests  1 failed | 288 passed (289)
EXIT=1
```

完整日志:`/opt/cursor/artifacts/t08_full_suite.log`。当时唯一红点是白名单外的
`test/mail-share.schema.spec.js` 主表 `account_id` 读取围栏（R-T08-1）。

### 最终快照（权威 · `5a81065` + T-12 `b6f5a28`）

主 AI 在干净树独立复跑（T-12 已入库，围栏已 4→3）：

| 套件 | 命令 | 结果 |
|---|---|---|
| T-08 三 spec | `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-api.spec.js test/share-attachment-service.spec.js --no-cache` | **79/79 EXIT=0**（auth 56 · api 8 · att 15） |
| 定点四文件（含 T-12） | 上列 + `test/mail-share-service.spec.js` | **185/185 EXIT=0** |
| 全量 worker | `pnpm --dir mail-worker test --no-cache` | **17/289 EXIT=0** |
| vue | `pnpm --dir mail-vue test` | **17/95 EXIT=0** |
| E2E | `node tests/e2e/run.mjs` | **13 EXIT=0** |

日志:`/opt/cursor/artifacts/t08_t12_full_worker.log`。T-08 scoped 成功态 = 后端 AC-AUTH-* / AC-SESS-09；访客 UI 归 T-26，不在本任务完成判决内。

---

## 2. 改了什么(file:lines)

### 生产代码

| 文件 | 行 | 内容 |
|---|---|---|
| `mail-worker/src/service/share-auth-service.js` | `:1-9` | 新增 `asc` / `inArray` 与 `mailShareBinding` 导入 |
| 同上 | `:18` | `SHARE_AUTH_REQUIRED` 常量 |
| 同上 | `:22-25` | `MIN_REFRESH_INTERVAL_MS = 3000`(投递侧下限,写侧拒绝归 T-12) |
| 同上 | `:39-41` | `throwAuthRequired()` |
| 同上 | `:182-197` | `matchAuthKey(c, authKey, row)`:复用 `pepperRing` / `selectKeyedSecret` / `digestShareSecret` / `timingSafeEqualString`;`auth_key_kid` 未配置 → fail-closed 但仍跑一次 HMAC;`auth_key_hash` 为 NULL 恒 false |
| 同上 | `:199-202` | `readAuthKey(options)`,`trim()` |
| 同上 | `:220-229` | `issueToken` payload 加 `cv`(`s1` 版本号不变) |
| 同上 | `:298-342` | `loadLiveBindings(c, row)`:按 `binding_id ASC` 取 Binding,再按 `account.is_del=NORMAL` 过滤;**零 Binding 行 → 回落 `loadLiveAccount(c, row.accountId)` 并合成 `bindingId: 0` 的影子 Binding**;全死 → `SHARE_UNAVAILABLE` |
| 同上 | `:344-346` | `toBoolean` |
| 同上 | `:348-369` | `buildShareContext`:**T-08 冻结形状** `{shareId, bindings[], messageLimit, otpExtractionEnabled, showFullAddress, expiresAt}` + 废弃 shim `accountId` / `windowStartEmailId`(取 `bindings[0]`)+ 本波保留的 `effectiveStatus`;整对象与 `bindings` 数组、每个 binding 均 `Object.freeze` |
| 同上 | `:371-382` | `maskAddress`(Decision 14 展示偏好,本文件私有;`shareMailService.maskAddress` 归 T-11,**未新增**) |
| 同上 | `:384-390` | `clampRefreshInterval`,`≥ 3000` |
| 同上 | `:392-413` | `buildSessionPayload`:`sessionToken` + 废弃 `mailbox`(不掩码)+ `shareType` + `mailboxes[{bindingId,address}]` + `expiresAt` + `config{autoRefresh, refreshIntervalMs, otpExtractionEnabled, messageLimit}`;布尔字段统一 0/1 → boolean |
| 同上 | `:500-519` | establish 顺序 ①③④:`matchSec` → `loadLiveBindings` → **AuthKey** → KV replay。`auth_key_enabled=0` 时忽略来件 authKey;失败打 `share.session.denied_auth` / `reason=auth_key_mismatch` 后 `SHARE_AUTH_REQUIRED` |
| 同上 | `:557` | 成功响应改由 `buildSessionPayload` 组装(整个对象进 T-07 重放缓存) |
| 同上 | `:577-586` | `resolveSession` cv 回源比对,`payload.cv ?? 0` vs `row.credentials_version`,不一致打 `share.session.denied_cv` 后 `SHARE_UNAVAILABLE` |
| 同上 | `:587-590` | `assertAllowed(RESOLVE_ALLOWED)` → `loadLiveBindings` → `buildShareContext`。零写入 |
| `mail-worker/src/api/share-api.js` | `:57-60` | `{ idempotencyKey, authKey: body.authKey }`。service 不读 `c.req` |
| `mail-worker/src/service/share-attachment-service.js` | `:104-114` | `DOWNLOAD_ALLOWED_STATUS = ['ACTIVE','ACCESS_LIMIT_REACHED']`,只放宽这一处守卫;REVOKED / EXPIRED 仍拒。仍继续消费 `effectiveStatus`(T-05 既有断言不动) |

`mail-share-service.js`(含 `SHARE_EVENT` / `logShareEvent`)、`init.js`、`security.js`、
`wrangler.toml`、`kv-const.js`、`mail-vue/**` 零改动。未开 `SHARE_CAPABILITY_V2`,未新增
`resetAuthKey`,未建任何失败计数表。无新增生产测试缝。

### 测试

| 文件 | 行 | 内容 |
|---|---|---|
| `mail-worker/test/share-auth-service.spec.js` | `:1-6` | 新增 `share-api.js?raw` / `shareAttachmentService` 导入 |
| 同上 | `:56-57` | `AUTH_REQUIRED_BODY` / `AUTH_KEY` |
| 同上 | `:217-218` | `shareFetch` 支持自定义 header(AC-SESS-08 换 IP 用) |
| 同上 | `:255-336` | `insertShare` 改成「可选列表驱动」(新增 auth_key_* / message_limit / otp / auto_refresh / refresh_interval_ms / show_full_address),`insertBinding`、`authKeyShare`,cleanup 连带清 `mail_share_binding` |
| 同上 | `:1193-1236` | `base64url` / `mintToken`(手工签一个无 `cv` 的旧 token)、`authEvents` / `cvEvents` / `bumpCredentialsVersion`(P-AUTH-02 直连 SQL,W1 没有 resetAuthKey) |
| 同上 | `:1238-1504` | `describe('shareAuthService AuthKey second factor')` 9 条 |
| 同上 | `:1506-1607` | `describe('shareAuthService credentials_version')` 4 条 |
| 同上 | `:1609-1800` | `describe('shareAuthService ShareContext and session response')` 9 条 |
| `mail-worker/test/share-api.spec.js` | `:12-27` | `AUTH_REQUIRED` 信封 + 本地 `hmacHex` |
| 同上 | `:363-411` | 一条 HTTP 用例:创建后直接 SQL 种 `auth_key_*`,无 Key / 错 Key → `SHARE_AUTH_REQUIRED` 零配额;错 sec + 对 Key → `SHARE_UNAVAILABLE`;对 Key → 200 且响应含 shareType / mailboxes(掩码)/ expiresAt / config |
| `mail-worker/test/share-attachment-service.spec.js` | `:144-158` | `ACCESS_LIMIT_REACHED` 上下文仍可下载(T05-attach 回归) |

T-08.1 逐项对照:

| T-08.1 要求 | 落点 |
|---|---|
| 无 Key / 错 Key → `SHARE_AUTH_REQUIRED`、零 token、零配额 | `refuses a missing or wrong AuthKey ...`(7 种形状,信封 byte-identical) |
| 无锁定副作用 | 同上,`SELECT name FROM sqlite_master` 断言无 `mail_share_auth_fail` |
| P-AUTH-01 property | `keeps every pre-AuthKey visitor failure byte-identical ...`,fast-check 40 runs |
| P-AUTH-02 + cv 严格单调 | `stamps cv on the token and kills the old one ...`(cv 0→1→2,旧 token 双双打死,新 Key 消耗新配额) |
| 旧 token 无 cv 按 0 | `resolves a pre-T-08 token with no cv as version 0` |
| 换 IP 头仍 200 | `does not bind the token to the caller IP` |
| 429 独立运输层、零配额 | `leaves HTTP 429 to the transport layer ...`(源码围栏;429 响应体本身由 `share-rate-limit.spec.js` 既有 2 条覆盖) |
| session 响应四件 | `answers a single-binding establish ...` / `answers a two-binding establish ...` / `shows full addresses ... clamps refresh_interval_ms` / `replays the whole extended response ...` |
| KV 写失败仍签发 + 配额 UPDATE 失败拒发 | `still refuses a keyed session when the quota UPDATE throws and still signs when the KV write fails` |
| AuthKey 在 KV 之前 | `checks the AuthKey before the idempotency replay cache ...`(断言 `kv.gets.length` 不变) |
| AC-LEAK-05 | `logs share.session.denied_auth without the key, the sec, the lid or the token` + `logs share.session.denied_cv ...` |
| denied_auth / denied_cv 事件 | 同上两条 |
| attachment 放行 ACCESS_LIMIT_REACHED | `lets an ACCESS_LIMIT_REACHED context still download an attachment` + attachment spec 单测 |

---

## 3. 与既有裁决的对齐

- **W1-sig**:`establishSession(c, lid, sec, options)`,AuthKey 走 `options.authKey`;
  `share-api.js` 读 `body.authKey`。service 不读 `c.req`。
- **W1-ctx**:ShareContext 形状按字面冻结,`bindings` 按 `bindingId ASC`;
  `accountId` / `windowStartEmailId` 作为**废弃 shim** 从 `bindings[0]` 派生(注释里写死 T-11 摘除)。
  `share-scoped-email-repository.js:25-26` 仍读这两个标量,本波零改动。
- **T12-R5**:AuthKey 与 sec 同一套 pepper(`SHARE_SEC_PEPPER` / `_KID` + PREV),同一个
  `digestShareSecret`,同一个常量时间比较。
- **T07-R1**:④ 插在 `loadLiveBindings` 之后、KV 之前;快照配额 / `assertAllowed` 仍在 KV 之后。
- **AC-SESS-11 / W1-quota**:配额 UPDATE 抛错仍拒发,零消耗。
- **P-AUTH-02**:测试用直连 `UPDATE mail_share SET credentials_version = credentials_version + 1`,
  不假装有 `resetAuthKey`。
- **T05-attach**:按推荐方案 —— 继续返回 `effectiveStatus`,只把 attachment 守卫从
  `!== 'ACTIVE'` 放宽为白名单 `['ACTIVE','ACCESS_LIMIT_REACHED']`,不扩大 attachment 范围。
- **T12-R1**:只在**投递侧** clamp `config.refreshIntervalMs ≥ 3000`;写侧拒绝仍归 T-12。

---

## 4. 一处需要主 AI 确认的边界(不是偏离,是把口径写明)

**过期/撤销 + 错 Key → `SHARE_AUTH_REQUIRED`,不是 `SHARE_UNAVAILABLE`。**

按题面钉死的 ①③④ 顺序,`assertAllowed` / 配额判定都在 KV 之后,所以「lid+sec 正确、
但分享已过期/已撤销」的访客带错 Key 时,先撞上 ④ 拿到 `SHARE_AUTH_REQUIRED`。

判定:**符合** AC-AUTH-02 ——「仅在 lid+sec 校验通过后才暴露 `SHARE_AUTH_REQUIRED`」,
这个访客确实通过了 lid+sec。P-AUTH-01 守的是「从没拿到过有效 lid+sec 的人不能分辨 AuthKey 是否存在」,
本实现完全满足。

写红时我一度把「过期 + 任意 Key」也塞进 P-AUTH-01 的 property,结果 property 报红 ——
这是**测试口径过严**,不是实现漏洞。已改成:property 只覆盖 `lid` 不存在 / `sec` 错(题面原话),
并在同一条用例末尾单独断言「过期 / 撤销 + **对的** Key → `SHARE_UNAVAILABLE`」。
若主 AI 认为过期/撤销必须压过 AuthKey,那要把 ④ 挪到 `assertAllowed` 之后 —— 但那会破坏
T07-R1(④ 必须在 KV 之前)与 AC-SESS-10(`max_sessions=1` 重放),所以我按现顺序落地。

---

## 5. 遗留风险

### R-T08-1 · [closed · `5a81065`] 主表 `account_id` 读取围栏 4→3

`test/mail-share.schema.spec.js:142-147`:

```js
it('freezes share-auth-service.js at its four pre-existing row.accountId reads', () => {
    // 这 4 处（assertShareActive / establishSession / resolveSession ×2）是 T-08 集合化之前
    // 的存量读取，冻结为允许清单：不得出现第 5 处。
    expect(countPrimaryAccountReads(shareAuthSource)).toBe(4);
});
```

T-08 集合化后,`share-auth-service.js` 里的主表 `account_id` 读取从 4 处**降到 3 处**:

- `:284` `assertAllowed` 的 `row.accountId > 0`
- `:311` `loadLiveBindings` 零 Binding 回落的 `loadLiveAccount(c, row.accountId)`
- `:314` 同一回落分支合成影子 Binding 的 `accountId: row.accountId`

`establishSession` / `resolveSession` 各自那处直读已被 `loadLiveBindings` 吸收 —— 这正是
AC-BIND-01「鉴权/范围代码只信 Binding」想要的方向,围栏注释本身也写明「冻结**至 T-08**」。
但断言是 `toBe(4)` 等值,少读也算破,于是全量套件红这一条。

`mail-share.schema.spec.js` **不在本任务白名单内**(白名单是「only these」),
所以我没有改它。需要的改动就一行 + 注释:

```diff
-	it('freezes share-auth-service.js at its four pre-existing row.accountId reads', () => {
-		// 这 4 处（assertShareActive / establishSession / resolveSession ×2）是 T-08 集合化之前
-		// 的存量读取，冻结为允许清单：不得出现第 5 处。
-		expect(countPrimaryAccountReads(shareAuthSource)).toBe(4);
+	it('freezes share-auth-service.js at its three post-T-08 row.accountId reads', () => {
+		// T-08 集合化后只剩 3 处，且全部落在「零 Binding 行回落到主表」这一条兼容分支
+		// （assertAllowed 的 >0 断言 + loadLiveBindings 的影子 Binding）。棘轮只许降不许升。
+		expect(countPrimaryAccountReads(shareAuthSource)).toBe(3);
```

`5a81065` 已按上列 diff 落地；棘轮现为 `toBe(3)`。全量 17/289 绿。

### R-T08-2 · [P1] `mail_share_binding` 与主表 `account_id` 双写不一致时以 Binding 为准

有 Binding 行时,`loadLiveBindings` 完全不看 `mail_share.account_id`;`assertAllowed` 仍要求
它 `> 0`(AC-LIFE-10 的旧 Worker 保护)。如果 Expand 期双写漏了、主表留了个指向已删账户的
`account_id`,而 Binding 指向活账户,本实现会**放行**并按 Binding 服务。这符合 AC-BIND-01
「Binding 是唯一真源」,但与 T-05/T-06 那批「主表 account 死 → 不可用」的用例语义不同,
差异只在「同时存在 Binding 行」时才显现。孤儿/不一致行的清理归 T-18。

### R-T08-3 · [P2] 影子 Binding 的 `bindingId: 0`

零 Binding 行时合成的影子 Binding 用 `bindingId: 0`。W2 若把 `bindingId` 当成
`mail_share_binding` 主键去回查,0 查不到任何行。当前 `mailboxes[].bindingId` / ShareContext
`bindings[].bindingId` 只用于前端 Tab 标识与本地水位比较(D16),不做回查,所以安全。
T-03 回填跑完后线上不应再有零 Binding 行,这条只服务于兼容期与 W1 既有 share-only 种子。
若 T-11/T-14 需要 `bindingId` 可回查,得先把回填做完再删这个回落分支。

### R-T08-4 · [P2] `config` 与 ShareContext 的布尔归一化口径

题面允许 `config` 保持 0/1。本实现选了**两侧统一 boolean**:
ShareContext 的 `otpExtractionEnabled` / `showFullAddress`,`config` 的 `autoRefresh` /
`otpExtractionEnabled` 都是 `true`/`false`;`messageLimit` 为 `null` 或数字。
用例已钉死(`expect(...).toBe(false)` / `toEqual({autoRefresh: false, ...})`)。
前端 T-26 接线时按 boolean 读,不要写 `=== 1`。

### R-T08-5 · [P2] `maskAddress` 在本文件里复制了一份

Decision 14 的掩码规则(local-part 留首字符 + `***`,domain 原样,幂等)现在有两个未来实现点:
`share-auth-service.js:375` 的私有版本,和 T-11 要建的 `shareMailService.maskAddress`。
题面明确禁止本任务动 `share-mail-service.js`,所以先复制。T-11 落地后应把这里改成调用它,
或反过来把这一份提到共享工具里 —— 两份规则漂移就是 P-MASK-01 的破口。

### R-T08-6 · [P3] AuthKey 做了 `trim()`

`readAuthKey` 对来件 Key `trim()` 后比较(题面要求)。AuthKey 是服务端 CSPRNG 生成的
base64url,不含空白,所以只影响「用户复制时带了空格/换行」这一类体验问题,不放宽凭据空间。
但这意味着服务端**永远无法**签发一个首尾带空白的 Key —— T-16 生成器保持 base64url 即可。

### R-T08-7 · [P3] 前端未接线

`shareType` / `mailboxes` / `config` 下发了,但访客页仍只读 `mailbox`。多邮箱 Tab、
AuthKey 输入框、`config.refreshIntervalMs` 消费均归 **T-26**,不是漏登记。

---

## 6. 并发状态（历史 · 执行期）

执行当时 `/workspace` 另有未提交 T-12 改动；T-08 未 stash、未触碰。T-12 现已入库 `b6f5a28`。
`share-api.spec.js` 在 T-08 工作树下 8/8 绿(T-07 note §5 记的 create 污染已不复现)。

执行当时 `git diff --stat` 中属于 T-08 的只有:

```
mail-worker/src/api/share-api.js                   |   5 +-
mail-worker/src/service/share-attachment-service.js|   6 +-
mail-worker/src/service/share-auth-service.js      | 208 +++++-
mail-worker/test/share-api.spec.js                 |  63 ++
mail-worker/test/share-attachment-service.spec.js  |  15 +
mail-worker/test/share-auth-service.spec.js        | 713 ++++++++++++++++++++-
```

---

## Update Log

- 2026-08-24 · 主 AI:C1/I1/M1 入库 `bc2b4e2`。独立复跑 auth+api+att+schema 90/90、全量 worker 17/317、vue 17/95、E2E 13，均为 EXIT=0。
- 2026-08-24 · executor:落地 T-08 代码审查三条 CHANGE(review-t08.md 过筛表),**未提交**。
  改动文件:`share-auth-service.js`(生产)、`share-auth-service.spec.js`(+2 用例)、
  `mail-share.schema.spec.js`(仅注释)、`design.md`(Session 幂等节 KV 契约 bullet 补一句交叉语义)。
  - **T08-C1**:`consumeSessionQuota(c, shareId, expectedCv, now, expectedAuthKeyEnabled)`,
    WHERE 增补 `eq(mailShare.authKeyEnabled, expectedAuthKeyEnabled)`(整数 0/1,列 NOT NULL DEFAULT 0);
    调用点传 `row.authKeyEnabled` 快照。落空仍走既有 `denyQuota(..., 'quota_race')` → `SHARE_UNAVAILABLE`。
    enable 仍不 bump cv。
  - **T08-I1**:`readReplayCache(c, lid, key, row)`(原 `shareId` 形参并入 `row`),KV 命中后
    `verifyToken` 并要求 `(payload.cv ?? 0) === row.credentialsVersion`,stale-cv / 校验失败按 miss;
    随后的成功签发用同 key `put` 覆盖旧值。未绑定 `authKeyEnabled`,同 Key 重放不受影响。
  - **T08-M1**:围栏注释改为点名 `:284 assertAllowed` 与 `loadLiveBindings` 回落两处,棘轮保持 `toBe(3)`。
  - 红(仅测试先落盘,生产代码未改):
    `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-api.spec.js test/share-attachment-service.spec.js --no-cache`
    → **3 files / 2 failed | 79 passed (81) · EXIT=1**。两条红点即新增用例
    `refuses when the Owner enables the AuthKey between the snapshot and the gate` 与
    `treats a replay cache entry from an older cv as a miss and re-enters on the new key`。
    日志:`/opt/cursor/artifacts/t08_change_red.log`。
  - 绿(同命令):**3 files / 81 passed (81) · EXIT=0**,日志 `/opt/cursor/artifacts/t08_change_green.log`。
  - 围栏:`pnpm --dir mail-worker exec vitest run test/mail-share.schema.spec.js --no-cache`
    → **1 file / 9 passed (9) · EXIT=0**,日志 `/opt/cursor/artifacts/t08_change_fence.log`。
  - 全量:`pnpm --dir mail-worker test --no-cache` → **17 files / 317 passed (317) · EXIT=0**,
    日志 `/opt/cursor/artifacts/t08_change_full_worker.log`。**口径**:该次全量跑在同一工作树上,
    树内同时存在另一执行者未提交的 T-12 CHANGE 改动(`mail-share-service.js` /
    `mail-share-service.spec.js`,本次零触碰),因此 317 不是 T-08 单独的基线数。
- 2026-08-24 · 主 AI:工件审查 `exec-t08-note.review1.sub.md` NEEDS_CHANGES。A1 CHANGE（统一最终快照 vs 历史 288/289）；A2 HOLD（scoped 成功态=后端 AC-AUTH-*，访客 UI 属 T-26，同 T07-A1）；A3 HOLD（W1-ctx：T-10/T-11 才消费 ShareContext，禁止 T-08 假接线）；A4 HOLD（新 key 触顶拒发已由 T-06 AC-SESS-01/11 覆盖）。
- 2026-08-24 · 主 AI:入库 `5a81065`（含围栏 4→3，R-T08-1 已收口）。独立复跑三 spec 79/79 + 全量 17/289 EXIT=0。vue 17/95 EXIT=0。
- 2026-08-24 · executor:T-08 落盘未提交。三 spec 红 17/79 → 绿 79/79 EXIT=0。全量 288/289,
  唯一红点为白名单外围栏 `mail-share.schema.spec.js:146`(4 → 3),见 R-T08-1,T-09 前必须收口。
