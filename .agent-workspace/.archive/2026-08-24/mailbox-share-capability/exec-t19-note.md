# Exec Note · T-19 Checkpoint:share-integration 扩多邮箱 / 配额 / AuthKey 三条 HTTP 整链

- **日期**:2026-08-24 · **分支**:`cursor/mailbox-share-capability-dcb6` · **起点 HEAD**:`fa61326`(T-18 `73dc371` 已入库,T-18 APPROVED)
- **未 commit / 未 push / 未 stash / 未切分支**。`git add` / `git commit` / `git stash` / `git checkout <branch>` 一次都没跑。
- **生产代码改动 = 0 行**(派单目标值)。没有任何一条 AC 需要改 src 才能过。

## 白名单

| 文件 | 改动 | 说明 |
|---|---|---|
| `mail-worker/test/share-integration.spec.js` | **+589 / −3** | 唯一被修改的文件 |
| 本文件 `exec-t19-note.md` | 新建 | — |

**白名单外一字未动**(`git status --short` 只有上面这一个 `M`):`mail-worker/src/**`(含 `mail-share-service.js` / `share-auth-service.js` / `share-scoped-email-repository.js`)、`wrangler-vitest.toml`、`wrangler.toml`、`test/setup.js`、`security-share.spec.js`、`share-api.spec.js`、`mail-share-service.spec.js`、`account-delete-share.spec.js`、`mail-share-cleanup.spec.js`、`mail-vue/**`、`tests/e2e/**`、`docs/specs/**`。

**`SHARE_CAPABILITY_V2 = "false"` 在 `wrangler-vitest.toml:41` 一字未动** —— 全仓「栅栏关闭态」基线保持。

### `:1-912` 区间只有三个 hunk,全是 helper 追加,既有 17 条的断言一字未改

| 位置 | 追加 |
|---|---|
| `savedEnv`(`:30-34`) | 多存一个 `SHARE_CAPABILITY_V2` |
| `openSession`(`:228-238`) | 两个**可选**参 `{ authKey, idempotencyKey }`,缺省即旧行为(既有 12 处调用点一字未改) |
| `cleanup()`(`:269-287`) | ① `SHARE_CAPABILITY_V2` 兜底还原;② `DELETE FROM mail_share_binding WHERE share_id NOT IN (SELECT share_id FROM mail_share)` |

`createShare()` **未改** —— 它的 body 本来就 spread,`accountIds` / `maxSessions` / `authKeyEnabled` 直接透传;需要翻栅栏的写入改走文件尾新增的 `createShareV2()`,与既有调用者零耦合。

---

## 红 → 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 基线 | `pnpm --dir mail-worker exec vitest run test/share-integration.spec.js --no-cache` | **17 passed (17)** |
| **红**(20 条新用例就位,helper 尚未扩参) | 同上 | **5 failed / 32 passed (37)** |
| **绿**(helper 扩参落地) | 同上 | **37 passed (37)**,EXIT=0 |
| 邻接回归 | `pnpm --dir mail-worker exec vitest run test/share-api.spec.js test/mail-share-service.spec.js test/security-share.spec.js --no-cache` | **375 passed (3 files)**,EXIT=0 |
| 同进程泄漏检查 | 上面三个 + `share-integration.spec.js` 一次跑 | **412 passed (4 files)**,EXIT=0 |
| 全量 worker | `pnpm --dir mail-worker test` | **18 files / 618 tests**,EXIT=0,36.3s |
| 前端 | `pnpm --dir mail-vue test` | **17 files / 95 tests**,EXIT=0 |
| E2E | `node tests/e2e/run.mjs` | **13 passed**,EXIT=0 |

**地板**:worker 18/598(T-18 收口态)→ **18/618**,只增不减,`+20` 全部来自本文件。vue 17/95 与 E2E 13 **分毫未动**(T-19 不碰前端)。

红态那 5 条恰是需要 `openSession` 新参的:B3(`Idempotency-Key`)+ C1 / C3 / C4 / C5(`authKey`)。checkpoint 任务的生产代码改动是 0,所以「红」只能来自测试脚手架侧;真正证明这 20 条**各自承重**的是下面的变异校验。

---

## V2 翻转模式(裁决 T16-HTTP + W0-R5)

```js
async function withCapabilityV2(run) {
	env.SHARE_CAPABILITY_V2 = 'true';
	try { return await run(); }
	finally { env.SHARE_CAPABILITY_V2 = savedEnv.SHARE_CAPABILITY_V2; }
}
function ownerV2(method, path, options = {}) {
	return withCapabilityV2(() => jsonWorker(method, path, { token: ownerJwt, ...options }));
}
```

**典型用例形状恒为「翻开关 → `jsonWorker` 写 → 还原 → `jsonApi` 读」**:写侧必须 `worker.fetch(req, env)`(`SELF.fetch` 看不见测试进程改的 `env`),读侧刻意留在 V2=false 的基线 Worker 上 —— 这样每一条多邮箱/配额/AuthKey 用例都顺带证明了**栅栏回落不影响已经发出去的链接**。

三层还原:① `withCapabilityV2` 的 `finally`;② `cleanup()` 里的兜底赋值(`afterEach`,抛异常也兜得住);③ 同进程泄漏检查实跑 —— 把 `share-integration` 与 `mail-share-service.spec.js`(内含 `:1224-1288` 那一族 V2=false 负向用例)塞进同一个 worker 进程跑,412 全绿,证明没有一枚 `true` 漏出去。

**不过栅栏的写入刻意走 `jsonApi`**,以免把「暂时的发布态」写成「永久的权限要求」:A3 的 remove(缩减)、A4 的删空、A7 的 delete、C3 的 `reset`、C4 / C6 的 `disable`。C6 正面钉死了这条不对称 —— V2=false 下 `enable` 拒、`disable` 放行。

---

## A8 结果(T-18 APPROVED 后才写的那条)

`DELETE /account/delete?accountId=<多邮箱之一>` 经 HTTP 打进去之后:

| 断言 | 实测 |
|---|---|
| `mail_share.status` | `ACTIVE`(未被误撤销) |
| `mail_share.revoked_at` | `NULL` |
| `mail_share.account_id` | 重指到幸存者 `boxB`(不是 0,不是旧值) |
| `mail_share_binding` | 只剩 `boxB` 一行 |
| 访客**旧 sessionToken**(不重建 Session)`GET /share/mails` | 只剩幸存邮箱那封 |
| `GET /share/mail?mailId=<已删邮箱的信>` | `SHARE_UNAVAILABLE` |

**A8 是 T-18 级联「无幸存者」半句在 HTTP 面的唯一守卫**(见下面 M5b)。

---

## 变异校验(证明新用例真的承重,不是陪跑)

`recon-t19-checkpoint.md §9` 把 T5 / T6 / T7 列为「写错了也全绿」的高风险项,所以逐条实跑变异。**六次变异后生产代码全部 `git checkout` 还原,`git status --short mail-worker/src` 为空**,还原后重跑 618/618。

| 变异 | 结果 | 捕获者 |
|---|---|---|
| **M1** `visibleSubquery` 的 per-binding 下界折成单标量 `scopes[0].windowStartEmailId` | 1 failed | **A2** 独家 |
| **M2** 删掉 `consumeSessionQuota` 的 `maxSessions` 谓词 | 1 failed | **B2** 独家 |
| **M3** `prepareUpdate` 的 `resetUsedSessions` 恒不生效 | 1 failed | **B5** 独家 |
| **M4** `establishSession` 的 `throwAuthRequired()` → `throwUnavailable()` | 4 failed | **C1 / C2 / C3 / C4** |
| **M5** 直接删掉 `CASCADE_REVOKE_WHERE` 的「无幸存者」半句 | ❌ **变异本身无效**:少了一个 `?`,绑定参数与占位符数量对不上,语句直接报错 —— 2 failed 里有一条是既有基线 #11,属假阳性 |
| **M5b** 同一半句改成恒真但仍消耗那个参数(`AND (? IS NOT NULL)`) | 1 failed | **A8** 独家 |

### M2 是本轮最有价值的发现

删掉配额 UPDATE 的 `access_count < max_sessions` 谓词之后,**B1 / B3 / B5 全都还是绿的**,只有 B2 变红。原因:`establishSession:544-546` 在写入之前还有一道快照预检 `effectiveStatus === 'ACCESS_LIMIT_REACHED' → denyQuota('quota_snapshot')`,顺序发起的第 N+1 次 Session 会先被它挡下,根本走不到 UPDATE。

所以配额其实是**两道闸**:快照预检管日常的顺序请求,UPDATE 谓词管并发的最后一格。**只有 B2(`Promise.all` 并发 + 库里 `access_count` 一起断言)能证伪后者**。这也反过来说明 T13 那条建议是对的:并发用例若只断言「1 成功 1 失败」而不查库,这次变异会完全漏网 —— 超发的典型形态恰是「两条都成功但计数只加了 1」。

---

## 新增 20 条用例清单

### A 组 · `describe('multi mailbox share over HTTP (T-19)')` 8 条

| # | 关键断言 | AC |
|---|---|---|
| A1 | create 响应 `shareType='multi'` + 两条 `bindings`;session `mailboxes` 两条且地址掩码为 `t***@example.com`、第二个邮箱完整地址零出现;`/share/mails` 合并两箱按 `mailId` DESC;逐行 `bindingId` 与 session 的 bindingId 对得上;逐行过 `expectVisitorDto` | AC-CAP-01/02 · AC-MAIL-01/08 · AC-SESS-09 |
| A2 | 两条 Binding 的 `window_start_email_id` 分别等于**各自邮箱**创建时刻的 `MAX(email_id)`(`[beforeA, beforeB]`,且 `beforeB > beforeA`);可见集恰是两封「之后」的;两封「之前」的直接取信皆 `SHARE_UNAVAILABLE` | AC-CAP-07 · AC-MAIL-02 |
| A3 | `PUT bindings {add:[C]}`(过栅栏,`jsonWorker`)→ **同一枚 sessionToken** 下一次拉取即含 C 的新邮件、status 多一条水位;`{remove:[bindingB]}`(不过栅栏,`jsonApi`)→ 下一次拉取不含 B 的任何邮件、`GET /share/mail?mailId=<B的>` 为 `SHARE_UNAVAILABLE`、水位掉回两条 | AC-BIND-02/03/08 · AC-EDGE-04 |
| A4 | 一次 remove 掉全部 Binding → 响应 `status='REVOKED'` + `bindings=[]`;访客四路(session/mails/mail/attachment)字节同形 `SHARE_UNAVAILABLE`;库里 `revoked_at` 非空、Binding 零行 | AC-BIND-04 |
| A5 | V2=false 下多邮箱 create 与 1→N 扩张双双 `SHARE_INVALID_CONFIG`;`mail_share` 与 `mail_share_binding` 零新增(扩张后仍只剩原来那一条 Binding) | AC-LIFE-11 |
| A6 | `accountIds` 混入另一 user 的 accountId → `SHARE_ACCOUNT_FORBIDDEN`;`mail_share` 与 `mail_share_binding` **全表零行**(零部分写入) | AC-CAP-03 · AC-BIND-10 |
| A7 | 带 `Idempotency-Key` 建多邮箱 share → `DELETE /mailShare/delete` → `mail_share` / `mail_share_binding` / `share_idempotency` **三表**该 shareId 全部零行 | AC-ADMIN-07 |
| A8 | 见上文「A8 结果」 | AC-BIND-05 · AC-EDGE-04 |

**Binding 全部经 `POST /mailShare/create` 或 `PUT /mailShare/bindings` 产生,新代码里零 `INSERT INTO mail_share_binding`**(文件里唯一一处直插库是 T-14 既有的 `addBinding`(`:797`),一字未动)。

### B 组 · `describe('session quota over HTTP (T-19)')` 6 条

| # | 关键断言 | AC |
|---|---|---|
| B1 | `maxSessions=2`:两次 200、第三次 `SHARE_UNAVAILABLE`;**第一枚 token 的 mails 与 status 仍 200**;`access_count=2` 且读完仍是 2 | AC-SESS-01/06/07 · AC-LIFE-04 |
| B2 | `maxSessions=1` + `Promise.all` 两路 → 恰 1 成功 1 同形失败;**库里 `access_count=1`** | AC-EDGE-02 · AC-SEC-08 |
| B3 | `maxSessions=1` + 同一 `Idempotency-Key` 连发两次 → 同一枚 `sessionToken`、`access_count` 恒 1;第三次不带 key 仍被拒;用后清 KV | AC-SESS-10 |
| B4 | 同 token 打 mails/status 各 3 次 → `access_count` 恒 1(**不断言 `last_access_at`**,它允许被写);名额没被吃掉:第二枚 Session 照常发得出 | AC-EDGE-01 · AC-SESS-02 |
| B5 | 无限配额 share 用掉 2 次 → `PUT update {maxSessions:2}`(默认 reset)→ `usedSessions=0` / `effectiveStatus='ACTIVE'` / 再发两枚、第三枚被拒;另一条 `{maxSessions:1, resetUsedSessions:false}` → 立刻 `ACCESS_LIMIT_REACHED` 且 Session 被拒 | AC-EDGE-14 · AC-ADMIN-03/04 |
| B6 | `GET /mailShare/list?status=ACCESS_LIMIT_REACHED` **只**命中被顶满那条;行上 `usedSessions=1` / `maxSessions=1` / `shareType='single'` / `status='ACTIVE'` / `effectiveStatus='ACCESS_LIMIT_REACHED'` 齐全;响应体不含任何一条 `sec` 明文 | AC-ADMIN-01/09 |

### C 组 · `describe('AuthKey over HTTP (T-19)')` 6 条

| # | 关键断言 | AC |
|---|---|---|
| C1 | create `{authKeyEnabled:true}` → `authKey` 匹配 `/^[A-Za-z0-9_-]{22}$/`;不带 Key / 带错 Key → **字节级 `SHARE_AUTH_REQUIRED`**(不是 UNAVAILABLE)+ `no-store` + `access_count` 不变;带正确 Key → 200 且 +1(**铸钥与验钥同源**) | AC-CAP-05 · AC-AUTH-01 · AC-EDGE-12 |
| C2 | 错 `sec` + 正确 Key、不存在的 `lid` + 正确 Key、不存在的 `lid` + 任意 Key → 三者字节同形 `SHARE_UNAVAILABLE`;正确 `sec` + 无 Key 才是 `SHARE_AUTH_REQUIRED`;`access_count` 全程 0 | AC-AUTH-02 |
| C3 | `resetAuthKey {action:'reset'}`(经 `jsonApi`,证明 reset 不过栅栏)→ 新旧 Key 不同;旧 token 的 mails/status 字节同形 `SHARE_UNAVAILABLE`;旧 Key 建 Session → `AUTH_REQUIRED` 且**不消耗配额**;新 Key → 200 且 `access_count` 1→2 | AC-ADMIN-05 · AC-EDGE-05 |
| C4 | 无 Key 的 share 先建 Session → `enable`(过栅栏)→ **旧 token 仍 200**(cv 未动)、新 Session 要 Key;再 `disable`(**经 `jsonApi`,不过栅栏**)→ 两枚旧 token 同形失效、无 Key 可进、**多余的旧 Key 被忽略不报错** | AC-AUTH-07/08 · AC-LIFE-11 |
| C5 | 明文不出现在 `GET /mailShare/get`、`GET /mailShare/list`、`POST /share/session` 三个响应体里;`assertSecAbsentFromDatabase(authKey)` 扫全库文本列 | AC-CAP-05 · AC-SEC-09 |
| C6 | V2=false 下 `action:'enable'` → `SHARE_INVALID_CONFIG` 且 `auth_key_enabled` 不动;翻开关 enable 成功后,V2=false 下 `disable` **放行**(Owner 不能被锁死在关不掉的第二因子上) | AC-LIFE-11 |

**未补 perm / `SHARE_FORBIDDEN`**(`security-share.spec.js:209-238` 已覆盖 AC-ADMIN-10 八条路由,重复即漂移源),**未补 `message_limit` 的 HTTP 面**(既有 #16 已借直写库覆盖滚动语义)。

---

## 未做事项 / 遗留

| # | 项 | 说明 |
|---|---|---|
| L1 | **B1 / B3 / B5 被配额快照预检「盖住」** | 见上文 M2。这不是用例缺陷(它们各自钉的是 AC-SESS-06「关门不清场」、AC-SESS-10 重放、AC-EDGE-14 纪元,都不是 UPDATE 谓词),但**主 AI 需要知道:配额 UPDATE 谓词在集成面只有 B2 一条守卫**。若将来要动 `consumeSessionQuota`,B2 是唯一的 HTTP 面警报器 |
| L2 | **`STRANGER_EMAIL` 的 user 行不进 `cleanup()`** | A6 的外人 user(`t24-stranger@example.com`)按需 lazily 种一次,`cleanup()` 只删它的 account(走 `t24-%@example.com` 的网),user 行留在库里 —— 与既有 `OWNER_EMAIL` 同处置,不是新增的泄漏面 |
| L3 | **文件从 912 行涨到 1498 行** | recon T14 预警的 ~1500 上限已经贴顶。**下一个要往这个文件加用例的任务应当先问是否另开 spec 文件**,不要再往里塞 |
| L4 | **未改 `tasks.md` / `docs/specs/**`** | 派单要求。T-19 的勾选与 Evidence(四要素:verify 含 EXIT / files:lines / AC / commit)留给主 AI 回写 |
| L5 | **未 commit / 未 push** | 工作树里 1 个 modified(`share-integration.spec.js`)+ 本文件 untracked。变异用的六次生产代码改动全部 `git checkout` 还原,`git diff mail-worker/src` 为空 |
| L6 | **未发现需要改生产代码的 AC 缺口** | 20 条全部落在已入库且 APPROVED 的端点上,`src` 改动 0 行。没有需要交主 AI 裁决的 STOP 项 |
