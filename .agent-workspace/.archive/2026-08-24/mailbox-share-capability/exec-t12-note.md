# T-12 执行说明 · create 多邮箱扩展 + V2 栅栏接线 + 双写

- 日期:2026-08-24
- 执行者:executor(sub-task executor)
- 分支:`cursor/mailbox-share-capability-dcb6` · 起跑 HEAD `6c6f618`
- **最终 commit:`b6f5a28`**（已推送；Evidence `695394f`）
- 白名单外文件零改动:本任务只动 `mail-worker/src/service/mail-share-service.js` + `mail-worker/test/mail-share-service.spec.js`。`test/setup.js` **未动**(现有 `seedShareRow`/`seedBindingRow` 够用,不需要新 seed 助手)

## 成功态(主 AI 原文照抄,未改写)

NOT "create accepts accountIds", BUT an owner can create a share bound to several of their mailboxes in one request and get back shareType + bindings; a request that mixes in someone else's mailbox or a deleted mailbox leaves zero rows; V2=false still creates the old single-mailbox share and rejects multi / AuthKey / finite maxSessions / finite messageLimit; a lost response can be replayed without a second share and without returning sec/authKey.

Negative: no share_type column; no leftover binding when insertShare misses; no AuthKey plaintext in logs; do not open SHARE_CAPABILITY_V2 in production wrangler.toml.

### 逐条核验

| 成功态子句 | 验证证据 |
|---|---|
| 一次请求绑多个自有邮箱,拿回 shareType + bindings | `spec:668-687`:`accountIds: [ACC_C, ACC_A]` → 恰 1 条 share + 2 条 binding,binding 按 `binding_id` 升序恒等 `[ACC_A, ACC_C]`,`created.bindings` 逐条对上库内 `binding_id`;`spec:688-703` 钉 `shareType` 派生(1→single / 2→multi)并扫 `pragma_table_info('mail_share')` 断言无 `share_type` 列 |
| 混入他人邮箱 → 零残留 | `spec:724-733`:`[ACC_A, ACC_B]`(ACC_B 属 USER_B)→ `SHARE_ACCOUNT_FORBIDDEN`,`{shares: 0, bindings: 0}` |
| 混入已删邮箱 → 零残留 | `spec:734-745`:先把 ACC_C 置 `is_del=DELETE` → 同上零残留 |
| **并发删除**下仍零残留(写入侧真防线) | `spec:1058-1081`:D1 代理在 `batch()` 真正执行**前**软删 ACC_C,绕过预检 → `SHARE_ACCOUNT_FORBIDDEN` + 零残留。这条是本任务对 AC-CAP-03 的硬证据,见下「写入侧谓词的反证探针」 |
| V2=false 仍能建旧单邮箱分享 | `spec:1028-1054`(旧载荷全默认值创建)+ `spec:1112-1124`(`onlyMessagesAfterCreated=false` / `showFullAddress=1` 仍放行)+ 既有 `create` 全组 `:180-501` 未改一字仍绿 |
| V2=false 拒 multi / AuthKey / 有限 maxSessions / 有限 messageLimit | `spec:1097-1108` 四条参数化,全部 `SHARE_INVALID_CONFIG` + `{shares: 0, bindings: 0}` |
| 响应丢失可重放:无第二条 share、无 sec/authKey | `spec:956-975`(乱序+重复 accountIds 同指纹重放,`shares === 1`,重放体含 shareType/bindings 但 `sec` 为 undefined)+ `spec:883-911`(AuthKey 分享重放 `authKey`/`sec` 双 undefined) |
| 负向:无 `share_type` 列 | `spec:699-702` + 既有护栏 `mail-share.schema.spec.js:69` 未被触碰 |
| 负向:insertShare 落空时无残留 binding | `spec:1083-1094`:`SHARE_ACTIVE_LIMIT=1` 下第二次多邮箱 create → `SHARE_LIMIT_EXCEEDED`,`{shares: 1, bindings: 1}`(只剩第一条成功分享的那条 binding) |
| 负向:AuthKey 明文不进日志 | `spec:936-954`:接管 `console.log`/`console.error`,成功路径 + 拒绝路径各跑一次,断言日志全文不含明文 |
| 负向:不在生产 `wrangler.toml` 打开栅栏 | `spec:1139-1144`:`wrangler.toml?raw` 逐行断言无未注释的 `SHARE_CAPABILITY_V2` 赋值行;文件本身零改动 |

## 红

命令:`pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache`(测试全部就位、`mail-share-service.js` 仍是 HEAD 版)

- **EXIT=1** · `Tests 37 failed | 68 passed (105)`
- 日志:`/opt/cursor/artifacts/t12_red_create_multi.log`
- 37 条全部是行为缺失,无一条是语法/import 错误。分布:
  1. 多邮箱主链路 16 条(binding 行不存在 / `created.bindings` 为 undefined / `shareType` 为 undefined / per-binding window 不写 / 归属批量校验不存在 → 混入他人 ID 时旧代码只看 `accountId` 建成了单邮箱分享)
  2. 取值域 4 条(`refreshIntervalMs=2999`、`messageLimit=0`、`maxSessions=0`、51 个 accountId 全部被旧代码放行)
  3. AuthKey 3 条(列恒为 NULL、响应无 `authKey`)
  4. 指纹 10 条(旧指纹只含 4 字段,改任一新字段都不触发 `SHARE_IDEMPOTENCY_CONFLICT`)
  5. V2 栅栏 5 条(create 侧完全未接线 + `SHARE_V2_INTENT` 缺 `MESSAGE_LIMIT`)
  6. 双写 1 条(`syncPrimaryAccountId` 不认 `{lid}` 定位、不写 `window_start_email_id`)

> ⚠️ **踩到的坑(值得记进流程)**:第一次跑红时 vitest 用了陈旧的 transform 缓存,报 `63 passed`(= 改动前的用例数),看上去像「新用例没被收集」。加 `--no-cache` 后才拿到真实的 105 条。本任务此后所有取证跑都带 `--no-cache`;不带缓存参数的普通 `pnpm --dir mail-worker test` 收尾时另跑了一次,同样 EXIT=0。

### 红阶段已通过的用例是护栏,不驱动实现

68 条 passed 里包含既有 63 条(单邮箱旧断言 + V2 助手单测 + 观测事件)与本任务新加但对旧代码天然成立的 5 条,例如「V2=false 下显式传 `null` 配额仍放行」「`wrangler.toml` 未开栅栏」「改写后的四条双写用例」——**四条 W0 双写用例改写后在红阶段就是绿的**,它们的作用是钉住「T-12 不得破坏 `syncPrimaryAccountId` 的四条语义」,不是驱动实现。

### 写入侧谓词的反证探针(补做,记录在案)

`spec:1058-1081`(并发删除)是绿灯之后补加的,没有进上面那份红日志。为免它变成「看起来在测、其实恒绿」的假护栏,单独做了一次反证:把 `prepareShareInsert` 的归属计数谓词从 `= ?` 改成恒真的 `>= 0 AND ? >= 0`,单跑该用例 → **EXIT=1 · `expected BizError`**(share 被建了出来,只挂上 ACC_A 一条 binding,正是 AC-CAP-03 要禁止的部分写入)。改回后全量复跑 EXIT=0。探针未留在工作树(`git diff` 已确认零残留)。

## 绿（历史 · 执行期脏树，并行 T-07 未入库）

- `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` → **EXIT=0** · `105 passed (105)`;连跑 3 次全绿,无 flake(并发限额用例 `spec:385-405` 仍是 `Promise.allSettled` 抢名额)
- `pnpm --dir mail-worker test --no-cache` → **EXIT=0** · `Test Files 17 passed (17)` · `Tests 264 passed (264)`;收尾时不带 `--no-cache` 复跑一次 → **EXIT=0** · `17 files / 265 tests`(+1 是 T-07 在这两次之间又落了一条,不是本任务)
- 日志:`/opt/cursor/artifacts/t12_green_create_multi.log`
- **基线只增不减**:起跑基线 17 files / 213 tests。执行期 264~265 = 213 + 本任务 +42 + **并行写者 T-07 的 +9~10**。本任务零改写不相关用例。

## 最终快照（权威 · `b6f5a28`，含已入库 T-08）

主 AI 独立复跑：

| 套件 | 结果 |
|---|---|
| `mail-share-service.spec.js`（含在四文件定点内） | **106/106 EXIT=0**（+1 为并发删除探针） |
| 全量 worker `pnpm --dir mail-worker test --no-cache` | **17/289 EXIT=0** |
| vue / E2E | **17/95** · **13**，均为 EXIT=0 |

日志:`/opt/cursor/artifacts/t08_t12_full_worker.log`。T-12 scoped 成功态 = owner create 服务写路径 AC-CAP-*；`mail-share-api.js:23-28` `{...body, idempotencyKey}` 已透传，本任务零改 API。HTTP 多邮箱入口用例不在 T-12.1 红灯清单，归后续 owner API 面（T-24 前可补）。

## 改了什么(file:lines)

### `mail-worker/src/service/mail-share-service.js`

| 位置 | 内容 |
|---|---|
| `1-4` | 删 `drizzle-orm` 的 `eq`、`entity/account`、`entity/orm` 三个 import —— 唯一用到它们的 `loadOwnedAccount` 已被批量版取代。`isDel` 保留(进了 SQL 字面量) |
| `10-11` | 新常量 `MIN_REFRESH_INTERVAL_MS = 3000`,注释写明「写入侧拒绝、下发侧钳制归 T-08」(裁决 T12-R1) |
| `17-25` | `SHARE_V2_INTENT` 加第五条 `MESSAGE_LIMIT: 'message_limit'`(裁决 T12-R3) |
| `60-64` | `assertCapabilityV2` 的注释从「四条受限写入路径」改为「哪一条」,并标注 create 侧已接线。**函数体零改动** |
| `107-129` | 新增 `isRowId` / `toFlag` / `toNullableCount` 三个纯归一助手。`isRowId` 与 `test/setup.js:62-64` 同形(`Number.isSafeInteger && > 0`) |
| `131-149` | 新增 `toAccountIdSet`:`accountIds` 优先、缺失回落 `[accountId]`(裁决 T12-R6b)、去重 + 升序。注释写明升序同时服务「UNIQUE 索引 / 栅栏计数 / 指纹」三处口径,并让 `accountIds[0]` 恒等于主 Binding |
| `151-168` | `normalizeCreateBody` 重写为 12 字段单一字面量。注释钉死「键顺序是指纹的一部分,禁止 `{...defaults, ...params}`」与「默认值逐个对齐 v3_2DB DDL DEFAULT」 |
| `211-231` | 新增 `placeholders` / `countOwnedAccounts`(单条批量 `IN`)/ `assertOwnedAccounts`,取代 `loadOwnedAccount`。注释写明这是 TOCTOU 预检、只为让两个错误码可区分 |
| `233-266` | 新增 `assertCreateBody`:域校验 → 上限 → 栅栏。上限排在栅栏前(recon §3.3),51 个 ID 在 V2=false 下也返回 `SHARE_BINDING_LIMIT_EXCEEDED` |
| `299-326` | 新增 `shareTypeOf`(由 binding 计数派生,不落库)/ `loadBindings`;`firstCreateResponse` 扩 `shareType` / `bindings[]` / 条件 `authKey` |
| `338-361` | `replayFromIdempotency` 改 `LEFT JOIN mail_share_binding`,补 `shareType`/`bindings`,**不新增往返**;`sec`/`authKey` 一个字符都不给(AC-CAP-14) |
| `379-440` | `prepareShareInsert` 扩 10 个新列 + `CASE WHEN ? = 1` 的 window 快照 + 在既有限额谓词之上 AND 一条归属计数谓词。注释写明主表 `account_id`/`window_start_email_id` 为什么写 `accountIds[0]` |
| `442-462` | 新增 `prepareBindingInsert`:一条 `INSERT ... SELECT` 同时满足 AC-CAP-07 / AC-CAP-08 / AC-BIND-10;`ORDER BY a.account_id ASC` 让 `binding_id` 顺序 = accountIds 升序 |
| `464-485` | `syncPrimaryAccountId` 扩两处:① `target` 可收 `shareId` 或 `{ lid }`(create 组装语句时 share_id 还不存在);② `window_start_email_id` 与 `account_id` 同批双写(裁决 T12-R2)。`EXISTS` 守卫与「绝不写 0」语义原样保留 |
| `487-511` | 原 `insertShareAndIdempotency` 内联的两条幂等语句抽成 `prepareStaleIdempotencyDelete` / `prepareIdempotencyInsert`(SQL 与绑定参数逐字未变) |
| `513-560` | `insertShareAndIdempotency` 重写:五条语句按 deleteStale → insertShare → insertBindings → syncPrimaryAccountId(by lid)→ insertIdempotency 组批(无幂等键时省掉首尾两条);`changes === 0` 走「先重放、再补一次归属查询消歧」 |
| `563-633` | `create` 重写:`assertCreateBody` + `assertOwnedAccounts` 取代原来的三段内联校验;新增 `authKey = randomToken(16)`;`digestShareSecret` 两处调用都在函数体内(循环 import 安全),并写了 R5 契约注释 |

### `mail-worker/test/mail-share-service.spec.js`

| 位置 | 内容 |
|---|---|
| `15` | `import wranglerToml from '../wrangler.toml?raw'`(只读,用于栅栏未开启的护栏断言) |
| `45-48` | `v2ctx(overrides)`:显式放行 V2 的上下文 |
| `120-160` | `readShareRow` / `listBindings` / `countOwnerRows` / `sqlProbe` 四个助手;`sqlProbe` 是 `:263-276` 那段 D1 代理的提取版(既有用例保持原样,未改一字) |
| `503-557` | **改写**四条 W0 双写用例(授权 T12-R6a):`create()` 之后再手工 `insertBinding(ACC_A)` 会撞 `idx_msb_share_account` 的 UNIQUE,且主 Binding 已被 create 占定,四条的前提在 T-12 之后全部不成立。改用 `seedShareRow` + `seedBindingRow` 直接造行(照抄 `:578` 那条已有的正确模板),**断言语义逐条保留**,用例标题与 AC 标签未动。改写理由写在 `:503-506` 的注释里 |
| `561-576` | **新增**第五条双写用例:按 `lid` 定位 + `window_start_email_id` 双写 |
| `667-1094` | **新增** describe `mailShareService multi-mailbox create (T-12)`,27 条用例(见下表) |
| `1096-1145` | **新增** describe `create under SHARE_CAPABILITY_V2=false (AC-LIFE-11)`,7 条用例 |
| `1160-1173` | `GATED_INTENTS` 与 `SHARE_V2_INTENT` 的冻结断言补第五条 `message_limit`;标题从「four gated intents」改为「the gated intents」。**其余 12 条参数化栅栏用例零改动**(它们跟着 `GATED_INTENTS` 自动多跑一轮) |

### 新增用例 → AC 映射(T-12.1 九组)

| spec 行 | 用例 | 覆盖 | 红? |
|---|---|---|---|
| `668-687` | 多 accountIds → 1 share + N binding + URL 形状不变 | AC-CAP-01 | **真红** |
| `688-703` | `shareType` 实时派生 + 扫表无 `share_type` 列 | AC-CAP-02 | **真红** |
| `705-722` | 主表 `account_id`/`window_start_email_id` 双写 = 主 Binding | AC-LIFE-10, R2 | **真红** |
| `724-745` | 混入他人 / 已删 accountId → 整单拒零残留 | AC-CAP-03 | **真红** |
| `746-754` | 空集 / 非行 ID 元素(0 / -1 / 1.5 / null / Infinity)→ `SHARE_ACCOUNT_FORBIDDEN` | AC-CAP-03 | **真红** |
| `755-765` | `accountIds` 与 `accountId` 同时出现时前者胜出 | T12-R6b | **真红** |
| `769-777` | 51 个 accountId(**无真实 account 行**)→ `SHARE_BINDING_LIMIT_EXCEEDED`,V2=false 下同样 | AC-CAP-13 | **真红** |
| `778-784` | 恰 50 个 → 不撞上限(落到 `SHARE_ACCOUNT_FORBIDDEN`),边界不偏 1 | AC-CAP-13 | **真红** |
| `786-798` | `refreshIntervalMs=2999` 拒 + `5000` 落库 | AC-CAP-06, AC-OTP-06 | **真红** |
| `800-809` | `messageLimit=0` / `maxSessions=0` → `SHARE_INVALID_CONFIG` | AC-CAP-06 | **真红** |
| `811-832` | 七项配置随行存储 | AC-CAP-06 | **真红** |
| `834-851` | per-binding window = 各邮箱自己的 `MAX(email_id)` | AC-CAP-07 | **真红** |
| `853-866` | `onlyMessagesAfterCreated=false` → 每条 binding 与主表都写 0 | AC-CAP-08 | **真红** |
| `868-881` | 快照留在写语句内,无独立 `SELECT MAX(email_id)` 往返 | AC-CAP-07, AC-SHARE-16 | **真红** |
| `883-911` | AuthKey 明文恰一次(22 字符 / 解码 16 字节)、库中仅 hash+kid、重放与 list 均无明文 | AC-CAP-05, AC-CAP-14 | **真红** |
| `915-923` | `auth_key_kid === pepper_kid` 且 hash 用同一 pepper —— **交给 T-08 的口径契约** | R5 | **真红** |
| `925-934` | 未启用时 `auth_key_*` 三列为 0/NULL,响应无 `authKey` | AC-CAP-05 | **真红** |
| `936-954` | AuthKey 明文不进日志(成功 + 拒绝两条路径) | AC-LEAK-05 | **真红** |
| `956-975` | `[C,A]` 与 `[A,C,A]` 同指纹重放 → 同 shareId、无 sec、含 shareType/bindings | AC-CAP-09, AC-CAP-14 | **真红** |
| `977-1003` | 「不传新字段」与「显式传全部默认值」同指纹 | AC-CAP-09 | **真红** |
| `1005-1026` | 8 条参数化:任一新字段(含 accountIds 集合)变化 → `SHARE_IDEMPOTENCY_CONFLICT` 且不建第二条 | AC-CAP-09 | **真红** |
| `1028-1054` | 旧 ShareDialog 单值载荷 → 恰 1 binding + 全默认值 + `shareType: 'single'` | AC-CAP-10 | **真红** |
| `1058-1081` | 预检后、batch 前删 account → 写入侧谓词拦下,零残留 | AC-CAP-03, AC-BIND-10 | 补做(反证见上) |
| `1083-1094` | 限额落空 → 无孤儿 binding | AC-CAP-03, AC-SHARE-15 | **真红** |
| `1097-1108` | V2=false 四路受限写入全拒 + 零残留 | AC-LIFE-11 | **真红** |
| `1112-1124` | V2=false 仍接受 `onlyMessagesAfterCreated=false` 与 `showFullAddress=1` | T12-R3 | **真红** |
| `1126-1137` | V2=false 接受显式 `null` 配额(「显式不限」不是受限意图) | AC-LIFE-11 | 护栏 |
| `1139-1144` | 生产 `wrangler.toml` 无未注释的栅栏赋值 | 部署护栏 | 护栏 |

## 派单裁决的落地对照(逐条,未自行改口径)

| 裁决 | 落在哪 |
|---|---|
| T12-R1 写入侧**拒绝** `refreshIntervalMs < 3000`,钳制归 T-08 | `service:10-11, 244-246` + `spec:786-798`;注释显式写了分工 |
| T12-R2 主表 `window_start_email_id` 与 `account_id` 同批双写 = 主 Binding 快照 | `service:464-485`(同一条 UPDATE 内)+ `service:388-392`(INSERT 的 `CASE WHEN`)+ `spec:705-722, 853-866, 561-576` |
| T12-R3 V2=false 也拒非空 `messageLimit`,新增 `MESSAGE_LIMIT` intent | `service:24, 262-264` + `spec:1097-1108, 1164-1173` |
| T12-R3 接受 `onlyMessagesAfterCreated=false` 与 `showFullAddress=1` | `spec:1112-1124`,理由写在用例上方注释 |
| T12-R5 AuthKey 复用 `SHARE_SEC_PEPPER` / `SHARE_SEC_PEPPER_KID`,调用写在函数体内,落断言给 T-08 | `service:597-620`(含循环 import 说明)+ `spec:915-923` |
| T12-R6a 授权改写四条 W0 双写用例,用 seed 行不走 create | `spec:503-557`,改写理由与「断言语义逐条保留」写在注释里 |
| T12-R6b `accountIds` 与 `accountId` 并存时前者胜出 | `service:131-136` + `spec:755-765` |
| 域校验(51 个)排在 MULTI_CREATE 栅栏之前,51 个 ID 不需要真实 account 行 | `service:233-266` 的顺序 + `spec:769-777`(用 990000+ 的不存在 ID) |
| 不动 `mail-share-api.js` | 零改动,`{...body, idempotencyKey}` 已把新载荷整体透传 |
| 不搬 `SHARE_EVENT`、不加 `share_type` 列、不动 `init.js` / `share-auth-service.js` / `package.json` / `mail-vue` | 全部零改动,`git status` 已核 |
| 归一化用单一字面量,键顺序即指纹 | `service:151-168`,注释写明为什么不能用展开语法 |
| `accountIds` 元素复用 `Number.isSafeInteger && > 0` 形状 | `service:107-109` |
| 写批顺序 deleteStale → insertShare → insertBindings → syncPrimaryAccountId(by lid)→ insertIdempotency | `service:520-535` |
| `insertShare` 落空:先 `replayOrConflict`,再补归属查询消歧 | `service:552-560` |
| 不 commit | 工作树保留改动,未 `git add` / `git commit` / `git push` |

## 既有护栏复核(未误伤)

- **`mail-share.schema.spec.js:142-147` 的 `row.accountId` 读取数冻结**:正则的扫描对象只有 `share-auth-service.js`(冻结为 4)与 `share-scoped-email-repository.js`(冻结为 0),**不含** `mail-share-service.js`。本任务在 `mail-share-service.js` 里新增的 `ms.account_id` 引用不进这条正则,全量套件已验证。
- **`share_type` 无列**(`mail-share.schema.spec.js:69`):未建列,`shareType` 只在响应组装时由 binding 计数派生。
- **`mail_share.account_id` NOT NULL**(`:153-155`):INSERT 恒写 `accountIds[0]`(升序去重后的首个,必 >0),不留空等 sync。
- **指纹稳定性旧用例**(`spec:367-383`「missing name 与 empty name 同指纹」):归一化仍是单一字面量,该用例未改一字仍绿。
- **并发限额线性化点**(`spec:385-405`):batch 里多了三条语句,但限额谓词仍在 `insertShare` 的 WHERE 里,仍是唯一线性化点;`Promise.allSettled` 抢名额仍恰 1 成功。
- **API 面与集成**(`share-api.spec.js` / `share-integration.spec.js`):旧单值载荷经 HTTP 走完整链路,全量套件 17/17 绿。
- **`logShareEvent` 信封**(`spec:1244-1262`):未改该函数,本任务也未新增任何 `console.log`。

## 遗留风险

1. **`ORDER BY a.account_id ASC` 依赖 SQLite 为 `INSERT ... SELECT` 按 SELECT 结果序分配 AUTOINCREMENT。** 实测成立(`spec:668-687` 传乱序 `[ACC_C, ACC_A]` 拿回升序 binding)。即使某天该行为变化也不会产生不一致:同批的 `syncPrimaryAccountId` 会按真实的最小 `binding_id` 重新落定主表两列,`spec:705-722` 断言的是「主表 = `rows[0]`」这个动态不变量而不是硬编码值。但若 T-13 要依赖「binding_id 序 = accountId 序」,需要先自己验一遍。
2. **幂等指纹跨部署 24h 窗口(recon R7,未消除)。** 部署瞬间之前由旧 Worker 写下的 4 字段指纹与新的 12 字段指纹不匹配,同一个 key 在部署后重试会拿到 `SHARE_IDEMPOTENCY_CONFLICT` 而非重放。窗口 ≤24h,影响面 = 恰好跨越部署时刻的创建重试。按派单未加版本前缀,建议记入 Decision Record。
3. **`create` 的失败归因多一次查询往返(recon R4 已裁,记录在案)。** `changes === 0` 时补一次 `countOwnedAccounts` 才能区分 `SHARE_ACCOUNT_FORBIDDEN` 与 `SHARE_LIMIT_EXCEEDED`。只在失败路径发生,成功路径零额外往返。
4. **`replayFromIdempotency` 现在必然返回 `bindings: []` 给「迁移前建、尚未回填 Binding」的旧行**,此时 `shareType` 派生为 `single`。AC-CAP-02 定义 0 条 Binding = 「已进入撤销路径」,但重放响应没有第三种取值可给。实际影响面极小(v3_2DB 回填已把合规旧行都补了 Binding,不合规的已被置 REVOKED),但严格说 `shareType` 在 0-binding 时的取值 spec 未定义,留给 T-15 的 list 投影一并裁。
5. **`SHARE_V2_INTENT` 现在有 5 条,`assertCapabilityV2` 的判定仍与 intent 无关。** `BINDING_EXPAND` 至今没有调用点(归 T-13),`MESSAGE_LIMIT` 只在 create 接了线,update 侧(T-15)必须记得接同一条,否则 `PUT /mailShare/update` 会成为绕过栅栏写 `message_limit` 的后门。
6. **AuthKey 只写不验。** T-12 只负责 `auth_key_hash`/`auth_key_kid` 落库,校验方在 T-08。在 T-08 落地之前,`authKeyEnabled=1` 的分享对访客而言与未启用无差别 —— 这是能力未闭环,不是漏洞(该分享只有在 V2=true 时才可能被创建,而 V2=true 的激活前置本就包含「无旧 Worker 在途」)。`spec:915-923` 就是防止 T-08 用另一个 pepper 口径实现的那道锁。
7. **vitest transform 缓存会掩盖新用例(见「红」小节的坑)。** 后续任务在同一工作树反复改 spec 时,取证跑建议一律带 `--no-cache`,否则可能拿到一份「用例数没变、全绿」的假红。

## Review Findings

- **无方向性偏差,按 recon §2 Step 1-7 逐步执行。** recon 给的行号锚点(`:106-113` 归一化 / `:156-162` 归属 / `:194-226` 响应 / `:239-359` 写库 / `:362-423` create)与工作树逐条命中,未发生漂移。
- **`insertShareAndIdempotency` 的无幂等键分支从「单语句直执行」改成了「三语句 batch」。** 原代码在没有 `Idempotency-Key` 时走 `insertShare.all()` 不进 batch;现在 binding 与双写必须与 share 同批提交(AC-CAP-01/AC-LIFE-10),所以无幂等键时也组批,只是省掉首尾两条幂等语句。既有用例 `spec:180-192`(无 key 创建)与 `spec:385-405`(无 key 并发抢限额)覆盖了这条路径,均绿。
- **`prepareBindingInsert` 的 SQL 会被既有用例 `spec:278` 的 `/INSERT\s+INTO\s+mail_share/i` 正则误命中**(`mail_share_binding` 是 `mail_share` 的前缀)。该用例用 `seen.find(...)` 取**第一条**,而 batch 里 `insertShare` 排在 `insertBindings` 之前,所以取到的仍是主表语句、断言仍在测它想测的东西。本任务新加的 per-binding 快照用例改用 `/INSERT\s+INTO\s+mail_share_binding/i` 精确匹配,避免同一个坑。
- **`toFlag` 把 `''` 当缺失而不是 falsy。** 前端表单空串与「没传」语义相同,若按 falsy 处理会让空串把 `only_messages_after_created` 从 1 打成 0 —— 那是一个静默放宽可见集的方向,不能默认。
- **跨域只读核查,未跨域改动**:读了 `init.js:38-89`(DDL 默认值对账)、`mail-share-api.js:23-28`(确认新载荷已透传)、`share-auth-service.js:95-98`(`digestShareSecret` 的 pepper 口径)、`mail-share.schema.spec.js` 全文(护栏边界)、`test/setup.js:60-132`(`isRowId` 形状与 seed 助手能力)、`wrangler.toml:57-60` 与 `wrangler-vitest.toml:41`(栅栏默认态),以确认 ① `test/setup.js` 确实不需要新助手;② AuthKey 复用 pepper 不需要动任何 toml;③ 归一化默认值与 DDL 逐个对齐。

## Update Log

- 2026-08-24 · 主 AI:P0-1/P1-1 入库 `6b5d29b`。独立复跑 mail-share 132/132、全量 worker 17/317、vue 17/95、E2E 13，均为 EXIT=0。遗留风险 2（滚动指纹）已关。
- 2026-08-24 · executor:落地 T-12 代码审查的两条 CHANGE(review-t12.md P0-1 / P1-1),只动
  `mail-share-service.js` + `mail-share-service.spec.js`,未 commit。
  - **红**:`pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` →
    **EXIT=1** · `19 failed | 113 passed (132)`。分布:P1-1 的 flag 15 条(五个 flag × `'invalid'`/`2`/`{}`)
    + count 2 条(`maxSessions: true` / `messageLimit: true`);P0-1 的 old→new 重放 1 条(实际抛
    `SHARE_IDEMPOTENCY_CONFLICT`)+ new→old 存储指纹 1 条(`4e1bac…` ≠ 旧 `448447…`)。
    日志 `/opt/cursor/artifacts/t12_change_red.log`。
    `MALFORMED_COUNTS` 里的 `false` / `'invalid'` 红阶段已绿 —— 旧 `Number()` 路径撞上
    `assertCreateBody` 的 `isSafeInteger` / `< 1`,它们是护栏不是驱动用例;真正的洞只有布尔。
  - **绿**:同命令 → **EXIT=0** · `132 passed (132)`。日志 `/opt/cursor/artifacts/t12_change_green.log`。
  - **全量**:`pnpm --dir mail-worker test --no-cache` → **EXIT=0** · `17 files / 317 tests`。
    日志 `/opt/cursor/artifacts/t12_change_full_worker.log`。⚠️ 该数字含同一工作树里并行 T-08
    未入库的 `share-auth-service.js` / `share-auth-service.spec.js` / `mail-share.schema.spec.js`
    改动,不是本次改动的净增。本次净增 26 条,口径取定点 spec 的 `106 → 132`。
  - **P0-1**(`service:193-227`)新增 `legacyCompatibleBody` + `createFingerprints`。兼容载荷
    = 单 accountId 且 `maxSessions`/`messageLimit` 为 null、三个 1-默认 flag 为 1、
    `refreshIntervalMs === MIN_REFRESH_INTERVAL_MS`、`showFullAddress`/`authKeyEnabled` 为 0。
    这类载荷**落库存旧四字段 hash**(new→old 方向),重放时 `accepted = [新 12 字段 hash, 旧 hash]`
    两个都认(old→new 方向 + 修复前新 Worker 写下的存量行)。非兼容载荷只走新 hash。
    `replayOrConflict` 第四参从单值改成 `accepted` 数组(`service:415-422`),`resolveReplay`
    与 `create` 同步换参。**未加版本列、未加第二张表。**独立复算佐证:
    `{accountId:909101,durationSeconds:3600,name:'',remark:''}` 的旧四字段 hash =
    `d5c870aaf938ac6df25f53f9847c50073d56e7abcac76be846b786af95e852bf`,与 review 的探针一致。
    → **本条关闭上面「遗留风险 2」(幂等指纹跨部署 24h 窗口)。**
  - **P1-1**(`service:111-139`)`toFlag` 改成 `FLAG_TOKENS` Map 白名单
    (`true/false/0/1/'0'/'1'/'true'/'false'`,`null`/`''` 仍回落默认),命不中即
    `BizError('SHARE_INVALID_CONFIG')`;`toNullableCount` 只收 number/string 且必须是安全整数,
    布尔显式落到 NaN 分支。下界 `< 1` 仍留在 `assertCreateBody`(未动那段)。
  - 新增用例 26 条:P0-1 三条(old→new 重放 / new→old 存旧 hash / 非兼容载荷不落旧 hash),
    P1-1 二十三条(15 flag 负向 + 6 count 负向 + 「全部合法 flag token 仍接受」+
    「整数字符串配额仍接受」)。既有 `treats omitted new config fields as their defaults`
    与 8 条指纹 CONFLICT 参数化表全部保持绿。
- 2026-08-24 · 主 AI:工件审查 `exec-t12-note.review1.sub.md` NEEDS_CHANGES。A1 HOLD（T-12.1 权威范围是 service spec；API `{...body}` 既有透传，HTTP 多邮箱入口不扩进本任务）；E1 CHANGE（权威快照钉到 `b6f5a28` / 17/289）；H1 HOLD（0-binding replay=`single` 交 T-15 list 投影；v3_2DB 已回填/撤销不合规旧行）。
- 2026-08-24 · 主 AI:入库 `b6f5a28`。独立复跑 mail-share spec 含在 185/185 内（106/106）+ 全量 17/289 EXIT=0。vue 17/95 EXIT=0。
- 2026-08-24 · executor:T-12 落地。红 EXIT=1(37 failed / 68 passed / 105)→ 绿 EXIT=0(spec 105/105;全量 17 files / 264→265 tests,尾数随并行写者 T-07 浮动)。改动 2 文件:`mail-share-service.js`(归一化集合化 + 域校验 + 五条 V2 栅栏接线 + 批量归属校验 + 三条写语句扩写/新增 + `syncPrimaryAccountId` 扩 lid 定位与 window 双写 + 响应扩 shareType/bindings/authKey)、`mail-share-service.spec.js`(+42 用例、改写 4 条 W0 双写用例、栅栏冻结断言补第五条 intent)。`test/setup.js` 未动。踩到的坑:vitest transform 缓存导致第一次红跑报出改动前的用例数,须带 `--no-cache`;`mail_share_binding` 会被既有的 `INSERT INTO mail_share` 正则前缀误命中。写入侧归属谓词另做了一次反证探针(改成恒真 → 该用例转红),探针已还原。未 commit、未 push。
