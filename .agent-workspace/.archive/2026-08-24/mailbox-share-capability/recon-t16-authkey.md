# Recon · T-16 AuthKey 状态机(`POST /mailShare/resetAuthKey`,enable / reset / disable 单入口)

| 字段 | 值 |
|---|---|
| 范围 Scope | T-16 / T-16.1 / T-16.2,`docs/specs/mailbox-share-capability/tasks.md:382-386` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`,HEAD `4124999`(含 T-15 `1d49bb4`) |
| 侦察日期 | 2026-08-24 |
| 依据 AC | AC-AUTH-07、AC-AUTH-08、AC-ADMIN-05、AC-LIFE-11(另牵 AC-CAP-05、AC-AUTH-04、AC-EDGE-05、AC-LEAK-05、AC-SEC-09) |
| 性质 | 只读侦察。**未改任何文件、未提交**;本文件是唯一产物 |

---

## 0. 一句话结论

T-16 是三个任务里**代码量最小、语义陷阱最密**的一个:密钥生成、摘要、pepper/kid、cv 语义、Session 侧的 cv 与 `auth_key_enabled` 双谓词**全部现成**,真正要新写的只有「一条带迁移守卫的条件 UPDATE + 一个 22 字符明文只回一次的响应」;而四个坑决定成败 ——

① **`action='reset'` 落在 `auth_key_enabled=0` 的行上就是一次没过栅栏的 enable**:AC-LIFE-11 只门控 enable,若不把「当前必须已启用」钉进迁移守卫,`reset` 就是绕过 `AUTH_KEY_ENABLE` 栅栏的后门(与 T-15 侦察里 `update` 绕过 `MESSAGE_LIMIT` 同型);
② **迁移守卫必须同时写进 WHERE**,不能只在预读时判 —— 否则并发两条命令能拼出 `enabled=1 / hash=NULL` 的非法组合,而 DDL 侧**没有任何 CHECK 兜底**(`init.js:48-51` 是纯 ALTER ADD COLUMN);
③ **明文的三条泄漏面已经有现成围栏,但没有一条覆盖 resetAuthKey**:`OWNER_ROW_COLUMNS:368-377` 不 SELECT 凭据列、`logShareEvent:85-95` 禁传凭据、`SHARE_EVENT:39-46` 是**封闭清单**(`mail-share-service.spec.js:1331-1341` 用 `toEqual` 钉死)—— T-16 顺手加一个 `share.authkey.reset` 事件名就会打红既有用例;
④ **HTTP 侧的 Worker env 是 `SHARE_CAPABILITY_V2="false"`**(`wrangler-vitest.toml:41`),`SELF.fetch` 跑 enable 一定被拒;HTTP 面用例只能走 reset/disable,或临时改 `env` 并在 `finally` 还原(先例:`share-integration.spec.js:261-267`)。

---

## 1. 已有 vs T-16 必须新增

### 1.1 已存在(可直接站上去,一行都不用改)

| 能力 | 位置 | 现状 |
|---|---|---|
| Key 生成 | `mail-share-service.js:97-101` `randomToken(byteLength)` | `crypto.getRandomValues` → `btoa` → 去 `=`、`+→-`、`/→_`。`randomToken(16)` = 128-bit → base64url **恰 22 字符**(AC-CAP-05 已被 `mail-share-service.spec.js:959-961` 钉死) |
| 摘要设施 | `share-auth-service.js:113-116` `digestShareSecret(sec, pepper)` | HMAC-SHA256 → 64 位十六进制。`sec` 与 AuthKey **共用同一函数、同一 pepper、同一 kid**(create `:1041` 与 `:1055` 并排调用) |
| pepper / kid | `c.env.SHARE_SEC_PEPPER` + `c.env.SHARE_SEC_PEPPER_KID \|\| 'v1'`(`:1009-1013`、`:1035`) | 缺 pepper 时 create 记 `console.error` 后抛**非 BizError**(`:1010-1013`)—— 这是既有口径,resetAuthKey 的 enable/reset 应照抄 |
| 校验侧 | `share-auth-service.js:185-197` `matchAuthKey` | 按**行上的 `auth_key_kid`** 从 pepper ring 选 key,常量时间比较,kid 不在环里 fail-closed;`readAuthKey:199-202` 规范化**仅 trim**(AC-CAP-05) |
| cv 载具 | `issueToken:219-228` payload 带 `cv`;`resolveSession:591-597` 每请求回源比对,不等即 `SHARE_UNAVAILABLE` + `share.session.denied_cv` | 「reset/disable 让旧 Session 立即失效」**已经全线就位**,T-16 只需要把 `credentials_version` 加一 |
| enable 的并发保护 | `consumeSessionQuota:430-442` 的 `eq(mailShare.authKeyEnabled, expectedAuthKeyEnabled)` 谓词 | 专为「enable 不 bump cv」而存在(`:426-429` 注释):快照读到 `enabled=0` 的在飞 establish,在 enable 提交后 UPDATE 失配 → 拒发。**T-16 不需要为此写任何代码** |
| KV 重放缓存 | `readReplayCache:463-476` | 缓存 token 的 `cv` ≠ 当前行 cv 即按 miss;enable 不 bump 故仍 hit(AC-AUTH-07 / AC-SESS-10 交叉语义) |
| V2 栅栏 | `assertCapabilityV2:76-81` + `SHARE_V2_INTENT.AUTH_KEY_ENABLE:33` | intent 常量**已经为 T-16 预留**(`:75` 注释点名 T-16);create 侧接线在 `:357-359` |
| Owner 投影 | `OWNER_ROW_COLUMNS:368-377` / `loadOwnerDetail:513-525` | 凭据列与 `credentials_version` **一律不进 SELECT**(`:368-369` 注释:「取不到就漏不掉」);`authKeyEnabled` 布尔已在 `projectOwnerRow:450` 回传 |
| 白名单封堵 | `UPDATE_FIELDS:873-882` + `:868-872` 注释 | T-15 已把 `auth_key_*` / `credentials_version` 挡在 update 之外,`mail-share-service.spec.js:2298-2340` 有逐列不变断言。**T-16 不需要、也不许动这张表** |

### 1.2 T-16 必须新增(只有三处)

| 项 | 契约出处 | 要点 |
|---|---|---|
| `mailShareService.resetAuthKey(c, params, userId)` | design.md:307、:311-329 · AC-ADMIN-05 / AC-AUTH-07 / AC-AUTH-08 | 单入口三迁移;一条带迁移守卫的条件 UPDATE;enable 不 bump cv,reset/disable bump |
| `POST /mailShare/resetAuthKey` | design.md:307 · design.md:665 | `mail-share-api.js` 第 6 个 Owner 端点,沿用 `withShare` + `shareJson`(`no-store`)+ `userContext.getUserId(c)`;POST 读 `await c.req.json()` |
| T-16.1 红灯用例 | tasks.md:383 | 全落 `mail-worker/test/mail-share-service.spec.js`,追加新 `describe`,既有 2740 行只加不改 |

### 1.3 三条既有断言会直接约束 T-16 的形状

- `mail-share-service.spec.js:1331-1341` —— `SHARE_EVENT` 用 `toEqual` 钉成 6 条封闭清单。**T-16 不得新增事件名**;若确实要记 AuthKey 迁移日志,只能复用现有 6 条(实际上一条都不合适),或走 spec 变更 —— 建议 T-16 **不记事件**,理由见 §6-T9。
- `mail-share-service.spec.js:1266-1271` —— 生产 `wrangler.toml` 不得出现未注释的 `SHARE_CAPABILITY_V2` 行。**T-16 不许碰 wrangler**。
- `mail-share-service.spec.js:2298-2340` —— update 后 `auth_key_enabled / auth_key_hash / auth_key_kid / credentials_version` 逐列不变。T-16 若为了省事把 AuthKey 塞进 `UPDATE_FIELDS`,这条用例立刻红。

---

## 2. 逐条回答侦察问题(全部以当前代码为准)

### 2.1 现有 create 如何生成 AuthKey

`mail-share-service.js:1031-1056`:

```js
const authKey = body.authKeyEnabled ? randomToken(16) : '';        // :1034
const pepperKid = c.env.SHARE_SEC_PEPPER_KID || 'v1';              // :1035
authKeyEnabled: body.authKeyEnabled,                               // :1054
authKeyHash: authKey ? await shareAuthService.digestShareSecret(authKey, pepper) : null,  // :1055
authKeyKid: authKey ? pepperKid : null,                            // :1056
```

- **长度 / 编码**:`randomToken(16)` = 16 字节 CSPRNG → base64url → **恰 22 字符**(`:97-101`)。
- **pepper / kid**:与 `sec` **同源** —— `SHARE_SEC_PEPPER` + `SHARE_SEC_PEPPER_KID`(缺省 `'v1'`);`auth_key_kid` 在 create 时恒等于 `pepper_kid`(spec `:989` 钉死)。
- **cv 是否 bump**:`prepareShareInsert:595-652` 的列清单**根本不含 `credentials_version`** → 走 DDL 默认 `0`(`init.js:51`)。**create 不 bump,新行恒 cv=0**,与 `issueToken` 对无 cv 旧 token 按 0 处理的口径一致(`share-auth-service.js:225-227`)。
- **明文回几次**:恰一次。`firstCreateResponse:527-543` 只在 `authKey` 非空时挂 `response.authKey`;幂等重放路径(`:1067-1069`)返回的是 `replayOrConflict` 的载荷,**无 `sec` 也无 `authKey`**(spec `:969-976`、`:1122-1126` 已钉)。落库只有 hash + kid,`Object.values(row)` 不含明文(spec `:967`)。

### 2.2 Session 侧如何校验、enable 为何不失效旧 Session、reset 必须 bump 哪一列

**建立(`establishSession:498-574`)**:`matchSec` 通过 → `loadLiveBindings` → **`if (toBoolean(row.authKeyEnabled))` 才要求 Key**(`:520-531`),失败记 `share.session.denied_auth` 并抛 `SHARE_AUTH_REQUIRED`(唯一可区分错误码,且只有持有效 `sec` 者能看到);顺序刻意放在重放查询**之上**(`:518-519` 注释:无 Key 的人不能拿走别人付过费的 token)。

**enable 不失效旧 Session,有两个独立原因**:
1. `resolveSession:576-601` 的校验链是 `verifyToken → lid 匹配 → payload.cv === row.credentials_version → effectiveStatus → binding 存活`,**全程不读 `auth_key_enabled`**。已签发的 token 只要 cv 没变就继续可读 —— 这正是 AC-AUTH-07「建立时本无 Key 要求,不追溯失效」的落点。
2. enable 不改 `credentials_version`,所以第 3 步恒通过。

**代价与既有补偿**:enable 会让「快照读到 `enabled=0`、UPDATE 却发生在 enable 之后」的在飞 establish 变成一条无 Key 的越权入口 —— 这个洞已经被 `consumeSessionQuota:439` 的 `eq(mailShare.authKeyEnabled, expectedAuthKeyEnabled)` 谓词堵上(`:426-429` 注释明写「因为 enable 故意不 bump cv」)。**T-16 因此不需要为 enable 引入任何 cv 变化来求稳**。

**reset 必须 bump 的列**:`mail_share.credentials_version`(唯一一列)。bump 后旧 token 在 `resolveSession:591` 失配即死(AC-AUTH-04 / AC-EDGE-05),KV 缓存的 stale-cv 条目在 `readReplayCache:468` 按 miss 处理。`disable` 同样 bump(AC-AUTH-08)。

### 2.3 落点、方法/路径、入参、出参

**落点**:`mail-worker/src/service/mail-share-service.js` 的服务对象内(建议紧跟 `delete`,即 `:1208` 之后、`list` 之前,与 Owner 写入口聚在一起);路由落 `mail-worker/src/api/mail-share-api.js`(建议紧跟 `revoke`,`:60` 之后)。

**HTTP**:`POST /mailShare/resetAuthKey`,JSON body(create 是唯一另一个 POST,同样读 `await c.req.json()`;`get`/`delete`/`revoke` 走 query 是因为它们是 GET/DELETE)。

**推荐签名**:

```js
// mail-share-service.js
const AUTH_KEY_ACTIONS = new Set(['enable', 'reset', 'disable']);

async resetAuthKey(c, params, userId) -> {
  ...loadOwnerDetail 的详情形状,          // 与 update 的返回口径一致,前端 AuthKey 区直接刷新
  authKey?: string                        // 仅 enable / reset,22 字符,恰一次
}

// mail-share-api.js
app.post('/mailShare/resetAuthKey', withShare(async (c) => {
  const body = await c.req.json();
  const data = await mailShareService.resetAuthKey(c, body, userContext.getUserId(c));
  return shareJson(c, shareResult.ok(data));
}));
```

**入参**:`{ shareId, action: 'enable' | 'reset' | 'disable' }`。`action` 严格枚举、**区分大小写、不做 trim 之外的归一**(与 `FLAG_TOKENS:140-143` 的「显式白名单、不合法即抛」同构);非法 / 缺失 → `SHARE_INVALID_CONFIG`。`shareId` 走现成的 `toShareId:124-127`(布尔显式挡掉,非法折 0 → `SHARE_NOT_FOUND`)。

**出参**:
- `enable` / `reset` → 详情 + `authKey`(明文,恰一次);
- `disable` → 详情,**无 `authKey` 键**(不是空串,是不存在 —— `firstCreateResponse:538-540` 的同款条件挂载)。
- **不回 `credentials_version`**:`OWNER_ROW_COLUMNS:368-369` 的既定口径是 cv 不进 Owner 投影;测试验 cv 走 `readShareRow` 直查(spec 已有该 helper `:130-132`)。这一条属可裁决项,若决定回传须在 exec note 登记。

**推荐的写入语句形状**(一条 UPDATE 同时完成迁移 + 守卫 + 计数):

```sql
UPDATE mail_share
SET auth_key_enabled = ?,                                  -- 1 / 1 / 0
    auth_key_hash    = ?,                                  -- hash / hash / NULL
    auth_key_kid     = ?,                                  -- kid  / kid  / NULL
    credentials_version = credentials_version + ?          -- 0 / 1 / 1
WHERE share_id = ? AND user_id = ?
  AND status = 'ACTIVE' AND expires_at > ?
  AND auth_key_enabled = ?                                 -- ← 迁移守卫:enable→0,reset/disable→1
RETURNING share_id
```

`changes = 0` → `SHARE_NOT_FOUND`(与 `update:1173-1175`、`revoke:1253-1255` 同码,不新增可区分错误码,存在性探针保持封闭)。

### 2.4 不变量 `auth_key_enabled=1` IFF hash 与 kid 均非空 —— 钉在哪

design.md:327 的原文是「schema/service spec **双侧断言**」。当前代码的事实是:

- **DDL 侧没有、也不该有 CHECK**:`init.js:48-51` 是 `ALTER TABLE … ADD COLUMN`,SQLite 无法对既有表追加表级 CHECK;而 `init.js` 是 T-01 的地盘,T-16 不许碰。**「schema 侧」只能靠断言表达,不是靠约束表达。**
- **schema 侧的现有钉子**:`mail-share.schema.spec.js:54-57`(列名映射)、`:82-83`(`authKeyEnabled` / `credentialsVersion` 默认 0)、`:111-114`(`authKeyHash` / `authKeyKid` 可空,`authKeyEnabled` / `credentialsVersion` 非空)。这三条已经把「合法组合的形状」钉住,**T-16 无需修改该文件**。
- **T-16 要补的是数据侧不变量**,写在 `mail-share-service.spec.js` 里,用一条与实现无关的 SQL 全表扫:

```sql
SELECT COUNT(*) AS bad FROM mail_share
WHERE (auth_key_enabled = 1) <> (auth_key_hash IS NOT NULL AND auth_key_kid IS NOT NULL)
```

  在三条迁移**各自之后**都断言 `bad = 0`(这就是「schema 侧」的可执行形式)。
- **service 侧**:三列恒在**同一条 UPDATE 的同一个 SET**里赋值(§2.3 的语句),物理上不存在中间态;再加一条用例断言 `resetAuthKey` **不产生任何只改其中一列的语句**(可用现成的 `sqlProbe():150-166` 抓 SQL 文本)。

### 2.5 V2 栅栏:哪些 action 要门控

**只有 `enable`。** 两处权威原文一致,不是推测:

- design.md:307 —— 「`action='enable'` 需 `SHARE_CAPABILITY_V2=true`,否则 `SHARE_INVALID_CONFIG`(AC-LIFE-11)」;
- requirements.md:200 AC-LIFE-11 ③ —— 「启用 AuthKey(create `authKeyEnabled=true` **或 resetAuthKey `action='enable'`**)」;
- design.md:220 的四条受限写入清单同款措辞;tasks.md:383 也只写「enable 需 V2=true」。

**reset / disable 明确不门控**,而且**不能**门控:
- `disable` 是**朝旧语义收敛**的迁移,旧 Worker 完全执行得了;AC-LIFE-10 路径③(已开 V2 后异常回滚)要求 Owner 在开关 false 时仍能关掉 AuthKey,门控它等于把 Owner 锁死在一个自己关不掉的第二因子上。
- `reset` 在**已启用**的行上只是换 hash —— 那行的 AuthKey 本来就是 V2=true 期间写下的,AC-LIFE-11 末句「已按 V2 写入的策略 SHALL NOT 因开关回退被静默改写」正是这个语义。
- ⚠️ **但这条豁免完全依赖 §2.3 的迁移守卫**:一旦允许 `reset` 落在 `auth_key_enabled=0` 的行上,它就是一次绕过 `AUTH_KEY_ENABLE` 栅栏的 enable。**守卫是栅栏的一部分,不是可选的健壮性装饰。**

顺序契约(照抄 `assertCreateBody:307-365` 与 `assertUpdatePatch:895-909` 的注释):**`action` 值域 → 归属/迁移合法性 → V2 栅栏**。永久领域错误必须排在暂时发布态之前 —— 二者共用 `SHARE_INVALID_CONFIG` 这一个码,语义只能靠语句顺序保住,用例也要按这个顺序钉。

### 2.6 可复用符号清单

| 符号 | 位置 | 复用姿势 / 陷阱 |
|---|---|---|
| `shareAuthService.digestShareSecret` | `share-auth-service.js:113-116`(经 `default` 导出 `:604`) | **函数体内解引用**,两模块互相 import,模块求值期解引用会踩 TDZ(`mail-share-service.js:1036-1038` 注释) |
| `randomToken(16)` | `mail-share-service.js:97-101` | 模块内私有函数,直接调;**不要新写第二个随机源** |
| `c.env.SHARE_SEC_PEPPER` / `SHARE_SEC_PEPPER_KID` | create `:1009-1013`、`:1035` | 缺 pepper 时照抄 create:`console.error` + 抛普通 `Error`(不是 BizError)。**disable 不需要 pepper,不要为它加无谓的前置检查** |
| `SHARE_V2_INTENT.AUTH_KEY_ENABLE` | `:33` | `assertCapabilityV2(c, SHARE_V2_INTENT.AUTH_KEY_ENABLE)`,**只在 enable 分支调** |
| `assertCapabilityV2` | `:76-81` | 判定与 intent 无关,不过即抛 `SHARE_INVALID_CONFIG` |
| `logShareEvent` / `SHARE_EVENT` | `:85-95` / `:39-46` | 事件名封闭(spec `:1331-1341`);调用方**禁止传 sec / authKey / token / IP / 邮箱**(`:84` 注释) |
| `loadMutableShare` | `:958-967` | ACTIVE + 未过期 + 本人;`update` 的同款前置。SELECT 列**不含 `auth_key_enabled`** —— resetAuthKey 需要现值来判迁移合法性,见 §6-T2 |
| `loadOwnerDetail` | `:513-525` | 返回口径与 `update:1177` 一致;凭据列天然不在 `OWNER_ROW_COLUMNS` 里 |
| `toShareId` / `isRowId` | `:124-127` / `:118-120` | 布尔显式挡掉,非法折 0 |
| `hasKey` / `hasValue` | `:129-135` | 判「键在场」而非真值 |
| `nowText()` | `:48-50` | `YYYY-MM-DD HH:mm:ss`,与 `expires_at` 同格式,给条件 UPDATE 的 `expires_at > ?` 用 |
| 测试侧 | `ctx()/v2ctx():44-51`、`PEPPER:20`、`decodeBase64Url:69-75`、`readShareRow:130-132`、`seedShareRow`(`setup.js:75-116`,已支持 `authKeyEnabled/authKeyHash/authKeyKid/credentialsVersion`)、`ownerJwt():1506`、`ownerApi():2092-2103`、`sqlProbe():150-166`、`catchBiz():57-67` | 造种子无需扩工厂;HTTP 用例的授权链已由 T-15 补齐 |

### 2.7 红测清单(§4 展开)

见 §4。文件恒为 `mail-worker/test/mail-share-service.spec.js`(tasks.md:383 指定)。

### 2.8 与 T-15 / T-17 的接口

- **T-15 已交付的地基**:`UPDATE_FIELDS:873-882` 与 `OWNER_ROW_COLUMNS:368-377` 已把 AuthKey 四列挡在 update 与 Owner 投影之外,`spec:2298-2340` 有逐列不变断言。**T-16 的活是新开一条唯一写入口,不是在 update 上开口子。**
- **T-16 不动 `security.js`**(tasks.md:25 明列该文件为 T-14/T-17 两点,同波次禁止第二写者)。
- **T-17 需要追加的那一条路径:`/mailShare/resetAuthKey`**,且是**两处**:
  1. `security.js:104` `premKey['share:manage']` 3 → 8 条:`/mailShare/create`、`/mailShare/list`、`/mailShare/revoke`、`/mailShare/get`、`/mailShare/update`、`/mailShare/bindings`、`/mailShare/delete`、**`/mailShare/resetAuthKey`**;
  2. `security.js:72-76` `requirePermsExact` 现只有 3 条(create/list/revoke),缺 `{ method: 'PUT', path: '/mailShare/bindings' }`(T-13)、`GET /mailShare/get`、`PUT /mailShare/update`、`DELETE /mailShare/delete`(T-15)与 **`{ method: 'POST', path: '/mailShare/resetAuthKey' }`(T-16)** 共 5 条。
- **T-16 的执行者义务**:在 exec note 里把「新增 1 条端点待 T-17 收编」登记进 `exec-t15-note.md` L1 的同一张清单(那里已预留「最后一条待 T-16 落地」),把缺口从 4 条更新为 5 条。

### 2.9 风险与不要做的事

见 §6。

---

## 3. 推荐落点与函数签名(可直接照抄的骨架)

```js
// mail-share-service.js —— 建议紧跟 delete(:1208)之后
// design.md:311-329 的状态机表就是这张表:源态 → 目标列值 → cv 增量 → 是否过 V2 栅栏。
// 迁移守卫(fromEnabled)必须同时进 WHERE:预读只决定错误码,WHERE 才决定并发下的正确性。
const AUTH_KEY_TRANSITIONS = {
  enable:  { fromEnabled: 0, toEnabled: 1, mintsKey: true,  cvBump: 0, gated: true  },
  reset:   { fromEnabled: 1, toEnabled: 1, mintsKey: true,  cvBump: 1, gated: false },
  disable: { fromEnabled: 1, toEnabled: 0, mintsKey: false, cvBump: 1, gated: false }
};

async resetAuthKey(c, params, userId) {
  const shareId = toShareId(params && params.shareId);
  const action = params == null || params.action == null ? '' : String(params.action);
  const move = Object.prototype.hasOwnProperty.call(AUTH_KEY_TRANSITIONS, action)
    ? AUTH_KEY_TRANSITIONS[action] : null;
  if (!move) throw new BizError('SHARE_INVALID_CONFIG');       // ① 值域(永久领域错误)
  const row = await loadMutableShareWithAuthKey(c, shareId, userId);  // ② 归属 + ACTIVE(见 §6-T2)
  if (row.auth_key_enabled !== move.fromEnabled) throw new BizError('SHARE_INVALID_CONFIG'); // ③ 迁移合法性
  if (move.gated) assertCapabilityV2(c, SHARE_V2_INTENT.AUTH_KEY_ENABLE);                    // ④ 栅栏最后
  // …mintsKey 时取 pepper(缺失即 Error,同 create:1010-1013)、randomToken(16)、digestShareSecret
  // …一条带 fromEnabled 守卫的条件 UPDATE(§2.3),changes=0 → SHARE_NOT_FOUND
  const detail = await loadOwnerDetail(c, shareId, userId);
  return authKey ? { ...detail, authKey } : detail;
}
```

顺序 ①→④ 就是 §2.5 的顺序契约,与 `assertCreateBody` / `assertUpdatePatch` 同构。

---

## 4. 红测清单(T-16.1,全部落 `mail-worker/test/mail-share-service.spec.js`)

### 4.1 三条迁移的正路(AC-AUTH-07 / AC-AUTH-08 / AC-ADMIN-05)

- [ ] **enable**:`v2ctx()` + 已 seed 的 `authKeyEnabled: 0` 行 → 返回 `authKey` 为 22 字符、`decodeBase64Url(...).length === 16`、字符集 `/^[A-Za-z0-9_-]{22}$/`;行上 `auth_key_enabled=1`、`auth_key_hash === await shareAuthService.digestShareSecret(authKey, PEPPER)`、`auth_key_kid === 'v2'`(= `ctx()` 的 `SHARE_SEC_PEPPER_KID`);**`credentials_version` 与操作前逐值相等**。
- [ ] **reset**:seed `authKeyEnabled: 1, authKeyHash: <旧>, authKeyKid: 'v9', credentialsVersion: 3` → 新明文、hash **≠** 旧 hash、kid 改写为当前 kid、`credentials_version === 4`。
- [ ] **disable**:同上种子 → 响应**无 `authKey` 键**(`'authKey' in result === false`)、`auth_key_enabled=0`、`auth_key_hash == null`、`auth_key_kid == null`、`credentials_version === 4`。
- [ ] 连续两次 enable→reset 的明文互不相同(CSPRNG 而非派生)。

### 4.2 不变量(AC-AUTH-07 · R2-F1)

- [ ] 三条迁移各自之后跑 §2.4 的全表 SQL,`bad === 0`。
- [ ] 直接 seed 非法组合(`enabled=1 / hash=NULL / kid=NULL`)→ 对其 `disable` 后回到合法态(异常恢复按同一断言,design.md:327 末句)。
- [ ] `sqlProbe()` 抓到的 resetAuthKey SQL 中,**没有任何一条只写 `auth_key_*` 三列中的一部分**。

### 4.3 失败场景(至少这五类,逐条给出错误码与「零副作用」断言)

| # | 场景 | 期望 |
|---|---|---|
| F1 | **错 action**:`'rotate'` / `'ENABLE'` / `''` / 缺失 / `null` / `true` / `2` / `{}` / `'enable '`(尾空格) | `SHARE_INVALID_CONFIG`;四列 + cv 逐列不变 |
| F2 | **他人 shareId / 不存在 / 畸形 id**:`USER_B` 的行、`88881111`、`0`、`-1`、`'abc'`、`null`、`true` | 一律 `SHARE_NOT_FOUND`(存在性探针封闭,与 `get` 的 `:2172-2180` 同款循环) |
| F3 | **已撤销 / 已过期行**(`seedFourStates():2055-2067` 现成) | `SHARE_NOT_FOUND`;行零变更 |
| F4 | **V2=false 下 enable** | `SHARE_INVALID_CONFIG`;`auth_key_enabled` 仍 0、hash/kid 仍 NULL、**cv 不变**。同一上下文下 **reset 与 disable 在已启用行上放行**(证明没有误加门控,对应 §2.5) |
| F5 | **明文二次读取**:enable 之后 → 再 `get()` / `list()` / 再调一次 `resetAuthKey` 的返回、`JSON.stringify` 全不含该明文;`Object.values(readShareRow())` 不含明文;`console.log/error` 捕获不含明文(照抄 `:1005-1024` 的 AC-LEAK-05 模式) |

### 4.4 非法迁移(F1 之外单列,这是本任务的核心红线)

- [ ] **`reset` 落在 `auth_key_enabled=0` 的行** → `SHARE_INVALID_CONFIG`,且**在 V2=false 与 V2=true 下都拒**;行上 hash/kid 仍 NULL。**这条用例就是「reset 不得成为绕过 AUTH_KEY_ENABLE 栅栏的后门」的取证。**
- [ ] `enable` 落在已启用行 → `SHARE_INVALID_CONFIG`(否则就是一次不 bump cv 的换钥匙,直接破 AC-AUTH-07 的 reset 语义)。
- [ ] `disable` 落在已禁用行 → `SHARE_INVALID_CONFIG`,尤其断言 **cv 未被无谓 bump**(白白杀掉在飞 Session)。

### 4.5 与 Visitor 面的真实闭环(不能只查库)

复用 `:2342-2372` 的 `workerCtx` + `SELF.fetch('/api/share/session')` 模式(pepper 必须取 `env.SHARE_SEC_PEPPER`,否则 HTTP 侧验不过):

- [ ] **enable 不失效已建 Session**(AC-AUTH-07):建 Session 拿 token → `resetAuthKey(enable)` → 用**旧 token** 读 `/share/mails` 仍 200。
- [ ] **enable 后新建 Session 需要 Key**:无 `authKey` → `SHARE_AUTH_REQUIRED`;带新明文 → 200(证明 hash/kid 与 `matchAuthKey:185-197` 同源)。
- [ ] **reset 立即失效旧 Session**(AC-EDGE-05):旧 token 下一请求 `SHARE_UNAVAILABLE`;旧 Key 建 Session → `SHARE_AUTH_REQUIRED`;新 Key → 200 且**消耗新配额**。
- [ ] **disable 后旧 Key 与旧 Session 双失效**:旧 token → `SHARE_UNAVAILABLE`;`{lid, sec}` 无 Key → 200(不再要求 Key);带旧 Key → 同样 200(多余字段被忽略,不得因此报错)。
- [ ] **未登录访客走不了这条**:不带 JWT `POST /api/mailShare/resetAuthKey` → 401/`SHARE_FORBIDDEN` 一类的拒绝(注意 §6-T7:`share:manage` 精确匹配归 T-17,T-16 这条用例只验 JWT 兜底,断言别写死成 `SHARE_FORBIDDEN`)。

### 4.6 HTTP 面

- [ ] `ownerApi('POST', '/mailShare/resetAuthKey', { jwt, body: { shareId, action: 'reset' } })` → 200 + `data.authKey` 22 字符 + `Cache-Control: no-store`;`disable` → 无 `authKey`。
- [ ] ⚠️ **enable 的 HTTP 用例需要临时开栅栏**:Worker env 是 `wrangler-vitest.toml:41` 的 `"false"`,`SELF.fetch` 读不到 `v2ctx()`。做法是在用例内 `env.SHARE_CAPABILITY_V2 = 'true'`、`finally` 里还原(先例 `share-integration.spec.js:261-267`、`share-rate-limit.spec.js:44-47`)。**不要改 `wrangler-vitest.toml`** —— 那会把全仓基线从「栅栏关闭态」翻过去。

---

## 5. 并行切分

**T-16 不可拆并行,整块单执行者串行完成。** 与 T-15 同因:`mail-share-service.js` 是波次内单写者热区(tasks.md:26,`T-15→T-16→T-18` 串行),红灯用例又全落 `mail-share-service.spec.js` 一个文件(2740 行,顶部 helper 区共享)。

内部推进次序(同一执行者内的顺序,不是并行槽):

```
① AUTH_KEY_TRANSITIONS 表 + action 值域 + 迁移守卫(纯函数,先把状态机钉死)
② 条件 UPDATE(含 fromEnabled 守卫)+ changes=0 → SHARE_NOT_FOUND
③ enable/reset 的取 pepper → randomToken → digest → 明文一次性返回
④ mail-share-api.js 端点 + HTTP 用例(注意 §4.6 的 env 临时开关)
⑤ Visitor 闭环用例(enable 不失效 / reset·disable 立即失效)
```

**可与 T-16 真正并行的只有 T-17**(独占 `security.js` + `security-share.spec.js`,零文件交集)—— 但 T-17.2 的 8 条清单需要 `/mailShare/resetAuthKey` 这个**路径名**已定,建议 T-16 先把路由名落库(或由主 AI 先行冻结路径名)再让 T-17 起跑。

---

## 6. 风险与陷阱

| # | 风险 | 说明与处置 |
|---|---|---|
| **T1** | 🔴 **`reset` = 未过栅栏的 enable** | AC-LIFE-11 只门控 enable。若 `reset` 能落在 `auth_key_enabled=0` 的行上,V2=false 时 Owner 只要发一次 `action='reset'` 就启用了 AuthKey —— 随机路由到旧 Worker 的请求会绕过第二因子(design.md:230 路径④正是要消解这个)。处置:迁移守卫 `fromEnabled=1` **同时进预读判定与 WHERE**。§4.4 第一条是它的取证 |
| **T2** | **`loadMutableShare` 的 SELECT 列不够** | `:958-967` 只取 `share_id, lid, only_messages_after_created`,**没有 `auth_key_enabled`**,而迁移合法性判定必须读现值。两个选项:(a) 给该助手扩一列(另两个调用方 `updateBindings:1076`、`update:1165` 多取一列无副作用);(b) resetAuthKey 内另起一次同谓词 SELECT。**推荐 (a)**,与 T-15 侦察 §2.1 对 `update` 的同款结论一致;无论哪种,守卫都必须**再进一次 WHERE**,预读只用于选错误码 |
| **T3** | **`changes=0` 有两个原因,不要过度消歧** | 并发 revoke/过期 与 并发迁移(守卫失配)都会让 UPDATE 零变更。`update:1172-1175` 的既有口径是一律 `SHARE_NOT_FOUND`。**照抄它**,不要为了「更准确」新增错误码 —— 存在性探针封闭是 AC-SEC 一侧的约束,而并发迁移的正确重试姿势本来就是「重读再决定」 |
| **T4** | **明文的三条泄漏面** | ① 返回值:只在 enable/reset 挂 `authKey` 键(`firstCreateResponse:538-540` 同款条件挂载);② 落库:只写 hash + kid,`Object.values(row)` 不得含明文;③ 日志:`logShareEvent` 的调用方禁令(`:84`)+ `console.error` 的 `{ name: err && err.name }` 口径。三条各配一条用例(§4.3-F5) |
| **T5** | **不要造第二套哈希** | `digestShareSecret` 是 sec 与 AuthKey 的**唯一**摘要设施(spec `:984-992` 已把「同 pepper 同 kid」钉成交给 T-08 的契约,`matchAuthKey:191-196` 按行上 kid 反查)。另起 `sha256Hex:213-216`(那是幂等指纹用的,无 pepper)或引入新 KDF,都会让 `matchAuthKey` 永远验不过 |
| **T6** | **不要引入新环境变量** | pepper / kid 复用 `SHARE_SEC_PEPPER(_KID)`,栅栏复用 `SHARE_CAPABILITY_V2`。新增变量意味着 `wrangler.toml` 与部署清单同步变更,而 `spec:1266-1271` 正盯着那个文件;design.md:666 的 Inventory 也只登记了这几项 |
| **T7** | **`share:manage` 尚未覆盖该端点(归 T-17)** | T-16 落地后缺口从 4 条变 5 条。**数据面不越权**(service 的谓词恒带 `user_id`),破的是路由级权限语义(AC-ADMIN-10)。T-16 **不许**顺手改 `security.js`;§4.5 最后一条用例的断言要写得容忍「今天是 JWT 兜底、明天是 `SHARE_FORBIDDEN`」,否则 T-17 一落地就把它打红 |
| **T8** | **kid 用「当前」还是「行上原有」?** | 用**当前** `c.env.SHARE_SEC_PEPPER_KID`:`matchAuthKey:192` 按行上 `auth_key_kid` 从 ring 里选 pepper,写当前 kid 等于顺手完成一次 pepper 前滚;写回旧 kid 则会在旧 pepper 退环后 fail-closed。注意 **`auth_key_kid` 与 `pepper_kid` 迁移后可能不再相等** —— spec `:989` 的 `auth_key_kid === pepper_kid` 是 **create 路径**的断言,T-16 不要把它扩成全局不变量 |
| **T9** | **不要新增观测事件名** | `SHARE_EVENT:39-46` 被 `spec:1332-1339` 的 `toEqual` 钉成封闭 6 条。AuthKey 迁移既不属于任何一条现有事件,也没有 AC 要求记事件(design.md:454-455 只列了 Session 侧三条 denied)。**建议 T-16 零事件**;若执行中认为必须记,那是一次 spec 变更,须先经主 AI 裁决 |
| **T10** | **明文丢失无恢复路径** | resetAuthKey **不接 `Idempotency-Key`**(design.md:307 没有该入参,`share_idempotency` 的 `operation` 目前只有 `'create'`)。响应丢失 = 明文永久丢失,恢复手段就是再跑一次 `reset`(会 bump cv、踢掉在飞 Session)。这是可接受的,但应在 exec note 里显式登记,供 T-20 的前端交互设计参照(与 AC-CAP-14 的 create 丢失恢复同族) |
| **T11** | **enable 之后不要顺手 bump cv「求稳」** | 看起来更安全,实则直接违反 AC-AUTH-07 与 AC-ADMIN-05,并且会打红「已建 Session 仍可读」的用例。in-flight establish 的窗口已由 `consumeSessionQuota:439` 的 `auth_key_enabled` 谓词关闭 —— 那条谓词存在的**唯一**理由就是它 |
| **T12** | **不要把 AuthKey 放进 update 白名单** | `UPDATE_FIELDS:873-882` 与 `:868-872` 的注释是 T-15 的成果;design.md:328「一切 Key 迁移只经 resetAuthKey 单入口」。加进去会同时打红 `spec:2298-2340` |
| **T13** | **不要动 Visitor 读路径** | `share-auth-service.js` 是 W1 冻结件,`mail-share.schema.spec.js:142-152` 还有一条**棘轮式** grep 围栏(`countPrimaryAccountReads(shareAuthSource) === 3`,只许降不许升)。T-16 在该文件里加任何一行都可能触发它 |
| **T14** | **`action` 的归一化不要「宽容」** | 不要 `toLowerCase()`、不要接受 `'0'/'1'`、不要把缺省当 `'reset'`。`FLAG_TOKENS:140-143` 的教训写得很直白:一旦在归一化阶段把非法值折成合法值,「静默打开 AuthKey」就再也认不出来了。trim 与否属可裁决(建议**不 trim**,与 `readAuthKey:199-202` 对 Key 明文才 trim 的口径区分开),但要有用例把选择固定下来 |
| **T15** | **非 ACTIVE 行的语义要显式裁决** | 推荐用 `loadMutableShare` 的 ACTIVE + 未过期谓词(与 `update` 一致):在已撤销/已过期的分享上换钥匙没有意义。但这不同于 `get`/`delete` 的宽谓词,属**本任务的口径选择**,必须在 exec note 的 decision 里写明,别让下一个人以为是抄漏了 |

---

## 7. 执行前自检清单(给 T-16 执行者)

- [ ] `action` 是严格枚举,非法/缺失/大小写不符 → `SHARE_INVALID_CONFIG`,且**排在栅栏之前**
- [ ] 迁移守卫 `fromEnabled` **同时**出现在预读判定与条件 UPDATE 的 WHERE 里
- [ ] `reset` 在 `auth_key_enabled=0` 上被拒(V2 两态下都拒),有专门用例
- [ ] 只有 `enable` 调 `assertCapabilityV2(c, SHARE_V2_INTENT.AUTH_KEY_ENABLE)`;reset/disable 在 V2=false 下放行且有用例
- [ ] enable 的 `credentials_version` 逐值不变;reset/disable 恰 +1
- [ ] 三列 `auth_key_enabled / auth_key_hash / auth_key_kid` 在**同一条 UPDATE 的同一个 SET** 里改
- [ ] 不变量全表 SQL 在三条迁移后各断言一次 `bad = 0`
- [ ] 明文只在 enable/reset 的响应里出现一次;`disable` 无该键;库、日志、后续 `get`/`list` 均不含
- [ ] 复用 `digestShareSecret` + `randomToken(16)` + `SHARE_SEC_PEPPER(_KID)`,零新环境变量、零第二套哈希
- [ ] `SHARE_EVENT` 未新增条目;`wrangler.toml` / `wrangler-vitest.toml` 一字未动
- [ ] `security.js` 一字未动,exec note 已把待 T-17 收编的端点从 4 条更新为 5 条(含 `POST /mailShare/resetAuthKey`)
- [ ] 至少三条用例经真实 `SELF.fetch('/api/share/session')` 证明:enable 不失效旧 Session、reset 立即失效、disable 后不再要求 Key
- [ ] HTTP 侧 enable 用例临时改 `env.SHARE_CAPABILITY_V2` 并在 `finally` 还原
- [ ] exec note 的 decision 里登记:非 ACTIVE 行的口径、是否回传 cv、`action` 是否 trim、无 `Idempotency-Key` 的恢复路径

---

## 8. 参考锚点索引

```
契约   docs/specs/mailbox-share-capability/design.md:307(API 行)、:311-329(状态机 + :327 不变量 + :328 单入口)
       :220 / :229-230(V2 栅栏四条 + 回滚路径)、:234(token cv)、:241(KV stale-cv)、:290、:661、:665-666
       :513 / :516 / :540 / :566 / :571(测试矩阵 AC-AUTH-04/07、AC-ADMIN-05、AC-LIFE-11、AC-EDGE-05)
       docs/specs/mailbox-share-capability/requirements.md:59(AC-CAP-05)、:109(AC-AUTH-04)
       :112-113(AC-AUTH-07/08)、:159(AC-ADMIN-05)、:200(AC-LIFE-11)、:212(AC-EDGE-05)
       docs/specs/mailbox-share-capability/tasks.md:25-26(热区表)、:382-386(T-16)、:388-392(T-17)
服务   mail-worker/src/service/mail-share-service.js:30-46(intent/event)、:76-95(栅栏/日志)
       :97-101(randomToken)、:118-135(id/键在场)、:140-166(值域归一)
       :368-377(OWNER_ROW_COLUMNS)、:389-455(投影)、:459-470(条件 UPDATE 范式)、:513-525(loadOwnerDetail)
       :527-543(明文一次性响应)、:595-652(create INSERT,无 cv)、:868-924(update 白名单/栅栏/语句)
       :958-967(loadMutableShare)、:1000-1071(create)、:1155-1208(get/update/delete)、:1250-1257(revoke)
鉴权   mail-worker/src/service/share-auth-service.js:47-60(effectiveStatus)、:113-116(digestShareSecret)
       :185-202(matchAuthKey / readAuthKey)、:204-234(issueToken 带 cv)、:430-442(consumeSessionQuota 双谓词)
       :463-476(stale-cv 重放)、:498-574(establishSession)、:576-601(resolveSession cv 校验)
路由   mail-worker/src/api/mail-share-api.js:6-60(withShare / shareJson / 6 端点)
权限   mail-worker/src/security/security.js:72-76 / :104(T-17 owns)
DDL    mail-worker/src/init/init.js:48-51(四列,无 CHECK,T-01 owns)
用例   mail-worker/test/mail-share-service.spec.js:20-75(PEPPER/ctx/v2ctx/decodeBase64Url)、:130-166(readShareRow/sqlProbe)
       :952-1024(create AuthKey 三条 + AC-LEAK-05)、:1266-1271(wrangler 栅栏)、:1286-1298(intent 清单)
       :1331-1341(SHARE_EVENT 封闭)、:1506-1534(ownerJwt)、:2044-2103(T-15 helper + ownerApi)
       :2182-2206(凭据不出投影)、:2298-2340(update 逐列不变)、:2342-2372(Visitor 真实闭环)
       mail-worker/test/mail-share.schema.spec.js:54-57 / :82-83 / :111-114 / :142-157
       mail-worker/test/share-api.spec.js:363-410(Visitor AuthKey 端到端,种子法待 T-16 替换)
       mail-worker/test/setup.js:49-55 / :96-104(seedShareRow 已支持四列)
配置   mail-worker/wrangler-vitest.toml:34-41(测试基线 V2=false)· mail-worker/wrangler.toml:56-60(生产开关注释态)
前锋   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-t15-owner-api.md(§3 栅栏、T4 AuthKey 越权)
       .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t15-note.md:113(L1 · share:manage 缺口清单)
```
