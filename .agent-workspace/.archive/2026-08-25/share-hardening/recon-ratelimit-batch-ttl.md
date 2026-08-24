# 侦察报告 · 分享访问速率限制 / 批量创建 API / 有效期上限

- 模式：**Mode R（现实核实）** · read-only，未修改任何业务代码
- 日期：2026-08-25 · 仓库 `F:\Email\cloud-mail-upstream`
- 侦察手段：`git ls-files` + Grep（全仓正则）+ 逐文件精读；`codegraph` 本仓未建索引（按 `.cursor/rules/10-cursor-tooling.mdc` 直接回退 Grep，不重试）
- 需求三项：① 复用登录侧 CF 能力做分享访问的验证码/频率配置 ② 批量创建指定邮箱的分享链接 ③ 突破 7 天有效期上限

---

## 1. 计划假设清单（从用户三条原话反推出的、可能被现实推翻的假设）

| # | 假设 | 出处 |
|---|---|---|
| H1 | 「项目**登录**模块已有现成 CF 能力」——登录接口受 CF 人机验证保护 | 需求 1 |
| H2 | 该「CF 能力」是一套可复用的**限流 + 验证码**设施 | 需求 1 |
| H3 | 分享侧目前**没有**频率保护，需要新建 | 需求 1 |
| H4 | 「触发频率配置」可以做成运行时可配（后台设置项） | 需求 1 |
| H5 | 创建分享的 API 只收单个邮箱，需要补批量能力 | 需求 2 |
| H6 | 分享有「多种类型」（单邮件 / 邮箱 / 目录），批量要兼容全部 | 需求 2 |
| H7 | 有效期上限 7 天是**后端**校验 | 需求 3 |
| H8 | 7 天是一条有意的安全决策 | 需求 3 |
| H9 | 访客会话 token 有独立 TTL 上限，会卡住更长有效期 | 需求 3 |

---

## 2. 现实核实（plan vs reality）

| # | 判定 | 证据锚点 |
|---|---|---|
| H1 | **[偏差]** 登录 `POST /login` **完全不过** Turnstile。受保护的是**注册**与**加邮箱**两条路径 | `mail-worker/src/service/login-service.js:115-127`（register 内）；`mail-worker/src/service/account-service.js:79-92`；`login-service.js` 的 `login()` 分支（:224 前后）只做密码校验，无 turnstile 调用 |
| H2 | **[部分偏差]** 「CF 能力」实为 **Cloudflare Turnstile 人机验证**（`turnstile-service.js`）；它**不是限流**。限流是另一套自建 D1 计数器 | `mail-worker/src/service/turnstile-service.js:5-33`；`mail-worker/src/service/verify-record-service.js:19-86` |
| H3 | **[偏差]** 分享侧**已有**限流，而且用的是 **CF 官方 Rate Limiting binding**，比登录侧更"CF 原生" | `mail-worker/src/security/share-rate-limit.js:1-83`；`mail-worker/wrangler.toml:12-20` |
| H4 | **[偏差·硬约束]** CF Rate Limiting binding 的 `limit`/`period` 只能写在 `wrangler.toml`，**运行时不可读不可改**，且 `period` 只能是 10 或 60 秒 | `share-rate-limit.js:9-27`（模块头契约注释，明确写"Periods other than 10 or 60 seconds (platform constraint)"）；`wrangler.toml:10-20` |
| H5 | **[已存在]** `POST /mailShare/create` **早已支持 `accountIds` 数组**（旧 `accountId` 单值兼容回落），上限 50 | `mail-worker/src/service/mail-share-service.js:187-190`（`toAccountIdSet`）、`:15`（`SHARE_BINDING_LIMIT = 50`）、`:335-345` |
| H6 | **[偏差]** 分享**只有一种对象：邮箱（account）**。`shareType` 枚举只有 `single` / `multi` 两个取值，且**不落库**，由绑定数实时派生。没有"单邮件分享 / 目录分享" | `mail-share-service.js:473-476`（`shareTypeOf`：`bindings.length > 1 ? 'multi' : 'single'`）；`share-auth-service.js:399` 同口径 |
| H7 | **[偏差]** 后端上限来自可选环境变量 `SHARE_MAX_DURATION_SECONDS`，**未配置即无上限**；生产 `wrangler.toml` 的 `[vars]` 里**根本没有这一项** | `mail-share-service.js:269-275`（未配置返回 `null`）、`:338-342`；`mail-worker/wrangler.toml:51-60`（`[vars]` 全是注释，无该变量） |
| H8 | **[偏差]** 7 天不是安全决策，是**前端下拉框的最大档位**（1h / 6h / 1d / 7d 四档写死） | `mail-vue/src/views/email/ShareDialog.vue:124-129`；`mail-vue/src/views/share-admin/ShareCreateWizard.vue:413-418` |
| H9 | **[偏差·但有另一种耦合]** 会话 token TTL 取 `min(分享到期时间, 签发时刻+TTL)`，**不构成有效期上限**；真正的耦合是"每 15 分钟重建会话 → 每次重建 `access_count+1`"消耗 `maxSessions` 配额 | `share-auth-service.js:21`（`DEFAULT_SESSION_TTL = 900`）、`:212-218`（`exp = Math.min(shareExp, iat + ttl)`）、`:430-442`（`consumeSessionQuota`）、`:551` |

---

## 3. 既有能力清单 + 双源风险判定

### 3.1 CF 验证码（Turnstile）既有实现

| 面 | 位置 | 说明 |
|---|---|---|
| 后端校验 | `mail-worker/src/service/turnstile-service.js:5-33` | `POST challenges.cloudflare.com/turnstile/v0/siteverify`，失败抛 `botVerifyFail` |
| **密钥来源** | `turnstile-service.js:13,21` → `settingService.query(c).secretKey` | **不是 env 变量，是 D1 `setting` 表的列** |
| 密钥列定义 | `mail-worker/src/entity/setting.js:15-16` | `secret_key` / `site_key`（均可为 NULL） |
| 密钥下发 | `mail-worker/src/service/setting-service.js:92-95` | `siteKey` 仅管理员可见明文，`secretKey` **恒掩码** |
| 前端 siteKey 下发 | `setting-service.js:215`（`websiteConfig`） | 匿名可读 `siteKey` |
| 前端脚本 | `mail-vue/index.html:20-24` | 全站已异步加载 turnstile api.js（**分享页同样能拿到，无需新增引入**） |
| 前端挂载点 1（注册） | `mail-vue/src/views/login/index.vue:84-93` | `data-sitekey` + `onTurnstileSuccess` 回调 |
| 前端挂载点 2（加邮箱） | `mail-vue/src/layout/account/index.vue:110,461` | 同款 |
| 开关枚举 | `mail-worker/src/const/entity-const.js:97-106` | `registerVerify` / `addEmailVerify`：`OPEN=0` / `CLOSE=1` / `COUNT=2` |
| 阈值配置 | `mail-worker/src/entity/setting.js:9-12` | `register_verify` / `add_email_verify` / `reg_verify_count` / `add_verify_count` |
| 后台 UI | `mail-vue/src/views/sys-setting/index.vue:294,313,326-335,471-474,637-648` | 三态下拉 + 阈值弹窗 + Site/Secret Key 录入 |

**「触发频率」的既有语义要看清**：`COUNT` 模式的计数器是 **D1 表 `verify_record` 按 IP 累计**（`verify-record-service.js:19-34` 读、`:54-86` 自增），**只增不减、没有时间窗**——达到阈值后对该 IP **永久开启**验证码，只能靠 `clearRecord()` 全表清零（`verify-record-service.js:15-17`）。它是"累计次数门槛"，**不是"每分钟 N 次"的速率限制**。若直接照搬到分享侧，语义会与用户想要的"触发频率"错位。

### 3.2 分享侧限流现状

| 项 | 结论 | 锚点 |
|---|---|---|
| 实现方式 | **CF 官方 Rate Limiting binding**（`env[bindingName].limit({key})`） | `share-rate-limit.js:55-72` |
| 保护端点 | `POST /share/session`（10 次/60s）；`GET /share/mails`、`/share/mailboxes/status`、`/share/mail`、`/share/attachment`（合计 100 次/60s，共用一个 binding） | `share-api.js:55,65,83,89,99`；`wrangler.toml:12-20` |
| 算法 / key | 纯 `CF-Connecting-IP`，显式忽略 `X-Forwarded-For`；**不按 lid 锁**（避免第三方 DoS 真实收件人） | `share-rate-limit.js:4-12,37-46` |
| 拒绝形态 | 返回 `Response` 而非抛错（绕开 hono onError 改写），HTTP 429 + `Retry-After` + `Cache-Control: no-store` | `share-rate-limit.js:48-53` |
| 缺失 binding 时 | **fail-open**（vitest / 误配部署不至于打死分享） | `share-rate-limit.js:56-58` |
| 可配置性 | **零运行时配置**。数值散落在 5 个 wrangler 文件 | `wrangler.toml:12-20`、`wrangler-dev.toml:9-16`、`wrangler-test.toml:9-16`、`wrangler-action.toml:8-15`；`wrangler-vitest.toml:6-7` 故意不配 |
| 前端 429 处理 | 已有 `ShareRateLimitedError` + `Retry-After` 解析 | `mail-vue/src/request/share.js:7-37,148-155` |
| 验证码 | **完全没有**。`establishSession` 只校验 `lid`+`sec`(+可选 `authKey`) | `share-auth-service.js:498-574` |
| Owner 侧创建 | `POST /mailShare/create` **完全没有任何限流**，只有登录鉴权 + `share:manage` 权限 | `mail-worker/src/security/security.js:73-81,112-121`；`mail-share-api.js:23-28` |

### 3.3 双源风险判定（P-08）

**当前是两套完全独立的机制，但它们保护的是不同的东西，本身不构成双源：**

- 登录/注册侧：Turnstile（**人机验证**）+ D1 IP 累计计数（**触发门槛**）
- 分享访客侧：CF Rate Limiting binding（**速率限制**），无人机验证

**真正的矛盾在需求 1 的第二半句「触发频率配置」**：

- 若把频率配置做成 DB `setting` 列（与登录侧同款后台可配），就会出现**两个真源**：`wrangler.toml` 的 `[[ratelimits]]` 静态配置 vs DB 配置项。CF binding 的 `limit`/`period` 在运行时**读不到也改不了**，DB 里那个数字永远只是"另一个数字"，二者必然漂移。这是本轮最明确的 P-08 风险。
- 「复用 Turnstile 做分享页验证码」**不构成双源**（分享侧当前无验证码，是纯新增），可行且改动面小。

**取舍建议（供主 AI / 用户裁决，不代裁）**：

| 方案 | 频率控制放在哪 | 与 CF binding 的关系 | 代价 |
|---|---|---|---|
| R1 保守 | 保持 CF binding 为唯一速率真源，**只**新增"验证码开关"（DB 可配）；频率数值仍改 `wrangler.toml`（需重新部署） | 单真源 ✅ | 频率不可热配，需要改 5 个 toml（见 §7 风险交叉区） |
| R2 分层 | CF binding 作为**硬顶**不动；新增一层 DB 可配的「软阈值」——同 IP 在 N 秒内第 M 次 `establish` 起要求 Turnstile（走 KV 或 D1 计数） | 语义分层，非同一维度双源 ⚠️ 需在文档写死"CF binding = 硬顶、DB = 验证码触发阈值"，否则后人会当成两个限流 | 新增一个计数器（KV 或复用 `verify_record` 加 type）；Workers KV 计数非原子，`share-rate-limit.js:5-7` 的注释明确点名反对用 KV/D1 做限流计数 |
| R3 激进 | 弃用 CF binding，全部自建可配限流 | 单真源 ✅ 但**倒退**：放弃 CF 边缘原生能力，回到被自己注释否定过的 KV/D1 计数 | 不推荐；`share-rate-limit.js:1-28` 的整段契约注释就是当初否决它的记录 |

---

## 4. 分享 API 端点全表 + 类型枚举 + 批量方案

### 4.1 Owner 侧端点（`mail-worker/src/api/mail-share-api.js`，全部需登录 + `share:manage`）

| 方法 | 路径 | 行 | 入参 | 出参 |
|---|---|---|---|---|
| POST | `/mailShare/create` | `:23-28` | body：`accountIds[]`(或旧 `accountId` 单值)、`durationSeconds`、`name?`、`remark?`、`maxSessions?`、`messageLimit?`、`onlyMessagesAfterCreated?`、`otpExtractionEnabled?`、`autoRefresh?`、`refreshIntervalMs?`、`showFullAddress?`、`authKeyEnabled?`；头 `Idempotency-Key` | `{shareId, lid, sec(仅首次), expiresAt, shareUrl, shareType, bindings[], authKey?}`；重放含 `idempotentReplay:true` 且无 `sec` |
| GET | `/mailShare/list` | `:30-33` | query：`page?`、`size?`(默认20/上限100)、`status?` | `{list[], total, page?, size?, deprecated?}` |
| GET | `/mailShare/get` | `:35-38` | query：`shareId` | 详情（列表行 + `bindings[]`） |
| PUT | `/mailShare/update` | `:40-44` | body：`shareId` + 白名单字段（`name/remark/maxSessions/messageLimit/otpExtractionEnabled/autoRefresh/refreshIntervalMs/showFullAddress`） | 详情 |
| DELETE | `/mailShare/delete` | `:46-49` | query：`shareId` | `{shareId}`（物理删除） |
| POST | `/mailShare/resetAuthKey` | `:53-57` | body：`shareId`、`action`(`enable`/`reset`/`disable`) | 详情 + `authKey`(仅 enable/reset) |
| PUT | `/mailShare/bindings` | `:59-63` | body：`shareId`、`add[]`、`remove[]` | `{shareId, status, shareType, bindings[]}` |
| DELETE | `/mailShare/revoke` | `:65-68` | query：`shareId` | `{shareId}`（置 REVOKED） |

### 4.2 访客侧端点（`mail-worker/src/api/share-api.js`，匿名，`security.js:23-30` 白名单）

| 方法 | 路径 | 行 | 限流 |
|---|---|---|---|
| POST | `/share/session` | `:55-63` | `SHARE_SESSION_RATE_LIMITER` 10/60s |
| GET | `/share/mails` | `:65-78` | `SHARE_READ_RATE_LIMITER` 100/60s |
| GET | `/share/mailboxes/status` | `:83-87` | 同上 |
| GET | `/share/mail` | `:89-97` | 同上 |
| GET | `/share/attachment` | `:99-106` | 同上 |

### 4.3 「类型」枚举核实

- **`shareType` 只有两个取值：`'single'` / `'multi'`**，定义在 `mail-share-service.js:474-476`（`shareTypeOf(bindings)`），孪生实现 `share-auth-service.js:399`。**不落库、无 DB 列、无 const 枚举文件**。
- 未检索到 `scope` / `kind` 之类的分享分类枚举（全仓 Grep 无命中）。
- **分享对象恒为「邮箱（account）」**——不存在"单邮件分享"或"目录分享"。`ShareDialog.vue` 从邮箱视角创建，`ShareCreateWizard.vue` 多选邮箱。
- 与「类型」相关的、真正的正交维度是**配置组合**：`authKeyEnabled`（访问密钥）、`maxSessions`（会话配额）、`messageLimit`（可见邮件条数）、`onlyMessagesAfterCreated`（窗口下界）、`showFullAddress`、`autoRefresh`/`refreshIntervalMs`。
- **发布栅栏 `SHARE_CAPABILITY_V2`**：`accountIds.length > 1`、`authKeyEnabled`、有限 `maxSessions`、有限 `messageLimit` 四条写入都要求 `SHARE_CAPABILITY_V2=true`，否则 `SHARE_INVALID_CONFIG`（`mail-share-service.js:355-366`、`:67-82`）。而 `wrangler.toml:58-60` 该变量**被注释掉、默认 false**。→ **当前生产部署下，多邮箱创建是被栅栏挡住的**，这是批量需求的前置阻塞。

### 4.4 关键歧义（必须先澄清才能定方案）

用户说「批量创建**指定邮箱**的分享链接」，代码里有两种截然不同的语义：

- **语义 A（已实现）**：一条分享绑 N 个邮箱 → **1 个 lid/sec，1 条链接**，访客一个页面切换多个邮箱。这就是现有 `accountIds[]` + `shareType='multi'`。
- **语义 B（未实现）**：为 N 个邮箱各建一条独立分享 → **N 个 lid/sec，N 条链接**，可分发给 N 个不同的人。

从「批量创建**链接**」（复数链接）的措辞看，用户大概率要的是 **B**。**B 目前 API 不支持**：单次 `create` 只产出一条 `mail_share` 行、一个 `Idempotency-Key`、一份 `sec`。

### 4.5 批量创建（语义 B）方案对比

| | 方案 P1：新增 `POST /mailShare/batchCreate` | 方案 P2：改造现有 `create` 加 `splitPerAccount` 标志 | 方案 P3：前端循环调用现有单条 create |
|---|---|---|---|
| 改动面 | 新端点 + `security.js` 两张表各加一行 + `premKey['share:manage']` 加一项（`security.js:73-81,112-121` 必须同步，注释 `:109-111` 明确警告）+ service 新方法 + 前端新方法 | `mail-share-api.js:23-28` 不动，`mail-share-service.create` 内部分叉 | 零后端改动，只改 `ShareCreateWizard.vue` + `mail-share.js` |
| 幂等 | 需要新语义：一个批次 key + 每条子 key（或 `key#index`）。现有 `share_idempotency` 表是 `(user_id, idempotency_key, operation)` 唯一，可用 `operation='batch_create'` 复用 | **风险大**：`normalizeCreateBody` 的字段顺序是幂等指纹的一部分（`:192-212` 注释明确"不许改"），加字段即改指纹，会打断滚动发布兼容（`legacyCompatibleBody` `:228-246`） | 天然：每条一个 key，复用现有全部逻辑 |
| 部分失败语义 | 可设计：`{created[], failed[{accountId, code}]}`，或全有或全无（D1 `batch()` 单事务，但 N×3 条语句可能撞 D1 单语句 100 绑定参数上限，见 `:299-302` 注释） | 同左 | 逐条独立，天然部分成功；前端需自己聚合与重试 |
| 响应体 `sec` 明文 | N 份 `sec` 一次性返回，泄露面 N 倍。需 UI 一次性展示 N 条链接（复制/导出） | 同左 | 同左 |
| V2 栅栏 | 语义 B 每条都是单邮箱 → **不触发 `MULTI_CREATE` 栅栏**，可在 V2=false 下工作 ✅ | 同左 | 同左 ✅ |
| 限流 | 需要新增 owner 侧限流（当前 create 零限流，N 条批量放大滥用面） | 同左 | **最危险**：前端循环 = N 次 HTTP，零服务端节流 |
| 取舍 | 契约清晰、可原子化、可单独限流；成本最高 | 不推荐——动幂等指纹是本仓明确标注的红线 | 最快落地，但把事务性/限流/重试全部推给前端，且 N 大时体验与可靠性差 |

**倾向**：P1（新端点）。理由是它避开了幂等指纹红线，且能就地为批量单独定限流与部分失败契约。但**这是建议，方向由主 AI / 用户裁定**。

---

## 5. 有效期 7 天的**全部**约束点表

| # | 层 | 位置 | 约束内容 | 是否真上限 |
|---|---|---|---|---|
| 1 | 前端 · 旧对话框 | `mail-vue/src/views/email/ShareDialog.vue:124-129` | `durationOptions` 四档写死，max `604800` | ✅ **有效上限**（`el-select` 固定选项，无自定义输入） |
| 2 | 前端 · 新向导 | `mail-vue/src/views/share-admin/ShareCreateWizard.vue:413-418` | `DURATION_OPTIONS` 同四档 | ✅ **有效上限** |
| 3 | 前端 · 向导控件 | `ShareCreateWizard.vue:141-154` | `el-select` + `el-option` 循环，无 `allow-create` | ✅ 结构性限制 |
| 4 | 前端 · 校验 | `ShareCreateWizard.vue:604-606` | 仅 `Number(durationSeconds) > 0` | ❌ 无上限 |
| 5 | 前端 · 文案 | `mail-vue/src/i18n/zh.js:350`、`en.js:350` | `shareDuration7d: '7 天' / '7 days'` | ❌ 仅文案（改档位需同步） |
| 6 | 后端 · 读配置 | `mail-worker/src/service/mail-share-service.js:269-275` | `SHARE_MAX_DURATION_SECONDS`，**未配置返回 `null` = 无上限** | ⚠️ 条件性 |
| 7 | 后端 · 校验 | `mail-share-service.js:338-342` | `durationSeconds <= 0` 或 `> maxDuration` → `SHARE_DURATION_EXCEEDED` | ⚠️ 条件性 |
| 8 | 部署配置 · 生产 | `mail-worker/wrangler.toml:51-60` | `[vars]` 中**没有** `SHARE_MAX_DURATION_SECONDS` | → 生产**后端无上限** |
| 9 | 部署配置 · 单测 | `mail-worker/wrangler-vitest.toml:39` | `SHARE_MAX_DURATION_SECONDS = "86400"`（1 天） | 测试基线 |
| 10 | 部署配置 · E2E | `tests/e2e/wrangler-e2e.toml:34` | 同 `86400` | 测试基线 |
| 11 | 测试夹具 | `mail-worker/test/mail-share-service.spec.js:38`、`test/account-delete-share.spec.js:38` | `SHARE_MAX_DURATION_SECONDS: '86400'` | 测试基线 |
| 12 | 测试断言 | `mail-worker/test/mail-share-service.spec.js:306-315`、`test/share-api.spec.js:498` | 覆写为 `'60'` 断言 61 秒被拒；`durationSeconds: 999999` 断言超限 | **改上限逻辑会打红这些用例** |
| 13 | DB schema | `mail-worker/src/init/init.js:152-153`、`mail-worker/src/entity/mail-share.js:15` | `expires_at TEXT NOT NULL` / `delete_at TEXT NOT NULL`，**无 CHECK 约束** | ❌ 无上限 |
| 14 | 保留期联动 | `mail-share-service.js:8`（`DEFAULT_RETENTION_SECONDS = 604800`）、`:277-283`、`:1142` | `delete_at = 到期 + 保留期(默认 7 天)`，可用 `SHARE_RETENTION_SECONDS` 覆写 | ❌ 非上限，但**长有效期会同比拉长物理留存**，影响清理任务与存储 |
| 15 | 修改入口 | `mail-share-service.js:935-944`（`UPDATE_FIELDS` 白名单） | **`expiresAt` 不在可改字段里** | ⚠️ **相邻缺口：已创建的分享无法延期/改期**，只能撤销重建 |
| 16 | 规格文档 | `docs/specs/mailbox-share-capability/requirements.md:65`（AC-CAP-11）、`docs/specs/mail-share/requirements.md:64`（AC-SHARE-07） | 只规定"**WHERE 管理员配置了**上限时"沿用错误码 | 上限本身是**可选**的 |

**结论：7 天上限只存在于前端两个下拉框。** 后端在生产配置下**根本没有上限**。

### 5.1 会话 TTL 耦合结论

| 事实 | 锚点 |
|---|---|
| 访客会话 token 默认 TTL = **900 秒（15 分钟）**，可由 `SHARE_SESSION_TTL` 覆写 | `share-auth-service.js:19-21`、`:212-213` |
| `exp = min(分享到期时间, 签发时刻 + TTL)` —— **取小值，不是硬上限** | `share-auth-service.js:214-215` |
| Token 无状态，每次请求回查 `mail_share` 行 | `share-auth-service.js:576-601` |
| **过期后可用 `lid`+`sec` 重建会话**，无需登录 | `share-auth-service.js:498-574`；档案 `.agent-workspace/.archive/2026-08-17/share-session-ttl-limitation/share-session-ttl-limitation-executor.md:32,39` |

**判定：会话 TTL 不构成有效期上限，不阻塞需求 3。** 但存在**两条真实耦合**，延长有效期会放大它们：

1. **配额消耗放大**：每次 `establishSession` 都执行 `consumeSessionQuota`，`access_count + 1`（`share-auth-service.js:430-442`、`:551`）。TTL 900s 意味着长期停留的访客**每 15 分钟消耗一个会话名额**。若 owner 设了有限 `maxSessions`，一条 30 天的分享会被会话重建迅速耗尽 → 状态变 `ACCESS_LIMIT_REACHED`。KV 重放缓存只挡 120 秒内的重试（`share-auth-service.js:31`），帮不上忙。
2. **访客体验断点**：TTL 过期后自动重建依赖页面内存里的 `pageSecret`（`mail-vue/src/views/share/index.vue:692-737`）；**一旦刷新页面就丢失**，访客必须重开带 `#sec` 的原链接。有效期越长，撞上这个断点的概率越高。档案 `share-session-ttl-limitation-executor.md:67-68` 已把它记为已知限制。

**如果要支持长有效期，`SHARE_SESSION_TTL` 是否需要联动上调，是一个必须显式裁决的决策**（上调会同步放大档案 `:18,39` 记录的"硬导航后同标签页 sessionStorage 残留窗口"这一安全权衡）。

### 5.2 7 天决策出处

- **未找到任何把 7 天定为安全上限的决策记录。** `docs/specs/mail-share/requirements.md:64`（AC-SHARE-07）与 `docs/specs/mailbox-share-capability/requirements.md:65`（AC-CAP-11）都只说"**WHERE 管理员配置了**最大有效期"——上限是**可选的运维旋钮**，规格从未给出默认值。
- 档案 `.agent-workspace/.archive/2026-08-17/share-session-ttl-limitation/` 两份文档**全篇只讲会话 TTL 86400→900**，与分享有效期无关（`share-session-ttl-limitation-executor.md:37-46`）。
- **易混淆点（必须点名）**：`docs/specs/mail-share/design.md:191` 与 `:320`、`requirements.md:41` 里出现的「≤7 天」指的是**密钥轮换双验窗口**（`SHARE_SESSION_SIGNING_KEY` / `SHARE_SEC_PEPPER` 新旧并行期），**与分享有效期毫无关系**。不要把它当成 7 天上限的依据。
- **判定：7 天是前端下拉框随手写的最大档位**（与 1h/6h/1d 一组的 UI 预设），不是有意的安全决策。

---

## 6. 三项需求的最小改动面

### 需求 1 · 分享访问速率限制 + 验证码开关 + 频率配置

**A. 验证码（复用 Turnstile）—— 可行，改动面小**

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| Turnstile 脚本 | `mail-vue/index.html:20-24` | 分享页 | ✅ 已全站加载 |
| `siteKey` 下发 | `setting-service.js:215`（`websiteConfig`，匿名可读） | 分享页 | ✅ 已存在，但**分享页当前不调 `websiteConfig`** ⛔ 需接线 |
| 开关配置项 | **待建**：`setting` 表新增列（如 `share_verify` / `share_verify_count`）+ `sys-setting` UI | `share-auth-service.establishSession` | ⛔ 待建 |
| 前端挂载 | **待建**：`mail-vue/src/views/share/index.vue` 加 turnstile 容器 | — | ⛔ 待建 |
| token 传递 | **待建**：`createShareSession` body 加 `turnstileToken`（`mail-vue/src/request/share.js:162-172`） | `share-api.js:55-63` → `establishSession` | ⛔ 待建 |
| 后端校验 | 复用 `turnstileService.verify(c, token)` | — | ✅ 直接复用 |

风险：① `establishSession` 的调用顺序有严格语义注释（`share-auth-service.js:511-538`：AuthKey 必须在重放查询之前），验证码校验插在哪一步需谨慎——建议放在 API 层（`share-api.js:55`）而非 service 内，避免污染已冻结的顺序契约。② `share-api.js` 的 `withShare` 把 `BizError` 转成 HTTP 200 + 业务码（`:32-37`），而 `turnstileService` 抛的是 `BizError(t('botVerifyFail'), 400)`，会走进分享侧的 `shareResult.fail` 信封——**错误码需要新增一个分享侧专用码**，不能直接漏 i18n 文案给匿名访客。

**B. 频率配置 —— 有硬约束，见 §3.3 三方案。**若选 R1（保守），改动面 = 5 个 wrangler 文件的 `simple = {limit, period}`（`wrangler.toml:15,20` 等），零代码。

**C. 顺带缺口**：`POST /mailShare/create` 零限流（`security.js:73-81`），批量创建落地后滥用面放大，建议同批补上。

### 需求 2 · 批量创建

见 §4.5。**前置阻塞**：`SHARE_CAPABILITY_V2` 默认 false（`wrangler.toml:58-60`）。若走语义 B（每邮箱一条链接），不触发栅栏；若走语义 A（一条链接多邮箱），必须先在 Dashboard 打开该变量，而它有明确的激活前置条件（`wrangler.toml:59` 注释：迁移完成 + 回填重跑 + 无旧 Worker 在途 + 告警消费者就位）。

### 需求 3 · 自定义有效期

**最小改动面（只改前端即可让 7 天以上可用）**：
1. `ShareCreateWizard.vue:413-418` + `:141-154`：档位改为「预设 + 自定义数值输入」（`el-select` 加 `filterable allow-create`，或独立 `el-input-number` + 单位选择）
2. `ShareDialog.vue:124-129`：同步（**P-03 传播点，两处必须一起改**）
3. `mail-vue/src/i18n/zh.js:350` / `en.js:350`：新增档位文案

**若要同时提供服务端上限治理（推荐）**：
4. `wrangler.toml:51-60` 显式加 `SHARE_MAX_DURATION_SECONDS`，把"生产无上限"这个隐式状态变显式（`mail-share-service.js:269-275` 逻辑不用改）
5. 测试基线 `86400` 的多处夹具（§5 表 #9~#12）需评估是否上调

**风险**：
- 后端**当前无上限**意味着前端一旦放开，用户可以创建任意长（如 10 年）的分享。**需要一个有意的上限决策**，而不是继续沿用"没有上限"。
- `delete_at = 到期 + 保留期`（`mail-share-service.js:1142`）→ 长有效期同比拉长物理留存，`mail-share-cleanup-service.js` 的清理窗口与 `idx_mail_share_delete_at` 索引行为需复核。
- 会话配额耦合见 §5.1。
- **相邻缺口**：`UPDATE_FIELDS` 白名单不含 `expiresAt`（`mail-share-service.js:935-944`），已创建的分享**不能延期**。若用户的真实痛点是"分享快到期了想续期"，只加长创建时的档位解决不了——这是一条独立的能力缺口，需确认是否在本轮范围内。

---

## 7. 风险交叉区与派发建议

**风险交叉区（多包会碰同一文件）：**

| 文件 | 谁会碰 | 建议 |
|---|---|---|
| `mail-worker/wrangler*.toml`（5 个） | 需求 1（限流数值） + 需求 3（`SHARE_MAX_DURATION_SECONDS`） + 需求 2（`SHARE_CAPABILITY_V2`） | **串行**，由一个包统一改 |
| `mail-worker/src/security/security.js` | 需求 2（新端点两张表 + `premKey`，`:73-81`/`:112-121` 必须同步，见 `:109-111` 注释） | 单包独占 |
| `mail-vue/src/views/share-admin/ShareCreateWizard.vue` | 需求 2（批量 UI） + 需求 3（自定义有效期） | **同一个包做**，否则必冲突 |
| `mail-vue/src/views/email/ShareDialog.vue` | 需求 3（有效期档位 P-03 传播） | 与上一行同包 |
| `mail-worker/src/service/mail-share-service.js` | 需求 2（批量 service） + 需求 3（若改上限逻辑） | 串行；`normalizeCreateBody:192-212` 与 `legacyCompatibleBody:228-246` 是幂等指纹红线，禁止改字段顺序 |
| `mail-vue/src/views/share/index.vue` | 需求 1（验证码挂载） | 单包独占 |

**建议的工作包切分（供主 AI 派发，依赖关系已标注）：**

| 包 | 范围 | 依赖 | 可并行 |
|---|---|---|---|
| W0（先决） | 用户裁决三件事：① 批量语义 A 还是 B ② 频率配置走 R1/R2/R3 ③ 新的有效期上限值 + 是否要"续期"能力 | — | 阻塞全部 |
| W1 | 分享页 Turnstile 接线（后端错误码 + `share-api.js` 中间件 + `share/index.vue` + `request/share.js`） | W0③无关，可先起 | 与 W2/W3 并行 |
| W2 | 批量创建（`security.js` + `mail-share-service` + `mail-share.js` + 向导 UI） | W0① | 与 W1 并行；与 W3 共享向导文件 → **建议 W2/W3 合并或串行** |
| W3 | 自定义有效期（两处下拉 + i18n + wrangler 显式上限 + 测试夹具） | W0③ | 与 W2 共享 `ShareCreateWizard.vue` |
| W4 | 配置层统一（5 个 wrangler 文件 + `setting` 表新列 + `sys-setting` UI） | W0② | 串行在 W1/W2/W3 之后收口 |

---

## 8. 领域模型核对

**部分适用。** 本仓无 `docs/domain/` 目录（Grep 无命中），但分享子系统的权威模型分散在 `docs/specs/mailbox-share-capability/design.md` 与 `docs/architecture/ADR-mailbox-share-capability-extension.md`。三项需求各自触及的模型维度：

| 维度 | 现状 | 本轮变更判定 |
|---|---|---|
| 限流通道 | CF Rate Limiting binding，key=IP，静态配置 | **[需改模型]** 若加 DB 可配阈值，须在 design.md 写死"CF binding=硬顶 / DB=验证码触发阈值"的分层语义 |
| 分享类型 | `single`/`multi`，由 binding 数派生，不落库 | **[匹配]** 语义 B 批量不引入新类型 |
| 幂等契约 | `share_idempotency(user_id, key, operation)`，指纹含字段顺序 | **[需改模型]** 批量需新增 `operation` 取值或子 key 规则 |
| 有效期 | `expires_at` 无 DB 约束，上限为可选 env | **[需改模型]** 应显式定义默认上限，把"无上限"从隐式变显式 |
| 会话配额 | `access_count` / `max_sessions`，每次 establish +1 | **[不变量风险]** 长有效期 × 有限 `maxSessions` 会让 `ACCESS_LIMIT_REACHED` 提前触发，需在文档写明这条交互 |

建议主调度者在实施前，把「限流分层语义」「批量幂等契约」「有效期上限默认值」三条补进 `docs/specs/mailbox-share-capability/design.md`，避免执行者各自发明。
