# P0-2 修复：续期写入路径补 CAS 守卫

来源：`review-t22b.gpt.md` P0-2（GPT-5.6 Sol 独立审查，`status: NEEDS_CHANGES`）
基线 HEAD：`632a931`（工作区带未提交的「有效期上限 + 续期 + 配额」三包）
独占文件：`mail-worker/src/service/mail-share-service.js` · `mail-worker/test/mail-share-service.spec.js`

## 成功状态（逐字抄自交付契约，未改写）

> NOT「UPDATE 语句的 WHERE 多了两个条件」, BUT 管理员点「延长有效期」的同时,如果另一个管理员正好在重置访问密钥、或撤销了这条分享,续期不会假装无事发生地成功 —— 它要么在正确的顺序上生效,要么明确失败让人重试。两个人同时续期时,最终到期时间不取决于谁的请求碰巧后到。
>
> 不该发生: 管理员收到「续期成功」,但期间发生的凭据轮换/撤销被静默覆盖。
> 来源: review-t22b.gpt.md P0-2

### 链路逐格核实

| 节点 | 契约给的锚点 | 核实结果 |
|---|---|---|
| 预读 | `loadMutableShare()` :1074-1082 | 属实。实际 :1074（改后 :1110）。原 SELECT 只取 `share_id, lid, only_messages_after_created, auth_key_enabled, create_time` |
| 写入谓词 | `prepareUpdate()` WHERE :1025-1034 | 属实。原 WHERE = `share_id / user_id / status='ACTIVE' / expires_at > now`，确无快照列 |
| 续期 UPDATE | :1322-1337 | 属实。`update()` 唯一写入点，零命中原样抛 `SHARE_NOT_FOUND` |
| 最终 sink | D1 `mail_share.expires_at` / `delete_at` | 已由测试直读行断言 |

## 改了什么

1. **`loadMutableShare()`**：SELECT 增加 `credentials_version, expires_at`。
2. **`prepareUpdate()`**：WHERE 增加 `AND credentials_version = ? AND expires_at = ?`，两值取自预读快照。
   保留原有 `expires_at > ?`（活跃时间判据）—— CAS 只证明「没人动过这一行」，证不了「此刻还没过期」，预读与写入之间流逝的真实时间只有它能拦。
3. **`update()` 零命中分流**：新增 `throwUpdateMiss()`，回查一次活跃谓词。
   行没了 → 仍是 `SHARE_NOT_FOUND`；行还在但快照过时 → `SHARE_UPDATE_CONFLICT`。

### 为什么是这两列，且一列都不能少

- `credentials_version` 认**凭据轮换**（`resetAuthKey` 的 reset/disable，是全仓唯一写这一列的语句，已 grep 确认）。
- `expires_at` 认**另一次续期** —— 续期本身不动 cv，所以 cv 拦不住并发续期。
- **撤销不需要新谓词**：`prepareRevoke` 写 `status='REVOKED'`，既有的 `status = 'ACTIVE'` 已经拦住。
  → 因此审查原文「预读之后、UPDATE 之前发生……撤销 → 续期仍然成功」这半句**不成立**，撤销那一路本来就是安全的。真正的缺口只有 cv 轮换与并发续期两条。这是我对审查结论的一处收窄，测试里也照实标注了。

变异验证（下文）已分别证明两列各自承载不同用例，没有一列是装饰。

## 影响面核实：`prepareUpdate()` 是不是只被续期用？

**不是。** `git grep` 确认 `prepareUpdate` 只有 :1333 一个调用点（在 `update()` 里），但 `update()` 走的是 `UPDATE_FIELDS` 九字段白名单——`name / remark / maxSessions / messageLimit / otpExtractionEnabled / autoRefresh / refreshIntervalMs / showFullAddress / expiresAt` **全部共用这一条 UPDATE**。所以 CAS 一加，九个字段一起受约束。

**结论：不隔离，让九个字段一起走 CAS。** 逐项核实如下。

判据是「会不会产生误报冲突」，即：有没有**常规流量**会在预读与写入之间动这两列。

| 潜在写者 | 是否动 cv / expires_at | 判定 |
|---|---|---|
| `prepareAuthKeyUpdate`（resetAuthKey reset/disable） | 动 cv | 这正是要拦的，管理员显式动作 |
| `prepareRevoke`（revoke / 删空转撤销 / 级联） | 都不动（只写 status + revoked_at） | 由 `status='ACTIVE'` 拦，与 CAS 无关 |
| `prepareUpdate` 自身（续期） | 动 expires_at | 这正是要拦的，管理员显式动作 |
| **`consumeSessionQuota`（访客建会话，`share-auth-service.js:481-501`）** | **只写 `access_count` / `last_access_at`** | **关键**：常规访客流量不碰这两列，因此不会把管理员的一次改名冲掉 |
| 定时清理 / create | 不在 update 并发面上 | 无关 |

所以把 CAS 收窄成「仅当 patch 含 `expiresAt` 时才加」是**没有收益的**：它不能消除任何误报（本来就没有误报源），却会给其余八个字段留一条无守卫的先读后写路径——那些字段同样会盖掉期间的凭据轮换。九个字段统一 CAS 更安全且更简单，故不隔离。

代价是显式的、可接受的：改名与并发的密钥重置相撞时会报冲突要求重读。已写成用例 `applies the same guard to a non-renewal field on the shared statement` 钉住这是刻意语义，不是回归。

**同构性**：这不是新发明的写法。`prepareAuthKeyUpdate:1153-1154` 的 `AND auth_key_enabled = ?` 迁移守卫、`consumeSessionQuota` 的 `cv + auth_key_enabled + status + expires_at` 全量重断言，都是同一条原则「预读到的事实必须进写入谓词」。本次是把 `update()` 补齐到该原则，不是另创一套。

## 错误码选择理由

**新增 `SHARE_UPDATE_CONFLICT`；`SHARE_NOT_FOUND` 保留给「行真的没了」。**

先看能不能复用：

| 既有码 | 能否复用 | 理由 |
|---|---|---|
| `SHARE_NOT_FOUND` | ✗ | 正是审查点名的「误报不存在」。行还在、重读重发就能成，报不存在会让管理台关掉抽屉，把可恢复动作演成不可恢复 |
| `SHARE_BINDING_CONFLICT` | ✗ | 语义是绑定集合被并发改写。续期/改名一个绑定都没碰，管理台会显示「绑定冲突」——错的提示比没有提示更坏 |
| `SHARE_IDEMPOTENCY_CONFLICT` | ✗ | 语义是同 Key 异请求体，属于 create 侧幂等语义，与并发快照失效无关 |

两个既有 CONFLICT 码都带资源名限定，跨资源复用会直接产生错误文案，所以新增。这也符合本模块既有先例：`SHARE_BINDING_CONFLICT` 本身就是 T13-P0-1 为绑定 CAS 单独加的——**一个 CAS 面一个冲突码**是这里已经在走的路子。

**为什么放出可区分的码不重开存在性探针**：`:1105` 那条「他人/不存在/已撤销/已过期共用 `SHARE_NOT_FOUND`，不新增可区分错误码」约束的是**预读之前**的探测面。能走到 CAS 零命中这一步的调用方，已经过了 `loadMutableShare` 的归属门——行的存在与归属对它早就不是秘密，再区分不泄露任何新信息。

**分流实现**：`throwUpdateMiss()` 回查一次 `loadMutableShare`。这次回查只是**解释**不是判据：判据永远是那条 CAS UPDATE 自己的谓词，回查本身也会被下一次并发赶上，所以它只负责挑错误码，不负责决定写不写，更不据此重发写入。只跑在失败路径上。

## 红绿与变异证据

命令一律 `pnpm vitest run test/mail-share-service.spec.js -t "<filter>"`（cwd = `mail-worker`）。

### 绿（改动完成后）

```
✓ refuses the renewal when credentials rotate between the pre-read and the write (P0-2)
✓ refuses the renewal when the share is revoked between the pre-read and the write
✓ lets exactly one of two concurrent renewals win, on the row and not by arrival order
✓ applies the same guard to a non-renewal field on the shared statement (P0-2 blast radius)
✓ keeps the plain renewal working and carries both CAS columns in the WHERE (P0-2)
Tests  5 passed | 239 skipped (244)     EXIT=0
```

### 变异 M1 · 两列 CAS 全部去掉

```
× refuses the renewal when credentials rotate ...        → expected BizError
✓ refuses the renewal when the share is revoked ...      （见下方说明，预期绿）
× lets exactly one of two concurrent renewals win ...    → expected BizError
× applies the same guard to a non-renewal field ...      → expected BizError
× keeps the plain renewal working and carries both ...   → expected ' share_id = ? AND user_id = ? AND sta…' to match /credentials_version\s*=\s*\?/i
Tests  4 failed | 1 passed | 239 skipped (244)     EXIT=1
```

撤销那条**在变异下仍然绿，这是预期的**：它的判据是既有的 `status='ACTIVE'`，不是 CAS。用例里已写明留它的理由——回归护栏（防止哪天把活跃谓词一起「优化」掉）+ 钉住错误码分流（行真没了要报 NOT_FOUND，不能报成「重试就好」的 CONFLICT）。不把它算作 CAS 的取证。

### 变异 M2a · 只保留 `credentials_version`（去掉 `expires_at`）

```
✓ credentials rotate ...        ✓ revoked ...        ✓ blast radius ...
× lets exactly one of two concurrent renewals win ...   → expected BizError
× carries both CAS columns in the WHERE ...             → to match /expires_at\s*=\s*\?/i
Tests  2 failed | 3 passed     EXIT=1
```

### 变异 M2b · 只保留 `expires_at`（去掉 `credentials_version`）

```
× credentials rotate ...                                → expected BizError
✓ revoked ...        ✓ concurrent renewals ...
× applies the same guard to a non-renewal field ...     → expected BizError
× carries both CAS columns in the WHERE ...             → to match /credentials_version\s*=\s*\?/i
Tests  3 failed | 2 passed     EXIT=1
```

M2a / M2b 交叉证明两列各自承载不同用例，任一列缺失都会漏掉一整类并发。

### 还原后复跑（⚠️ 变异态已还原）

```
pnpm vitest run test/mail-share-service.spec.js -t "pre-read|concurrent renewals|blast radius|CAS columns"
Tests  7 passed | 237 skipped (244)     EXIT=0
```

（该过滤串比变异轮宽，额外命中 2 条既有续期用例，一并绿。）

`git diff` 已复核，`AND credentials_version = ? AND expires_at = ?` 与两个 bind 值均在位，无变异残留。`ReadLints` 两文件均无告警。

## 全量后端测试

```
pnpm --dir mail-worker test
Test Files  18 passed (18)
Tests  663 passed (663)     EXIT=0     Duration 71.16s
```

基线 654 → 663，只增不减。**+9 的归属核实**（分文件计数）：

| 文件 | 现用例数 | 归属 |
|---|---|---|
| `mail-share-service.spec.js` | 244 | 我：239 → 244，**+5** |
| `share-auth-service.spec.js` | 69 | 并行执行者（P1-3 token 时间校验） |
| `share-api.spec.js` | 12 | 并行执行者 |

审查时三文件合计 316，现为 244+69+12=325，差 +9；我的 +5，其余 +4 全部落在我从未打开的两个文件里。`git diff --numstat` 确认我只改了独占的两个文件：`mail-share-service.js` (+123/-12，含本轮之前已有的未提交续期改动) 与 `mail-share-service.spec.js` (+347/-1)。

## Review Findings

1. **收窄了审查的一处判断（Tier 1 自纠，未停下请示）**：审查原文把「并发撤销」列为缺口之一，实测 `prepareRevoke` 只写 `status='REVOKED' / revoked_at`，而既有 WHERE 已含 `status = 'ACTIVE'`——撤销那一路本来就安全。真正的缺口是 cv 轮换与并发续期两条。仍按要求写了撤销用例，但在代码注释与本报告中标明它在变异下预期绿、不构成 CAS 取证，避免留下「测了就是防住了」的假证据。

2. **顺手修正一处注释与代码的事实漂移（同文件，独占范围内）**：`applyRenewal` 上方注释原写「要立即失效请走 revoke —— 那条路径才会写 revoked_at 并递增 credentials_version」。`prepareRevoke` 实际**不动** `credentials_version`（机制本身没问题：在飞 Session 由 `consumeSessionQuota` 的 `status='ACTIVE'` 谓词掐断，不需要 cv）。已把注释改成实况。属注释订正，不改任何行为。

3. **测试基础设施：为什么不用 `Promise.all` 撞并发**。`resetAuthKey` 比 `update` 多几个 await（mint key + digest），在单线程事件循环里**稳定地后写**，所以 `Promise.all([update, resetAuthKey])` 测到的是一次完全合法的线性化——CAS 拆掉照样绿，取证为零。改用 `ctxStallingUpdate()`：代理 `env.db`，把干扰精确钉在第一条 `UPDATE mail_share` 真正 `run()` 之前（即预读之后、写入之前那条缝），随后放行让 `loadOwnerDetail` 照常走。变异验证证明这个夹具是有效的（拆掉 CAS 确实变红）。

4. **⚠️ 需要前端跟进（我无权改 `mail-vue/`，第三位执行者在做续期入口）**：`SHARE_UPDATE_CONFLICT` 是新错误码，`ShareDetailDrawer.vue` 目前只特判 `SHARE_NOT_FOUND`（`isGone()` → 关抽屉）。新码会落到通用错误分支，管理员看到的可能是裸错误码而不是「这条分享刚被别人改过，请刷新后重试」。建议由做续期入口的那位补一条文案 + 触发一次重新拉取详情。**后端语义是完整的，这只是提示文案缺失，不阻塞合入。**

5. **未处理、已知**：`resetAuthKey` 零命中仍统一报 `SHARE_NOT_FOUND`（它有自己的 `auth_key_enabled` 迁移守卫，且既有用例 `lets exactly one of two concurrent disables win` 显式接受 `SHARE_NOT_FOUND | SHARE_INVALID_CONFIG` 两种码）。把它也改成冲突码语义更一致，但超出本任务范围且会动到并行执行者的相邻测试面，未动。

6. **无法从代码判定**：Cloudflare 生产 D1 在真实多 PoP 下的可见性延迟。本轮只验证了单语句谓词与本地 D1（`@cloudflare/vitest-pool-workers`）行为。不过 CAS 的正确性依赖的是单条 UPDATE 内谓词与赋值的原子性，这一点不随 PoP 数量变化。

## Update Log

- 2026-08-25 09:2x · executor · 补 `update()` 写入路径 CAS（`credentials_version` + `expires_at`）+ 零命中冲突分流（新增 `SHARE_UPDATE_CONFLICT`）+ 5 条并发回归用例。变异 M1/M2a/M2b 三轮取证后已还原并复跑绿。全量 `pnpm --dir mail-worker test` → 18 files / 663 passed / EXIT=0。commit: pending（按约束未提交）。
