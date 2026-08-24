# T-15 独立代码审查

VERDICT NEEDS_CHANGES

- review target: `1d49bb449b6809e0d1cc9ed0d0b207ce1d2926a1`
- p0: 0
- p1: 2
- CHANGE:
  - P1-1：`status` 单参请求错误落入 deprecated 500 行转储，而非默认 20 行分页。
  - P1-2：delete 的幂等子表删除未通过 `mail_share.user_id` 回查归属。
- HOLD:
  - T15-PERM：`security.js` 新路径按既定裁决留给 T-17，不计入本轮缺陷。
  - T13-DUP / T-17 `premKey` 不在本轮。
  - 后续 `4124999` 只含 Evidence / 台账 / T-11 R2 文档，本轮未把它计入缺陷。

## Findings

### P1-1 · `status` 单参绕过默认分页

- file:line: `mail-worker/src/service/mail-share-service.js:936-942`
- 判据来源：`docs/specs/mailbox-share-capability/design.md:301`（`size` 默认 20；仅“无参”调用保留 deprecated 全量、硬上限 500）；T15-STATUS 已拍板为计算态筛选。
- failure mode：`normalizeListPaging()` 只检查 `page`/`size` 是否有值。合法请求 `{ status: 'ACTIVE' }` 虽然不是无参请求，仍返回 `{ paged:false, limit:500 }`。
- trigger：Owner 调用 `GET /mailShare/list?status=ACTIVE`、`EXPIRED`、`REVOKED` 或 `ACCESS_LIMIT_REACHED`，但不显式附带 `page`/`size`。
- impact：接口最多返回 500 行，并错误回传 `deprecated:true`、缺少 `page/size`；违反默认 20 行分页契约，筛选结果较多时会放大 D1 查询、Binding 摘要和响应负载。`mail-worker/test/mail-share-service.spec.js:2602-2617` 恰以 status 单参调用，却没有断言分页形状，因此 195/195 不能否证此问题。
- 可证伪实验：造 25 条 `ACTIVE` 分享，调用 `mailShareService.list(ctx(), { status:'ACTIVE' }, owner)`。当前结果为 `list.length===25`、`deprecated===true`、`page/size===undefined`；契约要求 `list.length===20`、`page===1`、`size===20` 且不带 deprecated。
- required fix：仅真正无 query 参数时走 500 行兼容路径；带合法 `status` 而缺 `page/size` 时套用 page=1、size=20。补一条 25 条同态行的 status-only 回归。
- 建议裁决：CHANGE。

### P1-2 · 幂等子表删除缺少主表 Owner 回查

- file:line: `mail-worker/src/service/mail-share-service.js:1190-1205`
- 判据来源：`docs/specs/mailbox-share-capability/design.md:306`、AC-ADMIN-07；本轮明确核对项要求 binding 与 idempotency 两条子表删除都经 `mail_share.user_id` 回查，主表最后删除。
- failure mode：Binding DELETE 在 `mail_share` 上做 Owner `EXISTS`，但 `share_idempotency` DELETE 仅使用自身的 `share_id = ? AND user_id = ?`。`mail-worker/src/init/init.js:161-180` 证明该表没有 FK，也没有约束保证其 `user_id` 永远等于对应 `mail_share.user_id`。三条语句已在 batch 内成功后才检查主表 `changes`；主表不属于调用者时，随后抛出的 `SHARE_NOT_FOUND` 不会撤销已提交 batch。
- trigger：存在一条 schema 允许的幂等记录 `{ share_id: foreignShareId, user_id: caller }`，调用者删除他人的 `foreignShareId`；同理可用指向不存在主表的孤儿幂等记录触发。
- impact：API 返回 `SHARE_NOT_FOUND`，却已经删除调用者的幂等记录；“他人/不存在 shareId”路径不是无副作用，并且没有满足明确要求的主表归属回查。现有 `mail-worker/test/mail-share-service.spec.js:2531-2543` 只造了与主表 Owner 一致的幂等行，未覆盖这个无 FK 反例。
- 可证伪实验：造 `mail_share(share_id=77,user_id=B)` 与 `share_idempotency(share_id=77,user_id=A)`，以 A 调用 delete(77)；当前返回 `SHARE_NOT_FOUND`，但第二张表的行已消失。修复后该行应保留。
- required fix：将幂等 DELETE 也用仍存在的 `mail_share` 行按 `share_id + 当前 user_id` 做 `EXISTS` 归属门禁，并继续保持子表先、主表后的同一 batch 顺序；增加上述反例回归。
- 建议裁决：CHANGE。

## 逐项结论

1. **提交范围符合白名单。** `1d49bb4` 只改 `mail-share-service.js`、`mail-share-api.js`、`mail-share-service.spec.js` 与 `exec-t15-note.md`；`security.js`、`init.js`、`share-auth-service.js`、`share-api.js`、`email.js`、`wrangler*.toml`、`mail-vue/**`、`tests/e2e/**` 均无差异。
2. **get 的非 ACTIVE 审计范围成立。** `loadOwnerDetail` 仅按 `share_id + user_id` 查询，没有误用 `loadMutableShare`；EXPIRED/REVOKED/ACCESS_LIMIT_REACHED 均可读。
3. **四态投影成立。** `OWNER_ROW_COLUMNS`、`toOwnerRow`、`projectOwnerRow` 均携带 `maxSessions`；JS 与 SQL CASE 都按 REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE 判定。
4. **update 白名单成立。** 独立 `normalizeUpdateBody` 以 `hasOwnProperty` 区分缺键；SET 仅来自 8 项白名单，未复用 `normalizeCreateBody`，`lid/sec/expires_at/auth_key_*/credentials_version/access_count` 等不可经 patch 修改。
5. **配额纪元语义成立。** NULL→有限值缺省清零、显式 false 保留；已有限时不重复清零；下调到 `≤ usedSessions` 被接受并计算为 ACCESS_LIMIT_REACHED。
6. **V2 双栅栏成立。** 有限 `maxSessions` 与有限 `messageLimit` 分别接 FINITE_MAX_SESSIONS / MESSAGE_LIMIT；显式 null 放行。
7. **delete 部分不成立。** 同一 batch、Binding 子表先删、主表后删、无 status/expiry 限制、他人/不存在返回 SHARE_NOT_FOUND 均成立；但 idempotency 子表缺少 `mail_share.user_id` 回查，见 P1-2。
8. **list 部分不成立。** `share_id DESC`、size 上限 100、无参 500 硬顶、计算态 CASE 与同 CASE COUNT、`json_each(?)` Binding 摘要、无 JOIN 展开和 D1 参数预算均成立；但 status-only 请求未套默认 20 行分页，见 P1-1。
9. **旧投影兼容成立。** `accessCount` 与新增 `usedSessions` 并存。
10. **生产开关未静默开启。** 提交没有改任何 wrangler 配置；当前 `wrangler.toml` 仍注释为缺省 false，`wrangler-vitest.toml` 为 `"false"`。
11. **后续提交未污染本轮代码。** HEAD `4124999` 相对 `1d49bb4` 在三份审查范围文件和列出的对照文件上无差异。

## 测试与静态证据

- 指定测试：1 file / 195 tests，全部通过，EXIT=0。
- 测试输出有初始化阶段既有的 `auto_refresh_time` 缺列警告，无失败断言。
- `git diff --check 1d49bb4^..1d49bb4`：通过。
- 提交 churn：执行笔记 +121；API +16；service +349/-28；spec +722/-2。
- 绿测没有覆盖两条反例：status-only 的分页响应形状，以及无 FK 条件下 idempotency DELETE 的主表 Owner 回查。

## 实际运行命令

```sh
git status --short --branch && git rev-parse --verify 1d49bb4^{commit} && git rev-parse --abbrev-ref HEAD

git show --stat --oneline --decorate --no-renames 1d49bb4
git diff --name-status --no-renames 1d49bb4^..1d49bb4
git diff --check 1d49bb4^..1d49bb4

git diff --unified=3 --no-ext-diff --no-renames 1d49bb4^..1d49bb4 -- mail-worker/src/api/mail-share-api.js mail-worker/src/service/mail-share-service.js
git diff --unified=8 --no-ext-diff 1d49bb4^..1d49bb4 -- mail-worker/test/mail-share-service.spec.js

git diff --quiet 1d49bb4^..1d49bb4 -- mail-worker/src/security/security.js mail-worker/src/init/init.js mail-worker/src/service/share-auth-service.js mail-worker/src/api/share-api.js mail-worker/src/entity/email.js mail-worker/wrangler.toml mail-worker/wrangler-vitest.toml mail-vue tests/e2e

git rev-parse HEAD
git log --oneline --decorate 1d49bb4..HEAD
git diff --stat 1d49bb4..HEAD -- mail-worker/src/service/mail-share-service.js mail-worker/src/api/mail-share-api.js mail-worker/test/mail-share-service.spec.js mail-worker/src/security/security.js mail-worker/src/init/init.js mail-worker/src/service/share-auth-service.js mail-worker/src/api/share-api.js mail-worker/src/entity/email.js mail-worker/wrangler.toml mail-vue tests/e2e

pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache
```
