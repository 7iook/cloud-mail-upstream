# T-18 独立代码审查

## 结论

- **Verdict: APPROVED**
- **P0: 0**
- **P1: 0**
- **P2: 1**
- 审查对象：`73dc3715c6f2162dc8d42eef1629a4ee37e21673`
- 范围：该提交在两个生产文件与两个测试文件中的 diff；未采信执行者自述。

## Findings

### P0

无。

### P1

无。

### P2-1 · cleanup 用例不能单独证伪“主表先删”或“未使用同一 batch”

- 位置：`mail-worker/test/mail-share-cleanup.spec.js:176-200`
- 证据：B1/B2 只检查最终零 Binding/零悬空行。即使实现错误地先删 `mail_share`，再由孤儿 sweep 删除刚变成悬空的合法 Binding，这两条用例仍会通过；若各 DELETE 分属不同 batch，最终态也同样会通过。
- 影响：当前生产实现本身在 `mail-worker/src/service/mail-share-cleanup-service.js:38-97` 明确以单个 `db.batch()` 按 Binding → orphan revoke/sweep → idempotency → 主表顺序执行，故本提交没有现存 AC-LIFE-06 行为错误；但测试对未来的顺序/原子性回归保护弱于注释声称的强度。
- 建议：用 `env.db.batch` spy/statement 形状断言锁定一次 batch 及语句顺序，或构造能在主表删除与 orphan sweep 之间观察中间态的故障注入测试。

## 逐项核验

1. **撤销谓词正确**：`mail-worker/src/service/mail-share-service.js:768-783` 同时具备 Binding 受影响臂、零 Binding 遗留回落臂及“无幸存 Binding”约束；不会全库误撤销零 Binding 行，也不会漏撤销账号被删的遗留行。
2. **批次顺序正确**：级联在 `mail-worker/src/service/mail-share-service.js:1448-1452` 按撤销 → 重指 → 删 Binding；cleanup 在 `mail-worker/src/service/mail-share-cleanup-service.js:38-97` 单批执行且主表最后删除。
3. **不写 0/NULL**：级联重指在 `mail-worker/src/service/mail-share-service.js:789-810` 带 `account_id > 0` 与幸存者 `EXISTS`；cleanup 重指在 `mail-worker/src/service/mail-share-cleanup-service.js:69-89` 有同等守卫。
4. **D1 参数预算**：账号集合只以 JSON 单参数传入 `json_each(?)`；cleanup 也使用子查询，不展开到期 share ID。
5. **事件与 PII**：复用既有 `SHARE_EVENT.BINDING_CASCADE`，未新增事件名；新增日志字段仅含 share 行号、reason、计数和布尔值，无邮箱/密钥/token。
6. **禁改范围**：运行时代码和测试仅改任务允许的四个文件；`account-service.js`、`security.js`、`init.js`、`share-auth-service.js`、wrangler、API 与实体文件均无 diff。
7. **cleanup 假绿种子**：`mail-worker/test/mail-share-cleanup.spec.js:36-55` 创建合法 user/account，B1 使用该种子，不再沿用 `user_id=1/account_id=1` 的非法 Binding 形状。
8. **返回值语义**：`mail-worker/src/service/mail-share-service.js:1473-1474` 的 `revoked` 取撤销 UPDATE 的 `changes`，不是受影响或被解绑 share 数。
9. **错误不被吞**：两条生产路径均未新增 try/catch；级联/cleanup batch 错误会向调用方传播。
10. **空集合安全**：`mail-worker/src/service/mail-share-service.js:1436-1440` 在构造 `json_each`/`NOT IN` 谓词前早退。
11. **cleanup orphan 语义**：`mail-worker/src/service/mail-share-cleanup-service.js:48-65` 先把“有 Binding 且零 live mailbox”的 ACTIVE share 置 REVOKED，再按存在、`is_del=NORMAL`、owner 匹配的同源门禁删除孤儿。

## 运行验证

- `pnpm --dir mail-worker exec vitest run test/account-delete-share.spec.js test/mail-share-cleanup.spec.js --no-cache`
  - 2 files passed，27 tests passed。
- `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/v3-2-db.spec.js test/mail-share.schema.spec.js --no-cache`
  - 3 files passed，240 tests passed。
- `pnpm --dir mail-worker test -- --no-cache`
  - 18 files passed，598 tests passed。

## 最终判定

`73dc371` 满足 T-18 / T-18.1 / T-18.2 及 AC-BIND-05/06/10/11、AC-LIFE-06/09/10 的生产行为要求。未发现 P0/P1 缺陷；一项 P2 仅涉及测试对 batch 顺序与原子性的回归证明力度，不否定当前实现。
