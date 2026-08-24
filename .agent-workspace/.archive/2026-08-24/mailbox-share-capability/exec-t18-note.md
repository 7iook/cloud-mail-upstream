# Exec Note · T-18 级联撤销经 Binding + cleanup 清理守恒

- **日期**:2026-08-24 · **分支**:`cursor/mailbox-share-capability-dcb6` · **起点 HEAD**:`af94a22`(T-17 APPROVED + T-18 recon 已入库)
- **未 commit / 未 push / 未 stash / 未切分支**。
- **白名单外一字未动**:`security.js`、`init.js`、`share-auth-service.js`、`account-service.js`(目标 0 行,实际 0 行)、`wrangler*.toml`、`share-api.js`、`mail-share-api.js`、`mail-share-service.spec.js`、`v3-2-db.spec.js`、`entity/*`、`mail-vue/**`、`tests/e2e/**`。`SHARE_EVENT` 六条封闭清单未增未删。

## 白名单内改动(5 个文件)

| 文件 | 增/删 | 说明 |
|---|---|---|
| `mail-worker/src/service/mail-share-service.js` | +100 / −3 | `revokeByAccountIds` 函数体重写(归一化循环 `:1365-1377` 与空集合早退逐字保留)+ 紧邻 `syncPrimaryAccountId` 之后新增 `CASCADE_REVOKE_WHERE` / `prepareCascadeResync` / `prepareCascadeBindingDelete` 三个私有件。`syncPrimaryAccountId` / `prepareRevoke` / `create` / `update` / `delete` / `updateBindings` / `resetAuthKey` / `list` / `revoke` / `revokeByAccountId` 包装 **一字未动** |
| `mail-worker/src/service/mail-share-cleanup-service.js` | +105 / −22 | `cleanupExpired` 整体改为**单个** `c.env.db.batch()` 六条原生 SQL;drizzle 依赖(`orm` / `inArray` / `lt` / `lte` / `or` / 实体导入)已全部移除 |
| `mail-worker/test/account-delete-share.spec.js` | +255 / −8 | 只扩不改:`v2ctx()`、第三个可删邮箱 `BOX_C`、`cleanup()` 补 Binding 清理、新 describe 12 条(A1–A12)。**既有 5 条断言逐字未动**(改动仅:`readShareRow` 的 SELECT 多取一列 `window_start_email_id`、`afterEach` 追加 `vi.restoreAllMocks()`、`seedMailbox` 多种一个账号) |
| `mail-worker/test/mail-share-cleanup.spec.js` | +216 / −5 | 只扩不改:合法 user/account 种子、`insertShare` 补可选 `userId`/`accountId`(默认值即旧行为)、`afterEach` 追加清理、新增 9 条(B1–B8、B10)。**既有基线用例 `:52-82` 逐字未动** |
| 本文件 | 新建 | — |

---

## 红 / 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 基线 | `pnpm --dir mail-worker exec vitest run test/account-delete-share.spec.js test/mail-share-cleanup.spec.js --no-cache` | **6 passed**(5 + 1) |
| **红**(用例就位,两个生产文件未动) | 同上 | **15 failed / 11 passed(26)** |
| **绿** | 同上 | **26 passed(26)** |
| 绿 + A12(顺序守卫,变异测出来后补的) | 同上 | **27 passed(27)** |
| 邻接回归 | `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/v3-2-db.spec.js test/mail-share.schema.spec.js --no-cache` | **240 passed(3 文件)** |
| 全量 worker | `pnpm --dir mail-worker test -- --no-cache` | **18 files / 598 tests 全绿**(T-17 收口态 18/577,+21 全部来自本次两个 spec) |
| 前端 | `pnpm --dir mail-vue test -- --no-cache` | **17 files / 95 tests 全绿**(未改任何前端文件,只作地板确认) |

红态下**已绿**的 11 条是设计好的守恒护栏,不是漏写的红灯:既有 6 条基线,加 A6(不误撤销存活分享)/ A7(无 Binding 遗留行今天靠主表直查恰好撤得掉)/ A8(反向不过度撤销)/ B6(零 Binding ACTIVE 不被撤)/ B8(今天什么都不清所以天然幂等)。它们的作用是在绿态里**防回归**,红灯来源集中在 A1–A5 / A9–A11 与 B1–B5 / B7 / B10。

---

## 实现 · 级联侧(`revokeByAccountIds`)

三语句**同一个** `c.env.db.batch()`,顺序 **①撤销 → ②重指 → ③删 Binding**。

### ① 撤销:经 `prepareRevoke(c, CASCADE_REVOKE_WHERE, [idsJson, idsJson, idsJson])`

走 `prepareRevoke` 而不是另写 UPDATE,`AND status='ACTIVE'` 与 `RETURNING share_id` 因此仍是单一真源(顺带白拿 T14 的幂等:已 REVOKED 的行不会被二次写 `revoked_at`)。

**双臂(T18-DUAL),互斥**:
- **Binding 臂(主)**:`EXISTS(binding 指向将死账号)`;
- **回落臂**:`NOT EXISTS(任何 binding) AND mail_share.account_id ∈ 将死集合` —— R3-A2 迁移窗口晚写的合法遗留形状,`share-auth-service.loadLiveBindings:310-318` 为它留了影子 Binding 读路径。纯 JOIN 会让这类行的账号被删后永久停在 ACTIVE。
- 末尾恒挂 `AND NOT EXISTS(binding NOT IN 将死集合)`(无幸存者)。这半句掉了,删任意一个邮箱都会顺手撤掉还有存活邮箱的分享。

### ② 重指:`prepareCascadeResync`(新 helper,不复用也不修改 `syncPrimaryAccountId`)

`syncPrimaryAccountId` 按 `binding_id` 最小挑主 Binding,而级联跑在 DELETE **之前**、将死的行还在表里,直接复用会挑出一个马上要消失的 account。新 helper 只多一条 `AND b.account_id NOT IN (json_each(?))`,两条守卫逐字保留:`b.account_id > 0` 与 `EXISTS(幸存者)` —— 无幸存者时零变更,**绝不写 0/NULL**。

### ③ `DELETE FROM mail_share_binding WHERE account_id IN (SELECT value FROM json_each(?)) RETURNING share_id, account_id`

### 三条必须留在代码里的硬事实(已写成注释)

1. **顺序即语义**:①②读「将死 Binding 还在」这个事实,③销毁它。D1 的 `batch()` 是一个事务,三条要么全成要么全不成。
2. **判据只能是「accountId ∈ 本次传入集合」**。三个挂钩点(`account-service.js:159` 软删 / `:184` 随用户硬删 / `:250` 单账号硬删)**全在 account 行仍存活、仍 NORMAL 时调用**,拿「account 已删」当判据会恒零命中、静默退化成空操作。
3. **不加 try/catch**。级联抛错必须让整个账号删除失败(fail-closed);吞掉就变成「账号删了、分享还活着」。
4. **空集合早退不可省**。空 `json_each` 让 `IN` 恒假而 `NOT IN` 恒真,「删 0 个邮箱」会走成「撤销全库所有零 Binding 的 ACTIVE 行」。

### 绑定参数预算

集合全程只当**一个**绑定参数用:①用 3 次 = 3 个参数(+1 个 `revoked_at`),②用 4 次 = 4 个,③用 1 次 = 1 个。与 accountId 数量**无关**,`physicsDeleteByUserIds` 传 101 个邮箱也不会撞 D1 单语句 100 参数硬顶。A12 之外由 A11 实测 60 个 id 单次调用。

### 返回值

`{ revoked, unbound }`。**`revoked` 语义未漂移**,仍是「被置 REVOKED 的分享数」= ①的 `meta.changes`,不是「受影响分享数」。`unbound` = ③的 `meta.changes`。三个调用点都不消费返回值,只加字段不改形状。

---

## 实现 · cleanup 侧(`cleanupExpired`)

单个 `c.env.db.batch()`,六条,**主表恒最后**。`IDEMPOTENCY_TTL_HOURS = 24` 与 `delete_at <=` 语义原样保留。`c` 只有 `env`,新代码没有任何 `c.get(...)` / `c.req` / `publicOrigin`。

| # | 语句 | 为什么在这个位置 |
|---|---|---|
| ① | `DELETE mail_share_binding WHERE share_id IN (SELECT … delete_at <= ?)` `RETURNING` | AC-LIFE-06「同一批次」。必须早于⑥,否则子查询查不到 share_id |
| ② | `UPDATE mail_share … REVOKED` (`status='ACTIVE'` + `EXISTS(任意 Binding)` + `NOT EXISTS(活账号 JOIN)`) `RETURNING` | 必须早于③(它要读③即将删掉的行)。`EXISTS(任意 Binding)` **不可省**:零 Binding 的合法遗留行归回填收编,不归本臂管 |
| ③ | `DELETE mail_share_binding WHERE NOT <合法性判据>` `RETURNING` | 一条语句同时覆盖「account 不存在/已删/归属不符」与「悬空 share_id」(内层 `ms` 不存在 → NOT EXISTS 成立) |
| ④ | `UPDATE mail_share SET account_id / window_start_email_id …` | 必须在③之后:③跑完剩下的 Binding 才都是活的。带 `EXISTS(幸存者)` + `account_id > 0`,绝不写 0/NULL。级联已自己重指,这条是崩溃 / 绕过 service 的兜底(B7 · AC-LIFE-10) |
| ⑤ | `DELETE share_idempotency WHERE created_at < ? OR share_id IN (SELECT …)` | 相关子查询替代原来的 JS 侧预读 + drizzle `inArray` 展开(到期分享一多就撞参数上限) |
| ⑥ | `DELETE FROM mail_share WHERE delete_at <= ?` | 主表恒最后 |

**合法性判据同源**(提为文件级常量 `LEGAL_BINDING` 并在注释里点名三处同源点):`account` 存在 + `is_del = ${isDel.NORMAL}` + `a.user_id = ms.user_id`。与 `prepareBindingInsert:675-676` 的写入门禁 JOIN、`init.js:98-100` 的回填门禁、`v3-2-db.spec.js:66-77` 的 `illegalBindingCount()` 逐字一致。少一个条件就漏扫,多一个就误删。

**T18-ORPHAN-REVOKE 已落地**:②这条「补偿顺带撤销」保证补偿完不留下「ACTIVE + 有 Binding 记录 + 零活邮箱」的僵尸行(B4)。

不加 try/catch:清理失败必须让 cron 报错,而不是静默少清一批。

---

## 事件字段

复用 `SHARE_EVENT.BINDING_CASCADE`(`share.binding.cascade`),**未新增任何事件名**(六条 `toEqual` 封闭清单未动)。粒度是**每个受影响 share 一行**,不是每个 binding 一行 —— `physicsDeleteByUserIds` 一次可能剔除上百条。

字段固定四个,加上 `logShareEvent` 信封恒带的 `event` / `requestId` / `shareId` / `ts`:

| 字段 | 值 |
|---|---|
| `shareId` | 受影响 share(信封字段) |
| `reason` | 级联 `'account_deleted'` · cleanup 到期臂 `'share_expired'` · cleanup 补偿臂 `'orphan_sweep'` |
| `removedBindings` | 本轮该 share 被剔除的 Binding 行数(级联下零 Binding 遗留行被撤时为 `0`) |
| `revoked` | 本轮该 share 是否被置 REVOKED |

**不含**:邮箱地址、`sec`、`authKey`、token、IP。不传 `event` / `ts`(信封会覆盖)。A10 / B10 各有一条 `JSON.stringify(entry)).not.toContain('@')` 的机器断言钉住无 PII。

---

## 变异校验(证明每条谓词各自承重)

派单没要求,但 recon §9 把 T1/T2/T4/T6/T7 列为「写错了单测也看不出来」的高风险项,所以逐条实跑。**第 3 条变异直接暴露了一个用例缺口,A12 是因此补的**;六次变异后代码均已还原,`grep '0 = 1' src/service/*.js` 为空,全量重跑 598/598。

| 变异 | 结果 | 捕获者 |
|---|---|---|
| **M1** 去掉级联撤销的**回落臂** | 1 failed | **A7** 独家 |
| **M2** 去掉级联撤销的**「无幸存者」半句** | 7 failed | **A1 / A2**(AC-BIND-05 误撤销)领衔 |
| **M3** 级联三语句改为 **DELETE 排第一** | 2 failed,**且全是索引位移导致的假阳性**(A10/A11) | ❌ **A1–A9 全部漏网** |
| **M3b** 同上,补 A12 后重跑 | 3 failed | **A12** 抓住 |
| **M4** 去掉 cleanup ②臂的 `EXISTS(任意 Binding)` | 1 failed | **B6** 独家 |
| **M5** 让 cleanup ④(重指)恒不命中 | 1 failed | **B7** 独家 |
| **M6** 让 cleanup ①(到期臂)恒不命中 | 3 failed | **B1 / B2 / B10** |

**M3 是本轮最有价值的发现**。双臂设计有个反直觉的副作用:把 DELETE 提到最前面之后,Binding 臂虽然读不到行了,**回落臂会因为「此刻已零 Binding」而顶上**,A1–A9 的期望值一条都不变 —— 顺序错了却全绿。唯一能证伪的形状是 **Binding 集合全部将死、而主表 `account_id` 指向一个存活账号**(即 exec-t08-note:241-243 登记的「主表 / Binding 不一致行」):此时 Binding 臂读不到行、回落臂又因主表指向存活账号而不成立,分享静默停在「ACTIVE + 零 Binding」。**A12 就是这条**,它是级联侧语句顺序的唯一守卫。

---

## 用例清单

### `account-delete-share.spec.js` 5 → 17

| # | 用例 | 关键断言 |
|---|---|---|
| A1 | 软删多邮箱分享的**主** Binding 邮箱 | 仍 `ACTIVE` + `revoked_at IS NULL`;binding 只剩幸存者;`account_id` **与 `window_start_email_id` 双双**重指到幸存者的快照值(不是 0、不是旧值);访客旧 session 重解后能读到幸存邮箱的新邮件 |
| A2 | 软删**非主** Binding 邮箱 | 镜像;`account_id` / `window_start_email_id` **未被改写** |
| A3 | A1 之后再删幸存者 | `REVOKED` + `revoked_at` 非空;binding 行数 0;访客 `SHARE_UNAVAILABLE` |
| A4 | `physicsDelete` 硬删路径重跑 A1+A3 | 同 A1 / A3 |
| A5 | `physicsDeleteByUserIds([USER_A])`(1 条单邮箱 + 1 条多邮箱) | 两条全 `REVOKED`、binding 清零;**USER_B 的分享与 binding 一行不动** |
| A6 | 只绑存活邮箱的另一条分享 | 恒 `ACTIVE`,访客可读(用户点名的负面条件) |
| A7 | 零 Binding 遗留行,其 `account_id` 在将死集合内 | `REVOKED`(T18-DUAL 回落臂) |
| A8 | 零 Binding 遗留行,`account_id` **不在**将死集合内(本人的 + 他人的各一条) | 恒 `ACTIVE` + `revoked_at IS NULL` |
| A9 | 注入指向不存在 account 的孤儿 Binding 后删邮箱 | 级联不报错;将死的那条被剔除;孤儿留给 cleanup(**不在级联侧断言它被清**) |
| A10 | 事件日志 | 该 share 恰 **1** 条 `share.binding.cascade`;`reason='account_deleted'` / `removedBindings=1` / `revoked=false`;所有行不含 `@` |
| A11 | 参数预算 | 60 个合成 accountId 一次调用;`resolves.toEqual({ revoked: 0, unbound: 3 })`,不抛 `too many SQL variables` |
| A12 | **语句顺序守卫**(变异测出来的缺口) | 主表 `account_id` 指向存活账号 + Binding 全部将死 → 必须 `REVOKED` |

### `mail-share-cleanup.spec.js` 1 → 10

🔴 **种子陷阱已处置**:原 `insertShare` 写死 `user_id=1 / account_id=1` 而库里**没有** `account_id=1`,挂在这套种子上的任何 Binding 天生满足③的「非法」判据 —— B1 会被补偿臂顺手做绿,测不出到期臂是否存在。新用例一律先 `seedLegalOwner()` 种合法 user + account,两臂因此可独立证伪(M6 实测:到期臂失效时 B1/B2/B10 变红,补偿臂没能把它盖住)。`insertShare` 的两个新参数带默认值,基线用例调用点一字未改。

| # | 用例 | 关键断言 |
|---|---|---|
| B1 | 到期 share(合法种子)带 2 条 binding | 该 share binding 数 0、主表行已删;**未到期 share 的 binding 一行不动** |
| B2 | 顺序证伪 | 全表「share_id 已无主表行」的 binding 计数 = 0 |
| B3 | 悬空孤儿(share_id 从未存在) | 被删 |
| B4 | 死账号孤儿(**裸 SQL 硬删 account,绕过 service**) | binding 被删;该 share 剩 0 → `REVOKED` + `revoked_at` |
| B5 | 归属不符孤儿(指向另一 user 的 account) | 只删非法那条,合法那条留下;share 仍 `ACTIVE` |
| B6 | 零 Binding 的 ACTIVE 未到期 share | 仍 `ACTIVE` + `revoked_at IS NULL` |
| B7 | 2 条合法 binding,裸 SQL 删掉**主** binding 的 account | 只删那 1 条;share `ACTIVE`;`account_id` = 幸存者且 `window_start_email_id` = 幸存者快照(22,不是 0) |
| B8 | 连跑两次 cron | 第二次整行 `toEqual` 第一次(`revoked_at` 未被改写);零悬空 binding |
| B9 | 既有基线 `:52-82` | 一字未改仍绿(四个既有 job 各调 1 次 + 到期/未到期 + 幂等行 TTL 边界) |
| B10 | 补偿事件日志 | 孤儿臂 `reason='orphan_sweep'` + `revoked=true`;到期臂 `reason='share_expired'`;**没有一条是 `'account_deleted'`**;全部不含 `@` |

B1 / B9 走 `worker.scheduled({ cron: '0 16 * * *' }, env, {})` 的 cron 路径(定时接线保持被证明),其余用例同路径以保持一致。

---

## 未做事项 / 遗留

| # | 项 | 说明 |
|---|---|---|
| L1 | **`applyRevoke` 现在只剩 `revoke` 一个调用点** | 级联改走 `prepareRevoke` + batch,不再经 `applyRevoke`。函数本身未动(它不在白名单的可改清单里,且 `revoke` 仍在用),但它已从「两个消费者」退化成「一个」。将来若 `revoke` 也进 batch,这个薄包装可以删掉 |
| L2 | **级联侧不清孤儿 Binding** | A9 的孤儿(指向不存在 account)在级联批次里**不会**被剔除,它甚至会作为「幸存者」挡住撤销、并被②重指为主 `account_id`(值 >0,不违反 AC-LIFE-10 的字面,但指向了一个不存在的行)。这是刻意的:孤儿回收归 cleanup 的③臂,级联只管「将死集合」。**下一次 cron 才收敛**,窗口内该 share 停在「ACTIVE + 全是孤儿」的僵尸态。若要缩短窗口,得让级联也跑一遍③的合法性判据 —— 那会把「删一个邮箱」变成一次全表扫描,没做 |
| L3 | **`mail_share_binding` 仍无 `RETURNING` 去重** | ③返回的 `(share_id, account_id)` 里,`share_id` 可能指向已不存在的 mail_share 行(悬空孤儿被剔除时)。这类 shareId 照样会打一条 `orphan_sweep` 日志(B3 实测 `shareId: 918999`)。判定为可接受:日志本来就是诊断面,能看到「有个不存在的 share 上挂着孤儿」反而是信息 |
| L4 | 未改 `tasks.md` / `docs/specs/**` | 派单要求。T-18 / T-18.1 / T-18.2 的勾选与 Evidence 留给主 AI |
| L5 | 未 commit / 未 push | `git add` / `git commit` / `git stash` / `git checkout` 一次都没跑。工作树内 4 个 modified + 本文件 untracked |
