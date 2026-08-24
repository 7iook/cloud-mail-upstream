# T-07 KV Idempotency Replay Review

**VERDICT: APPROVED**

范围：仅审查 `9b98dec..c2087ce` 中 T-07 的生产代码、测试与 `exec-t07-note.md`；`8cafda6` / `a0f23eb` 仅用于核对 Evidence 哈希。提交内另有 `session-ledger.md` 的任务状态记录，不作为生产行为证据。当前未提交的 T-12 `mail-share-service.js` / `mail-share-service.spec.js` / `exec-t12-note.md` 及同工作区其他未跟踪文件均排除。`c2087ce` 在当前 HEAD `a0f23eb` 的祖先链上，后续提交未改写本次目标生产代码或测试。

## P0 / P1 / P2 findings

| id | severity | file:line | claim | falsification experiment |
|---|---|---|---|---|
| — | — | — | 未发现 P0/P1/P2 缺陷 | — |

## Requirement checks

| 检查项 | 结论 | 证据 |
|---|---|---|
| AC-SESS-10 请求接线 | PASS | `share-api.js:54-58` 从 `Idempotency-Key` 读取头并通过 `{ idempotencyKey }` options 传给 service；未把 HTTP 解析逻辑下沉，也未提前接入 T-08 `authKey`。 |
| T07-R1 查询顺序 | PASS（CHANGE 已落实） | `share-auth-service.js:342-358` 先完成 `sec` 匹配，再 `loadLiveAccount`，随后查 KV；`quota_snapshot` / `assertAllowed` 位于 `:365-368`。这精确满足“live account 之后、快照配额与 `assertAllowed` 之前”，因此 `max_sessions=1` 首次耗尽后仍可重放。 |
| 同 key 命中语义 | PASS | `share-auth-service.js:354-358` 命中后直接返回，不进入 `consumeSessionQuota`；`share-auth-service.spec.js:941-972` 给 quota UPDATE 装抛错引信，证明重放没有执行 UPDATE，且 `access_count` 保持 1。 |
| `max_sessions=1` 恢复 | PASS | `share-auth-service.spec.js:974-993` 首次签发耗尽唯一名额，同 key 仍返回同一结果且计数恒为 1；换 key 按正常配额路径拒绝。该用例直接覆盖 AC-SESS-10 的响应丢失恢复核心。 |
| 无 key / 新 key / miss | PASS | `share-auth-service.js:353-359` 只有非空 key 且命中才短路；否则继续 AC-SESS-01 gate。`share-auth-service.spec.js:995-1026` 覆盖新 key、无 key、空白 key，均正常消耗配额。 |
| KV key 与缓存内容 | PASS（HOLD） | `kv-const.js:7` 与 `share-auth-service.js:287-289` 形成 `share:est:<lid>:<key>`；`:389-396` 缓存完整 `{sessionToken, mailbox, expiresAt}`，`:302-307` 重放整个对象，符合既定“缓存整份响应”裁决。 |
| T07-S1 TTL | PASS | `share-auth-service.js:317-325` 以 token 自身 `exp` 计算剩余寿命：`remaining < 60` 静默跳过，否则 `expirationTtl=min(120, remaining)`；`share-auth-service.spec.js:1073-1119` 覆盖 `<60`、约 90 秒及 120 秒封顶。 |
| KV fail-open | PASS（HOLD） | `share-auth-service.js:302-311,317-328` 分别捕获读写失败；读失败退化为 miss 后继续签发，写失败保留已签发结果，两者均记录 `share.system.error`。`:1028-1071` 验证读/写故障仍签发及写失败后的再次消耗。 |
| 凭据与日志边界 | PASS | KV 故障日志只携带 `shareId` 与固定 reason，不记录 KV key；`share-auth-service.spec.js:1121-1148` 反向断言日志不含 `lid`、`sec`、token。缓存值不含 `sec` 或 AuthKey。 |
| HTTP 响应重放覆盖 | PASS（静态核验） | `share-api.spec.js:315-347` 经真实 `/share/session` 路由携带同一头两次请求，断言 token 相同、mailbox 保留、`access_count` 恒为 1；无头请求再消耗一次。因 T-12 正在修改 `/mailShare/create`，本轮按指令未单独运行该文件。 |
| 提交与 Evidence 一致性 | PASS | `c2087ce` 的实际目标 diff 与实现说明一致；`8cafda6` 将 tasks/ledger Evidence 指向 `c2087ce`，`a0f23eb` 将 `exec-t07-note.md` 固定到同一哈希；目标文件在 `c2087ce..HEAD` 无漂移。 |

## HOLD vs CHANGE

- **HOLD**：KV 读写故障 fail-open；缓存完整 `{sessionToken, mailbox, expiresAt}`；API 读头、service 收 options；`remaining < 60` 跳过写、否则 `min(120, remaining)`；重放仍先验证 `sec` 与 live account。`exec-t07-note.md` 已记录的短暂陈旧响应、超长 key 退化为 fail-open 等剩余风险不违反本次权威契约，不升级为 finding。
- **CHANGE**：无。T07-R1 要求的 KV 查询位置已在 `c2087ce` 正确落实。

## Verification

- `git merge-base --is-ancestor 9b98dec c2087ce` → EXIT 0。
- `git diff c2087ce..HEAD -- mail-worker/src/const/kv-const.js mail-worker/src/api/share-api.js mail-worker/src/service/share-auth-service.js mail-worker/test/share-auth-service.spec.js mail-worker/test/share-api.spec.js` → 空输出，确认后续 Evidence 提交未改目标文件。
- `git diff --check 9b98dec c2087ce` → EXIT 0。
- `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js --no-cache` → EXIT 0，1 file / 34 tests passed。
- 未运行全量 worker suite：当前 `mail-worker/src/service/mail-share-service.js` 与其 spec 为未提交 T-12 改动，按本轮指令隔离。
