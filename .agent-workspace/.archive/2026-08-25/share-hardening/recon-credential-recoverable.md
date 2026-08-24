# 侦察报告 · Owner 可重复查看分享链接(sec 可恢复化)

- 日期:2026-08-25
- 模式:Mode L(方案调研)+ Mode R(现实核实)
- 范围:read-only,未改任何代码
- 用户已裁决前提:支持 Owner 随时重新查看已创建分享的完整链接(含 `sec`),接受降低凭据保护等级
- 结论用途:供决策卡引用;方案选择权在主 AI 与用户

---

## 0. 一句话结论

三条方案里,**只有方案 1/3 才能"查看原链接";方案 2 给的是"换一条新链接"** —— 用户裁决书的措辞在这两种需求之间是歧义的,而便宜得多的方案 2 已经有一份写好并评审过的设计稿。另外一个必须先说的现实约束:**存量分享永远无法回填明文**(明文已不存在),所以即使上了方案 1,部署之前创建的分享仍然只能靠方案 2 的流程。这使方案 2 在任何路径下都是必要增量。

---

## 1. 计划假设清单(待现实核实的点)

| # | 假设(来自任务书) | 核实结果 |
|---|---|---|
| A1 | `sec` 明文只在创建响应出现一次,库里只有 `sec_hmac` + `pepper_kid` | [match] `entity/mail-share.js:7-8`;`mail-share-service.js:1144,1153`;`firstCreateResponse` `mail-share-service.js:528-543` |
| A2 | AuthKey 同构(`auth_key_hash` / `auth_key_kid`) | [match] `entity/mail-share.js:29-30`;`mail-share-service.js:1167-1168` |
| A3 | 仓内可能已有对称加解密可复用 | [deviation:全仓为零] 见 §2 |
| A4 | `credentials_version` 是为"重新生成链接"设计的 | [deviation] 它是为 AuthKey reset 设计的,但可原样复用于 sec 轮换。见 §4.2 |
| A5 | `resetAuthKey` 是可照搬的同构先例 | [match] `mail-share-service.js:1331-1370` 结构可逐段对应。见 §4.2 |
| A6 | 现有测试会因方案变更大面积失败 | [deviation:基本不会] 现有守卫是"明文子串"守卫,不是"不可恢复"守卫。见 §6 |
| A7 | 加密存储会推翻既有 AC | [match] 但推翻的是 **AC-SHARE-04 / AC-CAP-04**,不是常被误指的 AC-SHARE-03。见 §5 |

---

## 2. 现有密码学基础设施清单(A · 先查再造)

### 2.1 全仓检索结论:**没有任何对称加解密封装**

检索式(Grep over `mail-worker/src`):`crypto\.subtle|AES-GCM|AES-CBC|encrypt\(|decrypt\(|deriveKey|importKey`
命中 6 处,全部是 **摘要(digest)或签名(sign/verify)**,无一处 `encrypt` / `decrypt` / `wrapKey` / `deriveKey`:

| 位置 | 能力 | 性质 |
|---|---|---|
| `mail-worker/src/utils/crypto-utils.js:20` | `crypto.subtle.digest('SHA-256')`,盐+口令哈希(`saltHashUtils`) | 单向 |
| `mail-worker/src/utils/jwt-utils.js:35-64` | `importKey` + `sign` + `verify`,**HMAC-SHA256** | 单向签名 |
| `mail-worker/src/service/share-auth-service.js:102-116` | `hmacBytes` / `digestShareSecret` | 单向 |
| `mail-worker/src/service/mail-share-service.js:214-217` | `sha256Hex`(幂等指纹) | 单向 |
| `mail-worker/src/service/s3-service.js:56` | `digest('MD5')` | 单向 |
| `mail-worker/src/utils/file-utils.js:12` | `digest('SHA-256')` | 单向 |

**判定:对称加解密是真新建,无重复实现风险。**

### 2.2 但周边设施 100% 可复用(这才是重点)

方案 1/3 真正要写的只有 `encrypt`/`decrypt` 两个函数体,其余全部现成:

| 可复用件 | 锚点 | 复用方式 |
|---|---|---|
| **kid 双密钥环**(轮换机制本体) | `share-auth-service.js:118-131` `collectKeyedSecrets(currentKid, currentValue, prevKid, prevValue)` | 完全泛型,不含 pepper 语义。可原样加一个 `kekRing(c)` 读 `SHARE_SEC_KEK` / `SHARE_SEC_KEK_KID` / `_PREV`,与 `pepperRing`(`:146-153`)、`signingRing`(`:155-162`)并列第三个环 |
| kid 选择(常量时间) | `share-auth-service.js:133-144` `selectKeyedSecret` | 原样 |
| base64url 编解码 | `share-auth-service.js:76-87` | 原样(密文/IV 落库编码) |
| 常量时间比较 | `share-auth-service.js:89-100` | 原样 |
| CSPRNG token | `mail-share-service.js:98-101` `randomToken(byteLength)` | 原样(IV 生成用 `crypto.getRandomValues`) |
| expand-only 加列迁移 | `init/init.js:41-52` `ADD_COLUMN_SQL_LIST` + `:54-` 逐条 try/catch | 追加两行 `ALTER TABLE` 即可,幂等 |
| 凭据列不进 Owner 投影 | `mail-share-service.js:369-371` `OWNER_ROW_COLUMNS` 注释「取不到就漏不掉」 | 新列同样排除在外 |
| Owner 端「明文恰一次」的 UI 先例 | `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:312,398,813` | 复用同一交互与文案模式 |

> `collectKeyedSecrets` 是这次侦察里最有价值的发现:**轮换机制不用新造**,方案 1 的 `kek_kid` 就是第三个 ring,与既有 `pepper_kid` 完全同构。

### 2.3 Workers 运行时 WebCrypto 能力边界(官方文档核实)

来源:Cloudflare 官方 <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>(Last updated 2026-04-23),经 `exa-mcp-server-crawling_exa` 取回 `index.md` 的「Supported algorithms」表原文。

| 算法 | encrypt/decrypt | generateKey | wrapKey/unwrapKey | deriveBits/deriveKey | importKey |
|---|---|---|---|---|---|
| **AES-GCM** | ✓ | ✓ | ✓ | — | ✓ |
| AES-CTR | ✓ | ✓ | ✓ | — | ✓ |
| AES-CBC | ✓ | ✓ | ✓ | — | ✓ |
| AES-KW | — | ✓ | ✓ | — | ✓ |
| RSA-OAEP | ✓ | ✓ | ✓ | — | ✓ |
| **HKDF** | — | — | — | ✓ | ✓ |
| PBKDF2 | — | — | — | ✓ | ✓ |
| HMAC | (sign/verify ✓) | ✓ | — | — | ✓ |

补充事实:

- **AES-GCM 在 Workers 上完整可用**,方案 1 无运行时障碍。
- **HKDF `deriveKey` 可用** —— 建议 KEK 不直接当 AES key,而是经 HKDF 派生(`info` 绑定用途字符串),与仓内 pepper 直接当 HMAC key 的做法相比更规范,成本一行。
- 官方还提供**非标准扩展 `crypto.subtle.timingSafeEqual(a, b)`**;仓内目前是手写的(`share-auth-service.js:89-96`)。**这是既有实现,不在本次范围**,仅登记为可选清理项。
- MDN 记载 AES-GCM 单次明文上限 2^39−256 字节 —— `sec` 是 43 字符,完全无关。

---

## 3. 业务现实核查(§0.17)

用户已明确裁决要做,**不重开该裁决**。仅登记分类供决策卡引用:

| 项 | 判定 |
|---|---|
| 真实场景 | Owner 创建分享后把链接发给他人,后续需要再次找到这条链接(转发给同一个人 / 核对发出去的是哪条 / 换个渠道重发) |
| 缺失代价 | 真实存在:当前唯一补救是 revoke + create,会打断已在使用该链接的访客 —— 这正是 `AC-CAP-14` 目前那套「引导 Owner revoke/delete 后重新 create」的笨拙之处(`requirements.md:68`) |
| 既有覆盖 | 部分覆盖:revoke + create 能给出可用链接,但会踢掉在途访客;`design.md:295-297` 的 regenerate 约定是更好的既有设计,但从未实现 |
| 分类 | **A 业务必需**(用户已裁决 · 不再质疑) |

**但需求本身有歧义,必须由用户澄清**(这是本报告最重要的单点):

- **需求 X**:「我把链接弄丢了,要重新拿到一条能用的链接发给同一个人」→ 方案 2 完全满足,零安全代价。
- **需求 Y**:「我要查看当初发出去的那条链接原文,且不能影响正在用它的访客」→ 只有方案 1/3 能做到。

用户裁决书写的是「重新查看已创建分享的完整链接」,字面偏 Y,但实际业务动机常常是 X。**这一条建议放进决策卡的待确认项。**

---

## 4. 三方案对比(B)

### 4.0 总表

| 维度 | 方案 1 AES-GCM 可逆存储 | 方案 2 重新生成端点 | 方案 3 混合(创建时勾选) |
|---|---|---|---|
| 满足需求 X(丢了要新链接) | ✅ | ✅ | ✅ |
| 满足需求 Y(查看原链接不打扰访客) | ✅ | ❌ **做不到** | ✅(仅勾选过的) |
| 新增数据库列 | 2(`sec_enc`, `kek_kid`) | **0** | 3(+`sec_recoverable`) |
| 新增 env 密钥 | `SHARE_SEC_KEK` + kid(+prev) | 无 | 同方案 1 |
| 迁移代价 | 低(`init.js:41-52` 追加 2 行幂等 ALTER) | **零** | 低(追加 3 行) |
| 存量行可回填 | ❌ **永久不可能**(明文已不存在) | 不涉及(生成新的) | ❌ 同方案 1 |
| 密钥轮换 | 复用 `collectKeyedSecrets` 做 `kekRing`;**但语义与 pepper 相反**,见 §4.1 | 不涉及 | 同方案 1 |
| 规格返工 | 大(推翻 AC-SHARE-04 / AC-CAP-04 + 改 ADR Decision) | **小**(取消既有 deprecated 标记即可) | 最大 |
| 新写代码量 | 中(加解密 + 端点 + 限流 + 审计) | 小(照搬 `resetAuthKey`) | 中偏大 |
| 安全代价 | 见 §7,真实存在 | **零回归** | 同方案 1,但仅限勾选过的行 |
| 已有设计稿 | 无 | ✅ `design.md:295-297` 已写且经 R2/R3 评审 | 无 |

### 4.1 方案 1 · AES-GCM 可逆加密存储

**列设计(建议 2 列而非 3 列)**

`mail_share` 追加:

- `sec_enc TEXT` —— base64url(`IV(12B) || ciphertext || GCM tag(16B)`),IV 前缀打包,避免第三列
- `kek_kid TEXT` —— 与 `pepper_kid`(`entity/mail-share.js:8`)同构

同步改 `entity/mail-share.js` 加两个字段;`init.js` 的 `ADD_COLUMN_SQL_LIST`(`:41-52`)追加两行 `ALTER TABLE mail_share ADD COLUMN ...`,该列表本身逐条 try/catch(`:54-`),重复执行安全。

**加密参数**

- 算法 AES-GCM 256;**IV 必须每行随机 96-bit**(`crypto.getRandomValues`)—— 同一 key 下 nonce 复用会直接泄露密钥流,这是 GCM 唯一的致命误用点。
- **`additionalData` 绑定 `shareId`(或 `lid`)**:密文被复制到另一行时解密直接失败。零成本,防行替换。
- KEK 经 **HKDF `deriveKey`** 派生出 AES key(`info` 写死用途字符串),不要把 env 字符串直接当 raw key。

**密钥轮换:能复用 kid 机制,但语义要反过来想**

`collectKeyedSecrets`(`share-auth-service.js:118-131`)是纯泛型的,加一个 `kekRing(c)` 即可。但与 pepper 有一处**本质差异必须写进设计**:

- pepper 是**验证**用途,未知 kid 时 **fail-closed**(`share-auth-service.js:172-179` 的注释明确写了这一点),链接直接判死,这是对的。
- KEK 是**解密**用途。若 KEK 退环,密文不可读 —— 但此时**绝不能让分享失效**:`sec_hmac` 仍是鉴权真源,链接照常工作,只是"查看链接"这个功能对该行失效。

→ **解密失败必须软失败**:端点返回「该链接已不可再次查看」,鉴权路径零影响。这反而是方案 1 一个很好的性质:**KEK 丢失是优雅降级,不是数据事故。**

**改动面清单**

| 节点 | 生产者 | 消费者 |
|---|---|---|
| KEK env | `wrangler secret`(待建,勿写 toml,见 §7 措施 2) | `kekRing()`(待建,`share-auth-service.js` 或新 `share-crypto.js`) |
| 加密写入 | `mail-share-service.js:1151-1178` `insertShareAndIdempotency` 入参加 `secEnc`/`kekKid` | `entity/mail-share.js`(待改)+ `init.js:41-52`(待改) |
| 解密读取 | 新端点 `POST /mailShare/revealSec`(待建) | `mail-share-api.js:53-57` 的 `resetAuthKey` 路由形态(existing,照搬) |
| Owner UI | `ShareDetailDrawer.vue:312,398,813`(existing,扩展) | `mail-vue/src/views/email/build-share-url.js:1-9`(existing,直接复用拼 URL) |
| 审计日志 | `logShareEvent`(`share-auth-service.js:417` existing) | 新事件名 `share.sec.revealed`(待建,仅带 `shareId`) |
| 限流 | `wrangler.toml:12-20` 模式(existing,新增第三个 Owner 侧 limiter) | 新端点(待建) |

### 4.2 方案 2 · 重新生成链接端点

**这条路径的现实核实结果远好于预期 —— 设计稿已经写好并评审过了。**

**① 既有设计稿(可直接引用,不用重写)**

`docs/specs/mail-share/design.md:295-297`「后续 regenerate 约定(本期不做 · R2 语义保留)」原文:

> 当未来引入 `PUT /mailShare/regenerate` 时:**仅**对 `effectiveStatus=ACTIVE` 的授权在同一 `share_id` 行内原子更新 `lid` 与 `sec_hmac`,**保持** `expires_at` 与 `window_start_email_id`;`EXPIRED`/`REVOKED` 拒绝 regenerate,须新建授权。

配套的 AC 也只是被打了 deprecated 标记,原文都在,**取消标记即可复活**:

- `AC-SHARE-13`(`mail-share/requirements.md:70`)—— regenerate 的幂等语义
- `AC-LIFE-05`(`:112`)—— 生成新 `lid`/`sec`、旧链接立即失效、保持 `expires_at` 与 Visible Window
- `AC-LIFE-11`(`:113`)—— EXPIRED/REVOKED 拒绝 regenerate
- `P-LIFE-02`(`mail-share/design.md:595-599`)—— 不变式:只变 `lid`/`sec_hmac`,不变授权边界
- 移除记录:`design.md:763,770`「regenerate 保留(R2-A2)→ R3 延后」;`tasks.md:691` 列在「本期不做/后续」

**② `credentials_version` 是不是为此设计的?—— 不是,但可原样复用**

核实结论:该列是为 **AuthKey reset** 设计的,不是为 sec 轮换。证据:

- `ADR-mailbox-share-capability-extension.md:15`:「重置经 `credentials_version` 使旧 Session 立即失效」,上下文全是 AuthKey。
- `entity/mail-share.js:31` 与 `auth_key_*` 三列相邻,同批 `init.js:48-51` 加入。
- `share-auth-service.js:426-428` 注释:「enable 故意不 bump cv(AC-AUTH-07)」—— 语义完全绑定 AuthKey 状态机。

但它的**机制正是 sec 轮换需要的**:`resolveSession`(`share-auth-service.js:591-597`)每请求比对 token 里的 `cv` 与行上的 `credentialsVersion`,不等则 `SHARE_UNAVAILABLE` + 记 `SESSION_DENIED_CV`。`consumeSessionQuota`(`:430-441`)的 WHERE 也带 cv 谓词,并发建会话会输掉竞争。→ **regenerateSec 只要 `credentials_version + 1`,在途会话就在下一次请求即刻死亡。零新机制。**

**③ `resetAuthKey` 是不是可照搬的同构先例?—— 是,逐段对应**

`mail-share-service.js:1331-1370` 的结构:

| resetAuthKey 步骤 | 锚点 | regenerateSec 对应 |
|---|---|---|
| 动作值域校验 | `:1332` `toAuthKeyTransition` | 无(单一动作) |
| 归属 + ACTIVE 校验 | `:1334` `loadMutableShare` | 原样 |
| V2 栅栏 | `:1338-1340` `assertCapabilityV2` | 视是否纳入 V2 而定 |
| 取 pepper,缺失即抛 | `:1350-1354` | 原样 |
| CSPRNG 铸新凭据 | `:1355` `randomToken(16)` | `randomToken(16)` 新 lid + `randomToken(32)` 新 sec |
| 当前 pepper + **当前 kid**(顺手前滚) | `:1356-1357` 及 `:1342-1345` 注释 | 原样,同一 `digestShareSecret` |
| 单条带守卫条件 UPDATE | `:1360` → `prepareAuthKeyUpdate` `:1062-1069`(SET 三列 + `credentials_version + ?`,WHERE 带 `status='ACTIVE' AND expires_at > ?`) | 同形:SET `lid`/`sec_hmac`/`pepper_kid` + `credentials_version + 1` |
| 零变更 ⇒ `SHARE_NOT_FOUND` | `:1363-1365` | 原样 |
| 回读详情 + 明文恰一次 | `:1367-1369` | 原样,额外拼 `shareUrl` |
| 路由 | `mail-share-api.js:53-57` | 同形 `POST /mailShare/regenerateSec` |

**④ 访客在途会话会怎样?—— 会被踢下线,而且是双重的**

1. `credentials_version + 1` → 在途 sessionToken 在**下一次请求**即 `SHARE_UNAVAILABLE`(`share-auth-service.js:591-597`),不是等 TTL。
2. `lid` 变更 → 旧 URL 整体失效;`share:est:<lid>:<key>` 重放缓存键(`share-auth-service.js:444-446`)天然失效,无需清理。
3. `lid` 有 UNIQUE 索引(`design.md:329`),换 lid 安全;旧 URL 变成"查无此分享",与其他死链不可区分,符合 `AC-SEC-10` 的封闭性设计。

**可选收敛**:若产品上希望"不打扰访客",可只换 `sec_hmac` 保留 `lid`。但那样旧链接的 `lid` 仍能定位到行,只是 sec 不匹配 —— 安全上无差别,却丢掉了 lid 轮换的好处。建议按 `design.md:297` 原文两者都换。

**⑤ 这条路的致命局限**

**它不满足需求 Y。** 旧链接一定失效,已经拿到链接的人一定要重新收一份。如果用户真正想要的是"看一眼我发出去的是哪条,不打扰任何人",方案 2 答不了。

### 4.3 方案 3 · 混合(创建时勾选「允许日后重新查看」)

**开关落在哪**

`mail_share` 加 `sec_recoverable INTEGER NOT NULL DEFAULT 0`(与 `auth_key_enabled` 同形,`entity/mail-share.js:28`),仅当为 1 时写 `sec_enc`/`kek_kid`。

**与幂等指纹 `createFingerprints` 的关系(这是本方案最容易踩的坑)**

核实 `mail-share-service.js:192-259`:

1. `normalizeCreateBody`(`:195-212`)**字段插入顺序本身就是指纹的一部分** —— `:192-194` 的注释明确写了「必须一次性构造整个字面量,不能 `{...defaults, ...params}`」。新增 `secRecoverable` 必须写进这个字面量的固定位置。
2. `requestFingerprint`(`:219-221`)= `sha256Hex(JSON.stringify(body))`,**任何新键都会改变所有 modern 指纹**。这本身不致命(24 小时窗口,`IDEMPOTENCY_TTL_HOURS`)。
3. **真正的坑在 `legacyCompatibleBody`(`:228-246`)**:它把"兼容载荷"(单邮箱 + 全部新字段停在 DDL 默认值)降维成旧四字段指纹,让旧 Worker 也能重放。它的守卫列表逐条列着 `body.authKeyEnabled !== 0` 这类判断。
   → **必须追加 `|| body.secRecoverable !== 0`**,否则一个 `secRecoverable=true` 的请求会被降维成 legacy 指纹,被一个根本不认识这个字段的旧 Worker 重放出来 —— 正是 `AC-LIFE-10` 滚动发布栅栏要防的策略降级。
4. 同理,`secRecoverable=true` 应当纳入 `assertCapabilityV2` 门控(`SHARE_V2_INTENT`,参照 `:1338-1340`),理由与 AuthKey 一致:旧 Worker 执行不了这条策略。

**代价**:方案 1 全部成本 + 一个 flag + 一行 `legacyCompatibleBody` 守卫 + V2 栅栏接线 + 前端向导多一个勾选项(`ShareCreateWizard.vue`)。

---

## 5. 受影响的 AC 与 ADR(C · 逐条带原文)

### 5.1 直接被推翻的条款

| 编号 | 锚点 | 原文关键句 | 冲突点 | 受影响方案 |
|---|---|---|---|---|
| **AC-SHARE-04** | `docs/specs/mail-share/requirements.md:61` | 「THE MailShareService SHALL 在响应中返回 `sec` 明文恰好一次;后续任何查询接口 SHALL NOT 再返回 `sec` **或可据以重建 `sec` 的数据**」 | **这是核心冲突条款。**「可据以重建」一句直接封死可逆存储 —— 密文+KEK 就是"可据以重建的数据" | **1、3** |
| **AC-CAP-04** | `docs/specs/mailbox-share-capability/requirements.md:58` | 「`sec` **只以** `HMAC-SHA256(sec, PEPPER[pepper_kid])` 存库且明文仅创建响应返回一次」 | 「只以」被 `sec_enc` 列推翻 | **1、3** |
| **AC-CAP-14** | `docs/specs/mailbox-share-capability/requirements.md:68` | 「幂等重放 SHALL 仅返回 `shareId`/`lid` 而不重放明文;THE 管理 UI SHALL 依据重放结果**引导 Owner 对该分享执行 revoke/delete 后重新 create**」 | 补救措施整体过时:方案 1/3 下 Owner 直接重看;方案 2 下改为"调用 regenerateSec"(严格更优) | **1、2、3 全部** |
| **ADR Decision 1** | `docs/architecture/ADR-mail-share-capability-boundary.md:37` | 「`sec` 只存 `HMAC-SHA256(sec, PEPPER[kid])`」 | 修改的是 ADR 的 **Decision 正文**(该 ADR 状态为 Proposed) | **1、3** |
| ADR 扩展 | `docs/architecture/ADR-mailbox-share-capability-extension.md:15` | 「只存 `auth_key_hash`,复用 HMAC+PEPPER 设施」 | 若加密**不**扩展到 AuthKey,则不受影响(建议如此) | 仅当扩展到 AuthKey |
| 密钥生命周期表 | `docs/specs/mail-share/design.md:316-324` | pepper 正常轮换 / 验证 / 密钥丢失 / 紧急吊销 四行 | 需增加 KEK 一组行,且必须写明**与 pepper 相反的软失败语义**(§4.1) | **1、3** |
| create 契约行 | `docs/specs/mailbox-share-capability/design.md:300` | create 响应 `sec`(仅首次) | 需补充 reveal 端点行 | **1、3** |
| API 表 | `docs/specs/mailbox-share-capability/design.md:307` | `POST /mailShare/resetAuthKey` 行 | 新端点按同格式追加一行 | 全部 |

### 5.2 看似冲突、实际不冲突的条款(避免误改)

| 编号 | 锚点 | 为什么不冲突 |
|---|---|---|
| **AC-SHARE-03** | `mail-share/requirements.md:60` | 「SHALL NOT 将 `sec` **明文** 写入任何数据库列」—— 存的是密文,字面不违反。建议仍改写措辞以免歧义,但它**不是**阻挡条款 |
| **AC-CAP-05** | `mailbox-share-capability/requirements.md:59` | AuthKey 明文恰一次。**只要不把加密扩展到 AuthKey 就完全不动**(强烈建议不扩展,见 §7 措施 1) |
| **AC-AUTH-03** | `:108` | AuthKey 常量时间 HMAC 校验、不存明文 —— 同上,不动 |
| **AC-CAP-09** | `:63` | 幂等重放不返回 `sec`。新端点是独立路径,重放规则可保持原样不变 |
| **AC-SEC-09** | `:180` | 禁止 `sec` 进**日志 / URL 查询串 / Referer**。响应体不在禁止列表内。→ 但新端点**必须是 POST**(不能 GET 带 query)且 `no-store` |
| **AC-SEC-08** | `:179` | 状态变更须单条原子条件写。方案 2 的 UPDATE 天然满足(照搬 `prepareAuthKeyUpdate`);方案 1 的 reveal 是纯读,不涉及 |
| **AC-ADMIN-05** | `:159` | resetAuthKey 契约 —— 不冲突,而是**新 AC 的书写模板** |

### 5.3 方案 2 独有的规格影响(反向:是"复活"不是"推翻")

无任何现行 AC 被推翻。需要做的是**取消 deprecated 标记**:`AC-SHARE-13`(`:70`)、`AC-LIFE-05`(`:112`)、`AC-LIFE-11`(`:113`)、`P-LIFE-02`(`design.md:595-599`);并更新 `requirements.md:7` 与 `:75` 里「`regenerate` 本期不做 / `sec` 丢失即丢失」的范围声明,以及 `tasks.md:691` 的「本期不做」清单。

---

## 6. 受影响的测试清单(带锚点)+ 一个反直觉的结论

### 6.1 逐条核实

| 测试 | 锚点 | 断言内容 | 方案 1/3 下会红吗 |
|---|---|---|---|
| `stores HMAC(sec, pepper) and never persists plaintext sec (AC-SHARE-03)` | `mail-worker/test/mail-share-service.spec.js:225-237` | `:232` `expect(Object.values(share)).not.toContain(created.sec)` | **不会红**。AES-GCM 密文的 base64 不含明文子串 |
| `returns sec only on the first create response (AC-SHARE-04)` | `mail-share-service.spec.js:239-253` | `:246` `expect(JSON.stringify(listed)).not.toContain(created.sec)`;`:251` 重放无 sec | **不会红**,只要新端点独立于 `list`。但用例名与 AC 映射会变得误导 |
| 全库明文扫描守卫 | `share-integration.spec.js:248-267` | 遍历 `sqlite_master` 所有表的 TEXT 列,`instr(col, sec) > 0` 逐一断言为假(`:265`) | **不会红**,同上 |
| 守卫自检(元测试) | `share-integration.spec.js:1476-1484` | 故意把明文塞进 JSON 列,断言守卫会抛 | 不受影响 |
| 幂等重放无 sec | `share-integration.spec.js:619-627`;`share-api.spec.js:188`;`mail-share-service.spec.js:348-356,1040,1125-1126` | 重放响应 `sec` 为 `undefined` | 不受影响(重放规则不变) |
| AuthKey 明文恰一次 / 库中仅 hash | `mail-share-service.spec.js:953-1000`;`:1006`;`:3136` | AuthKey 相关 | **只要不加密 AuthKey 就完全不受影响** |
| cv 语义 / 旧 token 无 cv | `share-auth-service.spec.js:1618`;`mail-share-service.spec.js:2934`(disable bumps cv) | cv 状态机 | 方案 2 需**扩展**(新增 regenerate 后 cv 行为),不会红 |
| resetAuthKey HTTP 层 no-store + 单次明文 | `mail-share-service.spec.js:3224-3245` | 路由层契约 | 方案 2 的**直接模板** |
| 列清单快照 | `mail-share.schema.spec.js:33,70-76`;`v3-2-db.spec.js:45,127`;`share-auth-service.spec.js:285`;`mail-share-service.spec.js:2342` | 断言表/实体列集合 | **会红** —— 加列必然打红这几处列快照断言,需同步更新(方案 1/3) |
| 前端链接拼装 | `mail-vue/src/views/email/build-share-url.spec.js`;`ShareCreateWizard.spec.js:145,502-517`;`ShareDetailDrawer.spec.js` | `shareUrl` 构造与"重放无明文"引导 | 方案 1/3 需改 `ShareDetailDrawer` 新增查看入口;方案 2 需改 `ShareRowActions` 新增操作项 |

**规模**:`mail-share-service.spec.js` 157 个用例、`share-integration.spec.js` 38 个、`share-api.spec.js` 12 个(`git grep -c` 实测)。

### 6.2 反直觉但重要的结论

**现有测试套件实际上拦不住方案 1。** 所有"明文"守卫都是**明文子串扫描**,不是**不可恢复性**断言。规格层(`AC-SHARE-04` 的「或可据以重建 `sec` 的数据」)禁止可恢复,但**没有任何测试在执行这条禁令**。

含义有两层:

1. 方案 1/3 的测试工作量主要是**写新测试**,不是修红测试。真正会红的只有几处列快照断言。
2. 这本身是一条既有的规格-测试缺口,值得在决策卡里登记(不属本次交付范围)。

---

## 7. 安全代价的诚实评估(D)

### 7.1 采用方案 1 后,攻击者拿到什么就能还原所有历史链接

**答案:D1 数据库内容 + `SHARE_SEC_KEK` 的值。两样都拿到,就能离线、批量、静默地还原部署之后创建的每一条分享链接的完整 URL。**

### 7.2 与当前方案相比,多暴露了什么

**当前的真实状态(不夸大地说,它相当强):**

- `sec` 是 256-bit CSPRNG(`mail-share-service.js:1144` `randomToken(32)`)。
- 库里只有 `HMAC-SHA256(sec, pepper)`(`share-auth-service.js:113-116`,pepper 作 HMAC key)。
- 拿到 D1 全库:**毫无用处**。HMAC 单向,256-bit 随机原像,无字典、无彩虹表、无可行离线爆破。
- 即便同时拿到 D1 **和** `SHARE_SEC_PEPPER`:**仍然还原不出 `sec`** —— HMAC 依然是单向的,pepper 只能用于**验证**一个候选 `sec`,而候选空间是 2^256。
- 也就是说:**今天,明文在服务端任何地方都不存在。这不是"藏得好",是"真的没有"。** 这正是要交出去的性质。

**方案 1 之后新增的暴露:**

- D1 + KEK ⇒ 全量历史链接明文。
- 但要客观:两者都在同一个 Cloudflare 账户内 —— D1 是 binding,KEK 是 Worker secret。**已经拿到该账户 Dashboard / API Token 的攻击者,今天就能直接改 Worker 代码读取全部邮件**,对这类攻击者而言边际损失有限。
- **真正新增的、今天不存在的风险面**是这四类:
  1. **D1 备份/导出**与**密钥泄露**在不同时间、不同渠道各自发生,过去两者相加仍无害,现在相加即全量泄露。
  2. **内部人员**同时具备两边读权限(运维 / 前员工 / CI 凭据)。
  3. **未来任何一条代码路径**不慎把解密结果写进日志或返回给错误的对象 —— 今天这类 bug **物理上不可能泄露 `sec`**,因为明文不存在;方案 1 之后它变成一类真实的 bug。
  4. **Worker 代码注入 / 依赖投毒**能调用解密助手 —— 今天没有这个助手,所以没有这条路径。

**不危言耸听的部分:**

- 访客鉴权链路完全不变,`sec_hmac` 仍是唯一鉴权真源。
- per-link 的 revoke / 过期 / 配额 / cv 失效机制一个都不受影响。
- 这不是"分享变得不安全",而是系统从**"无法披露"**变成**"选择不披露"**。差别是真实的,但它是一次**保证等级的下调**,不是一个漏洞。

### 7.3 把泄露面压到最小的具体措施(按性价比排序)

1. **只加密 `sec`,AuthKey 保持纯 HMAC 不可恢复。** 性价比最高且零成本:即使 D1 + KEK 全丢,启用了 AuthKey 的分享**仍然打不开**,第二因子完好。同时 `AC-CAP-05` / `AC-AUTH-03` 一字不改。
2. **KEK 与 D1 分离存储**:用 `wrangler secret put SHARE_SEC_KEK`,**绝不写进 `wrangler.toml`**。特别注意 `wrangler.toml:4` `keep_vars = true` 与 `:58-60` 那条既有警告 —— toml 里显式写的值会覆盖 Dashboard 设置,`SHARE_CAPABILITY_V2` 就是因此特意保持注释状态。
3. **专用端点,绝不并入 `list`/`get`。** `OWNER_ROW_COLUMNS`(`mail-share-service.js:371`)刻意不 SELECT 凭据列,注释写着「取不到就漏不掉」(`:369-370`)—— 新列同样排除在外,使 reveal 端点成为**唯一**读取路径。
4. **限流 + 审计。** `wrangler.toml:12-20` 已有两个限流器(均为访客侧),新增第三个 Owner 侧限流器只是 4 行 toml。审计走既有 `logShareEvent`(`share-auth-service.js:417`)发 `share.sec.revealed`,**只带 `shareId`** —— `AC-LEAK-05` 日志栅栏禁止 `sec` 入日志。
5. **AES-GCM `additionalData` 绑定 `shareId`**:密文跨行复制即解密失败。零成本。
6. **每行独立随机 96-bit IV**,与密文一起存。GCM 的 nonce 复用是唯一致命误用,必须在设计里钉死。
7. **解密软失败**:KEK 缺失 / 已退环 ⇒ 返回「不可再次查看」,**绝不影响鉴权**。`sec_hmac` 未动,分享照常工作。
8. **给可恢复性设 TTL**:分享过期后清空 `sec_enc`(既有清理任务 `mail-share-cleanup-service.js` 已按 `delete_at` 扫表,挂一条 UPDATE 即可)。这样攻击者拿到的历史语料只覆盖仍然有效的分享,而不是全部历史。
9. **HKDF 派生**而非直接使用 env 字符串作 AES key(Workers 支持 `deriveKey`,见 §2.3)。

---

## 8. 推荐方案与理由(推荐归推荐,决策权在主 AI 与用户)

### 推荐:**先上方案 2,并向用户澄清需求 X / Y;若确为需求 Y,再上方案 3(而不是方案 1)。**

理由:

1. **需求歧义未消解前,先做零代价的那一半。** 若用户真实需求是 X(丢了要新链接),方案 2 **完全满足且安全零回归**;若是 Y,方案 2 也不白做(见理由 3)。花两周降低凭据保护等级去解决一个可能压根不是 Y 的需求,是不划算的。
2. **方案 2 的现成程度罕见地高**:设计稿已写(`design.md:295-297`)、AC 原文已在(只是打了 deprecated)、经过 R2/R3 两轮评审、有逐段可对应的同构实现(`resetAuthKey` `:1331-1370`)、复用现成的 cv 踢线机制、**零新增列、零新增密钥、零安全回归**。这是本次侦察里性价比最高的一条路。
3. **方案 2 在任何路径下都是必需的。** 方案 1/3 有一个用户可能没预料到的硬限制:**存量分享永远无法回填** —— 明文已经不存在了。所以即使上了方案 1,部署之前创建的每一条分享仍然只能走"重新生成"的流程。方案 2 不是方案 1 的替代品,而是它的前提。
4. **若确需 Y,选方案 3 而非方案 1。** 让可恢复性成为 Owner 的显式选择(创建时勾选),默认姿态仍是不可恢复,泄露面只覆盖 Owner 主动标记过的那些行。相对方案 1 的增量成本很小:一个 flag + `legacyCompatibleBody`(`:228-246`)加一行守卫 + V2 栅栏接线。用一点点代码换回"默认安全"。
5. **顺带修好一处既有笨拙设计**:`AC-CAP-14` 目前的补救是"引导 Owner revoke/delete 后重新 create"(`requirements.md:68`),会连带丢掉 `expires_at` 与 Visible Window;换成 regenerateSec 之后,原地换凭据、保留授权边界,严格更优。

### 需要用户拍板的问题(建议决策卡只问这一条)

> 您说的「重新查看完整链接」,是指哪种情况:
> **(X)** 我把链接弄丢了,需要重新拿到一条能用的链接发给对方 —— 代价是对方手上的旧链接会失效,需要重新发一次;
> **(Y)** 我要查看当初发出去的那条链接原文,而且正在使用它的人不能受影响 —— 代价是服务器必须保存可还原的凭据副本,拿到数据库和密钥的人能还原所有链接。

---

## 9. 领域模型核对

`docs/domain/` 目录不存在(仓内无 domain-model 文档体系);本变更的跨切面契约由 `docs/specs/mail-share/` 与 `docs/specs/mailbox-share-capability/` 两套 spec + 两份 ADR 承担,§5 已逐条核对。**无需新建 domain-model 文档**,但方案 1/3 触及 ADR Decision 正文,**触发 ADR admission**(需要一份修订说明或 superseding ADR),建议在决策卡的 ADR 字段写「需要:是」。

---

## 10. 未核实项(诚实标注)

- `mail-worker/.dev.vars` 未读取(可能含真实密钥),`SHARE_SEC_PEPPER` 等 env 的实际配置值 `unverified`;仅从代码读法(`share-auth-service.js:146-162`)确认了变量名契约。
- 未运行任何测试;§6 的"会红 / 不会红"判断基于对断言语义的代码级阅读,**非实测**。列快照类断言(`mail-share.schema.spec.js:33`、`v3-2-db.spec.js:45` 等)判定为"加列必红"置信度高;其余"不会红"的判定依据是"AES-GCM 密文 base64 不含明文子串"这一确定性事实。
- 方案 1/3 的实际迁移耗时、D1 加列在生产数据量下的表现 `unverified`(`init.js` 的 ALTER 是 expand-only 幂等模式,风险低)。
