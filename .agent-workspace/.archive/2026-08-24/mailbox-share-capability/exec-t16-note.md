# Exec Note · T-16 AuthKey 状态机(`POST /mailShare/resetAuthKey`,enable / reset / disable 单入口)

- **日期**:2026-08-24 · **分支**:`cursor/mailbox-share-capability-dcb6` · **起点 HEAD**:`4fbf9a8`(含 T-15 R2)
- **未 commit / 未 push / 未 stash**;`tasks.md`、`docs/specs/**`、`security.js`、`init.js`、`share-auth-service.js`、`share-api.js`、`email.js`、`wrangler*.toml`、`mail-vue/**`、`tests/e2e/**` 一字未动。
- `UPDATE_FIELDS`、`SHARE_EVENT`、`OWNER_ROW_COLUMNS` 三张表零改动(逐条核过 diff)。
- **白名单内改动**(4 个文件,与派单一致):

| 文件 | 增/删 | 说明 |
|---|---|---|
| `mail-worker/src/service/mail-share-service.js` | +95 / −1 | `AUTH_KEY_TRANSITIONS` + `toAuthKeyTransition` + `prepareAuthKeyUpdate` + `resetAuthKey`;唯一一行删除是 `loadMutableShare` 的 SELECT 列表多取一列 |
| `mail-worker/src/api/mail-share-api.js` | +8 / −0 | 只加 `POST /mailShare/resetAuthKey`,既有 7 条端点一字未动 |
| `mail-worker/test/mail-share-service.spec.js` | +514 / −0 | **纯追加**(`git diff -U0` 数出的删除行数 = 0),既有 198 条零改写;顶部多一行 `import worker from '../src/index.js'` |
| 本文件 | 新建 | — |

---

## 红 / 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 基线 | `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` | **198 passed**(T-15 R2 收口态) |
| 红(仅用例就位) | 同上 | **20 failed / 198 passed(218)** |
| 绿 | 同上 | **219 passed(219)** |
| 全量 worker | `pnpm --dir mail-worker test -- --no-cache` | **18 files / 465 tests 全绿**(T-15 收口态 18/444) |
| 前端 | `pnpm --dir mail-vue test -- --no-cache` | **17 files / 95 tests 全绿** |

红的 20 条全部因行为缺失,无一条是语法/装配错误:

- **17 条** `TypeError: default.resetAuthKey is not a function`(服务入口不存在)
- **3 条** HTTP 面 `SyntaxError: Unexpected non-whitespace character after JSON`(`POST /mailShare/resetAuthKey` 404,响应体不是 JSON)

绿之后又补了 **1 条并发用例**(`lets exactly one of two concurrent disables win`,见下 §变异校验 M1),总用例数因此从 218 变 219。它同样依赖 `resetAuthKey` 存在,回到红态一样红。

### 变异校验(证明新谓词/新语义不是摆设)

| 变异 | 结果 |
|---|---|
| **M1** 条件 UPDATE 的 `AND auth_key_enabled = ?` 换成恒真谓词(只留预读判定) | **2 failed** —— SQL 形状用例 + 并发用例(两条并发 disable 都提交,cv 被 +2) |
| **M2** 删掉预读的迁移合法性判定(只留 WHERE 守卫) | **3 failed** —— 三条非法迁移的错误码由 `SHARE_INVALID_CONFIG` 退化成 `SHARE_NOT_FOUND` |
| **M3** `enable` 的 `cvBump` 改 1 | **4 failed** —— 含「已建 Session 仍可读」的 Visitor 闭环 |
| **M4** 三条迁移全部 `gated: true` | **12 failed** |
| **M5** `enable` 改 `gated: false` | **2 failed** |
| **M6** 去掉 `changes = 0 → SHARE_NOT_FOUND` | **1 failed**(并发用例;顺序路径全被预读挡住) |
| **M7** `action` 加 `trim().toLowerCase()` | **1 failed**(值域用例) |
| **M8** `disable` 保留旧 `auth_key_hash`(`COALESCE`) | **15 failed** —— 不变量全表扫在三条迁移后各断言一次,所以踩一处炸一片 |

M1 与 M6 的低计数是刻意的:顺序调用下预读足以给出正确错误码,**只有并发才区分得出「守卫在 WHERE」与「守卫只在预读」**,所以那条并发用例是这两个谓词的唯一取证。

---

## 实现要点

### ① 状态机是一张表,不是三个 if(design.md:311-329 的直译)

```js
const AUTH_KEY_TRANSITIONS = {
  enable:  { fromEnabled: 0, toEnabled: 1, mintsKey: true,  cvBump: 0, gated: true  },
  reset:   { fromEnabled: 1, toEnabled: 1, mintsKey: true,  cvBump: 1, gated: false },
  disable: { fromEnabled: 1, toEnabled: 0, mintsKey: false, cvBump: 1, gated: false }
};
```

`fromEnabled` 是迁移守卫。`reset` 的 `1` 是本任务最贵的一个字符:AC-LIFE-11 只门控 `enable`,一旦允许 `reset` 落在 `auth_key_enabled=0` 的行上,V2=false 时 Owner 发一次 `action='reset'` 就启用了 AuthKey —— 随机路由到旧 Worker 的请求会绕过第二因子(design.md:230 路径④正是要消解这个)。**守卫是栅栏的一部分**,专门用例在 V2 两态下各拒一次。

### ② 顺序契约:值域 → 归属/ACTIVE → 迁移合法性 → V2 栅栏

```
① toAuthKeyTransition(action)                        SHARE_INVALID_CONFIG
② loadMutableShare(shareId, userId)                  SHARE_NOT_FOUND
③ row.auth_key_enabled !== move.fromEnabled          SHARE_INVALID_CONFIG
④ move.gated && assertCapabilityV2(AUTH_KEY_ENABLE)  SHARE_INVALID_CONFIG
```

与 `assertCreateBody:334-367` / `assertUpdatePatch:902-910` 同构:永久领域错误在前,暂时的发布态在后。①③④ 共用一个错误码,语义只能靠语句顺序保住,所以用例也按这个顺序钉(「V2=false 下对未启用行发 `reset`」必须是 `SHARE_INVALID_CONFIG` 且**与栅栏无关**)。

`action` 是严格枚举:`typeof value === 'string'` + `hasOwnProperty`。不 trim、不 `toLowerCase`、不接受数组包装(`String(['reset'])` 恰是 `'reset'`,所以拿 `String()` 归一就是个洞)、缺省不折成任何一条迁移。`'toString'` / `'constructor'` / `'__proto__'` 由 `hasOwnProperty` 挡掉,用例逐个钉。

### ③ 写入语句形状(一条 UPDATE 同时完成迁移 + 守卫 + 计数)

```sql
UPDATE mail_share
SET auth_key_enabled = ?,                             -- 1 / 1 / 0
    auth_key_hash    = ?,                             -- hash / hash / NULL
    auth_key_kid     = ?,                             -- kid  / kid  / NULL
    credentials_version = credentials_version + ?     -- 0 / 1 / 1
WHERE share_id = ? AND user_id = ?
  AND status = 'ACTIVE' AND expires_at > ?
  AND auth_key_enabled = ?                            -- ← 迁移守卫:enable→0,reset/disable→1
```

- 三列恒在**同一个 SET** 里赋值,物理上不存在 `enabled=1 / hash=NULL` 的中间态 —— DDL 侧没有 CHECK 兜底(`init.js:48-51` 是纯 `ALTER TABLE ADD COLUMN`,SQLite 无法对既有表追加表级 CHECK),所以不变量只能靠语句形状 + 断言表达。
- 不用 `RETURNING`,直接看 `run()` 的 `meta.changes`。`changes = 0` → `SHARE_NOT_FOUND`,与 `update:1223-1226` / `revoke` 同码,不为「并发迁移输了」新增可区分错误码(存在性探针保持封闭,而并发迁移的正确重试姿势本来就是重读再决定)。
- `nowText()` 与 `expires_at` 同为 `YYYY-MM-DD HH:mm:ss`,字典序比较与 JS 侧逐字一致。

不变量的可执行形式(三条迁移后各断言一次 `bad = 0`):

```sql
SELECT COUNT(*) AS bad FROM mail_share
WHERE (auth_key_enabled = 1) <> (auth_key_hash IS NOT NULL AND auth_key_kid IS NOT NULL)
```

另有一条异常恢复用例:直接 seed 非法组合(`enabled=1 / hash=NULL / kid=NULL`,`bad = 1`)→ 对其 `disable` → `bad = 0`。

### ④ 密钥物料完全复用 create 那一套,零新设施

`randomToken(16)`(128-bit CSPRNG → base64url 恰 22 字符)+ `shareAuthService.digestShareSecret(key, pepper)` + `SHARE_SEC_PEPPER` / `SHARE_SEC_PEPPER_KID`。`shareAuthService` **只在函数体内解引用**(两模块互相 import,模块求值期解引用会踩 TDZ)。零新环境变量、零第二套哈希、零新 `SHARE_EVENT` 条目。

- `auth_key_kid` 写**当前** kid 而不是行上原有值:`matchAuthKey:192` 按行上 kid 从 pepper ring 反查,写当前 kid 等于顺手完成一次 pepper 前滚;写回旧 kid 会在旧 pepper 退环后 fail-closed。⚠️ 因此 `auth_key_kid === pepper_kid` 只是 **create 路径**的断言(`spec:990`),T-16 之后**不是全局不变量**。
- 缺 pepper 照抄 create(`mail-share-service.js:1060-1064`):`console.error` + 抛普通 `Error`(不是 BizError)。`disable` 不需要 pepper,所以不为它做无谓的前置检查。

### ⑤ 出参:`loadOwnerDetail` 形状 + 条件挂载的明文

`enable` / `reset` 回 `{ ...detail, authKey }`;`disable` 回 `detail`,**没有 `authKey` 这个键**(不是空串,与 `firstCreateResponse:539-541` 同款条件挂载,用例用 `'authKey' in result === false` 钉)。

不回 `credentials_version` / `auth_key_hash` / `auth_key_kid`:`OWNER_ROW_COLUMNS:371-378` 的既定口径是凭据列与 cv 不进 Owner 投影(「取不到就漏不掉」),用例验 cv 走 `readShareRow` 直查。明文的三条泄漏面各配一条断言:响应(只挂一次)、落库(`Object.values(row)` 不含)、日志(捕获 `console.log/error` 不含)。

### ⑥ Visitor 面走的是真实 `SELF.fetch` 闭环,不只查库

三条用例,pepper / kid 取 `env.SHARE_SEC_PEPPER(_KID)`(否则 HTTP 侧的 `matchSec` / `matchAuthKey` 永远验不过):

| 迁移 | 旧 Session | 旧 Key 建新 Session | 新 Key 建新 Session |
|---|---|---|---|
| `enable` | **仍 200**(cv 未动,`resolveSession` 全程不读 `auth_key_enabled`) | 无 Key → `SHARE_AUTH_REQUIRED` | 200 |
| `reset` | `SHARE_UNAVAILABLE` | `SHARE_AUTH_REQUIRED` | 200,且新 token 可读 |
| `disable` | `SHARE_UNAVAILABLE` | 不带 Key → 200 | 带旧 Key → 同样 200(多余字段被忽略,不得报错) |

`enable` 不 bump cv 留下的在飞 establish 窗口,由 `consumeSessionQuota:439` 的 `eq(mailShare.authKeyEnabled, expectedAuthKeyEnabled)` 谓词关闭 —— 那条谓词存在的唯一理由就是它,T-16 因此**没有**为求稳给 enable 加 cv(M3 变异 4 failed 就是这条的取证)。

### ⑦ HTTP 面 enable 必须直接喂 worker,`SELF.fetch` 改 env 没用(⚠️ 与侦察 §4.6 有出入)

侦察建议「用例内改 `env.SHARE_CAPABILITY_V2` 并在 `finally` 还原」,并援引 `share-integration.spec.js:261-267` 为先例。**实测:改 `env` 对 `SELF.fetch` 无效** —— workerd 那侧读的是自己那份 env 快照。实验取证:在同一个用例里把 `env.SHARE_ENABLED` 改成 `'0'` 后经 `SELF.fetch` 建分享,仍然成功。

`share-integration.spec.js` 之所以成立,是因为那条路径走的是 `jsonWorker`(`:82-89`),它 `import worker from '../src/index.js'` 后 **`worker.fetch(req, env, {})` 直接把测试侧那个 `env` 对象喂进去**。本任务照抄这个姿势,新增 `ownerWorker()` helper,并仍然保留 `try/finally` 还原(那个对象是全局共享的)。**`wrangler-vitest.toml` 一字未动**,V2 基线仍是 `"false"`。

同一条用例先用 `SELF.fetch`(真实基线态)证明 enable 被拒,再用 `ownerWorker` + 临时放行证明它能过 —— 两条传输都覆盖到。

---

## 决策登记(侦察 §7 点名要记的几条)

| # | 决策 | 理由 |
|---|---|---|
| D1 | **非 ACTIVE 行一律拒**:走 `loadMutableShare` 的 ACTIVE + 未过期谓词,已撤销 / 已过期 → `SHARE_NOT_FOUND` | 与 `update` 同一把锁。在已撤销的分享上换钥匙没有意义;这**不同于** `get` / `delete` 的宽谓词(那两条要服务 AC-ADMIN-09 的审计面),属本任务口径选择,不是抄漏 |
| D2 | **不回传 `credentials_version`** | `OWNER_ROW_COLUMNS` 的既定口径,cv 是内部纪元不是 Owner 语义。测试验 cv 走 `readShareRow` |
| D3 | **`action` 不 trim** | 与 `readAuthKey:199-202`(对 Key 明文才 trim)刻意区分开:Key 明文是人手贴的,`action` 是程序发的。`'enable '` 有专门用例钉住这个选择 |
| D4 | **无 `Idempotency-Key`,响应丢失 = 明文永久丢失** | design.md:307 没有该入参,`share_idempotency.operation` 目前只有 `'create'`。恢复手段是再跑一次 `reset`(会 bump cv、踢掉在飞 Session)。**T-20 的前端交互要按这个前提设计**(与 AC-CAP-14 的 create 丢失恢复同族) |
| D5 | **零 `SHARE_EVENT` 事件** | `SHARE_EVENT:40-47` 被 `spec:1333-1343` 的 `toEqual` 钉成封闭 6 条,AuthKey 迁移不属于任何一条,也没有 AC 要求记事件。新增即 spec 变更 |
| D6 | **给 `loadMutableShare` 扩一列**(方案 a),而不是另起一次同谓词 SELECT | 另两个调用方(`updateBindings:1127`、`update:1216`)多取一列无副作用;守卫仍然**再进一次 WHERE**,预读只用于选错误码 |

---

## 遗留风险

| # | 风险 | 说明 |
|---|---|---|
| **L1** | **🔴 `share:manage` 缺口从 4 条变 5 条(归 T-17,上线前必补)** | `exec-t15-note.md` L1 的清单请更新为 **5 条只被 JWT 兜住、没有 `share:manage` 精确匹配**的端点:`PUT /mailShare/bindings`(T-13)、`GET /mailShare/get`、`PUT /mailShare/update`、`DELETE /mailShare/delete`(T-15)、**`POST /mailShare/resetAuthKey`(T-16)**。T-17 要改**两处**:① `security.js:104` `premKey['share:manage']` 由 3 条扩为 8 条(create/list/revoke/get/update/bindings/delete/**resetAuthKey**);② `security.js:72-76` `requirePermsExact` 由 3 条扩为 8 条,新增的那条是 `{ method: 'POST', path: '/mailShare/resetAuthKey' }`。**路径名与方法已在本任务冻结**。数据面不越权(service 的谓词恒带 `user_id`,他人 shareId 一律 `SHARE_NOT_FOUND`,有用例);破的是路由级权限语义(AC-ADMIN-10)。 |
| L2 | 匿名用例的断言刻意写松 | `refuses an anonymous caller` 只断言 `code !== 200`,不钉 `SHARE_FORBIDDEN` —— 今天是 JWT 兜底(401),T-17 收编后会变成 403 `SHARE_FORBIDDEN`。它先用一次带 JWT 的成功调用证明路由确实存在,避免端点缺失时假绿。T-17 落地后可以收紧成精确断言。 |
| L3 | 并发取证依赖 `Promise.allSettled` 的调度顺序 | 两条并发 `disable` 目前稳定表现为「预读都看到 `enabled=1`,第二条在 WHERE 上失配」。断言已经对失败码放宽到 `SHARE_NOT_FOUND | SHARE_INVALID_CONFIG`,真正的取证是 `credentials_version === 4`(不是 5)。若将来 miniflare 的 D1 调度变成完全串行,这条会退化成一条普通的顺序用例(仍绿,但不再证明 WHERE 守卫)。 |
| L4 | `auth_key_kid` 与 `pepper_kid` 迁移后可能不相等 | 见 §④。`spec:990` 的 `auth_key_kid === row.pepper_kid` 只对 create 出来的行成立。任何人想把它扩成全局不变量都会踩到 pepper 前滚。 |
| L5 | KV 重放缓存不主动清 | `reset` / `disable` bump cv 后,`readReplayCache:468` 按 stale-cv 当 miss 处理,不构成越权;但缓存条目仍在 KV 里躺到最长 120s 自然过期。与 T-15 的 L8 同族。 |
| L6 | `resetAuthKey` 不查 `SHARE_DISABLED` | 与 `update` / `revoke` / `updateBindings` 一致(见 T-15 L7):冻结期的语义是「禁止新建、存量保持」,把管理面冻上会让 Owner 在冻结期连关掉第二因子都做不到。要改属独立裁决。 |
| L7 | 明文丢失无第二次机会 | 见 D4。前端(T-20)必须在同一次响应里把明文展示完并提示「只显示一次」,否则 Owner 只能 `reset` 一次,代价是踢掉全部在飞 Session。 |

---

## 未做事项

- **不动 `security.js`**(T-17 的地盘,同波次禁止第二写者)—— 缺口已登记为 L1。
- **不动 `share-auth-service.js`**:Session 侧的 cv 校验(`resolveSession:591`)、AuthKey 校验(`matchAuthKey:185-197`)、`consumeSessionQuota` 的双谓词全部现成,T-16 一行没改,只用真实 `SELF.fetch` 闭环证明它们与新写入口同源。
- **不动 `share-api.spec.js:363-410`**:那里的 Visitor AuthKey 端到端仍用种子法造行。侦察提过「待 T-16 替换成真实 resetAuthKey」,但那是既有用例的改写,超出「只追加」的派单边界,留给后续任务裁决。
- **不动 `mail-vue`**:Owner 面的 AuthKey 交互(明文只显示一次、`action` 三按钮、reset/disable 的二次确认)归 T-20。
- **未提交**:`git add` / `git commit` / `git stash` 一次都没跑,`tasks.md` 未改。
