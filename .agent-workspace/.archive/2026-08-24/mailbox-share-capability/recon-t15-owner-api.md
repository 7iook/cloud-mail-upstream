# Recon · T-15 Owner API 扩展(get / update / delete + list 分页与新投影)

| 字段 | 值 |
|---|---|
| 范围 Scope | T-15(W3 首棒),`docs/specs/mailbox-share-capability/tasks.md:358-362` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`(工作树无生产代码改动) |
| 侦察日期 | 2026-08-24 |
| 依据 AC | AC-ADMIN-01/02/03/04/06/07/09、AC-EDGE-14、AC-LIFE-11、AC-OTP-06 |
| 性质 | 只读侦察。**未改任何文件、未提交**;本文件是唯一产物 |

---

## 0. 一句话结论

T-15 的四个动作里,**只有 `list` 是「改造」,`get`/`update`/`delete` 是三张白纸**;真正的风险不在新写三个函数,而在三处已经埋好的坑:
① 现有 `projectOwnerRow` 的 `effectiveStatus` 永远算不出 `ACCESS_LIMIT_REACHED`(投影少喂 `maxSessions`),AC-ADMIN-04/09 现在是假绿;
② `update` 若复用 `normalizeCreateBody`,会把没传的字段静默重置成 DDL 默认值;
③ `update` 必须同时接 `FINITE_MAX_SESSIONS` **和** `MESSAGE_LIMIT` 两条 V2 栅栏,少接后者就是绕过栅栏写 `message_limit` 的后门(exec-t12-note 第 5 条已经点名)。

---

## 1. 已有 vs T-15 必须新增

### 1.1 已存在(可直接站上去)

| 能力 | 位置 | 现状 |
|---|---|---|
| `create` | `mail-share-service.js:743-814` · `mail-share-api.js:23-28` | 多邮箱 + 全配置 + 幂等 + 四路 V2 栅栏齐活;`assertCreateBody:307-340` 是值域校验的现成范本 |
| `updateBindings` | `mail-share-service.js:817-895` · `mail-share-api.js:35-39` | 全有或全无 batch + CAS 快照 + 删空转撤销 + 主表双写 |
| `list` | `mail-share-service.js:897-927` · `mail-share-api.js:30-33` | **全量无分页**:`WHERE ms.user_id = ? ORDER BY ms.share_id DESC`,`LEFT JOIN account` 只取主 `account_id` 的 mailbox;返回 `{ list, total: list.length }` |
| `revoke` | `mail-share-service.js:929-936` | 条件 UPDATE 置 `REVOKED` + `revoked_at`,`changes=0 → SHARE_NOT_FOUND`(AC-ADMIN-06 已绿,T-15 只需保持) |
| `revokeByAccountIds` | `:938-959` | 归 T-18 改造,T-15 **不碰** |

### 1.2 T-15 必须新增

| 项 | 契约出处 | 要点 |
|---|---|---|
| `GET /mailShare/get` | design.md:302 · AC-ADMIN-02 | 单条详情 + Binding 清单 + 全部配置;他人 shareId → `SHARE_NOT_FOUND`。**必须能读到非 ACTIVE 行**(AC-ADMIN-09 审计),所以不能用 `loadMutableShare` |
| `PUT /mailShare/update` | design.md:303 · AC-ADMIN-03/04 · AC-EDGE-14 | 白名单 8 字段 `name/remark/maxSessions/messageLimit/otpExtractionEnabled/autoRefresh/refreshIntervalMs/showFullAddress` + `resetUsedSessions?`;不可改 `lid/sec_hmac/expires_at`;**SHALL NOT** 触碰 `auth_key_hash/auth_key_kid/auth_key_enabled/credentials_version`(design.md:328) |
| `DELETE /mailShare/delete` | design.md:306 · AC-ADMIN-07 | 物理删 `mail_share` + `mail_share_binding` + `share_idempotency`,一个 `c.env.db.batch()` 原子,零孤儿 |
| `list` 分页 + 新投影 | design.md:301(R1-F2)· AC-ADMIN-01/09 | `page?/size?`(size 默认 20、上限 100)、稳定序恒 `share_id DESC`、无参全量保留但 deprecated 且硬上限 500;行补 `shareType` / 四态 `effectiveStatus` / `usedSessions` / `maxSessions` / `bindings` 摘要 |

### 1.3 三条基线断言,只准扩展不准改写

`list` 的响应形状已经被三处钉住,新投影只能加字段:

- `mail-share-service.spec.js:332-345` —— `total===1`、`mailbox/name/remark/status/effectiveStatus/accessCount` 六字段 `toMatchObject`,`createTime/expiresAt` 为 String,`lastAccessAt == null`。**`accessCount` 这个键必须保留**(`usedSessions` 是新增别名,不是改名 —— D4 明写物理列名不改、DTO 增映射)。
- `mail-share-service.spec.js:438-441`、`:465-475` —— 过期行 `status='ACTIVE'` 而 `effectiveStatus='EXPIRED'`;只列本人行。
- HTTP 侧 `share-api.spec.js:190-196`、`share-integration.spec.js:671-676` —— `data.total` / `data.list[0].accessCount` / 响应不含 `sec` + `Cache-Control: no-store`。

> 直接后果:**无参调用必须继续返回可用的全量列表**(前端 `mail-vue/src/request/mail-share.js:34` 至今 `http.get('/mailShare/list')` 不带任何参数)。若把默认 size=20 套到无参路径上,ShareDialog 与上述用例一起翻车。deprecated 路径的语义是「不分页、硬顶 500 行」。

---

## 2. 可复用助手清单(逐个给出复用姿势与陷阱)

### 2.1 `loadMutableShare(c, shareId, userId)` · `:701-710`

```
SELECT share_id, lid, only_messages_after_created FROM mail_share
WHERE share_id = ? AND user_id = ? AND status = 'ACTIVE' AND expires_at > ?
```

- 语义是「**可变更**的本人分享」:同时过滤 `status='ACTIVE'` **且** `expires_at > now`,不满足一律 `SHARE_NOT_FOUND`(与 revoke 同码,不新增可区分错误码 —— 存在性探针封闭)。
- ✅ **`update` 可直接复用**(改配置本就只对活分享有意义),但 **SELECT 列不够**:`resetUsedSessions` 判据要 `max_sessions` 现值,`ACCESS_LIMIT_REACHED` 回显要 `access_count`。扩列会同时影响 `updateBindings`(唯一另一个调用方,`:819`),多取两列无副作用,属安全扩展;若不想动共享助手,就在 `update` 内另起一次 SELECT。
- ⛔ **`get` 不能复用**:AC-ADMIN-09 要求 EXPIRED/REVOKED/ACCESS_LIMIT_REACHED 行仍可读可审计,套上 ACTIVE 谓词直接把审计面砍掉。
- ⛔ **`delete` 不能复用**:物理删除的主要对象恰恰是已撤销/已过期的行。

### 2.2 `projectOwnerRow(row, mailbox, now)` · `:342-361`

- 唯一的 Owner 行投影出口,`list` 现在是唯一调用方。`get` 应复用同一投影(详情 = 列表行 + bindings + config),避免两套字段名。
- 🔴 **现存缺陷(T-15 必修)**:第 352 行 `shareAuthService.effectiveStatus(row, now)`,而 `effectiveStatus`(`share-auth-service.js:47-60`)判 `ACCESS_LIMIT_REACHED` 读的是 `row.maxSessions` 与 `row.accessCount`。`list:910-925` 组装的对象**根本没有 `maxSessions` 键** → 恒 `undefined` → `!= null` 为假 → **这条分支现在永远不会命中**。因此 AC-ADMIN-04(下调 max_sessions 后态正确)与 AC-ADMIN-09 的第三态在今天是不可达的。T-15 的 SELECT 必须补 `ms.max_sessions`,并在传入对象里带上 `maxSessions`。
- 投影扩展点:`shareType`(派生,见 2.5)、`usedSessions`(= `accessCount`,别名不替换)、`maxSessions`、`messageLimit`、其余配置列、`bindings` 摘要。

### 2.3 `assertCapabilityV2(c, intent)` · `:65-70` + `SHARE_V2_INTENT` · `:19-25`

- 判定与 intent 无关,只读 `SHARE_CAPABILITY_V2`,不过即抛 `SHARE_INVALID_CONFIG`。
- 顺序契约(照抄 `assertCreateBody:305-340` 的注释):**域校验 → 上限 → 栅栏**。永久领域错误必须排在暂时发布态之前,否则 `refreshIntervalMs=2000` 在 V2=false 下会返回 `SHARE_INVALID_CONFIG`「栅栏味」而不是值域味 —— 这两者恰好共用同一个错误码,更要靠**语句顺序**保住语义,测试也应按这个顺序钉。
- 详见 §3。

### 2.4 `syncPrimaryAccountId(c, target)` · `:600-621`

- 返回**未执行**的语句,收 `shareId` 或 `{ lid }`;把主表 `account_id` / `window_start_email_id` 对齐主 Binding,无可用 Binding 时自身零变更(绝不写 0)。
- T-15 的三个新入口**都不改变 Binding 集合**:`get` 只读、`update` 只动配置列、`delete` 整行删掉。因此 **T-15 原则上不需要调用它**。
- ⚠️ 唯一需要想一秒的是 `update` 改 `only_messages_after_created` 的情形 —— 契约里 `update` 的白名单**不含**该字段(design.md:303 只列 8 项),窗口下界快照口径因此不动,不需要 resync。**别顺手把 `onlyMessagesAfterCreated` 加进 update 白名单**:改它会让主表/Binding 的 `window_start_email_id` 与新口径失配,而重算窗口是 create/bindings 两条写入口的语义,不是 update 的。

### 2.5 其它现成件

| 助手 | 位置 | 用途 |
|---|---|---|
| `loadBindings(c, shareId)` | `:383-389` | `get` 的 Binding 清单直接用;返回 `{bindingId, accountId}`,**不含 mailbox**,详情要显示地址需另 JOIN account |
| `shareTypeOf(bindings)` | `:379-381` | `>1 → 'multi'`,派生不落库(D1/AC-CAP-02) |
| `placeholders(list)` | `:266-268` | 展开 `?` 占位符 |
| `json_each(?)` 模式 | `snapshotPredicate:276-287` 的注释 | **分页取 bindings 时的首选**:D1 单语句 100 个绑定参数硬上限,size 上限 100 → 100 个 shareId 直接展开 IN 就撞线 |
| `isRowId(value)` | `:107-109` | 入参 id 校验,`Number.isSafeInteger && > 0` |
| `toFlag / toNullableCount` | `:119-128` / `:131-140` | 值域归一;**注意二者把 `''` 与 `null` 都当「没传」并回落 fallback**,update 的语义不同,见 §6-T3 |
| `nowText()` | `:37-39` | `YYYY-MM-DD HH:mm:ss`,与 `expires_at` 同格式 |
| `isShareDisabled(c)` | `:41-53` | 目前只有 create 用。**建议 T-15 不给 get/update/delete 加冻结闸门**:AC-ABUSE-03/AC-LIFE-13 的语义是「冻结期禁止新建、存量保持」,把管理面也冻上会让 Owner 在冻结期连撤销/删除都做不了 —— 若要改,应属独立裁决而非 T-15 顺手 |
| `logShareEvent` / `SHARE_EVENT` | `:74-84` / `:28-35` | 事件名是封闭清单(spec 已钉,`mail-share-service.spec.js:1331-1341`);T-15 **不要新造事件名** |

---

## 3. 🔴 V2 / MESSAGE_LIMIT 栅栏(update 侧必接,不可漏)

这是本次侦察最重要的一条,T-03 埋点、T-12 留言、tasks 只写了一半。

**现状**:`SHARE_V2_INTENT` 五条 intent 中,`MULTI_CREATE` / `AUTH_KEY_ENABLE` / `FINITE_MAX_SESSIONS` / `MESSAGE_LIMIT` 在 create 侧已接线(`:328-339`),`BINDING_EXPAND` 在 T-13 接线(`:737-739`)。**update 侧一条都没有 —— 因为 update 还不存在。**

**T-15 必须在 `update` 里接的两条**:

```
if (patch 里 maxSessions 被设为有限值)  assertCapabilityV2(c, SHARE_V2_INTENT.FINITE_MAX_SESSIONS);
if (patch 里 messageLimit 被设为有限值) assertCapabilityV2(c, SHARE_V2_INTENT.MESSAGE_LIMIT);
```

- **tasks.md:361 只写了 `maxSessions`,这是任务书的疏漏,不是契约的裁决。** `message_limit` 的栅栏理由在 `mail-share-service.js:17-18` 的注释里白纸黑字:旧 Worker 不认识该列,落库即「可见集被放宽到窗口内全部邮件」—— 这是**可见性放大**,比配额失效更严重。`exec-t12-note.md` 第 5 条明确点名:「update 侧(T-15)必须记得接同一条,否则 `PUT /mailShare/update` 会成为绕过栅栏写 `message_limit` 的后门」。
- **触发条件是「设为有限值」,不是「字段出现在 patch 里」**:
  - `null`(取消限制)→ 旧 Worker 语义完全兼容 → **放行**,不过栅栏。create 侧同款:`:334`/`:337` 都是 `!= null` 才拦,spec `:1253-1265`「still accepts explicit nulls for the gated quota fields」正是这条。
  - 有限正整数 → 过栅栏。
- **顺序**:值域(`< 1` / 非安全整数 → `SHARE_INVALID_CONFIG`)先判,栅栏后判,与 `assertCreateBody` 同构。
- **同款遗漏面自查**:`authKeyEnabled` 不在 update 白名单(归 T-16 单入口),所以 update 不接 `AUTH_KEY_ENABLE`;`accountIds` 不在 update 白名单,不接 `MULTI_CREATE`/`BINDING_EXPAND`。**四条里恰好且只有两条落在 update 上。**
- 建议在 spec 里加一条「栅栏覆盖率」用例:遍历 `SHARE_V2_INTENT`,断言 update 路径对 `FINITE_MAX_SESSIONS` 与 `MESSAGE_LIMIT` 两条在 V2=false 下均拒。测试上下文用现成的 `ctx()` / `v2ctx()`(`mail-share-service.spec.js:44-51`)。

### 3.1 与 `resetUsedSessions` 的交互(AC-EDGE-14,同一条语句)

- 判据是**旧值**:`max_sessions IS NULL` 且本次设为有限值 → 首设 → 缺省 `resetUsedSessions=true` → `access_count = 0`;显式 `false` → 保留计数(可能立即 `ACCESS_LIMIT_REACHED`,属 Owner 显式选择,原样接受)。
- design.md:303 要求「**同语句**将 `access_count` 置 0」。SQLite 单条 UPDATE 的所有 SET 表达式都读**更新前**的行值,所以 `SET max_sessions = ?, access_count = CASE WHEN max_sessions IS NULL AND ? = 1 THEN 0 ELSE access_count END` 里的 `max_sessions` 恒是旧值,与 SET 子句先后顺序无关 —— 不需要先 SELECT 再判、更不需要两条语句。这一点值得在实现处留一行注释,否则后来者容易「优化」成读后写。
- 非首设(旧值已是有限值)时,无论 `resetUsedSessions` 传什么都**不重置** —— 纪元基线只建立一次。
- AC-ADMIN-04(下调 `max_sessions ≤ used_sessions`)必须**接受**,不得校验成错误;态由 `effectiveStatus` 实时算出(所以 §2.2 的投影缺陷必须先补,否则这条 AC 写了用例也验不出真值)。

---

## 4. 文件白名单提案

### 4.1 允许写(3 个)

| 文件 | 改动 | 约束 |
|---|---|---|
| `mail-worker/src/service/mail-share-service.js` | 新增 `get` / `update` / `delete`;`list:897-927` 扩展分页与投影;`projectOwnerRow:342-361` 补字段;必要时 `loadMutableShare:701-710` 扩 SELECT 列 | 波次内**单写者**(tasks.md:26);create/updateBindings/revoke/revokeByAccountIds 的既有逻辑一字不动 |
| `mail-worker/src/api/mail-share-api.js` | 新增 `GET /mailShare/get`、`PUT /mailShare/update`、`DELETE /mailShare/delete` | 沿用 `withShare` 包装 + `shareJson`(`no-store`)+ `userContext.getUserId(c)`;**校验一律留在 service**(仓内既有约定,recon-w2-t12-create §1.3 同款结论);get/delete 读 `c.req.query()`,update 读 `await c.req.json()` |
| `mail-worker/test/mail-share-service.spec.js` | T-15.1 红灯用例 | 追加新 `describe` 块;既有 2022 行**只加不改**,尤其 §1.3 的三条 list 基线 |

### 4.2 明确不碰

| 文件 | 归属 | 理由 |
|---|---|---|
| `mail-worker/src/security/security.js` | **T-17** | `requirePermsExact:72-76` 与 `premKey['share:manage']:104` 的 3→8 扩展是 T-17 独占;同波次内绝不能出现第二写者(tasks.md:25) |
| `mail-worker/src/init/init.js` | T-01 | DDL/回填单 owner;T-15 不需要任何新列 —— 8 个可变字段 v3_2DB 已全部就位(`init.js:41-51`) |
| `mail-worker/src/service/share-auth-service.js` | W1 已冻结 | `effectiveStatus:47-60` 是四态唯一真源,**只读不改**;T-15 的活是把正确的字段喂进去,不是改判定 |
| `mail-worker/src/service/mail-share-cleanup-service.js` | T-18 | 到期清理与孤儿补偿归 T-18;T-15 的 `delete` 是 Owner 主动删,两条路径互不覆盖(见 §6-T6) |
| `mail-worker/src/entity/mail-share.js` | 只读 | 列已齐(`:21-31`);T-15 走原生 SQL,不需要 drizzle 侧改动 |
| `mail-worker/test/setup.js` | 共享基建 | `seedShareRow:75-116` / `seedBindingRow:122-132` 已覆盖 v3_2DB 全部列(含 `maxSessions`/`accessCount`/`messageLimit`),T-15 造种子无需扩工厂 |
| `mail-worker/test/security-share.spec.js` | T-17 | 8 端点 `SHARE_FORBIDDEN` 回归归 T-17 |
| `mail-worker/test/share-api.spec.js` · `share-integration.spec.js` | T-19 | 现有 list 断言只作为「不许改坏」的基线;端到端扩展归 T-19 checkpoint |
| `mail-vue/**` · `tests/e2e/**` | W4/W5/W6 | 前端 `request/mail-share.js:34` 的无参 list 是**兼容义务的来源**,不是 T-15 的改造对象 |

---

## 5. 并行切分:T-15 内部必须串行的部分

**结论:T-15 不可再拆并行,整块单执行者串行完成。**

物理原因有两条,任一条都足以否掉 fanout:
1. **单文件单写者**:三个新函数 + list 改造全落在 `mail-share-service.js` 一个文件,`tasks.md:26` 已把该文件登记为「W3 内 T-15→T-16→T-18 串行」的热区。
2. **单 spec 文件**:T-15.1 的全部红灯用例落在 `mail-share-service.spec.js` 一个文件(2022 行,顶部 helper 区共享)。两个 sub 并行改同一 spec 顶部的 helper 区必冲突。

内部**逻辑顺序**建议(同一执行者内的推进次序,不是并行槽):

```
① projectOwnerRow 补 maxSessions/messageLimit + list SELECT 补列   ← 先修 §2.2 缺陷,四态才可验
② list 分页(page/size/无参 deprecated 500)+ bindings 摘要二次查询
③ get(复用 ①② 的投影 + loadBindings)
④ update(白名单 patch + 值域 + 双栅栏 + resetUsedSessions 同语句)
⑤ delete(三表 batch)
```

- ①必须最先:②③④ 的断言都依赖正确的 `effectiveStatus`;先做②③会写出一批「假绿」用例。
- ④与⑤互不依赖,但同文件,顺序做即可。
- **可与 T-15 真正并行的只有 T-17**(独占 `security.js` + `security-share.spec.js`,零文件交集)。T-16 与 T-18 同写 `mail-share-service.js`,必须等 T-15 落库。
- 若确实要在 T-15 内部派 sub,唯一安全的切法是「实现 sub + 独立评审 sub」的时间串行,而不是空间并行。

---

## 6. 风险与陷阱

| # | 风险 | 说明与处置 |
|---|---|---|
| **T1** | **`share:manage` 尚未覆盖新端点(归 T-17)** | `security.js:72-76`/`:104` 现在只登记 create/list/revoke 三条。T-13 加的 `PUT /mailShare/bindings` 已经踩过一次(`exec-t13-note.md` L1),T-15 再加三条 → **合计 4 条端点只被 JWT 兜住、无 `share:manage` 精确匹配**。数据面不越权(service 的资源谓词恒带 `user_id`,他人 shareId 一律 `SHARE_NOT_FOUND`),破的是**路由级权限语义**。T-15 **不许**顺手改 security.js;应在 exec note 里显式登记「新增 3 条待 T-17 收编」,并让 T-17 的 8 条清单核对 T-13+T-15 实际落地的路径名 |
| **T2** | **`projectOwnerRow` 的 `ACCESS_LIMIT_REACHED` 现在不可达** | 见 §2.2。若照抄现有 list 组装写 get,缺陷会被复制到第二处。**先修投影,再写用例** |
| **T3** | **update 复用 `normalizeCreateBody` = 静默重置** | `normalizeCreateBody:168-185` 是 create 语义:缺省字段回落 DDL 默认(`toFlag(x, 1)` / `toNullableCount` 把 `''` 与 `null` 都当没传)。用在 patch 上会把 Owner 没提交的 `otpExtractionEnabled` 悄悄打回 1、把 `maxSessions` 悄悄清成 NULL。update 需要**独立的 patch 归一**:「键不存在 = 不改」与「键存在且为 null = 清空(仅两个 nullable 计数列)」必须可区分 —— 建议用 `Object.prototype.hasOwnProperty.call(params, key)` 判在场,而不是真值判断。**也不要反过来去改 `normalizeCreateBody`**,它的字段顺序是幂等指纹的一部分(`:165-167`) |
| **T4** | **update 越权触碰 AuthKey / cv** | design.md:328 + AC-AUTH-07:一切 Key 迁移只经 `resetAuthKey`(T-16)。update 的 SET 子句必须是**显式白名单**(禁止 `Object.keys(patch)` 拼 SQL),且 `credentials_version` 不得 bump —— bump 会让在飞 Session 无故失效。spec 应加一条「update 前后 `auth_key_*` 与 `credentials_version` 四列逐列不变」的断言 |
| **T5** | **update 也不得改 `lid` / `sec_hmac` / `expires_at` / `user_id` / `account_id` / `window_start_email_id` / `status`** | 前三者是任务书点名的;后四者同样致命:改 `account_id`/`window_start_email_id` 会绕过 Binding 真源与 `syncPrimaryAccountId` 的双写口径(AC-LIFE-10),改 `status` 会绕过 revoke 的终态单向性(AC-ADMIN-06「撤销后不可重新启用」)。白名单实现天然挡住,断言要写出来 |
| **T6** | **delete 无外键,级联全靠手写** | `mail_share_binding`(`init.js:64-71`)与 `share_idempotency`(`:162-172`)**都没有 FOREIGN KEY**,D1 也不开 `ON DELETE CASCADE`。三条 DELETE 必须进同一个 `c.env.db.batch()`,且**子表在前、主表在后**:子表的归属谓词要经 `mail_share` 回查 `user_id`(`EXISTS (SELECT 1 FROM mail_share ms WHERE ms.share_id = ? AND ms.user_id = ?)`),主表行一旦先删,子表的归属判据就消失了。`share_idempotency` 按 `share_id = ? AND user_id = ?` 删(该列可空,`entity/mail-share.js:40`)。主表语句 `changes=0 → SHARE_NOT_FOUND`。参照 `mail-share-cleanup-service.js:21-27` 的「先幂等行、后主表」顺序 |
| **T7** | **delete 的可见范围必须比 revoke 宽** | 删的往往是 REVOKED/EXPIRED 行;谓词只能是 `share_id = ? AND user_id = ?`,**不带 status/expires_at**。别复用 `prepareRevoke:365-372` 的 `AND status = 'ACTIVE'` 思路 |
| **T8** | **分页 + JOIN 的行乘法** | `bindings` 摘要若直接 JOIN 进 list 主查询,`LIMIT/OFFSET` 会作用在**展开后的行**上,一个 5 邮箱的 share 就能吃掉 5 个名额。正解是两步:先分页取 share 行,再用一条 `WHERE share_id IN (SELECT value FROM json_each(?))` 批量取 bindings 在内存归并。`total` 也要改成真实 `COUNT(*)`(或窗口函数),不能继续用 `list.length` —— 分页后二者不等,而 `share-api.spec.js:191` 与 `mail-share-service.spec.js:333` 都在断言 `total` |
| **T9** | **D1 绑定参数 100 上限** | size 上限恰好 100,`IN (?,?,…)` 展开 100 个 shareId 再加任何一个参数就越界。用 `json_each(?)` 单参数传数组(`snapshotPredicate:276-287` 已有先例与注释),并考虑给 spec 加一条与 `:1984-2020` 同款的绑定参数预算用例(`bindSlots` helper 在 `:1482-1484` 现成) |
| **T10** | **`page/size` 入参本身要抗污染** | `size='abc'` / `size=0` / `size=-1` / `size=1e3` / `page=true` 都要有确定行为(建议:非安全整数或越界 → 钳到默认/上限,而不是抛错,以免前端传脏参数把整页打死)。仓内 `isRowId:107-109` 与 `toNullableCount:131-140` 的「布尔要显式挡掉」注释是同一类教训 |
| **T11** | **无参 deprecated 路径的 500 硬顶** | 无参 ≠ 分页,而是「不分页 + `LIMIT 500`」。若 Owner 有 600 条分享,无参调用只回 500 且 `total` 应如实反映被截断的语义(建议 `total` 给真实总数,并另给一个截断标记或直接在 exec note 里记下裁决)。这是 design.md:301 的原文约束,别自作主张改成 size=20 |
| **T12** | **`usedSessions` 是新增别名,不是改名** | D4/R1-A1 明写物理列名 `access_count` 不改、DTO 映射为 `usedSessions`。投影里**两个键并存**;删掉 `accessCount` 会直接打红 `mail-share-service.spec.js:340` 与 `share-api.spec.js:192` |
| **T13** | **`get` 详情不得回传任何凭据** | `sec_hmac` / `auth_key_hash` / `auth_key_kid` / `pepper_kid` 一概不出投影;`authKeyEnabled` 布尔可回(前端 AuthKey 区要显示状态)。spec 建议加一条 `JSON.stringify(detail)` 不含 `sec_hmac` 值的断言,与 `share-api.spec.js:195`、`:1005-1024`(AuthKey 不入日志)同族 |
| **T14** | **`status` 筛选参数的归属未定** | design.md:301 的 list 入参含 `status?`,但 tasks.md:359 的 T-15.1 清单**没有**列它,AC-ADMIN-01 里的筛选是前端列表页(T-20)的描述。若要在 T-15 实现,注意筛的是**计算态**四态而非存储态,SQL 侧得写 CASE(存储态只有 ACTIVE/REVOKED 两值),否则分页 `total` 与筛选结果对不上。**建议:T-15 先不实现,在 exec note 里显式标注留给 T-20 提出真实需求后再补** —— 但这属可裁决项,执行前应与主 AI 确认,别默默跳过 |
| **T15** | **「下次 Visitor 请求生效」是断言,不是自然结果** | AC-ADMIN-03 要求 update 后 Visitor 侧立刻读到新配置。读路径经 `share-auth-service` / `share-scoped-email-repository` 每次回源查库,天然满足;但 spec 必须**真的跑一次 Visitor 请求**来证明(而不是只查库),否则这条 AC 只是被「落库断言」冒充。可复用 `mail-share-service.spec.js:1500-1523` 的 `ownerJwt()` / `SELF.fetch` 模式建一个 `/share/session` → `/share/mails` 的最小闭环 |
| **T16** | **`message_limit` 目前只有写入侧,读侧消费在别处** | T-15 只负责「能改、且改动过栅栏」;`message_limit` 实际裁剪可见集的逻辑属读路径(T-10/T-11 域)。别在 update 里顺手做读侧验证,也别假设改完就有可观测的可见集变化 —— 用例应断言落库值与栅栏行为,而不是邮件条数 |

---

## 7. 执行前自检清单(给 T-15 执行者)

- [ ] `projectOwnerRow` 已补 `maxSessions`,`ACCESS_LIMIT_REACHED` 在 list/get 双侧可达
- [ ] `accessCount` 与 `usedSessions` 并存,三条 list 基线断言未被改写
- [ ] 无参 `list` 仍返回全量(≤500),前端 `request/mail-share.js:34` 不受影响
- [ ] `update` 用独立 patch 归一,「未传」与「传 null」可区分
- [ ] `update` 接了 **FINITE_MAX_SESSIONS 与 MESSAGE_LIMIT 两条**栅栏,且 `null` 放行
- [ ] `resetUsedSessions` 在**同一条 UPDATE** 里完成,判据取旧值
- [ ] `update` 的 SET 是显式白名单,`auth_key_*` 与 `credentials_version` 逐列不变(有断言)
- [ ] `delete` 三表进同一 batch,子表在前、经 `mail_share` 回查归属,`changes=0 → SHARE_NOT_FOUND`
- [ ] `get`/`delete` 能作用于 REVOKED/EXPIRED 行(未误用 `loadMutableShare`)
- [ ] 分页未用 JOIN 展开行,`total` 为真实计数,shareId 批量查询走 `json_each(?)`
- [ ] `security.js` 一字未动,exec note 已登记 3 条新端点待 T-17 收编
- [ ] 至少一条用例经真实 Visitor 请求证明「下次请求生效」

---

## 8. 参考锚点索引

```
契约   docs/specs/mailbox-share-capability/design.md:298-309(API 表)、:328(update 不碰 AuthKey)、:686/:693(R1-F2/R2-A5)
       docs/specs/mailbox-share-capability/requirements.md:155-164(AC-ADMIN-01..10)、:222(AC-EDGE-14)
       docs/specs/mailbox-share-capability/tasks.md:20-27(热区表)、:356-362(T-15)、:451-452(W3 并行说明)
服务   mail-worker/src/service/mail-share-service.js:19-25 / :65-70 / :107-140 / :168-185 / :266-287
       :307-340 / :342-361 / :365-389 / :600-621 / :701-710 / :743-814 / :817-895 / :897-936
路由   mail-worker/src/api/mail-share-api.js:6-44
权限   mail-worker/src/security/security.js:72-76 / :104(T-17 owns)
四态   mail-worker/src/service/share-auth-service.js:47-60(frozen)
DDL    mail-worker/src/init/init.js:41-51 / :63-76 / :141-181
实体   mail-worker/src/entity/mail-share.js:4-43
清理   mail-worker/src/service/mail-share-cleanup-service.js:10-28(T-18 owns)
种子   mail-worker/test/setup.js:75-116 / :122-132
用例   mail-worker/test/mail-share-service.spec.js:44-51 / :57-67 / :130-166 / :332-345 / :438-475
       :1331-1341 / :1400-1437 / :1478-1523 / :1984-2020
基线   mail-worker/test/share-api.spec.js:190-196 · share-integration.spec.js:671-676
前锋   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t12-note.md(第 5 条:MESSAGE_LIMIT 后门)
       .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t13-note.md(L1:share:manage 缺口)
```
