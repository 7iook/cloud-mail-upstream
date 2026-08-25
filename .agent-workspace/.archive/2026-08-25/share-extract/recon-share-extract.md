# 侦察报告 · 分享访客页「邮件展示与验证码/链接提取」现状(Mode R)

日期:2026-08-25 · 侦察员:plan-reality-recon · 范围:只调查,零代码改动
锚点均为本轮实读文件行号(`file:line`)。

---

## 1. 计划假设清单(来自新需求 1–7)

| # | 需求隐含的假设 | 现实核实结果 |
|---|---|---|
| 1 | 现有提取只针对验证码 | ✅ 成立(AI prompt 只要 `{"code":""}`) |
| 2 | 访客页会「自动回退到别的邮件」展示验证码 | ✅ 成立,且回退发生在两处 |
| 3 | 访客页没有手动刷新 / 没有新邮件提示 | ❌ **部分不成立**:手动刷新按钮已存在(但被 `v-if="!autoRefresh"` 藏起来);新邮件差异检测已存在(水位线 + Tab 红点),缺的是 toast |
| 4 | 项目没有 AI 提取,要新建 | ❌ **不成立**:Workers AI 已接入并已在跑验证码提取,缺的是「降级兜底」 |
| 5 | 加提取模式配置项 = 新工作 | ✅ 成立,但已有 `otpExtractionEnabled` 开关全链路可照抄 |
| 6 | 需要同时展示码与链接 | ✅ 成立,链接提取**全仓零实现** |
| 7 | 访客拿不到完整原文,要后端放行 | ❌ **不成立**:`text` + `content` 已经完整下发,无截断 |

---

## 2. 现实核实(plan vs reality)

### A · 访客页现状

**A1 文件职责**(`mail-vue/src/views/share/`,共 6 个源文件 + 4 个 spec)

| 文件 | 职责 |
|---|---|
| `index.vue`(1198 行) | 访客页唯一容器:会话建立/恢复/超时、AuthKey 表单、多邮箱 Tab、列表+详情、附件下载、轮询编排、过期倒计时 |
| `ShareOtpCard.vue`(161 行) | 顶部验证码卡片 + 复制降级 |
| `session.js` | sessionStorage 会话/幂等键读写 |
| `status-watermark.js` | 每 binding 已读水位线(`advance`/`hasNew`/`reconcile`),驱动 Tab 红点 |
| `mail-fields.js` | `senderLine()` 展示拼装 |
| `assert-share-chunk.js` | 构建期闸门:分享 chunk 不得引入 dexie / `account:query` / `location.reload` / `websiteConfig` |

**A2 `featuredMail` 的确切逻辑与「残留」根因** —— `ShareOtpCard.vue:72-83`:

```
72| const featuredMail = computed(() => {
73|     const selected = props.selected
74|     if (selected && hasShareCode(selected.code)) {   // 选中邮件有码 → 用它
75|         return selected
76|     }
77|     for (let i = props.mails.length - 1; i >= 0; i--) {  // ← 回退:从最新往回找第一封有码的
78|         if (hasShareCode(props.mails[i].code)) {
79|             return props.mails[i]
80|         }
81|     }
82|     return null
83| })
```

**根因就是 77-81 行的回退循环**:选中邮件 `code` 为空时不返回 null,而是倒序扫描整个 `mails` 数组,把别的邮件的码顶上去。用户看到的「切到没有验证码的第一封,顶部仍是第二封的码」正是这段。第二处放大器在 `index.vue:450-456`:`selectedId` 为空时 `selectedMail` 默认取**最后一封**;`index.vue:865-867` 首屏也会自动选中最后一封。所以「不自动回退」需要同时删掉 77-81 与决定是否保留默认选中。

**A3 验证码正则位置** —— **全仓没有任何验证码正则**。前端不解析,后端也不用正则:唯一提取点是 `mail-worker/src/service/ai-service.js:22-47` 的一次 LLM 调用,系统提示词写死「只回 `{"code":"..."}`、≤8 字符、不含空白」(`ai-service.js:26`),超长或含空白就丢弃(`ai-service.js:43-45`)。提取发生在**邮件摄取时**(`mail-worker/src/email/email.js:95`),结果写进 `email.code` 列随行落库(`email.js:103`)。访客页只是把这一列透传出来。

**A4 链接提取能力** —— **零**。`mail-vue/src/views/share/` 下 grep `https?://` 无业务命中(仅 spec 里的 blob URL);后端也无。

**A5 轮询机制** —— `mail-vue/src/composables/useSharePolling.js`,默认间隔 `POLL_INTERVAL_MS = 3000`(`:9`),带 `visibilitychange` 后台暂停(`:186-196`)、429 Retry-After 退避(`:173-175`)、`SHARE_UNAVAILABLE` 熔断(`:177-179`)。
- **手动触发入口已存在**:`index.vue:413-426` `manualRefresh()`,按钮在 `index.vue:113-121`,但 `v-if="!autoRefresh"` —— 只有关掉自动刷新的分享才看得到。
- **新邮件差异检测已存在**:`index.vue:385-395` `pollTick` 每轮读一次 status 帧,`status-watermark.js` 的 `hasNew()` 判定,`index.vue:462-465` `tabHasNew()` 驱动 Tab 红点。**但只对非当前 Tab 生效**(`:463` `box.bindingId !== activeBinding.value`),当前 Tab 来新邮件时没有任何提示。

**A6 toast 能力** —— element-plus **已经在分享 chunk 里**:`ShareOtpCard.vue:95-100` 已经在调 `ElMessage`(经 `vite.config.js:42-44` 的 `AutoImport + ElementPlusResolver` 自动引入),且 `SafeMailRenderer` 用了 `el-button`/`el-alert`(`components/safe-mail/index.vue:5,25`)。`assert-share-chunk.js:10-15` 的 FORBIDDEN 名单**不含 element-plus**,所以访客页用 `ElMessage` 做 toast 无任何闸门阻碍。注意 `ShareOtpCard.vue:95` 的 `typeof ElMessage === 'function'` 是防御式写法,自动引入后恒真。

### B · 邮件正文渲染

**B1 后端投影字段清单** —— `mail-worker/src/service/share-mail-service.js:90-107`,`VisitorMailDTO` =
`mailId` / `bindingId` / `mailboxAddress`(掩码)/ `senderName` / `senderAddress` / `subject` / **`text`(原样,无截断)** / **`content`(= HTML 原文,无截断)** / `receivedAt` / `code`(仅当 `ctx.otpExtractionEnabled === true`,`:105`)/ `attachments`。
**结论:完整原文已经在访客手里,没有任何截断或过滤。** 唯一的量级约束是可见邮件条数(`messageLimit` / VisibleWindow),不是单封内容长度。

**B2 SafeMailRenderer 做了什么** —— `mail-vue/src/components/safe-mail/index.vue`:纯文本模式直接 `<pre>{{ text }}</pre>`(`:42`),**一个字符都不删**;HTML 模式走 sandbox iframe + `srcdoc`(`:43-51`),沙箱不含 `allow-scripts`/`allow-same-origin`。访客页默认 `default-mode="text"`(`index.vue:173`)。**不会删链接或文本**,但 iframe 内的链接不可点击/不可跨框复制是沙箱的固有代价。

**B3 「访客拿不到原文」的技术阻碍** —— **不存在**。做「查看完整原文 + 一键复制全部」纯前端即可(数据已在 `selectedMail.text` / `.content`)。
⚠️ 反过来才是难点:需求 7 说「可配置该入口」——若只在前端隐藏按钮,就是典型的 trust-the-client:原文仍在响应体里,F12 就能拿。**要做成真开关,必须在 `share-mail-service.js:100-101` 按 ctx 决定是否投影 `text`/`content`**,并且必须同时想清楚「关掉原文后正文区显示什么」(现在正文区就是原文本身)。

### C · 后端提取与 AI 能力

**C1 后端验证码提取代码** —— `mail-worker/src/service/ai-service.js`(73 行,全文即提取器)。调用点唯一:`mail-worker/src/email/email.js:95`。消费者两个:TG 推送(`telegram-service.js:64-69`)、分享投影(`share-mail-service.js:105`)。

**C2 Workers AI 已在用** —— `wrangler.toml:47` 有 `[ai]` 段;`wrangler-test.toml:33`、`wrangler-action.toml:35` 同;`wrangler-dev.toml:35` 是注释掉的(本地默认无 AI)。模型可配:`c.env.ai_model`,默认 `@cf/meta/llama-3.1-8b-instruct`(`ai-service.js:22`、`wrangler.toml:61`、`.github/workflows/deploy-cloudflare.yml:28`)。全局开关在 setting 表:`ai_code` / `ai_code_filter`(`entity/setting.js:53-54`),`shouldExtractCode` 用发件人邮箱/域白名单过滤(`ai-service.js:54-68`)。
⚠️ **既有运营陷阱**(design.md:54 已记录):配了 `aiCodeFilter` 白名单,名单外的邮件 `code` 恒空。

**C3 既有降级范式** —— `ai-service.js:48-51` 就是现成范式:`catch` → `console.error` → 返回空串,**永不抛给调用方**。但它是「降级为空」,不是「降级为另一条提取路径」。全仓**没有**「AI 不可用 → 走规则兜底」的先例。
另一条可参照的兜底是 `SafeMailRenderer` 的 `injectFailed`(`safe-mail/index.vue:164-167`):srcdoc 构建失败 → 自动回退纯文本 + 提示条,这是「双方案 + 用户可见降级提示」的既有形状,值得照抄 UI 语义。

### D · 分享配置模型

**D1 `mail_share` 现有字段**(`mail-worker/src/entity/mail-share.js:4-38`,共 27 列):
`shareId` `lid` `secHmac` `pepperKid` `userId` `accountId` `name` `remark` `status` `windowStartEmailId` `expiresAt` `deleteAt` `accessCount` `lastAccessAt` `revokedAt` `createTime` `maxSessions` `messageLimit` `onlyMessagesAfterCreated` **`otpExtractionEnabled`** `autoRefresh` `refreshIntervalMs` `showFullAddress` `authKeyEnabled` `authKeyHash` `authKeyKid` `credentialsVersion` `secCipher` `kekKid`。
迁移分布:`init/init.js:66-76`(v3_2DB,配置列全在这批)、`:49-50`(v3_3DB,凭据密文)。迁移模式 = expand-only 逐条 ALTER + catch 吞 duplicate(`init.js:79-86`),幂等是常态路径。

**D2 创建时可配的开关**(前端向导 `ShareCreateWizard.vue:225-290`,后端白名单 `mail-share-service.js:186-203`):
`maxSessions` `messageLimit` `onlyMessagesAfterCreated` `otpExtractionEnabled` `autoRefresh` `refreshIntervalMs` `showFullAddress` `authKeyEnabled` —— 八项,前后端一一对应(前端出口白名单 `request/mail-share.js:23-32`)。

**D3 ⭐「加一个开关」的完整链路 checklist**(照抄 `otpExtractionEnabled` 的既有路径,每一处都有锚点):

| # | 位置 | 锚点 | 动作 |
|---|---|---|---|
| 1 | 迁移 | `mail-worker/src/init/init.js` | 新增 `v3_4DB`(**勿改 v3_2/v3_3**),照 `:46-61` 的形状加 `ALTER TABLE mail_share ADD COLUMN ...`,并在 `:30-35` 的调用链尾部追加 |
| 2 | entity | `entity/mail-share.js:24` 邻位 | 加列定义 |
| 3 | create 归一化 | `mail-share-service.js:186-203` `normalizeCreateBody` | **必须一次性写进字面量、不能展开合并**——键顺序是幂等指纹的一部分(`:183-185` 注释) |
| 4 | **幂等指纹兼容** | `mail-share-service.js:219-237` `legacyCompatibleBody` | 新字段非默认值时必须让它返回 null,否则旧 Worker 重放会建出不同的行 |
| 5 | 插入 | `mail-share-service.js:1375-1404` + `:646-649` values 顺序 | 传入新字段 |
| 6 | 行→DTO | `mail-share-service.js:406-410` 与 `:444-447` | 两处映射(snake 与 camel 各一套) |
| 7 | UPDATE 白名单 | `mail-share-service.js:971-981` `UPDATE_FIELDS` | 加一行,否则管理端改不了(`:962-970` 明确禁止 `Object.keys(patch)` 拼 SQL) |
| 8 | ShareContext | `share-auth-service.js:428-446` `buildShareContext` | 若访客侧读取逻辑要用它 |
| 9 | 访客 config 下发 | `share-auth-service.js:482-487` `buildSessionPayload.config` | 若前端要按开关改行为 |
| 10 | 投影 | `share-mail-service.js:90-107` | 若开关决定某字段是否下发(照 `:105` 的 `...(cond ? {k:v} : {})` 形状) |
| 11 | 前端出口白名单 | `mail-vue/src/request/mail-share.js:23-32` | 加字段名 |
| 12 | 创建向导 | `ShareCreateWizard.vue:225-272` 表单 + `:703-705` payload | UI + 提交 |
| 13 | 预设 | `mail-vue/src/views/share-admin/presets.js:15-18` 白名单 + `:145-206` 四套预设 | 四套预设都要给值 |
| 14 | 详情抽屉 | `ShareDetailDrawer.vue:233` / `:587-590` / `:709-712` / `:891-898` | 表单项 + 初值 + 回填 + diff patch,**四处** |
| 15 | 访客页读取 | `mail-vue/src/views/share/index.vue:596-603` `applyShareConfig` | 唯一的 config 读点,注释明确要求不开第二个 |
| 16 | i18n | `mail-vue/src/i18n/{zh,en}.js` | 标签 + hint |

**共 16 个改动点、约 10 个文件。这是本轮最容易漏改的一条链。**

### E · 已有约束与冲突

| 既有决策 | 锚点 | 与新需求的关系 |
|---|---|---|
| **Decision 6 · OTP 只读 `email.code`,不在投影链重新推断** | `docs/specs/mail-share/design.md:101`;不变量 `P-OTP-03`(`design.md:532-536`) | ⛔ **直接冲突**。需求 1/4/6 要在分享侧解析链接、要降级兜底,都是「重新推断」。必须显式推翻 P-OTP-03 或把新提取器放回**邮件摄取链**(design.md:101 原话:「统一抽取应归属邮件摄取链」) |
| 严格最小集,不做确定性 OTP 打分器 | `requirements.md:7`、`design.md:88`;AC-OTP-01~05/10~13 全部 deprecated | ⚠️ 需求 4 的「降级兜底」本质就是被废弃的确定性打分器复活。需要用户明确重开 |
| `code` 空串 `''` 视为无验证码,非 null | `design.md:357` | 新的「码 + 链接」结构要保持这个语义,别引入 null |
| 正文双模式 + 沙箱 iframe;不下发 `/oss/` 直链 | `requirements.md:7,182-208` | 需求 7 与之不冲突(原文已下发) |
| 访客日志不得含邮件正文(AC-LEAK-05) | `requirements.md:259` | ⚠️ 若新提取器要打日志排错,不得记正文/链接原文 |
| 上一轮 share-hardening 的债 | `share-hardening-decision-card.md:369-377` | 已登记债表;评审循环因单卡跨节一致性成本终止(`:484`),**结论:本轮务必拆卡** |

---

## 3. 重复实现与可复用扫描

**内部命中(应复用,不要新建)**
- AI 提取器:`ai-service.js` 整个文件 —— 扩 prompt 让它同时回 `{code, link}` 比新建第二个提取器便宜得多。
- 提取开关链路:`otpExtractionEnabled` 16 点链路(见 D3),照抄即可。
- 复制降级:`@/composables/useCopyWithFallback.js`(`ShareOtpCard.vue:37,60`)—— 「复制全部原文」直接复用,别再写一遍 clipboard。
- 手动刷新:`index.vue:413-426` 已实现且与轮询共用同一 tick、共用水位线语义(`:409-412` 注释明确禁止开第二条 fetch 路径)。需求 3 只需把 `v-if="!autoRefresh"`(`:114`)去掉。
- 新邮件差异检测:`status-watermark.js` 的 `hasNew` —— toast 直接挂在这套水位线上,别自己比 mailId。
- 降级 UI 语义:`safe-mail/index.vue:164-167` + `:33-40` 的 warning alert。

**外部**:未做联网检索(本轮范围内所有能力均有内部现成实现,`unverified: 未执行 exa/tavily`)。若后续要做规则兜底,建议届时补一次开源正则库调研。

---

## 4. 架构/前提质疑 + 业务现实闸门

**§0.17 四问逐条(对新需求)**

| 需求 | 真实场景 | 缺失影响 | 既有覆盖 | 分类 |
|---|---|---|---|---|
| 1 链接也要提 | 拿到分享链接的人要激活账号,邮件里只有激活链接没有码 | 拿不到,人工翻正文 | 无 | **A** |
| 2 移除自动回退 | 用户点第一封,顶部显示第二封的码 → 复制了错的码 | **已经在造成错误操作** | 无 | **A(缺陷)** |
| 3 手刷 + toast | 等码时想立即查 | 手刷按钮**已存在但被藏**;toast 无 | 部分 | **B**(把已有能力放出来 + 补 toast) |
| 4 AI + 兜底 | AI 额度耗尽/模型抖动时 code 恒空 | 分享页空白无解释 | `catch → ''` 只降级为空 | **B** |
| 5 提取模式可配 | 不同分享场景需求不同 | — | `otpExtractionEnabled` 已是布尔开关 | **C**,建议**扩展**而非新建开关 |
| 6 码/链接同展示 + 空态文案 | 同 1 | 同 1 | 无 | **A** |
| 7 原文入口可配 | 访客要复制整封内容 | 数据已在手,只是没入口 | 无 UI | 入口 = **B**;**「可配置」= 需谨慎** |

**⚠️ 业务现实建议(需求 7 的「可配置」)**:数据已经无条件下发(`share-mail-service.js:100-101`)。如果只加前端开关,这个「配置」在安全意义上是**假的**(D 类技术整洁)。要么(a) 承认它只是 UI 偏好、明说不是保密边界(照 `share-mail-service.js:9-14` 对地址掩码的既有定性:"masking is a display preference, not a confidentiality boundary"),要么(b) 做成真开关 = 后端按 ctx 停止投影 `text`/`content` —— 但那样正文区就没内容可渲染了,等于把访客页降级成「只看码」。**这是必须由用户裁决的方向题,不要让执行者自己选。**

**🛑 架构级质疑(需求 1/4/6 的落点)**:design.md:101 的既有裁决是「统一抽取应归属邮件摄取链」。现在有两条路:
- **路 A(摄取侧)**:扩 `ai-service.js` 同时产出 code + link,新增 `email.link` 列。优点:符合既有 SSOT 决策、TG 推送也白拿链接、零额外 AI 调用。缺点:**存量邮件全部没有 link**(无回填路径,`design.md:672` 明确 `email.code` 无 UPDATE 路径);且「每个分享配不同提取模式」在摄取侧无法表达(摄取时还不知道会被哪个分享看到)。
- **路 B(分享读侧)**:在 `share-mail-service` 投影时按分享配置提取。优点:存量邮件立刻生效、per-share 配置天然成立。缺点:**推翻 P-OTP-03 不变量**、每次读都要跑 AI(轮询 3 秒一次 × N 封 = AI 调用量爆炸,必须配缓存)。
**需求 5「每个分享可配提取模式」与需求「AI 优先」在路 A 下是互斥的。这是本轮最大的架构岔路,必须在开工前裁决,不能让执行者边写边选。** 建议候选:路 A 产出兜底数据 + 路 B 按需二次提取并缓存到 email 行(混合),但成本需评估。

---

## 5. 真实修改范围

1. **提取内核**:`ai-service.js` prompt + 返回结构;新增规则兜底模块(位置取决于第 4 节裁决);可能新增 `email` 列 + 迁移。
2. **投影**:`share-mail-service.js:90-107` 增加 link 字段(与 code 同样受开关控制)。
3. **配置链**:D3 的 16 点 ×(1~2 个新开关)。
4. **访客页**:`ShareOtpCard.vue:72-83` 删回退 + 改为「码/链接双槽 + 空态文案」;`index.vue:113-121` 解除刷新按钮的 `v-if`;新增当前 Tab 新邮件 toast;新增「查看原文/复制全部」入口。
5. **i18n**:zh/en 各约 6-10 个新 key。
6. **测试**:`share/index.spec.js`、新建 `ShareOtpCard.spec.js`(⚠️ 当前**没有** ShareOtpCard 的单测,回退逻辑无测试保护)、`share-mail-service.spec.js`、`mail-share-service.spec.js`(白名单/指纹)、`v3-*-db.spec.js`。
7. **文档**:design.md 的 Decision 6 / P-OTP-03 必须显式修订(否则新代码与不变量正面冲突)。

---

## 6. 可并行工作包拆分(按文件所有权切,零重叠)

| 包 | 范围(独占文件) | 目标 | 依赖 | 可并行 |
|---|---|---|---|---|
| **W-0 裁决**(主 AI,非执行包) | `docs/specs/mail-share/design.md` `requirements.md` | 裁决第 4 节的路 A/B、需求 7 的真/假开关;修订 Decision 6 + P-OTP-03 | 无 | ⛔ **阻塞 W-1/W-2** |
| **W-1 提取内核** | `mail-worker/src/service/ai-service.js` + 新建兜底模块 + `test/ai-service*.spec.js` | 产出 `{code, link}` 双结果 + AI 不可用降级 | W-0 | 与 W-3/W-4 并行 |
| **W-2 配置链(后端)** | `init/init.js` `entity/mail-share.js` `service/mail-share-service.js` `service/share-auth-service.js` `service/share-mail-service.js` + 对应 spec | 新开关的迁移/白名单/UPDATE/config 下发/投影 | W-0 | 与 W-3 并行;**与 W-1 在 `share-mail-service.js` 有潜在交叠 → 由 W-2 独占该文件,W-1 只交付纯函数** |
| **W-3 访客页展示** | `views/share/ShareOtpCard.vue`(+ 新建 spec)· `views/share/index.vue` · `views/share/index.spec.js` | 删回退、双槽展示、空态文案、刷新按钮常驻、toast、原文入口 | 无(可先按契约 mock) | ✅ 立即,与全部并行 |
| **W-4 管理端配置 UI** | `views/share-admin/ShareCreateWizard.vue` `ShareDetailDrawer.vue` `presets.js` `request/mail-share.js` + 各自 spec | 新开关的向导/抽屉/预设/出口白名单 | W-0(知道开关叫什么) | ✅ 与 W-1/W-2/W-3 并行 |
| **W-5 i18n** | `i18n/zh.js` `i18n/en.js` | 文案 | 需 W-3/W-4 的 key 清单 | ⚠️ **两个文件被 W-3/W-4 同时需要 → 建议 W-5 串在最后,或开工前一次性把 key 全部占位写入** |

**风险交叉区**
1. `mail-vue/src/i18n/{zh,en}.js` —— W-3/W-4/W-5 都要动的**唯一热点**。建议:开工前主 AI 一次性写入全部占位 key,执行包只准改自己那几行。
2. `share-mail-service.js` —— W-1(提取)与 W-2(投影开关)天然想同时改。已在表中指派给 W-2 独占。
3. `mail-share-service.js`(1800+ 行)—— W-2 独占,别让第二个包碰。
4. 这四个文件当前 **git 工作区已有未提交修改**(`mail-share-service.js` / `share-auth-service.js` / `ShareCreateWizard.vue` / `ShareDetailDrawer.vue` / i18n 双文件均为 ` M`),来自上一轮 share-hardening。**派发前必须先把上一轮收口提交,否则多 sub 的 diff 会和存量脏改动混在一起无法审查。**

**派发建议**:W-0 主 AI 先做(不可并行)→ 然后 W-1 / W-2 / W-3 / W-4 四包真并行 → W-5 收口。

---

## 7. 链路完整性扫描(§0.16 · 以「链接提取」为例)

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| 邮件到达 | `email/email.js:95` | `ai-service.js:5` | ✅ 已通 |
| 提取结果落库 | `email/email.js:103`(仅 `code`) | `entity/email.js` `code` 列 | ⛔ **断**:link 无列、无写入 |
| 投影给访客 | `share-mail-service.js:105`(仅 `code`) | `views/share/index.vue:132`(`:mails`) | ⛔ **断**:无 link 字段 |
| 顶部卡片展示 | `ShareOtpCard.vue:9`(仅 `code`) | 访客眼睛/剪贴板 | ⛔ **断**:无 link 槽、无空态文案 |
| 新邮件提示 | `status-watermark.js` `hasNew` | `index.vue:462-465`(仅非当前 Tab 红点) | ⛔ **断**:当前 Tab 无 toast |
| 原文复制 | `share-mail-service.js:100-101`(`text`/`content` 已下发) | `index.vue:170-174`(仅渲染) | ⛔ **断**:无复制入口(但**数据侧已通**) |

**最终 sink**:访客剪贴板中的验证码 / 激活链接 / 完整原文。
**真跑一次的 e2e 姿势**:新浏览器上下文打开分享链接,外部真投一封「只有激活链接、无验证码」的邮件,不刷新页面观察 toast → 点开该封 → 顶部只显示链接(不残留上一封的码)→ 复制链接与原文均成功。

---

## 8. 领域模型对账

`docs/domain/` 目录**不存在**(未建立 domain-model 文档体系)。本子系统的事实基线由 `docs/specs/mail-share/design.md` + `docs/specs/mailbox-share-capability/design.md` 承担,且 design.md:44-70 已有完整的「既有实现清单表」,功能等价于跨切维度表。
**建议**:本轮不新建 domain-model 文档(会造第二个 SSOT),但**必须在 design.md 里修订 Decision 6 / P-OTP-03**,否则新提取器与既有不变量正面冲突。—— 这条已列为 W-0。
