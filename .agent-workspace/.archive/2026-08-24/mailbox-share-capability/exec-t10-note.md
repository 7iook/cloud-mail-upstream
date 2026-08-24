# T-10 执行记录 · scoped repository 集合化 + per-binding window + message_limit DESC 截断

分支 `cursor/mailbox-share-capability-dcb6` · 基线 HEAD `5ebb8a8` · 未提交(按派发要求不 add/commit/push)。

## 成功状态复核

访客用已建立 Session 看绑定邮箱时，只能看到各 Binding 自己窗口内、且不超过 `messageLimit` 的最新邮件；他邮箱行 / 窗口外 / 被 N 滚出 / `account_id=0` / `is_del!=NORMAL` / `status=SAVING` 一律不出现。全部由 SQL 强制，应用层不裁剪数组。

## 红 → 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 红 | `pnpm --dir mail-worker exec vitest run test/share-scoped-email-repository.spec.js --no-cache` | EXIT=1 · **12 failed / 1 passed / 13** |
| 绿 | 同上 | EXIT=0 · **13 passed / 13** |

红灯成因是功能缺失而非断言写错：`listForBinding is not a function`、ASC 序返回、per-binding 下界与 N 截断均不存在。

旁证（非本任务 owner 的文件，只跑不改）：

- `pnpm --dir mail-worker exec vitest run test/share-mail-service.spec.js test/share-attachment-service.spec.js --no-cache` → EXIT=0（7 + 15 = 22 passed，这两套 mock 掉了 repo）。
- 全量 `pnpm --dir mail-worker exec vitest run --no-cache` → EXIT=1。失败分三处：本任务外溢 2 条（见「遗留」），另 21 条是 T-13 在同一工作树进行中的 `mail-share-service.spec.js`（`default.updateBindings is not a function`）+ `test/zz-probe.spec.js`，与 T-10 无关。

## 落地文件

- `mail-worker/src/service/share-scoped-email-repository.js:1-160`（整文件改写）
  - `:27-72` ctx 解析：`toScope` / `resolveScopes` / `resolveMessageLimit` / `resolveCursor` / `resolveLimit` / `resolveRowId`
  - `:74-105` **range SSOT** `visibleSubquery`：`inArray` + `or(and(eq(account), gt(window)), ...)` + `account_id>0` + `is_del=NORMAL` + `status!=SAVING`，外挂 `row_number() over (partition by account_id order by email_id desc)`
  - `:107-122` `selectVisible`：`row_no <= messageLimit` + 游标 + `order by email_id desc` + `limit`
  - `:124-157` `list` / `listForBinding` / `getById` 三个入口，全部走同一 SSOT
- `mail-worker/test/share-scoped-email-repository.spec.js:1-385`（整文件改写，13 用例）

未改任何其他文件（`share-mail-service.js` / `share-attachment-service.js` / `share-auth-service.js` / `mail-share-service.js` / API / security / i18n / wrangler / tasks.md 零改动；`mail-vue` 零改动；无新依赖；未开 `SHARE_CAPABILITY_V2`）。

## 关键实现口径

### 一份范围模型（SSOT）

`list` / `listForBinding` / `getById` 都调 `visibleSubquery(c, scopes, messageLimit)`，没有第二套 window 实现。三者的差别只有：scopes 从哪来、外层再加什么谓词（游标 / `email_id = ?`）。

### N 截断在 SQL 内

`row_number() over (partition by account_id order by email_id desc)` 在子查询里算，外层 `where row_no <= N`。`messageLimit` 为 null 时不加这个谓词（无上界，仍受 50 封顶）。应用层没有任何 `slice` / `sort` / 手工归并。

实测生成的 SQL 与计划（EXPLAIN QUERY PLAN，双 Binding + N=5 + 游标）：

```
MULTI-INDEX OR
  SEARCH email USING INDEX idx_email_account_id_email_id (account_id=? AND email_id>?)
  SEARCH email USING INDEX idx_email_account_id_email_id (account_id=? AND email_id>?)
```

无表扫描，仍吃 AC-RT-04 那条索引。窗口函数在 D1 / miniflare 本地 SQLite 上可用（已跑通）。

### 游标（DESC）

- 语义从「`email_id > cursor` 取更新」翻成 **`email_id < cursor` 取更旧**；排序 `email_id DESC`；首页不传 cursor。
- 非法 / 空 cursor（`null` / `''` / `'not-a-number'`）→ 视为无游标取首页，不抛。
- 稳定性：新邮件 id 更大，落在 `< cursor` 之外，所以**翻页过程中到达的新邮件不会插进已翻的页**，同一 cursor 重读结果恒等（旧 ASC 语义下反而会让尾页增长）。不重不漏由「严格小于 + 页内 DESC 连续」保证，用例里做了 1 条/页的全量 walk 断言。
- 截断与游标的先后：`row_number` 在子查询算完再套游标，所以每页的 N 是同一个全局最新 N，不会「每翻一页重新算 N」。

### bindings vs 垫片

`resolveScopes(ctx)`：`Array.isArray(ctx.bindings) && length > 0` → 只认 `bindings`，**垫片 `accountId`/`windowStartEmailId` 完全忽略**（垫片本就是 `bindings[0]` 派生，取并集只会放大范围）；否则退化为把 `ctx` 自己当成单个 scope，`share-mail-service.js:96-98` 那条无 bindingId 的老调用与旧垫片 ctx 因此照常工作。任一 scope 的 `accountId <= 0` 或 window 非有限数 → 该 scope 丢弃；全丢光 → `[]` / `null`，不抛可区分错误。

`listForBinding(c, ctx, bindingId, cursor?, limit)` 只按 `bindingId` 精确匹配 `ctx.bindings` 里的一条；不在集合内（含未知 id / `null` / `0` / `-1` / `'x'` / `{}` / 垫片 ctx 无 bindingId）一律空集，与「该 Binding 存在但零邮件」不可区分。

### limit

`resolveLimit(limit, cap) = min(requested || 20, 50, cap ?? ∞)`。`listForBinding` 的 cap 取 `messageLimit`（design.md `:370` 的 `行数 ≤ min(limit, 50, ctx.messageLimit ?? ∞)`）。`list` 只在**单 scope** 时取 `messageLimit` 作 cap：多 scope 时每个邮箱的最新 N 已由 SQL 各自截断，总量再压到 N 会让排序靠后的邮箱一封都拿不到（两邮箱 N=2 应得 4 行）。

## 遗留风险

1. **两条 ASC 黄金断言外溢**：主 AI 已按 DESC 消费方改写（同批 T-10 commit）：
   - `mail-worker/test/share-api.spec.js:447,451` → page1=`[ids[2], ids[1]]`，page2=`[ids[0]]`
   - `mail-worker/test/share-integration.spec.js:766` → `all === [ids[2], ids[1], ids[0]]`
   - `share-api.js:69-71` nextCursor 仍取本页最后一行，DESC 下即本页最旧，API 未改。
   - E2E `listMails` 用 `.find()`，不依赖顺序。
2. `share-integration.spec.js:517-529` 的 AC-RT-04 计划探针跑的是**手写 ASC SQL**，不是 repo 真实语句，所以它是绿的但已不代表现网查询形状。真实语句的计划见上（仍走同一索引）。建议后续把探针换成 repo 真实 SQL。
3. 同一 share 下两条 Binding 指向同一 `account_id` 时，`row_number` 按 account 分区、`or` 取更松的窗口，N 会按邮箱而非按 Binding 生效。DDL `UNIQUE(share_id, account_id)` 已排除该形状，未额外去重。
4. 每页代价是 O(窗口内行数)：`row_number` 与跨 Binding 归并都在 `LIMIT` 之前物化。源码 `:79-81` 留了 `ponytail:` 标记与升级路径（per-binding `UNION ALL (... ORDER BY email_id DESC LIMIT n)`）。当前用例规模无感。
5. T-11 承接：详情/附件可见集复查现在有 `getById`（已含 window ∩ 最新 N）与 `listForBinding` 可直接消费；`share-attachment-service.js` 里 `shareContext.accountId` 的单值假设仍未改（T-11.4 范围）。
6. 返回行仍是 `email` 全列（子查询里的 `row_no` 已在外层 select 剔除，行形状与改造前一致），投影白名单仍由 T-11 的 `project` 负责。
