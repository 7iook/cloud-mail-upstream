# Review · T-19 P1-1 fix · `db1e511`

## Verdict

**APPROVED**

| Severity | Count |
|---|---:|
| P0 | 0 |
| P1 | 0 |

## P1-1 re-review

- `assertSecAbsentFromDatabase` 已将整格相等判断改为逐文本列执行
  `instr(CAST("column" AS TEXT), ?) > 0`，能够发现 JSON、日志文本及带前后缀载荷中的 AuthKey 明文。
- 新增回归用例把 `{"authKey":"abcdefghijklmnopqrstuv"}` 写入
  `share_idempotency.request_fingerprint`，并要求 helper 以
  `plaintext secret stored` 拒绝；这直接覆盖上一轮指出的 equality leak 假绿路径。
- 本轮只复审 P1-1，未发现阻断项。

## Verification

- `pnpm --dir mail-worker exec vitest run test/share-integration.spec.js --no-cache -t "fails the leak guard when AuthKey plaintext is embedded in a JSON text column"` → EXIT=0，1/1 通过（37 skipped）。
- `git diff --check db1e511^ db1e511 -- mail-worker/test/share-integration.spec.js` → EXIT=0。
