# ShareContext 冻结公告 · T-09 / W1 收口

权威形状在 `mail-worker/src/service/share-auth-service.js` 的 `buildShareContext`。W2 只消费、不改字段名、不增删键、不解冻。

```text
{
  shareId,
  bindings: [{ bindingId, accountId, windowStartEmailId }, ...],  // 按 bindingId 升序；外层与元素均 freeze
  messageLimit,            // number | null
  otpExtractionEnabled,    // boolean
  showFullAddress,         // boolean
  expiresAt,
  accountId,               // 废弃垫片 = bindings[0].accountId，至 T-11
  windowStartEmailId,      // 废弃垫片 = bindings[0].windowStartEmailId，至 T-11
  effectiveStatus
}
```

负向：W2 不得再读主表 `mail_share.account_id` 做鉴权/范围；不得调用 `resolveSession` 来「借」一个 ctx（T-10 测试自造对象）；不得把垫片当成多邮箱真源。

基线：`pnpm --dir mail-worker test --no-cache` → 17/317 EXIT=0（审查 CHANGE 入库后主 AI 独立复跑）。地板 16/138 只增不减。
