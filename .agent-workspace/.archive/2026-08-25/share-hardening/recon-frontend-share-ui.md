# 侦察报告 · 分享链接前端展示 / 复制 / 邮件条数上限

- 模式：Mode R（现实核实）· read-only，未修改任何业务代码
- 日期：2026-08-25
- 范围：`mail-vue/src/views/share-admin/`、`mail-vue/src/views/share/`、`mail-vue/src/views/email/ShareDialog.vue`、`mail-worker/src/service/mail-share-service.js`、`share-scoped-email-repository.js`、`share-auth-service.js`、`docs/specs/mailbox-share-capability/`、`docs/architecture/`

---

## 1. 计划假设清单（用户需求视角，逐条待核实）

| # | 需求方假设 | 核实结论 |
|---|---|---|
| H1 | 分享链接在 UI 上被「隐藏处理」（掩码 `***`） | **[偏差]** 从未掩码，创建成功那一刻是完整明文 |
| H2 | 分享链接「不支持复制」 | **[偏差]** 已有复制按钮 + 三级降级复制封装 |
| H3 | 分享链接「只展示一次」是前端选择，可以改成随时可看 | **[部分成立 · 关键约束]** 一次性是真的，但**不是前端选择** —— 后端只存 HMAC，明文不可复现 |
| H4 | 邮件条数上限 = 仅展示最新 N 封 | **[匹配]** 确为动态「每邮箱最新 N 封」，SQL 层强制 |
| H5 | 该配置当前可用 | **[偏差 · 高优先]** `message_limit` 在 `SHARE_CAPABILITY_V2` 栅栏后，生产默认关闭，现在填 3 会被拒 |

---

## 2. 现实核实 ① · 链接/密钥展示现状表

| 界面 | 展示形态 | 可否复制 | 可否重看 | 锚点 |
|---|---|---|---|---|
| 创建向导 · 成功面板（链接） | **完整明文**，`readonly` input，非掩码 | ✅ `复制链接` 按钮 | ❌ 关闭/点「我已保存」即销毁 | `ShareCreateWizard.vue:35-49`（input 45 行 `:value="createdShareUrl"`）· 复制按钮 `:47` |
| 创建向导 · 成功面板（访问密钥） | 完整明文 input | ✅ `复制` 按钮 | ❌ 同上 | `ShareCreateWizard.vue:51-65`（复制按钮 `:63`） |
| 创建向导 · 幂等重放分支 | **只有 shareId / lid，无链接无密钥** | — | ❌ 明文永不重发 | `ShareCreateWizard.vue:18-31`；判定 `replayWithoutSecret` `:488-491` |
| 详情抽屉 | **完全不展示链接**；仅 AuthKey 重置后一次性展示新 Key | ✅ 仅 AuthKey `authkey-copy` | ❌ `authKeyOnce` 点「我已保存」即清空 | `ShareDetailDrawer.vue:300-317`；清空 `:313`、`:421-423`、`:827` |
| 行操作 `ShareRowActions.vue` | 无任何链接/复制入口（只有 详情 / 撤销 / 删除） | — | — | `ShareRowActions.vue:1-28` |
| 管理列表页 `share-admin/index.vue` | 无链接列（grep `shareUrl\|copy\|lid\|link` 零命中于模板） | — | — | `share-admin/index.vue`（全文件无命中） |
| 旧入口 `email/ShareDialog.vue` | 完整明文 input + 复制按钮，同样一次性 | ✅ `:37` | ❌ 关闭对话框 `created = null` | `ShareDialog.vue:25-39`；销毁 `:184-191` |
| 访客页 OTP 卡 | 复制的是验证码，非链接 | ✅ | — | `ShareOtpCard.vue:12-13,89-94` |

**销毁时机（前端侧一次性的执行点）**：
- `ShareCreateWizard.vue:553-558` `closeNow()` → `created.value = null`
- `ShareCreateWizard.vue:582-584` `acknowledgeSecret()` → `created.value = null`
- 关闭前有二次确认：`ShareCreateWizard.vue:571-578`，文案 `shareWizardCloseConfirm`「关闭后将无法再看到这个链接（和密钥）」`:384`
- 代码注释已把边界写死：`ShareCreateWizard.vue:430-432`「The only place the plaintext link and auth key ever live. Not storage, not pinia, not the URL: the list and the detail drawer never return them again.」

**结论 A**：需求方的「隐藏处理」判断与代码不符 —— 链接从来没有被掩码，**复制按钮也早就存在**。真正的痛点只有一个：**关闭后无法再看**。

---

## 3. 现实核实 ② · 后端存储形态判定 + 「可重复查看」技术可行性

### 3.1 存储形态：**HMAC 哈希，不是明文，也不是可逆加密**

- 表结构只有 `sec_hmac` + `pepper_kid`，**没有任何存明文/密文的列** —— `mail-worker/src/entity/mail-share.js:6-8`
  ```js
  lid: text('lid').notNull(),
  secHmac: text('sec_hmac').notNull(),
  pepperKid: text('pepper_kid').notNull(),
  ```
- AuthKey 同构：`authKeyHash` + `authKeyKid`，无明文列 —— `entity/mail-share.js:29-30`
- 明文只在创建那一刻存在于内存：`mail-share-service.js:1143-1146`
  ```js
  const lid = randomToken(16);
  const sec = randomToken(32);
  const authKey = body.authKeyEnabled ? randomToken(16) : '';
  ```
- 落库前立即摘要：`mail-share-service.js:1153`、`:1167`
  ```js
  secHmac: await shareAuthService.digestShareSecret(sec, pepper),
  authKeyHash: authKey ? await shareAuthService.digestShareSecret(authKey, pepper) : null,
  ```
- 摘要函数 = **HMAC-SHA256 + pepper，输出 hex**，单向 —— `share-auth-service.js:113-116`
  ```js
  async function digestShareSecret(sec, pepper) {
      const bytes = await hmacBytes(pepper, sec);
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  ```
- 明文唯一出口是创建首响应：`mail-share-service.js:528-543` `firstCreateResponse()`，`shareUrl: ${origin}/s/${row.lid}#${sec}`（`:535`）
- Owner 面读取列清单**主动排除**凭据物料 —— `mail-share-service.js:369-378`
  ```
  // Owner 面唯一的列清单。凭据物料(`sec_hmac` / `pepper_kid` / `auth_key_hash` /
  // `auth_key_kid`)与 `credentials_version` 一律不进 SELECT —— 取不到就漏不掉。
  ```
  list / detail 投影 `projectOwnerRow()` `:424-456` 也无 `sec` 字段。
- 幂等重放显式不重放明文：`mail-share-service.js:553-578`（`:553` 注释「sec 与 AuthKey 明文一个字符都不给」）

### 3.2 技术可行性判定（明确、不含糊）

> **「随时回来再查看同一条原始分享链接」在当前架构下密码学上不可能。**
>
> `sec` 是 256-bit CSPRNG，只留 HMAC-SHA256 摘要。HMAC 单向，服务端自己也无法从 `sec_hmac` 反推 `sec`。这不是前端隐藏，是**后端根本没有那份数据**。

**可分半判定**（重要，决定方案空间）：
- 链接的**前半 `lid` 是明文存库的**（`entity/mail-share.js:6`），list / detail 都返回（`toOwnerRow():393`、`replayFromIdempotency():572`）→ `https://host/s/<lid>` 这一半随时可重建。
- **后半 `#sec` 不可恢复**。而 `sec` 恰是授权凭据本身（`sec` 在 URL fragment，浏览器不发往服务器 —— `docs/specs/mail-share/requirements.md:42`）。

因此「不能仅只展示一次」这条需求，落到实现上必须二选一改语义（**决策权在用户/主 AI，本报告不替选**）：

| 方案 | 语义 | 代价 | 是否推翻安全决策 |
|---|---|---|---|
| S1 · 加固「那一次」 | 明文在**本次会话内**可反复查看/复制（不随关闭对话框销毁，改为显式「我已保存」才销毁；或管理页保留「最近创建」卡片直到刷新） | 最小改动，纯前端 | 不推翻（明文仍不落库、不进 storage）；但刷新页面仍然丢失 |
| S2 · 新增「重新生成链接」 | 像 `resetAuthKey` 那样重置 `sec_hmac` + `credentials_version`，发新链接、旧链接立即失效 | 后端新端点 + 迁移语义 | 不推翻（仍只存 hash）；语义是「重发」不是「重看」，用户预期需对齐 |
| S3 · 改为可逆加密存储 | 服务端可解密后重复下发原链接 | **架构级**：新增密钥管理、推翻 ADR 的凭据边界、日志/备份泄露面扩大 | **推翻**（见 §5） |

前端已有**部分 S1 的现成骨架**：`created` ref 生命周期集中在 `ShareCreateWizard.vue:432 / 553-558 / 582-584` 三处，改销毁时机是局部改动，不触碰后端。

---

## 4. 既有复制能力复用点（先查再造，已查到）

**SSOT 封装存在且成熟，禁止再造第二个复制实现。**

- 实现：`mail-vue/src/composables/useCopyWithFallback.js:120-209`
  - 三级降级：`navigator.clipboard.writeText`（`:20-30`）→ `document.execCommand('copy')`（`:32-61`）→ 手动选中兜底（`activateManual():140-163`，可绑 `selectableRef` 到页面内 input，否则注入浮层 textarea `createFallbackHost():88-111`）
  - 返回 `{copied, path, text, selectableEl}`，调用方**只在 `copied === true` 时弹成功提示**（doc 注释 `:113-119`）
- 现有 4 个消费者，均可直接照抄用法：
  - `ShareCreateWizard.vue:350-351`（两个实例：链接与密钥各一，因为一个 `selectableRef` 只能绑一个 input，注释 `:348-349`）+ 调用 `:711-723`
  - `ShareDetailDrawer.vue:347` + `copyAuthKey():813-818`
  - `ShareDialog.vue:100` + `copyCreatedLink():249-254`
  - `ShareOtpCard.vue:60` + `copyFeaturedCode():89-94`
- 历史档案佐证：`.agent-workspace/.archive/2026-08-17/t-19-use-copy-with-fallback/`、`t-23-copy-fallback-converge/`（收敛任务，已把散落实现并成这一份）

**结论**：需求「该链接需要支持复制」**已经满足**，无需新建能力；若做 S1，只需把已有复制按钮的可达时间窗拉长。

---

## 5. 「一次性展示」的原始设计决策出处（推翻前需知道推翻的是什么）

这是**有意的安全决策**，写在需求/设计/ADR 三层，不是实现疏漏。

| 层级 | 锚点 | 原文要点 |
|---|---|---|
| 需求（旧 charter） | `docs/specs/mail-share/requirements.md:41` | 「`sec` **只以 `HMAC-SHA256(sec, PEPPER[kid])` 存库**…明文仅在创建时返回一次」；含 PEPPER `kid` 轮换契约 |
| 需求（本期） | `docs/specs/mailbox-share-capability/requirements.md:58` AC-CAP-04 | 「`sec` 只以 `HMAC-SHA256(...)` 存库且明文仅创建响应返回一次」 |
| 需求（AuthKey） | 同上 `:59` AC-CAP-05 | AuthKey「只存 `auth_key_hash` 与 `auth_key_kid`，并在创建响应中返回明文**恰好一次**」 |
| 需求（幂等边界） | 同上 `:63` AC-CAP-09 / `:68` AC-CAP-14 | 重放「返回同 `shareId`/`lid` 且**不再返回** `sec`/AuthKey 明文」；响应丢失的恢复动作是 **revoke/delete 后重建**，不是重发 |
| 需求（日志面） | 同上 `:180` AC-SEC-09 | `sec`/AuthKey/token 不得进服务端日志、URL 查询串、Referer |
| 设计 | `docs/specs/mailbox-share-capability/design.md:393` | 创建向导「成功后**一次性展示** `shareUrl`(+`authKey`)」；结果未知 → 引导 revoke/delete 重建 |
| 设计（威胁表） | 同上 `:420-421` | AuthKey「只存 hash；常量时间比较」；「凭据日志…fragment 方案与**一次性捕获**沿用」 |
| ADR | `docs/architecture/ADR-mailbox-share-capability-extension.md:9` | 确立 `/s/<lid>#<sec>` **capability URL** 边界：链接本身即凭据 |
| ADR | 同上 `:15` | AuthKey「只存 `auth_key_hash`，复用 HMAC+PEPPER 设施」 |
| 评审留痕 | `docs/specs/mailbox-share-capability/review3.sub.md:111-118` P1-A6 | 外部评审已提过「一次性秘密在响应丢失后没有恢复流程」，结论是**保持不重放明文的安全边界**，补的是「删除+重建」流程，不是重发 |
| 遗留开放问题 | 同上 `:215` | 「create 成功但一次性 `sec` 未送达时，产品是否接受"删除并重建"」—— **这条问题至今仍开放，用户现在的需求正好落在它上面** |

**rationale 一句话**：`sec` 是 capability URL 的凭据半，泄漏即等于泄漏邮箱可读权；只存 HMAC 的目的是让**数据库泄漏 / 日志泄漏 / 备份泄漏都不足以重建可用链接**。「可随时重看」会把这条防线换成「服务端持有可解密凭据」。

---

## 6. 邮件条数上限：真实语义 + SQL 证据

### 6.1 配置位置（前端）

| 位置 | 字段 | 锚点 |
|---|---|---|
| 创建向导 · 高级选项 | `form.messageLimit`，`el-input-number`，`min=1`，留空 = 不限 | `ShareCreateWizard.vue:268-280`（label `shareMessageLimit`「邮件条数上限」`:390`） |
| 请求体组装 | 仅当非空才带 key（区分「没填」与「设为 0」） | `ShareCreateWizard.vue:642-644` |
| 白名单 | `CREATE_BODY_KEYS` 含 `messageLimit` | `presets.js:13` |
| 四个预设默认值 | 全部 `messageLimit: null`（= 不限） | `presets.js:72, 93, 112, 130` |
| 详情抽屉可改 | `form.messageLimit` + 「不限」复选框 | `ShareDetailDrawer.vue:170-189`；patch 组装 `:665-668` |
| 能力栅栏 | `messageLimit != null` 即触发 fence intent，被拒后置灰 | `presets.js:44-52`；降级 `ShareCreateWizard.vue:654-660` |

### 6.2 后端消费链

`mail_share.message_limit`（`entity/mail-share.js:22`）
→ 建 Session 时进 ShareContext：`share-auth-service.js:361`、下发给访客 `:409`
→ 查询时强制：`share-scoped-email-repository.js`

### 6.3 真实 SQL（唯一强制点）

`share-scoped-email-repository.js:97-119`：

```js
function visibleSubquery(c, scopes, messageLimit) {
    const ranked = orm(c)
        .select({
            ...getTableColumns(email),
            rowNo: sql`row_number() over (partition by ${email.accountId} order by ${email.emailId} desc)`.as('row_no')
        })
        .from(email)
        .where(and(
            inArray(email.accountId, scopes.map((scope) => scope.accountId)),
            gt(email.accountId, 0),
            eq(email.isDel, isDel.NORMAL),
            ne(email.status, emailConst.status.SAVING),
            or(...scopes.map((scope) => and(
                eq(email.accountId, scope.accountId),
                gt(email.emailId, scope.windowStartEmailId)
            )))
        ))
        .as('visible');

    const truncation = messageLimit == null ? undefined : sql`${ranked.rowNo} <= ${messageLimit}`;
    return { ranked, columns, truncation };
}
```

- `row_number() over (partition by account_id order by email_id desc)` + `row_no <= N` = **每个绑定邮箱各自取最新 N 封**
- 该子查询是 list / listForBinding / getById / status 水位的**共同真源**（注释 `:88-92`「Single range SSOT」）
- 单邮箱时总量上界也压到 N（`:145`），多邮箱时不压总量，避免后面的邮箱拿不到名额（注释 `:143-144`）

### 6.4 明确回答：**动态取最新 N 封，不是创建时冻结的快照**

判定依据：
1. `messageLimit` 在**每次查询**时参与 SQL（`selectVisible()` `:121-136`），不落任何快照表；
2. `row_number()` 按 `email_id DESC` 实时排序，新邮件 `email_id` 更大 → 排第 1，最旧的一封被挤出 `row_no <= N`；
3. 需求逐字确认：`requirements.md:41`「每条 Binding 各自可见的最近 N 封上限（按 `email_id` DESC 取最新 N）」；`:124` AC-MAIL-04「新邮件到达使某 Binding 的最新 N 封集合滚动…最旧一封滚出可见集，后续列表与详情请求 SHALL NOT 再返回它」；`:213` AC-EDGE-06「`message_limit=1`…更新的邮件到达时只返回新的一封」;
4. `messageLimit` 可在详情抽屉**创建后修改**（`ShareDetailDrawer.vue:665-668`，AC-ADMIN-03 `requirements.md:157`），快照语义下这不可能生效。

**「分享期间新邮件是否会出现」的答案：会。** 新邮件立刻进入可见集，同时把最旧一封挤出去（窗口滚动）。

**注意区分另一个真·快照**：`window_start_email_id`（`only_messages_after_created`）**是**创建时刻的 `MAX(email_id)` 原子快照，作为可见集**下界**（`entity/mail-share.js:14`；`requirements.md:40`；SQL `share-scoped-email-repository.js:109-112`）。两者叠加：可见集 = 「创建后新到的邮件」∩「最新 N 封」。用户口中的「仅展示最新 N 封」对应后者，语义合理，**核实结论：可以保留**。

### 6.5 ⚠️ 现实约束（需求方必须知道）

`message_limit` 是 `SHARE_CAPABILITY_V2` 栅栏后的五条受限写入之一，**生产默认关闭**：

- 判定：`mail-share-service.js:67-70`
  ```js
  function isCapabilityV2Enabled(c) {
      const flag = c.env && c.env.SHARE_CAPABILITY_V2;
      return flag === '1' || flag === 1 || flag === true || flag === 'true';
  }
  ```
- 拦截点：create `mail-share-service.js:364-366`、update `:968-970` → 抛 `SHARE_INVALID_CONFIG`
- 生产配置：`mail-worker/wrangler.toml:58` 该项**只有注释、没有赋值**，缺省即 false；`:60` 明确「此处保持注释…取消注释会把 Dashboard 的 true 覆盖回 false」
- 需求依据：`requirements.md:200` AC-LIFE-11 第 ⑤ 条（旧 Worker 不认识该列，写入有限 N 会在随机路由下放出超出 N 的邮件）
- ADR 发布态：`ADR-mailbox-share-capability-extension.md:53`「生产默认关闭…读到 Accepted 不等于读到「已生效」」
- 前端对应表现：被拒后 `degradeToInactive()` 置灰四组控件并显示「能力未激活」（`ShareCreateWizard.vue:654-660, 234-242`）

**即：今天在生产 UI 里把「邮件条数上限」填成 3，会被后端拒绝并整组置灰。** 「确认保留」这个动作只对**代码语义**成立；要让它真正可用，需要一次独立的能力激活部署（迁移完成 + 回填重跑 + 无旧 Worker 在途 + 告警消费者就绪）。

---

## 7. 访客页对应展示（C 点）

| 事项 | 现状 | 锚点 |
|---|---|---|
| 前端分页粒度 | `PAGE_LIMIT = 50`（与 `message_limit` 无关，是网络分页大小） | `share/index.vue:241` |
| 首屏补齐 | 游标向旧翻页循环，最多 40 页；`list.length < PAGE_LIMIT` 或无 `nextCursor` 即停 | `share/index.vue:837-860`（上限常量 `:242`） |
| 轮询 | 每周期一次 status + 一次 mails，`limit: PAGE_LIMIT` | `share/index.vue:385-401` |
| 前端是否自行截断 N | **否**，前端不做条数裁剪 | 需求硬约束 `requirements.md:125` AC-MAIL-05「服务端 SHALL 为唯一强制点，SHALL NOT 依赖前端截断」 |
| 与 B 的对应关系 | `messageLimit=3` 时服务端子查询只产出 3 行，首屏第一页即拿满并因 `list.length < 50` 停止循环，访客自然只看到 3 封 | 服务端 `share-scoped-email-repository.js:117`；前端停止条件 `share/index.vue:855` |
| OTP 卡片 | 纯展示组件，从 `mails` 里挑最新带 `code` 的一封，无自己的条数逻辑 | `ShareOtpCard.vue:44-45, 73-80` |
| session 下发 | `messageLimit` 随 session 下发给前端（仅供展示口径，非强制点） | `share-auth-service.js:409`；`requirements.md:103` AC-SESS-09 |

**结论**：访客侧与 B 的语义一致，无需改动；`message_limit` 变小后，下一次请求即生效（不需要访客重开链接）。

---

## 8. 重复实现 & 可复用扫描

| 能力 | 结论 | 锚点 |
|---|---|---|
| 复制（含降级） | **已有 SSOT，直接复用，禁止再造** | `useCopyWithFallback.js:120-209`，4 个消费者见 §4 |
| 分享 URL 拼装 | 已有纯函数，`origin + /s/<lid>#<sec>`，前后端两侧同形 | 前端 `email/build-share-url.js:1-9`；后端 `mail-share-service.js:535` |
| 一次性密钥展示 UI 形态 | 已有两处同构实现（向导链接/密钥、抽屉 AuthKey），T-21 曾裁决**不抽公共组件**（`T21-INLINE HOLD`） | `ShareCreateWizard.vue:35-65`、`ShareDetailDrawer.vue:300-317`；裁决记录 `docs/specs/mailbox-share-capability/tasks.md:498` |
| 「重新下发凭据」的现成范式 | `resetAuthKey` 已实现 enable/reset/disable 三态 + `credentials_version` 失效旧会话，**若走 S2（重新生成链接）可照此形状扩展**，非从零设计 | `mail-share-service.js:1334-1369`；`requirements.md:159` AC-ADMIN-05、`:113` AC-AUTH-08 |

**外部检索**：本轮未做 exa/tavily 外部检索 —— 两个议题都是本仓既有实现的语义核实，无「是否该引入外部库」的决策点。`unverified: 未做外部开源方案检索（判定为本轮无适用场景）`。

---

## 9. 架构 / 前提质疑 + 业务现实检查

### 9.1 需求 1（链接可复制、不止展示一次）

XY 回推：用户说的 Y =「链接被隐藏了、不能复制、只显示一次」；真实 X = **「我错过了那一次，就永久拿不回这条链接」**。

- 「隐藏 / 不能复制」两条与代码不符（§2、§4）→ 需求描述基于误解，实现时不应照字面做「解除掩码 / 加复制按钮」，那会造出重复能力。
- 剩下的真问题「拿不回」，其代价分层很清楚：
  - 会话内拿不回 = **纯前端销毁时机问题，S1 可解，零安全代价**；
  - 刷新/次日拿不回 = **后端只存 HMAC，S1 无解**，只能 S2（重新生成）或 S3（改存储）。
- **业务现实检查（§0.17 四问）**：① 场景：Owner 创建后被打断/误关弹窗，需要重新拿到链接分发给同事 —— 真实存在；② 缺失影响：只能 revoke + 重建，占用活跃额度且需重新通知对方 —— 真实业务损耗；③ 既有覆盖：`resetAuthKey` 覆盖的是第二因子不是链接本身，**无既有机制覆盖**；④ 分类：**B 稳定性保护 / A 业务必要之间**（取决于「刷新后还能拿回」是否是硬需求）。**不是 D 类技术洁癖**，可以做。

### 9.2 【架构级提示】S3 会推翻既定安全边界

若最终选择「服务端可重新下发同一条原链接」，等于要求服务端持有可逆凭据，这会：
- 推翻 AC-CAP-04 / AC-CAP-05 / AC-CAP-09 / AC-CAP-14 四条已定稿验收（§5）；
- 推翻 ADR 的 capability-URL 边界（`ADR-...-extension.md:9,15`）；
- 把「DB/日志/备份泄漏 ⇏ 可用链接」这条防线降级；
- 需要新的密钥管理与轮换方案（现有 PEPPER 只服务 HMAC，不是加密密钥）。

**这属于需要用户明确裁决的方向选择，侦察员不替选。** 建议优先评估 S1（零安全代价，解决大部分真实场景）+ 可选 S2（覆盖跨会话场景，语义为「换一条新链接」而非「看回旧链接」）。

### 9.3 需求 2（邮件条数上限）

语义核实通过、可保留（§6.4）。但**「确认保留」不等于「现在能用」**（§6.5）：生产栅栏关闭。需要用户决定的是「是否把 `SHARE_CAPABILITY_V2` 激活列入本轮范围」—— 这是一次部署动作，带四项前置条件，**不是代码改动**。

---

## 10. 真实修改范围（相对需求描述的增减）

| 需求描述 | 真实需要做的 | 增/减 |
|---|---|---|
| 「取消链接隐藏处理」 | **无需做**（从未掩码） | 减 |
| 「链接支持复制」 | **无需做**（已有复制 + 三级降级） | 减 |
| 「不能仅展示一次」 | 前端：改 `created` 销毁时机（S1）；可选后端：新增重新生成端点（S2） | 保留，需先裁决 S1/S2/S3 |
| 「确认保留邮件条数上限语义」 | **代码零改动**；需回报「动态最新 N 封 + 当前被栅栏挡住」两个事实 | 减（改动）/ 增（信息同步） |

预估落到代码的最小闭环（若只做 S1）：`ShareCreateWizard.vue` 三处销毁点 + 对应 spec；`ShareDialog.vue` 同构一处。**不触碰后端、不触碰访客页。**

---

## 11. 可执行工作包拆分

| 包 | 范围 | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|
| W0（前置 · 非编码） | 用户/主 AI 裁决 | 选 S1 / S1+S2 / S3；是否把 V2 激活纳入范围 | 无 | — | 主 AI + 用户 |
| W1 | `ShareCreateWizard.vue`（`:432,553-558,571-580,582-584`）+ `ShareCreateWizard.spec.js` | 明文在向导内可反复查看/复制，直到显式「我已保存」；关闭确认文案同步 | W0 选 S1 | ✅ | 1 |
| W2 | `email/ShareDialog.vue`（`:25-39,184-191`）+ `ShareDialog.spec.js` | 旧入口同构对齐，避免两个入口行为分叉 | W0；与 W1 同源决策，建议同人或严格对齐 | ⚠️ 与 W1 语义耦合，建议串行或同包 | 1 |
| W3（可选） | `mail-share-service.js` 新端点 + `mail-share-api.js` + 前端调用 + 全套 spec | 「重新生成链接」：重置 `sec_hmac`、bump `credentials_version`、返回新链接一次 | W0 选 S2；必须先补 ADR/需求条目 | ✅（与 W1/W2 无文件交集） | 1-2 |
| W4（文档） | `requirements.md` / `design.md` / ADR update log | 记录「一次性」边界的调整或维持 + rationale | W0 | ✅ | 1 |
| W5（信息回报，非编码） | 无代码 | 向用户说明 `message_limit` 语义 + V2 栅栏现状 | 无 | ✅ | 主 AI |

**风险交叉区**：
- W1 与 W2 改的是**同一套一次性展示语义的两个副本**（T-21 曾裁决不抽公共组件，`tasks.md:498`）。两包并行会产生行为分叉 → **建议合成一包或严格串行**。
- W3 若落地，会改动 `mail-share-service.js` 这个 1500+ 行的核心文件，与任何其它后端改动冲突 → 单独占用。
- W4 的 `requirements.md` 与 W3 的验收条目相互引用 → W3 先出契约，W4 收尾。

**给主 AI 的派发建议**：W0 必须先完成（这是需求方向裁决，不是技术问题）。W0 落定前不要派 executor —— S1 与 S3 的修改范围差一个数量级。

---

## 12. Domain-Model 对账

`docs/domain/` 目录不存在（本仓用 `docs/specs/<feature>/` + `docs/architecture/ADR-*` 承担该职责）。跨切面语义的真源为：
- 凭据生命周期：`docs/specs/mailbox-share-capability/requirements.md` AC-CAP-04/05/09/14 + `ADR-mailbox-share-capability-extension.md`
- 可见集模型：`requirements.md` 术语表 `:40-41` + AC-MAIL-01~09 + `share-scoped-email-repository.js:88-92` 的 Single-range-SSOT 注释

对账结论：
- 邮件条数上限 → **[匹配]**，代码与 AC-MAIL-03/04、AC-EDGE-06 逐字一致，无需改模型。
- 分享链接一次性 → **[需模型变更 · 视裁决而定]**：S1 不动模型（明文仍不落库）；S2 需新增「凭据轮换」状态转移（可复用 AuthKey 的 `credentials_version` 范式）；S3 **违反现有不变量**（「明文不可从服务端重建」），必须先改 ADR 再改代码。

---

## 13. 未核实项（诚实标注）

- `unverified: 未做外部开源方案检索` —— 判定本轮两个议题均无外部选型决策点（§8）。
- `unverified: 未实际运行任何测试或启动服务` —— read-only 侦察，全部结论来自源码/文档静态锚点。
- `unverified: 未核实生产 Cloudflare Dashboard 中 SHARE_CAPABILITY_V2 的实际取值` —— 仅能确认仓库内 `wrangler.toml:58` 保持注释、代码缺省 false；Dashboard 侧需运维确认。
