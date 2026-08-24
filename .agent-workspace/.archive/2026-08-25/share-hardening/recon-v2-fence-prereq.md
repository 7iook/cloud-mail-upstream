# 侦察报告 · `SHARE_CAPABILITY_V2` 发布栅栏四项激活前置核实

- 模式:Mode R(现实核实)· read-only,零代码改动
- 日期:2026-08-25
- 范围:`mail-worker/` + `docs/specs/mailbox-share-capability/` + `docs/architecture/`
- HEAD:`03e5711`(`git log --oneline -1`)

---

## 0. 一句话结论

**四项前置,零项可从代码判定为「已满足」。** 两项(迁移、回填)的**代码资产已完整存在于仓库**,但「是否已在目标 D1 应用/跑完」在本项目里**没有任何版本记录机制**可查 —— 迁移是幂等 `ALTER`/`CREATE IF NOT EXISTS` 的手工触发式,不写版本表。另两项(无旧 Worker、告警消费者)**代码里根本不存在判据**,是纯平台侧事实。全部需运维执行下列命令确认。

另有两条本次侦察发现的、影响第 4 项达标的代码侧缺口(§4),发布前应一并处置。

---

## 1. 计划假设清单

从 `requirements.md:200`(AC-LIFE-11)与 `design.md:220` 提取的、现实可推翻的假设:

| # | 假设 | 出处 |
|---|---|---|
| H1 | 存在「数据库迁移」这一可判定完成的动作 | `requirements.md:200` |
| H2 | 存在「最终回填」脚本,且可判定其重跑完成 | `requirements.md:200`、`design.md:219` |
| H3 | 「无旧 Worker 在途」有可查判据 | `design.md:217-223`、`requirements.md:198` |
| H4 | 关键日志事件已产出且形状满足告警消费 | `design.md:449-460` |
| H5 | 栅栏回退安全(已写入策略不被静默改写) | `requirements.md:200` 末句 |
| H6 | 本地/生产开启方式已有文档 | `wrangler.toml:58-60` |

---

## 2. 四项前置核实结论表(核心交付)

| # | 前置项 | 结论 | 证据锚点 | 运维确认命令 |
|---|---|---|---|---|
| **1** | 数据库迁移完成 | **代码侧已满足;实际库状态无法从代码判定 → 需运维确认** | `mail-worker/src/init/init.js:38-89`(`v3_2DB`)· 触发入口 `mail-worker/src/api/init-api.js:4` | 见 §2.1 |
| **2** | 最终回填重跑完成 | **回填脚本已存在;是否跑完无法从代码判定 → 需运维确认** | `mail-worker/src/init/init.js:93-106`(`backfillShareBindings`)· `:111-137`(`revokeInvalidShares`) | 见 §2.2 |
| **3** | 无旧 Worker 在途 | **代码中无任何版本标记,纯运维/平台事实 → 需运维确认** | 判据出处 `docs/specs/mailbox-share-capability/design.md:217-223`;全仓无 worker version marker | 见 §2.3 |
| **4** | 关键日志事件已有告警消费者 | **事件产出点已全部就位;告警消费者是 Cloudflare 侧配置,代码完全无从判断 → 需运维确认**。**另有两条代码缺口需先修**(§4) | 事件常量 `mail-share-service.js:40-47`;9 个产出点见 §2.4 | 见 §2.4 |

### 2.1 前置 1 · 数据库迁移

**代码事实(已核实)**

本项目**没有 `.sql` 文件、没有 drizzle-kit migrations 目录、没有迁移版本表**(全仓 `**/*.sql` glob 零命中)。迁移全部写在 `mail-worker/src/init/init.js`,由 `init()` 顺序调用 `intDB → v1_1DB → … → v3_2DB`(`init.js:14-33`)。

`v3_2DB`(`init.js:38-89`)与分享能力 V2 相关的全部内容,与需求点名的列**逐条对得上**:

| 需求点名的列 | 代码锚点 | 状态 |
|---|---|---|
| `max_sessions` | `init.js:41` | ✅ 在仓库 |
| `message_limit` | `init.js:42` | ✅ |
| `only_messages_after_created` | `init.js:43` | ✅ |
| `otp_extraction_enabled` | `init.js:44` | ✅ |
| `auto_refresh` | `init.js:45` | ✅ |
| `refresh_interval_ms` | `init.js:46` | ✅ |
| `show_full_address` | `init.js:47` | ✅ |
| `auth_key_hash` | `init.js:49` | ✅ |
| `auth_key_kid` | `init.js:50` | ✅ |
| `credentials_version` | `init.js:51` | ✅ |
| (需求未点名但同批)`auth_key_enabled` | `init.js:48` | ✅ |
| `mail_share_binding` 表 | `init.js:63-71` | ✅ |
| 两个索引 `idx_msb_share_account` / `idx_msb_account` | `init.js:74-75` | ✅ |

**为什么无法从代码判定实际库状态**

三条独立原因,每条单独就足以否定「代码能判定」:

1. **无版本记录机制**。`init()` 每次调用都从 `intDB` 跑到 `v3_2DB` 全量重放;每条 `ALTER TABLE` 包在 `try/catch` 里,失败只打 `console.warn('跳过字段：…')`(`init.js:54-60`),建表/建索引用 `IF NOT EXISTS`。**没有任何一张表记录「跑到了哪个版本」**,因此代码运行时也不知道自己有没有迁移过。
2. **迁移不是部署自动触发的**。唯一入口是 `GET /api/init/:secret`(`init-api.js:4`,`security.js:16` 将 `/init` 列为免鉴权路径,靠 `init.js:10` 比对 `c.env.jwt_secret` 保护)。`index.js:28-40` 的 cron **不含** init。也就是说:**部署了含 `v3_2DB` 的代码 ≠ 迁移已应用**,必须有人手工访问过该 URL。
3. **`ADD COLUMN` 的失败被吞成 warn**。若某列因任何原因(如同名列已存在于不同类型)未加上,`init` 仍返回 `success`(`init.js:35`)。「调用过 init 并看到 success」不能证明 11 列全部到位。

> **结论:需运维执行 `wrangler d1` 查询确认。**

**可执行确认命令**(生产库名替换 `<DB_NAME>`;`wrangler.toml:22-25` 的 d1 配置是注释状态,生产库名由部署方在 Dashboard 或自己的 toml 里填,需向运维索取):

```powershell
# ① 确认 mail_share 的 11 个 V2 列全部到位（期望输出 11 行）
npx wrangler d1 execute <DB_NAME> --remote --command "SELECT name FROM pragma_table_info('mail_share') WHERE name IN ('max_sessions','message_limit','only_messages_after_created','otp_extraction_enabled','auto_refresh','refresh_interval_ms','show_full_address','auth_key_enabled','auth_key_hash','auth_key_kid','credentials_version');"

# ② 确认 mail_share_binding 表存在
npx wrangler d1 execute <DB_NAME> --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='mail_share_binding';"

# ③ 确认两个索引存在（期望 idx_msb_share_account 与 idx_msb_account 各一行）
npx wrangler d1 execute <DB_NAME> --remote --command "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mail_share_binding';"
```

本地库同一套命令,把 `--remote` 换成 `--local`,并加 `--config wrangler-dev.toml`(本地库名 `email`,见 `wrangler-dev.toml:22-25`)。

---

### 2.2 前置 2 · 最终回填重跑

**回填在做什么(已核实,非推测)**

`backfillShareBindings`(`init.js:93-106`)确实就是把存量单邮箱 share 的 `account_id` 回填进 `mail_share_binding`,但**带迁移门禁**:

```sql
INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id, create_time)
SELECT ms.share_id, ms.account_id, ms.window_start_email_id, ms.create_time
FROM mail_share ms
JOIN account a ON a.account_id = ms.account_id AND a.is_del = 0 AND a.user_id = ms.user_id
WHERE NOT EXISTS (SELECT 1 FROM mail_share_binding b WHERE b.share_id = ms.share_id)
```

`is_del = 0` 来自 `isDel.NORMAL`(`mail-worker/src/const/entity-const.js:147-150`)。门禁三条件:account 存在 + 未删 + 归属匹配。`WHERE NOT EXISTS` 使其**幂等**,可安全重跑。

紧随其后的 `revokeInvalidShares`(`init.js:111-137`)把**门禁不通过**的 ACTIVE 旧行置 `REVOKED`。其判据**只取 account 事实、不看有无 Binding**(`init.js:108-110` 注释写明 R3-A2 裁决):这正是「交错安全」—— 迁移窗口内旧 Worker 晚写的合法行此刻尚无 Binding,不会被误判终态,留待**重跑**收编。**「最终回填重跑」这个前置存在的原因就在这里。**

**脚本在哪 / 怎么重跑**

回填**没有独立脚本、没有独立路由、不在 cron**。它是 `v3_2DB` 的最后两步(`init.js:87-88`),因此:

> **重跑回填 = 再访问一次 `GET /api/init/{jwt_secret}`。** 全量迁移重放是幂等的,这是设计内的正常操作。

**如何判断它跑完了 → 需运维确认**

代码不记录回填执行次数或时间戳。唯一可靠判据是**查询残留量为 0**:

```powershell
# ④ 应回填而未回填的合法旧行数（期望 pending = 0）
npx wrangler d1 execute <DB_NAME> --remote --command "SELECT COUNT(*) AS pending FROM mail_share ms JOIN account a ON a.account_id = ms.account_id AND a.is_del = 0 AND a.user_id = ms.user_id WHERE NOT EXISTS (SELECT 1 FROM mail_share_binding b WHERE b.share_id = ms.share_id);"

# ⑤ 零 Binding 的 ACTIVE 分享（期望 0；非 0 说明既没回填也没被 REVOKED，属需人工看的残留）
npx wrangler d1 execute <DB_NAME> --remote --command "SELECT COUNT(*) AS zero_binding_active FROM mail_share ms WHERE ms.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM mail_share_binding b WHERE b.share_id = ms.share_id);"

# ⑥ 孤儿 Binding（期望 0；判据与 mail-share-cleanup-service.js:11-17 的 LEGAL_BINDING 同源）
npx wrangler d1 execute <DB_NAME> --remote --command "SELECT COUNT(*) AS orphan FROM mail_share_binding msb WHERE NOT EXISTS (SELECT 1 FROM mail_share ms JOIN account a ON a.account_id = msb.account_id AND a.is_del = 0 AND a.user_id = ms.user_id WHERE ms.share_id = msb.share_id);"
```

**推荐顺序**:先跑 ④⑤⑥ 看基线 → 访问一次 `/api/init/{jwt_secret}` → 再跑一次 ④⑤⑥ 确认 `pending = 0` 且数字稳定不再变化。「稳定」比「等于 0」更重要:两次之间若还有新增,说明仍有旧 Worker 在写(直接关联前置 3)。

---

### 2.3 前置 3 · 无旧 Worker 在途

**「旧 Worker」指什么(已核实)**

指 Binding 模型上线前的 Worker 版本。代码里给出了确切基线:`mail-share-service.js:223` 注释 ——「旧 Worker(基线 `5a81065`)的指纹只含 accountId/durationSeconds/name/remark」;`mail-worker/test/mail-share-service.spec.js:178` 同一措辞。旧 Worker 的特征是**不认识 `auth_key_enabled` / `credentials_version` / `max_sessions` / `message_limit` / `mail_share_binding`**,只按 `mail_share.account_id` 单列授权。

**为什么它危险**:`design.md:217` 写得很直白 —— 兼容窗口内新旧代码随机路由,一旦 V2 策略落库而请求落到旧 Worker,就是**策略降级入口**(仅凭 `lid+sec` 建会话、配额超发、reset 后旧 token 不拒)。栅栏拦在写入侧、不拦读取侧,原因就是这个(`mail-share-service.js:72-74` 注释)。

**判据:代码里查不到 → 纯运维动作**

全仓无 worker 版本号、无 `/version` 端点、无部署标记写库。这条**只能**从 Cloudflare 部署面确认:

```powershell
# ⑦ 查看部署历史，确认最新版本已生效且无回滚版本在跑
npx wrangler deployments list

# ⑧ 确认当前线上版本
npx wrangler deployments status
```

**判定口径**(建议向运维明确):最后一次 `wrangler deploy` 的时间戳 ≥ 含 `v3_2DB` 的代码入库时间(`4f72418 feat(worker): add v3_2DB mail_share binding migration`),且此后无回滚/无灰度分流版本。Cloudflare Workers 部署为全球边缘传播,官方不承诺瞬时一致 —— 稳妥做法是**在最后一次部署后留出观察窗口,并用 §2.2 的 ④⑤ 复查两次数字是否稳定**(仍有旧 Worker 在写会表现为 pending 反复出现)。

> `unverified: 无法从代码判定线上 Worker 版本与部署时间,需运维执行 ⑦⑧ 并给出最后部署时间戳。`

---

### 2.4 前置 4 · 关键日志事件已有告警消费者

**代码侧:事件清单与产出点全部就位**

事件名常量 SSOT 在 `mail-share-service.js:40-47`(`SHARE_EVENT`),与 `design.md:453-458` 逐条对应。统一出口 `logShareEvent`(`mail-share-service.js:86-96`),输出单行 JSON。

| 事件名 | 语义 | 产出点 `file:line` | 发布门槛点名 |
|---|---|---|---|
| `share.session.denied_quota` | 配额触顶拒发 | `share-auth-service.js:417` | ✅ **必须告警** |
| `share.session.denied_auth` | AuthKey 不匹配 | `share-auth-service.js:525` | |
| `share.session.denied_cv` | `credentials_version` 失配 | `share-auth-service.js:592` | |
| `share.binding.cascade` | Binding 级联剔除/撤销 | `mail-share-service.js:1465`(account 删除)· `mail-share-cleanup-service.js:103`(到期)· `:108`(孤儿清扫) | |
| `share.migrate.invalid_row` | 迁移门禁不通过的旧行 REVOKED | `init.js:127-134` | ✅ **必须告警** |
| `share.system.error` | 未归类系统故障(KV 读/写失败) | `share-auth-service.js:473` · `:491` | ✅ **必须告警** |

「必须告警」列依据 `design.md:460`:*启用 `SHARE_CAPABILITY_V2` 前,上述事件清单(至少 `share.migrate.invalid_row`、`share.session.denied_quota`、`share.system.error`)必须已有告警消费者(阈值 + 接收人),否则不得置 true*。

**「已有告警消费者」如何验证 → 代码完全无从判断**

告警消费者是 Cloudflare 侧配置(Workers Logs / Logpush → 外部 SIEM → 阈值规则 + 接收人),仓库里**没有任何对应物**:无 Logpush 配置、无告警规则文件、无 Terraform/IaC。`wrangler.toml:6-7` 只有 `[observability] enabled = true`,那是**采集端**开关,不是消费端 —— `design.md:460` 原文也是这么区分的(「日志检索即消费端」在 R3-A7 被明确改为「采集端 + 门槛」)。

> **需运维确认**,且这一项**无法用 wrangler 命令自证**。建议要求运维出具三项书面确认:① 三个必须告警事件各自的**阈值**;② **接收人**;③ 一次**告警链路实测**记录(人为触发一条 `share.system.error` 并确认接收人收到)。

可用于辅助核对采集是否通的命令:

```powershell
# ⑨ 实时观察线上日志流，确认结构化事件确实进入 Cloudflare 采集端
npx wrangler tail --format json
```

---

## 3. 重复实现与可复用扫描

- **内部**:`assertCapabilityV2` 是唯一栅栏判定函数(`mail-share-service.js:77-82`),`isCapabilityV2Enabled`(`:67-70`)是唯一取值点。8 个调用点无重复实现,SSOT 成立 —— 见 §5。
- **内部**:回填 SQL 的三条件门禁在三处出现且**注释声明必须逐字同源**:`init.js:98-100`(回填)、`mail-share-cleanup-service.js:11-17`(`LEGAL_BINDING`)、`mail-share-service.js` 的 `prepareBindingInsert`。这是有意的三点同源,不是重复实现,但**改动其一必须同改其三**(`mail-share-cleanup-service.js:7-10` 注释明确要求)。
- **外部**:未做开源检索 —— 本任务是既有部署门槛核实,无新建能力,`not applicable`。

---

## 4. 架构 / 前提质疑 + 本次发现的代码缺口

### 4.1 缺口 A · 全部结构化日志的 `requestId` 恒为 `null`(影响前置 4)

`design.md:451` 明确要求「**每条日志携带 `requestId` 与 `shareId`**(R2-F2,请求关联字段)」。`logShareEvent` 的签名确实预留了(`mail-share-service.js:87`:`const { requestId = null, shareId = null, ...rest } = fields`)。

但**核实全部 8 个 `logShareEvent` 调用点,没有任何一个传 `requestId`**:

| 调用点 | 实传字段 |
|---|---|
| `share-auth-service.js:417` | `{ shareId, reason }` |
| `share-auth-service.js:473` | `{ shareId: row.shareId, reason }` |
| `share-auth-service.js:491` | `{ shareId, reason }` |
| `share-auth-service.js:525-528` | `{ shareId, reason }` |
| `share-auth-service.js:592-595` | `{ shareId, reason }` |
| `mail-share-service.js:1465-1469` | `{ shareId, reason, removedBindings, revoked }` |
| `mail-share-cleanup-service.js:103-105` | `{ shareId, reason, removedBindings, revoked }` |
| `mail-share-cleanup-service.js:108-110` | `{ shareId, reason, removedBindings, revoked }` |

结果:线上每条事件的 `requestId` 都是 `null`。**告警消费者无法按请求关联** —— 一条 `share.system.error` 无法回溯到具体请求。这不阻塞栅栏开启的安全性,但让 R3-A7 门槛的「告警可用性」打折。建议在开栅栏前补,或至少在告警规则设计时明确「本期不按 requestId 关联」。

### 4.2 缺口 B · `share.migrate.invalid_row` 绕过 SSOT,字段形状与其余五个不同(影响前置 4)

其余 5 个事件都走 `logShareEvent`,信封形如 `{...rest, event, requestId, shareId, ts}`。而 `share.migrate.invalid_row` 在 `init.js:127-134` 是**手写 `console.log(JSON.stringify(...))`**,字段为 `{event, migration, shareId, accountId, reason, ts}` —— **没有 `requestId` 键**(其余五个有该键但值为 null),且**多了 `accountId`**。

两个后果:① 若告警规则按 `requestId` 字段存在性过滤,会**整类漏掉**这个事件 —— 而它恰是发布门槛点名必须告警的三个之一;② `accountId` 是 `logShareEvent` 注释(`mail-share-service.js:85`)禁止的字段类别边缘(注释禁「邮箱地址」,`accountId` 是行号不是 PII,尚可接受,但偏离了 SSOT 的约束面)。

> 原因可理解:`init.js` 若 import `mail-share-service` 会引入迁移路径对 service 层的依赖。但**告警规则必须知道这个事件形状不同**。

### 4.3 前提质疑

**这四项前置本身是否成立?** 成立,且理由在代码里可验证 —— 不是文档上的仪式。`mail-share-service.js:72-74` 用三行注释说明了栅栏为何拦写入侧不拦读取侧;`design.md:217` 给出了随机路由降级的具体四条路径。**未发现「在错误架构上打补丁」的迹象**,栅栏设计与代码实现一一对应(前序侦察 `recon-config-keys.md:239` 也已核实文档与代码在这块同步)。

**业务现实检查(§0.17)**:本任务不新建能力,是核实既有部署门槛 → `not applicable`。

---

## 5. 开启 / 回退风险面

### 5.1 栅栏为什么存在

`git log -S "SHARE_CAPABILITY_V2"` 定位到引入提交 **`e878760 feat(worker): add V2 fence, dual-write helper, test seeds`**(其后 `b6f5a28` 接入 create、`ee2db41` 接入 bindings、`3bb1d55` 接入 resetAuthKey)。

裁决链:`SHARE_MULTI_ENABLED`(R2-A1)→ 升级为 `SHARE_CAPABILITY_V2` 全能力栅栏(R3-A1),记录在 `design.md:709`、`ADR-mailbox-share-capability-extension.md:24`。**核心理由**(`design.md:217`):只门控 multi create 不够 —— 旧 Worker 不认识 `auth_key_enabled`/`credentials_version`/配额条件,这些策略一旦在兼容窗口内落库,随机路由到旧 Worker 的请求就绕过第二因子与配额。

ADR 明确定性(`ADR-…-extension.md:45`):这是把「随机路由策略降级」换成「新能力延迟可用」的**显式取舍**。`:53` 进一步写明「读到 Accepted 不等于读到『已生效』」。

### 5.2 开启后立即改变的行为

栅栏**只拦写入,不改任何读取行为**。开启后立即解锁的是 8 个写入点:

| # | 写入路径 | 锚点 | intent |
|---|---|---|---|
| 1 | create `accountIds.length > 1` | `mail-share-service.js:355-356` | `MULTI_CREATE` |
| 2 | create `authKeyEnabled=true` | `:358-359` | `AUTH_KEY_ENABLE` |
| 3 | create `maxSessions != null` | `:361-362` | `FINITE_MAX_SESSIONS` |
| 4 | create `messageLimit != null` | `:364-365` | `MESSAGE_LIMIT` |
| 5 | update 把 `maxSessions` 设为有限值 | `:965-966` | `FINITE_MAX_SESSIONS` |
| 6 | update 把 `messageLimit` 设为有限值 | `:968-969` | `MESSAGE_LIMIT` |
| 7 | `PUT /mailShare/bindings` 使 Binding 数变大且 >1 | `:1106-1107` | `BINDING_EXPAND` |
| 8 | `resetAuthKey(action='enable')` | `:1338-1339` | `AUTH_KEY_ENABLE` |

> 注:需求文档说「四类写入」,代码是 **5 个 intent / 8 个调用点** —— `MESSAGE_LIMIT` 是第五条(`requirements.md:200` 的 ⑤ 已补,`mail-share-service.js:29-30` 与 `:960-962` 注释说明其与前四条同构)。前序侦察 `recon-config-keys.md:239` 已核实这不是漂移。

**前端**同步解冻:`ShareCreateWizard.vue:448` 的 `gatedDisabled` 依赖 `capabilityV2`。注意其实现是**懒发现**(`presets.js:22-30`):Worker 的 env 不进任何响应体,浏览器**提交前无法知道开关状态**,只有两态 —— `'unknown'`(默认,受控项**可用**)与 `'inactive'`(仅由一次真实拒绝进入)。**因此开关打开后前端无需任何改动即自动可用**;反之关闭后,用户会先吃一次拒绝才看到置灰。

**不改变的**:所有读路径。`share-auth-service.js` 全文**不引用** `SHARE_CAPABILITY_V2`(grep 零命中),配额闸门(`:54` 注释:`NULL/undefined max_sessions means unlimited`)、AuthKey 校验(`:520-530`)、`cv` 比对(`:591-597`)全部**无条件执行**。

### 5.3 回退路径:能安全关回去,且「已写入策略不被静默改写」在代码里成立

`requirements.md:200` 末句与 `design.md:223` 的回滚预案(「关闭 `SHARE_CAPABILITY_V2`,单邮箱分享因双写在旧 Worker 下保持可用」)在代码里由**三条机制**共同保障:

1. **栅栏是纯写入侧断言,不含任何数据改写**。`assertCapabilityV2`(`:77-82`)只有 `if (enabled) return; throw`。全仓无「开关 false 时清空 `max_sessions`/`auth_key_*`」之类的逻辑 —— 关掉开关**不会触碰任何已落库的行**。
2. **执行侧无条件生效**。既然 `share-auth-service.js` 不看开关(见 §5.2),回退后**已写入的 AuthKey 与配额继续被强制执行**,不会出现「策略还在库里但不再生效」的静默降级。这正是「不被静默改写」的实际含义。
3. **回退后仍留有下行通道**。`assertUpdatePatch`(`:963-971`)的触发条件是「**设为有限值**」而非「键出现在 patch 里」—— `mail-share-service.js:960-961` 注释写明:显式 `null` 是取消限制,旧 Worker 语义完全兼容,**放行**。同理 `:1106` 只拦「变大且 >1」,缩减 N→1 放行;`resetAuthKey` 只有 `enable` 受门控(`:1338`),`disable`/`reset` 放行。**即:关掉开关后,Owner 仍可主动把已有 V2 配置降级回旧语义,但系统绝不替他做。**

**回退的真实残留风险**(需向决策者说明,代码无法消除):关闭开关后,库中**仍存在**多 Binding 行与 AuthKey 行。若此时**真有旧 Worker 在跑**,它按 `mail_share.account_id`(双写维护的主 Binding,`ADR:55` 确认仍处 Expand 阶段,`syncPrimaryAccountId()` 每次变更同步)提供**单邮箱降级视图**,不越权 —— 这是 `requirements.md:198` AC-LIFE-10 路径③ 的设计。**但 AuthKey 与配额会被旧 Worker 绕过。** 所以回退的安全性同样依赖「无旧 Worker 在途」。

> **一句话**:开关可以安全关回去,前提与开启前提是同一个 —— 无旧 Worker 在途。**在旧 Worker 确实清干净之前,开与关都不安全;清干净之后,开与关都安全。**

---

## 6. 开启操作指引(两套)

### 6.1 本地开发(Windows · wrangler dev)

**推荐做法:写进 `mail-worker/.dev.vars`。**

当前 `mail-worker/.dev.vars` 只有四把密钥(`:1-4`),无 `SHARE_CAPABILITY_V2`。追加一行:

```
SHARE_CAPABILITY_V2 = "true"
```

**为什么这样可行(已核实,非推测)**:

- 本地启动命令是 `pnpm --dir mail-worker dev` → `wrangler dev --config wrangler-dev.toml`(`mail-worker/package.json:6`),**不带 `--env`**。Cloudflare 官方文档确认:未选择命名环境时,顶层 `.dev.vars` 被加载并覆盖配置文件里的 `vars`。
- `wrangler-dev.toml:48-54` 的 `[vars]` 里**没有** `SHARE_CAPABILITY_V2`,不存在冲突。
- `isCapabilityV2Enabled`(`mail-share-service.js:67-70`)只认 `'1' | 1 | true | 'true'`,`"true"` 命中。

**已知陷阱**:若将来给 `wrangler dev` 加了 `--env <name>`,`.dev.vars` 对该环境**不再生效**(workers-sdk issue #13462,官方答复为预期行为),需改用 `.dev.vars.<name>`;且一旦存在 `.dev.vars.<name>`,顶层 `.dev.vars` **整个不加载**,四把密钥也要一并复制过去。

**临时试一次不改文件**(CLI `--var` 优先级最高):

```powershell
pnpm --dir mail-worker exec wrangler dev --config wrangler-dev.toml --var SHARE_CAPABILITY_V2:true
```

**改完必须重启 `wrangler dev`** —— env 在 Worker 启动时绑定,热重载不重读 `.dev.vars`。

`.dev.vars` 已被忽略(`mail-worker/.gitignore` 存在,`git status` 显示 `mail-worker/.dev.vars` 为未跟踪),不会误提交。

### 6.2 生产开启

**推荐做法:Cloudflare Dashboard → Workers & Pages → `cloud-mail` → Settings → Variables and Secrets → 添加明文变量 `SHARE_CAPABILITY_V2 = true`。**

**三条必须遵守的约束**:

1. **绝不取消 `wrangler.toml:58` 的注释。** `wrangler.toml:60` 的注释已写明原因,本次核实其成立:`keep_vars = true`(`:4`)只保证 `wrangler deploy` **不删除** Dashboard 上已有的变量,**拦不住 toml 里显式写的值** —— toml `[vars]` 里的值会被上传并覆盖同名 Dashboard 值。取消注释写 `"false"`,下一次 `wrangler deploy` 就会把 Dashboard 的 `true` 覆盖回 `false`,且**静默无告警**。这条是 `tasks.md:754` 的 W0 明文裁决(「禁止 toml 硬写 false 覆盖 dashboard」)。
2. **用明文变量(Text),不要用 Secret / `wrangler secret put`。** 这不是凭据,是能力开关;运行时读取方式相同,但 Secret 在 Dashboard 上不可读回,会让「现在到底是开是关」变成不可自证的状态 —— 而这恰是发布门槛最需要能一眼看清的东西。(对比:`SHARE_SEC_PEPPER` / `SHARE_SESSION_SIGNING_KEY` 才应走 secret。)
3. **值必须是 `true` 或 `1`。** `isCapabilityV2Enabled`(`:67-70`)只认 `'1' | 1 | true | 'true'`,**其余一切(含 `"TRUE"`、`"yes"`、`"on"`)一律判为关闭且不报错**。写错的现象是「配了但没生效」,没有任何日志提示。

**生效方式**:Dashboard 改 Variables 会触发一次新版本部署,无需重新 `wrangler deploy`。改完请用一次真实写入验证(见下)。

**开关生效验证**(无需查库):用管理端创建一个 `maxSessions=1` 的分享 —— 开关关闭时返回 `SHARE_INVALID_CONFIG`,开启后成功。这是最短的端到端验证路径(命中 `mail-share-service.js:361-362`)。

### 6.3 发布前检查清单(建议交付给运维)

```
[ ] ① 迁移列 11 项到位            → 命令 ①②③（§2.1）
[ ] ② 访问 /api/init/{jwt_secret} 重跑回填一次
[ ] ③ pending = 0 且两次查询数字稳定 → 命令 ④⑤⑥（§2.2）
[ ] ④ 最后部署时间戳确认，无回滚版本在跑 → 命令 ⑦⑧（§2.3）
[ ] ⑤ 三个必须告警事件的阈值 + 接收人 + 一次链路实测记录（§2.4）
[ ] ⑥ 决定缺口 A/B 是本轮修还是登记为已知限制（§4.1 §4.2）
[ ] ⑦ Dashboard 置 SHARE_CAPABILITY_V2 = true（明文，不动 toml:58）
[ ] ⑧ 端到端验证：创建 maxSessions=1 的分享成功（§6.2）
```

---

## 7. 链路完整性扫描

本任务为部署门槛核实,不新建能力。但四项前置本身构成一条端到端链路,按 §0.16 落表:

| 节点 | 生产者 | 消费者 | 状态 |
|---|---|---|---|
| 迁移 DDL | `init.js:40-85` | D1 库(实际状态) | ⛔ **断点:无版本表,代码侧无法验证消费端** → 需命令 ①②③ |
| 迁移触发 | 人工 `GET /api/init/:secret`(`init-api.js:4`) | `dbInit.init`(`init.js:6`) | ✅ 完整,但**非自动**,部署不触发 |
| 回填 | `init.js:93-106` | `mail_share_binding` 表 | ⛔ **断点:无完成标记** → 需命令 ④⑤⑥ |
| 旧 Worker 判据 | 无生产者(代码中不存在) | 发布负责人 | ⛔ **断点:纯平台事实** → 需命令 ⑦⑧ |
| 日志事件产出 | `logShareEvent`(`mail-share-service.js:86`)× 8 + `init.js:127` × 1 | Cloudflare 采集端(`wrangler.toml:6-7`) | ✅ 已接线 |
| 告警消费 | Cloudflare 采集端 | **告警规则 + 接收人** | ⛔ **断点:仓库内无任何对应物** → 需运维书面确认 |
| 栅栏判定 | `isCapabilityV2Enabled`(`:67-70`) | `assertCapabilityV2` 8 个调用点 | ✅ 完整,SSOT 成立 |
| 前端降级 | `markCapabilityInactive`(`presets.js:32`) | `gatedDisabled`(`ShareCreateWizard.vue:448`) | ✅ 完整(懒发现语义,见 §5.2) |

**成功状态**(来源:`requirements.md:200` 用户侧原文 + `design.md:460` 消费端前置):

> **不是**「`SHARE_CAPABILITY_V2` 被设成了 true」,**而是**发布负责人能对四项前置各出示一份可复核的证据,随后 Owner 在管理端创建多邮箱 / AuthKey / 有限配额分享成功且 Visitor 侧正常访问。
> **负条件**:不得出现「开关已开、但仍有旧 Worker 在途导致 AuthKey 或配额被随机路由绕过」。

---

## 8. 领域模型对账

本次为**只读核实**,不触碰跨切面中间层,无模型变更。`docs/domain/` 目录不存在于本仓库(本项目用 `docs/specs/<slug>/design.md` 承担同等职责,`design.md:90-109` 的 Decision 1-20 即为模型真源)。

`not applicable:只读侦察,零代码改动,无新增 fetch/persist/render 作业或实体。`

---

## 9. 未验证项汇总(诚实声明)

- `unverified: 目标 D1 库的实际 schema 与数据状态` —— 无迁移版本表,仓库内不可判定。需命令 ①②③④⑤⑥。
- `unverified: 生产 Cloudflare Dashboard 中 SHARE_CAPABILITY_V2 的当前取值` —— 仅能确认 `wrangler.toml:58` 保持注释、代码缺省 false。
- `unverified: 线上 Worker 版本与最后部署时间` —— 代码中无版本标记。需命令 ⑦⑧。
- `unverified: Cloudflare 侧是否已配置告警规则/阈值/接收人` —— 仓库内无 Logpush/告警/IaC 配置,完全不可判定。
- `unverified: 生产 D1 数据库名` —— `wrangler.toml:22-25` 为注释状态,需向运维索取后替换命令中的 `<DB_NAME>`。
- 未跑任何测试或构建(read-only 侦察,dispatch 明确禁改代码)。
