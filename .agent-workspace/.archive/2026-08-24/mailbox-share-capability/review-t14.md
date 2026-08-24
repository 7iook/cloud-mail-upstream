# T-14 独立代码审查

VERDICT APPROVED

- review target: `d6fa50bbbf3181197466162ed04dad5fb233b1a7`
- p0: 0
- p1: 0
- CHANGE: 无
- HOLD:
  - T-17 `premKey` 按指令保留；本提交未改动。
  - `share-api.js` 直接调用 scoped repository 不构成本轮问题：设计明确要求 status 经 `share-auth-service` + scoped repository，当前没有值得新增纯转发 service 的投影或业务逻辑。
  - 执行记录中的“整个端点恰 1 条 SQL”应理解为 `latestByBinding` 的水位读取恰 1 条 SQL；`resolveSession` 仍有固定条数的鉴权查询。实现不存在随 Binding 数量增长的查询扇出，不影响结论。

## 逐项结论

1. **成功态成立。** `GET /share/mailboxes/status` 先用 visitor token 调用 `resolveSession`，再一次调用 `latestByBinding`；返回顺序跟随 `ctx.bindings`，每条有效 Binding 均有 `latestEmailId`，无可见邮件时为 `null`。
2. **范围模型同源。** `latestByBinding` 直接复用 `visibleSubquery`；窗口下界、`account_id > 0`、`is_del=NORMAL`、`status != SAVING` 与 `message_limit` 截断均与 mails 共用同一实现，没有第二套范围条件。
3. **无 N+1。** `latestByBinding` 只构造并执行一次水位 SQL，没有循环调用 `listForBinding`。三条 Binding 的查询计数测试断言 `prepare` 恰调用一次并通过。鉴权侧的查询数也不随 Binding 数量线性增长。
4. **无游标语义成立。** handler 不读取 `c.req.query()`；`sinceEmailId`、`cursor`、`limit`、`bindingId` 等 query 组合下返回相同 mailboxes 水位。
5. **窗口外、排除项和滚出 N 的邮件不移动水位。** 过滤在窗口函数排名前完成，最终只取 `row_no = 1` 且保留同一 `message_limit` 截断；repository/API/integration 用例覆盖窗口下邮件、SAVING、已删、外部 account 与 `message_limit=1` 滚动。
6. **零配额增量。** status 只走无写入的 `resolveSession` 和 repository 查询；集成测试对比轮询前后 `access_count`/`last_access_at`/`status`，保持不变。只有 `establishSession` 的 `consumeSessionQuota` 会递增 `access_count`。
7. **安全豁免封闭。** `security.js` 的提交差异严格只有一条 `excludeExact`：`GET /share/mailboxes/status`。`/share/mailboxes/statusX`、子路径、近似路径及 POST/DELETE 仍走 JWT，测试通过。
8. **既有 handler 无行为改动。** session/mails/mail/attachment 的原代码逐字未改，仅新增 import 和相邻 status route；额外 visitor API/integration 回归 25/25 通过。
9. **T-11 follow-up 合理。** `VISITOR_MAIL_KEYS` 只补上 T-11 已增加的 `bindingId`、`mailboxAddress`；status 集成用例把每 Binding 水位与同 token 的 mails 结果对照，范围一致。未重审 T-11 投影细节。
10. **V2 未静默开启。** 提交未改 `wrangler.toml`、`wrangler-vitest.toml` 或任何生产开关配置；提交文件清单也没有其他配置文件。

## 测试与静态证据

- 指定测试：4 files / 82 tests，全部通过，exit 0。
- 既有 visitor handler 回归：2 files / 25 tests，全部通过，exit 0。
- `git diff --check d6fa50b^..d6fa50b`：通过。
- 当前 HEAD 为 `ec93f93`；`d6fa50b..HEAD` 仅有后续 spec evidence commit，八个审查范围文件无差异，因此本次测试对应被审提交内容。
- 测试输出存在仓库初始化阶段已有的重复列/缺列日志与安全负例日志，但没有失败断言，不影响上述结果。

## 实际运行命令

```sh
git status --short --branch && git rev-parse --abbrev-ref HEAD && git show d6fa50b --stat

git diff d6fa50b^..d6fa50b -- mail-worker/src/api/share-api.js mail-worker/src/security/security.js mail-worker/src/service/share-scoped-email-repository.js

git diff d6fa50b^..d6fa50b -- mail-worker/test/share-status.spec.js mail-worker/test/security-share.spec.js mail-worker/test/share-scoped-email-repository.spec.js mail-worker/test/share-integration.spec.js .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t14-note.md

pnpm --dir mail-worker exec vitest run test/share-status.spec.js test/security-share.spec.js test/share-scoped-email-repository.spec.js test/share-integration.spec.js --no-cache

git rev-parse HEAD && git diff --check d6fa50b^..d6fa50b && git diff --name-only d6fa50b^..d6fa50b && git diff d6fa50b^..d6fa50b -- mail-worker/wrangler.toml mail-worker/wrangler-vitest.toml

git log --oneline --decorate d6fa50b..HEAD && git diff --stat d6fa50b..HEAD -- mail-worker/src/api/share-api.js mail-worker/src/security/security.js mail-worker/src/service/share-scoped-email-repository.js mail-worker/test/share-status.spec.js mail-worker/test/security-share.spec.js mail-worker/test/share-scoped-email-repository.spec.js mail-worker/test/share-integration.spec.js .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t14-note.md && git diff d6fa50b..HEAD -- mail-worker/src/api/share-api.js mail-worker/src/security/security.js mail-worker/src/service/share-scoped-email-repository.js mail-worker/test/share-status.spec.js mail-worker/test/security-share.spec.js mail-worker/test/share-scoped-email-repository.spec.js mail-worker/test/share-integration.spec.js .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t14-note.md

git show d6fa50b^:mail-worker/src/api/share-api.js | sha256sum && git show d6fa50b:mail-worker/src/api/share-api.js | sha256sum && git show d6fa50b^:mail-worker/src/security/security.js | sha256sum && git show d6fa50b:mail-worker/src/security/security.js | sha256sum

git diff --unified=0 d6fa50b^..d6fa50b -- mail-worker/src/security/security.js && git diff --unified=0 d6fa50b^..d6fa50b -- mail-worker/src/api/share-api.js

pnpm --dir mail-worker exec vitest run test/share-api.spec.js test/share-integration.spec.js --no-cache

git show d6fa50b^:mail-worker/src/api/share-api.js | sed -n '50,110p' && git show d6fa50b:mail-worker/src/api/share-api.js | sed -n '50,110p'

git show --format=fuller --no-ext-diff --find-renames d6fa50b -- mail-worker/test/share-integration.spec.js
```
