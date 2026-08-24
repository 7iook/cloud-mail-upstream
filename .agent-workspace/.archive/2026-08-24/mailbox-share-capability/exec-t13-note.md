# Exec Note · T-13 bindings 增删原子命令 + `PUT /mailShare/bindings`

- **日期**:2026-08-24 · **分支**:`cursor/mailbox-share-capability-dcb6` · **基线 HEAD**:`5ebb8a8`
- **未 commit / 未 push / 未动 tasks.md**(派单要求)。
- **白名单内改动**(4 个文件,全部在派单白名单里):
  - `mail-worker/src/service/mail-share-service.js`(本波次独占写者)
  - `mail-worker/src/api/mail-share-api.js`(只加 `PUT /mailShare/bindings`,create/list/revoke 一字未动)
  - `mail-worker/test/mail-share-service.spec.js`(追加 T-13 用例;T-12 既有 132 条零改写,只在 `cleanup()` 末尾加一行 `DELETE FROM user`,因为 HTTP 用例需要一条真实 user 行)
  - 本文件

## 红 / 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 基线 | `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` | **132 passed**(T-12 收口态) |
| 红 | 同上(用例已写、`updateBindings` 尚不存在) | **21 failed / 132 passed(153)** |
| 绿 | 同上 | **155 passed(155)** |
| 变异校验 | 拆掉 INSERT 归属计数守卫 + DELETE 的 add 守卫后重跑 | **5 failed**(两条原子性用例确实钉在守卫上,不是摆设) |
| 全量(隔离) | 干净 worktree(`5ebb8a8`)+ 仅本任务 3 个源/测试文件 → `pnpm --dir mail-worker test` | **17 files / 340 tests,EXIT=0** |

绿灯后期又补了 2 条原子性用例(153 → 155),它们的红由上面那次变异校验取证,不是「写完就绿」。

⚠️ **`/workspace` 工作树直接跑全量会看到 2 条失败**:`share-api.spec.js`「pages with a stable cursor」与 `share-integration.spec.js`「re-reads the same cursor after a reconnect」。这两条**不是 T-13 引入的** —— 同一工作树里并行的 T-10 正在改 `share-scoped-email-repository.js` / `share-scoped-email-repository.spec.js`(未提交),失败断言是分页游标顺序(`[3,2]` vs `[1,2]`),属该文件的在飞中间态。取证:干净 worktree `5ebb8a8` 上这两条 **passed**;把 T-13 的 3 个文件单独拷进去,全量 **17/340 全绿**。

## 怎么复用 `prepareBindingInsert`(没有第二套 INSERT 方言)

add 直接调既有的 `prepareBindingInsert(c, { onlyMessagesAfterCreated, accountIds: add, userId, lid })`:

- `lid` 取自本分享的行(create 当初也是靠 `WHERE ms.lid = ?` 回捞尚不存在的 `share_id`,T-13 只是把同一把钥匙用在已存在的行上),因此**没有给助手加第二个定位分支**。
- `onlyMessagesAfterCreated` 取本分享落库的那一列,不是请求参数 —— AC-BIND-02 的窗口口径必须跟随分享自身配置(true → 加入时刻 `MAX(email_id)`,false → 0)。
- 用例 `commits every mutation in one batch and reuses the create binding INSERT` 把「create 的 binding INSERT SQL 文本」与「bindings 的 binding INSERT SQL 文本」逐字比对,任何一方分叉出第二套方言立刻红。

对该助手唯一的扩写:WHERE 追加一条**归属计数谓词**(与 `prepareShareInsert` 同款写法,不是新方言):

```sql
AND (SELECT COUNT(*) FROM account
     WHERE account_id IN (...) AND user_id = ? AND is_del = 0) = ?
```

它让这条语句自身「全有或全无」。create 侧是冗余的(`prepareShareInsert` 已带同款谓词,share 不落 binding 自然零行),但对 T-13 是必需的,理由见下。

## batch 里 0 行 INSERT 怎么被挡住(本任务最要紧的一处)

**实测**(临时探针 `test/zz-probe.spec.js`,取证后已删):

```
PROBE error: D1_ERROR: NOT NULL constraint failed: mail_share_binding.account_id: SQLITE_CONSTRAINT
PROBE surviving binding rows after failed batch: 1     ← 同批在前的 DELETE 被回滚了
PROBE unique error: D1_ERROR: UNIQUE constraint failed: mail_share_binding.share_id, mail_share_binding.account_id
PROBE surviving dup row after unique failure: 1        ← UNIQUE 冲突同样整批回滚
```

即:**语句报错 → 整批回滚;`changes === 0` → 不报错、就地提交**。所以「add 写不进去」这件事本身不会救 remove。

SQLite 的 `RAISE(ABORT, …)` 只在 trigger body 里合法,裸语句用不了;为了报错而故意去撞 NOT NULL 又是 3 点钟看不懂的花招。这里改用**互相看得见的守卫**,不依赖异常:

1. batch 顺序固定为 `[add INSERT] → [remove DELETE] → [删空转 REVOKED] → [syncPrimaryAccountId]`(同一 `c.env.db.batch()`,D1 内按序、同事务)。
2. **add 自身全有或全无**:上面那条归属计数谓词。预检之后被删掉一个 account,整条 INSERT 零行,而不是插一半。
3. **remove 看得见 add 的结果**:`prepareBindingDelete` 在 add 非空时挂一条
   `AND (SELECT COUNT(*) FROM mail_share_binding added WHERE added.share_id = ... AND added.account_id IN (add...)) = :addCount`。
   add 零行 → 这条守卫不成立 → DELETE 也零行 → 库表零残留。
4. 批后 `results[addIndex].meta.changes !== add.length` → 抛 `SHARE_ACCOUNT_FORBIDDEN`(AC-BIND-10 的错误码在这里补出来,防线本身在 SQL 里)。
5. 删空转 REVOKED 的谓词是 `NOT EXISTS(该 share 还有 Binding)`,读的是同批 DELETE **之后**的真实状态,不信预检算出的投影数;`syncPrimaryAccountId` 的 `EXISTS` 守卫原样保留 —— 没有可跟随的 Binding 时零变更,绝不写 `account_id = 0`。

`applyRevoke` 拆成 `prepareRevoke`(返回未执行语句)+ 一行 `applyRevoke`,撤销谓词仍是单一真源,revoke / 级联 / 删空三处共用。

**UNIQUE 兜底**:重复绑定在预检就拒(`SHARE_BINDING_DUPLICATE`);真撞上并发 UNIQUE 时 `isUniqueConflict(err)` 把 D1 错误翻译成同一个错误码,而整批已由 D1 回滚(上面实测第二段)。

## 校验顺序(顺序即语义)

`SHARE_NOT_FOUND`(分享归属 + ACTIVE + 未过期)→ `add` 行 ID 形状 → `remove` 三重谓词命中 → 重复绑定 → **上限** → **V2 栅栏** → 归属预检 → 建 batch。

- 上限排在栅栏前,与 create 同序(`51 > 50` 是永久领域错误,栅栏只是暂时的发布态)。
- 栅栏条件:`projected > 1 && projected > current`。1→N 与 N→N+1 都要 `BINDING_EXPAND`;N→1 / 1→0 / 等量替换不要(AC-LIFE-11 ② 的宽读法与派单口径的交集)。V2=false 下现存数根本不可能 >1,所以 N→N+1 分支在栅栏关着时不可达。
- 上限看**投影数**不是现存数:满仓 50 时「删一个加一个」合法,有专门用例钉住。
- 全部拒绝路径都排在建 batch 之前 —— D1 没有 BEGIN,提交后没有回头路。

## 契约与实现的几处显式取舍(评审请重点看这几条)

1. **`remove` + 同一 accountId 的 `add` 判 `SHARE_BINDING_DUPLICATE`**。语义上「换个窗口快照重绑」是合理需求,但同批 INSERT 在 DELETE 之前,放行就是 UNIQUE 冲突。当前口径:让它明确失败,想重绑请分两次提交。spec 未裁,已写进用例注释。
2. **不查 `SHARE_DISABLED`**。AC-ABUSE-03 只约束「创建新的 MailShare」,`revoke` 同样不查。冻结期扩绑是否该拒,spec 没写,保持与 revoke 一致。
3. **过期/已撤销/他人 → `SHARE_NOT_FOUND`**,不发明新错误码(与 revoke 同款,不泄露存在性)。
4. **响应形状**:`{ shareId, status, shareType, bindings[] }`。`shareType` 由 Binding 计数实时派生,不落库;`status` 由剩余 Binding 数派生(0 → 已在同批转 REVOKED),让调用方不必再拉一次详情。
5. **不加幂等/指纹**(design 未要求),**不动** create 的指纹 / `FLAG_TOKENS` / `legacyCompatibleBody`,**不动** `wrangler.toml` 的 V2 开关。
6. **`security.js` 未动**:`PUT /mailShare/bindings` 目前只被 JWT 兜住,**没有** `share:manage` 精确匹配(`requirePermsExact` / `premKey` 的扩展是 T-17)。HTTP 用例现在只能证明「路由通、Owner 能用」,证不了「无 `share:manage` 被拒」。

## 遗留风险

| # | 风险 | 说明 |
|---|---|---|
| L1 | **`share:manage` 未覆盖新端点** | 持任意 JWT 的登录用户都能调 `PUT /mailShare/bindings`。越权改他人分享被 service 的 `SHARE_NOT_FOUND` 挡住(资源级谓词恒带 `user_id`),所以不是数据越权,但**路由级权限确实缺一行**,归 T-17。上线前必须补,否则 `share:manage` 的语义在 8 条路径里破了一个口。 |
| L2 | 分享在预检与 batch 之间被并发 revoke | `prepareBindingInsert` 只按 `lid` 定位,不看 `status`。极窄窗口(同一 Owner 自己 revoke 撞 bindings),后果是给一条 REVOKED 分享加了 Binding —— 不产生越权可见性(读路径先看 status),但会留下语义上多余的行。要收紧需给共用助手加 `AND ms.status = 'ACTIVE'`,会改到 create 的 SQL 文本,本轮未做。 |
| L3 | remove 与 account 级联删除并发 | 被请求的 bindingId 若在 batch 前已被级联清掉,DELETE 的 `changes` 会小于请求数,当前不报错(终态与意图一致)。孤儿/级联补偿归 T-16/T-18。 |
| L4 | 未做 API 面的权限/参数负向 HTTP 用例 | 只在 service spec 里加了 1 条 HTTP happy + 1 条 forbidden(派单允许)。完整的 `mail-share-api` 面用例留给 T-15/T-17 波次。 |
| L5 | 50 上限用例用了合成 accountId | 上限用例的 49 条填充 Binding 指向不存在的 account(`mail_share_binding` 无外键)。这测的是计数口径,不是归属;归属另有专门用例。 |

---

# 评审整改 · T-13 P0-1 / P1-1(第 2 轮)

- **日期**:2026-08-24 · **分支**:`cursor/mailbox-share-capability-dcb6`
- **只改 3 个文件**:`mail-worker/src/service/mail-share-service.js`、`mail-worker/test/mail-share-service.spec.js`、本文件。
- **未 commit / 未 push / 未 stash**;`tasks.md`、`mail-share-api.js`、`security.js`、`share-scoped-email-repository.js`、`wrangler.toml`、`mail-vue` 一字未动。
- 只做 `review-t13.md` 过筛后的 **P0-1** 与 **P1-1**,HOLD 项(T13-DUP、T-17 premKey、L1–L5)原样保留。

## 红 / 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 基线 | `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` | **155 passed** |
| 红(先写用例) | 同上 | **8 failed / 156 passed(164)** |
| 绿(实现后) | 同上 | **164 passed(164)** |
| 全量 | `pnpm --dir mail-worker test` | **17 files / 358 tests,全绿** |

红的 8 条 = P0-1 的 4 条(并发替换、49→50 并发 add、快照多出一行、快照少掉一行)+ P1-1 的 4 条(48/50 真实自有邮箱 create、create 参数预算、最大合法替换)。
新增第 9 条 `removes several bindings in one command` 在红阶段就是绿的 —— 它不是 P0-1 的复现,而是给整改本身设的护栏(见下文「一次删多条」)。

红阶段的取证:
- 并发替换用例的失败断言是 `expected [...] to have a length of 1 but got 2` —— **两条命令都成功了**,终态就是评审说的 `{B,C}`。
- P1-1 的 4 条全部死在 `D1_ERROR: too many SQL variables at offset 714`。本地 miniflare 恰好也强制了这条限制,所以这是真实报错而不是靠数占位符推断出来的。

## P0-1:CAS 怎么工作

D1 的 `batch()` 是一个事务,而两次 `updateBindings` 的**预读发生在事务之外**。原实现只在预读快照上算 cap / V2 栅栏 / remove 合法性,批后又只看 add 的 `changes`,于是两条「等量替换」都以为自己是 1→1。

整改把**预读到的 Binding 集合本身**变成写入侧的前置条件,一批四步:

1. **`prepareBindingCas`(恒为 batch 第 0 条)**
   ```sql
   UPDATE mail_share SET remark = remark
   WHERE share_id = ? AND user_id = ? AND status = 'ACTIVE'
     AND <快照谓词>
   ```
   同列自赋值:不碰 `credentials_version` / `access_count` / `account_id` / `window_start_email_id`。SQLite 的 `changes()` 数的是**匹配到的行**而不是「值变了的行」,所以 `SET remark = remark` 照样返回 1(已实测:命中 1 / 快照过期 0 / 快照 id 漂移 0)。
2. **快照谓词的唯一写法**(`snapshotPredicate()`,三处写语句共用):
   ```sql
   NOT EXISTS (SELECT 1 FROM mail_share_binding snap
               WHERE snap.share_id = <share> AND snap.binding_id NOT IN (SELECT value FROM json_each(?)))
   AND (SELECT COUNT(*) FROM mail_share_binding snap WHERE snap.share_id = <share>) = ?
   ```
   「没有快照之外的行」+「行数相等」⇒ 集合相等(`binding_id` 是全局唯一的 AUTOINCREMENT 主键)。**只有计数是不够的**:`{A}` → `{B}` 计数不变,正是评审那条 exploit 的第二批要闯的关。
3. **同款谓词进每一条写语句**。`prepareBindingInsert` 用同一段(create 传空快照 `'[]'` / `0` —— 同批新建的 share 此刻本就没有 Binding,所以两个写入口仍是**同一段 SQL 文本**,原有的「SQL 文本逐字比对」用例不用改也仍然绿)。`prepareBindingDelete` 的期望行数取 `快照 + 同批 add`,并把 add 的 accountId 加进「集合外」的豁免列表 —— 这条**顶掉了原来那条独立的 add 守卫**(少一条谓词,语义反而更强)。
4. **批后判读**,顺序即语义:
   - `results[0].meta.changes === 0` → `SHARE_BINDING_CONFLICT`(新码)
   - add `changes !== add.length` → `SHARE_ACCOUNT_FORBIDDEN`(不变,AC-BIND-10)
   - remove `changes !== remove.length` → `SHARE_BINDING_CONFLICT`

`SHARE_BINDING_CONFLICT` **不需要动 API**:`withShare` 已经把 `BizError.message` 原样放进统一信封,`mail-share-api.js` 一字未改。语义是「你手上的集合过期了,请重读再决定」—— 输的一方**不能拿同一份 remove 列表原样重试**:`{A}` 已经变成 `{B}` 时,重试只会撞成语义完全不同的 `SHARE_BINDING_FORBIDDEN`,所以错误码必须和 FORBIDDEN 分开。

**为什么批后抛错不够、必须每条写语句都带谓词**:CAS 落空是在 batch **提交之后**才读到的,`changes === 0` 不会让 D1 回滚(只有语句报错才回滚,这一点第一轮已实测)。变异校验直接钉住了这条:只掐掉 INSERT 的快照谓词(CAS 保持完好),并发替换用例立刻红。

### `syncPrimaryAccountId` 为什么没加谓词

它是**从现存 Binding 派生**出主表两列(取 `binding_id` 最小的那条),不是写请求里的值。CAS 落空时它算出来的恰好就是赢家自己那一批已经写过的值,是一次幂等重写,不产生残留;`EXISTS` 守卫仍然保证无 Binding 时零变更、绝不写 0。给它加谓词要连带改 create 侧调用(create 走 `{lid}` 定位,且 sync 时 Binding 已落库,期望值口径完全不同),收益为零、回归面很大,故不动。并发替换用例已断言输家过后主表 `account_id` 与赢家的集合一致。

### 一次删多条:依赖 SQLite 的两遍 DELETE

DELETE 的快照谓词是自引用的(子查询读的就是正在被删的表)。如果 SQLite 逐行重算,删掉第一行后计数就对不上,第二行起会全部落空 —— 那才是真正的半提交。**实测**(临时探针,取证后已删):3 条 Binding、`COUNT(*) = 3` 谓词、一次删 2 条 → `changes = 2`。即 SQLite 先收集 rowid 再删,谓词按 DELETE 之前的状态求值一次。用例 `removes several bindings in one command` 就是这条行为的护栏,SQLite 哪天换策略它立刻红。

### 变异校验(证明谓词不是摆设)

| 变异 | 结果 |
|---|---|
| 掐掉 CAS 的快照谓词 | **2 failed**(两条并发用例) |
| 掐掉 DELETE 的快照谓词 | **3 failed**(两条漂移用例 + 第一轮那条 add-归零用例 —— 说明新谓词确实覆盖了被删掉的旧 add 守卫) |
| 掐掉 INSERT 的快照谓词 | **2 failed**(两条并发用例;CAS 完好也救不了已提交的 INSERT) |
| 把 `WHERE matched = ?` 换成恒真 | **1 failed**(`inserts every add or none` —— 窗口计数确实接住了被删掉的第二组 `IN` 的职责) |

## P1-1:绑定参数预算

D1 上限 **100 / 语句**(https://developers.cloudflare.com/d1/platform/limits/)。T-13 第一轮给 `prepareBindingInsert` 展开了第二组 `IN` 做归属计数,变成 `2N+5`,N=48 即 101 —— 而这个助手是和 create 共用的,48–50 个自有邮箱的合法 create 在生产直接报错。

**保持单一 INSERT 方言**,把第二组 `IN` 换成窗口计数:JOIN 已经把 accountIds 展开过一次,`COUNT(*) OVER () AS matched` 直接数这次 JOIN 命中了几行,外层 `WHERE matched = ?` 表达「全有或全无」。窗口函数顺带强制内层先物化,所以快照谓词恒在任何一行落库之前求值 —— P0-1 的正确性反而是白捡的。

集合类参数一律「每个集合最多展开一次占位符」,需要第二处引用就走 `json_each(?)` 占一个槽(D1/SQLite 原生,已实测可用)。

### N=50 的实测占位符数(探针直接数 SQL 里的 `?`,取证后已删)

| 语句 | 公式 | N=50 |
|---|---|---|
| `prepareShareInsert` | `27 + N` | **77**(未动,评审要求「不要让它更糟」) |
| `prepareBindingInsert` | `N + 6` = flag 1 + accountIds N + user 1 + lid 1 + 快照 json 1 + 快照 count 1 + matched 1 | **56**(整改前 `2N+5` = 105) |
| `prepareBindingDelete` | `R + 5` = bindingIds R + shareId 1 + user 1 + 快照 json 1 + add json 1 + count 1 | **55**(R=50) |
| `prepareBindingCas` | 恒 4 | **4** |
| `countOwnedAccounts` 预检 | `N + 1` | **51** |

最大合法替换(现存 50、remove 50、add 50 → 投影 50)整批最高 56,离 100 还有一半余量。用例 `keeps the largest legal replacement under the limit` 与 `keeps every create statement under the limit at SHARE_BINDING_LIMIT` 把「本批没有任何语句超过 100」写成了断言,不是靠人算。

48 / 50 两条 create 用例用的是 **`seedOwnedAccounts()` 造出来的真实自有 account**(评审明确点名:合成 id 在 `assertOwnedAccounts` 就被拒,根本走不到 SQL)。

## 遗留风险(本轮新增)

| # | 风险 | 说明 |
|---|---|---|
| L6 | DELETE 快照谓词依赖 SQLite「先收集 rowid 再删」 | 已实测成立并有护栏用例。若未来 SQLite 对含自引用子查询的 DELETE 启用 one-pass,`removes several bindings in one command` 会立刻红;届时的解法是把计数口径换成「不被删的那部分」(`快照 \ remove`),那个形状对自身删除天然免疫。 |
| L7 | `SHARE_BINDING_CONFLICT` 未进 design.md 的错误码表 | 派单禁止改 spec 文档。API 层不需要改(`BizError` 已统一映射),但 `design.md` §Error Handling 与前端文案缺这一行,需要一个 spec 同步动作补齐。 |
| L8 | CAS 用 `SET remark = remark` | 依赖「`changes()` 数匹配行而非变更行」这条 SQLite 语义(已实测)。它同时意味着每次 bindings 变更都会重写一次 `mail_share` 行 —— 无触发器、无 `updated_at`,当前无副作用,但将来若给该表加触发器需要重新评估。 |
| L9 | 并发窗口仍在预读侧 | CAS 只保证「快照漂移就整批零变更」,不保证无锁重试。输家拿到 `SHARE_BINDING_CONFLICT` 后必须重读集合再发一次;自动重试(以及要不要给 bindings 加幂等键)不在 T-13 范围。 |
