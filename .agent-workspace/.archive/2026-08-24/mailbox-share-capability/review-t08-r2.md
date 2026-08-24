# T-08 Review-Fix Re-review

**VERDICT: APPROVED**

范围：独立复审 `1208321..bc2b4e2`；修复提交为 `bc2b4e2`，当前分支 `cursor/mailbox-share-capability-dcb6` 的 HEAD 为 `66d7455`。`1208321..bc2b4e2` 仅含本次修复提交。`bc2b4e2..HEAD` 虽含 T-12 的生产改动，但对 T-08 三个生产文件 `share-auth-service.js`、`share-api.js`、`share-attachment-service.js` 的定向 diff 为空；T-08 后续记录仅为 docs / Evidence，未改写本次受审生产实现。

## P0 / P1 / P2 findings

| id | severity | file:line | claim | falsification experiment |
|---|---|---|---|---|
| T08-C1 | CLOSED（原 P0 / Critical） | `mail-worker/src/service/share-auth-service.js:430-441,551`；`mail-worker/test/share-auth-service.spec.js:822-849` | `consumeSessionQuota` 已接收快照 `row.authKeyEnabled`，并在唯一条件 UPDATE 的 WHERE 中以整数 `0/1` 复核 `auth_key_enabled`。`enable` 不 bump `credentials_version` 时，快照后的 0→1 变化仍会使 UPDATE 返回空，不能签发无 Key token。 | 新竞态测试用 `injectingDb.before` 在无 Key 请求读到 disabled 快照后、quota UPDATE 执行前原子写入 `auth_key_enabled=1` 及 hash/kid；实际返回 `SHARE_UNAVAILABLE`，`access_count=0`、`last_access_at=NULL`、`credentials_version=0`。指定定点套件通过。 |
| T08-I1 | CLOSED（原 P1 / Important） | `mail-worker/src/service/share-auth-service.js:463-475,532-551`；`mail-worker/test/share-auth-service.spec.js:1408-1433,1571-1607` | KV 值只有在 `verifyToken` 成功且 `(payload.cv ?? 0) === row.credentialsVersion` 的等价判断成立时才命中；reset/disable 的 cv bump 会把旧缓存降为 miss。新 Key + 同一 `Idempotency-Key` 会重新过 quota、签发当前 cv token并覆盖缓存；enable 不 bump cv，正确 Key 的同 key replay 仍返回原响应且不多耗配额。 | 先以 K0 + idem I 建立 cv=0 token，再将 hash 换为 K1 且 cv→1，以 K1 + I 重入：实际得到不同的 cv=1 token，`access_count` 由 1→2，新 token 可 resolve、旧 token 被拒；再次 K1 + I 命中 live token，计数保持 2。既有 keyed replay 测试同时证明 cv 不变时同 key replay 保持命中。 |
| T08-M1 | CLOSED（原 P2 / Minor） | `mail-worker/test/mail-share.schema.spec.js:142-148` | 注释已准确拆分三处读取：一处是所有 establish/resolve 都经过的 `assertAllowed`，两处是零 Binding 回落；围栏断言仍保持 3。 | raw-source fence 实际执行并通过，`countPrimaryAccountReads(shareAuthSource) === 3`；注释不再声称三处全属回落分支。 |

未发现新 P0、P1 或 P2 finding。

## Requirement checks

| 检查项 | 结论 | 证据 |
|---|---|---|
| C1 · enable 并发授权线性化 | PASS / CLOSED | `mailShare.authKeyEnabled` 是未启用 boolean mode 的 SQLite integer 列；快照值原样从 `establishSession` 传入 `consumeSessionQuota`，WHERE 同时约束 `credentials_version` 与 `auth_key_enabled`。竞态测试真实插入 0→1 提交并验证零 token、零配额。 |
| I1 · KV replay 绑定当前 cv | PASS / CLOSED | 缓存 token 先验签、验有效期，再比较当前行 cv；stale 或无效缓存均按 miss。reset/new-key/same-idem 用例验证新 token、新配额与可 resolve；keyed same-idem 用例验证 enable/cv 不变语义未被误伤。 |
| M1 · fence 文案与数字 | PASS / CLOSED | 仅注释修正，ratchet 数字仍为 3；schema spec 通过。 |
| 新安全/生产回归 | PASS | 修复局限在授权 gate、KV hit 判据、回归测试与设计文档交叉语义；未新增绕过、吞错或第二授权真源。 |
| 后续提交漂移 | PASS | `git diff --exit-code bc2b4e2..HEAD -- <T-08 三个生产文件>` 为 EXIT 0；当前实现仍是 `bc2b4e2` 的受审内容。 |

## HOLD vs CHANGE

- **HOLD**：C1 的 `auth_key_enabled` 快照谓词；enable 不 bump cv；gate 落空沿既有 `quota_race` 拒发；I1 的 token 验签 + 当前 cv 匹配；stale/验签失败按 cache miss；reset/disable 后重新消耗配额并签发 live token；enable/cv 不变时同 key replay；M1 注释修正且 fence 保持 3；design.md 的 AC-EDGE-05 / AC-SESS-10 交叉语义。
- **CHANGE**：无。

## Verification

- `git rev-parse HEAD` → `66d7455cd4fc37106d24811e82c86d20bf779a91`。
- `git log --oneline --reverse 1208321..bc2b4e2` → 仅 `bc2b4e2 fix(worker): bind AuthKey enable and cv into session gates`。
- `git diff --check 1208321..bc2b4e2` → EXIT 0。
- `git merge-base --is-ancestor 1208321 bc2b4e2` 与 `git merge-base --is-ancestor bc2b4e2 HEAD` → EXIT 0。
- `git diff --exit-code bc2b4e2..HEAD -- mail-worker/src/service/share-auth-service.js mail-worker/src/api/share-api.js mail-worker/src/service/share-attachment-service.js` → EXIT 0。
- `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-api.spec.js test/share-attachment-service.spec.js test/mail-share.schema.spec.js --no-cache` → EXIT 0；4 files / 90 tests passed。

## VERDICT

status: APPROVED
critical_count: 0
important_count: 0
minor_count: 0
ready_to_merge: YES
one_line: C1、I1、M1 均已按裁决闭环；enable 竞态不能无 Key 签发，stale-cv KV 不再返回必死 token，且同版本 replay 与 fence=3 保持不变。
