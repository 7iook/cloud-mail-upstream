# T-13 Binding 原子变更独立代码审查

**VERDICT: NEEDS_CHANGES**

范围：仅审查提交 `ee2db41`（`feat(worker): add atomic PUT /mailShare/bindings`）及指定四个文件；当前分支 `cursor/mailbox-share-capability-dcb6`。T-10、T-12 指纹/flag、T-17 `share:manage` 均排除，只有 T-13 对共享 `prepareBindingInsert` 的改动纳入审查。工作区其他未跟踪文件不在本审查范围。

## P0 / P1 / P2 findings

| id | severity | file:line | claim | independent verification |
|---|---|---|---|---|
| P0-1 | Critical | `mail-worker/src/service/mail-share-service.js:685-704,793-822` | **What's wrong:** Binding 集合、投影上限与 V2 栅栏只在 batch 前的旧快照上校验；batch 后只检查 add 的 `changes`，从不确认 remove 命中数，也没有把“预检时的 Binding 集合/数量”作为写入谓词。两个并发等量替换都从 `{A}` 出发，分别执行 `add B/remove binding(A)` 与 `add C/remove binding(A)`：两者都算出 projected=1，故 V2=false 也放行；第一批得到 `{B}`，第二批 INSERT C 成功、DELETE A 为 0 行却仍被当作成功，终态变为 `{B,C}`。这既无法对应任一合法串行次序，也直接把 V2=false 的 1→N 栅栏绕开。相同交错从 50 条开始还会得到 51 条，违反 AC-CAP-13。**Why it matters:** AC-BIND-12 的“新集合成为唯一真源或整单零残留失败”、AC-LIFE-11 与 50 条硬上限均不是并发不变量；滚动发布时可落入旧 Worker 无法执行的 multi 状态。**How to fix:** 在同一 batch 的写语句中加入预期集合/计数门禁，使快照已漂移时 add、remove、revoke、sync 全部不写；并校验 remove 的预期命中数。不能仅在 batch 返回后抛错，因为 D1 已提交。补一条 V2=false 并发双替换回归及一条 49/50 边界并发回归。 | 代码路径确定：`:696-703` 仅以预读 `current.length` 判 cap/fence；`:807` 的 DELETE add-guard 只证明 C 已插入，不证明 A 仍存在；`:820-822` 只检查 INSERT changes。现有 T-13 用例没有两个 `updateBindings` 的 `Promise.all/Promise.allSettled` 竞争测试，唯一并发 update 用例只在 batch 前软删 account。 |
| P1-1 | Important | `mail-worker/src/service/mail-share-service.js:505-530,536-556,628-630` | **What's wrong:** T-13 为复用的 `prepareBindingInsert` 重复展开 accountId 占位符，单条语句绑定数为 `2N+5`；合法的 N=48 已是 101，超过生产 D1 每查询最多 100 个 bound parameters。该 helper 同时服务 create 与 update，所以 48–50 个自有邮箱的合法 create/add 会在生产报 `too many SQL variables`，而不是按契约成功。大规模等量替换的 DELETE 还会使用 `removeN + addN + 3` 个绑定。**Why it matters:** `SHARE_BINDING_LIMIT=50` 的合法上界实际上不可达，并且这是 T-13 对 T-12 create 路径造成的回归；155 条测试只证明小集合，50 边界测试使用不存在的 accountId，在进入 SQL 前即失败。**How to fix:** 保持唯一 `prepareBindingInsert` 方言，但改为不重复消耗绑定槽位的请求集合表示/可复用参数，并增加 48、50 个真实 owned account 的 create/update 回归，同时覆盖合法大规模替换。 | Cloudflare 官方 D1 Limits：`Maximum bound parameters per query = 100`（https://developers.cloudflare.com/d1/platform/limits/）。当前 bind 顺序为 flag 1 + 首组 N + user/lid 2 + 次组 N + user/count 2，即 `2N+5`；N=48 时为 101，N=50 时为 105。 |
| — | Minor | — | 未发现独立 P2 缺陷。 | — |

## Requirement checks

| 检查项 | 结论 | 证据 |
|---|---|---|
| add 归属计数谓词 / 0-row INSERT | PASS（单命令 account 删除竞态） | `prepareBindingInsert` 的归属 COUNT 使多 add 全插或全不插；add 归零时 DELETE guard 阻止 remove，定点用例覆盖。 |
| remove 三重谓词与存在性隐藏 | PASS（非并发） | DELETE 同时带 `binding_id IN (...) + share_id + mail_share.user_id`；预检对他人/未知 bindingId 统一 `SHARE_BINDING_FORBIDDEN`，且测试证明两边零变更。 |
| 全有或全无 | **FAIL（P0-1）** | 单批次本身成立，但 batch 未绑定预检集合，0-row DELETE 被静默当成功；并发双替换可产生第三种集合。 |
| 删空转 REVOKED | PASS | DELETE 后的 `NOT EXISTS` 撤销语句与其他写入位于同一 batch，最后一条 Binding 删除测试同时断言 `revoked_at`。 |
| 主表双写且永不写 0 | PASS | `syncPrimaryAccountId` 同批执行并有 Binding `EXISTS` 门禁；删空时保留旧非零主列，剩余 Binding 时 account/window 跟随最小 binding_id。 |
| V2=false 不扩展 1→N | **FAIL（P0-1）** | 串行 1→N 被拒；并发两个 1→1 替换可实际提交为 1→2。 |
| projected count >50 不写 | **FAIL（P0-1）** | 串行投影检查正确；并发 add/替换没有写入侧 count 门禁，可提交第 51 条。 |
| `prepareBindingInsert` 单一方言 | PASS（结构）/ **FAIL（P1-1 生产边界）** | create/update 确实调用同一 helper，SQL 文本比较测试通过；但新增的重复占位符使共享 create 路径在 48–50 条时超过 D1 限制。 |
| API `PUT /mailShare/bindings` | PASS（T-13 范围） | 路由读 JSON、取当前 userId、调用 service 并复用统一 BizError envelope；`share:manage` 精确路径按指令留给 T-17。 |

## HOLD vs CHANGE

- **HOLD**：复用唯一 `prepareBindingInsert`；per-binding window 快照；account 存活/归属 COUNT；add 归零时 DELETE guard；remove 三重资源谓词与统一 `SHARE_BINDING_FORBIDDEN`；删空同批 REVOKED；`syncPrimaryAccountId` 同批且不写 0；同一 account 同时 add/remove 返回 `SHARE_BINDING_DUPLICATE`；T-17 再扩 `premKey['share:manage']`。
- **CHANGE**：① 给 batch 增加写入时的预期 Binding 集合/数量门禁并验证 remove 命中，封死并发双替换造成的 V2 与 50 上限绕过；② 将合法 50 上限内的 INSERT/DELETE 参数预算压到 D1 的 100 以下，并用真实 owned account 覆盖 48/50 边界。

## Verification

- `git show ee2db41 --stat` → 仅指定 4 个文件，721 insertions / 12 deletions。
- `git merge-base --is-ancestor ee2db41 HEAD` → EXIT 0。
- `git diff --exit-code ee2db41..HEAD -- <指定四文件>` → EXIT 0。
- `git diff --check ee2db41^..ee2db41` → EXIT 0。
- `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` → EXIT 0；1 file / 155 tests passed。
- Cloudflare D1 官方限制核对：每查询最多 100 个 bound parameters；当前共享 INSERT 在 N=48/50 时分别需要 101/105。

## Update Log

- 2026-08-24 · 主 AI过筛：P0-1 CHANGE（并发双替换：双方预检 `{A}`、projected=1，第二批 INSERT C 成功且 DELETE A 为 0 行 → `{B,C}`，绕过 V2/50）。P1-1 CHANGE（T-13 给 `prepareBindingInsert` 加第二组 `IN` 后 `2N+5`；N=48 即 101 > D1 100；T-12 create 同 helper 回归）。HOLD：T13-DUP、T-17 premKey。

## VERDICT

status: NEEDS_CHANGES
critical_count: 1
important_count: 1
minor_count: 0
ready_to_merge: NO
one_line: 顺序路径、三重 remove、删空撤销与主表双写均由 155/155 证明，但 stale precheck 可让并发替换绕过 V2/50 上限，且共享 INSERT 在 48–50 条时超过生产 D1 的 100 参数限制。
