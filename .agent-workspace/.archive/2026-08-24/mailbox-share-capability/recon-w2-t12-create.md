# Recon · W2 / T-12 create 多邮箱扩展 可执行修改范围

- **模式**:Mode R(reality recon)· 只服务 T-12,不重写 `recon-w1-t06-quota-gate.md` / `recon-w1-auth-chain.md`
- **日期**:2026-08-24
- **分支**:`cursor/mailbox-share-capability-dcb6` · 派单基线 HEAD `f92d9a5` → **收尾基线 HEAD `6209960`**
- **✅ 侦察收尾时两个并行写者都已落地,`mail-share-service.js` 现在是空闲的**:
  - `3cce543 fix(worker): tighten seed IDs and protect share event names` —— 派单里说的「在飞 W0 修复」(`logShareEvent` 信封顺序 + `test/setup.js` seed ID 收紧 + spec +18 用例)。**这是 T-12 的唯一硬前置,已关闭。**
  - `6209960 feat(worker): add session quota consume gate` —— T-06 绿灯(`share-auth-service.js` +62-21,spec +420-21)。
  - 侦察过程中这两处一度是未提交改动,第一次全量跑撞到中间态(7 failed);**那不是 flaky,是并行写者的中间快照**。收尾时工作树已干净。
- **本报告的行号基准**:**HEAD `6209960` 的 `mail-share-service.js`**。派单基线 `f92d9a5` 的行号在 `:75` 之后整体 −1(`3cce543` 插了一行注释),本报告已全部换算到新 HEAD。仍建议执行者按符号名定位。
- **本次实跑基线**:
  - `pnpm --dir mail-worker test` @`6209960` → **17 files / 213 tests, EXIT=0**(T-12 的只增不减起点)
  - 同命令 @`f92d9a5` 干净 clone → **17 files / 185 tests, EXIT=0**(与 `exec-t05-note.md:36` 一致;两次之差 = W0 修复 +18、T-06 +10)
  - `test/mail-share-service.spec.js` @`6209960` → **63 用例**(@`f92d9a5` 为 45)
- **本次侦察写了什么**:仅本报告。**零业务代码改动、零 commit、`/workspace` 内零临时文件**。取证探针建在 `/tmp/headbase`(`f92d9a5` 的一次性 clone)里,跑完连 clone 一起删了。探针输出逐条引在 §4.2,可复现。

---

## 问题速查索引(派单 7 问 → 本报告章节)

| # | 派单问题 | 答在 |
|---|---|---|
| 1 | 当前 create 路径 file:line + 精确改写序列 | §1 + §2 |
| 2 | V2=false 怎么既保旧单邮箱 create 绿、又拦住四类意图 | §3 |
| 3 | 幂等指纹:纳入哪些新字段 + 排序 accountIds | §4.1 |
| 4 | 文件冲突图(T-06 / T-13 / 在飞的 W0 `logShareEvent` 修复) | §4.2 + §4.3 |
| 5 | T-12 能否先于 T-08(ShareContext)起跑 | §5 |
| 6 | 会逼改 spec 的风险 | §6 |
| 7 | 本波次执行者拆分建议 | §7 |

---

## 1. 当前 create 路径的真实坐标(HEAD `6209960`)

### 1.1 主链路

| 环节 | HEAD 位置 | 现状 | T-12 动作 |
|---|---|---|---|
| HTTP 入口 | `mail-worker/src/api/mail-share-api.js:23-28` | `{...body, idempotencyKey}` 整体透传 | **零改动即可**(见 §1.3) |
| 服务入口 | `mail-share-service.js:362-423` `create(c, params, userId)` | 单 `accountId` | 重写 |
| 开关 | `:364-366` `isShareDisabled` | `SHARE_DISABLED` | 不动 |
| 载荷归一 | `:106-113` `normalizeCreateBody` | 只认 4 字段 | **重写**(集合化 + 新配置字段 + 默认值) |
| accountId 校验 | `:368-371` | `Number.isFinite && > 0` | 改成集合级 |
| 时长校验 | `:371-375` | `SHARE_DURATION_EXCEEDED` | 不动 |
| 归属校验 | `:156-162` `loadOwnedAccount` → `:376` 调用 | 单行 `SELECT` + `isDel`/`userId` 判定 | **改批量 IN**(tasks.md 里写的 `:104-110` 是陈旧锚点,实际 `:156-162`) |
| pepper | `:378-382` | `SHARE_SEC_PEPPER` 缺失即 500 | 复用(AuthKey 同源,见 §6-R5) |
| 幂等键 | `:384-386` | 从 `params.idempotencyKey` 取 | 不动 |
| 指纹 | `:120-122` `requestFingerprint` → `:387` | `sha256(JSON.stringify(body))` | **扩形状**(§4.1) |
| 提前重放 | `:228-237` `replayOrConflict` → `:388-394` | TTL 24h + 指纹比对 | 不动 |
| 时间/凭据 | `:396-401` | `lid=randomToken(16)`、`sec=randomToken(32)` | 加 `authKey=randomToken(16)`(16 字节 base64url 恰 22 字符,正是 AC-CAP-05 的定长规格,`lid` 已在用这条路) |
| 写库 | `:292-359` `insertShareAndIdempotency` + `:239-270` `prepareShareInsert` | `db.batch([deleteStale, insertShare, insertIdempotency])` | **主战场**,加 binding 语句 + 双写 |
| 双写助手 | `:276-290` `syncPrimaryAccountId` | 返回未执行语句 | **接线**(放进同一 batch) |
| 响应 | `:194-203` `firstCreateResponse` | `{shareId, lid, sec, expiresAt, shareUrl}` | 加 `shareType` / `bindings[]` / `authKey?` |
| 重放响应 | `:213-226` `replayFromIdempotency` | `{shareId, lid, expiresAt, idempotentReplay}` | 加 `shareType` / `bindings[]`,**绝不加 `sec`/`authKey`**(AC-CAP-14) |

### 1.2 已有的三个可复用「单语句原子写」模式(别重造)

1. **限额条件写**:`prepareShareInsert` `:250-253` —— `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < ?`。AC-CAP-07 点名要沿用的就是这个(spec 里写的 `:187-218` 是陈旧锚点)。
2. **窗口原子快照**:`:248` —— `(SELECT COALESCE(MAX(email_id), 0) FROM email WHERE account_id = ?)` 内嵌在 INSERT 的 SELECT 里。per-binding 快照就是把它挪进 binding 的 `INSERT ... SELECT`。
3. **靠 `lid` 回捞刚插入的 `share_id`**:`:312-314` 幂等行用 `SELECT ?, ?, ?, ?, share_id, ?, ? FROM mail_share WHERE lid = ?`。**这是 T-12 最关键的一块现成积木** —— binding 行同样需要一个尚不存在的 `share_id`,同一 batch 里用 `WHERE lid = ?` 回捞即可;并且当 share 因限额未插入时,这条 SELECT 天然零行,binding 自动不写,零孤儿。

### 1.3 `mail-share-api.js` 大概率不用改

`:24-26` 是 `const body = await c.req.json()` + `{ ...body, idempotencyKey }`。`accountIds` 数组、`maxSessions`、`authKeyEnabled` 全都随 spread 原样进 service。tasks.md T-12.2 写的「create 端点透传新载荷」在当前实现下**已经成立**。

**建议:T-12 不碰 `mail-share-api.js`**,把校验全部留在 service(既有约定就是这样:`durationSeconds`/`accountId` 的校验都在 service)。少碰一个文件 = 少一份与 T-13(要在同文件加 `PUT /mailShare/bindings`)的冲突面。

---

## 2. 精确改写序列(以「W0 修复已 commit」的工作树为基准)

> 一条铁律贯穿全序列:**任何写库之前,所有拒绝路径必须已经走完**。AC-CAP-03 的「零残留」不是靠回滚实现的 —— D1 没有 `BEGIN`,`c.env.db.batch()` 一旦提交就没有回头路。

### Step 0 · 起跑前置(不是代码)

**已关闭。** W0 修复已入库为 `3cce543`,T-06 已入库为 `6209960`,`mail-share-service.js` 工作树干净。执行者从 `6209960` 起跑即可,不需要再等。

### Step 1 · `normalizeCreateBody`(`:106-113`)重写为集合化归一

产出一个**字段顺序固定、全部带默认值**的对象(顺序固定这点很重要,§4.1 会解释为什么):

```
{
  accountIds: number[],      // 去重 + 升序;旧 `accountId` 单值归一进来
  durationSeconds: number,
  name: string,              // 现状:null → ''
  remark: string,
  maxSessions: number|null,          // 默认 null(不限)
  messageLimit: number|null,         // 默认 null(不限);给值时 >=1
  onlyMessagesAfterCreated: 0|1,     // 默认 1
  otpExtractionEnabled: 0|1,         // 默认 1
  autoRefresh: 0|1,                  // 默认 1
  refreshIntervalMs: number,         // 默认 3000
  showFullAddress: 0|1,              // 默认 0
  authKeyEnabled: 0|1                // 默认 0
}
```

默认值必须和 `init.js:41-51` 的 DDL DEFAULT **逐个对齐**(`only_messages_after_created` 1 / `otp_extraction_enabled` 1 / `auto_refresh` 1 / `refresh_interval_ms` 3000 / `show_full_address` 0 / `auth_key_enabled` 0 / `credentials_version` 0,`max_sessions` 与 `message_limit` 无 DEFAULT 即 NULL)。`test/setup.js:92-102`(`3cce543` 之后)的 `seedShareRow` 默认值也是同一套,可以拿来当交叉校对表。

`accountIds` 归一细节:
- `accountIds` 缺失 → 回落 `[accountId]`(AC-CAP-10)。
- 两者都给:建议**以 `accountIds` 为准**,或直接判 `SHARE_INVALID_CONFIG`。spec 没裁,选一个并写进用例(§6-R6b)。
- 去重 + 升序:表级 `UNIQUE(share_id, account_id)`(`init.js:74`)决定了重复 ID 只能落一条,先去重才能让「栅栏计数 / 上限计数 / 指纹」三者口径一致。
- 空数组 / 全非法 → `SHARE_ACCOUNT_FORBIDDEN`。

### Step 2 · 取值域校验(纯计算,零 IO)

顺序建议(**先域校验、再栅栏、最后归属**,理由见 §3.3):

1. `durationSeconds`(`:370-374`,不动)
2. `accountIds.length > SHARE_BINDING_LIMIT` → `SHARE_BINDING_LIMIT_EXCEEDED`
3. `refreshIntervalMs < 3000` → `SHARE_INVALID_CONFIG`(**拒绝,不是钳制** —— 见 §6-R1)
4. `messageLimit != null && messageLimit < 1` → `SHARE_INVALID_CONFIG`
5. `maxSessions != null && maxSessions < 1` → `SHARE_INVALID_CONFIG`

### Step 3 · V2 栅栏接线(三处,§3 详述)

```
if (body.accountIds.length > 1)      assertCapabilityV2(c, SHARE_V2_INTENT.MULTI_CREATE);
if (body.authKeyEnabled)             assertCapabilityV2(c, SHARE_V2_INTENT.AUTH_KEY_ENABLE);
if (body.maxSessions != null)        assertCapabilityV2(c, SHARE_V2_INTENT.FINITE_MAX_SESSIONS);
```

`assertCapabilityV2` 在 `:64-69`,已经是「缺省 = false + 只认 env、不认 setting 行」的成品,`test/mail-share-service.spec.js:632-669` 用 12 条参数化用例钉死了它的判定语义。**T-12 只接线,不碰这个函数**。

### Step 4 · `loadOwnedAccount`(`:156-162`)改批量

```
async function loadOwnedAccounts(c, accountIds, userId) -> Map<accountId, row>
```
单条 `SELECT ... WHERE account_id IN (?,...) AND user_id = ? AND is_del = NORMAL`,返回行数 ≠ `accountIds.length` → `SHARE_ACCOUNT_FORBIDDEN`。最多 50 个占位符,离 SQLite 变量上限很远。

⚠️ 这是 TOCTOU 预检,不是防线。防线在 Step 5 的条件 INSERT。这一步存在的唯一理由是:**让 `SHARE_ACCOUNT_FORBIDDEN` 和 `SHARE_LIMIT_EXCEEDED` 可区分**(§6-R4)。

### Step 5 · 写库 batch(`insertShareAndIdempotency` `:292-359` 扩写)

batch 语句序列(顺序即依赖顺序):

1. `deleteStale`(`:303-306`,不动)
2. `insertShare`(`:239-270` 扩写):`INSERT` 列表加 11 个新列;`WHERE` 子句在既有限额谓词之上 **AND** 一条归属计数谓词:
   ```
   AND (SELECT COUNT(*) FROM account
        WHERE account_id IN (?,...) AND user_id = ? AND is_del = 0) = :N
   ```
   把 Step 4 的预检**同时**做成写入侧条件,与 account 删除并发时整个 batch 零变更 —— 这是 AC-CAP-03「零残留」的真正实现点。
   主表 `account_id` 写什么:写 `accountIds[0]`(去重升序后的首个)作为占位,真值由第 4 条语句的 `syncPrimaryAccountId` 落定;`account_id` 是 `NOT NULL`(`mail-share.schema.spec.js:153-155` 钉死),且 AC-LIFE-10 禁止写 0,所以**必须**给一个 >0 的初值,不能留空等 sync。
   主表 `window_start_email_id` 写什么 —— **停下,看 §6-R2**,这是本报告最要紧的一条上报项。
3. `insertBindings`(新增,**一条语句**):
   ```sql
   INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id)
   SELECT ms.share_id, a.account_id,
          CASE WHEN ? = 1
               THEN (SELECT COALESCE(MAX(e.email_id), 0) FROM email e WHERE e.account_id = a.account_id)
               ELSE 0 END
   FROM mail_share ms
   JOIN account a ON a.account_id IN (?,...) AND a.user_id = ? AND a.is_del = 0
   WHERE ms.lid = ?
   ```
   一条语句同时满足三条 AC:AC-CAP-07(per-binding 原子快照)、AC-CAP-08(false 写 0)、AC-BIND-10(条件 INSERT,account 存活/归属)。share 未插入 → `WHERE ms.lid = ?` 零行 → binding 零行,无需额外守卫。
4. `syncPrimaryAccountId(c, shareId)` —— **卡点**:这个助手(`:276-290`)签名收 `shareId`,而 create 阶段 `share_id` 还不存在。两条出路:
   - **(推荐)** 给助手加一个按 `lid` 定位的姊妹语句,或把 `WHERE share_id = ?` 改成 `WHERE share_id = (SELECT share_id FROM mail_share WHERE lid = ?)`。改动小、语义不变、`EXISTS` 守卫原样保留。
   - 退而求其次:create 路径不调助手,靠 Step 5.2 的 `accountIds[0]` 初值直接落对。**不推荐** —— 主 Binding 的定义是「`binding_id` 最小」,而 `binding_id` 由第 3 条语句的 AUTOINCREMENT 决定,JOIN 的行序不保证等于 `accountIds` 的升序。让两个真源各自猜,迟早对不上。
   无论选哪条,**都要在同一个 `batch()` 里**(AC-LIFE-10 原话:「同一 `c.env.db.batch()` 内同步更新主表列」)。
5. `insertIdempotency`(`:308-323`,只改指纹入参)

### Step 6 · 结果判定与错误归因

`insertShare` 的 `meta.changes === 0` 现在有**两个**可能原因(限额 / 归属)。既有代码 `:328-340` 只归因到 `SHARE_LIMIT_EXCEEDED`。改法沿用仓内已有的「事后消歧」模式(`replayOrConflict` 就是这么干的):`changes === 0` → 先查幂等重放,没有重放再补一次归属查询,归属不过 → `SHARE_ACCOUNT_FORBIDDEN`,否则 `SHARE_LIMIT_EXCEEDED`。

### Step 7 · 响应

- `firstCreateResponse`(`:194-203`)加 `shareType`(由本次写入的 binding 条数派生,**不落库**,AC-CAP-02)、`bindings: [{bindingId, accountId}]`、`authKey`(仅 `authKeyEnabled` 时,明文恰一次)。
- `replayFromIdempotency`(`:213-226`)加 `shareType` / `bindings[]`,**明文一个都不给**(AC-CAP-14)。派生所需的 binding 计数得回查一次 —— 重放路径本来就已经查了一次 `mail_share`(`:215-217`),扩成 JOIN 即可,不新增往返。

### Step 8 · 不要做的三件事

1. **不要把 `SHARE_EVENT`/`logShareEvent` 抽到 `src/const/share-event.js`**。`recon-w1-t06-quota-gate.md:535` 把这件事记为「W2 收口输入」,但 T-06 已经在 `6209960` 里 `import { SHARE_EVENT, logShareEvent } from './mail-share-service'`(`share-auth-service.js:8-11` 带了循环 import 的说明注释)。T-12 期间搬家 = 砸掉刚落地的 T-06。留给 T-19。
2. **不要在模块求值期解引用 `shareAuthService`**。这个循环 import 靠「两个方向都只在函数体内解引用」活着。AuthKey 的 `digestShareSecret` 调用写在函数体内即可。
3. **不要加 `share_type` 列**。`mail-share.schema.spec.js:69` 有 `expect(...).not.toContain('share_type')` 护栏。

---

## 3. V2=false 如何既保旧绿、又拦四类意图

### 3.1 为什么旧单邮箱 create 天然不触发栅栏

三条栅栏的触发条件都是**显式意图**,而旧载荷三项全空:

| 意图 | 触发条件 | 旧 ShareDialog 载荷 | 结果 |
|---|---|---|---|
| `MULTI_CREATE` | `accountIds.length > 1` | 单 `accountId` → 归一为长度 1 | 不触发 |
| `AUTH_KEY_ENABLE` | `authKeyEnabled` 真值 | 字段不存在 → 默认 0 | 不触发 |
| `FINITE_MAX_SESSIONS` | `maxSessions != null` | 字段不存在 → 默认 null | 不触发 |
| `BINDING_EXPAND` | —— | 属 T-13 的 `PUT /mailShare/bindings` | 不在 T-12 |

前端真实载荷可核:`mail-vue/src/request/mail-share.js:21-30` 把请求体**显式收窄**成 `{accountId, durationSeconds, name, remark}` 四字段,连透传新字段的可能性都没有。W4 之前这个文件不改(tasks.md:235 归 T-20)。

`wrangler-vitest.toml:41` 已经 `SHARE_CAPABILITY_V2 = "false"`,`wrangler.toml:58` 只有注释声明。**测试环境的默认态就是生产默认态**,不需要任何额外布置。

### 3.2 「默认值 = 旧语义」是保绿的真正机制

V2=false 不是把新代码关掉,而是让新代码的默认值路径与旧行为逐位等价:

| 新列 | T-12 默认写入 | 旧 Worker 读到 | 是否等价旧语义 |
|---|---|---|---|
| `max_sessions` | NULL | 不认识该列 | ✅ 不限,等价 |
| `auth_key_enabled` | 0 | 不认识 | ✅ 无第二因子,等价 |
| `credentials_version` | 0(DDL 默认) | 不认识 | ✅ |
| binding 行数 | 恰 1 | 不认识该表 | ✅ 读主表 `account_id` |
| `account_id`(主表) | = 唯一 binding 的 account | 授权真源 | ✅ 双写成立 |
| `message_limit` | NULL | 不认识 | ✅ **仅当默认 NULL 时** |
| `only_messages_after_created` | 1 | 不认识 | ⚠️ 见 §6-R2 |
| `show_full_address` | 0 | 不认识 | ⚠️ 见 §6-R3 |

前 5 行是 AC-LIFE-11 明文覆盖的;后 3 行不在栅栏清单里,但同样是「旧 Worker 无法执行的策略」。**这是 spec 的洞,不是实现的洞**(§6-R2/R3)。

### 3.3 校验顺序:为什么域校验要排在栅栏前面

T-12.1 的红灯清单里有一条「51 个 accountId → `SHARE_BINDING_LIMIT_EXCEEDED` 整单拒」。51 个 accountId 同时满足 `length > 1`,所以**顺序决定错误码**:栅栏在前 → `SHARE_INVALID_CONFIG`,上限在前 → `SHARE_BINDING_LIMIT_EXCEEDED`。

推荐**上限在前**,两个理由:① 用例可以在 V2=false 下直接写,不需要为了测上限先把栅栏打开;② 「51 > 50」是永远为真的领域错误,而栅栏是暂时的发布态,把永久错误报出来对调用方更有用。

代价:V2=true 之后这个错误码不变,行为一致,无回归。**这是执行者必须显式做出并写进用例注释的选择,spec 没裁。**

### 3.4 保绿清单(必须逐条复跑)

| 用例组 | 位置 | 为什么会被 T-12 波及 |
|---|---|---|
| `mail-share-service.spec.js` create 全组 | `:140-461` | 全部走旧单值 `createParams()`;归一化改坏立刻红 |
| 指纹稳定性 | `:327-343`「missing name 与 empty name 同指纹」 | 归一化改形状会直接破这条(§4.1) |
| 并发限额 | `:345-365` | batch 里多了两条语句,限额谓词必须仍是唯一线性化点 |
| 幂等孤儿 | `:386-405` | 限额落空时 binding 也必须零行 |
| API 面 | `share-api.spec.js:139-181` `:284-296` `:317-370` | 旧载荷经 HTTP 走完整链路 |
| 集成 | `share-integration.spec.js:209` `:577-581` `:680` `:728` | 同上 |
| schema 护栏 | `mail-share.schema.spec.js:66-69` `:142-155` | 无 `share_type` 列、`account_id` NOT NULL |
| 双写四条 | `mail-share-service.spec.js:463-527` | **会被打破,必须改写** —— §4.2 |

---

## 4. 幂等指纹 与 冲突图

### 4.1 指纹:纳入哪些字段

现状(`:120-122`):`sha256Hex(JSON.stringify(normalizeCreateBody(params)))`,输入是 `{accountId, durationSeconds, name, remark}`。

**新指纹输入 = Step 1 归一化产出的完整对象**,即 12 个字段:

| 入指纹 | 字段 | 备注 |
|---|---|---|
| ✅ | `accountIds` | **去重 + 升序数值数组**。AC-CAP-09 原话「排序后的 `accountId` 集合」。`[3,1]` 与 `[1,3]` 与 `[1,1,3]` 必须同指纹 |
| ✅ | `durationSeconds` / `name` / `remark` | 现状不变 |
| ✅ | `maxSessions` / `messageLimit` / `onlyMessagesAfterCreated` / `otpExtractionEnabled` / `autoRefresh` / `refreshIntervalMs` / `showFullAddress` | AC-CAP-09「全部新配置字段」 |
| ✅ | `authKeyEnabled` | 是策略意图,必须入 |
| ❌ | AuthKey 明文 | 服务端生成,每次不同,入了指纹重放永远 conflict |
| ❌ | `idempotencyKey` | 它是键,不是体 |
| ❌ | `lid` / `sec` / 时间戳 | 同上 |

**三个必须钉死的实现细节:**

1. **字段顺序是指纹的一部分**。`JSON.stringify` 按插入顺序序列化。归一化函数必须**用字面量一次性构造整个对象**(现状 `:107-113` 已经是这个写法),不能 `{...defaults, ...params}` —— 后者的键顺序会随调用方传了哪些字段而变,同一语义请求会算出两个指纹。
2. **默认值必须在指纹之前落定**。「不传 `messageLimit`」与「显式传 `null`」必须同指纹。这正是既有用例 `:327-343`(missing name ≡ empty name)在守的性质,把它扩到全部新字段就是 T-12.1 的现成红灯素材。
3. **数值归一**。`'5'` 与 `5`、`true` 与 `1` 必须收敛到同一个 JSON 值,否则前端换个序列化方式就 conflict。`3cce543` 刚给 `test/setup.js:62-64` 加的 `isRowId`(`Number.isSafeInteger(v) && v > 0`)是现成的同款判据,`accountIds` 元素校验可以照抄这个形状 —— 那次修复挡的正是 `'1e3'` / `'1.5'` / `true` / `Infinity` 这四种「满足 `> 0` 却不是行 ID」的形状。

**跨部署风险**(§6-R7):`share_idempotency` 的 TTL 是 24 小时(`:10`)。部署瞬间之前由旧 Worker 写下的指纹是旧形状;同一个 key 在部署之后重试 → 指纹不匹配 → `replayOrConflict` `:234-236` 抛 `SHARE_IDEMPOTENCY_CONFLICT`,而不是重放。Owner 看到的是「冲突」而非「你的分享已经建好了」。窗口 ≤24h、影响面 = 恰好跨越部署时刻的创建重试。AC-CAP-14 定义的恢复流程(引导 revoke/delete 后重建)覆盖不到这个形状。

### 4.2 四条 W0 双写用例会被 T-12 打破

**这是本报告第二要紧的发现。** `mail-share-service.spec.js:463-527`(行号在 `3cce543` 之后未变)有四条 W0 落的 `syncPrimaryAccountId` 用例,它们全部建立在一个**在 T-12 之后不再成立**的前提上:「`create()` 不写 binding 行」。

| 用例 | 位置 | T-12 后为什么红 |
|---|---|---|
| `syncs the primary account_id to the smallest binding_id account` | `:463-474` | `:466` 手工 `insertBinding(shareId, ACC_A)`;create 已经为 ACC_A 建了 binding → **UNIQUE 冲突抛错** |
| `follows the surviving primary binding after the first one is removed` | `:476-486` | `:479` 同上,同样 UNIQUE 冲突 |
| `never writes 0 when the share has no usable binding left` | `:488-497` | 前提「create 后无 binding」消失;`:495` `expect(meta.changes).toBe(0)` 变成 1 |
| `is one conditional UPDATE that composes into a single db.batch` | `:499-527` | `:502` 只加了 ACC_C,但 create 已建 ACC_A 的 binding 且 `binding_id` 更小 → `:526` 期望 `ACC_C` 实得 `ACC_A` |

**实测取证**(`f92d9a5` 的一次性 clone `/tmp/headbase`,探针与 clone 均已删):

```
✓ test/zz-probe.spec.js (1 test) 21ms
  duplicate binding rejected; sync UPDATE still reports changes=1 on an unchanged value
```

探针同时证实了两件事:① `idx_msb_share_account`(`init.js:74`)会对重复 `(share_id, account_id)` 抛 `UNIQUE constraint failed`;② `syncPrimaryAccountId` 的条件 UPDATE 在**值没变**时 `meta.changes` 依然是 1(SQLite 按 WHERE 命中行计数,不按值是否变化)—— 所以 `:495` 的 `toBe(0)` 一定会红。

**处置建议**:这四条改成用 `seedShareRow` + `seedBindingRow`(`test/setup.js:75/122`)自造行,不经过 `create()`。`:529-551` 那条「syncs a seeded v3_2DB-shaped row that never went through create」已经是这个写法,**照抄它就行**,是现成的正确模板。

⚠️ 这件事撞到 `test/setup.js:23-24` 的基线守恒规则:「单邮箱旧断言只允许扩展,不允许改写」。这四条不是单邮箱旧断言(它们是 W0 新落的),但形式上仍是改写既有用例。**建议派单时显式授权**,别让执行者停在这里问(§6-R6)。

### 4.3 文件冲突图

「W0 修复」= `3cce543`、「T-06」= `6209960`,**两者都已入库**,所以下表左两列现在是历史,只用于说明 T-12 会踩在谁的成果上。

| 文件 | W0 修复(`3cce543`,已入库) | T-06(`6209960`,已入库) | **T-12** | T-13(其后) | 判定 |
|---|---|---|---|---|---|
| `src/service/mail-share-service.js` | `:73-83` `logShareEvent` 信封顺序(+1 行注释,整体下移后续行号) | 只读 import,零改动 | **重写 `:106-113` / `:120-122` / `:156-162` / `:194-226` / `:239-359` / `:362-423`** | 新增 bindings 变更方法 | 🟢 **已释放**,T-12 可独占。与 T-13 严格串行(tasks.md:26) |
| `src/api/mail-share-api.js` | 零 | 零 | **建议零**(§1.3) | 新增 `PUT /mailShare/bindings` | 🟢 T-12 不占写权即无冲突 |
| `src/service/share-auth-service.js` | 零 | 重写 `:249-285` 区 + 新增 import(+62-21) | **只读**(`digestShareSecret` / `effectiveStatus`) | 零 | 🟢 单向只读;T-07/T-08 接手该文件,与 T-12 无重叠 |
| `test/mail-share-service.spec.js` | `:557-593` `:712-730` 新增 18 条 | 零 | **同 describe 内大量新增 + 改写 `:463-527`** | 追加 bindings 用例 | 🟢 已释放;与 T-13 同一 `describe` 块,串行 |
| `test/setup.js` | `:60-64` `isRowId` + `:105`/`:123` 调用 | 零 | 可能加 `seedAccountRow` 之类 | 可能 | 🟢 已释放;能不动就不动 |
| `test/share-auth-service.spec.js` | 零 | +420-21 | 零 | 零 | 🟢 |
| `src/init/init.js` | 零 | 零 | **零**(T-01 单 owner) | 零 | 🟢 只读 |
| `test/mail-share.schema.spec.js` | 零 | 零 | **零**(护栏,只被动满足) | 零 | 🟢 |
| `package.json` / `pnpm-lock.yaml` | 零 | 零 | **零** | 零 | 🟢 T-12 不需要新依赖 |

**会被误伤的既有护栏**(T-12 必须知道):

| 护栏 | 位置 | T-12 会不会踩 |
|---|---|---|
| `share_type` 无列 | `mail-share.schema.spec.js:69` | 不会,只要不建列 |
| `mail_share.account_id` NOT NULL | `:153-155` | ⚠️ **会**,如果 insert 不给 `account_id` 初值。Step 5.2 已处置 |
| `row.accountId` 读取数冻结为 4 | `:142-147`,正则只扫 `share-auth-service.js` 与 `share-scoped-email-repository.js` | **不会** —— 正则的扫描对象里**没有** `mail-share-service.js`。该文件 `:428` 已在用 `ms.account_id`,是合法的 |
| AC-LEAK-05 日志不含 sec | `mail-share-service.spec.js:599-615` | ⚠️ **会**,如果为 AuthKey 加了任何 `console.log`。**AuthKey 明文一个字符都不许进日志**,`logShareEvent` 的注释(`:71-72`)已明文禁止 |
| `logShareEvent` 信封不可被诊断字段覆盖 | `mail-share-service.spec.js:712-730`(`3cce543` 落) | 不会,只要不改 `logShareEvent` |

---

## 5. T-12 能否先于 T-08 起跑 —— **能(yes)**

### 5.1 证据

1. **create 根本不消费 ShareContext**。ShareContext 是 `resolveSession` 的返回形状(`share-auth-service.js:345-350`),服务的是访客读路径。`mail-share-service.js` 从 `share-auth-service` 只取两样东西:`digestShareSecret`(`:404`,纯 HMAC 工具)与 `effectiveStatus`(`:175`,在 `projectOwnerRow` 里,归 list 用,T-12 不碰)。两者都不在 T-08 的冻结契约里。
2. **charter 已经明文允许**。`tasks.md:163` W2 标题:「文件不冲突时 T-10/T-12 可与 W1 后半并行起跑」;`tasks.md:297-298` 波次定义里同一句话再说一遍。
3. **前一份侦察已经关掉了这道门**。`recon-w1-t06-quota-gate.md:497`:「T-12 ✅ **现在可以了** …… 该阻塞已解除:W0 全部 commit 于 `e878760`」;§7.3 第 5 条与 §10 第 8 条重复确认。
4. **写路径与读路径在数据上不交叉**。T-12 只写 `mail_share` / `mail_share_binding` / `share_idempotency`;T-08 只读。T-08 冻结 ShareContext 之后由 T-10/T-11 消费,与 create 无耦合。

### 5.2 唯一的软依赖:AuthKey 摘要口径必须两侧同源

T-12 在 create 时写 `auth_key_hash` / `auth_key_kid`,T-08 在 establish 时校验。两侧必须用同一个 pepper 与同一个 kid 约定,否则 T-08 落地当天所有 T-12 建的 AuthKey 分享全部验不过。

design.md:156 只写了 `HMAC-SHA256(authKey, PEPPER[auth_key_kid])`,**没说 `PEPPER` 从哪个环境变量来**。仓内目前只有 `SHARE_SEC_PEPPER` / `SHARE_SEC_PEPPER_KID` 一对(`wrangler-vitest.toml:35-36`)。

**处置(不阻塞起跑)**:T-12 复用 `SHARE_SEC_PEPPER` + `auth_key_kid = SHARE_SEC_PEPPER_KID`,在代码里写一行契约注释,并在 `mail-share.schema.spec.js` 或 service spec 里落一条断言把这个口径钉住,作为交给 T-08 的输入。同时报给主 AI 追认(§6-R5)。

### 5.3 真正的硬前置(只有一条,**已关闭**)

原本唯一的硬前置是「`mail-share-service.js` 的 W0 修复必须先 commit」—— 那是文件占用问题,不是依赖问题。侦察收尾时它已入库为 `3cce543`,工作树干净。**T-12 现在可以立即起跑。**

---

## 6. 会逼改 spec / 需要上报的风险

> 按「必须停下上报」→「执行者可自裁但要记录」排序。前三条建议在派单前裁掉。

### R1 · [P0 · spec 自相矛盾] `refreshIntervalMs` 到底是拒绝还是钳制

四处说法打架:

| 出处 | 原文 | 行为 |
|---|---|---|
| AC-CAP-06(`requirements.md:60`) | 「IF `refreshIntervalMs` 小于 3000, THEN …… 拒绝并返回 `SHARE_INVALID_CONFIG`」 | **拒绝** |
| AC-OTP-06(`requirements.md:142`) | 「服务端强制 `>= 3000`;IF 存量数据或请求给出更小值, THEN 下发给访客的配置 SHALL 被钳制为 3000」 | **钳制** |
| design.md:153 | `-- 写入前钳 >=3000` | 钳制 |
| design.md:102 | 「服务端写入与下发**双侧**钳制 ≥3000」 | 钳制 |
| tasks.md T-12.1(`:186`) | 「`refreshIntervalMs=2999` → `SHARE_INVALID_CONFIG`」 | 拒绝 |
| tasks.md T-12.2(`:188`) | 「取值域校验(`refresh_interval_ms` 钳 ≥3000)」 | 钳制 |

**同一个任务的红灯说拒绝、绿灯说钳制。** 建议裁决:**create 写入侧拒绝(AC-CAP-06 是 create 的 AC,且 tasks 红灯已这么写),下发侧钳制(AC-OTP-06 服务存量数据,属 T-08 session 响应)**。两者不矛盾,只是 spec 措辞把「写入侧」和「下发侧」混成了一句。请主 AI 一句话追认,别让执行者自裁。

### R2 · [P0 · spec 覆盖缺口] 新建行的主表 `window_start_email_id` 写什么

design.md:161 把主表 `window_start_email_id` 定为「迁移遗留只读」,AC-LIFE-10 的双写义务**只覆盖 `account_id`**。

但当前(= 滚动窗口里的「旧 Worker」)读路径实测在读它:`share-auth-service.js:348`(@`6209960`)`windowStartEmailId: row.windowStartEmailId` → `share-scoped-email-repository.js:26,64` `gt(email.emailId, scope.windowStartEmailId)`。

后果:T-12 若不写主表这一列,新建分享该列取 DDL 默认 0 → 兼容窗口内路由到旧 Worker 的访客请求,窗口下界变成 0 → **`only_messages_after_created=true` 的分享会把创建之前的全部历史邮件放出去**。这不是降级,是越权读。

- 严重度:高(泄露),窗口:滚动发布期,触发概率:随机路由,必然发生。
- 现有代码本来就在写它(`:248`),所以**修法极简:主 Binding 的快照值同时写进主表**。
- 但这需要把 AC-LIFE-10 的双写清单从「`account_id`」扩到「`account_id` + `window_start_email_id`」,并改 design.md:161 的「只读」定性 —— **这是 spec 改动,必须上报,不许执行者自己顺手加**。

### R3 · [P1 · spec 覆盖缺口] 栅栏清单漏了三个「旧 Worker 无法执行的策略」

AC-LIFE-11 的四条栅栏覆盖 multi / 1→N / AuthKey / 有限配额。但按同一条推理(「旧 Worker 不认识这些列 → 落到旧 Worker 就是策略降级」),下列字段同样合格:

| 字段 | V2=false 下若允许写非默认值,旧 Worker 的行为 |
|---|---|
| `message_limit = N` | 不认识 → 返回超出最新 N 封的邮件(可见集变宽) |
| `only_messages_after_created = false` | 与 R2 是同一个坑的另一面 |
| `show_full_address = 1` | 不认识 → 掩码策略在旧 Worker 上恒为「不掩码」(此项方向相反,是**收紧**失效,严重度低) |

`message_limit` 这一条与 multi/AuthKey/配额是同构风险,却不在栅栏内。两种处置:① 扩栅栏(改 AC-LIFE-11,成本高);② 明确裁决「V2=false 时这些字段只接受默认值」(等价于扩栅栏但不改 AC 编号);③ 接受该风险并记入 Decision Record。**建议②或③,由主 AI 裁,T-12 执行者不自裁。**

### R4 · [P1] AC-CAP-03 的「零残留」与错误码可区分性是一对张力

D1 无事务回滚,零残留只能靠「把归属条件塞进写语句的 WHERE」实现;但那样 `changes=0` 就丢失了失败原因。§2 Step 4 + Step 6 给的是「预检定错误码 + 写入侧条件保原子性 + 事后消歧」三件套。这不是绕法,是仓内既有模式(`replayOrConflict` 同款),但**多一次查询往返**。若主 AI 认为 create 路径不该多一次往返,需要另裁。

### R5 · [P1] AuthKey 的 pepper 与 kid 来源未定义

见 §5.2。建议裁「复用 `SHARE_SEC_PEPPER` / `SHARE_SEC_PEPPER_KID`」并落断言。若要独立 pepper,需要新增环境变量 → 动 `wrangler*.toml`(T-01/T-03 的地盘)+ 部署清单,成本明显更高。

### R6 · [P1] 两条需要显式授权的「改写既有用例」

- **R6a**:`mail-share-service.spec.js:463-527` 四条 W0 双写用例必须改写(§4.2 已实测)。与 `test/setup.js:23-24` 的「旧断言只扩展不改写」规则形式冲突,需授权。
- **R6b**:`accountId` 与 `accountIds` 同时出现时的优先级,spec 未定义。建议裁「`accountIds` 优先」(前端升级期间旧代码只发 `accountId`,新代码只发 `accountIds`,同时发只可能是 bug)。

### R7 · [P2] 幂等指纹跨部署 24h 窗口

见 §4.1 末段。建议:记入 Decision Record,不改 spec。若要消除,得给指纹加版本前缀并在读侧兼容两代 —— 为一个 24 小时窗口不值得。

### R8 · [P2] 51 个 accountId 的红灯用例需要 51 个真实 account 行

T-12.1 要求「51 个 accountId → `SHARE_BINDING_LIMIT_EXCEEDED`」。按 §3.3 的顺序(上限校验在归属查询之前),这条用例**不需要真的建 51 个 account**,传 51 个不存在的 ID 也应先撞上限。这是采用「上限在前」顺序的一个额外好处,值得在用例注释里写明,免得后人以为是漏测。

---

## 7. 执行者拆分建议

### 7.1 结论:**本波次 `mail-share-service.js` 只派一个人,T-12 与 T-13 由同一人串行做完。**

三条理由:

1. **tasks.md:26 已经是这么规定的**(「W2:T-12→T-13 串行」),分给两个人只是把串行约束从人内搬到人间,徒增交接成本。
2. **T-12 与 T-13 共享大量实现**:条件 `INSERT ... SELECT`(AC-BIND-10 与 AC-CAP-07 是同一条语句的两种参数化)、`syncPrimaryAccountId` 接线、`SHARE_BINDING_LIMIT` 计数、「删空转 REVOKED」的对偶。第二个人要把第一个人的语句从头读一遍才能改。
3. **T-12 本身不可再分**。红灯(T-12.1)与绿灯(T-12.2)是 TDD 的两半,拆给两个人 = 红灯作者猜绿灯作者的函数签名。

### 7.2 T-12 白名单(除此之外一律不许动)

| 文件 | 权限 |
|---|---|
| `mail-worker/src/service/mail-share-service.js` | **写**(本波次独占) |
| `mail-worker/test/mail-share-service.spec.js` | **写**(含 §4.2 的四条改写) |
| `mail-worker/test/setup.js` | 写(仅在确需新 seed 助手时;能不动就不动) |
| `mail-worker/src/api/mail-share-api.js` | 建议**零改动**(§1.3);若确需,只许动 `:23-28` |
| 其余一切 | **只读** |

明确禁止:`init.js`(T-01)、`share-auth-service.js`(T-06/T-08)、`mail-share.schema.spec.js`(护栏)、`package.json` / `pnpm-lock.yaml`、`mail-vue/**`(W4)。

### 7.3 起跑前置清单(主 AI 逐条打勾再派)

1. ☑ W0 `logShareEvent` + `test/setup.js` 修复已 commit(`3cce543`),`mail-share-service.js` 工作树干净 —— **侦察收尾时已自动关闭**
2. ☐ R1(`refreshIntervalMs` 拒绝 vs 钳制)已裁
3. ☐ R2(主表 `window_start_email_id` 是否纳入双写)已裁 —— **这条不裁就派,等于明知有泄露路径还放行**
4. ☐ R3(`message_limit` 等是否进栅栏)已裁或已明确接受
5. ☐ R6a(授权改写四条 W0 双写用例)已授权
6. ☐ R5(AuthKey pepper 口径)已裁,并说明要不要落断言交给 T-08

剩下 5 条建议一次性裁完再派,单条追问的往返成本远高于一次性裁决。

### 7.4 T-12 期间的并行位

| 任务 | 可并行? | 依据 |
|---|---|---|
| **T-07 / T-08**(`share-auth-service.js`) | ✅ | 与 T-12 白名单零重叠,单向只读。T-06 已于 `6209960` 落地,W1 后半可与 T-12 同时跑 |
| **T-10**(`share-scoped-email-repository.js`) | ✅ 有条件 | 与 T-12 白名单零重叠;前置条件见 `recon-w1-auth-chain.md` §7.3(未变) |
| **T-13** | ❌ | 同文件,tasks.md:26 强制串行 |
| **T-14**(`share-api.js` + `security.js`) | ❌ | W1 仍占 `share-api.js`(tasks.md:24) |
| **T-11 / T-15 / T-16 / T-18** | ❌ | T-11 依赖 T-10;后三者同占 `mail-share-service.js` |

### 7.5 工作包表

| 包 | 内容 | 产出 | 验收命令 |
|---|---|---|---|
| T-12.1 红 | `mail-share-service.spec.js` 新增 9 组用例(多邮箱建行 / `shareType` 派生 / 混入他人或已删 accountId 零残留 / 51 个上限 / `refreshIntervalMs=2999` / per-binding window 双态 / AuthKey 明文恰一次 / 指纹含新字段与排序 accountIds / 旧单值载荷默认值创建)+ 改写 `:463-527` 四条 | 红灯 EXIT=1 | `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js` |
| T-12.2 绿 | §2 Step 1-7 | 绿灯 EXIT=0 | 同上 |
| T-12 收口 | 全量 + schema 护栏 | **≥ 213 tests / 17 files,EXIT=0**(只增不减) | `pnpm --dir mail-worker test` |

**收口口径特别说明**:213 是侦察收尾时在 `6209960` 上实测的数字(17 files / 213 tests / EXIT=0)。派单基线 `f92d9a5` 是 185,两次之差 = `3cce543` 的 +18 与 `6209960` 的 +10。T-07/T-08 若在 T-12 期间并行落地还会继续推高,**起跑当天重新取一次基线,别把 213 当固定值**。`test/setup.js:18-24` 记的历史地板(worker 138)才是「只增不减」的绝对底线。

---

## 8. 链路完整性扫描(T-12 交付契约)

| AC | 落在 §2 的哪一步 | 有对应红灯? |
|---|---|---|
| AC-CAP-01(share 行 + N binding 行 + URL) | Step 5.2 + 5.3 + Step 7 | ✅ |
| AC-CAP-02(`shareType` 实时派生,不落库) | Step 7 + Step 8.3 | ✅(含扫表断言无 `share_type` 列) |
| AC-CAP-03(任一非法 accountId → 整单拒零残留) | Step 4 + Step 5.2 的 COUNT 谓词 | ✅ |
| AC-CAP-04(lid/sec 规格) | 现状 `:399-400` 不变 | ✅ 既有 `:154-179` |
| AC-CAP-05(AuthKey 22 字符 / 只存 hash+kid / 明文一次) | Step 1 末 + Step 5.2 + Step 7 | ✅ |
| AC-CAP-06(配置取值域 + `refreshIntervalMs`) | Step 2 | ✅(⚠️ R1) |
| AC-CAP-07(true → per-binding 原子快照) | Step 5.3 的 `CASE WHEN` | ✅ |
| AC-CAP-08(false → 写 0) | 同上 `ELSE 0` | ✅ |
| AC-CAP-09(指纹含新字段 + 排序 accountIds) | Step 1 + §4.1 | ✅ |
| AC-CAP-10(旧单值载荷默认值创建) | Step 1 的回落 | ✅ |
| AC-CAP-13(50 上限整单拒) | Step 2.2 | ✅ |
| AC-CAP-14(重放无明文) | Step 7 的 `replayFromIdempotency` | ✅ |
| AC-OTP-06(≥3000) | Step 2.3 | ⚠️ R1 未裁前口径未定 |
| AC-LIFE-10(双写主 Binding) | Step 5.4 | ✅(⚠️ R2 覆盖缺口) |
| AC-LIFE-11(三类意图门控) | Step 3 | ✅(⚠️ R3 覆盖缺口) |

**T-12 不承诺**:`PUT /mailShare/bindings`(T-13)、list 投影改造(T-15)、级联撤销经 Binding(T-16/T-18)、ShareContext 消费(T-08/T-10)、前端载荷升级(T-20/T-23)。

---

## 9. Domain-Model 对账

`docs/domain/` 仍不存在(与 `recon-w1-t06-quota-gate.md:539` 结论一致)。本 charter 的 `design.md` 承担 domain-model 职责:Binding 语义在 Decision 1(`:90`)、Decision 15(`:104`)、Data Models(`:163-179`)、迁移/发布协议(`:217-230`)四处,彼此一致,与 `requirements.md` AC-CAP-01/02/03/13 与 AC-BIND-01/07/10 无冲突。**唯一的 model 级缺口是 R2**(主表 `window_start_email_id` 的双写定性),它同时缺在 design 与 requirements,不是实现层能补的。

---

## Update Log

- 2026-08-24 · recon 执行者:首次落盘。派单基线 HEAD `f92d9a5`(干净 clone 全量 17 files / 185 tests EXIT=0),**收尾基线 HEAD `6209960`(17 files / 213 tests EXIT=0)**。侦察期间两个并行写者先后落地:`3cce543`(W0 `logShareEvent` 信封顺序 + seed ID 收紧)与 `6209960`(T-06 配额闸门);全部行号已换算到 `6209960`,`mail-share-service.js` 现已释放。实测取证两条:`idx_msb_share_account` 对重复 binding 抛 UNIQUE、`syncPrimaryAccountId` 在值未变时 `meta.changes=1` —— 二者共同证明 `mail-share-service.spec.js:463-527` 四条 W0 用例会被 T-12 打破(§4.2)。发现两条 spec 级缺口:R1(`refreshIntervalMs` 拒绝 vs 钳制,同一任务红绿灯自相矛盾)、R2(新建行主表 `window_start_email_id` 不双写 → 滚动窗口内旧 Worker 窗口下界为 0 的越权读)。结论:T-12 可先于 T-08 起跑,唯一硬前置(等 `mail-share-service.js` 释放)已于侦察收尾时自动关闭,**现在即可派单**。
