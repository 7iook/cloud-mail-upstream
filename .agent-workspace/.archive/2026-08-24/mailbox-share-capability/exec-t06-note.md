# T-06 执行说明 · 配额闸门 `consumeSessionQuota` 单语句条件 UPDATE

- 日期:2026-08-24
- 执行者:executor(sub-task executor)
- 分支:`cursor/mailbox-share-capability-dcb6` · 基线 HEAD `f92d9a5`(在 `9f733d1` 之后;T-05 已 commit 于 `c7789e6`,已核实)
- **未提交、未推送**(按派单要求)
- 白名单外文件零改动:仅 `mail-worker/src/service/share-auth-service.js` + `mail-worker/test/share-auth-service.spec.js`

## 成功态(主 AI 原文照抄,未改写)

NOT "a helper exists", BUT two concurrent visitors cannot both open a new session when only one slot remains; polling/read requests do not increment access_count; a quota UPDATE miss or throw refuses the token.

### 逐条核验

| 成功态子句 | 验证证据 |
|---|---|
| 两个并发访客不能同抢最后一个名额 | `spec:656-681`:`max_sessions=3, access_count=2`,6 路 `Promise.allSettled` → 恰 1 fulfilled / 5 rejected(每条包体与 `SHARE_UNAVAILABLE` 字节相同),终值 `access_count===3`。**红阶段实测 6 fulfilled**(与 recon `PROBE_R1` 一致),即该用例真红,不是护栏。补充 `spec:683-697`:空配额 8 路并发 → 恰 3 fulfilled、`access_count===3` |
| 轮询/读请求不增加 access_count | `spec:839-874`:经真实 worker(`SELF.fetch`)`POST /share/session` 建会话 → `access_count===1`;随后 `resolveSession`×3 + `GET /share/mails`×2 + `GET /share/mail` + `GET /share/attachment` → `access_count` 恒 1 且 `last_access_at` 逐字未变。结构性护栏 `spec:876-891`:`share-auth-service.js?raw` 断言 `resolveSession` 函数体内零 `.update(/.insert(/.delete(`、零 SQL 写关键字、不引用 `consumeSessionQuota`;全文件 `.update(` 恰 1 处且位于 `consumeSessionQuota` 内 |
| 配额 UPDATE 落空 → 拒发 | `spec:715-736`(cv 漂移)、`spec:738-772`(闸门前 revoke / 过期)均断言字节相同 `SHARE_UNAVAILABLE` + `access_count===0` + `last_access_at IS NULL` |
| 配额 UPDATE 抛错 → 拒发 | `spec:386-405`(旧 AC-LIFE-14 用例的语义反转):D1 代理在闸门语句执行前抛 `d1 write failed` → 拒发、零 token、`access_count===0` |

## 红

命令:`pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js`(测试全部就位、`share-auth-service.js` 回退到 HEAD 版)

- **EXIT=1** · `Tests 7 failed | 19 passed (26)`
- 失败原因全部是行为缺失,非语法/import:
  1. `Error: expected SHARE_UNAVAILABLE`(`spec:386` AC-SESS-11 抛错拒发)—— 旧 `recordAccess` 吞异常后仍签发
  2. `AssertionError: expected 6 to be 1`(`spec:656` 抢最后名额)—— 无闸门,6 路并发全部超发
  3. `AssertionError: expected 8 to be 3`(`spec:683` 空配额并发)—— 同上
  4. `Error: expected SHARE_UNAVAILABLE`(`spec:715` cv 漂移)—— WHERE 无 `credentials_version` 谓词
  5. `Error: expected SHARE_UNAVAILABLE`(`spec:738` 闸门前 revoke/过期)—— WHERE 只有 `share_id`
  6. `Error: expected SHARE_UNAVAILABLE`(`spec:800` `denied_quota` 双触发点)—— 事件未打
  7. `AssertionError: expected -1 to be greater than -1`(`spec:876` 源码护栏)—— `consumeSessionQuota` 尚不存在
- 日志:`/opt/cursor/artifacts/t06_red_quota_gate.log`

红阶段已通过的 4 条本任务新增用例是**回归护栏**,不驱动实现:`spec:635`(单次 +1 与 `exp` 上界)、`spec:699`(`max_sessions IS NULL` 不受闸门约束)、`spec:774`(闸门后 TOCTOU 名额不退还)、`spec:839`(读路径零消耗)。其中 `spec:699` 是「不破既有无限额分享」的底线,`spec:635` 的 `exp` 断言钉住 `issueToken` 换位后 `exp = min(expires_at, iat+TTL)` 未漂移(AC-SESS-05)。

## 绿

- `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js` → **EXIT=0** · `26 passed (26)`
- `pnpm --dir mail-worker test` → **EXIT=0** · `Test Files 17 passed (17)` · `Tests 213 passed (213)`
- 日志:`/opt/cursor/artifacts/t06_green_quota_gate.log`
- 并发用例稳定性:auth spec 连跑 4 次全 26/26,无 flake
- **基线数字说明**:T-05 收尾时全量为 17 files / 185 tests。本任务执行期间有并行执行者在同一工作树改了 `mail-share-service.js`(`logShareEvent` 字段铺开顺序)、`test/mail-share-service.spec.js`(+18)、`test/setup.js`(`isRowId` 守卫),这三个文件**不是本任务改的**。本任务前的实际基线因此是 203,本任务 +10(auth spec 16→26)= 213。`logShareEvent` 的字段顺序变更对本任务无影响:`spec:151-161` 用 `JSON.parse` 取字段,不依赖键序。

## 改了什么(file:lines)

| 文件 | 位置 | 内容 |
|---|---|---|
| `mail-worker/src/service/share-auth-service.js` | `1` | drizzle import 补 `and` / `gt` / `isNull` / `or` |
| 同上 | `8-11` | `import { SHARE_EVENT, logShareEvent } from './mail-share-service'`,附已知循环的安全依据注释(双向引用均在函数体内)。**未搬家常量**,`mail-share-service.spec.js` 的冻结断言未被触碰 |
| 同上 | `253-259` | 新增 `denyQuota(shareId, reason)`:先 `logShareEvent(SHARE_EVENT.SESSION_DENIED_QUOTA, { shareId, reason })` 再 `throwUnavailable()`;fields 只含 `shareId` + `reason`(AC-LEAK-05) |
| 同上 | `260-277` | 新增 `consumeSessionQuota(c, shareId, expectedCv, now)`,取代原 `recordAccess`:drizzle `update().set({ accessCount: sql\`+1\`, lastAccessAt: now }).where(and(shareId, status='ACTIVE', expiresAt > now, credentialsVersion = cv, or(maxSessions IS NULL, accessCount < maxSessions))).returning({ accessCount })` —— 判空用数组长度,不用 `.get()` 的 `undefined` |
| 同上 | `279-281` | `establishSession` 第 4 参 `deps = {}` → `options = {}`(T-06 内为空,T-07/T-08 填);`deps.recordAccess` seam 与 `recordAccess` 函数一并删除 |
| 同上 | `294-302` | 闸门前的快照侧配额日志:`effectiveStatus(row, nowText()) === 'ACCESS_LIMIT_REACHED'` → `denyQuota(shareId, 'quota_snapshot')`;其后 `assertAllowed(row, ESTABLISH_ALLOWED)` 原样保留,负责 REVOKED/EXPIRED/accountId |
| 同上 | `303-323` | 流程重排:`loadLiveAccount` → 闸门(`try/catch`,抛错走 `console.error` + `throwUnavailable`,AC-SESS-11)→ `!applied.length` 则 `denyQuota(shareId, 'quota_race')` → **然后才** `issueToken`。返回体 `:324-328` 零改动 |
| `mail-worker/test/share-auth-service.spec.js` | `1,5` | `SELF` from `cloudflare:test`;`shareAuthSource` from `'../src/service/share-auth-service.js?raw'` |
| 同上 | `53` | `UNAVAILABLE_BODY` 常量 |
| 同上 | `90-137` | `QUOTA_UPDATE_SQL` 正则 + `injectingDb(db, { before, after })` D1 绑定代理:只包裹匹配闸门语句的 statement,`bind()` 递归重包 |
| 同上 | `139-149` | `captureLogs(run)` 接管 `console.log` |
| 同上 | `151-161` | `quotaEvents(lines)`:JSON 解析后筛 `share.session.denied_quota` |
| 同上 | `163-167` | `quotaRow(shareId)` 直读 `env.db`(不经 orm,与本 spec 既有写法一致) |
| 同上 | `169-192` | `shareFetch(method, path, { bearer, body })`:经 `SELF.fetch` 打真实 `/api/share/*` |
| 同上 | `217,238-243` | `insertShare` 加可选 `credentialsVersion`(照 T-05 的动态列拼接模式;默认不写该列) |
| 同上 | `383-405` | **改写**原 `still issues a session when access accounting fails (AC-LIFE-14)` → `refuses the session when the quota UPDATE itself throws (AC-SESS-11)`,断言由「仍签发」翻为「拒发 + 零 token + 零消耗」 |
| 同上 | `407` | **仅改标题标签**:`(AC-LIFE-10)` → `(mail-share AC-LIFE-10)`,断言逐字未动 |
| 同上 | `619-632` | `futureText(seconds)` / `functionSource(source, name)` 两个本地工具 |
| 同上 | `634-892` | 新 describe `shareAuthService session quota gate`,10 条用例(见下表) |

### 新增用例 → AC 映射

| spec 行 | 用例 | 覆盖 | 红? |
|---|---|---|---|
| `635-654` | 单次建会话恰 +1、`last_access_at` 落值、`exp` 上界不变 | AC-SESS-01, AC-SESS-05 | 护栏 |
| `656-681` | 6 路并发抢最后名额恰 1 成功 | AC-EDGE-02, AC-SESS-07, P-SESS-01 | **真红** |
| `683-697` | 8 路并发空配额恰 3 成功 | AC-SESS-01, AC-SESS-07, P-SESS-01 | **真红** |
| `699-713` | `max_sessions IS NULL` 三连建全成功、计数仍走 | AC-SESS-01 | 护栏 |
| `715-736` | cv 在快照与闸门之间漂移 → 拒发零消耗 | AC-SESS-01, AC-EDGE-13 | **真红** |
| `738-772` | 闸门**前** revoke / 过期提交 → 拒发零消耗 | AC-EDGE-13 | **真红** |
| `774-798` | 闸门**后** revoke → token 首次回源失败、名额不退还 | AC-EDGE-13 | 护栏 |
| `800-837` | `denied_quota` 两个触发点、reason 分别为 `quota_snapshot` / `quota_race`、日志不含 sec/lid | AC-SESS-07 + AC-LEAK-05 | **真红** |
| `839-874` | 轮询 + mails/mail/attachment 零配额消耗 | AC-SESS-02, AC-EDGE-01, P-SESS-02 | 护栏 |
| `876-891` | `resolveSession` 源码级无写护栏 + 全文件唯一写在闸门内 + `recordAccess` 双侧删净 | AC-SESS-02, P-SESS-02 | **真红** |

## 派单裁决的落地对照(逐条,未自行改口径)

| 裁决 | 落在哪 |
|---|---|
| `last_access_at` 与 `access_count` 同在成功 UPDATE | `share-auth-service.js:263-265`;establish 路径已无任何 fire-and-forget 库写 |
| 配额 UPDATE 失败 / RETURNING 空 MUST 拒发;改写旧「仍签发」用例 | `share-auth-service.js:308-319` + `spec:383-405`(语义反转,已在用例上方注明) |
| 增量用例改标 `(mail-share AC-LIFE-10)`,断言不动 | `spec:407`,断言 `access_count===2` 与 `last_access_at` 为字符串逐字保留 |
| `denyQuota` 两处触发,reason `quota_snapshot` / `quota_race` | `share-auth-service.js:300, 318`;`spec:800-837` 同时断言两个 reason 与顺序 |
| 并发用例必须 `Promise.allSettled` | `spec:665, 690, 706`;红阶段拿到 6 / 8,证明不是假绿 |
| status 端点不存在 → 断言 mails/mail/attachment + 源码级护栏 | `spec:839-874` 三端点 + `spec:876-891` 源码护栏 |
| 从 `mail-share-service.js` import 事件常量,不搬家 | `share-auth-service.js:8-11` |
| 不动 `share-attachment-service.js`;P-SESS-02 种在未触顶行 | `spec:845-850` 显式种无上限行并在注释里写明附件路由的 ACTIVE 硬判定属 T-08 |
| 不造生产测试 seam,用 `ctx({ db: proxy })` | `spec:90-137`;生产代码零测试专用参数 |
| 第 4 参 `deps` → `options`(T-06 为空) | `share-auth-service.js:281` |
| 删 `recordAccess` 与 `deps.recordAccess` seam | 生产侧删净;测试侧 `spec:888` 用 `?raw` 断言全文件不含 `recordAccess` 字样,防单侧残留 |
| 用 drizzle `update+returning` | `share-auth-service.js:266-279`,未手写 raw SQL |
| `insertShare` 只加 `credentialsVersion` | `spec:217, 238-243`;`maxSessions` / `accessCount` 沿用 T-05 已加的形参 |

## 既有护栏复核(未误伤)

- **`row.accountId` 读取数冻结为 4**(`mail-share.schema.spec.js:146`):改写后仍为 4 处(`assertAllowed` 1 + establish 1 + resolve 2),闸门谓词零 `accountId`。全量套件已验证。
- **AC-LEAK-05 日志不含 sec/token**(`spec:420-441`):`denyQuota` 只传 `shareId` + `reason`;`spec:830-833` 额外断言 `denied_quota` 行不含 sec 与 lid。
- **P-AUTH-01 六路失败包体字节相同**(`spec:269-302`):`denyQuota` 抛的仍是 `throwUnavailable()`,包体不变;该用例六条路径均在快照校验阶段被拒,不经闸门。

## 遗留风险

1. **【已知洞 · 归 T-08,本任务按令未碰】** `share-attachment-service.js:104-111` 的 `assertActiveShareContext` 仍写死 `effectiveStatus !== 'ACTIVE'` 即拒,触顶后 `/share/attachment` 失效。P-SESS-02 用例因此把零消耗断言种在**未触顶**行上,并在 `spec:843-844` 注明。
2. **端到端仍不可达。** 生产侧至今无写 `max_sessions` 的路径(Owner 面 create 不写该列、update 端点在 T-15),`credentials_version` 的写入方在 T-16。本任务全部证据来自 service 层直测 + `SELF.fetch` 端点 + 手写 seed;「建带配额分享 → 触顶 → 老 token 仍能读」的真端到端要等 T-15/T-16。
3. **UPDATE 抛错的两种情形被合并处理。** `consumeSessionQuota` 抛错时一律拒发。若异常发生在语句**已提交**之后(如响应链路故障),名额已消耗而客户端拿不到 token —— 这与 AC-EDGE-13 文档化的 TOCTOU 语义同类,且正是 T-07 的 `Idempotency-Key` 重放(AC-SESS-10)要覆盖的恢复面。本任务不做补偿。
4. **`share-auth-service ↔ mail-share-service` 循环 import 已实际引入**(recon §3.4 裁决)。实测安全(两个入口顺序全量套件均绿,含经 worker 入口的 `share-api.spec.js` / `share-integration.spec.js`),但结构上仍是异味。清理归 W2:抽到 `src/const/share-event.js`,同时改 `mail-share-service.spec.js:635` 的冻结断言指向。
5. **`denyQuota` 目前不带 `requestId`。** `logShareEvent` 会补 `requestId: null`。`share-auth-service` 拿不到 hono 的 requestId,接线属 T-12/T-15 的观测收口范围,本任务未扩签名。

## Review Findings

- **无方向性偏差,按派单执行。** recon §5.2 给出的 post-T-05 锚点(`ESTABLISH_ALLOWED:230` / `assertAllowed:233` / `recordAccess:249` / `establishSession:256` / `resolveSession:287`)与工作树逐条命中,未发生漂移;`resolveSession` 与默认导出对象零改动。
- **`insertShare` 的 `credentialsVersion` 是必需扩参,不是方便。** 闸门谓词比的是快照 cv 与库内 cv;若只种 cv=0,`credentials_version` 谓词与「常量 0」不可区分。用例 `spec:715-736` 因此种 cv=7 再在闸门前推到 8 —— status 未变、未过期、配额充足,唯一能拒的原因只有 cv,该谓词被单独隔离出来。
- **D1 代理的坑已踩过并处理**:`bind()` 返回新对象,不递归重包就丢钩子(`spec:104-106`);`Reflect.get` 带 `receiver` 会让 workerd 原生对象的方法拿到 Proxy 作 `this`,改用 `target[prop]` + `value.bind(target)`(`spec:100, 119, 124, 129`)。
- **红阶段的 `spec:774`(闸门后 TOCTOU)在旧代码下也通过**,因为旧 `recordAccess` 的 SQL 同样匹配 `QUOTA_UPDATE_SQL`。这条不是驱动实现的红,而是钉住换位后行为不变的护栏 —— 绿阶段它跑的已经是新闸门语句(同批 `before` 钩子用例在红阶段全部失败,证明代理确实挂在了新语句上)。
- **跨域只读核查,未跨域改动**:读了 `share-api.js:54-88`、`share-attachment-service.js:92-111`、`share-mail-service.js:92-116`、`share-scoped-email-repository.js:70-112`、`mail-share.schema.spec.js:142-147`、`entity/mail-share.js:17-31`、`wrangler-vitest.toml`,以确认 ① 三条读端点确实共用 `resolveSession` 咽喉;② 端点级 P-SESS-02 必须用部署环的 pepper/签名环种子(`spec:845-850` 用 `env.SHARE_SEC_PEPPER`),spec 本地的 t08 密钥在 `SELF.fetch` 里不成立;③ `access_count` 为 `NOT NULL DEFAULT 0`、`credentials_version` 为 `NOT NULL DEFAULT 0`,闸门谓词不会退化成 NULL。

## Update Log

- 2026-08-24 · executor:T-06 落地。红 EXIT=1(7 failed / 19 passed / 26,含 6 路并发实测超发 6、8 路并发实测超发 8)→ 绿 EXIT=0(spec 26/26;全量 17 files / 213 tests)。改动 2 文件:`share-auth-service.js:1,8-11,253-323`、`share-auth-service.spec.js`(+10 用例、1 条语义反转改写、1 条标签改写、D1 代理 helper、`insertShare` 扩 `credentialsVersion`)。`recordAccess` 与 `deps.recordAccess` seam 生产侧与测试侧同时删净,并用 `?raw` 断言防单侧残留。踩到的坑:D1 `bind()` 返回新对象须递归重包代理;`Reflect.get` 带 receiver 会破坏 workerd 原生对象的 `this`。未 commit、未 push。
