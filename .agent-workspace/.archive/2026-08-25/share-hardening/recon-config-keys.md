# 侦察报告 · 邮件分享功能的密钥与配置链路

- 模式:Mode R(现实核实)· read-only,未修改任何业务代码/配置
- 仓库:`F:\Email\cloud-mail-upstream` · 后端 `mail-worker/` · 前端 `mail-vue/`
- 日期:2026-08-25
- 检索工具:Cursor `Grep`(ripgrep)+ `Read`(逐段精读)+ `Get-ChildItem`(文件枚举);`user-mcphub` 语义检索未使用 —— 本次目标是精确符号/常量定位,`Grep` 的全仓精确匹配即等价能力(Globalrules §2 允许等价检索手段)

---

## 1. 计划假设清单(来自用户提出的待核实事实)

| # | 假设 | 出处 |
|---|---|---|
| A1 | `mail-share-service.js` 约 1121 行要求 `SHARE_SEC_PEPPER`,缺失返回 `share create pepper missing` | 用户报告(未亲验) |
| A2 | `share-auth-service.js` 约 158 行要求 `SHARE_SESSION_SIGNING_KEY` | 用户报告(未亲验) |
| A3 | `wrangler.toml` 注释只提 `SHARE_CAPABILITY_V2`,未提这两个密钥;README 亦未提 | 用户报告(未亲验) |
| A4 | 根 `.gitignore` 与 `mail-worker/.gitignore` 忽略 `.dev.vars` | 用户报告(未亲验) |
| B1 | 创建分享后点「访问密钥启动」直接抛 `SHARE_INVALID_CONFIG` | 用户报告(现象) |

---

## 2. 事实核实表(逐条 确认/否证/无法判定 + 锚点)

### A1 · `SHARE_SEC_PEPPER` 于 create 路径 — **部分确认(行号精确命中,报错文本需修正)**

```1121:1125:mail-worker/src/service/mail-share-service.js
		const pepper = c.env.SHARE_SEC_PEPPER;
		if (!pepper) {
			console.error('share create sec pepper missing');
			throw new Error('share create pepper missing');
		}
```

- **真实行号**:读取点 `mail-share-service.js:1121`,判空 `:1122`,`console.error` `:1123`,抛错 `:1124`。用户说的「约 1121 行」**确认**。
- **报错文本**:抛出的 `Error.message` 是 `share create pepper missing`(`:1124`);`console.error` 打的是**另一个**字符串 `share create sec pepper missing`(`:1123`,多一个 `sec`)。用户引述的是 `Error` 那条,**确认**。
- **抛错路径**:`new Error(...)` 而**非** `BizError`。这条不是业务码,会走 hono 全局 onError 兜底,**接口不会返回 `share create pepper missing` 给前端**,前端只拿得到通用 500 信封。用户表述「接口返回 `share create pepper missing`」**部分否证** —— 该文本只出现在 Worker 日志,不在响应体。
- **有无默认值/降级**:**无**。`pepper` 为空即 fail-closed。对照 `pepperKid` 有默认值 `'v1'`(`:1147`),`pepper` 本身刻意不给默认。
- **同类第二处**:`resetAuthKey` 的 `enable`/`reset` 分支同样硬依赖,`mail-share-service.js:1350-1354`,抛 `Error('share reset auth key pepper missing')`。`disable` 不 mint key 故不检查(`:1345` 注释明说)。

### A2 · `SHARE_SESSION_SIGNING_KEY` 于访客会话签名 — **确认(行号命中,行为需补全)**

```155:162:mail-worker/src/service/share-auth-service.js
function signingRing(c) {
	return collectKeyedSecrets(
		c.env.SHARE_SESSION_SIGNING_KID,
		c.env.SHARE_SESSION_SIGNING_KEY,
		c.env.SHARE_SESSION_SIGNING_KID_PREV,
		c.env.SHARE_SESSION_SIGNING_KEY_PREV
	);
}
```

- **真实行号**:`share-auth-service.js:158`(读取点),位于 `signingRing()` `:155-162`。用户说的「约 158 行」**确认**。
- **缺失时的行为**:`collectKeyedSecrets` 的 `add()` 对 falsy value 直接 `return`(`:122-124`),故两把 key 都缺 → 返回空数组。空环在 `issueToken` 处 fail-closed:

```204:209:mail-worker/src/service/share-auth-service.js
async function issueToken(c, row) {
	const keys = signingRing(c);
	if (!keys.length) {
		console.error('share-auth session signing key missing');
		throwUnavailable();
	}
```

- **错误码**:`throwUnavailable()`(`:35-36`)抛 `BizError('SHARE_UNAVAILABLE')`,**不是** `SHARE_INVALID_CONFIG`。这一点对事实 B 的根因排除很关键。
- **同构第三条链**:`SHARE_SEC_PEPPER` 在访客侧还有独立读取点 `pepperRing()` `:146-153`,空环时 `matchSec` 走 `throwUnavailable()`(`:166-169` → `SHARE_UNAVAILABLE`),`matchAuthKey` 走 `return false`(`:186-190` → 验签失败,非异常)。**同一变量缺失,三条路径三种表现**(500 / `SHARE_UNAVAILABLE` / 静默 false),这是排障时最容易误判的地方。

### A3 · wrangler.toml 与 README 的说明覆盖 — **确认(wrangler.toml)· 部分否证(文档)**

`mail-worker/wrangler.toml` 的 `[vars]` 全文(`:51-60`),**全部为注释**,无任何生效变量:

```51:60:mail-worker/wrangler.toml
[vars]
#ai_model = ""			#ai模型,不填默认使用@cf/meta/llama-3.1-8b-instruct
#analysis_cache = false			#是否开启分析数据缓存
#orm_log = false			#是否sql日志
#domain = []				#邮件域名可可配置多个 示例: ["example1.com","example2.com"]
#admin = ""				#管理员的邮箱	示例: admin@example.com
#jwt_secret = ""			#jwt令牌的密钥,随便填一串字符串
#SHARE_CAPABILITY_V2 = "false"	#分享全能力发布栅栏(AC-LIFE-11),缺省即 false,代码把「缺失」当 false
						#只在 Dashboard 置 "true",且须先满足激活前置:迁移完成 + 回填重跑 + 无旧 Worker 在途 + 关键日志事件已有告警消费者
						#此处保持注释:keep_vars 拦不住 toml 里显式写的值,取消注释会把 Dashboard 的 true 覆盖回 false
```

- 分享相关只出现 `SHARE_CAPABILITY_V2` 一条注释;`SHARE_SEC_PEPPER` / `SHARE_SESSION_SIGNING_KEY` **全文无提及**(全仓 grep 对 `wrangler.toml` 零命中)。**确认**。
- 顶部另有两条分享 ratelimit binding 声明 `wrangler.toml:12-20`(`SHARE_SESSION_RATE_LIMITER` / `SHARE_READ_RATE_LIMITER`),是**已生效**配置,非注释。
- **README**:根 `README.md:73` 只有一句功能介绍「多邮箱与访问密钥需平台启用」,**不提任何变量名**;`README-en.md` 同构;**无 `mail-worker/README.md`**(全仓 README 仅 4 个:根 `README.md` / `README-en.md` / `docs/specs/README.md` / `tests/e2e/README.md`)。用户说 README 未提及这两个密钥 → **确认**。
- **但文档并非全无记载**(用户表述在此处**部分否证**):
  - `docs/architecture/ADR-mail-share-capability-boundary.md:55` —「**运维新增密钥**:`SHARE_SEC_PEPPER`、`SHARE_SESSION_SIGNING_KEY` 及 `kid` 双 key 轮换窗口」
  - `docs/specs/mail-share/tasks.md:179` — 已勾选任务「新建 `SHARE_SEC_PEPPER`、`SHARE_SESSION_SIGNING_KEY` env + kid 双 key 验签」
  - `docs/specs/mail-share/design.md:191`(签名密钥轮换)、`:320`(pepper 轮换)
  - 即:**设计层写了,部署层(wrangler.toml / README)没落地**。这是漂移的确切位置,不是「完全没写」。

### A4 · `.dev.vars` 是否被忽略 — **否证(重要安全缺口)**

- 根 `.gitignore` 全 33 行(已通读),**无** `.dev.vars` / `*.vars` / `.env` 任何条目。最接近的是 `*.local`(`:11`),匹配不到 `.dev.vars`。
- `mail-worker/.gitignore` 全文只有一行 `.ace-tool/`。
- **交叉验证**:会话起始 git status 显示 `?? mail-worker/.dev.vars` —— `??` 表示**未跟踪且未被忽略**;被忽略的文件默认不会出现在 `git status` 输出中。双重证据一致。
- **后果**:`mail-worker/.dev.vars` 现含三把明文密钥(`.dev.vars:1-4`:`SHARE_SEC_PEPPER` / `SHARE_SEC_PEPPER_KID` / `SHARE_SESSION_SIGNING_KEY` / `SHARE_SESSION_SIGNING_KID`),任何 `git add -A` 都会把它提交进版本库。虽然当前值是 `local-dev-*` 占位串,但**机制上已经是密钥泄露路径**。
- 参照物:`mail-worker/wrangler-vitest.toml:34-41` 是**已跟踪**的测试配置,里面本来就有 `vitest-share-*` 明文占位值 —— 说明「测试用假密钥入库」是本仓既有惯例,`.dev.vars` 未忽略可能是沿袭而非疏漏,但风险等级不同(`.dev.vars` 是开发者会往里塞真值的文件)。

---

## 3. 事实 B · `SHARE_INVALID_CONFIG` 全部抛出点与候选根因

### 3.1 反向枚举 · 后端全部抛出点(12 处,均在 `mail-worker/src/service/mail-share-service.js`)

全仓 grep `SHARE_INVALID_CONFIG` 在 `src/` 下**只命中这一个文件**;`share-auth-service.js` / `share-mail-service.js` / `share-attachment-service.js` / `share-api.js` / `share-rate-limit.js` **零抛出**(访客侧统一用 `SHARE_UNAVAILABLE`)。

| # | `file:line` | 所在函数 | 触发条件 |
|---|---|---|---|
| T1 | `mail-share-service.js:81` | `assertCapabilityV2(c, intent)` | `SHARE_CAPABILITY_V2` 不是 `'1'/1/true/'true'` 之一(`isCapabilityV2Enabled` `:67-70`)。**缺失即 false**。这是唯一的「栅栏」型抛出,有 8 个调用点(见 3.2) |
| T2 | `:152` | `toFlag(value, fallback)` | create 归一化:五个 flag 字段(`onlyMessagesAfterCreated`/`otpExtractionEnabled`/`autoRefresh`/`showFullAddress`/`authKeyEnabled`)取值不在 `FLAG_TOKENS`(`:141-144`,仅 `true/1/'1'/'true'/false/0/'0'/'false'`)。`null`/`''` 走 fallback 不抛 |
| T3 | `:164` | `toNullableCount(value)` | `maxSessions`/`messageLimit` 非 safe integer(含布尔 `true`、对象、`'abc'`)。`null`/`''` → 返回 null 不抛 |
| T4 | `:347` | `assertCreateBody` | `refreshIntervalMs` 非 safe integer **或** `< 3000`(`MIN_REFRESH_INTERVAL_MS` `:11`) |
| T5 | `:350` | `assertCreateBody` | `messageLimit != null` 且 `< 1` |
| T6 | `:353` | `assertCreateBody` | `maxSessions != null` 且 `< 1` |
| T7 | `:905` | `toPatchFlag(value)` | update 归一化:flag 字段取值不在 `FLAG_TOKENS`。**注意与 T2 不同**:此处**无** `null`/`''` 兜底,显式传 `null` 也抛 |
| T8 | `:913` | `toPatchCount(value)` | update:count `< 1`(先经 `toNullableCount`,故非整数由 T3 先抛) |
| T9 | `:921` | `toPatchInterval(value)` | update:`refreshIntervalMs` 非 safe integer 或 `< 3000` |
| T10 | `:1016` | `normalizeListStatus` | `GET /mailShare/list?status=` 取值不在 `OWNER_STATUSES`(`:27` = `ACTIVE/EXPIRED/REVOKED/ACCESS_LIMIT_REACHED`) |
| T11 | `:1054` | `toAuthKeyTransition(value)` | `resetAuthKey` 的 `action` 不是字符串字面量 `'enable'`/`'reset'`/`'disable'` 之一(不 trim、不 lowercase、不接受数组包装) |
| T12 | `:1336` | `resetAuthKey` | 行上的 `auth_key_enabled` 与所请求迁移的 `fromEnabled` 不符(`AUTH_KEY_TRANSITIONS` `:1043-1047`:`enable` 要求 0、`reset`/`disable` 要求 1)。即「对已启用的分享再 enable」「对未启用的分享 reset/disable」 |

### 3.2 T1 的 8 个调用点(栅栏实际接线位置)

| `file:line` | intent | 触发写入 |
|---|---|---|
| `:356` | `MULTI_CREATE` | create 时 `accountIds.length > 1` |
| `:359` | `AUTH_KEY_ENABLE` | create 时 `authKeyEnabled` 为真 |
| `:362` | `FINITE_MAX_SESSIONS` | create 时 `maxSessions != null` |
| `:365` | `MESSAGE_LIMIT` | create 时 `messageLimit != null` |
| `:966` | `FINITE_MAX_SESSIONS` | update 把 `maxSessions` 设为非 NULL 有限值 |
| `:969` | `MESSAGE_LIMIT` | update 把 `messageLimit` 设为非 NULL |
| `:1107` | `BINDING_EXPAND` | `PUT /mailShare/bindings` 使绑定数变大且 > 1 |
| **`:1339`** | `AUTH_KEY_ENABLE` | **`resetAuthKey` 且 `action='enable'`**(`AUTH_KEY_TRANSITIONS.enable.gated = true`,`:1044`) |

### 3.3 前端全部消费点(3 处)

| `file:line` | 入口 | 处置 |
|---|---|---|
| `ShareDetailDrawer.vue:747` | 详情抽屉保存配置(update) | `configError = tf('shareConfigRejected')`,文案「可能超出取值,或能力尚未开放」 |
| **`ShareDetailDrawer.vue:787`** | **`submitAuthKey(action)` 的 catch** | 设 `authKeyError = tf('shareAuthKeyFailed')`。**注意:此处并不判断 `err.message`**,任何异常都是同一句文案;`:784-786` 注释明说这是刻意的「不宣称知道是哪一种」 |
| `ShareCreateWizard.vue:699` | 创建向导提交 | 仅当 `fenceIntent && err.message === 'SHARE_INVALID_CONFIG'` → `degradeToInactive()`(`:654-660`,置灰四组能力并回退表单) |

### 3.4 用户所说「访问密钥启动」的确切入口

```280:289:mail-vue/src/views/share-admin/ShareDetailDrawer.vue
          <el-button
              v-else
              type="primary"
              data-test="authkey-enable"
              :disabled="!writable || authKeyBusy"
              :loading="authKeyBusy"
              @click="submitAuthKey('enable')"
          >
            {{ tf('shareAuthKeyEnable') }}
          </el-button>
```

按钮文案 `shareAuthKeyEnable` = 「启用」(`mail-vue/src/i18n/zh.js:469`),位于「访问密钥」面板(`shareAuthKey` = 「访问密钥」,`zh.js` 同节)—— 与用户口述的「访问密钥启动」对应。

**完整调用链(逐跳带锚点)**:

| 跳 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| 1 点击 | `ShareDetailDrawer.vue:286` `@click="submitAuthKey('enable')"` | `ShareDetailDrawer.vue:756` | ✅ |
| 2 HTTP | `ShareDetailDrawer.vue:765` `resetMailShareAuthKey({shareId, action})` | `mail-worker/src/api/mail-share-api.js:53` `POST /mailShare/resetAuthKey` | ✅ |
| 3 服务 | `mail-share-api.js:55` `mailShareService.resetAuthKey(c, body, userId)` | `mail-share-service.js:1331` | ✅ |
| 4 校验序 | `:1332` action 值域(T11) → `:1334` 归属+ACTIVE(`SHARE_NOT_FOUND`) → `:1335` 迁移守卫(T12) → **`:1338-1340` V2 栅栏(T1/`:1339`)** | — | ⛔ 在此抛出 |
| 5 前端回显 | `mail-share-service.js:81` `BizError('SHARE_INVALID_CONFIG')` | `ShareDetailDrawer.vue:787` `authKeyError` | ✅(但不区分原因) |

**关键排除**:`resetAuthKey` 的 pepper 检查在 `:1350`,位于栅栏 `:1338` **之后**。所以 `SHARE_SEC_PEPPER` 配没配都**不影响**这个错误 —— 请求根本走不到 mint key 那一步。这直接排除了「补 `.dev.vars` 密钥就能修好」的直觉。

### 3.5 候选根因(互斥假设 + 证伪实验)

| ID | 假设 | 置信度 | 判据 | 证伪/证实实验 |
|---|---|---|---|---|
| **H-A** | **`SHARE_CAPABILITY_V2` 未配置/非 true**,`resetAuthKey('enable')` 命中 `:1339` 栅栏 | **~85%** | `isCapabilityV2Enabled` 只认 `'1'/1/true/'true'`(`:67-70`);`wrangler.toml:58` 该变量**整行注释**;用户新建的 `.dev.vars:1-4` **只有四把密钥,没有 `SHARE_CAPABILITY_V2`**;`wrangler-vitest.toml:41` 显式 `"false"` | 在 `.dev.vars` 追加 `SHARE_CAPABILITY_V2 = "true"` 后重启 `wrangler dev`,重点同一按钮。**若转为成功并返回一次性 authKey → H-A 证实**;若仍报同码 → H-A 证伪,转 H-B |
| **H-B** | 行状态漂移:该 share 的 `auth_key_enabled` 已是 1,前端 `detail.authKeyEnabled` 却渲染为假,于是显示「启用」按钮却命中 `:1336` 迁移守卫 | ~10% | `:1335` `share.auth_key_enabled !== move.fromEnabled` 与 T1 **共用同一错误码**,前端无法区分(`:1329-1330` 注释自承「语义只能靠语句顺序保住」) | 直接查库:`SELECT share_id, auth_key_enabled, credentials_version FROM mail_share WHERE share_id=<id>`。**若 `auth_key_enabled=1` → H-B 证实**;若为 0 → 证伪 |
| **H-C** | 前端发出的 `action` 不是精确字符串 `'enable'`(被序列化成数组/带空格),命中 `:1054` T11 | ~3% | `toAuthKeyTransition` 严格枚举,不 trim/不 lowercase | 抓 `POST /mailShare/resetAuthKey` 请求体。**若 `action` 严格等于 `"enable"` → H-C 证伪** |
| **H-D** | 错误码并非来自 resetAuthKey,而是同屏 update 请求(`:747`)的串扰,用户把两条错误看混 | ~2% | 两个入口写的是**不同**的 ref(`configError` vs `authKeyError`),DOM 上是 `data-test="authkey-error"` 与另一处 | 看错误出现在哪个 DOM 节点 + Network 面板确认失败的是哪个 URL。**若失败请求是 `/mailShare/update` → H-D 证实** |

**互斥性说明**:H-A 与 H-B 在代码里是先后两道关(`:1335` 在前、`:1338` 在后),若两者同时成立则先抛 H-B 那条;因此按「先查库(H-B)、再改开关(H-A)」的顺序做实验,可一次性定序。

**尚未证实,不下单一结论**:本次为 read-only 侦察,未启动 `wrangler dev`、未查 D1、未抓包。`unverified: 四条假设均未执行运行时实验`。H-A 的高置信度来自静态证据链完整(变量在 toml 被注释 + `.dev.vars` 无该键 + 代码缺省即 false + 该按钮恰好是 gated intent),但**静态一致 ≠ 运行时证实**。

### 3.6 顺带发现的前端不一致(非本次 bug 根因,但会放大误判)

- `ShareCreateWizard.vue` 会读 `capabilityV2` 状态(`:448` `gatedDisabled`)并在失败后 `degradeToInactive()` 置灰,而 **`ShareDetailDrawer.vue` 完全不 import `capabilityV2`**(grep 该文件零命中)。因此「启用」按钮**永远不会被预置灰**,Owner 只能靠点击失败才知道能力没开。
- `capabilityV2` 是纯前端 ref(`mail-vue/src/views/share-admin/presets.js:30`),**后端没有任何端点下发 V2 开关状态** —— 前端只能「撞墙后才知道」。这是设计上的已知取舍(`presets.js:42` 注释),不是 bug。

---

## 4. 环境变量全清单表

检索范围:`mail-share-service.js`、`share-auth-service.js`、`share-attachment-service.js`、`share-mail-service.js`、`api/share-api.js`、`security/share-rate-limit.js`(用户指定的 6 个文件)+ `api/mail-share-api.js`。
**注**:`share-attachment-service.js` / `share-mail-service.js` / `api/share-api.js` 对 `env.` 的 grep **零命中** —— 这三个文件不直接读环境变量,全部经服务层传入。

| 变量名 | 必需/可选 | 默认值 | 缺失后果 | 读取点 `file:line` | 已在 wrangler.toml / 文档说明? |
|---|---|---|---|---|---|
| `SHARE_SEC_PEPPER` | **必需** | 无 | ① create:`Error('share create pepper missing')` → 500(**非业务码**)<br>② resetAuthKey enable/reset:`Error('share reset auth key pepper missing')` → 500<br>③ 访客建会话:`SHARE_UNAVAILABLE`<br>④ AuthKey 校验:静默 `false`(验不过) | `mail-share-service.js:1121`<br>`mail-share-service.js:1350`<br>`share-auth-service.js:149` | toml ❌ / README ❌ / ADR-boundary:55 ✅ / mail-share design:320 ✅ |
| `SHARE_SESSION_SIGNING_KEY` | **必需** | 无 | 签发访客 token 时 `SHARE_UNAVAILABLE`(`issueToken` `:206-208`) | `share-auth-service.js:158` | toml ❌ / README ❌ / ADR-boundary:55 ✅ / mail-share design:191 ✅ |
| `SHARE_SEC_PEPPER_KID` | 可选 | `'v1'`(写入侧) | 写入侧回落 `'v1'`;验证侧 `collectKeyedSecrets` 也用 `'v1'` 兜底(`:128`)。两侧一致故安全 | `mail-share-service.js:1147`, `:1357`<br>`share-auth-service.js:148` | ❌ 全部未说明 |
| `SHARE_SEC_PEPPER_PREV` | 可选 | 无 | 无。仅供 pepper 轮换重叠窗口;缺失即无旧环,老行的 kid 若已退环则 fail-closed(`:172-176`) | `share-auth-service.js:151` | ❌(design:320 提到轮换模型,未点名变量) |
| `SHARE_SEC_PEPPER_PREV_KID` | 可选 | `'v0'`(`:129`) | 同上 | `share-auth-service.js:150` | ❌ |
| `SHARE_SESSION_SIGNING_KID` | 可选 | `'v1'`(`:128`) | 无。token 头部 kid 回落 `'v1'` | `share-auth-service.js:157` | ❌ |
| `SHARE_SESSION_SIGNING_KEY_PREV` | 可选 | 无 | 无。仅供签名密钥轮换重叠窗口 | `share-auth-service.js:160` | ❌(design:191 提到轮换模型,未点名变量) |
| `SHARE_SESSION_SIGNING_KID_PREV` | 可选 | `'v0'`(`:129`) | 同上 | `share-auth-service.js:159` | ❌ |
| `SHARE_CAPABILITY_V2` | 可选 | **缺失 = false** | 四类 V2 能力写入全部 `SHARE_INVALID_CONFIG`(8 个调用点见 §3.2)。**本次 bug 的头号嫌疑** | `mail-share-service.js:68`(`isCapabilityV2Enabled`) | toml ✅(**但整行注释**,`:58-60`)/ README ❌(仅 `:73` 一句「需平台启用」)/ requirements AC-LIFE-11 ✅ / design:220 ✅ |
| `SHARE_ENABLED` | 可选 | 缺失 = 启用 | 显式 `'0'/0/false/'false'` → Owner 侧 `SHARE_DISABLED`、访客侧 `SHARE_UNAVAILABLE`。冻结语义,非删除 | `mail-share-service.js:54`<br>`share-auth-service.js:63` | toml ❌ / requirements AC-LIFE-07 ✅ |
| `SHARE_PUBLIC_ORIGIN` | 可选 | 回落 `new URL(c.req.url).origin`(`:109-115`),再失败返回 `''` | 分享链接的 origin 取自请求 URL;反代场景下可能生成错误的对外链接 | `mail-share-service.js:105` | ❌ 全部未说明 |
| `SHARE_ACTIVE_LIMIT` | 可选 | 见 `:262`(非数字即不限) | 不限制每用户活跃分享数;配置后超限 `SHARE_LIMIT_EXCEEDED` | `mail-share-service.js:262` | toml ❌ / requirements AC-CAP-11 ✅ |
| `SHARE_MAX_DURATION_SECONDS` | 可选 | 见 `:270`(非数字即不限) | 不限制分享时长;配置后超限 `SHARE_DURATION_EXCEEDED` | `mail-share-service.js:270` | toml ❌ / requirements AC-CAP-11 ✅ / vitest toml `:39` ✅ |
| `SHARE_RETENTION_SECONDS` | 可选 | 见 `:278` | 影响 `delete_at` 计算(过期后物理删除的宽限期) | `mail-share-service.js:278` | ❌ |
| `SHARE_SESSION_TTL` | 可选 | `DEFAULT_SESSION_TTL` = 900s(`:212-213`) | 会话 token 绝对 TTL 用 900s | `share-auth-service.js:212` | toml ❌ / requirements AC-SESS-05 ✅ |
| `SHARE_SESSION_RATE_LIMITER` | 可选(binding) | 无 → **fail-open** | 限流不生效(`share-rate-limit.js:56-58` 显式 fail-open,注释 `:21-23` 说明是为 vitest 与误配部署留活口) | `share-rate-limit.js:76`(`c.env[bindingName]`) | toml ✅ **已生效**(`:12-15`) |
| `SHARE_READ_RATE_LIMITER` | 可选(binding) | 无 → fail-open | 同上 | `share-rate-limit.js:76` | toml ✅ **已生效**(`:17-20`) |
| `kv` | **必需**(binding) | 无 | AuthKey 重放缓存读写失败(`share-auth-service.js:465`, `:487`) | `share-auth-service.js:465`, `:487` | toml **注释态**(`:27-29`),需在 Dashboard 绑定 |
| `db` | **必需**(binding) | 无 | 全线不可用 | 全文件 30+ 处 `c.env.db` | toml **注释态**(`:22-25`) |

**清单口径提醒**:上表「必需/可选」按**代码是否 fail-closed** 判定,不是按业务重要性。`SHARE_SEC_PEPPER` 与 `SHARE_SESSION_SIGNING_KEY` 是仅有的两个「缺失即功能不可用且无默认」的变量 —— 也正是 wrangler.toml 唯独没写的两个。

---

## 5. 已有文档漂移点

已读:`docs/specs/mailbox-share-capability/{requirements,design,tasks}.md`、`docs/specs/mail-share/design.md`、`docs/architecture/ADR-mailbox-share-capability-extension.md`、`docs/architecture/ADR-mail-share-capability-boundary.md`。

| # | 漂移点 | 文档侧锚点 | 代码/配置侧锚点 | 判定 |
|---|---|---|---|---|
| D-1 | **两把必需密钥只活在设计文档,没进部署面**。ADR 把它们列为「运维新增密钥」,tasks.md 标记为已完成,但 `wrangler.toml` 无注释模板、README 无部署说明、无 `.dev.vars.example` | `ADR-mail-share-capability-boundary.md:55`<br>`docs/specs/mail-share/tasks.md:179`<br>`docs/specs/mail-share/design.md:191,320` | `mail-worker/wrangler.toml:51-60`(仅 `SHARE_CAPABILITY_V2` 一条注释)<br>`README.md:73` | **确认漂移**。tasks.md:179 的 `[x]` 覆盖的是「代码里 env + kid 双 key 验签」,不含部署文档 —— 属于交付面缺口而非任务作假 |
| D-2 | **`SHARE_CAPABILITY_V2` 在 toml 中刻意保持注释,但这个决策的理由只写在 toml 注释里,没进 README**。运维照 README 部署会完全不知道有这个开关 | `tasks.md:754`(W0 裁决:「`wrangler.toml` 仅注释声明 `SHARE_CAPABILITY_V2`…禁止 toml 硬写 false 覆盖 dashboard」) | `wrangler.toml:58-60` | **确认,且是有意设计**。`keep_vars = true`(`:4`)下 toml 显式值会覆盖 Dashboard,所以注释是正确做法;缺的是 README 侧的「去 Dashboard 配这个」指引 |
| D-3 | **`SHARE_INVALID_CONFIG` 一码多义在文档中只覆盖了「栅栏 + 值域」两类,实际有第三类** | `design.md:437-438` 列出两行:栅栏 / 配置越域<br>`requirements.md:60` AC-CAP-06 只谈值域 | 实际还有 `:1336` 迁移守卫(T12)、`:1054` action 值域(T11)、`:1016` list status(T10) | **确认漂移**。代码注释 `mail-share-service.js:1329-1330` 自己承认「三者共用一个码,语义只能靠语句顺序保住」,但 design.md 的错误码表没记这一条 |
| D-4 | 前端降级策略在文档中描述为通用行为,实际只有创建向导实现 | `design.md:393`「`SHARE_CAPABILITY_V2=false` 时多邮箱/AuthKey/配额表单项以『能力未激活』置灰」<br>`design.md:437`「前端以『能力未激活』提示」 | `ShareCreateWizard.vue:448,654-660` 实现置灰<br>`ShareDetailDrawer.vue` **不 import `capabilityV2`**,`:787` 只给一句模糊文案 | **确认漂移**。design 的措辞覆盖「表单项」,详情抽屉的 AuthKey 启用按钮不在其字面范围内,但用户体验上就是同一件事 |
| D-5 | `.dev.vars` 未纳入 `.gitignore`,任何文档/规范都未提及本地密钥文件的管理方式 | 全仓无 `.dev.vars` 相关规范(grep `dev.vars` 在 `docs/` 零命中) | 根 `.gitignore`(33 行,无该条)<br>`mail-worker/.gitignore:1`(仅 `.ace-tool/`) | **确认缺口**。见 §2/A4 |
| D-6 | ADR-extension 提到「复用 HMAC+PEPPER 设施」,读者可能误以为复用了既有 jwt 密钥 | `ADR-mailbox-share-capability-extension.md:15` | 实际 pepper 是分享专属新变量;`ADR-boundary:55` 明确「仓内**无**可复用 PEPPER/JWT-kid 设施(`jwt-utils.js:17-20`)」 | **措辞歧义,非事实漂移**。两份 ADR 合读无矛盾:extension 说的「复用」指复用 boundary 期建立的分享自有设施 |

**未漂移(核实通过)**:`SHARE_CAPABILITY_V2` 的四路栅栏语义(design.md:220 / requirements AC-LIFE-11)与代码 `:356/:359/:362/:1339` 一一对应;`message_limit` 第五条也已按 requirements:200 的 ⑤ 接线(`:365/:969`)。栅栏这块文档与代码是同步的。

---

## 6. 真实修改范围建议(供主 AI 决策,本报告不执行)

按 §0.17 商业现实四问过滤后,以下为**已确认存在真实用户损害**的项:

| 项 | 类别 | 依据 |
|---|---|---|
| P0 · `.dev.vars` 加入 `.gitignore` | **B 稳定性保护**(接近 A) | 真实场景:开发者往 `.dev.vars` 填真密钥后 `git add -A`;损害:密钥进版本库不可撤销。现有覆盖:无 |
| P0 · 定位 B 事实根因(先做 §3.5 的 H-B 查库 + H-A 开关实验) | **A 业务必需** | 真实场景:Owner 点「启用」永远失败;损害:AuthKey 功能整体不可用 |
| P1 · `wrangler.toml` 补两把密钥的注释模板 + README 补分享部署段 | **A 业务必需** | 真实场景:新部署者照 README 部署,分享创建直接 500 且响应体无任何线索(A1 已证:文本只进日志);损害:功能不可用且不可自助排障 |
| P2 · `SHARE_INVALID_CONFIG` 语义细分或补 detail 字段 | **B 稳定性保护** | 真实场景:排障者面对 12 个抛出点无法定位。但改错误码会动外部契约,`design.md:437` 与前端三处消费点都要同步 —— 属于「需要单独一轮重构」 |
| — · `ShareDetailDrawer` 接入 `capabilityV2` 预置灰 | **C 商业能力**(按优先级排期) | 真实但轻微:多一次失败点击。**不建议塞进本轮** |

**判为 D(技术整洁强迫症,不建议做)**:统一 `mail-share-service.js:1123` 与 `:1124` 的两个字符串(`share create sec pepper missing` vs `share create pepper missing`)。日志与异常本就可以不同措辞,无真实用户损害。

---

## 7. 遗留与未验证项

- `unverified: 未启动 wrangler dev,未执行 §3.5 任何一项运行时实验`。四个候选假设的置信度均来自静态证据链。
- `unverified: 未查询 D1 中该 share 行的 auth_key_enabled 实际值`(H-B 的判据)。
- `unverified: 未抓取 POST /mailShare/resetAuthKey 的实际请求体`(H-C 的判据)。
- `not applicable: 领域模型对账(Domain-Model Reconciliation)` —— 本次是配置链路核实,未触及数据获取/持久化/渲染中间层的模型变更;且 `docs/specs/mailbox-share-capability/design.md` 已 `status: shipped`,无待对账的模型改动。
- `not applicable: 并行工作包拆分` —— 本次是单线调查任务,主 AI 未要求拆包;真实修改范围见 §6,P0 两项互相独立可并行,P1 依赖 P0 的根因结论。
