# T-20c · 分享凭据链路的安全护栏（执行记录）

**成功状态（逐字抄自交付契约，未改写）**

> NOT「又加了几条测试」, BUT 未来某个人在改分享凭据这条链路时,如果他不小心把明文写进了库、把解密端点的鉴权拆了、或者顺手把 AuthKey 也变成可恢复的,CI 会当场拦住他 —— 而不是等到某次安全审计或事故才发现。
> 不该发生: 护栏本身是空过的(功能被破坏时它仍然绿)· 与既有测试重复造第二套。
> 来源: 决策卡 §1.4「⚠️ 安全护栏会自动让路」+ T-20c

**交付**：`mail-worker/test/share-credential-guards.spec.js`（新增，8 用例）
**生产代码**：未改动（`git diff --stat -- mail-worker/src` 在开工前后逐项相同）
**测试**：`pnpm --dir mail-worker test` → **20 files / 752 passed**（基线 19 / 744，+1 文件 / +8 用例，无减少）

---

## 1. 既有覆盖盘点（已覆盖 / 弱覆盖 / 未覆盖）

先把 `mail-worker/test/` 下与三条性质相关的既有断言找齐，再判断哪些是真的钉住了。

### 护栏 ① 解密端点的鉴权不可被拆

| 结论 | 断言 | 位置 |
|---|---|---|
| ✅ 已覆盖 | `POST /mailShare/revealSec` 无 JWT → 401；无 `share:manage` → 403 `SHARE_FORBIDDEN`；有权限 → 非 403/401 | `security-share.spec.js:212-231`（`OWNER_ENDPOINTS` 含 revealSec） |
| ✅ 已覆盖 | 访客 session token 打 owner 路由 → 401，死在签名环上 | `security-share.spec.js:242-248` |
| ✅ 已覆盖 | 前缀近似路径（`/mailShare/revealSecX` 等）→ 404 而非落进 perm 分支 | `security-share.spec.js:306-329` |
| ✅ 已覆盖 | 服务层归属：他人分享 / 不存在 / 畸形 shareId 共用 `SHARE_NOT_FOUND`，且被拒调用留 `denied` 审计 | `mail-share-service.spec.js:4344-4356, 4481-4489` |
| ✅ 已覆盖 | HTTP 层越权同码 | `mail-share-service.spec.js:4573-4580` |
| ⚠️ 弱覆盖 | `AC-ADMIN-10`（`security-share.spec.js:233`）比的是「API 文件声明的路由 vs **测试自己的常量表** `OWNER_ENDPOINTS`」。`security.js` 里 `requirePermsExact` 与 `premKey['share:manage']` **两张表之间**没有任何单点断言 —— 它们的 lockstep 只被逐端点的行为断言间接覆盖，新增一条 `/mailShare` 路由时没有任何东西提醒「这两张表也要登记」 | — |
| ❌ 未覆盖 | 明文凭据的**出口棘轮**：没有断言说「普通 owner 读接口（get / list）不得回明文 `sec` / `authKey`」。既有的 `mail-share-service.spec.js:4252-4258` 只扫了 `sec_cipher` / `secCipher` / `kekKid` / `sec_hmac`，明文 `sec` 与 `authKey` 都不在针里 | — |

### 护栏 ② KEK 缺失时 fail-closed 不可被降级

| 结论 | 断言 | 位置 |
|---|---|---|
| ✅ 已覆盖 | create 缺 KEK → 零行落库（share / binding / idempotency 三表各自计数） | `mail-share-service.spec.js:4153-4174` |
| ✅ 已覆盖 | regenerate 缺 KEK → 每一列原样不动 | `mail-share-service.spec.js:4176-4192` |
| ✅ 已覆盖 | **探测前置**：幂等重放在缺 KEK 时同样被拒（这条是上一包变异后补的，正是唯一能把「探测前置」与「铸造点自己抛」分开的缝） | `mail-share-service.spec.js:4198-4226` |
| ✅ 已覆盖 | 读取端 `kek_missing` → `SHARE_SEC_UNAVAILABLE` + `alert: true`，且 ≠ `SHARE_SEC_ABSENT`；四码互不相等 | `mail-share-service.spec.js:4374-4388, 4441-4459` |
| ⚠️ 弱覆盖 | 创建端的既有断言是 `rejects.toThrow(/kek/i)`。**把裸 `Error` 换成 `BizError('SHARE_SEC_ABSENT kek missing')`，这条依然绿** —— 而 BizError 会被 `withShare` 翻成 200 + 业务码，一次部署事故就长得像「这条分享有点问题」。变异已实测（见 §3 · M3） | — |
| ❌ 未覆盖 | `REVEAL_FAILURE` 映射表的**完备性**：解密模块将来多一种失败原因时，没有任何东西逼人回来分类，它会静默落进 `REVEAL_UNKNOWN_FAILURE` | — |

### 护栏 ③ AuthKey 仍不可恢复

| 结论 | 断言 | 位置 |
|---|---|---|
| ✅ 已覆盖 | 库里只有 `auth_key_hash` + `auth_key_kid`，值等于 `digestShareSecret(authKey, pepper)`；`disable` 清空 | `mail-share-service.spec.js:3382-3387, 3435-3441` |
| ✅ 已覆盖 | 一次全库明文扫描（`databaseContains(created.authKey)`） | `mail-share-service.spec.js:4237` |
| ⚠️ 弱覆盖 | 列名守卫是**黑名单两个名字**（`auth_key_cipher` / `auth_key_encrypted`，`mail-share.schema.spec.js:65-71`）。叫 `auth_key_envelope` / `auth_key_recoverable` 就整条溜过去。变异已实测（§3 · M5） | — |
| ⚠️ 弱覆盖 | 同一条只查 drizzle entity。**迁移 DDL 加了列但 entity 没同步**时它全绿 —— 而库里真实的样子由 `init.js` 的 `v3_2DB` 决定。变异已实测（§3 · M5b） | — |
| ❌ 未覆盖 | 密文感知：**持有 KEK 时库里有没有任何一个信封解得出 AuthKey**。「顺手把 AuthKey 也加密了」这件事，明文扫描与列名黑名单都看不见 | — |

### 护栏 ④ 密文感知的泄漏扫描

| 结论 | 断言 | 位置 |
|---|---|---|
| ✅ 已覆盖 | 明文 `sec` 不出现在任何表的任何列（`databaseContains` 逐表 `SELECT *`；`share-integration.spec.js:248-267` 是 SQL `instr` 版本） | `mail-share-service.spec.js:3807-3819` |
| ❌ 未覆盖 | **拿到整库但没有 KEK 时 `sec` 不可还原** —— 本轮交出去的安全性质，此前没有任何断言表达 |
| ❌ 未覆盖 | **无密钥可逆编码旁路**：把 AES 信封换成 base64 / base64url / hex，既有明文子串扫描全绿，而它其实零保护 |

---

## 2. 本轮新增的护栏（8 条）

全部落在 `mail-worker/test/share-credential-guards.spec.js`，只补上表里 ⚠️ 与 ❌ 的格子，不重造 ✅ 的部分。

| # | 用例 | 补的是哪一格 |
|---|---|---|
| 1 | `keeps requirePermsExact, the share:manage grant list and the declared routes in lockstep` | ①⚠️ 两张表之间无单点断言 |
| 2 | `never hands the credential out through the ordinary owner read surface` | ①❌ 明文出口棘轮（含正对照：同一个针在 revealSec 响应里找得到） |
| 3 | `refuses to create with a non-business error, so no self-service code can absorb it` | ②⚠️ `/kek/i` 对 BizError 一样绿 |
| 4 | `classifies every cipher failure reason explicitly, so a new one cannot default to benign` | ②❌ 映射表完备性（枚举从加密模块真取，不抄常量） |
| 5 | `allows exactly three auth-key columns, in the entity and in the live table` | ③⚠️×2 黑名单→正向白名单、entity→活表 |
| 6 | `leaves no recoverable copy of the AuthKey anywhere in the database` | ③❌ 密文感知 |
| 7 | `opens under the right ring and stays shut under no ring and a wrong ring` | ④❌×2 无 KEK 不可还原 + 无密钥编码旁路 |
| 8 | `keeps the same property across a regenerate, for both the old and the new sec` | ④❌ 轮换后旧 sec 连持钥人也取不回 |

**三环对照实验**（用例 7 / 8 的骨架，也是「护栏不空过」的核心机制）：

- **正确环** → 必须**解得开**。没有这一条，下面两条「解不开」在扫描器根本没看到那一列时也成立。
- **空环**（无 KEK）→ 必须解不开。这是攻击者拿到整库导出的形状。
- **错环**（kid 对、材料错）→ 必须解不开。它把「保护来自密钥」和「保护来自格式」分开：只有它是活的，才说明真的走到了 GCM tag 校验。

---

## 3. 变异证据（每条护栏都破坏一次被保护的性质，确认变红）

方法：破坏性质 → 只跑相关用例 → 确认红 → 还原 → 确认绿。生产代码的每次改动都用逐字反向替换还原，收尾以 `git diff --stat -- mail-worker/src` 与开工前逐项比对确认无残留。

| ID | 变异内容 | 手段 | 结果 |
|---|---|---|---|
| M1 | 从 `security.js` 的 `premKey['share:manage']` 删掉 `/mailShare/revealSec` | 生产码（已还原） | 🔴 用例 1 `expected Set{…(8)} to deeply equal Set{…(9)}` |
| M2 | 让 `mailShareService.get` 顺手解密并回一个 `sec` 字段 | 生产码（已还原） | 🔴 用例 2 `expected [ 'get', true ] to deeply equal [ 'get', false ]` |
| M3 | `assertKekConfigured` 的裸 `Error` 换成 `BizError('SHARE_SEC_ABSENT kek missing')` | 生产码（已还原） | 🔴 用例 3 `expected 'BizError' not to be 'BizError'`。**同一次变异下既有的 `refuses to create at all when no KEK is configured, leaving zero rows behind` 仍然 ✓ 绿** —— 这就是那格 ⚠️ 弱覆盖的直接取证 |
| M4 | 从 `REVEAL_FAILURE` 删掉 `MALFORMED` 一行 | 生产码（已还原） | 🔴 用例 4 `expected [ 'MALFORMED', false ] to deeply equal [ 'MALFORMED', true ]` |
| M5 | 给 drizzle entity 加一列 `authKeyEnvelope: text('auth_key_envelope')` | 生产码（已还原） | 🔴 用例 5（entity 半边） |
| M5b | 只给 `init.js` 的 `v3_2DB` 加 `ALTER TABLE mail_share ADD COLUMN auth_key_envelope TEXT`，**entity 不动** | 生产码（已还原） | 🔴 用例 5（活表半边独立成立） |
| M6 | 把 AuthKey 用当前 KEK 加密后写进 `mail_share.remark`（模拟「顺手把 AuthKey 也加密了」） | 测试副本注入，零生产改动 | 🔴 用例 6 `expected 'mail_share.remark (lid=RAIhnYt3c9wLjD…' to be null` |
| M7 | 把 `btoa(sec)` 写进 `mail_share.remark`（模拟「把 AES 换成 base64」） | 测试副本注入，零生产改动 | 🔴 用例 7 `expected 'mail_share.remark (keyless-decodable)' to be null`。**这正是既有明文子串扫描会放过的形状** |
| M8 | 把 `NO_RING` 改成等于正确环 | 测试副本 | 🔴 用例 7、8（证明「空环解不开」不是空过） |
| M9 | 把 `WRONG_RING` 改成等于正确环 | 测试副本 | 🔴 用例 7、8（证明「错环解不开」不是空过） |

M8 / M9 是专门针对本包自身的反空过检查：它们确认「解不开」那三条断言在密钥真的对上时会变红，而不是因为扫描器压根没找到那一列而恒真。

还原验证：`git diff --stat -- mail-worker/src` 开工前后一致（`mail-share-api.js 58` / `entity 8` / `init.js 24` / `security.js 8` / `mail-share-service.js 304` / `share-auth-service.js 19` / `share-event.js 3`），临时变异副本 `test/_mut.spec.js` 已删除。

---

## 4. Review Findings（对派发任务的核对与偏差）

- **无方向性偏差**。任务描述里的三条性质、`share-integration.spec.js:248-267` 的全库明文扫描位置、决策卡 §1.4 的「护栏自动让路」判断，逐条与真实代码核对后全部成立。
- **一处描述需要收窄**：任务写「现有的安全护栏对本轮加密改动是自动让路的」。这在**泄漏扫描**这一维成立（明文子串扫描对密文无效，已确认），但在**鉴权**与**KEK fail-closed** 两维上，W-D 前几包留下的断言其实相当扎实（见 §1 的 ✅ 行）。所以本包实际补的是「两条弱覆盖 + 四个真空格」，而不是三条从零起的护栏。这点在 §1 三分表里如实标出，没有把已覆盖的重算成本包产出。
- **未改生产代码**。三条性质全部可以从外部断言：鉴权表与失败映射表走 `?raw` 源码文本（不需要为了测试而导出内部常量），密文性质走真实 D1 + 真实 `decryptShareSec`。
- **跨域触碰**：无。`mail-vue/` / `share-sec-cipher.js` / `keyed-secret-ring.js` 一律未动；对生产代码的改动全部是变异验证的临时改动并已逐字还原。

---

## 5. 残留风险（诚实列出，不凑「全覆盖」）

1. **KEK 缺失在 HTTP 面上仍然回 200**。`hono.js:28` 的 `onError` 把任何非 BizError 也翻成 `c.json(result.fail(err.message, err.code))` —— 状态码 200、body 里带原始英文 message（`share create sec kek missing`）。fail-closed 的**行为**是对的（零行落库），但**外观**不像 500，也顺带把内部信息吐给了调用方。本包只钉住了「抛的不是 BizError」这条服务层性质，没有动 `onError`（那是全局错误面，超出本包范围且会影响所有接口）。**建议单独立项**。
2. **密文感知扫描只覆盖 `v1:` 前缀的信封**。有人用一套完全不同的自研格式存可恢复副本时，AES 解密扫描够不着它；只有当那套格式恰好是 base64 / base64url / hex 之一，无密钥解码扫描才拦得住。真正通用的做法（对全库做熵分析 / 尝试所有已知密钥的所有 KDF 组合）代价与误报都不成比例，本包没做。
3. **无密钥编码扫描只试三种**（base64 / base64url / hex）。ROT13、URL-encode、gzip+base64、逐字符异或之类不在内。取这三种是因为它们是「随手换个编码就当加密了」的实际高频形态。
4. **`storesPlaintext` 是子串匹配**。把 `sec` 拆成两列分开存（前半 + 后半）能绕过它。这类切分式泄漏没有便宜的通用检测手段。
5. **鉴权表的 lockstep 靠源码正则解析**。`security.js` 里两张表的写法一旦大改（例如改成从数组生成），正则会解析出空集。用例里放了一条 `expect(declared).toContain('POST /mailShare/revealSec')` 作为解析活性检查，能挡住「API 那侧解析失效」，但挡不住「`security.js` 那侧解析失效同时两张表都被改坏」这种同时失效的组合。更稳的做法是把两张表从 `security.js` 导出、直接 import 断言 —— 那需要改生产代码，按约束留给后续决定。
6. **本包不覆盖运行时的密钥轮换实操**（prev 环退役时机、kid 冲突的运维流程）。护栏只钉「当前环 + 错环」的密码学性质。

---

## Update Log

- **2026-08-25 · executor（T-20c）**：新增 `mail-worker/test/share-credential-guards.spec.js`（8 用例），补齐鉴权表 lockstep、KEK fail-closed 不得降级为业务码、`REVEAL_FAILURE` 完备性、AuthKey 列名正向白名单 + 活表校验 + 密文感知扫描、以及三环对照的密文感知泄漏扫描。10 次变异（M1–M9，含 M5b）全部实测变红并还原；其中 M3 同时证实既有 `rejects.toThrow(/kek/i)` 断言对 BizError 降级是空过的。生产代码零改动。`pnpm --dir mail-worker test` → 20 files / 752 passed（基线 19 / 744）。未提交。
