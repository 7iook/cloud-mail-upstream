# T3 · emails 建分享 + provision · 高风险传播链独立审查

- 被审对象：`/tmp/share-review`，HEAD `9b6eb8072fe73c93518e872037702a2e8e54056b`
- 对比基线：`origin/main...HEAD`
- 审查范围：仅 `provision-invariant-parity`、`env-domain-ssot`、`d1-batch-atomicity`、`fingerprint-compat-window`
- 结论：**CHANGES_REQUIRED**
- Findings：**P0 × 1，P1 × 1，P2 × 1**

## Findings

### T3-P0-1 · V2=false 批量可提交部分 share/account，并由幂等回读伪装成成功

1. **严重度**：P0（阻塞）。请求承诺“整单失败零残留”，实际可在归属竞态下提交子集；带幂等键的正常前端请求还会收到成功响应。
2. **置信度**：高。源码谓词逐句可推导，并已在隔离副本上用真实 D1/Vitest 稳定复现。
3. **证据锚点**：
   - `mail-worker/src/service/mail-share-service.js:1200-1202,1265-1315`：V2=false 将地址拆成逐组 share 语句，account/share/binding/幂等写入同一 batch。
   - `mail-worker/src/service/mail-share-service.js:823-892`：每条 share 只校验当前 `item.group` 的 account 归属计数，不校验本次完整 `body.emails` 集合。
   - `mail-worker/src/service/mail-share-service.js:1062-1078`：幂等行只要求首个 `lid` 存在。
   - `mail-worker/src/service/mail-share-service.js:1317-1355`：batch 已提交后才检查 `shareRows.every(...)`；失败时先回读幂等行，再重查归属。
   - `mail-worker/src/service/mail-share-service.js:649-693`：批量重放只检查“至少查到一行”，未验证查回的 distinct lid 数等于请求中的 `lids.length`。
   - 契约反证：`.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:101-106` 明确要求 share 失败时 account 一并回滚、N 条单分享全在同一 batch。
4. **触发条件**：V2=false；一次请求含两个地址；预校验后、batch 前，其中一个复用 account 被并发软删/易主，而另一个地址仍有效（可为待新建地址）。前端默认携带 `Idempotency-Key`。
5. **失效机制**：D1 batch 只在语句报错时回滚，条件 INSERT 的 0 行不是错误。有效组的 account/share/binding 会写入，无效组的 share 只返回 0 行；首组成功时幂等行仍会写入。batch 返回后，代码先命中该幂等行，`replayBatchFromLids` 又接受缺失部分 lid 的结果，于是把子集包装成 `{shares, idempotentReplay:true}` 返回。
6. **用户/数据影响**：两地址请求可能只创建一条链接却报告成功；若首组失败、后组成功，则调用方收到错误但后组 share/account 已提交。由此产生部分分享、用户未确认的 account 行，以及与请求目标不一致的幂等账本。
7. **修复与回归**：
   - 写侧必须让所有组共享“完整邮箱集合仍全部归属且存活”的事务内谓词；不能只检查各 `item.group`。
   - 幂等 INSERT 必须以预期全部 lid 已落库为条件；`replayBatchFromLids` 也应校验 distinct lid 完整性，缺一条即 fail-closed。
   - 补回归：在 `beforeBatch` 中软删第二个复用 account 后让真实 batch 继续执行，分别覆盖“首组成功/首组失败”和“有/无幂等键”，断言零新增 account、零 share、零 binding、零幂等行。

### T3-P1-1 · 角色邮箱配额仅预读，两个并发 provision 可同时越额

1. **严重度**：P1。可稳定突破角色 `account_count`，但未发现跨租户绑定或凭据泄露。
2. **置信度**：高。隔离副本中以两个并发真实 create 调用复现：额度 2、初始占用 1，两个请求均成功，最终活跃 account 数为 3。
3. **证据锚点**：
   - `mail-worker/src/service/mailbox-provision.js:139-160`：角色配额只在 batch 前通过 `owned + missing.length > accountCount` 预检。
   - `mail-worker/src/service/mailbox-provision.js:171-176`：account INSERT 本体不含角色配额谓词。
   - `mail-worker/src/service/mail-share-service.js:1253-1271`：分享入口注入的 account guard 只检查 `SHARE_ACTIVE_LIMIT`，没有 `role.account_count`。
   - `mail-worker/test/mail-share-emails.spec.js:303-319`：现有配额用例只有串行“已满后再请求”，未覆盖两个请求同时在剩余一格时通过预检。
4. **触发条件**：非管理员用户的角色设置有限 `account_count`；当前尚余至少一格；对不同未注册地址并发发起两个或更多 create 请求，使它们在任一 batch 提交前都完成 `planMailboxProvision`。
5. **失效机制**：两个请求读到同一 `owned` 快照并均通过。D1 随后虽串行提交 batch，但 account INSERT 不重查角色配额，因此后提交者不会观察并拒绝先提交者新增的 account。
6. **用户/数据影响**：Owner 可通过并发分享请求持续越过邮箱数上限。该入口按设计不走 Turnstile，因此配额成为主要资源约束时，这个 TOCTOU 可直接转化为资源滥用。
7. **修复与回归**：
   - 将同请求的全部 missing 地址合并为一条条件 `INSERT ... SELECT`，在该语句内按最终新增数量校验角色配额；UNIQUE 冲突仍应使整批报错回滚。
   - 补双请求屏障测试：两次 plan 完成后同时放行 batch，断言至多一个请求成功，最终活跃 account 数不超过 `account_count`。

### T3-P2-1 · provision 搬家改变了前缀黑名单的大小写语义

1. **严重度**：P2。属于设置页既有行为回归，不扩大授权。
2. **置信度**：高。新旧表达式直接可比。
3. **证据锚点**：
   - 基线 `origin/main:mail-worker/src/service/account-service.js:47`：`getName(email).includes(content)`，原样、区分大小写。
   - 当前 `mail-worker/src/service/mailbox-provision.js:98-103`：prefix 与 token 两端均 `toLowerCase()`。
   - `mail-worker/test/mail-share-emails.spec.js:285-301,465-485`：仅覆盖小写分享前缀，以及设置页的重复/未知域名；没有锁定大小写迁移语义。
4. **触发条件**：`emailPrefixFilter` 含 `spam`，用户通过设置页添加 `SPAM@example.com`（或任意仅大小写不同的命中项）。
5. **失效机制**：旧实现允许该地址，新 SSOT 会以 `PREFIX_FORBIDDEN` 拒绝；`accountService.add` 已改走该 SSOT，所以这不是只有新分享入口才有的加强。
6. **用户/数据影响**：升级后，一批此前可添加的大小写 local-part 地址会突然失败。错误文案不变，调用方无法区分这是规则语义变更还是原有规则命中。
7. **修复与回归**：明确裁决。若要求搬家等价，恢复原样比较；若大小写不敏感是有意加强，则把变更写入契约，并为 `accountService.add` 与 emails 分享入口各加同一组大小写正反例。

## 传播链闭合

### 1. provision-invariant-parity

| 不变量 | 当前落点 | 对比结果 |
|---|---|---|
| 邮箱格式 | `mailbox-provision.js:91-94` → `verify-utils.js:2-4` | 与旧设置页同一 regex，等价 |
| 配置域名 | `mailbox-provision.js:88,95-97` | 改为解析后小写精确匹配；这是本主题明确要求的修正 |
| 前缀长度/黑名单 | `mailbox-provision.js:98-104` | 最小长度等价；黑名单从大小写敏感改为不敏感，见 T3-P2-1 |
| UNIQUE / 已删 / 他人 / 自有复用 | `mailbox-provision.js:107-137,166-176` | NOCASE 查找、状态与 owner 判定齐全；并发 UNIQUE 会报错而非静默 0 行 |
| 角色邮箱配额 | `mailbox-provision.js:139-151` | 单请求算式正确；缺事务内谓词，见 T3-P1-1 |
| 角色域名权限 | `mailbox-provision.js:145-159` → `role-service.js:157-171` | 对存在角色时保持精确域名相等；admin 豁免保持 |

设置页入口保留 `addEmail/manyEmail` 与 Turnstile 包装（`account-service.js:43-95`），分享入口不走这些门是已裁决差异，不作为 finding。

### 2. env-domain-ssot

全仓生产代码的 `c.env.domain` 读点已列清：

| 读点 | 口径 |
|---|---|
| `mail-worker/src/service/mailbox-provision.js:52-64,88-96` | JSON 字符串/数组统一解析，小写后数组精确匹配 |
| `mail-worker/src/service/setting-service.js:48-63` | JSON 字符串先 parse，再映射为展示用 `@domain`；不是成员匹配点 |
| `mail-worker/src/service/login-service.js:64` | 仍直接 `.includes(domain)`；当 env 是字符串时为宽子串匹配 |
| `mail-worker/src/service/user-service.js:309` | 同上，仍宽匹配 |
| `mail-worker/src/service/public-service.js:107` | 同上，仍宽匹配 |

`deploy-cloudflare.yml:76-79,126-130` 在该部署路径上要求 `DOMAIN` 是 JSON array 并写成 TOML 数组，因此上述三处在线上主工作流中通常执行数组成员匹配；Dashboard/其它部署把变量留成 JSON 字符串时仍会退化为子串匹配。决策卡 `:276` 明确本期只保证分享创建路径，不要求扫射其它入口，故记录为残余面，不另报 T3 finding。

### 3. d1-batch-atomicity

| 谓词 | 零行语义核对 |
|---|---|
| 归属 | **不成立**：每组独立计数，合法组可写、失效组可 0 行；D1 不因 0 行回滚，见 T3-P0-1 |
| 限额 | `SHARE_ACTIVE_LIMIT` 的 account guard 与第 i 条 share 的折算在无其它失配时同值，能做到整批全写或全 0；但角色 `account_count` 完全不在写谓词中，见 T3-P1-1 |
| 幂等 | **不成立**：幂等行只依赖首 lid，批量回读又不核对 lid 完整性，可把部分提交翻成成功重放，见 T3-P0-1 |

既有 `insertShareAndIdempotency` 的单分享路径在 `mail-share-service.js:1088-1128` 只有一个 share 结果，零行后回读/消歧不会出现“组间一半成功”；问题由 emails 的 N 组语句扩展引入。

### 4. fingerprint-compat-window

双入口映射如下（`M_id`/`M_email` 为各自现代 body hash，`L` 为旧四字段 hash）：

| 入口与归一化结果 | stored | accepted | 结论 |
|---|---|---|---|
| `emails` 缺省/空；单 `accountId` + 默认配置 | `L` | `{M_id, L}` | 保持旧 Worker 双认 |
| 单 `emails`；已解析为自有存量 account + 默认配置 | `L` | `{M_email, L}` | 与 accountId 入口以 `L` 相交，可跨入口重放 |
| 单 `emails`；首次地址缺失 | `M_email` | `{M_email}` | 首次无法预知自增 accountId，落现代 hash |
| 上一行成功后的同 emails 重试 | 计算得到 `stored=L`，但先读旧幂等行 | `{M_email, L}` | 已持久化的 `M_email` 被接受，重放成功；不会改写 stored |
| 多 emails 或任一非默认配置 | 对应 modern hash | `{modern}` | 不冒充旧 Worker 可执行载荷 |

`normalizeCreateBody` 在非空 emails 时先清空 `accountIds`，再把排序后的 emails 作为末键（`mail-share-service.js:203-231`）；`createMailShare` 只在非空数组时转发 emails，否则沿用 accountId(s)（`mail-vue/src/request/mail-share.js:34-61`）。空 `emails:[]`、同 emails 重试、accountId→emails 桥接已有回归（`mail-share-emails.spec.js:336-400`）。本链未发现指纹冲突缺陷。

## 验证证据

- `mail-vue`: `pnpm exec vitest run src/request/mail-share.spec.js` → **1 file / 10 tests passed**。
- 先完成前端 release build以生成 Worker assets；随后 `mail-worker`: `pnpm exec vitest run test/mail-share-emails.spec.js` → **1 file / 25 tests passed**。
- 隔离副本运行两条定向复现：`pnpm exec vitest run test/t3-review-repro.spec.js` → **1 file / 2 tests passed**。两条断言分别证实：
  1. 请求两个地址后返回 `idempotentReplay=true` 且仅 `shares.length===1`，数据库已提交一条 share 和新 account；
  2. 角色额度 2、初始占用 1 时，两次并发 provision 均成功，最终 account 数为 3。
- 复现文件只存在于 `/tmp/share-review-t3-repro` 隔离副本；被审树 `/tmp/share-review` 保持 `git status --short` 为空。

## 最终判定

T3 当前不能合入：P0 的部分提交/伪成功破坏 DC-P0-3，P1 的事务外角色配额可被并发绕过。指纹兼容链本身闭合；域名 SSOT 在分享与设置页建号路径成立，其它三处字符串宽匹配是已知残余面。
