# T-12 Review-Fix Re-review R2

**VERDICT: APPROVED**

范围：独立复审 `bc2b4e2..6b5d29b`；当前分支 `cursor/mailbox-share-capability-dcb6`，HEAD `66d7455`。`git log bc2b4e2..6b5d29b` 仅含生产修复 `6b5d29b`。后续文档提交 `66d7455` 只改 Evidence/台账/任务文档，`git diff --exit-code 6b5d29b..66d7455 -- mail-worker/src/service/mail-share-service.js` 为 EXIT 0，未改写目标生产文件。工作区原有未跟踪文件均排除。

## Strengths

- `mail-worker/src/service/mail-share-service.js:198-228` 将兼容范围封在单一 helper：单邮箱且配额为空、AuthKey 关闭、所有 flag/refresh 保持默认时，持久化旧四字段 SHA-256，同时重放接受 modern 与 legacy 两个 hash。
- `mail-worker/src/service/mail-share-service.js:415-423,565-600,630-680` 的首次查询、唯一键竞态恢复与零变更恢复均使用同一 `accepted` 集合；修复不只覆盖无竞态 happy path。
- `mail-worker/src/service/mail-share-service.js:114-139` 在归一化边界精确封闭 flag token，并在 `Number(...)` 前按原始类型拒绝 boolean count，错误统一为 `SHARE_INVALID_CONFIG`。
- 回归测试直接覆盖 old→new 重放、new→old 落库旧 hash、非兼容载荷不落旧 hash、非法 flag/count 及既有 boolean create。

## P0 / P1 / P2 findings

| id | severity | file:line | conclusion | independent verification |
|---|---|---|---|---|
| P0-1 | Critical · **CLOSED** | `mail-worker/src/service/mail-share-service.js:193-228,415-423,630-680`; `mail-worker/test/mail-share-service.spec.js:1094-1150` | legacy-compatible create 落旧四字段 hash，重放双认 old/modern；multi、AuthKey、有限配额、任一非默认 flag/refresh 均由 `legacyCompatibleBody` 返回 `null`，只使用 modern hash。old→new 与 new→old 两条滚动路由回归均已存在。 | 独立 Node WebCrypto 对 `{accountId:909101,durationSeconds:3600,name:'',remark:''}` 复算：old=`d5c870aaf938ac6df25f53f9847c50073d56e7abcac76be846b786af95e852bf`，modern=`6ddde52742eae28fe8de1b8a5490e04900d2c7d207730b08beca5597caab8a33`，`match=false`。代码对兼容载荷返回 `{stored: legacyHash, accepted: [modern, legacyHash]}`；非兼容分支返回 `{stored: modern, accepted: [modern]}`。 |
| P1-1 | Important · **CLOSED** | `mail-worker/src/service/mail-share-service.js:114-139`; `mail-worker/test/mail-share-service.spec.js:826-897,1043-1089` | `toFlag` 仅接受 `true/false/0/1/'0'/'1'/'true'/'false'`，`null`/`undefined`/`''` 回落默认；其余值抛 `SHARE_INVALID_CONFIG`。`toNullableCount` 只对 number/string 做数值转换并要求 safe integer，因此 `true`/`false` 均被拒绝。既有 boolean true/false create 仍有效。 | 表驱动负向测试覆盖五个 flag × `['invalid',2,{}]`、两个 count × `[true,false,'invalid']`；正向测试覆盖允许 token、显式 boolean false/true、默认 boolean 及配置落库。指定 focused suite 132/132 通过。 |
| — | — | — | 未发现新的 P0、P1 或 P2 finding。 | `git diff --check bc2b4e2..6b5d29b` 为 EXIT 0；生产 diff 未引入新的吞错、明文 secret 或并行指纹实现。 |

## Requirement checks

| 检查项 | 结论 | 证据 |
|---|---|---|
| P0-1 / old→new replay | PASS | 测试先写入旧四字段 `request_fingerprint`，再由当前 create 用同 key/载荷重放；断言同 share/lid、`idempotentReplay=true`、无 sec/AuthKey、share 数仍为 1。 |
| P0-1 / new→old stored hash | PASS | 当前 create 后直接读 `share_idempotency.request_fingerprint`，断言等于独立 legacy 四字段 hash。 |
| P0-1 / non-legacy modern-only | PASS | `legacyCompatibleBody` 对 account 数非 1、任一有限 count、AuthKey、任一非默认 flag 或 refresh 立即返回 `null`；返回路径只保存/接受 modern hash。既有矩阵还证明这些字段进入 modern 指纹。 |
| P1-1 / flag exact domain | PASS | `FLAG_TOKENS` 是精确键集合；非法值不会经 truthiness 静默转 1。 |
| P1-1 / boolean count rejection | PASS | boolean 不进入 number/string 转换分支，得到 `NaN` 并抛 `SHARE_INVALID_CONFIG`；true/false 对两个 count 的测试均通过。 |
| P1-1 / existing boolean creates | PASS | 显式 boolean false/true、显式默认 boolean 与 AuthKey boolean 的既有 create/fingerprint 测试全部通过。 |
| 后续 docs commit 隔离 | PASS | `6b5d29b..66d7455` 对 `mail-share-service.js` 无 diff。 |

## HOLD vs CHANGE

- **HOLD**：`FLAG_TOKENS` 精确值域；boolean count 原始类型拦截；`legacyCompatibleBody` 的默认值判定；兼容载荷 `stored=legacy` + `accepted=[modern,legacy]`；所有重放/竞态路径传递同一 accepted 集合；old→new/new→old 回归。
- **CHANGE**：无。

## Verification

- `git merge-base --is-ancestor bc2b4e2 6b5d29b` → EXIT 0。
- `git diff --check bc2b4e2..6b5d29b` → EXIT 0。
- `git diff --exit-code 6b5d29b..66d7455 -- mail-worker/src/service/mail-share-service.js` → EXIT 0。
- 独立 WebCrypto probe → old `d5c870aaf938ac6df25f53f9847c50073d56e7abcac76be846b786af95e852bf`；modern `6ddde52742eae28fe8de1b8a5490e04900d2c7d207730b08beca5597caab8a33`；`match=false`。
- `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` → EXIT 0；1 file / 132 tests passed。

## VERDICT

status: APPROVED
critical_count: 0
important_count: 0
minor_count: 0
ready_to_merge: YES
one_line: P0-1 与 P1-1 均已关闭；滚动发布指纹双向兼容、非兼容载荷 modern-only、flag/count 严格值域及既有 boolean create 均由代码与 132/132 focused tests 证明，且未发现新 P0。
