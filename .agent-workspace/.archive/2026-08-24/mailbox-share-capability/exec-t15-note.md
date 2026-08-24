# Exec Note · T-15 Owner API 扩展(get / update / delete + list 分页与新投影)

- **日期**:2026-08-24 · **分支**:`cursor/mailbox-share-capability-dcb6`
- **未 commit / 未 push / 未 stash**;`docs/specs/**`、`tasks.md`、`security.js`、`init.js`、`share-auth-service.js`、`share-api.js`、`email.js`、i18n、`mail-vue/**`、`tests/e2e/**`、`wrangler*.toml` 一字未动。
- **白名单内改动**(4 个文件,与派单一致):
  - `mail-worker/src/service/mail-share-service.js`(W3 本波次独占写者;create / updateBindings / revoke / revokeByAccountIds 的既有逻辑零改动)
  - `mail-worker/src/api/mail-share-api.js`(只加 `GET /mailShare/get`、`PUT /mailShare/update`、`DELETE /mailShare/delete` 三条;create/list/bindings/revoke 一字未动)
  - `mail-worker/test/mail-share-service.spec.js`(追加 T-15 用例;T-13 既有 164 条零改写,只扩了 `ownerJwt()` —— 见下「对既有 helper 的唯一改动」)
  - 本文件

## 红 / 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 基线 | `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` | **164 passed**(T-13 收口态) |
| 红(仅用例就位) | 同上 | **31 failed / 164 passed(195)**,EXIT=0(vitest 该配置不改退出码,以计数为准) |
| 绿 | 同上 | **195 passed(195)** |
| 全量 worker | `pnpm --dir mail-worker test --no-cache` | **18 files / 441 tests 全绿**(T-14 收口态 18/410) |
| 前端基线(未改动,仅确认没打坏 list 契约) | `pnpm --dir mail-vue test` | **17 files / 95 tests 全绿** |

红的 31 条按失败原因分三类,全部是行为缺失而非语法/装配错误:

- **21 条** `TypeError: default.get / default.update / default.delete is not a function`(三个入口尚不存在)
- **8 条** 投影/分页断言失败:`effectiveStatus` 拿不到 `maxSessions` 时 `st-capped` 回 `ACTIVE`(T2 缺陷的直接取证)、`page/size` 未被消费、无参转储回了 505 行而不是 500、`json_each` 不在 SQL 里
- **2 条** HTTP 面:三条新路由 404(响应体不是 JSON)

### 变异校验(证明新谓词不是摆设)

| 变异 | 结果 |
|---|---|
| `toOwnerRow` 去掉 `maxSessions: row.max_sessions` | **8 failed** —— T2 缺陷复现:`ACCESS_LIMIT_REACHED` 在 list/get 双侧同时不可达 |
| `projectOwnerRow` 只去掉响应里的 `maxSessions` 键(判定仍能拿到) | **4 failed**(纯投影断言;证明上一条的 8 条里确有 4 条钉的是判定而非回显) |
| 拿掉 update 的 `MESSAGE_LIMIT` 栅栏 | **1 failed** —— 后门用例 |
| `total: counted.total` 改回 `list.length` | **5 failed** |
| `access_count = CASE WHEN max_sessions IS NULL …` 改成无条件 `access_count = 0` | **2 failed**(纪元基线只建立一次 + AC-ADMIN-04 下调不清零) |
| 从 delete 的 batch 里删掉 binding 那条语句 | **3 failed**(孤儿) |

## 实现要点(评审请重点看这几条)

### ① 先修 `projectOwnerRow` 的假绿(内部顺序的第一步)

`effectiveStatus`(`share-auth-service.js:47-60`)判 `ACCESS_LIMIT_REACHED` 读的是 `row.maxSessions` / `row.accessCount`,而旧 `list` 组装的对象**根本没有 `maxSessions` 键** → `!= null` 恒假 → 这条分支在 T-15 之前不可达,AC-ADMIN-04/09 的第三态是假绿。

改法是把行装配抽成 `toOwnerRow(dbRow)`(snake→camel 单一真源),`SELECT` 列表抽成 `OWNER_ROW_COLUMNS`,list 与 get 共用。**先做这一步,后写用例** —— 否则会写出一批看着绿、其实验不到真值的断言。

### ② 四态筛选是 SQL CASE,不是内存过滤(T15-STATUS CHANGE)

存储态只有 `ACTIVE`/`REVOKED`(AC-LIFE-01),所以 `status?` 筛的必须是计算态。`OWNER_STATUS_CASE` 是 `effectiveStatus` 的 SQL 孪生:同一条优先级链、同一个 `now`、`expires_at` 与 `now` 同为 `YYYY-MM-DD HH:mm:ss` 故字典序比较与 JS 侧逐字一致,唯一绑定参数是 `now`。

`total` 走**同一条 CASE 的独立 `COUNT(*)`**,不是 `list.length`,也不是 `COUNT(*) OVER ()`:后者在越界页(空结果集)会拿不到总数。未知 `status` 值抛 `SHARE_INVALID_CONFIG` —— 静默忽略一个筛选参数比报错更危险。

### ③ 分页两步走,绝不 JOIN 展开

`bindings` 摘要若 JOIN 进主查询,`LIMIT/OFFSET` 会作用在展开后的行上,一个 5 邮箱的分享吃掉 5 个名额。正解:先分页取 share 行,再 `loadBindingSummaries()` 用一条 `WHERE share_id IN (SELECT value FROM json_each(?))` 批量取回内存归并。走 `json_each(?)` 而不是展开 `IN (?,?,…)` 是硬要求 —— `size` 上限恰是 100,而 D1 每条语句最多 100 个绑定参数,展开即越界。用例 `loads binding summaries through json_each and stays inside the D1 parameter budget` 在 size=100 下直接数占位符。

**无参路径保持 deprecated 全量转储**:`LIMIT 500`、不套默认 size、响应带 `deprecated: true`。前端 `mail-vue/src/request/mail-share.js:34` 至今 `http.get('/mailShare/list')` 不带参数,把 size=20 套上去会连带打红 `share-api.spec.js:190-196` 与 `share-integration.spec.js:671-676`。`total` 给真实总数,`total > list.length` 即被截断(没有另造截断标记)。

`page`/`size` 抗污染:非安全整数、`< 1`、布尔一律钳到默认/上限而不抛错(`size=200→100`、`size='abc'→20`、`size=1.5→20`、`page=true→1`),响应回显 `page`/`size` 让调用方能看见钳制结果。

### ④ update 用独立 patch 归一,不碰 `normalizeCreateBody`(T15-PATCH HOLD)

`normalizeCreateBody` 是 create 语义(缺省即 DDL 默认值),用在 patch 上会把 Owner 没提交的 `otpExtractionEnabled` 悄悄打回 1、把 `maxSessions` 悄悄清成 NULL;而且它的**字段顺序是幂等指纹的一部分**,也不能反过来改它。

新写的 `UPDATE_FIELDS` 白名单 8 项 + `normalizeUpdateBody`:

- 在场判据是 `Object.prototype.hasOwnProperty`,不是真值判断 —— 「键不存在 = 不改」与「键存在且为 `null` = 清空」严格可区分。
- SET 子句**只从白名单表生成**,禁止 `Object.keys(patch)` 拼 SQL。`lid` / `sec_hmac` / `pepper_kid` / `expires_at` / `delete_at` / `status` / `user_id` / `account_id` / `window_start_email_id` / `only_messages_after_created` / `auth_key_*` / `credentials_version` / `access_count` 全部天然挡在外面,用例逐列断言前后不变。
- flag 的 patch 归一是**严格**版(`toPatchFlag`):present-null / `''` / `2` / `'yes'` 一律 `SHARE_INVALID_CONFIG`,不像 create 侧回落默认值 —— patch 里给一个布尔列传 null 是客户端 bug,不该被解释成「不改」。
- `onlyMessagesAfterCreated` **不在**白名单:改它会让主表与 Binding 的 `window_start_email_id` 与新口径失配,而重算窗口是 create/bindings 两条写入口的语义。因此 T-15 **不调用** `syncPrimaryAccountId`。

### ⑤ update 侧接了**两条**栅栏(T15-V2 CHANGE)

```
maxSessions 被设为有限值  → assertCapabilityV2(FINITE_MAX_SESSIONS)
messageLimit 被设为有限值 → assertCapabilityV2(MESSAGE_LIMIT)
```

tasks.md:361 只写了 `maxSessions`,那是任务书疏漏。`exec-t12-note.md` 第 5 条点名:少接 `MESSAGE_LIMIT` 就是绕过栅栏写 `message_limit` 的后门(旧 Worker 不认识该列,落库即可见集被放宽到窗口内全部邮件,属可见性放大)。

触发条件是「设为有限值」不是「键出现在 patch 里」:显式 `null`(取消限制)旧 Worker 语义完全兼容,**放行**,与 create 侧 `:334/:337` 同款。顺序仍是**值域 → 栅栏**(值域在 `normalizeUpdateBody` 里逐字段抛出,栅栏在其后的 `assertUpdatePatch`)。update 白名单里恰好且只有这两条 intent —— AuthKey 归 `resetAuthKey` 单入口(T-16),`accountIds` 归 bindings。

### ⑥ `resetUsedSessions` 在同一条 UPDATE 里,判据取旧值(AC-EDGE-14)

```sql
SET max_sessions = ?, …, access_count = CASE WHEN max_sessions IS NULL THEN 0 ELSE access_count END
```

SQLite 单条 UPDATE 的所有 SET 表达式都读**更新前**的行值,所以 `max_sessions IS NULL` 恒指旧值,与 SET 子句先后顺序无关 —— 不需要先 SELECT 再判(那就是一次先读后写)。`resetUsedSessions` 的真假在 JS 侧就折进「这条 CASE 加不加」,SQL 里不再多占一个绑定参数。

- NULL→有限值 + 缺省 → `access_count = 0`;显式 `false` → 保留计数,可能立即 `ACCESS_LIMIT_REACHED`(Owner 显式选择,原样接受)。
- 旧值已是有限值 → 无论传什么都不重置(纪元基线只建立一次)。
- 下调 `maxSessions ≤ usedSessions`(AC-ADMIN-04)**接受**,不校验成错误,态由 `effectiveStatus` 实时算出。

### ⑦ get / delete 用比 revoke 更宽的可见范围

- `loadOwnerDetail` 谓词只有 `share_id + user_id`,**不带** status / expires_at:AC-ADMIN-09 要求 EXPIRED / REVOKED / ACCESS_LIMIT_REACHED 行仍可读可审计。
- `delete` 同理 —— 删的往往正是已撤销/已过期的行,套上 `prepareRevoke` 的 `AND status='ACTIVE'` 思路就删不掉了。
- `update` 反过来仍用 `loadMutableShare`(ACTIVE + 未过期),与 `updateBindings` 同一把锁:改配置只对活分享有意义。
- 三者的他人 / 不存在 / 形状非法一律 `SHARE_NOT_FOUND`,不新增可区分错误码(存在性探针封闭)。`toShareId()` 显式挡掉布尔:`Number(true) === 1` 会把 `shareId: true` 变成一次对 `share_id=1` 的越权探测。

### ⑧ delete 的级联全靠手写,子表在前

`mail_share_binding`(`init.js:64-71`)与 `share_idempotency`(`:162-172`)都**没有 FOREIGN KEY**,D1 也不开 `ON DELETE CASCADE`。三条 DELETE 进同一个 `c.env.db.batch()`,顺序是 **binding → idempotency → mail_share**:子表的归属谓词要经 `mail_share` 回查 `user_id`,主表行一旦先删归属判据就消失了。主表 `changes = 0 → SHARE_NOT_FOUND`。用例断言 `batchCount() === 1` 且三张表零残留;跨用户 shareId 则三张表逐一验证「一行未动」。

### 对既有 helper 的唯一改动

`ownerJwt()`(T-13 加的)补了 perm 37 / role 98 / role_perm 的 `INSERT OR IGNORE` 并把 user 的 `type` 设成 98。原因:`/mailShare/list` 已在 `security.js:74` 的 `requirePermsExact` 里,HTTP 分页用例的 Owner 必须真的持有 `share:manage`,否则拿到的是 `SHARE_FORBIDDEN`。这是**放宽**而非收紧,T-13 的 HTTP 用例不受影响(已复跑)。三条新端点目前不在那张表里,所以它们的 HTTP 用例本来就不需要这个授权 —— 这恰恰是下面 L1 的取证。

## 遗留风险

| # | 风险 | 说明 |
|---|---|---|
| **L1** | **🔴 `share:manage` 现在缺 4 条端点(归 T-17,上线前必补)** | `security.js:72-76` 的 `requirePermsExact` 与 `:104` 的 `premKey['share:manage']` 至今只登记 `create / list / revoke` **3 条**。T-13 加的 `PUT /mailShare/bindings` 已经缺了一条,T-15 再加 3 条,合计 **4 条端点只被 JWT 兜住、没有 `share:manage` 精确匹配**:`PUT /mailShare/bindings`(T-13)、`GET /mailShare/get`、`PUT /mailShare/update`、`DELETE /mailShare/delete`(T-15)。**数据面不越权**(service 的资源谓词恒带 `user_id`,他人 shareId 一律 `SHARE_NOT_FOUND`,已有用例);破的是**路由级权限语义**(AC-ADMIN-10)。T-17.2 的 8 条清单请照这四条路径名核对:`/mailShare/create`、`/mailShare/list`、`/mailShare/revoke`、`/mailShare/get`、`/mailShare/update`、`/mailShare/bindings`、`/mailShare/delete`、`/mailShare/resetAuthKey`(最后一条待 T-16 落地)。 |
| L2 | `list` 的 `deprecated: true` 与截断语义没有 spec 出处 | design.md:301 只写「无参全量兼容期保留但标注 deprecated,硬上限 500」,没规定怎么在响应里表达。当前口径:`total` 给真实总数(`total > list.length` 即被截断)+ 响应加 `deprecated: true`。需要一个 spec 同步动作确认,或在 T-20 接入时改成显式 `truncated` 字段。 |
| L3 | `status` 筛选的入参归属仍是 T-15 自裁 | tasks.md:359 的 T-15.1 清单没列 `status?`(recon T14 标为待裁决),本轮按主 AI 的 **T15-STATUS CHANGE** 实现为计算态筛选。若 T-20 提出的真实需求是「多选」或「包含已删」,SQL CASE 的形状要重来一次。 |
| L4 | `OWNER_STATUS_CASE` 与 `effectiveStatus` 是两份手写实现 | 一份在 JS(`share-auth-service.js:47-60`,W1 冻结,只读不改)、一份在 SQL(本文件)。两条链现在逐字一致并有四态用例双侧钉住,但**没有机制**保证将来同步。若 W1 之后要给四态加第五态,必须同时改这两处。 |
| L5 | `update` 的 patch flag 比 create 严格 | create 侧 `toFlag(value, fallback)` 把 `''`/`null` 当「没传」回落默认;update 侧 `toPatchFlag` 对同样的值抛 `SHARE_INVALID_CONFIG`。语义上是对的(patch 里显式传 null 给非空列是客户端 bug),但两个入口对同一个字段的容错口径不同,T-20/T-21 写表单时要注意别把空输入直接塞进 patch。 |
| L6 | `list` 从 1 条查询变成 3 条 | COUNT + 分页行 + binding 摘要。无参转储在 500 行满载时是 500 行 × 摘要一次批量查询,没有 N+1,但请求数确实从 1 涨到 3。D1 无事务读一致性要求,COUNT 与行集之间的极窄窗口内新建一条分享会让 `total` 比页面多 1,属可接受的分页常态。 |
| L7 | `update` 不查 `SHARE_DISABLED` | 与 `revoke`/`updateBindings` 一致。AC-ABUSE-03/AC-LIFE-13 的语义是「冻结期禁止新建、存量保持」,把管理面也冻上会让 Owner 在冻结期连改配置都做不了。recon §2.5 同结论,若要改属独立裁决。 |
| L8 | `delete` 只清 `mail_share` / `mail_share_binding` / `share_idempotency` 三张表 | 没有第四张关联表(已核 `init.js`)。KV 里的 `share:est:<lid>:<key>` 重放缓存不清 —— 它最长 120s 自然过期,且缓存 token 的 `cv` 回源时行已不存在,`resolveSession` 直接 `SHARE_UNAVAILABLE`。不构成越权,但删除后 120s 内 KV 里确实还留着一条无主记录。 |
| L9 | `update` 的并发窗口 | `loadMutableShare` 预检与 UPDATE 之间被并发 revoke/过期赶上时,UPDATE 自带同款谓词故零变更,翻译成 `SHARE_NOT_FOUND`。不做 CAS(T-13 的 `SHARE_BINDING_CONFLICT` 是因为 Binding 集合是命令的前置条件;配置 patch 是最后写入者获胜的字段级覆盖,没有集合语义要保护)。 |
