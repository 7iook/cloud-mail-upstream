# Recon · T-18 级联撤销经 Binding JOIN + cleanup 清理守恒

| 字段 | 值 |
|---|---|
| 范围 Scope | T-18 / T-18.1 / T-18.2(W3 收尾棒),`docs/specs/mailbox-share-capability/tasks.md:428-432` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`,HEAD `33ad281`(含 T-17 `d18f027`);工作树无生产代码改动 |
| 侦察日期 | 2026-08-24 |
| 依据 AC | AC-BIND-05 / AC-BIND-06 / AC-BIND-10 / AC-LIFE-06 / AC-LIFE-09(旁及 AC-LIFE-10、AC-BIND-11) |
| 热区状态 | `mail-share-service.js` 空闲(T-16 `3bb1d55` 已收口,T-17 只动 `security.js`),T-18 是该文件的下一个单写者 |
| 性质 | 只读侦察。**未改任何文件、未提交**;本文件是唯一产物 |

**任务书行号已漂移**,执行者按实际行号定位:tasks.md 写 `mail-share-service.js:394-415`,实际 `revokeByAccountId/revokeByAccountIds` 在 `:1360-1381`(文件 1384 行);tasks.md 写 `mail-share-cleanup-service.js:20-28`,实际 `cleanupExpired` 在 `:10-28`、两条 DELETE 在 `:26-27`。

---

## 0. 一句话结论

现有级联是**纯主表 `account_id` 直查**(`:1379`),它同时犯了「误撤销」和「漏撤销」两个方向的错:删主 Binding 的邮箱会把还有存活邮箱的多邮箱分享整条撤掉(违 AC-BIND-05),删非主 Binding 的邮箱则**零变更**、留下永不回收的孤儿 Binding、分享删光邮箱后仍停在 ACTIVE(违 AC-BIND-06)。T-18 的真正难点不在写 JOIN,而在三条守恒边界:

① **撤销谓词必须自带「受影响集合」范围**——`NOT EXISTS(binding) → REVOKED` 这种全局写法会顺手撤掉**合法的无 Binding 遗留行**(R3-A2 明写这类行要保持 ACTIVE 等回填收编,`share-auth-service.js:310-318` 还专门为它留了影子 Binding 路径);
② **「替换主表直查」不能读成「删掉主表判据」**——无 Binding 的遗留形状今天只靠主表这一条路径才撤得掉,纯 JOIN 会把它漏成永久 ACTIVE,必须保留回落臂;
③ **cleanup 的孤儿补偿臂会全局扫表**,而 `mail-share-cleanup.spec.js` 现有种子(`user_id=1/account_id=1`、无 account 行)天生就是「非法 Binding」——红灯用例若沿用这套种子造 Binding,会被补偿臂顺手删掉,于是「到期同批删」这条断言**为错误的原因变绿**。

三条 SQL 都能做到**零预读、绑定参数与 accountId 数量无关**(`json_each(?)`),这也是 `physicsDeleteByUserIds` 传入 >100 个 accountId 时不炸 D1 参数上限的前提。

---

## 1. 问题直答(五问)

| # | 问题 | 结论 | 详见 |
|---|---|---|---|
| 1 | 现有撤销按主表还是 Binding? | **纯主表 `account_id`**,且带 `status='ACTIVE'`。后果是双向错:误撤销 + 漏撤销 + 孤儿永存 + 双写失配 | §2 |
| 2 | 改哪些函数 / SQL 形状 / 是否复用 `BINDING_CASCADE` | 只改 `revokeByAccountIds` 一个函数体(`revokeByAccountId` 是它的单参包装,一字不动);三语句同批,顺序 **撤销 → 重指主表 → 删 Binding**;全部走 `json_each(?)`;`SHARE_EVENT.BINDING_CASCADE` **必须复用**(它是六事件封闭清单里唯一还没有生产调用点的那条,T-18.2 明写要打) | §3 |
| 3 | cleanup 现删什么、缺什么 | 现只删 `share_idempotency` + 到期 `mail_share` 两表,**完全不碰 `mail_share_binding`**;缺「到期同批删 binding」与「孤儿补偿」两臂,且两条 DELETE 不在同一个 batch 里 | §4 |
| 4 | account-service 挂钩要不要改签名 | **不改,`account-service.js` 目标改动量为 0 行**。`:159` / `:184` / `:250` 三处调用与两个方法签名全部保持;返回值只允许**加字段**,不允许改形状 | §5 |
| 5 | 红测清单与禁改文件 | 两个 spec 扩展共 ~14 条;禁改 `security.js` / `init.js` / `share-auth-service.js` / `wrangler*.toml` / `account-service.js` / `mail-share-api.js` | §6 §7 |

---

## 2. 现状:级联走的是主表,而且两个方向都错

### 2.1 现有代码路径

```
account-service.js:159  delete()                 → revokeByAccountId(c, accountId)      → 软删前调用
account-service.js:184  physicsDeleteByUserIds() → revokeByAccountIds(c, [...all ids])  → 硬删前调用
account-service.js:250  physicsDelete()          → revokeByAccountId(c, accountId)      → 硬删前调用
                                                        ↓
mail-share-service.js:1360-1362  revokeByAccountId  = revokeByAccountIds(c, [accountId])
mail-share-service.js:1364-1381  revokeByAccountIds:
    · 入参归一:Number + Number.isInteger + >0 + Set 去重(:1365-1374)
    · 空集合早退 { revoked: 0 }(:1375-1377)
    · placeholders 展开 → applyRevoke(c, `account_id IN (?, ?, …)`, ids)(:1378-1379)
                                                        ↓
mail-share-service.js:460-471  prepareRevoke/applyRevoke:
    UPDATE mail_share SET status='REVOKED', revoked_at=? WHERE <whereSql> AND status='ACTIVE' RETURNING share_id
```

**`mail_share_binding` 在这条链上一次都没出现。** `idx_msb_account`(`init.js:75`)这个索引的注释写着「级联撤销反查」,建了 4 个波次,至今零消费者。

### 2.2 漏掉 Binding 的具体后果(逐条,附受影响 AC)

| # | 场景 | 今天实际发生什么 | 违反 |
|---|---|---|---|
| **C1** | 多邮箱分享 `{A,B}`,删**主** Binding 的邮箱 A(`mail_share.account_id = A`) | 整条分享被置 REVOKED,B 还活着。访客侧 `resolveSession` 直接 `SHARE_UNAVAILABLE`,B 的邮件一封也看不到 | **AC-BIND-05**(用户点名的「误撤销仍有其它存活邮箱的分享」) |
| **C2** | 多邮箱分享 `{A,B}`,删**非主** Binding 的邮箱 B | `account_id IN (B)` 零匹配 → `changes=0` → **什么都没发生**。B 的 Binding 行留在表里成孤儿 | AC-BIND-05 后半(剔除 Binding)、AC-LIFE-09 |
| **C3** | 接着 C2 再删 A | A 匹配主表 → 分享被撤销;但 B 的孤儿 Binding **仍在表里**,永远没有回收路径 | AC-BIND-10 尾句、AC-LIFE-06 |
| **C4** | 多邮箱分享 `{A,B}`,只删 B,再删 A **之外**的路径(如 Owner 用 `updateBindings` 删掉 A) | `prepareBindingDelete` 的删空转撤销谓词是 `NOT EXISTS(binding)`,而 B 的孤儿行还在 → **谓词不成立 → 分享停在 ACTIVE 且零存活邮箱** | **AC-BIND-06** |
| **C5** | 任一孤儿残留态下的 Owner 面 | `loadBindingSummaries:496-508` 的 `LEFT JOIN account` 对已硬删账号给出 `mailbox: ''` → 列表里出现一个空地址绑定;`shareTypeOf` 把它算进 `multi`;`SHARE_ACTIVE_LIMIT` 的活跃计数也仍占名额 | AC-ADMIN-01/09 的真值 |
| **C6** | 主表双写失配 | C2 之后 `mail_share.account_id` 若指向被删账号(C1 撤销掉了所以不显)…… 更准确说:C2 里主表指向 A 无恙;但一旦孤儿是主 Binding(硬删 A 而 T-18 未重指),主表 `account_id` 会指向不存在的 account,**Expand 窗口内的旧 Worker 读主表即判不可用**,新旧 Worker 行为分叉 | **AC-LIFE-10** |
| **C7** | 合法的**无 Binding** 遗留行(R3-A2 迁移窗口晚写行,`init.js:93-106` 尚未收编)其 account 被删 | 今天靠主表直查恰好能撤销。**如果 T-18 改成纯 Binding JOIN,这条路径就断了**,该行永久停在 ACTIVE | 新增回归风险,见 §3.3 |

**不是**后果的两条(别在用例里写反):
- **不是可见性泄漏**。`share-auth-service.js:303-341` 的 `loadLiveBindings` 每次回源都按 `is_del`/存在性过滤活账号,全死则 `throwUnavailable`。所以 C2/C3/C4 的残留是**状态面错误**(status/计数/投影/旧 Worker 分叉),不是数据越权。用例断言要落在 `mail_share.status`、binding 行数、`account_id` 上,不要写成「访客能读到已删邮箱的邮件」——那条本来就是绿的。
- **不是 Owner 主动删除的问题**。`delete()`(`:1236-1262`)三表同批已经零孤儿(T-15 已绿),两条路径互不覆盖。

---

## 3. T-18.2 · 级联侧:改什么、SQL 长什么样

### 3.1 改动面(只有一个函数体)

| 符号 | 位置 | 动作 |
|---|---|---|
| `revokeByAccountIds` | `:1364-1381` | **函数体重写**:入参归一(`:1365-1377`)一字不动;把 `placeholders + applyRevoke` 换成三语句 `c.env.db.batch()`;末尾补 `logShareEvent(SHARE_EVENT.BINDING_CASCADE, …)` |
| `revokeByAccountId` | `:1360-1362` | **不动**(单参包装) |
| `prepareRevoke` | `:460-467` | **不动**,但**要复用**:注释已把它钉为「撤销谓词的唯一真源:revoke / 级联 / T-13 删空转撤销共用」。级联的撤销语句应当继续经它生成,而不是另写一条 `UPDATE mail_share SET status='REVOKED'` |
| `syncPrimaryAccountId` | `:737-758` | **不动**(create `:802` 与 updateBindings `:1167` 两个调用点已冻结)。级联需要的是「排除将死账号」的变体,另起一个私有 helper,见 §3.2-② |
| 新增私有 helper | 建议紧邻 `syncPrimaryAccountId` 之后 | `prepareCascadeResync(c, idsJson)` / `prepareCascadeBindingDelete(c, idsJson)`;与仓内既有 `prepare*` 命名一致,**返回未执行语句** |

### 3.2 SQL 形状:三语句同批,顺序即语义

`ids = JSON.stringify(归一化后的 accountId 数组)`,全程只当**一个**绑定参数用。

**① 撤销「受影响且无幸存者」的分享**(必须排在 DELETE 之前,它要读将死的 Binding 行):

```sql
-- 经 prepareRevoke(c, whereSql, [ids, ids, ids]) 生成,自动补 `AND status='ACTIVE'` 与 RETURNING share_id
   (
     EXISTS (SELECT 1 FROM mail_share_binding b
             WHERE b.share_id = mail_share.share_id
               AND b.account_id IN (SELECT value FROM json_each(?)))       -- 受影响:有将死 Binding
     OR (
       NOT EXISTS (SELECT 1 FROM mail_share_binding b WHERE b.share_id = mail_share.share_id)
       AND mail_share.account_id IN (SELECT value FROM json_each(?))       -- 回落臂:无 Binding 的遗留形状(见 §3.3)
     )
   )
   AND NOT EXISTS (SELECT 1 FROM mail_share_binding b
                   WHERE b.share_id = mail_share.share_id
                     AND b.account_id NOT IN (SELECT value FROM json_each(?)))  -- 无幸存者
```

**② 主表重指(AC-LIFE-10 双写),同样排在 DELETE 之前,靠「排除将死集合」拿到幸存主 Binding**:

```sql
UPDATE mail_share
SET account_id = (SELECT b.account_id FROM mail_share_binding b
                  WHERE b.share_id = mail_share.share_id AND b.account_id > 0
                    AND b.account_id NOT IN (SELECT value FROM json_each(?))
                  ORDER BY b.binding_id ASC LIMIT 1),
    window_start_email_id = (SELECT b.window_start_email_id FROM mail_share_binding b
                  WHERE b.share_id = mail_share.share_id AND b.account_id > 0
                    AND b.account_id NOT IN (SELECT value FROM json_each(?))
                  ORDER BY b.binding_id ASC LIMIT 1)
WHERE mail_share.account_id IN (SELECT value FROM json_each(?))              -- 只有「主 Binding 将死」的分享需要重指
  AND EXISTS (SELECT 1 FROM mail_share_binding b
              WHERE b.share_id = mail_share.share_id AND b.account_id > 0
                AND b.account_id NOT IN (SELECT value FROM json_each(?)))    -- 有幸存者才写,绝不写 0/NULL
```

**③ 剔除 Binding(最后一条,前两条都依赖它删之前的状态)**:

```sql
DELETE FROM mail_share_binding
WHERE account_id IN (SELECT value FROM json_each(?))
RETURNING share_id, account_id
```

**为什么是这个顺序**:①②读「将死 Binding 还在」的事实,③销毁这个事实。①与②的谓词互斥(无幸存者 / 有幸存者),彼此顺序无所谓。D1 的 `batch()` 顺序执行且是一个事务(`create`/`updateBindings` 已依赖这一点),所以三条要么全成要么全不成。

**为什么全用 `json_each(?)` 而不是展开 `IN (?,?,…)`**:
- `physicsDeleteByUserIds`(`account-service.js:182-184`)把一个用户**全部** account 行的 id 原样传进来,无去重上限。用户有 101 个邮箱,今天的 `placeholders` 展开就撞上 D1 单语句 100 个绑定参数的硬顶。
- 更要命的是集合在①里出现 3 次、②里出现 4 次 —— 展开写法是 `3N`/`4N`,N=26 就越界。`json_each(?)` 每次出现只算 1 个参数,合计恒为 4 / 4 / 1。
- 仓内已有先例与注释:`snapshotPredicate:300-313`、`loadBindingSummaries:489-490`。

**RETURNING 是免费的可观测数据源**:①返回被撤销的 share_id,③返回被剔除的 `(share_id, account_id)`。`create` 已经在 batch 里读 RETURNING(`:809-811`),形式成立,不需要任何预读 SELECT。

### 3.3 🔴 两条不能省的谓词(本次侦察最重要的两条)

**(A) 撤销必须带「受影响」范围,不能只写 `NOT EXISTS(binding)`。**
一条 `UPDATE mail_share SET REVOKED WHERE status='ACTIVE' AND NOT EXISTS(binding)` 看起来很干净,实际会**在每次删任意一个邮箱时,顺手撤掉全库所有零 Binding 的 ACTIVE 分享**。这类行是规格明确要求保留的:
- R3-A2 / AC-BIND-11:迁移窗口内旧 Worker 在回填 INSERT 之后写的合法行「虽暂无 Binding,SHALL NOT 被置 REVOKED,SHALL 由发布收尾重跑幂等回填收编」;`v3-2-db.spec.js:310-327` 正是这条的用例。
- `share-auth-service.js:300-318` 专门给这类行留了「影子 Binding `bindingId:0`」读路径,证明它是**运行时合法形状**,不是脏数据。

**(B) 「替换主表 account_id 直查」不等于「删掉主表判据」。**
AC-LIFE-09 的括注是「替换 `mail-share-service.js:394-415` 的主表 `account_id` 直查」,字面读会得到纯 JOIN。但纯 JOIN 会让 §2.2-C7 那类**无 Binding 的合法 ACTIVE 行**在其 account 被删后永久停在 ACTIVE —— 今天它是撤得掉的,改完反而回归。

> **建议裁决(交主 AI)**:采用 §3.2-① 的**双臂**写法 —— Binding 为主、`NOT EXISTS(binding)` 时回落主表。理由:补的是「无 Binding 时」这一互斥分支,不是把主表直查留成第二真源;两臂互斥,不可能重复撤销;删掉它就等于用一条新回归换一条 AC 的字面整洁。若主 AI 裁定严格按字面只留 JOIN 臂,必须同时在 exec note 里登记「无 Binding 遗留行的 account 删除不再撤销」这条已知缺口,并给 cleanup 补一条对应补偿臂。

### 3.4 事件日志:复用 `SHARE_EVENT.BINDING_CASCADE`,不新造名字

- 事件名清单是**封闭**的,`mail-share-service.spec.js:1332-1341` 用 `toEqual` 钉死了六条。`BINDING_CASCADE`(`:44`)是其中**唯一至今零生产调用点**的一条(grep 全仓:只有定义与两处测试),T-18.2 就是它的接线任务。
- 建议粒度:**每个受影响 share 一行**(不是每个 binding 一行)。`physicsDeleteByUserIds` 可能一次剔除上百条 Binding,逐条打会把日志打爆;而 `logShareEvent` 的信封恒带 `shareId`(`:86-96`),per-share 正好填满它。
- 字段建议:`{ shareId, reason: 'account_deleted', removedBindings: n, revoked: true|false }`。**禁止**放 email 地址(PII)、`sec`/`authKey`(凭据);`accountId` 属内部行号,可放但非必需。
- `logShareEvent` 的 canonical 字段不可被覆盖(`:88-95` 与 spec `:1372-1387` 已钉),别传 `event`/`ts`。
- cleanup 的孤儿补偿臂同样打这条事件(design.md:456 原文「含孤儿补偿」),`reason` 用不同值区分(如 `'orphan_sweep'` / `'share_expired'`)。

### 3.5 返回值

现在是 `{ revoked: n }`,**全仓零断言**(`grep revokeByAccountId mail-worker/test` 无结果),三个调用点也都不消费。可以安全**追加**字段:`{ revoked, unbound }`(unbound = 被剔除的 Binding 行数)。**不要改 `revoked` 的含义**——它今天是「被置 REVOKED 的分享数」,新实现里应继续取①的 `changes`,而不是变成「受影响分享数」。

---

## 4. T-18.2 · cleanup 侧:现删什么、缺什么、怎么写才守恒

### 4.1 现状(`mail-share-cleanup-service.js:10-28`)

| 步骤 | 语句 | 备注 |
|---|---|---|
| 预读 | `SELECT share_id FROM mail_share WHERE delete_at <= now` | JS 侧收集 `dueShareIds` |
| 删 1 | `DELETE FROM share_idempotency WHERE created_at < cutoff OR share_id IN (dueShareIds)` | drizzle `inArray` **展开占位符** → 到期分享一多就撞 D1 参数上限 |
| 删 2 | `DELETE FROM mail_share WHERE delete_at <= now` | |

**缺的三项**:
1. **`mail_share_binding` 一条都不删** → 每条到期分享的 Binding 行在主表行消失后全部成为孤儿,永久累积。直接违反 AC-LIFE-06。
2. **孤儿补偿臂完全不存在** → AC-BIND-10 尾句(「WHEN account 删除与 Binding 写入并发仍产生孤儿 Binding,THE 级联与定时清理路径 SHALL 补偿剔除之」)无实现。**现成的真实孤儿源**:`init.js:111+` 的 `revokeInvalidShares` 只把行置 REVOKED,**不删已回填的 Binding**(`review-t01.md:102` 已点名,`v3-2-db.spec.js:350-365` 就是这个场景),这类行今天没有任何回收路径。
3. **两条 DELETE 不在同一个 batch 里**(两次独立 `await`)。AC-LIFE-06 原文是「在删除到期 `mail_share` 行的**同一批次**删除其全部 `mail_share_binding` 行」。

### 4.2 目标形状:单个 `c.env.db.batch()`,主表恒在最后

```sql
-- ① 到期分享的 Binding(必须早于主表 DELETE,否则子查询查不到 share_id → 全成孤儿)
DELETE FROM mail_share_binding
WHERE share_id IN (SELECT share_id FROM mail_share WHERE delete_at <= ?);

-- ② 孤儿补偿前置:先撤销「有 Binding 但一条活的都不剩」的分享(必须早于 ③,它要读将被删的行)
UPDATE mail_share SET status='REVOKED', revoked_at = ?
WHERE status='ACTIVE'
  AND EXISTS (SELECT 1 FROM mail_share_binding b WHERE b.share_id = mail_share.share_id)   -- ★ 无 Binding 的遗留形状不归本臂管
  AND NOT EXISTS (
    SELECT 1 FROM mail_share_binding b
    JOIN account a ON a.account_id = b.account_id AND a.is_del = 0 AND a.user_id = mail_share.user_id
    WHERE b.share_id = mail_share.share_id)
RETURNING share_id;

-- ③ 孤儿补偿本体:一条语句覆盖「share 行不存在」与「account 不存在/已删/归属不符」两类
DELETE FROM mail_share_binding
WHERE NOT EXISTS (
  SELECT 1 FROM mail_share ms
  JOIN account a ON a.account_id = mail_share_binding.account_id
                AND a.is_del = 0 AND a.user_id = ms.user_id
  WHERE ms.share_id = mail_share_binding.share_id)
RETURNING share_id, account_id;

-- ④ 幂等行(把 JS 侧 dueShareIds 预读换成相关子查询,顺带消掉 inArray 的参数上限风险)
DELETE FROM share_idempotency
WHERE created_at < ? OR share_id IN (SELECT share_id FROM mail_share WHERE delete_at <= ?);

-- ⑤ 主表,恒最后
DELETE FROM mail_share WHERE delete_at <= ?;
```

**守恒论证**(建议原样写进实现注释):
- ③的谓词与 `v3-2-db.spec.js:66-77` 的 `illegalBindingCount()` **逐字同源**(存在 + `is_del=NORMAL` + `user_id` 匹配),也与 `prepareBindingInsert:675-676` 的 JOIN 门禁、`init.js:98-100` 的回填门禁同源。**同一条合法性判据在写入、迁移、清理三处共用,才叫守恒**;各写各的必然漂移。
- ③天然覆盖「share 行已被删」的情形(内层 `ms` 不存在 → NOT EXISTS 成立),所以不需要单独的「悬空 share_id」臂。
- ①→⑤ 的相对顺序是**硬约束**:①和④的子查询要在主表行还在的时候求值;②要在③之前;③在④⑤之前或之后都行,但放在主表 DELETE 之前语义更直白。参照 `delete()` 的「子表在前、主表在后」(`:1231-1257`)与 `prepareBindingDelete` 的同款注释。
- ②的 `EXISTS(任意 Binding)` 那一行**不可省**,理由同 §3.3-(A);少了它,现有用例里的 `t12-keep-expired`(零 Binding 的 ACTIVE 行)会被清理任务撤掉。

> **建议裁决(交主 AI)**:②这条「孤儿补偿顺带撤销」是**新行为**,AC-BIND-10 尾句字面只要求「剔除孤儿」。建议保留,否则补偿完会留下「ACTIVE + 有 Binding 记录 + 零活邮箱」这种既占 `SHARE_ACTIVE_LIMIT` 名额、Owner 面又显示为 ACTIVE 的僵尸行,与用户给定的成功态「剩 0 则 REVOKED」直接冲突。若裁定不做,则③之后必须在 exec note 登记该僵尸态。

### 4.3 cleanup 的上下文约束

- 入口是 `index.js:39` 的 `mailShareCleanupService.cleanupExpired({ env })` —— **`c` 只有 `env`,没有 `c.get` / `c.req`**。别在新代码里用 `isShareDisabled(c)`(它读 `c.get('setting')`)或 `publicOrigin(c)`。`c.env.db.prepare` 与 `nowText()` 同款 `dayjs` 格式化都可用。
- 现有文件是 drizzle 风格(`orm(c).delete(...)`)。跨表条件与 `RETURNING` 用 drizzle 表达笨重,建议本函数整体改写为原生 SQL + 单 batch;仓内两种风格混用是既有惯例(`mail-share-service.js` 全原生)。
- `IDEMPOTENCY_TTL_HOURS = 24` 与 `delete_at` 的 `<=` 语义保持不变,别顺手改成 `<`,`mail-share-cleanup.spec.js:52-82` 的 `-25h` / `-23h` / `-1h` 边界依赖它。

---

## 5. account-service 挂钩:签名与调用点均**零改动**

tasks.md:431 要求 `:159,184,250` 保持调用不变,侦察结论是**完全可行且应当如此**——三处只需要「传入将死的 accountId 集合」,而这正是现签名给的东西。

| 位置 | 调用 | T-18 后是否需要改 | 备注 |
|---|---|---|---|
| `account-service.js:159` | `revokeByAccountId(c, accountId)`(软删) | 否 | 调用发生在 `is_del=DELETE` 落库**之前** |
| `account-service.js:184` | `revokeByAccountIds(c, rows.map(r => r.accountId))`(随用户硬删) | 否 | 传的是该用户**全部** account 行,含已软删的;集合可能很大 → §3.2 的 `json_each` 是刚需 |
| `account-service.js:250` | `revokeByAccountId(c, accountId)`(单账号硬删) | 否 | 调用发生在删 email 与 account 行**之前** |

**三条必须写进实现注释的时序事实**:
1. **级联恒在 account 行仍存活/仍 NORMAL 时执行**。所以级联 SQL **绝不能**用「account 已删」当判据(例如 JOIN `account WHERE is_del = DELETE`)—— 那会在这三个调用点上**恒零命中**,静默变成空操作。判据只能是「accountId ∈ 传入集合」。这是最容易写错、且单测里很难一眼看出的一条。
2. **没有跨 service 的事务**(D1 无 `.transaction()`)。级联 batch 与随后的 account 删除是两笔独立提交。中间崩溃 → 分享已撤销而邮箱还在(fail-closed,可接受);反向不会发生,因为级联在前。保持这个顺序,别为了「先删账号再清理」而调换。
3. **级联抛错会让整个账号删除失败**(三处都是裸 `await`,无 try/catch)。保持这个 fail-closed 语义,**不要**给级联加 `catch` 吞掉异常——吞了就变成「账号删了、分享还活着」。

`revokeByAccountIds` 的返回值可加字段但不可改形状(§3.5)。

---

## 6. T-18.1 红灯清单

### 6.1 `mail-worker/test/account-delete-share.spec.js`(现 265 行,5 条用例,全是单邮箱)

**先要补的基建**(现有 helper 不够,这三条不补,后面的用例写不出来):
- **V2 上下文**:`shareEnv()`(`:23-38`)**没有 `SHARE_CAPABILITY_V2`** → 多邮箱 `create` 会被 `MULTI_CREATE` 栅栏拒成 `SHARE_INVALID_CONFIG`。照 `mail-share-service.spec.js:44-51` 加一个 `v2ctx()`。
- **同用户第三个邮箱**:`seedMailbox()`(`:98-104`)给 USER_A 只有 `PRIMARY_A` + `BOX_A`,而 `PRIMARY_A` 是本人地址、`accountService.delete` 会拒(`delMyAccount`)。多邮箱用例需要 USER_A 名下两个**可删**邮箱 + 一个幸存者。
- **afterEach 清 Binding**:`cleanup()`(`:106-114`)删 `mail_share` 却**不删 `mail_share_binding`**。`isolatedStorage` 默认每条用例回滚,所以今天没炸;但一旦用例内自己造孤儿,同一条用例内的后续断言会被污染。补一条 `DELETE FROM mail_share_binding WHERE share_id NOT IN (SELECT share_id FROM mail_share)` 或按 share_id 定点删。

**用例清单**:

| # | 用例 | 关键断言 | AC |
|---|---|---|---|
| A1 | 多邮箱 `{X,Y}` 软删 X(X 是主 Binding) | share 仍 `ACTIVE` + `revoked_at IS NULL`;binding 行只剩 Y;`mail_share.account_id` = Y 且 `window_start_email_id` = Y 的快照(**不是 0**);访客旧 session 仍能读到 Y 的邮件 | AC-BIND-05 · AC-LIFE-10 |
| A2 | 多邮箱 `{X,Y}` 软删**非主**的 Y | 同上镜像;`account_id` 仍为 X **未被改写** | AC-BIND-05 |
| A3 | A1 之后再删 Y | `REVOKED` + `revoked_at` 非空;该 share 的 binding 行数 = 0 | AC-BIND-06 |
| A4 | 硬删路径 `physicsDelete` 重跑 A1/A3 | 同 A1/A3 | AC-BIND-05/06 |
| A5 | `physicsDeleteByUserIds([USER_A])`,USER_A 有一条单邮箱 + 一条多邮箱 | 两条全 `REVOKED`;USER_A 名下 binding 行清零;**USER_B 的分享与 binding 一行不动** | AC-LIFE-09 |
| A6 | 不误撤销:另一条只绑存活邮箱的分享 | 删 X 后该分享恒 `ACTIVE`,访客可读(用户点名的负面条件) | AC-BIND-05 |
| A7 | **无 Binding 的遗留形状**:直接 SQL 造 ACTIVE share(`account_id=X`,零 binding 行),删 X | `REVOKED`(§3.3-B 的回落臂;若主 AI 裁定去掉该臂,本条改为 `.todo` 并在 exec note 登记) | AC-LIFE-09 |
| A8 | **反向守恒**:另造一条无 Binding 的 ACTIVE share(`account_id=Z`,Z 存活),删 X | 该 share 恒 `ACTIVE`(§3.3-A 的过度撤销防线;R3-A2) | AC-BIND-11 |
| A9 | 注入孤儿 Binding(`seedBindingRow` 指向不存在的 accountId)后删 X | 级联不因孤儿而报错;`{X}` 被剔除;孤儿是否本轮被清由 cleanup 负责(断言不要写死在级联侧) | AC-BIND-10 |
| A10 | 事件日志 | spy `console.log`,解析 JSON 行:含 `event === 'share.binding.cascade'`、`shareId` 为受影响 share、**不含**任何邮箱地址明文 | design.md:456 |
| A11 | 参数预算 | 造 60 个 accountId 一次级联(可用合成 id,`mail_share_binding` 无外键,同 `exec-t13-note` L5 的做法),断言不抛 `too many SQL variables`;或直接数 SQL 里的 `?` | D1 100 参数上限 |

### 6.2 `mail-worker/test/mail-share-cleanup.spec.js`(现 83 行,1 条用例)

🔴 **种子陷阱(必须先修,否则新用例假绿)**:现有 `insertShare`(`:14-21`)写死 `user_id=1, account_id=1`,而测试库里**没有** `account_id=1` 的 account 行。基于这套种子造出来的任何 Binding 都天然满足 §4.2-③ 的「非法」谓词 → **「到期分享 Binding 同批删」这条断言会被孤儿补偿臂顺手做掉,测不出①臂是否存在**。红灯用例必须先 seed 一对合法的 `user` + `account`(照 `account-delete-share.spec.js:65-79` 的 `ensureUser`/`ensureAccount`),让到期臂与补偿臂各自可独立证伪。

| # | 用例 | 关键断言 | AC |
|---|---|---|---|
| B1 | 到期 share(**合法** account/user)带 2 条 binding,跑 cron | 该 share 的 binding 行数 = 0;主表行已删;**未到期 share 的 binding 一行不动** | AC-LIFE-06 |
| B2 | 顺序证伪:B1 结束后全表扫「binding 的 share_id 已无主表行」 | 计数 = 0(证明子表删在主表之前) | AC-LIFE-06 |
| B3 | 悬空孤儿:直接插一条 `share_id` 不存在的 binding,跑 cron | 被删 | AC-BIND-10 |
| B4 | 死账号孤儿:合法未到期 share + binding,把 account 硬删(绕过 service 直接 SQL),跑 cron | binding 被删;该 share 剩 0 → `REVOKED` + `revoked_at` | AC-BIND-10 · AC-BIND-06 |
| B5 | 归属不符孤儿:binding 指向另一 user 的 account | 被删(与 `illegalBindingCount()` 同源判据) | AC-BIND-10/11 |
| B6 | **不过度撤销**:零 Binding 的 ACTIVE 未到期 share(即现有 `t12-keep-expired` 形状) | 跑完仍 `ACTIVE` + `revoked_at IS NULL` | R3-A2 · AC-BIND-11 |
| B7 | **不误伤幸存者**:合法 share 有 2 条 binding、其中 1 条的 account 被删 | 只删那 1 条;share 保持 `ACTIVE`;主表 `account_id` 指向幸存者(若被删的是主) | AC-BIND-05 |
| B8 | 幂等:连跑两次 cron | 第二次零变更;`revoked_at` 不被改写 | AC-LIFE-08 同族 |
| B9 | 基线保持 | 现有 `:52-82` 那条(幂等行 TTL + 到期分享 + 四个既有 job 各调 1 次)**一字不改**仍绿 | 基线守恒 |
| B10 | 补偿事件日志 | 孤儿清理打 `share.binding.cascade`,`reason` 与级联侧可区分 | design.md:456 |

### 6.3 已有的、必须继续绿的断言

- `account-delete-share.spec.js` 现有 5 条(`:140-264`)**只扩不改** —— 尤其 `:175-191`「软删后 restore,分享保持 REVOKED」(级联删了 binding 之后,restore 不会复活分享,新实现天然满足,但要跑)。
- `v3-2-db.spec.js:350-365`「回填后 account 被删,下次 init 撤销该行」—— T-18 **不碰 init.js**,这条不受影响;但它留下的孤儿 binding 正是 §4.2-③ 的目标。
- `mail-share.schema.spec.js:142-152` 的主表读取围栏只数 `share-auth-service.js`(恒 3)与 `share-scoped-email-repository.js`(恒 0),**不数 `mail-share-service.js`**。所以级联里新增的 `mail_share.account_id` 引用不会打红围栏 —— 但也别自作主张把 `mail-share-service.js` 加进围栏清单(那是 Expand 期双写的合法写者)。
- `mail-share-service.spec.js:1332-1341` 六事件封闭清单 `toEqual`:接线 `BINDING_CASCADE` **不改** `SHARE_EVENT`,这条不动。

### 6.4 验证命令

```
pnpm --dir mail-worker exec vitest run test/account-delete-share.spec.js test/mail-share-cleanup.spec.js --no-cache   # 红→绿定点
pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/v3-2-db.spec.js test/mail-share.schema.spec.js  # 邻接回归
pnpm --dir mail-worker test                                                                                            # 全量(基线 18 文件 / 577)
```

---

## 7. 文件白名单

### 7.1 允许写(4 个)

| 文件 | 改动 | 约束 |
|---|---|---|
| `mail-worker/src/service/mail-share-service.js` | `revokeByAccountIds:1364-1381` 函数体 + 2 个新私有 `prepare*` helper | 波次内单写者(tasks.md:26,W3 `T-15→T-16→T-18`)。`create`/`updateBindings`/`revoke`/`get`/`update`/`delete`/`resetAuthKey`/`list` 一字不动;`prepareRevoke` / `syncPrimaryAccountId` 复用不修改 |
| `mail-worker/src/service/mail-share-cleanup-service.js` | `cleanupExpired:10-28` 整体改为单 batch + 3 条新语句 | T-18 独占。`IDEMPOTENCY_TTL_HOURS` 与既有幂等行 TTL 语义不变 |
| `mail-worker/test/account-delete-share.spec.js` | T-18.1 红灯(§6.1)+ `v2ctx` / 第三邮箱 / afterEach 清 binding | 现有 5 条只扩不改 |
| `mail-worker/test/mail-share-cleanup.spec.js` | T-18.1 红灯(§6.2)+ 合法 account/user 种子 | 现有 1 条只扩不改 |

### 7.2 明确不碰

| 文件 | 归属 / 理由 |
|---|---|
| `mail-worker/src/security/security.js` | T-17 已入库 `d18f027`,8 条 Owner 路径已收编。T-18 **不新增任何端点**,级联是内部调用,无路由面 |
| `mail-worker/src/init/init.js` | T-01 独占。回填/门禁 SQL 是裁决原文(W0 已定「不加 `status` 过滤,补偿交 T-18」)。T-18 的活是在 cleanup 侧**补偿**它留下的孤儿,不是回头改迁移 |
| `mail-worker/src/service/share-auth-service.js` | W1 冻结。`loadLiveBindings:303-341` 的活账号过滤与影子 Binding 路径**是 T-18 的正确性前提,不是改造对象**;`effectiveStatus` 更不能动 |
| `mail-worker/src/service/account-service.js` | §5:签名与三处调用点保持不变,目标改动 0 行。若执行中发现非改不可,**先停下交主 AI 裁决**,不要自行改 |
| `wrangler.toml` / `wrangler-vitest.toml` | W0-R5 裁决:toml 只写注释声明,禁止硬写覆盖 dashboard。T-18 **不需要任何新环境变量**——级联与清理都不过 V2 栅栏(删邮箱是既有能力,不是新策略写入) |
| `mail-worker/src/api/mail-share-api.js` · `share-api.js` | 无新端点;`share-api.js` 另属 W1/T-14 |
| `mail-worker/src/entity/*.js` | 列已齐,走原生 SQL |
| `mail-worker/test/mail-share-service.spec.js` · `security-share.spec.js` · `v3-2-db.spec.js` | 作为「不许改坏」的基线跑,不加 T-18 用例(级联用例有专属 spec) |
| `mail-vue/**` · `tests/e2e/**` | W4/W5/W6 |

---

## 8. 并行切分

**T-18 不可拆并行,单执行者串行完成。** 两条物理原因:

1. 两个生产文件里,`mail-share-service.js` 是波次内单写者热区(tasks.md:26);`mail-share-cleanup-service.js` 虽独立,但它的孤儿补偿谓词必须与级联侧的合法性判据**逐字同源**(§4.2),分给两个 sub 必然漂移成两套判据 —— 这正是「守恒」二字要防的东西。
2. 两个 spec 虽是两个文件,但 §6.1 与 §6.2 的红灯依赖同一批语义裁决(回落臂是否保留、cleanup 是否顺带撤销)。裁决未定就并行开写,必然返工。

内部推进次序(同一执行者内的顺序,不是并行槽):

```
① 先取 §3.3 与 §4.2 的两条裁决(回落臂 / cleanup 撤销臂)—— 它们决定 A7/A8/B4/B6 四条用例的期望值
② 红:account-delete-share.spec.js 扩展(A1–A11)
③ 绿:revokeByAccountIds 三语句 batch + BINDING_CASCADE 日志
④ 红:mail-share-cleanup.spec.js 修种子 + 扩展(B1–B10)
⑤ 绿:cleanupExpired 单 batch 五语句
⑥ 全量回归 + 邻接 spec(v3-2-db / mail-share-service / schema)
```

③必须早于⑤:cleanup 的孤儿补偿是级联的**兜底**,先把主路径做对,才能让 B3/B4 测的是「补偿」而不是「唯一路径」。

可与 T-18 真正并行的:无(T-19 是它的 checkpoint,W4 依赖 W3 契约)。

---

## 9. 风险与陷阱

| # | 风险 | 说明与处置 |
|---|---|---|
| **T1** | **过度撤销零 Binding 的合法行** | §3.3-(A)。撤销谓词漏掉「受影响」范围 = 每删一个邮箱就扫一遍全库。防线:A8/B6 两条反向用例 |
| **T2** | **纯 JOIN 漏掉无 Binding 的遗留形状** | §3.3-(B)。字面照抄 AC-LIFE-09 会制造新回归。防线:A7 + 主 AI 裁决登记 |
| **T3** | **用「account 已删」当级联判据** | §5-事实 1。三个挂钩点全在 account 行仍存活时调用,这种写法**恒零命中**且单测很难发现(因为主表直查那条路径同时被删了,现象是「什么都没发生」)。判据只能是 accountId 集合 |
| **T4** | **语句顺序写反** | 级联:撤销/重指必须早于 DELETE binding;cleanup:子表必须早于主表。写反的现象都是「零孤儿断言过、但撤销/重指静默失效」,只有 A1(`account_id` 值断言)与 B2(全表悬空扫描)能抓住 |
| **T5** | **D1 绑定参数上限** | `physicsDeleteByUserIds` 的集合无上限,且集合在单条语句里出现 3–4 次。必须 `json_each(?)`。防线:A11 |
| **T6** | **主表重指写出 0 / NULL** | `syncPrimaryAccountId:735-736` 的注释说得很清楚:宁可停在旧值,绝不写 0(旧 Worker 见 0 即判链接不可用)。新的排除式变体必须原样保留 `EXISTS(幸存者)` 守卫 + `b.account_id > 0`。防线:A1 断言 `account_id` 等于幸存者且 > 0 |
| **T7** | **cleanup 种子天生非法 → 假绿** | §6.2 首段。这是本轮最容易吃到的假绿:B1 不换合法种子的话,binding 消失的原因是补偿臂而不是到期臂 |
| **T8** | **孤儿补偿判据与写入门禁漂移** | ③的谓词必须与 `prepareBindingInsert:675-676` / `init.js:98-100` / `illegalBindingCount()` 同源(存在 + `is_del=NORMAL` + `user_id` 匹配)。少一个条件就漏扫,多一个就误删。建议实现处留注释指向这三处 |
| **T9** | **软删可 restore,补偿臂却是不可逆的** | `restoreByEmail`(`account-service.js:209-211`)能把 `is_del` 改回 NORMAL,但 Binding 已被级联删掉、分享已 REVOKED(终态)。这是**既有语义**(`account-delete-share.spec.js:175-191` 已钉),不是 T-18 引入的;别为了「restore 友好」把删 Binding 改成软删 —— 那会新造一个状态维度 |
| **T10** | **日志量爆炸 / PII** | per-binding 打日志会在 `physicsDeleteByUserIds` 下刷出上百行。per-share 一行,字段只放行号与计数,绝不放 email(`logShareEvent:85` 的注释是硬约束) |
| **T11** | **吞掉级联异常** | §5-事实 3。给 `await mailShareService.revokeByAccountId` 包 try/catch = 「账号删了、分享还活着」。保持 fail-closed |
| **T12** | **cleanup 上下文只有 `env`** | §4.3。用了 `c.get(...)` 会在 cron 路径上直接抛 TypeError,而 cron 失败在测试里只表现为「什么都没清」 |
| **T13** | **`revoked` 返回值语义漂移** | §3.5。现在是「被置 REVOKED 的分享数」;新实现里三条语句都有 changes,取错一条就把语义换成了「受影响分享数」。虽无测试断言,但 exec note 要写明取的是哪条 |
| **T14** | **重复撤销覆盖 `revoked_at`** | `prepareRevoke` 带 `AND status='ACTIVE'`,已 REVOKED 的行不会被二次写时间戳。级联复用它就自动满足幂等;cleanup 的②臂是自写 UPDATE,**必须自己带 `status='ACTIVE'`**。防线:B8 |
| **T15** | **`json_each` 与 `NOT IN` 的空集合语义** | 空数组时 `IN` 恒假、`NOT IN` 恒真 —— 现有的空集合早退(`:1375-1377`)必须保留,否则「删 0 个邮箱」会走成「撤销所有无 Binding 的行」 |

---

## 10. 执行前自检清单(给 T-18 执行者)

- [ ] §3.3 与 §4.2 的两条裁决已取得(回落臂 / cleanup 撤销臂),A7/A8/B4/B6 的期望值已确定
- [ ] 级联三语句在**同一个** `c.env.db.batch()`,顺序为 撤销 → 重指 → 删 Binding
- [ ] 撤销谓词同时带「受影响」与「无幸存者」两半,且经 `prepareRevoke` 生成
- [ ] 无 Binding 的回落臂已实现(或缺口已登记)
- [ ] 主表重指带 `EXISTS(幸存者)` 守卫与 `account_id > 0`,绝不写 0/NULL
- [ ] 集合全部走 `json_each(?)`,单语句绑定参数与 accountId 数量无关
- [ ] `logShareEvent(SHARE_EVENT.BINDING_CASCADE, …)` 已接线,per-share 一行,无邮箱明文
- [ ] cleanup 已改为单 batch,子表恒在主表之前,幂等行子查询替换 `inArray` 预读
- [ ] 孤儿补偿谓词与 `prepareBindingInsert` / `init.js` 回填门禁 / `illegalBindingCount()` 逐字同源
- [ ] cleanup 的②臂带 `EXISTS(任意 Binding)` 与 `status='ACTIVE'`
- [ ] `mail-share-cleanup.spec.js` 已换合法 account/user 种子,到期臂与补偿臂可独立证伪
- [ ] `account-service.js` 改动 0 行;`security.js` / `init.js` / `share-auth-service.js` / `wrangler*.toml` 一字未动
- [ ] 现有 6 条基线用例(account-delete 5 + cleanup 1)未改写且全绿
- [ ] 全量 `pnpm --dir mail-worker test` EXIT=0,与 T-17 基线(18 文件 / 577)比只增不减

---

## 11. 参考锚点索引

```
契约   docs/specs/mailbox-share-capability/requirements.md:80-81(AC-BIND-05/06)、:85(AC-BIND-10)
       :86(AC-BIND-11 门禁同源)、:194(AC-LIFE-06)、:197(AC-LIFE-09)
       docs/specs/mailbox-share-capability/design.md:136(D1 无事务/batch)、:174(idx_msb_account 级联反查)
       :177(无外键,守恒靠 cleanup)、:179(R1-A9 孤儿补偿)、:456(share.binding.cascade 含孤儿补偿)
       :491-496 / :561-565(AC 矩阵)、:656(mail_share_binding 消费者表)
       docs/specs/mailbox-share-capability/tasks.md:26(热区单写者)、:428-432(T-18,行号已漂移)
级联   mail-worker/src/service/mail-share-service.js:1360-1381(revokeByAccountId/Ids,本次改造点)
复用   :40-47(SHARE_EVENT)、:85-96(logShareEvent)、:293-295(placeholders)、:300-313(snapshotPredicate/json_each 先例)
       :458-471(prepareRevoke 撤销唯一真源)、:478-509(loadBindings/loadBindingSummaries)
       :665-691(prepareBindingInsert · account 门禁 JOIN)、:698-716(prepareBindingDelete)
       :737-758(syncPrimaryAccountId 双写)、:1163-1167(删空转撤销 + 双写的现成组合)
       :1231-1262(delete 的子表在前/主表在后)
清理   mail-worker/src/service/mail-share-cleanup-service.js:10-28(本次改造点)· mail-worker/src/index.js:28-40(cron 入口)
挂钩   mail-worker/src/service/account-service.js:144-165(软删)、:182-187(随用户硬删)、:248-253(硬删)
       :209-215(restore,与 T9 相关)
读路径 mail-worker/src/service/share-auth-service.js:282-296(assertAllowed/loadLiveAccount)
       :303-341(loadLiveBindings 活账号过滤 + 影子 Binding,§3.3-A/B 的依据)
DDL    mail-worker/src/init/init.js:63-76(binding 表 + 两个索引)、:93-106(回填门禁)、:111+(revokeInvalidShares,孤儿源)
用例   mail-worker/test/account-delete-share.spec.js:23-38(shareEnv 缺 V2)、:65-114(种子与 cleanup)、:139-264(5 条基线)
       mail-worker/test/mail-share-cleanup.spec.js:14-21(种子陷阱)、:45-82(基线用例)
       mail-worker/test/v3-2-db.spec.js:59-77(bindings / illegalBindingCount 判据同源)、:310-327(R3-A2 晚写行)、:350-365(孤儿源用例)
       mail-worker/test/mail-share-service.spec.js:1332-1341(事件封闭清单)、:2002-2020(D1 参数预算范本)
       mail-worker/test/setup.js:75-116 / :122-132(seedShareRow / seedBindingRow)
       mail-worker/test/mail-share.schema.spec.js:142-152(主表读取围栏,不含 mail-share-service.js)
配置   mail-worker/vitest.config.js:11-21(singleWorker + 默认 isolatedStorage 每例回滚)
前锋   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/review-t01.md:102(回填后删 account 留孤儿)
       .../exec-t13-note.md:93(L3 remove 与级联并发,补偿归 T-18)· .../exec-t08-note.md:241-243(主表/Binding 不一致行归 T-18)
       .../recon-w0-t01-executable-scope.md:179(W0-R3 裁决:补偿交 T-18)
       .../session-ledger.md:125(mail-share-service.js 下一写者 = T-18)
```
