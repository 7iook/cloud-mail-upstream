# reviewer T1 · 批量 emails[] 整单篱笆

L0 通用内核 · L1 scope.md 判据源/机械闸门 · L2 T1 review_focus
model: gpt-5.6-sol-xhigh-fast（Task 用量耗尽 · 主 AI 按 reviewer 模板代行）
read: mail-share-service.js:1107-1448 · mailbox-provision.js:227-270 · mail-share-emails.spec.js:391-558
verify: cd mail-worker && pnpm exec vitest run test/mail-share-emails.spec.js → EXIT=0 (35 passed)

## 查证

1. 篱笆三条 COUNT 分别钉 share lids / 本批 emails 的 account / 这些 share 的 Binding。零行 INSERT 会让对应 COUNT 对不上，`INSERT NULL` 撞 `mail_share_binding.share_id` NOT NULL。`rolls back the rows the batch already wrote when one share goes zero-row` 断言 account/share/binding/idempotency 全 0。
2. `accountQuotaPredicateBinds` 排除本批 missing、阈值 `accountCount - keys.length`。刚好填满配额的两枚地址整单通过；UNIQUE 重试后 binds 含 `["p2-retry-c@example.com"]` 且末值 3。
3. `resolveNonAdminAccountQuota` 在 attempt 环内，每次按当前 plan.missing 重建。
4. `isIntegrityFence` 认 NOT NULL + mail_share_binding。认不出则 throw 原错（500），注释写数据已回滚。miniflare 上 35 例绿。
5. T-02「不得消费前序结果」指 JS 侧不能拿 batch 返回再拼下一条（语句预装配）。篱笆是同事务 SQL 读已写入行，与 T-02 的 JS 约束不是同一件事。F-0030（真 D1 行可见性）仍无 remote 实验，篱笆把它变成承重件。
6. `insertShareAndIdempotency` 仍批后看 `meta.changes`、无篱笆。accountId 单条路径，部分写入面比 emails[] 小；本轮不新开条，记 T1 已扫。

## persist

- persists: F-0008, F-0009, F-0010（mailbox-provision.js 锚点仍在）
- persists: F-0030（篱笆依赖同批可见性，仍无真 D1 对照）

## findings

本主题无新 finding。F-0004 / F-78412ce3 / F-570b7d4c 关闭结论与 6ad2686 + 35 例绿对齐，不 reopen。
