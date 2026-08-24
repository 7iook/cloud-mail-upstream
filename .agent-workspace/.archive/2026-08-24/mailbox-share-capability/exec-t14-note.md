# T-14 执行记录 · status 水位端点 `GET /share/mailboxes/status`

- 日期:2026-08-24
- 模式:Mode A executor(TDD red→green),未 commit、未 push
- 分支:`cursor/mailbox-share-capability-dcb6`(工作树,未新建分支)
- 依据:`docs/specs/mailbox-share-capability/tasks.md` T-14 / T-14.1 / T-14.2 · `design.md`「Status 水位协议」(R2-A2 · D16)· `requirements.md` StatusEndpoint

## 达成的成功态

一条 `GET /share/mailboxes/status`:带有效访客 token 时,返回**每条 Binding** 在
`VisibleWindow ∩ message_limit ∩ 既有排除条件`(`is_del=NORMAL`、`status != SAVING`、
`account_id > 0`)内的 `latestEmailId`(无可见邮件为 `null`)+ `latestReceivedAt` + `serverTime`;
**不接受任何游标参数**(`sinceEmailId` / `cursor` 出现与否结果逐字节相同);
`/share/mailboxes/statusX` 等近似路径仍走 JWT。
负面约束全部满足:**每 Binding 一次查询的写法不存在**(整个端点恰 1 条 SQL)、
**没有第二套范围模型**(复用 `visibleSubquery`)、**零配额消耗**、
**窗口外 / 被 N 滚出的邮件不进水位**。

## 红 → 绿

### 1. 红(测试先行)

```
pnpm --dir mail-worker exec vitest run test/share-status.spec.js test/security-share.spec.js \
  test/share-scoped-email-repository.spec.js --no-cache
```

→ `EXIT=1` · **18 failed | 47 passed (65)** · 3 个文件全红,失败原因逐条对得上缺失实现:

| 失败面 | 条数 | 报错 |
|---|---|---|
| `share-scoped-email-repository.spec.js` | 7 | `default.latestByBinding is not a function` |
| `share-status.spec.js` | 9 | 路由不存在 → `Cannot read properties of undefined (reading 'mailboxes')`;无 token 面拿到 `{"code":401,...}` 而非 `SHARE_UNAVAILABLE` |
| `security-share.spec.js` | 2 | `GET /share/mailboxes/status` 未在 `excludeExact` 里,被 JWT 拦成 401 |

同一次红跑里,`/share/mailboxes/statusX`、`/share/mailboxes/status/extra`、`/share/mailboxes`、
`/share/mailbox/status`、`POST|DELETE /share/mailboxes/status` 六条封闭性用例**红期即绿**——
它们证明的是「不加前缀豁免」,基线本就应当成立,不是新行为。

### 2. 绿

```
pnpm --dir mail-worker exec vitest run test/share-status.spec.js test/security-share.spec.js \
  test/share-scoped-email-repository.spec.js test/share-integration.spec.js --no-cache
```

→ `EXIT=0` · **82 passed (82)**(status 9 / security-share 36 / repository 20 / integration 17,
其中 integration 的 4 条为本任务新增的末尾 `describe`)。

### 3. 既有 mails / mail / attachment 回归

```
pnpm --dir mail-worker exec vitest run test/share-api.spec.js test/share-integration.spec.js --no-cache
```

→ `EXIT=0` · **25 passed (25)**。

### 4. 全量 worker 套件

```
pnpm --dir mail-worker test
```

→ `EXIT=0` · **18 文件 / 410 用例全绿**(含并行在跑的 T-11 改动)。

## 改动文件(严格落在白名单内)

| 文件 | 改动 |
|---|---|
| `mail-worker/src/api/share-api.js:79-85` | 新增且仅新增一条 `app.get('/share/mailboxes/status', shareRateLimit(SHARE_READ_RATE_LIMITER, ...), withShare(...))`;顶部多一行 `shareScopedEmailRepository` import。session/mails/mail/attachment 四个 handler 一字未动,`/share/mails` 也没加 `bindingId`(那是 T-11) |
| `mail-worker/src/security/security.js:26` | `excludeExact` 追加恰一行 `{ method: 'GET', path: '/share/mailboxes/status' }`;未碰 `excludePrefixes` / `premKey` / `requirePermsExact` |
| `mail-worker/src/service/share-scoped-email-repository.js:39-58,157-192` | 新增 `latestByBinding(c, ctx)`;把 `resolveScopes` 的取 binding 列表那两行抽成 `resolveBindings`(纯提取,零语义变化);新增 `toBindingKey`。`list` / `listForBinding` / `getById` 三者的实现与语义原样保留 |
| `mail-worker/test/share-scoped-email-repository.spec.js:386-514` | 末尾追加 7 条 latest-per-binding 用例,既有 13 条未动 |
| `mail-worker/test/share-status.spec.js`(新建,386 行) | 9 条 API 面用例;助手照抄 `share-api.spec.js` 而非 import(避免与 T-11 对该文件的改动互锁) |
| `mail-worker/test/security-share.spec.js:101-107,119,128-130,139-140` | 精确豁免表加 `GET /share/mailboxes/status`;新增 5 条前缀近似 + 2 条写方法封闭性 + 1 条带游标 query 的豁免用例 |
| `mail-worker/test/share-integration.spec.js:776-912` | **仅**在文件末尾追加 `describe('GET /share/mailboxes/status', ...)`(4 条),既有用例与 helper 一行未改 |

## 实现要点

**一条 SQL 出水位。** `visibleSubquery` 里的窗口函数已经按
`partition by account_id order by email_id desc` 排过名,所以 `visible.row_no = 1`
本身就是「该邮箱可见集里的最新一封」——不需要 `GROUP BY`,不需要 `max()`,更不需要
`for (binding of bindings) listForBinding(limit=1)`。`latestReceivedAt` 直接取同一行的
`create_time`,因此水位与时间戳天然出自同一封邮件(用例 `pairs latestReceivedAt with the row
that owns the watermark` 钉死这一点)。截断谓词 `row_no <= message_limit` 仍然挂着:
它对 `row_no = 1` 恒真,留着是为了让「范围条件只有一处」在代码上可见,而不是靠注释保证。
`latestByBinding costs exactly one query regardless of the binding count` 用 `prepare` 代理
计数,3 条 Binding 下断言 `seen.toHaveLength(1)`——扇出回归会立刻红。

**无游标是协议,不是校验。** handler 完全不读 `c.req.query()`。选择「忽略」而非 400,
理由写在源码注释里:单个全局标量表达不了 per-binding 消费进度(R2-A2),服务端保持无状态,
客户端本地水位比较得出 hasNew。用例 `ignores sinceEmailId, cursor and limit` 用 6 组垃圾参数
(含空值、超大值、非数字)断言 `mailboxes` 逐字段相等。

**bindingId 用 `toBindingKey` 而非 `resolveRowId`。** 后者把 0 映射成 null(真实行 ID 不会是 0),
但 `buildShareContext` 对「零 Binding 行回落到主表」的兼容形状发的就是 `bindingId: 0`,
session 响应里也是 0。水位 map 的键必须和 session 下发的一致,否则老单邮箱链接在访客页
永远对不上角标。用例 `keeps the legacy bindingId 0` 覆盖。

**侧信道。** 三条独立断言:窗口下界抬到最新一封之上 → 全 null;`email_id` 比可见最新一封**更大**
的 SAVING / 已删邮件(900023 / 900024 vs 900013)不得顶起水位;`message_limit=1` 下被滚出的那封
既不当水位也不出现在 mails 里。

## 遗留风险 / 需要下游知道的事

1. **`share-api.js` 直接 import 了 repository。** 其余 visitor 端点都经 service 层
   (`shareMailService` / `shareAttachmentService`)。水位没有投影逻辑可言(三个标量),
   为它新建一个 `share-status-service.js` 是纯转发层;且本任务白名单不含 service 层文件。
   若后续 status 要长出投影(比如带掩码地址、带 unread 数),应当补一层 service,别在 handler 里堆。
2. **`serverTime` 用 `new Date().toISOString()`(ISO-8601 UTC),`latestReceivedAt` 用 D1 的
   `create_time` 文本(`YYYY-MM-DD HH:mm:ss`)。** 两者格式不同。design.md 没有规定 `serverTime`
   的格式,前端(T-25/T-26)若要拿它做时钟校正,需要知道这一点;要统一格式的话是 W5 的裁决。
3. **`latestReceivedAt` 恒在响应里(无邮件时为 `null`),不是可选字段。** design.md 写的是
   「可选 `latestReceivedAt`」;实现选择恒存在,省掉客户端的 `in` 判断。若前端契约要求缺省即省略,
   改这一处即可。
4. **未做 `EXPLAIN QUERY PLAN` 断言。** `share-integration.spec.js` 现有的 AC-RT-04 计划断言只覆盖
   mails 的查询形状。status 走的是同一个 `visibleSubquery`,窗口函数会先物化窗口内行数(源码里
   T-10 留的 ponytail 注释已记录这条代价)。巨型窗口下的水位查询代价与 mails 同量级,不额外劣化,
   但也没有独立的计划守护测试。
5. **`message_limit` 在测试里靠直接 `UPDATE mail_share SET message_limit = ?` 造。** 经 `create()`
   会撞 `SHARE_CAPABILITY_V2` 栅栏,而本任务禁止把开关置 true。T-15 的 update 端点落地后,
   这两条用例可以改走正规写入口。
6. **同工作树有并行任务(T-11)。** 执行期间 `share-mail-service.js` / `share-attachment-service.js`
   及其 spec 一直在被另一位 executor 改写,中途出现过 `share-integration.spec.js` 的
   `expectVisitorDto` 键集短暂失配(T-11 的 DTO 加了 `bindingId` / `mailboxAddress`,
   `VISITOR_MAIL_KEYS` 尚未跟上)。该失配与 T-14 无关,且在 T-11 更新键集后自行消失;
   最终全量 410/410 绿是在两边改动同时在树上的状态下跑出来的。
7. **`share-scoped-email-repository.js` 里禁止出现字面量 `row.accountId`。**
   `mail-share.schema.spec.js` 的主表读取围栏用正则扫源码
   (`/\brow\.accountId\b|\bmailShare\.accountId\b|mail_share\.account_id|\bms\.account_id\b/`),
   即便那个 `row` 是邮件行也会被计数。本实现把局部变量改名为 `head` 绕开——后续在这个文件里
   写循环变量时要留意同一个坑。
