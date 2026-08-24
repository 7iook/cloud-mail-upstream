# T-06 Session Quota Gate Review

**VERDICT: APPROVED**

范围：审查 `6209960` 对 `share-auth-service.js` / `share-auth-service.spec.js` 的提交 diff，并以现行 capability 规格为判据；当前并行中的 T-07 未提交测试不作为 T-06 正确性证据。`6209960` 在 HEAD 祖先链上，后续已提交内容未改这两个目标文件。

## P0 / P1 / P2 findings

| id | severity | file:line | claim | falsification experiment |
|---|---|---|---|---|
| — | — | — | 未发现 P0/P1/P2 缺陷 | — |

## Requirement checks

| 检查项 | 结论 | 证据 |
|---|---|---|
| WHERE predicates / 单一状态写 | PASS | `share-auth-service.js:266-276` 是单条 `UPDATE ... RETURNING`，同时约束 `share_id`、`status='ACTIVE'`、`expires_at > now`、`credentials_version = expectedCv`、`max_sessions IS NULL OR access_count < max_sessions`；快照只用于校验和携带 cv，不构成两步状态写。 |
| `issueToken` after UPDATE | PASS | `share-auth-service.js:307-323` 先 await gate，抛错或空数组均拒绝，只有非空后才签发；`last_access_at` 与 `access_count+1` 在同一成功 UPDATE。 |
| quota denial logs | PASS | `share-auth-service.js:299-300,317-318` 分别记录 `quota_snapshot` / `quota_race`，事件名由 `SHARE_EVENT.SESSION_DENIED_QUOTA` 固定为 `share.session.denied_quota`。 |
| `recordAccess` / fire-and-forget | PASS | 生产代码已删除 `recordAccess`；全仓 JS 搜索仅测试中的反向断言命中该词。establish 路径唯一写被 await。 |
| resolve/read path | PASS | `resolveSession` 仅验签与 SELECT；生产源码中 `access_count+1` / `last_access_at` 的唯一写点是 quota gate。读序列测试后两字段保持不变。 |
| concurrency | PASS | `share-auth-service.spec.js:656-713`（`6209960`）用真实 `Promise.allSettled` 发起 6/8 路并发；最后一槽仅 1 成功，空额度 3 槽仅 3 成功，计数不超上限。 |
| AC-LIFE-14 reversal | PASS | 原“统计写失败仍签发”测试已反转为 AC-SESS-11：quota UPDATE 抛错时拒发且计数/时间不变；旧 charter 的 AC-LIFE-14 已标注由 AC-SESS-11 supersede。 |
| expiry / renewal | PASS | `issueToken` 仍执行 `exp=min(expires_at, iat+TTL)`；路由与服务搜索无续期入口。 |
| circular import safety | PASS（HOLD） | 当前环 `share-auth-service ↔ mail-share-service` 的互引绑定都只在函数体执行时解引用，模块初始化无 TDZ 读取；全量 worker suite 覆盖两种入口导入并通过。结构较脆，但不是本次行为缺陷。 |
| unused `options` | PASS（HOLD） | `establishSession(..., options={})` 在 `6209960` 确实未读取；它不形成注入 seam、不能绕过 gate，也不影响 T-06 行为。属非阻塞接口预留，不要求为本次改动。 |

## HOLD vs CHANGE

- **HOLD**：现有原子 gate、失败即拒发、双 reason 日志、只读 resolve、当前 evaluation-safe 的循环依赖，以及非行为性的 `options` 形参。
- **CHANGE**：无。

## Verification

- `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js` → EXIT 0，1 file / 26 tests passed。
- `pnpm --dir mail-worker test` → EXIT 0，17 files / 213 tests passed。
