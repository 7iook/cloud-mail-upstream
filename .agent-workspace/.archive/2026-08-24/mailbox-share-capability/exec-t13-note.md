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
