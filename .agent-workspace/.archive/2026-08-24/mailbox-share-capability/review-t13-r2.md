# T-13 Binding Batch 整改二轮独立审查

**VERDICT: APPROVED**

- 审查范围：提交 `22d9832` 相对父提交 `ee2db41`，仅指定的 3 个文件。
- P0 count：**0**
- P1 count：**0**
- 新阻塞 finding：**无**

## 已关闭

### C1 / P0-1：CLOSED

- `snapshotPredicate()` 以“没有快照外 `binding_id`”和“当前行数等于快照行数”共同证明集合相等；只比较数量导致 `{A}→{B}` 漂移漏检的问题已消除。
- CAS 是 batch 第 0 条语句；INSERT 与 DELETE 也各自带写入侧快照谓词，因此 CAS 落空后不会靠批后抛错掩盖已提交的 add/remove 残留。
- V2=false 的真实并发 `{A}→{C}` / `{A}→{D}` 回归断言并实测：仅 1 个 fulfilled，另 1 个返回 `SHARE_BINDING_CONFLICT`，终态恰为 1 条 Binding，主表 `account_id` 跟随赢家。
- 49→50 的并发双 add 回归同样只允许 1 个赢家，终态保持 50。
- 代码没有对 `SHARE_BINDING_CONFLICT` 自动重试；注释明确要求调用方重读后再决定，未复用过期 remove 列表。

### I1 / P1-1：CLOSED

- `prepareBindingInsert()` 已删除第二组展开的 `IN`，用 `COUNT(*) OVER () AS matched` 复用首组 JOIN；快照集合通过单个 `json_each(?)` 参数传入。
- 绑定参数公式为 `N + 6`，N=50 时为 **56 ≤ 100**；最大合法替换的 DELETE 为 `R + 5`，R=50 时为 **55 ≤ 100**。
- create/update 仍调用同一个 `prepareBindingInsert()`；现有 SQL 文本逐字比较测试通过。
- 真实 owned account 的 N=48、N=50 create 测试以及 50→50 最大合法 update 测试均通过；参数预算断言覆盖 batch 内每条语句。

### M1：CLOSED

- CAS SQL 仅执行 `UPDATE mail_share SET remark = remark`，未赋值 `credentials_version`、`access_count`、`account_id` 或 `window_start_email_id`。
- 并发替换回归证明输家结束后主表 `account_id` 与赢家 Binding 一致；未发现 CAS 引入的新 P0。

## 新 findings

无功能性 finding。

非阻塞文档备注：测试注释称本地 miniflare“不强制”100 参数限制，而同提交的执行记录称红测实际触发 `too many SQL variables`。这不影响回归有效性，因为测试同时执行真实 N=48/50 写入并直接断言占位符预算。

## 实际执行的命令

- `git show 22d9832 --stat` → EXIT 0；仅指定 3 个文件，372 insertions / 38 deletions。
- `git diff ee2db41..22d9832 -- mail-worker/src/service/mail-share-service.js` → EXIT 0。
- `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` → EXIT 0；1 file / **164 tests passed**。
- `git status --short --branch && git rev-parse HEAD && git diff --name-only ee2db41..22d9832` → EXIT 0。
- `git diff ee2db41..22d9832 -- mail-worker/test/mail-share-service.spec.js` → EXIT 0。
- `git diff ee2db41..22d9832 -- .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t13-note.md` → EXIT 0。
- `git diff --name-only 22d9832..HEAD -- mail-worker/src/service/mail-share-service.js mail-worker/test/mail-share-service.spec.js .agent-workspace/.archive/2026-08-24/mailbox-share-capability/exec-t13-note.md && git merge-base --is-ancestor 22d9832 HEAD` → EXIT 0；三文件在目标提交后未再变化，目标提交是当前 HEAD 的祖先。
- `git diff --check ee2db41..22d9832 && git show --format= --name-only 22d9832` → EXIT 0；补丁无空白错误，变更文件范围准确。

## VERDICT

status: APPROVED  
p0_count: 0  
ready_to_merge: YES  
one_line: 写入侧集合 CAS 已使同快照并发等量替换只能一胜一冲突，且共享 Binding INSERT 在 N=50 时仅 56 个绑定参数；首轮 P0-1、P1-1 均关闭。
