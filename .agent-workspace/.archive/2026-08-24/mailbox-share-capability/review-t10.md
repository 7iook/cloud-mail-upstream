# T-10 独立代码审查

**VERDICT: APPROVED**

**一行摘要：** `bca7bc2` 以同一 SQL 可见集约束 `list` / `listForBinding` / `getById`，正确落实 per-binding window、每邮箱最新 N、DESC 游标与负向隔离；未发现需修改的真实缺陷。

## P0 / P1 / P2

| 级别 | 数量 | Finding | 处置 |
|---|---:|---|---|
| P0 | 0 | 无 | — |
| P1 | 0 | 无 | — |
| P2 | 0 | 无 | — |

## 核验结果

| 检查项 | 证据与结论 |
|---|---|
| 单一范围 SSOT | `visibleSubquery` 同时承载 Binding 集合、每 Binding 下界、`account_id > 0`、`is_del=NORMAL`、`status!=SAVING` 与最新 N 排名；`list`、`listForBinding`、`getById` 均经该子查询，无第二套 window 条件。 |
| N 截断位置 | `row_number() over (partition by account_id order by email_id desc)` 在 SQL 子查询排名，外层以 `row_no <= messageLimit` 截断；不存在 JS `slice`。`getById` 也先经过同一排名/截断再按 id 取行。 |
| DESC 与游标 | 外层 `orderBy(desc(email_id))`，游标谓词为严格 `email_id < cursor`；API 与 integration 的黄金值仅按该契约由 ASC 改为 DESC。 |
| Binding 真源 | `bindings` 非空时仅消费集合并忽略 shim；`bindings` 缺失或为空时回落到 `ctx` shim，旧 `shareMailService.list` 仍可调用。 |
| 单 Binding 查询 | `listForBinding` 先把输入规范为正整数，再只保留匹配 `bindingId` 的 scope；未知、非法或无上下文 id 均返回空数组。 |
| 负向隔离 | SQL 同时限定 account 集合、逐 Binding window、正 account、NORMAL、非 SAVING；测试覆盖他账户、窗口下方、`account_id=0`、删除态、SAVING 与最新 N 滚出。 |
| 多 Binding 总量 | 最新 N 在 `account_id` 分区内逐邮箱执行；外层 `limit<=50` 只是全局分页大小，不会把 per-mailbox N 错做全局 N。 |
| SQL 注入 | scope、cursor、limit 与 N 均先数值化/校验；Drizzle 模板插值生成绑定参数，未把调用方字符串拼入 raw SQL。 |
| `messageLimit` 边界 | `null` 按设计表示不限；`0` 不是有效持久化配置（设计域为 NULL 或 `>=1`，写入口拒绝 0），因此不构成有效冻结 ctx 的可达泄漏路径。 |
| 重复 account scope | 有效数据受 `UNIQUE(share_id, account_id)` 约束；合法 ShareContext 中每邮箱一条 Binding，按 `account_id` 分区等价于按 Binding 分区。 |
| 禁止依赖 | 本生产文件不调用 `resolveSession`，不读取 `mail_share.account_id`；测试直接构造冻结 ctx。 |

## HOLD vs CHANGE

| 决策 | 项目 | 理由 |
|---|---|---|
| HOLD | `messageLimit=0` 的防御性语义 | 0 被 Owner 写入口拒绝，数据库契约只允许 NULL 或 `>=1`；不把无效内部状态升级为本任务缺陷。 |
| HOLD | 多 Binding `list` 的全局 50 行分页上限 | 这是页大小上限；每邮箱最新 N 已在游标之前独立截断，可继续分页，不违反“至多 N”。 |
| HOLD | 执行记录所述真实 SQL 性能探针后续替换 | 当前查询仍使用既有索引，且这是性能探针质量而非本次范围隔离正确性缺陷。 |
| CHANGE | 无 | 无 P0/P1/P2 finding。 |

## Verification

```text
git show bca7bc2 --stat
=> 5 files changed, 477 insertions(+), 186 deletions(-)

git diff --quiet bca7bc2 -- \
  mail-worker/src/service/share-scoped-email-repository.js \
  mail-worker/test/share-scoped-email-repository.spec.js \
  mail-worker/test/share-api.spec.js \
  mail-worker/test/share-integration.spec.js \
  .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t10-note.md
=> EXIT=0（当前 scoped files 与目标提交一致）

pnpm --dir mail-worker exec vitest run \
  test/share-scoped-email-repository.spec.js \
  test/share-api.spec.js \
  test/share-integration.spec.js \
  --no-cache
=> EXIT=0；3 files passed；34 tests passed
```

测试 stderr 含既有迁移重复列/跳过字段及 workerd 清理噪声，但无失败用例，未发现其与 T-10 行为相关。
