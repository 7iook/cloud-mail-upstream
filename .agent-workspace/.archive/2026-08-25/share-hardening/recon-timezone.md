# 侦察报告 · 分享功能的时间序列化与时区契约

- 模式:Mode R(现实核实)· read-only,未修改任何业务代码
- 日期:2026-08-25
- 仓库:`F:\Email\cloud-mail-upstream`(`mail-worker/` · `mail-vue/`)

---

## 0. 一句话结论(先给最反直觉的那条)

用户的现象描述属实(裸串 vs ISO-Z 混用、访客页硬编码按 UTC 解析),但**归因方向是反的**:

- 访客页 `Date.parse(raw + 'Z')` **符合本仓库全局既有约定**(`mail-vue/src/utils/day.js:83-85` 的 `tzDayjs` 对所有后端裸串一律 `dayjs.utc(time)`),它不是错误方。
- **管理台才是真正错的一方**:`share-admin/index.vue:73`、`ShareDetailDrawer.vue:49`、`email/ShareDialog.vue:57` 三处**完全不做任何时区转换**,直接把裸串打到屏幕上。它在本地"看起来对"纯属巧合(本地 worker 恰好写的就是 UTC+8 本地时间);**部署到 Cloudflare 之后(workerd 恒 UTC),这三处会对东八区管理员少显示 8 小时**。
- 根因在后端:`dayjs().format('YYYY-MM-DD HH:mm:ss')` 产出的是**进程本地时区**的裸串,而全仓其它表(如 `email.create_time`,`mail-worker/src/entity/email.js:26` 用 SQLite `CURRENT_TIMESTAMP`)的裸串**恒为 UTC**。分享模块是唯一一个"裸串是否为 UTC 取决于运行环境"的写入方 —— 这就是被破坏的不变量。

---

## 1. 计划假设清单(来自用户观测,逐条待核实)

| # | 假设 | 核实结果 |
|---|---|---|
| A1 | `serverTime` 是带 Z 的 UTC | ✅ 成立 |
| A2 | `expiresAt` 是 `dayjs().format()` 产出的裸串、取进程本地时区 | ✅ 成立 |
| A3 | 前端 `share/index.vue` 约 565 行硬编码按 UTC 解析 | ✅ 成立(真实行号 560-566) |
| A4 | 管理台显示的失效时间是对的 | ❌ **不成立**(局部巧合;生产环境下反而是错的) |
| A5 | 同一响应里混用两种时间格式 | ⚠️ 部分成立:两种格式确实存在,但**不在同一个响应体里**,且 `serverTime` 在生产前端**无任何消费点** |
| A6 | `TZ=UTC` 对 workerd 进程内 `Date` 无影响 | ✅ 成立,且已查明机理(Windows 平台 ICU 忽略 `TZ`) |
| A7 | 生产不受影响 | ⚠️ **仅倒计时与过期判定不受影响;管理台显示在生产环境反而受影响** |

---

## 2. 时间字段产出 / 消费全链路表

### 2.1 后端产出点(全量枚举 · `mail-worker/src/`)

| 字段 / 用途 | 产出点 `file:line` | 表达式 | 产出格式 | 时区归属 |
|---|---|---|---|---|
| `expiresAt`(写库) | `service/mail-share-service.js:1141` | `now.clone().add(...).format('YYYY-MM-DD HH:mm:ss')` | 裸串 | **进程本地** |
| `createdAt`(写库) | `service/mail-share-service.js:1140` | `now.format('YYYY-MM-DD HH:mm:ss')` | 裸串 | **进程本地** |
| `deleteAt`(写库) | `service/mail-share-service.js:1142` | `now.clone().add(...).format(...)` | 裸串 | **进程本地** |
| `now`(比较基准) | `service/mail-share-service.js:49-51` `nowText()` | `dayjs().format('YYYY-MM-DD HH:mm:ss')` | 裸串 | **进程本地** |
| `now`(比较基准) | `service/share-auth-service.js:43-45` `nowText()` | `dayjs().format('YYYY-MM-DD HH:mm:ss')` | 裸串 | **进程本地** |
| 幂等 cutoff | `service/mail-share-service.js:286` | `dayjs().subtract(24,'hour').format(...)` | 裸串 | **进程本地** |
| cron 清理 `now` / cutoff | `service/mail-share-cleanup-service.js:35-36` | `dayjs().format(...)` | 裸串 | **进程本地** |
| `serverTime`(下发) | `api/share-api.js:86` | `new Date().toISOString()` | **ISO-8601 + Z** | **恒 UTC** |
| 观测日志 `ts` | `service/mail-share-service.js:94`、`init/init.js:133` | `new Date().toISOString()` | ISO-8601 + Z | 恒 UTC |
| token `iat`/`exp` | `service/share-auth-service.js:211,265,482` | `Math.floor(Date.now()/1000)` | epoch 秒 | 恒 UTC(无歧义) |
| token `shareExp` | `service/share-auth-service.js:214` | `dayjs(row.expiresAt).unix()` | epoch 秒 | **按进程本地解析裸串** |
| `email.create_time`(对照组) | `entity/email.js:26` | SQLite `CURRENT_TIMESTAMP` | 裸串 | **恒 UTC** ← 全仓约定的来源 |

分享相关之外的同类点(非本次范围,仅记录):`security/security.js:190-194`、`login-service.js:246`(`toISOString`)、`user-service.js:235`、`public-service.js:122`、`verify-record-service.js:59,76`、`analysis-service.js:51-53,82,109`、`reg-key-service.js:39,52,78`、`utils/date-uitil.js:7-13`。其中 `reg-key` / `login` 走的是 `toUtc(...).tz('Asia/Shanghai')`,是**第三种口径**,进一步说明全仓没有单一真源。

### 2.2 DTO 出口(裸串原样透出,不做任何转换)

| 出口 | `file:line` | 说明 |
|---|---|---|
| 访客 session 响应 | `service/share-auth-service.js:404` | `expiresAt: row.expiresAt` |
| ShareContext | `service/share-auth-service.js:364` | `expiresAt: row.expiresAt` |
| Owner 列表行 | `service/mail-share-service.js:401` `toOwnerRow` | `expiresAt: row.expires_at` |
| Owner 列表 DTO | `service/mail-share-service.js:438` | `expiresAt: row.expiresAt` |
| create 首响应 | `service/mail-share-service.js:534` | `expiresAt: row.expires_at` |
| 幂等重放响应 | `service/mail-share-service.js:573` | `expiresAt: rows[0].expires_at` |

### 2.3 前端消费点

| 消费点 `file:line` | 解析方式 | 判定 |
|---|---|---|
| `share/index.vue:560-566` `expiresMs` | `Date.parse(raw.replace(' ','T') + 'Z')` → **强制按 UTC** | ✅ 符合全仓约定 |
| `share/index.vue:568-570` `expiresIso` | 基于上面的 ms 生成 `datetime` 属性 | ✅ 同上 |
| `share/index.vue:572-580` `expiresLabel` | `expiresMs - nowMs`(`nowMs` = `Date.now()`,`:266,:967-969`) | ✅ 两侧同为真 epoch |
| `share-admin/index.vue:73` | `{{ row.expiresAt }}` **原样渲染,零转换** | ❌ 生产环境将少 8 小时 |
| `share-admin/ShareDetailDrawer.vue:49` | `{{ detail.expiresAt }}` **零转换** | ❌ 同上 |
| `email/ShareDialog.vue:57` | `{{ row.expiresAt }}` **零转换** | ❌ 同上 |
| `serverTime` | **无生产消费点** | ⚠️ 死负载(仅 `share/index.spec.js:628` 夹具 + `share/index.vue:966` 注释说明"刻意不用") |
| 对照:`reg-key/index.vue:220-221` | `tzDayjs(expireTime)` = `dayjs.utc(t).tz(local)` | ✅ 全仓标准做法 |
| 对照:`utils/day.js:12-13,68-69,83-85` | 一律 `dayjs.utc(time).tz(timeZone)` | ✅ **约定真源:后端裸串 = UTC** |

---

## 3. ≥3 个互斥根因候选 + 证伪实验

| ID | 假说 | 状态 | 证据 / 证伪实验 |
|---|---|---|---|
| **H-A** | 前端访客页错误地假设裸串是 UTC,应改为按本地解析 | 🔴 **已证伪** | `utils/day.js:83-85` `tzDayjs` 与 `:12-13` `fromNow` 对全部后端裸串一律 `dayjs.utc()`;该约定的物理基础是 `entity/email.js:26` 的 `CURRENT_TIMESTAMP`(SQLite 恒 UTC)。访客页与全仓约定一致,改它等于把唯一正确的消费点改错 |
| **H-B** | 后端 `dayjs().format()` 产出进程本地裸串,破坏了"裸串 = UTC"不变量 | 🟢 **已确认(根因)** | `mail-share-service.js:1139-1142`、`share-auth-service.js:44`、`mail-share-cleanup-service.js:35-36` 均为无 `.utc()` 的 `dayjs()`;`mail-share-service.js:1` / `share-auth-service.js:2` 都是裸 `import dayjs from 'dayjs'`,未挂 utc 插件。用户观测数据自洽:`serverTime`=20:51:42Z,1 小时分享的 `expiresAt`=`2026-08-25 05:47:59`,若按 UTC 应为 `2026-08-24 21:47:59`,实测偏移恰为宿主机 UTC+8 |
| **H-C** | 管理台是对的、访客页是错的 | 🔴 **已证伪且方向相反** | 管理台三处(`share-admin/index.vue:73`、`ShareDetailDrawer.vue:49`、`ShareDialog.vue:57`)**根本没有解析逻辑**,是字符串直出。它与"本地 worker 写本地时间"两个错误相抵才显得正确。**证伪实验**:把 worker 强制跑在 UTC(或直接读生产库的一行 `expires_at`)后打开管理台 —— 东八区管理员会看到比真实失效时刻早 8 小时的字符串 |
| **H-D** | 过期判定(服务端拒绝过期分享)也偏移 8 小时 | 🔴 **已证伪** | 见 §4,所有比较两侧同源同格式 |
| **H-E** | `TZ=UTC` 实验失败说明 workerd 忽略环境变量 | 🟢 **已确认,但机理是 Windows 特有** | 见 §5 |

---

## 4. 过期判定是否受影响 —— 独立结论

**结论:在单一环境内不受影响;跨环境(写入方与读取方时区不同)才会偏移。**

所有过期比较的两侧都来自**同一进程、同一 `dayjs().format('YYYY-MM-DD HH:mm:ss')` 口径**,做的是定长格式的字典序比较,因此自洽:

| 判定点 | `file:line` | 比较式 | `now` 来源 |
|---|---|---|---|
| JS 侧状态机 | `share-auth-service.js:51` | `row.expiresAt <= now` | `:283` → `nowText()` `:44` |
| 配额写入门禁 | `share-auth-service.js:437` | `gt(mailShare.expiresAt, now)` | `:548` → `nowText()` `:44` |
| Owner 侧 SQL 孪生 | `mail-share-service.js:385` | `ms.expires_at <= ?` | `nowText()` `:50` |
| create 活跃额度 | `mail-share-service.js:616` | `expires_at > ?` | `createdAt` `:1140` |
| update 守卫 | `mail-share-service.js:984` | `expires_at > ?` | `nowText()` `:985` |
| loadMutableShare | `mail-share-service.js:1028-1029` | `expires_at > ?` | `nowText()` |
| AuthKey 守卫 | `mail-share-service.js:1067` | `expires_at > ?` | `nowText()` |
| cron 物理清理 | `mail-share-cleanup-service.js:42` | `delete_at <= ?` | `:35` |
| token 有效期 | `share-auth-service.js:214-215` | `dayjs(row.expiresAt).unix()` vs `Date.now()/1000` | 裸串按本地解析,与写入侧同一时区 → 差值恒等于真实剩余秒数 |

代码里已有一条注释显式声明了这个不变量:`mail-share-service.js:381-382`「`expires_at` 与 `now` 同为 `YYYY-MM-DD HH:mm:ss`,字典序比较与 JS 侧逐字一致」。

**残留风险(必须记录)**:该自洽性依赖"写入进程与读取进程处于同一时区"。若某些行由本地 UTC+8 的 wrangler 写入、之后被 UTC 的生产 worker 读取(例如共用同一个远程 D1、或把本地库导入生产),**过期判定会真实偏移 8 小时**(表现为分享提前或延后 8 小时失效)。这是比 UI 显示错更严重的那一类,当前仅因"生产写、生产读"而未暴露。修复 H-B 可从构造上消除。

---

## 5. Cloudflare Workers 运行时时区 —— 权威来源

| 结论 | 来源 |
|---|---|
| 生产 Workers 的 `Date` **恒为 UTC** | Cloudflare 官方文档 <https://developers.cloudflare.com/workers/local-development/> ;workerd 维护者 kentonv 原话「in production, Cloudflare Workers always use UTC as the time zone」 <https://github.com/cloudflare/workerd/issues/2328> |
| workerd 本地运行**曾**继承宿主机时区,导致 dev/prod 漂移 | 同上 issue #2328(2024-06-25 开,2025-04-03 被 kentonv 重开并注明 "Not fixed") |
| 尝试在 workerd 层强制 UTC 的 PR | <https://github.com/cloudflare/workerd/pull/3865>(`v8::Isolate::TimeZoneDetection::kSkip`) |
| miniflare 改为给 workerd 子进程默认 `TZ=UTC` | <https://github.com/cloudflare/workers-sdk/pull/13776> · 发布于 `miniflare@4.20260507.0` <https://github.com/cloudflare/workers-sdk/releases/tag/miniflare%404.20260507.0> |

**本仓库实测(read-only 核实,解释了用户的实验为何失败)**

1. `mail-worker/package.json:6` 的 `dev` 脚本走 `wrangler dev`,`package.json:16` 声明 `wrangler ^4.90.0`;`node_modules/wrangler/package.json` 实装 `4.90.0` → 依赖 `miniflare 4.20260507.1`。
2. 该 miniflare **确实带了修复**:`node_modules/.pnpm/miniflare@4.20260507.1/.../dist/src/index.js:69743` 存在 `TZ: "UTC",`,`:69745` 为 `...options.runtimeEnv`。
3. 但 **`TZ` 在 Windows 上对 V8/ICU 无效**:ICU 的 `detectHostTimeZone()` 走 `uprv_detectWindowsTimeZone()` → Windows `GetDynamicTimeZoneInformation()`,**始终返回系统时区,完全忽略 `TZ` 环境变量**(nodejs/node#4230 的根因分析:<https://github.com/nodejs/node/issues/4230>;Node.js 是在 `src/node_i18n.cc` 里自己额外调 `adoptDefault` 才绕过的 —— 见 <https://github.com/nodejs/node/pull/38642>,workerd 无此补丁)。
4. 另一条独立风险:`mail-worker/package.json:20` 的 `@cloudflare/vite-plugin@1.6.0` 依赖的是 **`miniflare 4.20250604.1`**(`pnpm-lock.yaml:3006`),`@cloudflare/vitest-pool-workers` 依赖 `miniflare 3.20250310.0`(`:3027`),两者都**早于**修复版本。走 vite 插件或跑 vitest 时,即使在 Linux/macOS 上也拿不到 `TZ=UTC` 默认值。

**因此**:「生产不受影响」对**倒计时与过期判定**而言是**已证实的事实**(生产恒 UTC + 访客页按 UTC 解析 → 一致);但对**管理台显示**而言恰恰相反 —— 生产恒 UTC 才使管理台的零转换渲染暴露为真实缺陷。

---

## 6. 架构 / 前提质疑 + 业务现实检查

### 6.1 架构层建议:这是 SSOT 缺失,不是一个显示 bug

真正的问题 X 不是"访客页多 8 小时",而是:**本仓库对"DB 裸时间串代表哪个时区"没有单一真源**,目前并存三种口径 ——
① SQLite `CURRENT_TIMESTAMP`(恒 UTC,`entity/email.js:26`);
② JS `dayjs().format()`(进程本地,分享模块全部写入点);
③ `toUtc(x).tz('Asia/Shanghai')`(硬编码东八区,`login-service.js:171,193`、`reg-key-service.js:78`)。

前端 `utils/day.js` 单方面假定了口径 ①。分享模块用了口径 ②,只因生产 workerd 恰为 UTC 才与 ① 等价 —— **正确性建立在运行时的偶然属性上,而不是建立在代码的显式契约上**。`share/index.vue:557-559` 那段注释("expires_at is a bare ... the worker wrote in UTC")把这个隐式依赖写成了断言,但代码里没有任何东西保证它。

建议在修复的同时,把该不变量落成显式契约(见 §8),否则下一个写时间字段的人会再踩一次。

### 6.2 业务现实检查(§0.17)

本次不新建能力,只纠正既有输出/消费口径,四问从简:

| 项 | 判定 |
|---|---|
| 管理台时间显示纠正 | **A 业务必需** —— 管理员据此判断分享何时失效并决定是否续期/撤销;显示早 8 小时会导致误判"已过期"而重复创建分享(消耗 `activeLimit`),或误判"还有效"而未及时撤销 |
| 后端写入口径 UTC 化 | **B 稳定性防护** —— 消除跨环境数据(本地写 / 生产读)导致过期判定真实偏移的隐患,见 §4 残留风险 |
| 移除或消费 `serverTime` | **D 技术整洁**(倾向不动) —— `share/index.vue:966` 已显式记录"对齐 serverTime 只多一个 ref、不换来可见的正确性"。它是死负载但无业务损害,**不建议在本轮顺手删**:删了要同步改 `share/index.spec.js:628` 夹具,收益为零。仅在报告中登记 |

---

## 7. 真实修改范围

| # | 位置 | 动作 |
|---|---|---|
| R1 | `mail-share-service.js:1139-1142`、`:49-51`、`:286` | 写入 / 比较基准改为显式 UTC |
| R2 | `share-auth-service.js:43-45`、`:214` | 同上(`:214` 的 `dayjs(row.expiresAt)` 需按 UTC 解析) |
| R3 | `mail-share-cleanup-service.js:35-36` | 同上 |
| R4 | 上述三文件的 `import dayjs from 'dayjs'`(`mail-share-service.js:1`、`share-auth-service.js:2`、cleanup 同) | **必须补 `dayjs/plugin/utc` 的 `extend`** —— 现无任何一处在这三个模块里挂过 utc 插件(`utils/date-uitil.js:1-5` 挂了,但这三个模块没 import 它,不能依赖副作用) |
| R5 | `share-admin/index.vue:73`、`ShareDetailDrawer.vue:49`、`email/ShareDialog.vue:57` | 改用 `tzDayjs(...)`(`utils/day.js:83`)渲染 |
| R6(可选,契约路径) | `share-auth-service.js:364,404`、`mail-share-service.js:401,438,534,573` | DTO 出口序列化为 ISO-8601 带 Z |
| R7(伴随 R6) | `share/index.vue:560-566` 去掉硬编码 `'Z'`;`share/index.spec.js:1439-1468` 基线需同步 | |
| **不改** | 数据库存储格式 `YYYY-MM-DD HH:mm:ss` | **硬约束**:`mail-share-service.js:385,616,984,1028,1067`、`share-auth-service.js:437`、`cleanup:42` 全部依赖定长字典序比较,改存储格式会同时打破 SQL 与 JS 两侧的比较语义(`:381-382` 注释已声明) |

---

## 8. 修复方案候选与收益/代价对比

### 方案甲:后端写入口径显式 UTC 化(R1-R4)—— **上游根因修**

`dayjs()` → `dayjs.utc()`,存储格式与 SQL 比较完全不动。

- **收益**:让"DB 裸串 = UTC"从"依赖 workerd 恰好是 UTC"变成**由代码保证**;与 `email.create_time` 的 `CURRENT_TIMESTAMP` 口径统一;消除 §4 的跨环境过期偏移隐患;本地 dev 与生产行为一致(Windows 上也一致,不依赖 `TZ`);访客页现有解析立即变成有据可依而非侥幸。
- **代价**:6-8 处单行改动 + 3 个模块补 utc 插件 import;存量行**零迁移**(生产行本来就是 UTC);本地开发库里已有的 UTC+8 行会显示为"晚 8 小时",属于脏数据,可忽略或清库。
- **风险**:低。若漏挂 utc 插件,`dayjs.utc` 是 undefined,会立刻抛错而非静默出错 —— 失败模式是响亮的。

### 方案乙:前端容错解析(R5)—— **必需的下游修,但单独做不够**

管理台三处改用 `tzDayjs(row.expiresAt)`。

- **收益**:直接修好 §0 指出的**生产环境真实缺陷**(管理台少 8 小时);与 `reg-key/index.vue:220-221` 的既有做法一致,零新概念。
- **代价**:3 处单行改动。
- **局限**:它假定裸串是 UTC —— 在方案甲落地前,这个假定在本地 dev 仍然不成立,会把管理台从"本地对/生产错"翻成"本地错/生产对"。**单独实施会让本地开发体验变差,必须与甲同批**。

### 方案丙:DTO 出口改为 ISO-8601 带 Z(R6-R7)—— 契约显式化

- **收益**:线上契约自解释,前端不再需要任何"我知道它是 UTC"的隐式知识;`serverTime` 与 `expiresAt` 格式统一,消除用户观测到的"混用"。
- **代价**:改动面最大(6 个 DTO 出口 + 前端解析 + 至少 `share/index.spec.js:1439-1468` 与 `share-admin/*.spec.js`、`ShareDialog.spec.js`、`ShareCreateWizard.spec.js` 里 6+ 处 `'2026-08-18 01:00:00'` 形态的夹具);属于对外响应契约变更,老前端拿到新格式会怎样需要单独评估。
- **注意**:丙**不能替代甲**。即使出口转成 ISO-Z,转换时仍要知道裸串是哪个时区 —— 不修甲就只是把同一个歧义搬到了序列化层。

### 推荐次序

**甲(上游根因)+ 乙(修复生产可见缺陷)同批交付;丙 作为独立的契约演进单独排期。**
理由:甲把不变量变成代码保证,乙修好用户真正会受损的那一面,两者合计约 10 处单行改动、零迁移、零契约变更;丙收益是"可读性/自解释",但要动对外响应格式和 6+ 个测试基线,风险收益比不适合与 bug 修复混在同一轮。

---

## 9. 可并行工作包拆分

| 包 | 范围 | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|
| **W1** | `mail-share-service.js`、`share-auth-service.js`、`mail-share-cleanup-service.js`(R1-R4) | 后端写入/比较口径显式 UTC + 补 utc 插件 | 无 | ✅ | 1 |
| **W2** | `share-admin/index.vue`、`ShareDetailDrawer.vue`、`email/ShareDialog.vue`(R5) | 管理台三处改 `tzDayjs` | 无(与 W1 文件零重叠) | ✅ 与 W1 并行 | 1 |
| **W3** | `mail-worker` 侧回归测试 | 为 §4 的跨环境偏移补一条红测(非 UTC 宿主下创建→UTC 下判定) | 依赖 W1 | ❌ 串行于 W1 | 1 |
| **W4**(可选) | 契约文档 / `ARCHITECTURE.md` | 落一条「DB 裸 datetime 串一律 UTC」的显式约定 | 无 | ✅ | 1 |

**风险交叉区**:W1 与 W3 同文件族,必须串行。W1/W2 分属 `mail-worker/` 与 `mail-vue/`,无交叉,可安全并行。W2 若先于 W1 合并,本地 dev 的管理台会短暂显示错误(见方案乙局限),建议两包同批合入。

---

## 10. 链路完整性扫描(§0.16)

| 节点 | 生产方 `file:line` | 消费方 `file:line` | 状态 |
|---|---|---|---|
| 创建时刻 → `expires_at` 落库 | `mail-share-service.js:1141` | `prepareShareInsert` `:600,633` | ✅ 完整 |
| `expires_at` → 访客 session 响应 | `share-auth-service.js:404` | `share/index.vue:602` `applyShareConfig` | ✅ 完整 |
| 访客响应 → 倒计时渲染 | `share/index.vue:560-566` | `:572-580` `expiresLabel` | ✅ 完整(解析口径正确) |
| `expires_at` → Owner 列表 DTO | `mail-share-service.js:401,438` | `share-admin/index.vue:73` | ⛔ **断点:消费方缺时区转换** |
| `expires_at` → Owner 详情 DTO | `mail-share-service.js:401`(经详情装配) | `ShareDetailDrawer.vue:49` | ⛔ **断点:同上** |
| `expires_at` → create 首响应 | `mail-share-service.js:534` | `email/ShareDialog.vue:57` | ⛔ **断点:同上** |
| `serverTime` → ? | `api/share-api.js:86` | **无生产消费方** | ⚠️ 死负载(已在 §6.2 判定为 D 类,本轮不动) |

**下游消费方前置条件锚点(唯一可自行推导的成功态来源)**:`mail-vue/src/utils/day.js:83-85` —— `tzDayjs(time) => dayjs.utc(time).tz(timeZone)` 要求**一切后端裸时间串必须是 UTC**。这就是本次修复的成功态判据:`NOT「访客页倒计时数字变小了」,BUT「东八区的管理员和访客,在本地 dev 与 Cloudflare 生产两个环境下,看到的失效时刻都等于真实失效时刻」`;负条件:**不得**通过改动 `share/index.vue` 的 UTC 解析来"对齐"本地环境。

---

## 11. 领域模型对账(§4.5)

`docs/domain/` 下无分享子系统模型文档(未找到)。本次触及的是**跨切面时间序列化口径**,建议由主 AI 在 W4 里把以下最小基线落成显式约定:

- **不变量 I-1**:D1 中一切 `TEXT` 型 datetime 列(格式 `YYYY-MM-DD HH:mm:ss`)其值**恒为 UTC**。
- **不变量 I-2**:存储格式固定为定长 `YYYY-MM-DD HH:mm:ss`,以保证 SQL 字典序比较等价于时间序比较(依赖方见 §7「不改」行)。
- **不变量 I-3**:前端**不得**直接渲染后端 datetime 裸串,必须经 `utils/day.js` 的 `tzDayjs` / `fromNow` / `formatDetailDate` 转换。
- 现存违反:I-1 被 `login-service.js:171,193`、`reg-key-service.js:78` 的硬编码 `Asia/Shanghai` 口径违反(本次范围外,登记为技术债);I-3 被 §10 的三个断点违反(本次修复)。
