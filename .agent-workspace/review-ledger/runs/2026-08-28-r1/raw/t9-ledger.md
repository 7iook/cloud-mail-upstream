# T9 · 审查台账自身的落盘、关闭回写与空轮记录

结论：NEEDS_CHANGES（P1 × 1）

## T9-F1 · F-0004 的失效关闭仍被记作 resolved

- severity: P1
- anchor: `.agent-workspace/review-ledger/ledger.jsonl:4`
- symbols: `F-0004`, `status`, `close_note`, `prepareShareBatchComplete`, `INDEX SNAPSHOT`
- rule_source: `.agent-workspace/review-ledger/INDEX.md:3-5` 规定追加区保存历史、覆盖区表达当前状态；`.agent-workspace/review-ledger/runs/2026-08-28-r1/reviewer-l0-l1.md:32-38` 规定 `resolved` 条目后续不再报告；F-0004 自身的关闭条件是批内完整性哨兵把零行 INSERT 变成错误并回滚整批。
- identity_scope: `review-ledger/F-0004 resolution lifecycle × current-open P1 snapshot`
- failure_mode: F-0004 仍是 `status: resolved`，`close_note` 把 `0f4f52c + 8a80014` 的 `SELECT 1/0` 哨兵记为关闭证据；`790c550` 的实测结论却是 SQLite 除零返回 NULL、该哨兵从未触发回滚，并从当前代码删除了 `prepareShareBatchComplete` 与 `isPartialInsert`。当前 `createFromEmails` 在 `db.batch()` 返回后才检查 `shareRows.every(row.meta.changes)`，与 F-0004 所记的“批内错误回滚”关闭条件不相符。
- trigger: 下一轮 sweep 按 `ledger.jsonl` 的 `resolved` 状态执行 resolve-once 过滤，或按 `INDEX.md` 覆盖区判断当前 P1 数量。
- impact: 一个没有有效关闭证据的 P1 被排除出 carryover；`INDEX.md:10` 因而显示 `P1=0`，后续审查不会继续追踪批量创建零行 INSERT 与整单拒绝的部分写入风险。
- required_fix: 在台账生命周期层撤销 F-0004 的旧关闭事件：保留历史关闭记录，但在本轮 decisions 中把该次 resolution 标为被 `790c550` invalidated，并把 F-0004 恢复为 `open/persists`；当前 `ledger.jsonl` 写入新的现状与验证口径，`INDEX.md` 覆盖区重算为 `P1=1`。不要把 F-0004 本身终结为 `invalidated`，否则 L0 仍会过滤它；被 invalidated 的是旧关闭判定。
- verify: 解析当前 `ledger.jsonl`，断言 F-0004 为 `open` 且最新裁决引用 `790c550`；解析本轮 `decisions.json`，断言旧 resolution 被撤销且 F-0004 进入 `persists`；重算 open severity 后断言 P1=1，并与 `INDEX.md` 覆盖区一致。
- risk_spread: none

## 已查证且未形成 finding

- 空轮分支基线错位未污染旧轮产物：`git diff --exit-code c0a4a45 c0ede67 -- .agent-workspace/review-ledger/runs/2026-08-26-r1/` 实跑退出 0；`ledger.jsonl` 在该 merge 前后也无差异。
- `state.json` 的 `refs` 确实由对象收敛为 `ref → sha`，但仓内未找到消费该对象旧字段的代码；空轮的 `phase0-refs.json` 仍逐 ref 保存 `status`、完成原因、PR、`in_ledger` 与 cursor 证据，当前简化映射与这些 cursor 一致，故没有可复现的字段丢失故障。
- `run_seq: 1` 与 `last_run_id: 2026-08-27-r1` 的 `r1` 一致；`INDEX.md` 的“累计轮次: 3”与下方三条审查记录一致，两者不是同一计数口径。
- 空轮没有误推游标：`state.json` 的 `cursor_advanced: false`、`last_reviewed_sha=9b6eb80`、`origin/main=12cec61`，与空轮 scope/decisions 及 `INDEX.md:11` 的“本轮未推进”一致。
- `.gitignore` 当前仅有一组 review-ledger 放行规则（第 48-49 行）；两个 merge parent 与 merge 结果均各一组，无重复。
- 结构校验实跑：`ledger.jsonl` 30 行全部可解析；`state.json`、两轮 `decisions.json`/`scope.json` 可解析；当前重算 open 为 P2=14、suggestion=1、P1=0，精确复现了失效关闭造成的覆盖区结果。
