# reviewer CROSS · T1 × T2

Lens: cross-contract
边: T1 --contract-change--> T2 （SHARE_NOT_FOUND / 零残留 → remnant）
model: gpt-5.6-sol-xhigh-fast（Task 用量耗尽 · 主 AI 代行）

## 查证

- `replayBatchFromLids` 残缺批次抛 SHARE_NOT_FOUND。向导仅在 **replay** 收到该码时升 remnant，不解锁。
- 真超额路径 `rejects with zero residue and stays replayable`：零残留 + 同键再试仍 SHARE_ACCOUNT_FORBIDDEN（业务码 → 向导清 pending）。与 remnant 不冲突。
- 若篱笆回滚失败却写了幂等行，向导会把 Owner 锁在 remnant。T1 的零残留测试覆盖这条契约边。

## findings

无跨主题新 finding。
