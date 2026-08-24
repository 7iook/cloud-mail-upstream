# exec-t07-note · Session 建立幂等恢复(KV 结果重放,AC-SESS-10)

| 字段 | 值 |
|---|---|
| 任务 | T-07(T-07.1 红 + T-07.2 绿) |
| 分支 | `cursor/mailbox-share-capability-dcb6` |
| 起点 HEAD | `9b98dec`(会话开工时读到 `6c6f618`,执行期间同仓另一执行者推进到 `0d20768` → `9b98dec`,均为 docs commit,不含 W1 代码) |
| commit | `c2087ce` |
| 白名单外改动 | 无 |

---

## 1. 红 → 绿

红绿两次都在 `/tmp/t07-verify`(`git worktree add --detach HEAD` + 仅覆盖 T-07 白名单文件)里跑,
原因见 §5「并发污染」:`/workspace` 工作树里同时有另一执行者未提交的 T-12 改动
(`mail-share-service.js` / `mail-share-service.spec.js`),会把 `/mailShare/create` 打成
`SHARE_ACCOUNT_FORBIDDEN`,`share-api.spec.js` 全挂,与 T-07 无关。

### 红

```
$ pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-api.spec.js
  (src/ 为 HEAD 9b98dec 原样,test/ 已含 T-07 新用例)
 Test Files  2 failed (2)
      Tests  7 failed | 33 passed (40)
EXIT=1
```

失败的 7 条即 T-07 新增(6 条 service + 1 条 HTTP);第 8 条新用例
`skips the KV write when the token has less than the 60s KV minimum left` 在红期**空过**
——它断言的是「不写」,功能不存在时天然成立,只有在绿之后才有约束力。这一条是刻意保留的
边界护栏,不是伪红。

### 绿

```
$ pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-api.spec.js
 Test Files  2 passed (2)
      Tests  40 passed (40)
EXIT=0

$ pnpm --dir mail-worker test
 Test Files  17 passed (17)
      Tests  221 passed (221)
EXIT=0
```

基线守恒:213 → **221**(+8 = 7 service + 1 HTTP),零删除、零改写既有断言。
完整日志:`/opt/cursor/artifacts/t07_red_green.log`。

`/workspace` 原地复跑 `test/share-auth-service.spec.js` 同为 33/33 EXIT=0;
`test/share-api.spec.js` 在另一执行者改动落盘前也曾 7/7 EXIT=0(改动落盘后 7 条全挂,
挂点在 `/mailShare/create`,非 `/share/session`)。

---

## 2. 改了什么(file:lines)

### 生产代码

| 文件 | 行 | 内容 |
|---|---|---|
| `mail-worker/src/const/kv-const.js` | `:7` | 新增 `SHARE_EST: 'share:est:'` |
| `mail-worker/src/api/share-api.js` | `:56-57` | 读 `Idempotency-Key` 头,以 `{ idempotencyKey }` 作第 4 参传入。**未传 authKey**(T-08 own) |
| `mail-worker/src/service/share-auth-service.js` | `:21-23` | `KV_MIN_TTL = 60` / `ESTABLISH_REPLAY_TTL = 120` |
| 同上 | `:196` | `issueToken` 改返回 `{ sessionToken, exp }`——TTL 需要 token 真实剩余寿命,不从行上二次推导 |
| 同上 | `:287-289` | `replayCacheKey(lid, key)` → `share:est:<lid>:<key>` |
| 同上 | `:291-296` | `readIdempotencyKey(options)`,`trim()` 后空串 = 无 key |
| 同上 | `:298-312` | `readReplayCache`,读失败 fail-open 记 `share.system.error` / `reason=replay_cache_read_failed` |
| 同上 | `:314-329` | `writeReplayCache`,`remaining < 60` 静默跳过;否则 `expirationTtl = min(120, remaining)`;写失败 fail-open 记 `reason=replay_cache_write_failed` |
| 同上 | `:346-358` | **T07-R1 CHANGE 后**命中点:`matchSec` → `loadLiveAccount` → 查 KV → 命中直接返回;未命中才 `denyQuota(quota_snapshot)` / `assertAllowed` / `consumeSessionQuota` |
| 同上 | `:385-395` | 签发成功后按整个响应对象缓存,替换原先直接 return |

`SHARE_EVENT` 未移动;`share-attachment-service.js` / `init.js` / `security.js` /
`mail-share-service.js` 零改动。无新增生产测试缝——KV 走 `ctx({ kv })`,与 T-06 注入 `db` 同法。

### 测试

| 文件 | 行 | 内容 |
|---|---|---|
| `mail-worker/test/share-auth-service.spec.js` | `:151-172` | `quotaEvents` 抽出 `eventsNamed(lines, event)`,新增 `systemErrors` |
| 同上 | `:174-205` | `recordingKv({ getThrows, putThrows })`——记录 get/put 调用与 `options` |
| 同上 | `:934-1128` | `describe('shareAuthService establish idempotency replay')` 共 7 条 |
| `mail-worker/test/share-api.spec.js` | `:315-346` | 一条 HTTP 重放用例(同头两次 POST → 同 token、`access_count` 恒 1;第三次不带头 → 2) |

7 条 service 用例对应 T-07.1 全部要求:同 key 重放(用 `injectingDb` 的 `before` 在配额
UPDATE 上装引信,跑到就抛)、新 key / 无 key / 空白 key 各消耗一格且两 key 缓存互不串、
KV get 抛、KV put 抛(且证明重试再付一格)、`remaining < 60` 不写不记 error、
`expirationTtl` = 120 与 ≈90 两点验 `min(120, remaining)` 且恒 ≥ 60、AC-LEAK-05 日志无
sec/token/lid。

---

## 3. 与既有裁决的对齐

- API 层读头、service 只收普通参数(recon §3.2,照 `mail-share-api.js:25-26` 先例)。
- KV `expirationTtl` 最小 60s(recon §3.4 / R3 [P1]):`remaining < 60` 跳过写入且**不记 error**
  ——记 error 会把一个正常边界伪装成故障,污染 `share.system.error` 的告警信噪比。
- 跨 PoP 传播最长 60s → 重放可能落到读不到缓存的位置、退化为再消耗一格。已写进
  `writeReplayCache` 上方注释(recon §3.4 第二个陷阱要求的「实现注释显式记一句」)。
- 缓存的是整个 `{sessionToken, mailbox, expiresAt}`,重放响应与首发同形;不缓存 sec/authKey。
- 日志只出 `shareId` + 固定 `reason`。**KV key 里嵌了 lid,所以 key 本身永远不能进日志**
  ——这一条在代码注释里点名,并由 AC-LEAK-05 用例守住。

---

## 4. 遗留风险

### R-T07-1 · [P1 · 已裁决 T07-R1 CHANGE] KV 查询必须在快照配额判定之前

主 AI **CHANGE**:KV 查询落在 `loadLiveAccount` 之后、`denyQuota` / `assertAllowed` 之前。
依据:`design.md:357`「①③④ → 查 KV → 未命中才 UPDATE」;`requirements.md:95`;
AC-SESS-10 E2E 明文要求 `max_sessions=1` 响应丢失后同 key 重试成功且 `used_sessions` 恒为 1。

已落地:`share-auth-service.js:346-358` + 用例
`replays a max_sessions=1 share after the first slot is gone (AC-SESS-10)`。
换 key 仍走 `quota_snapshot` 拒发。吊销/过期后 ≤120s 窗口内重放仍可能吐出缓存 token,
回源 `resolveSession` 打死——与 AC-EDGE-13 TOCTOU 同类,不构成越权。

### R-T07-2 · [P2] 重放不校验缓存与当前行的一致性

缓存值里的 `expiresAt` 是首发时刻的快照。首发之后 Owner 若延长/缩短有效期,重放
(≤120s 窗口内)返回的仍是旧 `expiresAt`。token 本身携带的 `exp` 也是旧的,回源时以行为准,
所以不构成越权,只是响应里的展示字段可能陈旧 120 秒。design.md 要求「响应形状与首发一致」,
这里按字面实现;若后续要求「值也随行走」,得改成只缓存 token、其余字段重算。

### R-T07-3 · [P2] `Idempotency-Key` 未做长度/字符集约束

`share-api.js` 只做 `|| ''`,service 只做 `trim()`。一个超长 key 会拼进 KV key
(Workers KV 键上限 512 字节),超限时 `put` 抛错 → 被 fail-open 吞成 `share.system.error`,
行为安全(仍签发)但会刷日志。要不要在 API 层截断/拒绝,建议与 T-08 一并定。

### R-T07-4 · [P3] 幂等键不绑 `sec`

key 由客户端生成、只绑 `lid`。同一 `lid` 的两个持链者若撞了同一个 key,后者会拿到前者的
token。但走到重放查询前双方都已通过 `sec`(及后续 AuthKey)校验,即两人本就是同权持链者,
拿到同一 token 不越权。design.md:243 已把这条论证写死,此处只做记录。

### R-T07-5 · [P3 · 非漏登记] 前端侧未接线

design.md:240 要求访客页在发请求**前**生成 key 并写 sessionStorage(`share:est-key:<lid>`)。
T-07 只落服务端是规格分工;前端接线由 **T-26** 承载,不是漏登记。

---

## 5. 并发污染(与 T-07 无关,但影响复跑)

执行期间 `/workspace` 工作树里出现了另一执行者(T-12)的未提交改动:
`mail-worker/src/service/mail-share-service.js`、`mail-worker/test/mail-share-service.spec.js`(+587 行)。
后果:

- `pnpm --dir mail-worker test` 在 `/workspace` 直接跑会红,红点在 `syncPrimaryAccountId`
  (`mail-share-service.js:289` D1_TYPE_ERROR)与 `/mailShare/create` 返回 `SHARE_ACCOUNT_FORBIDDEN`,
  与 T-07 无因果。
- 本任务因此改用一次性 worktree 取干净读数。**过程中曾用 `git stash push -- mail-worker/src
  mail-worker/test` 做过一次隔离验证并 `stash pop` 还原**,已核对对方的 587 行改动完整回位;
  但这类操作在并发工作树上有风险,后续执行者请直接用 worktree,不要 stash。

W1 串行约定下 `share-auth-service.js` 单 owner 无冲突;`share-api.js` 目前也只有 T-07 在动。

---

## Update Log

- 2026-08-24 · 主 AI:T-07 代码审查 APPROVED p0=0(`review-t07.md`)。工件审查两条 P0 HOLD:A1 完成判决口径=后端 AC-SESS-10 非 T-26;A2 跨 PoP miss 已在 design.md:241 文档化为 fail-open。
- 2026-08-24 · 主 AI:T-07 入库 `c2087ce`。T07-R1 CHANGE。主 AI 独立复跑 34/34 + 7/7 EXIT=0。R-T07-5 裁定由 T-26 承载。未勾选尾:T-08 / T-12 → T-29。
