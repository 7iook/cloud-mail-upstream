# Review · T-19 checkpoint · `03d987c`

## Verdict

**NEEDS_CHANGES**

| Severity | Count |
|---|---:|
| P0 | 0 |
| P1 | 1 |
| P2 | 0 |

## Findings

### P1-1 · AuthKey 的全库明文守卫只匹配整格相等，嵌入文本时会假绿

- **Location:** `mail-worker/test/share-integration.spec.js:248-265`, `mail-worker/test/share-integration.spec.js:1458-1473`
- **Criterion:** recon T-19 §5-C5 / 本轮 Hunt #6、#9：AuthKey 明文不得泄漏进任一 DB 文本列，且测试不得假绿。
- **Failure mode:** C5 调用 `assertSecAbsentFromDatabase(authKey)`，但 helper 为每个文本列生成的是 `"column" = ?`。它只能发现整格内容恰好等于 AuthKey；若生产代码把明文写成 JSON（例如 `{"authKey":"<key>"}`）、日志文本或带前后缀的载荷，该测试仍会通过。
- **Impact:** 当前 37/37 与全量 618/618 不能证明“全库文本列不含 AuthKey 明文”这一安全断言；checkpoint 会接受可恢复的凭据泄漏。
- **Required fix:** 文本列逐列做子串搜索，例如 `instr(CAST("column" AS TEXT), ?) > 0`，保留现有 get/list/session 响应体 `not.toContain(authKey)` 断言。
- **Verify:** 在任一临时文本列写入包含 AuthKey 的 JSON/前后缀文本时 C5 必须失败；清除该值后定点与全量测试应恢复全绿。

## Hunt matrix

1. **既有 17 条用例被改写:** 未发现。提交前 912 行仅扩展 `savedEnv`、`openSession` 可选参数与 `cleanup`；17 个既有 `it` 块及其断言无 diff。
2. **`wrangler-vitest.toml` / `src` 改动:** 未发现；`git diff --quiet 03d987c^ 03d987c -- mail-worker/src mail-worker/wrangler-vitest.toml` 返回 0。
3. **V2 经 `SELF.fetch` 翻转或泄漏:** 未发现。`withCapabilityV2` 使用 `try/finally`，`ownerV2` 调 `jsonWorker`；`cleanup` 另有兜底还原。
4. **新 A 组直插 `mail_share_binding`:** 未发现。新增 A1–A8 只经 create/bindings HTTP 产生 Binding；文件唯一直接 INSERT 位于既有 `addBinding`，不在新增 A 组路径。
5. **A8 缺失或沿用整条撤销旧语义:** 未发现。A8 断言剩余分享 `ACTIVE`、只余幸存 Binding、旧 token 继续读取幸存邮箱。
6. **AuthKey 明文泄漏:** get/list/session 响应体已有子串断言；DB 文本列守卫存在 P1-1。
7. **配额触顶后既有 token:** B1 明确在第三次建会话失败后，用第一枚 token 成功读取 mails/status，并复查 `access_count=2`。
8. **重复 perm 测试:** 未发现；新增区间无 `share:manage` / `SHARE_FORBIDDEN` 断言。
9. **弱断言 / 假绿:** 除 P1-1 外，未发现会改变结论的弱断言。

## Verification

- `pnpm --dir mail-worker exec vitest run test/share-integration.spec.js --no-cache` → EXIT=0，1 file / 37 tests。
- `pnpm --dir mail-worker test` → EXIT=0，18 files / 618 tests。
- `git diff --check 03d987c^ 03d987c -- mail-worker/test/share-integration.spec.js` → EXIT=0。

