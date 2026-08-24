# T-11 独立代码审查

VERDICT: NEEDS_CHANGES

审查对象：提交 `bee72b6`（`feat(worker): project share mail with mask and OTP gate`）。

## P0

无。

## P1

### P1-1 [CHANGE] `maskAddress` 把明显非法的邮箱字符串当作合法值

- 证据：`mail-worker/src/service/share-mail-service.js:17-21` 只检查第一个 `@` 不在首尾；没有拒绝多个 `@` 或地址中的空白。因此：
  - `maskAddress('a@@example.com', true)` 返回原串 `a@@example.com`，不是 `***`；
  - `maskAddress('a@@example.com', false)` 返回 `a***@@example.com`，不是 `***`；
  - `maskAddress(' alice@example.com', true)` 返回带前导空格的原串，`false` 时还会把空格当作“首个 local 字符”。
- 影响：未满足明确验收项“illegal → `***` no throw”。`showFullAddress=true` 时还会把脏 account 地址原样送给访客。
- 测试缺口：`mail-worker/test/share-mail-service.spec.js:123-138` 的非法样本只覆盖无 `@`、空 local、空 domain 和非字符串，没有覆盖多 `@`、前后/内部空白；现有 45 条测试全绿不能证明该验收项完整成立。
- 必须修改：在返回原串或生成掩码前，拒绝至少多 `@` 与任意空白等明显非法形态，并为 `showFullAddress` 双态补反例；保留非法输入不抛错及幂等断言。

## HOLD

无。

## CHANGE

- 修复 P1-1 后再批准；其余 T-11 验收项无需扩大修改范围。

## 其余验收结果

- PASS：合法地址在 `showFullAddress === true` 时原样返回；关闭时为首个 local 字符 + `***` + domain；当前变换在同一开关状态下幂等。
- PASS：sender、subject、text、content 不经过邮箱掩码；正文中的 mailbox 地址保持原文。
- PASS：`code` 仅在 `otpExtractionEnabled === true` 时挂载，关闭时整个键被省略。
- PASS：邮件与附件投影键集为白名单；包含 `bindingId`、`mailboxAddress`，不包含 raw `accountId`/`userId`/`isDel`/`status` 或 storage key，下载链接不走 `/oss/`。
- PASS：附件下载先调用 `scopedRepo.getById`，命中后才用该邮件行的 `accountId` 查附件；真实 D1 用例覆盖第二个 Binding、窗口外、latest-N 滚出、跨分享及 mail/attachment 错配，拒绝路径统一为 `SHARE_UNAVAILABLE`。
- PASS：提交文件清单未包含 `share-auth-service.js` 或 `email.js`；两个服务内未新增第二套 VisibleWindow，邮件可见集仍委托 scoped repository。
- 说明：当前 HEAD 为 `ec93f93`，但 `bee72b6..HEAD` 在本次五个审查文件上无差异，因此本轮测试覆盖的实现与目标提交一致。

## 实际运行的命令

```sh
git status --short --branch && git show bee72b6 --stat
git diff bee72b6^..bee72b6 -- mail-worker/src/service/share-mail-service.js mail-worker/src/service/share-attachment-service.js
git rev-parse HEAD && git diff --name-status bee72b6^..bee72b6
git merge-base --is-ancestor bee72b6 HEAD && git diff --name-status bee72b6..HEAD -- mail-worker/src/service/share-mail-service.js mail-worker/src/service/share-attachment-service.js mail-worker/test/share-mail-service.spec.js mail-worker/test/share-attachment-service.spec.js .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t11-note.md
git log --oneline --decorate bee72b6^..HEAD
pnpm --dir mail-worker exec vitest run test/share-mail-service.spec.js test/share-attachment-service.spec.js --no-cache
git diff --quiet bee72b6^..bee72b6 -- mail-worker/src/service/share-auth-service.js mail-worker/src/email/email.js; test $? -eq 0
git diff --check bee72b6^..bee72b6
git status --short && git diff --exit-code -- mail-worker/src/service/share-mail-service.js mail-worker/src/service/share-attachment-service.js mail-worker/test/share-mail-service.spec.js mail-worker/test/share-attachment-service.spec.js
```

测试结果：EXIT=0；2 个测试文件通过，45/45 用例通过。

## Update Log

- 2026-08-24 · 主 AI 过筛：P1-1 CHANGE。依据本轮红测 `maskAddress('a@@example.com', true)` 返回原串，不是 `***`。formal spec 要求 `local@domain`；多 `@` / 空白不是合法形态。已落地：`isMailboxAddress` 拒绝空白与第二个 `@`，非法样本扩进同一用例。
