VERDICT: APPROVED

# T-15 P1-1 / P1-2 修复复审

复审对象：仅提交 `cccb3bb`（`fix(worker): page status-only list and gate delete`）。后续 `c6c67fe`、`25c5588` 仅改 Evidence / tasks 文档，不纳入本轮缺陷判断。

## P0

无。未发现新增 P0。

## T15-P1-1 关闭结论

CLOSED。

- `normalizeListPaging` 现在分别识别 `page/size` 与 `status`；仅两者都缺席时返回 deprecated 500 行兼容转储。
- `{ status: 'ACTIVE' }` 会进入分页分支，缺省得到 `page=1`、`size=20`、`limit=20`，响应不含 `deprecated`。
- 新回归造 25 条 ACTIVE 分享，实际断言 `total=25`、`page=1`、`size=20`、首页 20 行且 `deprecated` 为 `undefined`。
- `{}` 仍进入 `{ paged:false, limit:500 }`；既有回归造 505 行，断言返回 500 行、`total=505`、`deprecated=true` 且无 `page`，旧无参 list 形状和 DESC 顺序保持。
- 目标文件整套 198 项测试通过，覆盖既有分页、状态筛选、Binding 摘要和 HTTP 无参 list 基线。

## T15-P1-2 关闭结论

CLOSED。

- Binding 与 idempotency 两条子表 DELETE 现在同形：均以子表 `share_id = ?` 定位，并通过仍存在的 `mail_share ms` 按 `ms.share_id = ? AND ms.user_id = ?` 做 Owner EXISTS 回查。
- idempotency DELETE 已移除 `share_idempotency.user_id = ?` 门禁；Owner 删除时会按 share_id 清理全部幂等行，包括 child `user_id` 漂移行。
- 三条语句仍位于同一个 `c.env.db.batch()`，顺序保持为 `mail_share_binding` → `share_idempotency` → `mail_share`；主表最后以 `share_id + 当前 user_id` 删除。
- 新反例证明他人 share 下即使存在“share_id 相同、child user_id 等于调用方”的 mismatch 幂等行，调用方删除仍返回 `SHARE_NOT_FOUND`，主表、Binding、Owner 幂等行及 mismatch 幂等行均保留。
- 新正例证明 Owner 删除自己的 share 时，Owner 幂等行和 child `user_id` 漂移行一并清零。

## Requirement checks

| 检查项 | 结论 | 证据 |
|---|---|---|
| 指定提交范围 | PASS | 已执行 `git show cccb3bb --stat`；提交共改 4 个文件、`63 insertions(+), 7 deletions(-)`。已执行指定两文件的 `git diff cccb3bb^..cccb3bb -- ...`，生产差异仅为分页判定、DELETE 门禁及注释，测试差异为 3 条定向回归与 1 个计数 helper。 |
| P1-1 · status-only 默认分页 | PASS / CLOSED | 25 条 ACTIVE 回归实际通过：20 行、page 1、size 20、无 deprecated。 |
| P1-1 · 真正无参兼容 | PASS | 505 行无参回归实际通过：500 行硬顶、真实 total、deprecated=true、无 page；旧 list 相关基线随整文件套件通过。 |
| P1-2 · 同形 Owner EXISTS | PASS / CLOSED | 两条子表 DELETE 都回查 `mail_share(share_id,user_id)`；idempotency 不再以自身 `user_id` 作为唯一门禁。 |
| P1-2 · mismatch 与漂移反例 | PASS | 他人 share 的调用方 mismatch 幂等行保留；Owner 删除时 child user_id 漂移行一并清除，两条定向测试均通过。 |
| 子表先、主表后 | PASS | 同一 batch 中依次删除 Binding、idempotency、主表。 |
| 新 P0 | PASS | 未发现。 |

## 测试与证据

```sh
git show cccb3bb --stat
git diff cccb3bb^..cccb3bb -- mail-worker/src/service/mail-share-service.js mail-worker/test/mail-share-service.spec.js
git diff --check cccb3bb^..cccb3bb
pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache
```

结果：

- `git diff --check`：EXIT=0。
- Vitest：EXIT=0；`1` 个测试文件通过；`198/198` 个测试通过。
- 输出仅有初始化阶段既有的 `auto_refresh_time` 缺列跳过提示，无失败断言。

## VERDICT

status: APPROVED
critical_count: 0
important_count: 0
ready_to_merge: YES
one_line: T15-P1-1 与 T15-P1-2 均按既定 CHANGE 闭环；status-only 默认分页、真正无参 500 行兼容、幂等 DELETE Owner 回查及 child user_id 漂移清理均有通过的定向回归。
