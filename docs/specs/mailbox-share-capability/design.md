---
# ═══ CORE IDENTITY(必填 · 3 段)═══
slug: mailbox-share-capability
title: 邮箱能力分享 —— 单/多邮箱统一授权、Session 配额与可选认证
# ═══ LIFECYCLE(必填 · 状态机由主 AI 判定;spec-cross-review 只回写 last_review_* / review_rounds_done / last_updated)═══
status: shipped
review_rounds_done: 3
last_review_status: NEEDS_CHANGES
last_review_p0: 0
created: 2026-08-24
last_updated: 2026-08-24
shipped_commit: 190f704
# ═══ RELATIONSHIPS(可空 · 建知识图)═══
related_adrs: [docs/architecture/ADR-mail-share-capability-boundary.md, docs/architecture/ADR-mailbox-share-capability-extension.md]
related_specs: [docs/specs/mail-share]
supersedes: null
superseded_by: null
rca: null
# ═══ DISCOVERY(机检索用)═══
tags: [share, multi-mailbox, session-quota, auth-key, otp]
domain: business
one_line: 在既有 mail-share 上扩展多邮箱 Binding、Session 配额闸门与可选认证 Key
---

# Design · mailbox-share-capability

## Overview

把已交付的 mail-share(单邮箱 capability URL 分享)扩展为「邮箱访问能力分享」:一条 `/s/<lid>#<sec>` 链接可绑定 1..N 个邮箱,可设累计 Session 配额、可选认证 Key、每邮箱最近 N 封可见集、脱敏与刷新策略。三个关键权衡在此定死:

1. **演进 vs 重建**:既有架构(capability URL + 无状态 HMAC Session token + `share-scoped-email-repository` 反腐层)没有坏,五个目标领域对象中三个已存在或半存在。选择**就地演进**——`mail_share` 加列 + 新建 `mail_share_binding` 表,不建 `mail_share_v2` 平行表、不建服务端 Session 表。全部读路径为显式列名 SELECT(`mail-share-service.js:354-364`、drizzle 实体列枚举),加列零破坏;旧 `s1.` token 在新代码下天然可验。代价:`account_id` 旧列与 Binding 表并存期的双真源风险,用「迁移门禁回填 + 新代码读路径只信 Binding + Expand 阶段双写主 Binding + `SHARE_CAPABILITY_V2` 全能力栅栏」的分阶段发布协议封死(R2-A1 · R3-A1,见「迁移/发布协议」)。
2. **无状态 token + 配额闸门**:`max_sessions` 是累计建立次数上限(用户裁决 D5),不是并发数——因此**不需要**服务端 Session 表,单条原子条件 UPDATE(物理列 `access_count` 承载领域量 `used_sessions`,条件含生命周期/凭据版本/配额,模式已被 `transaction.spec.js`/`mail-share-service.js:187-218` 验证)即是闸门。旧 charter「无服务端 session 表」的 A1 裁决得以保留;AuthKey 重置的「旧 Session 立即失效」用行上 `credentials_version` + token 携带版本号回源比对实现,同样零 Session 存储。
3. **统一 status 轮询**:多邮箱页禁止 N 路并行轮询(用户裁决 D16,Cloudflare 边缘限流 100/60s 下 N 路轮询会自我 DoS)。`email_id` 全局单调(`email.js` PK AUTOINCREMENT)使每 Binding 的 `latestEmailId` 可直接比较——新增一个 `GET /share/mailboxes/status` 端点一次返回各 Binding 最新水位(**无游标参数**,R2-A2:单个全局标量无法表达 per-binding 消费进度),hasNew/角标由客户端本地 per-binding 水位比较得出,前端 `useSharePolling` 保持单实例。

## Current-State Inventory (from recon — MANDATORY)

来源:`.agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-{backend,frontend,crosscut}.md`,锚点已由本执行者于 2026-08-24 工作树抽查复核。

| Path | Type | Interface/Fields | Reuse decision |
|---|---|---|---|
| `mail-worker/src/entity/mail-share.js:4-21` | drizzle 实体 | `mail_share` 17 列,含 `accountId`(单值)、`accessCount`、`windowStartEmailId` | ✅ extend:加配置/配额/auth 列;`accountId` 转 Expand 期双写列(主 Binding,鉴权零读取,R2-A1) |
| `mail-worker/src/init/init.js:39-79` | DDL+索引 | `mail_share`/`share_idempotency` 建表 + 5 索引(v3_1DB) | ✅ extend:新增 v3_2DB 挂 `init.js:31-32` 注册链 |
| `mail-worker/src/service/share-auth-service.js:25-33` | Fn | `effectiveStatus(row, now)` 三态计算 | ✅ extend:加 `ACCESS_LIMIT_REACHED` 分支 |
| `share-auth-service.js:86-89` | Fn | `digestShareSecret(sec, pepper)` HMAC-SHA256 | ✅ reuse:auth_key_hash 同款设施 |
| `share-auth-service.js:155-180,182-207` | Fn | `issueToken`/`verifyToken`,`s1.<kid>.<payload>.<sig>`,payload `{shareId,lid,iat,exp,kid}` | ✅ extend:payload 加 `cv`(credentials_version),保持 `s1` 版本 |
| `share-auth-service.js:236-241` | Fn | `recordAccess`:`access_count+1` 原子自增,fire-and-forget | ✅ absorb:升级为配额闸门条件 UPDATE(语义变更,见 Decision 4) |
| `share-auth-service.js:243-272` | Fn | `establishSession(c, lid, sec)`:验摘要→活性→发 token→计数 | ✅ extend:加 authKey 第三参、配额闸门 |
| `share-auth-service.js:274-296` | Fn | `resolveSession`:验签→查行→比 lid→effectiveStatus→account 存活→返回单值 `accountId` ctx | ✅ extend:ctx 集合化(Binding 清单)、cv 比对 |
| `mail-worker/src/service/mail-share-service.js:104-110` | Fn | `loadOwnedAccount`:单 account 归属校验 | ✅ extend:批量 IN 校验 |
| `mail-share-service.js:187-218` | SQL | 单语句条件 INSERT(活跃上限 + window 快照原子化) | ✅ reuse:配额闸门同款单语句模式 |
| `mail-share-service.js:354-364` | SQL | Owner list:显式列名 SELECT + LEFT JOIN account | ✅ extend:JOIN 改经 Binding、投影加新字段 |
| `mail-share-service.js:394-415` | Fn | `revokeByAccountIds`:按主表 `account_id IN` 直查撤销 | ⚠️ rework:改经 Binding JOIN(剔除 Binding→剩 0 才撤销,D15) |
| `mail-worker/src/service/share-scoped-email-repository.js:60-68` | Fn | `visibleWindowConditions`:`accountId` 单值等值 + 单标量 window 下界 | ✅ extend:`inArray` + per-binding 下界 + message_limit DESC 截断 |
| `mail-worker/src/service/share-mail-service.js:46-63` | Fn | `project(emailRow)`:白名单 DTO 含 `code` | ✅ extend:加 Binding 标识/掩码地址;`code` 按开关条件剔除 |
| `mail-worker/src/service/share-attachment-service.js:126-161` | Fn | 附件三重校验,`shareContext.accountId` 单值假设 | ✅ extend:多 Binding 集合校验 |
| `mail-worker/src/api/mail-share-api.js:23-38` | Endpoint | Owner 3 端点 create/list/revoke(无 update/get/delete) | ✅ extend + 新增 5 端点 |
| `mail-worker/src/api/share-api.js:54-88` | Endpoint | Visitor 4 端点 session/mails/mail/attachment | ✅ extend + 新增 status 端点 |
| `mail-worker/src/security/security.js:23-29` | 配置 | `excludeExact` 精确豁免 4 条 Visitor 路由 | ✅ extend:加 `GET /share/mailboxes/status` 一行 |
| `security.js:103` | 配置 | `premKey['share:manage']` → 3 条 `/mailShare/*` | ✅ extend:path 列表加新端点 |
| `mail-worker/src/security/share-rate-limit.js` | 中间件 | CF 边缘限流(IP 维度),429+Retry-After,fail-open | ✅ reuse:新端点直接套用 |
| `mail-worker/src/service/mail-share-cleanup-service.js:20-28` | 定时任务 | 删幂等行 + 删到期 `mail_share` 行(2 表) | ✅ extend:同批删 Binding 行 + 孤儿 Binding 补偿(R1-A9;R2-A6 删除 auth_fail 表,无此项清理) |
| `mail-worker/src/email/email.js:95-131` + `ai-service.js:5-69` | 摄取链 | OTP 提取写 `email.code`,失败空串,全局门控 | ❌ don't touch:`otp_extraction_enabled` 只动投影 |
| `mail-vue/src/composables/useSharePolling.js:9,56-214` | composable | 3s 链式轮询、后台暂停、429 退避、单游标 | ✅ extend:`intervalMs` 已可注入,改拉 status+mails |
| `mail-vue/src/views/share/index.vue:160-266,514-556` | 页面 | 访客页状态机 + featuredMail OTP 区(内嵌未抽组件) | ✅ extend:抽 `ShareOtpCard`,加多邮箱 Tab |
| `mail-vue/src/views/email/ShareDialog.vue:92-219` | 组件 | 创建表单 + 一次性密钥展示 + 幂等键轮换 | ✅ reuse:契约兼容,快捷入口保留(AC-CAP-10) |
| `mail-vue/src/request/share.js:3-147` | axios 实例 | `shareHttp` 匿名实例(无 cookie/无登录拦截器) | ✅ extend:加 status/多邮箱函数 |
| `mail-vue/src/router/index.js:157-183` | 守卫 | share 路由白名单 + 离开清会话 | ✅ extend:多邮箱页复用 `/s/` 路径与 `name:'share'` 则近零改 |
| `mail-vue/src/init/init.js:18-20` | 引导 | `isAnonymousShareVisit` 正则 `/(?:^|\/)s\/[^/]+/` | ✅ reuse:多邮箱沿用 `/s/<lid>` 形态,正则不动 |
| `mail-vue/src/views/share/assert-share-chunk.js:10-15` | 守护测试 | share chunk 依赖闭包禁入清单 | ✅ reuse:新页面 import 必须留在闭包内(红了改 import 不改闸门) |
| `mail-vue/src/components/safe-mail/index.vue:69-192` | 组件 | SafeMailRenderer 沙箱渲染,自带 zh/en 兜底 | ✅ reuse:零改动 |

## Corrected Goal (draft-vs-reality — from recon)

| Draft assumption | Reality found | Correction |
|---|---|---|
| 按五对象领域模型(Share/Binding/Session/AccessEvent/…)重建 bounded context | capability URL + 无状态 token + scoped repository 架构健康,三个对象已存在或半存在(recon-backend §6) | 就地演进:加列 + Binding 表;Session 不落库;AccessEvent deferred(D17) |
| ShareSession 需要服务端落库才能限次 | `max_sessions` 是**累计**上限(D5),原子条件 UPDATE 即闸门;并发上限才需要 Session 表 | 不建 session 表,不升 token 版本(保持 `s1`),规避 recon R7 双版本窗口成本 |
| 访问计数 = HTTP 请求 visit_count++ | `access_count` 已是「建立 Session 时 +1」(`share-auth-service.js:236-241`),口径天然一致,只缺闸门 | 物理列名保留 `access_count`(expand-only,R1-A1),领域语义升级为 `used_sessions` + 条件递增;轮询零消耗(AC-SESS-02) |
| `only_messages_after_created` 是新能力 | `window_start_email_id` 快照已存在且恒开启(`mail-share-service.js:195`) | 降级为可选布尔 + 快照从主表移到 per-binding(多邮箱各自下界,recon-backend §5) |
| 已有管理界面可增强 | 只有收件箱内 ShareDialog,无独立路由/页面/分页(recon-frontend §2) | 新建 `views/share-admin/` 管理模块;ShareDialog 保留为快捷入口 |
| 多邮箱要新轮询机制或 N 路轮询 | `useSharePolling` 成熟但单实例单游标;`email_id` 全局单调使单游标聚合可行(recon-backend §5) | 统一 StatusEndpoint + 单实例轮询(D16),不做 N 路 |
| Visitor session 响应不含 `expiresAt`(recon-frontend §1) | **recon-frontend 记述有误**:`establishSession` 已返回 `expiresAt`(`share-auth-service.js:266-271`,本执行者 2026-08-24 亲验),仅前端未消费 | 访客页剩余时间展示为纯前端工作,后端零改动;recon 修正记入 Update Log |
| `setting.share` DB 开关可用 | `entity/setting.js` 无 `share` 列,`isShareDisabled` 的 DB 分支是死分支(recon-crosscut §0) | 功能开关只依赖 `SHARE_ENABLED` 环境变量;死分支不在本期修复也不新增依赖 |
| `otp_extraction_enabled` 控制提取行为 | 提取发生在摄取链且受全局 `aiCode`+白名单门控,对已收邮件不可追溯(recon-crosscut §4) | 开关只控投影是否返回 `code`(D12),摄取链零改动 |
| auth_key/max_sessions 是净新增需求 | 二者曾被 mail-share R1-R3 用户裁决明确排除(recon-crosscut §8 #2/#3) | 用户 2026-08-24 裁决显式推翻,记入本 charter Decision Record,旧 charter 不改 |
| 多邮箱游标分页复杂 | `email_id` PK AUTOINCREMENT 全局单调,跨邮箱聚合天然同一游标(recon-backend §5) | mails 分页用全局 `email_id` 游标;status 端点**无游标参数**,返回 per-binding `latestEmailId` 水位、客户端本地比较(R2-A2:单标量表达不了 per-binding 消费进度) |

## Decision(s)

- **Decision 1 · 统一模型**:单/多邮箱共用 `MailboxShare`(`mail_share` 就地演进)+ `ShareMailboxBinding`(新表);`share_type` 取 `single`|`multi`,**不落库**,由现存 Binding 计数在响应组装时实时派生(恰 1 → `single`,>1 → `multi`,0 → 已进入撤销路径),`mail_share_binding` 是该类型的唯一真源(R1-A2:持久化派生列会与 Binding 增删/级联/迁移形成无维护闭环的双真源)。拒绝:平行 `mail_share_v2` 表(双真源、迁移成本)、「多邮箱=多条 share 的聚合入口」(撤销/配额语义不可组合)、持久化 `share_type` 列(派生双真源)。
- **Decision 2 · 全面复用既有设施**:`lid`+`sec` fragment、HMAC pepper(`pepper_kid` 轮换)、无状态 `s1.` token、`share-auth-service` 唯一授权入口、`share-scoped-email-repository` 唯一范围查询、`useSharePolling`、SafeMailRenderer、`share:manage` 权限。拒绝:重建授权链(旧链 17 个 spec 全绿是资产不是包袱)。
- **Decision 3 · 新旧 charter 关系**:新 slug `mailbox-share-capability`,`related_specs: [docs/specs/mail-share]`;旧单邮箱链接迁移回填 Binding 后继续有效;旧 ShareDialog 继续调 create(升级 payload,向后兼容);完整管理模块新建;发布后不立刻 supersede(观察期后由用户决定 supersede 时点)。
- **Decision 4 · Session 计数口径**:建立 Session 计 1;`access_count` 列**语义**升级为 `used_sessions`,**物理列名不改**(R1-A1:RENAME 会使旧版本 Worker/在途实例/回滚版本立即失配;expand 语义 = 应用层读写 `access_count` 列、DTO 映射为 `usedSessions`,旧 Worker 读旧列名保持兼容,天然可回滚);轮询/刷新/同 tab sessionStorage 恢复不计;新 tab 无恢复凭据则新建并计数。计数从 fire-and-forget 统计升级为**准入闸门**(原子条件 UPDATE),`last_access_at` 保持 fire-and-forget。**线性化承诺(R2-A3)**:以条件 UPDATE 成功时刻为配额与授权的唯一线性化点;UPDATE 提交后、issueToken/响应返回前的并发失效属已知极窄 TOCTOU 窗口,该 token 首次回源失败且名额不退还——不承诺「响应时仍可用/绝不即死」,也不为此引入服务端 Session/Grant 表。
- **Decision 5 · max_sessions 语义**:累计建立次数上限(非并发)。触顶 → effectiveStatus `ACCESS_LIMIT_REACHED`(计算态,不落库);已建立 Session 在自身 TTL 内继续可用,禁止新建。存量旧行 `max_sessions=NULL` 不限,历史 `access_count` 值不追溯为配额消耗(规避 recon R5 风险)。**配额纪元基线(R2-A5)**:首次将 `max_sessions` 从 NULL 设为有限值时默认 `resetUsedSessions=true`(`access_count` 置 0),历史观测计数不被追溯执行;Owner 显式提交 false 则保留计数(可能立即触顶,属显式选择)。见 AC-EDGE-14。
- **Decision 6 · Session TTL**:默认 900s(`SHARE_SESSION_TTL`),绝对、不续期;`exp = min(expires_at, iat + TTL)` 不变。
- **Decision 7 · IP 变化**:不新建 Session,token 自绑定;不做 IP 绑定校验(与 CF 多 PoP 出口漂移冲突)。
- **Decision 8 · AuthKey**:可选第二因子,默认关;独立于 fragment `sec`;服务端生成(规格:128-bit CSPRNG、base64url 编码、定长 22 字符,展示可分组,校验侧规范化仅 trim,R1-F1),只存 `auth_key_hash`(+`auth_key_kid`,复用 digest+pepper);生命周期为完整状态机 `disabled → enable → reset → disable`(见 API 契约「AuthKey 状态机」小节与 AC-AUTH-07/08,R1-A5);reset/disable bump `credentials_version`,旧 Session 立即失效(token 携带 `cv` 回源比对)。错误暴露面:仅 `lid`+`sec` 通过后才返回 `SHARE_AUTH_REQUIRED`,其余一律 `SHARE_UNAVAILABLE`(P-AUTH-01 保持)。
- **Decision 9 · 暴力防护(R2-A6 定稿,推翻 R1-A6 锁定方案)**:AuthKey 暴力防护**仅**依赖既有 IP 边缘限流(`SHARE_SESSION_RATE_LIMITER`)。不建 `mail_share_auth_fail` 失败计数/锁定表:AuthKey 是 128-bit 服务端 CSPRNG 生成的 capability 凭据,在线穷举不可行——「防猜中高熵凭据」不需要密码式锁定;锁定机制只重复单一出口限制、无法阻止分布式来源,反而让共享 NAT 下的合法访客被他人失败牵连,并新增一套状态/清理故障面。错误 Key 不消耗配额(AC-EDGE-12),429 保持独立运输层语义(AC-AUTH-06)。
- **Decision 10 · message_limit**:每 Binding 各自最近 N 封(`email_id` DESC),N=1 合法,NULL 不限;服务端在列表、详情、附件三处强制。
- **Decision 11 · only_messages_after_created**:true → per-binding `window_start_email_id` 原子快照;false → 下界 0(仍受 N 限制)。
- **Decision 12 · otp_extraction_enabled**:仅控投影是否返回 `code`;摄取链零改动;提取失败(`code=''`)仍展示邮件。
- **Decision 13 · auto_refresh / refresh_interval_ms**:share 配置随 session 响应下发;默认开/3000ms;create/update **写入侧拒绝** `<3000`(`SHARE_INVALID_CONFIG`,AC-CAP-06);session/status **下发侧**对存量脏数据钳制 ≥3000(AC-OTP-06,T-08)。
- **Decision 14 · 脱敏 = 展示偏好,非安全边界(R2-A7 归类)**:掩码是 Visitor 侧 UI 展示偏好(降噪/降低随手抄录),**不是**「隐藏邮箱身份」的保密能力,不列入安全保证、不以安全开关口径向 Owner 呈现。规则:系统生成的绑定邮箱身份字段默认掩码(session/status/list/detail 投影中的 mailbox address,`a***@x.com`:local-part 留首字符);`show_full_address=true` 关闭;发件人默认不掩码(OTP 场景需要判断来源可信度);主题/正文不承诺不出现绑定地址、命中内容不改写(R1-A3 收窄保留,SafeMailRenderer 原样渲染)。若未来出现真实的内容级隐私需求,须另立产品边界(快照/内容改写 + 明确保真损失),不由 `maskAddress` 承担。规格落位见「外部访问页」下「展示偏好:地址掩码」小节(自安全边界移出)。
- **Decision 15 · Binding 增删语义**:立即影响下次拉取;删光 Binding 撤销分享;account 删除剔除对应 Binding、剩余继续、剩 0 撤销。
- **Decision 16 · 实时机制**:客户端轮询不变;多邮箱统一 `GET /share/mailboxes/status`(单请求返回各 Binding `latestEmailId` 水位,hasNew 由客户端本地比较,R2-A2),全局轮询每 tick 只拉一次 status,禁止 N 路并行轮询。
- **Decision 17 · ShareAccessEvent**:本期不建独立事件表(deferred,B/C 类非必做);保留 `used_sessions`/`last_access_at` 聚合观测。
- **Decision 18 · 预设**:Phase1 纯前端表单预填(单邮箱验证码/临时邮箱/多邮箱验证码池/自定义),不落 DB;`SHARE_ACTIVE_LIMIT` 等环境变量上限保留。
- **Decision 19 · 状态机**:持久化 `ACTIVE`|`REVOKED`;计算态 `ACTIVE`|`EXPIRED`|`REVOKED`|`ACCESS_LIMIT_REACHED`,优先级 REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE。
- **Decision 20 · 滚动发布协议(R2-A1 · R3-A1 升级为全能力栅栏)**:Binding 切换不是 expand-only 加列即安全——兼容窗口内 `mail_share.account_id` 与 Binding 是两个可执行授权源,且旧 Worker 不认识 `auth_key_enabled`/`credentials_version`/配额条件:这些策略一旦在兼容窗口内写入,随机路由到旧 Worker 的请求即成策略降级入口(仅凭 `lid+sec` 建会话、配额超发、reset 后旧 token 不拒)。裁决为分阶段 Expand/Contract + 全能力激活开关:Expand 阶段新代码**双写**主表 `account_id` = 主 Binding(`binding_id` 最小)的 `account_id`、禁止写 0;**全部 V2 能力**(multi 创建、bindings 使绑定数 >1、AuthKey 启用、有限 `max_sessions`)受 `SHARE_CAPABILITY_V2`(默认 false,取代 R2 的 `SHARE_MULTI_ENABLED`)统一门控,开关 false 时行为等同旧 mail-share 单邮箱(双写仍进行);激活前置 = 迁移完成 + 最终回填重跑完成 + 无旧 Worker 在途 + 告警消费者就绪(R3-A7);新代码读路径只信 Binding;Contract(后续版本)确认无旧 Worker 后才停止双写。回滚 = 关闭 V2 开关,单邮箱因双写仍可用。协议全文见「迁移/发布协议」节,验收 AC-LIFE-10/11。
- **ADR needed?** **yes** —— 多邮箱 Binding(1:1→1:N 数据模型)、Session 配额闸门(观测→执行)、auth_key(capability→capability+credential)三者都是边界定义级、难回退的变更,且部分推翻旧 charter 裁决。后继 ADR:`docs/architecture/ADR-mailbox-share-capability-extension.md`(Proposed stub 已随本 charter 落盘),Context 引用 `ADR-mail-share-capability-boundary.md`。
- **Reviewer**: codex(默认;用户未另行指定)。

## Architecture & Layering

沿用 mail-share 确立的分层与反腐边界,单向依赖不变:

```
Owner 面(JWT + share:manage)                Visitor 面(匿名,精确豁免)
mail-share-api.js ──┐                        share-api.js ──┐
                    ▼                                       ▼
        mail-share-service.js                    share-auth-service.js   ← 唯一授权入口
        (create/update/bindings/                 (establishSession/resolveSession/
         revoke/delete/resetAuthKey)              effectiveStatus/配额闸门/authKey)
                    │                                       │
                    ▼                                       ▼
        entity(mail_share + mail_share_binding)  share-scoped-email-repository.js ← 唯一范围查询
                    │                                       │
                    ▼                                       ▼
                  D1(init.js v3_2DB 迁移)        share-mail-service.js(投影/掩码/otp 裁剪)
                                                 share-attachment-service.js(受控附件)
```

- **Visitor 永不进入登录态 `email-service`**;新增 StatusEndpoint 同样只经 `share-auth-service` + scoped repository。
- **新表/新列全部落 v3_2DB**(`init.js` 注册链尾追加),幂等模式照抄 v3_1DB(`CREATE TABLE IF NOT EXISTS` + try/catch ALTER + `INSERT ... WHERE NOT EXISTS` 回填)。
- **前端两域**:访客域(share chunk,隔离闭包,`shareHttp` 专用实例)与管理域(layout 内新 `views/share-admin/`,走登录态 axios)。二者不共享网络层;共享的仅纯组件(`ShareOtpCard`、SafeMailRenderer)。
- **D1 约束**(勿再踩):`.transaction()` 不可用;跨表原子 = `c.env.db.batch()`;单语句 `INSERT ... SELECT`/条件 UPDATE 做快照与闸门。跨聚合不变量(Binding ↔ account 存活)不靠应用层多步检查,靠单语句条件写 + 清理补偿(R1-A9,见 Data Models「Binding 写入的并发一致性」与 AC-BIND-10)。

## Data Models

### `mail_share` 新增/变更列(v3_2DB · 就地演进)

```sql
-- v3_2DB:每语句独立 try/catch 幂等(照抄 init.js v3_1DB 模式)
-- R1-A1:全程 expand-only,零 RENAME、零 DROP。access_count 物理列名保留,
--        应用层读写 access_count、DTO 映射为 usedSessions;旧版本 Worker 读旧列名兼容,可回滚。
-- R1-A2:不加 share_type 列——该值由 Binding 计数实时派生,持久化即双真源。
-- R2-A6:无任何失败计数/锁定列或表——AuthKey 暴力防护仅靠既有 IP 边缘限流(Decision 9)。
ALTER TABLE mail_share ADD COLUMN max_sessions INTEGER;               -- NULL = 不限(存量旧行)
ALTER TABLE mail_share ADD COLUMN message_limit INTEGER;              -- NULL = 不限;>=1
ALTER TABLE mail_share ADD COLUMN only_messages_after_created INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mail_share ADD COLUMN otp_extraction_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mail_share ADD COLUMN auto_refresh INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mail_share ADD COLUMN refresh_interval_ms INTEGER NOT NULL DEFAULT 3000;  -- 写入侧拒绝 <3000;下发侧钳 >=3000
ALTER TABLE mail_share ADD COLUMN show_full_address INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_share ADD COLUMN auth_key_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_share ADD COLUMN auth_key_hash TEXT;                 -- HMAC-SHA256(authKey, PEPPER[auth_key_kid])
ALTER TABLE mail_share ADD COLUMN auth_key_kid TEXT;
ALTER TABLE mail_share ADD COLUMN credentials_version INTEGER NOT NULL DEFAULT 0;
```

保留列:`lid`/`sec_hmac`/`pepper_kid`/`user_id`/`name`/`remark`/`status`/`expires_at`/`delete_at`/`access_count`/`last_access_at`/`revoked_at`/`create_time` 全部不动(`access_count` 列名保留,领域量 `used_sessions` 的物理载体,R1-A1)。`account_id` 列在 **Expand 阶段为双写目标**(R2-A1/AC-LIFE-10):新代码写它为主 Binding 的 `account_id`(禁止写 0),但任何鉴权/范围逻辑不得读它(AC-BIND-01);`window_start_email_id` 在 Expand 阶段与 `account_id` **一并双写**为主 Binding 快照(`only_messages_after_created=true` 时为该 Binding 的 `MAX(email_id)`,false 时为 0)——旧 Worker 读路径仍消费主表该列,不双写则新建行默认 0,滚动窗口内会越权放出创建前邮件;新代码读路径仍只信 Binding。不删列(D1 ALTER DROP 风险高、schema spec 钉死);`mail-share.schema.spec.js` 扩展断言「双写非 0 + 鉴权零读取」语义。

### `mail_share_binding`(新表)

```sql
CREATE TABLE IF NOT EXISTS mail_share_binding (
  binding_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id              INTEGER NOT NULL,
  account_id            INTEGER NOT NULL,
  window_start_email_id INTEGER NOT NULL DEFAULT 0,  -- per-binding 快照;only_messages_after_created=false 时写 0
  create_time           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msb_share_account ON mail_share_binding(share_id, account_id);
CREATE INDEX IF NOT EXISTS idx_msb_account ON mail_share_binding(account_id);   -- 级联撤销反查
```

无外键(D1 惯例,与全库一致);清理守恒由 cleanup 任务显式保证(AC-LIFE-06)。

**Binding 写入的并发一致性(R1-A9)**:新增 Binding 不做「先批量校验、再写入」两步——与 account 删除并发时会在删除完成后插入指向已删 account 的孤儿行。写入为单语句条件 `INSERT ... SELECT`:仅当目标 `account` 行仍存在、`is_del = NORMAL` 且 `user_id = :owner` 时插入(UNIQUE 索引兜底防重复);受影响行数为 0 → 返回 `SHARE_ACCOUNT_FORBIDDEN`(AC-BIND-10)。极端交错仍产生的孤儿由级联路径(AC-LIFE-09)与定时清理任务补偿剔除。

### ~~`mail_share_auth_fail`~~(R2-A6 删除,不建此表)

R1-A6 曾引入 `(shareId, IP)` 失败计数/短窗锁定表;R2 评审裁定**删除**:AuthKey 为 128-bit 服务端 CSPRNG 凭据,在线穷举不可行,该表未解决任何已量化威胁,只重复单一出口限制(分布式来源仍由边缘限流承担)、牵连共享 NAT 合法访客、多出一套状态与 cleanup 故障面。AuthKey 暴力防护仅依赖既有 IP 边缘限流(Decision 9、AC-AUTH-05);相关 DDL、原子 UPSERT、cleanup 清理项全部不做。

### 迁移 v3_2DB · 旧行回填(R2-A4 迁移门禁)

```sql
-- 通过门禁的存量行幂等回填恰一条 Binding(AC-BIND-09/AC-BIND-11):
-- JOIN account 要求 account 存活、is_del=NORMAL、user_id 归属匹配(与 AC-BIND-10 运行时条件同源)
INSERT INTO mail_share_binding (share_id, account_id, window_start_email_id, create_time)
SELECT ms.share_id, ms.account_id, ms.window_start_email_id, ms.create_time
FROM mail_share ms
JOIN account a ON a.account_id = ms.account_id
             AND a.is_del = 0            -- NORMAL
             AND a.user_id = ms.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM mail_share_binding b WHERE b.share_id = ms.share_id
);

-- 未通过门禁的旧行:以 account 事实为显式判据(R3-A2)——禁止以「无 Binding」判脏。
-- 谓词 = ACTIVE 且 (account 不存在 OR 已删 OR 归属不符);处置时打 share.migrate.invalid_row 结构化日志(R2-F2/AC-BIND-11)
UPDATE mail_share
SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
WHERE status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM account a
    WHERE a.account_id = mail_share.account_id
      AND a.is_del = 0            -- NORMAL
      AND a.user_id = mail_share.user_id
  );
```

两条语句幂等、可重复执行(发布收尾重跑一次,收编滚动窗口内旧 Worker 晚写的行,见「迁移/发布协议」路径①)。**交错安全(R3-A2)**:无效行 UPDATE 只依据 account 存活/归属事实,与「是否已回填 Binding」完全解耦——旧 Worker 在回填 INSERT 之后、无效行 UPDATE 之前新建的 account 合法行(此刻尚无 Binding)不满足撤销谓词,不会被误置终态 REVOKED(REVOKED 是终态,重跑 INSERT 无法恢复,故绝不允许误判),留待收尾重跑 INSERT 幂等收编;account 确实无效的行无论有无 Binding、无论旧写落在哪个时点,重跑时都命中同一谓词。迁移测试须注入旧写发生在 INSERT 之前/INSERT 与 UPDATE 之间/UPDATE 之后与任务重启后的全部交错时序(AC-BIND-11)。迁移门禁保证零非法 Binding——历史脏引用(已删邮箱/归属漂移)不被固化为新授权真源,而是安全失败为 REVOKED(Owner 列表仍可见可审计)。`share_type` 无列可回填(实时派生,存量行恰一条 Binding → 天然 `single`,R1-A2);`access_count` 列值原样保留(即领域量 `used_sessions` 历史值)且 `max_sessions=NULL` 使其不构成配额消耗(AC-EDGE-09;首次设有限值的基线见 Decision 5 / AC-EDGE-14)。`share_idempotency` 表原样保留,请求指纹扩展在 service 层(新字段纳入规范化 JSON)。

### 迁移/发布协议(R2-A1 · R3-A1 全能力发布栅栏,AC-LIFE-10/11)

滚动发布窗口内,旧 Worker 仍按 `mail_share.account_id` 授权、新代码只信 Binding——若新代码停止维护主表列(旧稿「新建行写 0」),旧 Worker 读新建分享见 0(不可用)、读已移除原 Binding 的旧分享按陈旧 `account_id` 继续授权(越权),形成新旧授权双轨。且不止数据形状:旧 Worker 不认识 `auth_key_enabled`/`credentials_version`/配额条件——只门控 multi create 不够,AuthKey/配额一旦写入,落到旧 Worker 的请求就绕过第二因子与配额(R3-A1)。分阶段协议:

1. **Expand(本期)**:新代码**双写** `mail_share.account_id` = 主 Binding(`binding_id` 最小,即创建时第一个)的 `account_id`;**禁止写 0**;新建分享、增删 Binding 后在同一 `c.env.db.batch()` 内同步更新主表列(删空 Binding → REVOKED,主表列值不再被信任)。
2. **全能力激活栅栏(R3-A1)**:全部新策略能力受 `SHARE_CAPABILITY_V2` 环境变量(默认 false,取代 R2 的 `SHARE_MULTI_ENABLED`)统一门控。开关 false 时,以下写入一律拒绝(`SHARE_INVALID_CONFIG`,AC-LIFE-11):① create `accountIds.length > 1`;② `PUT /mailShare/bindings` 使现存 Binding 数 >1;③ AuthKey 启用(create `authKeyEnabled=true` / resetAuthKey `action='enable'`);④ `max_sessions` 设为非 NULL 有限值(create/update)。此时系统行为等同旧 mail-share 单邮箱(双写仍进行),Visitor 侧依赖新策略字段的前端功能以「能力未激活」提示降级。**激活前置**:迁移完成 + 最终回填重跑完成 + 确认无旧 Worker 在途 + 关键日志事件已有告警消费者(R3-A7);缺任一项不得置 true。
3. **读路径**:新代码鉴权/范围只信 Binding(AC-BIND-01);旧 Worker 兼容窗口内仍按主表 `account_id` 读旧语义,双写保证其读到主 Binding 的有效值。
4. **Contract(后续版本)**:确认无旧 Worker 在途后才停止双写,`account_id` 转纯遗留列。
5. **回滚**:关闭 `SHARE_CAPABILITY_V2`;单邮箱分享因双写在旧 Worker 下仍可用。

四条路径验收(AC-LIFE-10,对应 R2/R3 评审「全绿但失败」路径):

- **① 旧实例晚写、新实例读取**:旧 Worker 在回填后新建的行只有主表 `account_id`、无 Binding → 新代码读到零 Binding 按不可用处理(不越权);发布收尾**重跑幂等回填**(两条迁移语句可重复执行)收编这些行,旧链接恢复在新代码下有效(合法无 Binding 行不会被无效行 UPDATE 误撤销,R3-A2 见上节)。
- **② Binding 移除后旧实例读取**:双写使主表列同步为剩余主 Binding 的 `account_id`;删空 → REVOKED,旧 Worker 读 `status` 即拒——旧 Worker 不会按已移除邮箱授权。multi 场景的主 Binding 变更只在 `SHARE_CAPABILITY_V2` 开启后存在,而开启前提是无旧 Worker。
- **③ 回滚读取新建多邮箱分享**:V2 开启前不存在 multi 行、无 AuthKey、无有限配额,常规回滚窗口无此路径;异常场景(已开 V2 后回滚)旧 Worker 按主 Binding 提供单邮箱降级视图——降级但不越权(主 Binding 本就在授权集合内)。
- **④ 滚动窗口随机路由(R3-A1)**:开关 false 期间不存在任何旧 Worker 无法执行的已写入策略(AuthKey 未启用、配额恒 NULL、Binding 恒 ≤1)——「新代码启用 AuthKey/配额后请求落旧 Worker 被绕过」「bindings 端点绕过 multi 门控 1→N」两条降级路径被写入侧栅栏消解;验收注入:V2=false 下四路受限写入全部被拒 + 随机路由新旧 Worker 混跑不产生策略差异。

### Session token(`s1` 保持,payload 扩展)

payload 由 `{shareId, lid, iat, exp, kid}` 扩展为 `{shareId, lid, iat, exp, kid, cv}`。`cv` = 签发时行上 `credentials_version`。旧 token 无 `cv` 字段 → `resolveSession` 按 `cv=0` 处理;行上版本一旦 bump,旧 token 全部失效(AC-AUTH-04)。**不升 `s2`**:`verifyToken` 的 `parts[0] !== TOKEN_VER` 检查不变,payload 是 JSON,加字段向后兼容。

### Session 建立幂等恢复(R3-A3 · KV 结果重放,AC-SESS-10)

**产品裁决:配额成功口径 = 客户端可恢复地获得凭据**(非仅服务端 UPDATE 提交)。条件 UPDATE 提交后、响应送达前的网络超时/Worker 重启/响应丢失,不允许把一次逻辑建会话变成多次配额消耗(`max_sessions=1` 下一次超时即永久耗尽链接)。机制为最小请求幂等/结果重放——只负责一次签发结果的去重,**不是** Session 授权真源(每请求回源判定不变,不推翻 R2-A3 线性化承诺、不建服务端 Session/Grant 表):

- **请求**:`POST /share/session` 支持 `Idempotency-Key` 头;客户端在发请求**前**生成并写入 sessionStorage(键 `share:est-key:<lid>`),超时/响应丢失重试必须复用同一 key,禁止换 key 盲重试;成功拿到 token 后清除该 key。
- **KV 契约**:成功签发后把 sessionToken 写入既有 KV 绑定(`c.env.kv`,同 `security.js:117` 设施;`KvConst` 新增前缀)键 `share:est:<lid>:<key>`,TTL = min(120 秒, token 剩余寿命)(Workers KV `expirationTtl` 最小 60 秒:剩余寿命 `< 60` 时跳过写入,不记 error;≥60 时 `expirationTtl = min(120, remaining)`)。同 key 重放命中 → 直接返回缓存 token(响应形状与首发一致),不再走条件 UPDATE、不再 +1 配额。无 key / 新 key / 缓存过期 → 正常走 AC-SESS-01 条件 UPDATE。跨 PoP 传播最长 60 秒,读不到则退化为再消耗一次配额,属 fail-open 风险窗口。**与 AC-EDGE-05 的交叉语义**:只有缓存 token 的 `cv` 等于当前行 `credentials_version` 才算 AC-SESS-10 的有效 hit,reset/disable bump 后的 stale-cv 缓存一律按 miss 处理(重新走条件 UPDATE、重新消耗配额),避免把必死 token 回给持新 Key 的访客;enable 不 bump `cv`,同 Key 重放仍是 hit(AC-AUTH-07)。
- **失败语义(fail-open,文档化风险)**:KV 读/写不可用时仍正常签发 token,该次无重放保护(若响应再丢失,名额已耗且不可恢复),记 `share.system.error` 结构化日志。选 fail-open 而非硬失败:KV 故障不应使整个分享面不可用;风险窗口 = KV 故障 ∩ 响应丢失 ∩ 低配额,接受并观测。
- **安全**:缓存值是本就要下发给同一持链者的 token(重放方必须持有 `lid`+`sec`(+AuthKey)且通过全部校验才走到重放查询);key 由客户端生成并绑定 `lid`;TTL ≤ 120s 限制暴露窗口;不缓存 `sec`/AuthKey 明文。
- **E2E**:`max_sessions=1` + 注入响应丢失 → 同 key 重试拿到同一 token、`used_sessions` 恒为 1(AC-SESS-10)。

## Effective Status 状态机

```
持久化状态(mail_share.status):  ACTIVE ──revoke/级联/删光 Binding──► REVOKED(终态,不可逆)

计算态 effectiveStatus(row, now)(每次访问实时计算,不落库):

        ┌─ row.status = 'REVOKED' ──────────────────────────► REVOKED
        │
row ────┼─ expires_at <= now ──────────────────────────────► EXPIRED
        │
        ├─ max_sessions IS NOT NULL
        │   AND used_sessions >= max_sessions ──────────────► ACCESS_LIMIT_REACHED
        │
        └─ 其余 ───────────────────────────────────────────► ACTIVE

判定优先级:REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE(AC-LIFE-02)
```

各计算态对 Visitor 的语义:

| effectiveStatus | 新建 Session | 既有 token 读请求 |
|---|---|---|
| ACTIVE | ✅ 允许(过配额闸门) | ✅ 允许 |
| ACCESS_LIMIT_REACHED | ❌ 拒绝 | ✅ **允许**(TTL 内继续用,D5/AC-SESS-06) |
| EXPIRED | ❌ 拒绝 | ❌ 拒绝(token `exp` ≤ `expires_at` 双重封顶) |
| REVOKED | ❌ 拒绝 | ❌ 拒绝(回源即断,AC-LIFE-03) |

实现要点:`resolveSession` 中 `assertShareActive` 现行为「非 ACTIVE 即拒」——须改为**区分调用方**:`establishSession` 拒绝一切非 ACTIVE;`resolveSession` 对 `ACCESS_LIMIT_REACHED` 放行(唯一的差异态)。

## Session / Auth / 访问次数精确语义(回答用户 §9 全部问题)

| 问题 | 裁决后的精确行为 | 强制点 |
|---|---|---|
| 建立 Session 何时计数? | `POST /share/session` 成功签发即 +1,单一线性化点(R1-A4):先读快照取 `credentials_version`,再原子条件 UPDATE:`UPDATE mail_share SET access_count = access_count + 1, last_access_at = ? WHERE share_id = ? AND status = 'ACTIVE' AND expires_at > ? AND credentials_version = ? AND (max_sessions IS NULL OR access_count < max_sessions) RETURNING access_count`(物理列 `access_count` 承载 `used_sessions`);RETURNING 空 = 拒发零配额(触顶/已撤销/已过期/版本已变);RETURNING 非空才 issueToken(携带该 cv)。**UPDATE 成功时刻即配额与授权的线性化点(R2-A3)**:UPDATE→issueToken 之间的并发失效属已知极窄 TOCTOU,该 token 首次回源失败且名额不退还 | share-auth-service `establishSession`(AC-SESS-01/AC-EDGE-13) |
| 同一人刷新页面算几次? | 同 tab `sessionStorage` 键 `share:session:<lid>` 内 token 未过 TTL → 恢复,不计数;TTL 已过 → 页面内存/重开链接重建 Session,计 1 | 前端 bootstrap + 后端闸门(AC-SESS-03) |
| 新开 tab 算几次? | `sessionStorage` 不跨 tab,新 tab 无恢复凭据 → 新建 Session,计 1 | 浏览器语义 + 闸门(AC-SESS-04) |
| HTTP 轮询消耗次数吗? | 不。mails/mail/attachment/status 全部零配额消耗,`used_sessions` 只在 establish 时变化 | resolveSession 无写路径(AC-SESS-02/AC-EDGE-01/11) |
| IP 变了要重建吗? | 不。token 自绑定,不校验 IP | AC-SESS-08 |
| 配额用完,老访客还能看吗? | 能。已签发 token 在自身 `exp` 内继续读;只禁新建。`ACCESS_LIMIT_REACHED` 是「关门不清场」 | resolveSession 放行差异态(AC-SESS-06/AC-LIFE-04) |
| 配额用完后过一段时间恢复吗? | 不恢复。累计上限,无滑动窗口;Owner 可 update 上调 `max_sessions` 重新开门 | AC-ADMIN-03/04 |
| 并发抢最后一个名额? | 单语句条件 UPDATE 保证恰好 max 次成功,无超发 | AC-EDGE-02(D1 单语句原子,`transaction.spec.js` 已验证) |
| AuthKey 谁生成、谁输入? | 服务端 CSPRNG 生成,Owner 创建/重置时看到一次并另行传达;Visitor 在访客页输入(仅当 `SHARE_AUTH_REQUIRED` 返回时展示输入框) | AC-CAP-05/AC-AUTH-01 |
| 输错 Key 有惩罚吗? | 无 per-share 锁定、无失败计数(R2-A6 删除 `mail_share_auth_fail`):错误 Key → `SHARE_AUTH_REQUIRED`、零配额消耗、零 token;唯一请求成本约束是既有 IP 边缘限流(429 独立运输层)。128-bit 服务端生成 Key 在线穷举不可行 | AC-AUTH-05/AC-EDGE-12 |
| 重置 Key 后老 Session 呢? | 立即失效:`credentials_version` bump,token `cv` 回源不匹配即拒;重新进入需新 Key + 消耗新配额 | AC-AUTH-04/AC-EDGE-05 |
| 错误会泄露什么? | `lid`+`sec` 未通过 → 一律 `SHARE_UNAVAILABLE`(不可区分);通过后才可能 `SHARE_AUTH_REQUIRED`(只有合法持链者能得知需要 Key);Key 缺失/错误不可区分 | AC-AUTH-02(P-AUTH-01 扩展) |
| 429 消耗配额吗? | 不。边缘限流在闸门之前,运输层独立语义 | AC-AUTH-06 |

## API 契约

### Owner 面 `/mailShare/*`(JWT + `share:manage` 精确匹配)

| Method + Path | 状态 | 请求 | 响应要点 |
|---|---|---|---|
| `POST /mailShare/create` | 扩展 | `{accountIds: number[]`(或旧 `accountId` 单值,兼容 AC-CAP-10)`, durationSeconds, name?, remark?, maxSessions?, messageLimit?, onlyMessagesAfterCreated?, otpExtractionEnabled?, autoRefresh?, refreshIntervalMs?, showFullAddress?, authKeyEnabled?}` + `Idempotency-Key` 头;`accountIds.length > 1`、`authKeyEnabled=true`、有限 `maxSessions` 均需 `SHARE_CAPABILITY_V2=true`,否则 `SHARE_INVALID_CONFIG`(全能力栅栏,AC-LIFE-10/11);`accountIds` 数量 > `SHARE_BINDING_LIMIT`(50)→ `SHARE_BINDING_LIMIT_EXCEEDED`(AC-CAP-13) | `shareId, lid, shareUrl, sec`(仅首次)`, authKey`(仅首次且启用时)`, shareType, bindings[]`;重放含 `idempotentReplay: true` 且无 `sec`/`authKey`(响应丢失恢复流程见 AC-CAP-14);同时双写主表 `account_id` = 主 Binding(R2-A1) |
| `GET /mailShare/list` | 扩展 | `page?, size?, status?`(R1-F2:`size` 默认 20、上限 100;稳定排序恒为 `share_id DESC`;无参全量兼容期保留但标注 **deprecated**,兼容期硬上限 500 行) | 行含 `shareType`(由 Binding 计数派生)`, effectiveStatus`(四态)`, usedSessions, maxSessions, bindings 摘要, expiresAt, lastAccessAt` |
| `GET /mailShare/get` | 新建 | `shareId` | 单条详情 + Binding 清单 + 全部配置;他人 `shareId` → `SHARE_NOT_FOUND` |
| `PUT /mailShare/update` | 新建 | `shareId` + 可变配置(`name/remark/maxSessions/messageLimit/otpExtractionEnabled/autoRefresh/refreshIntervalMs/showFullAddress`)+ `resetUsedSessions?`(仅 `maxSessions` 从 NULL 首设有限值时有意义,缺省 true,R2-A5/AC-EDGE-14) | 校验后落库,下次 Visitor 请求生效;`maxSessions` 设为非 NULL 有限值需 `SHARE_CAPABILITY_V2=true`(AC-LIFE-11);NULL→有限值且 `resetUsedSessions≠false` → 同语句将 `access_count` 置 0;不可改 `lid/sec/expires_at`;`shareType` 为派生值无此字段;SHALL NOT 直接改 `auth_key_hash`(AC-AUTH-07) |
| `PUT /mailShare/bindings` | 新建 | `shareId, add?: accountIds[], remove?: bindingIds[]` | **全有或全无原子命令(R3-A4/AC-BIND-12,同一 `c.env.db.batch()`)**:任一项无效整单失败零残留;remove 以 `binding_id + share_id + owner(user_id)` 三重谓词定位,跨分享/跨租户 bindingId 混入 → 整单 `SHARE_BINDING_FORBIDDEN`(不泄露存在性);结果 Binding 数 > `SHARE_BINDING_LIMIT`(50)→ `SHARE_BINDING_LIMIT_EXCEEDED`(AC-CAP-13);1→N 需 `SHARE_CAPABILITY_V2=true`(AC-LIFE-11);加时快照 window;删光 → 撤销(AC-BIND-04);变更后同批双写主表 `account_id` = 主 Binding(AC-LIFE-10) |
| `DELETE /mailShare/revoke` | 沿用 | `shareId` | `status='REVOKED'` + `revoked_at` |
| `DELETE /mailShare/delete` | 新建 | `shareId` | 物理删除 share + bindings + 幂等行(`c.env.db.batch()` 原子) |
| `POST /mailShare/resetAuthKey` | 新建 | `shareId, action: 'enable'\|'reset'\|'disable'` | `action='enable'` 需 `SHARE_CAPABILITY_V2=true`,否则 `SHARE_INVALID_CONFIG`(AC-LIFE-11);`enable`/`reset`:新 `authKey` 明文恰一次 + `auth_key_enabled=1`(`reset` 另 `credentials_version+1`);`disable`:清空 hash/kid + `auth_key_enabled=0` + `credentials_version+1`,无明文返回 |

`premKey['share:manage']` 扩展为全部 8 条路径(`security.js:103`)。

### AuthKey 状态机(R1-A5)

```
disabled(默认)                    enabled
auth_key_hash IS NULL   ──enable──►  auth_key_hash NOT NULL
auth_key_enabled = 0    ◄─disable──  auth_key_enabled = 1
                                       │  ▲
                                       └──┘ reset(换 hash + kid)
```

| 迁移 | 触发 | 字段变化 | `credentials_version` | 对既有 Session |
|---|---|---|---|---|
| `enable` | resetAuthKey `action='enable'`(或创建时 `authKeyEnabled=true`) | 生成新 Key,写 hash+kid,`auth_key_enabled=1` | 不变 | 不失效(建立时本无 Key 要求,不追溯) |
| `reset` | resetAuthKey `action='reset'` | 换 hash+kid | +1 | 立即失效(cv 回源不匹配) |
| `disable` | resetAuthKey `action='disable'` | 清空 hash+kid,`auth_key_enabled=0` | +1 | 立即失效;新 Session 不再要求 Key |

- **字段不变量(R2-F1 收紧)**:`auth_key_enabled=1` IFF(`auth_key_hash IS NOT NULL` **AND** `auth_key_kid IS NOT NULL`)(AC-AUTH-07,schema/service spec 双侧断言,杜绝「要求一个无法验证的 Key」与「hash 在而 kid 空、无法解析 PEPPER」两类非法组合;迁移检查与异常恢复同样按此断言)。
- `PUT /mailShare/update` 不触碰 AuthKey 字段;一切 Key 迁移只经 resetAuthKey 单入口。
- 无失败计数/锁定状态(R2-A6 删除 `mail_share_auth_fail`),状态机之外无 AuthKey 相关服务端状态。

### Visitor 面 `/share/*`(匿名,`excludeExact` 精确豁免 + 边缘限流)

| Method + Path | 状态 | 请求 | 响应要点 |
|---|---|---|---|
| `POST /share/session` | 扩展 | `{lid, sec, authKey?}` + 可选 `Idempotency-Key` 头(客户端发请求前写 sessionStorage,超时重试复用同 key,R3-A3/AC-SESS-10) | 成功:`{sessionToken, shareType, mailboxes: [{bindingId, address(掩码策略后)}], expiresAt, config: {autoRefresh, refreshIntervalMs, otpExtractionEnabled, messageLimit}}`;同 key 重放命中 → 返回缓存 token 零配额消耗;失败:`SHARE_UNAVAILABLE` 或(lid+sec 通过后)`SHARE_AUTH_REQUIRED` |
| `GET /share/mailboxes/status` | 新建 | `Bearer token`(**无游标参数**,R2-A2;协议见下「Status 水位协议」) | `{mailboxes: [{bindingId, latestEmailId(null=无可见邮件), latestReceivedAt?}], serverTime}`;单请求覆盖全部 Binding(D16);挂 `SHARE_READ_RATE_LIMITER` |
| `GET /share/mails` | 扩展 | `Bearer token` + `bindingId?`(multi 必带;single 可省)`, cursor?, limit?` | 该 Binding 可见集(window ∩ 最新 N)按 `email_id` DESC;`limit` 服务端钳制 ≤ min(50, messageLimit) |
| `GET /share/mail` | 扩展 | `Bearer token` + `mailId` | 白名单投影(含 Binding 标识、掩码地址、按开关裁剪的 `code`);可见集外(含被 N 滚出)→ `SHARE_UNAVAILABLE` |
| `GET /share/attachment` | 扩展 | `Bearer token` + `mailId, attachmentId` | 三重校验扩展为多 Binding 集合;可见集外 → `SHARE_UNAVAILABLE` |

`excludeExact`(`security.js:23-29`)追加 `{ method: 'GET', path: '/share/mailboxes/status' }` 一行;禁止前缀豁免(AC-SEC-03)。

### Status 水位协议(R2-A2 · AC-OTP-09,取代 R1-A7 单标量游标)

**唯一裁决**:StatusEndpoint **不接受 `sinceEmailId`**(或任何游标参数)。R1 版单个全局标量无法表达 per-binding 消费水位——用当前 Tab 的高水位请求会漏掉其他 Tab 尚未消费的较小 ID 邮件,用最小水位则持续重复计数已消费邮箱;请求模型无法实现协议自身的状态机。服务端保持无状态、无游标:

- **响应**:始终返回每条 Binding 在其 VisibleWindow ∩ `message_limit` ∩ 既有排除条件(`is_del=NORMAL`、`status != SAVING`)内的 `latestEmailId`(**无可见邮件为 null**)与可选 `latestReceivedAt`——与 mails 端点**共用 scoped repository 同一范围条件**,不形成第二套范围模型;窗口外/被 N 滚出的邮件不影响水位(禁止侧信道,防泄露可见集之外邮件的数量/存在性)。响应不含 `newCount`,新邮件判定完全在客户端。
- **hasNew/角标(客户端职责)**:客户端持本地 per-binding 水位 map(sessionStorage,键 `share:status:<lid>`,值 `{bindingId: watermark}`);`latestEmailId > 本地水位` → 该 Binding hasNew。消费(拉取)某 Binding 的 mails 后,只把该 Binding 的本地水位推进到已拉取的最大 `email_id`;未消费的 Binding 水位不动(跨 Tab 未读天然保留)。
- **轮询次数**:全局轮询每 tick 只拉一次 status(D16),请求数与 Binding 数量无关。
- **首帧/重建**:本地无某 Binding 的水位(首次进入、存储丢失、Binding 新增)→ 以本次返回的 `latestEmailId` 建立基准且该帧不渲染角标(宁可少报一帧、绝不误报);已删 Binding 的水位直接丢弃。
- **Binding 增删语义**:服务端只返回现存 Binding 的水位;客户端 map 与响应集合对齐(新增建基准、删除丢弃),无需服务端迁移任何游标状态。

## Key Functions — Formal Specifications

### `shareAuthService.establishSession(c, lid, sec, authKey?) -> { sessionToken, ... }`(扩展 `share-auth-service.js:243-272`)
- **Preconditions**:`lid`/`sec` 为字符串;分享功能未关闭。
- **流程(单一线性化点,R1-A4 · R2-A3 收敛 · R3-A3 幂等重放)**:读行快照(得 `credentials_version = cv`、hash、Binding 等)→ 校验 ①③④ → WHERE 请求携带 `Idempotency-Key`:查 KV `share:est:<lid>:<key>`,命中即返回缓存 token(零配额、零 UPDATE,AC-SESS-10)→ 未命中才条件 UPDATE(WHERE 同时含 `status='ACTIVE'`、`expires_at > now`、`credentials_version = :cv`、配额条件)→ RETURNING 非空才 `issueToken`(token 携带该 `cv`)→ 携带 key 时将 token 写入 KV(TTL = min(120s, token 剩余寿命);KV 不可用 → 仍返回 token,fail-open 无重放保护,记 `share.system.error`,见「Session 建立幂等恢复」)。快照与 UPDATE 之间发生的撤销/过期/Key 重置/版本递增,一律使 UPDATE 条件失配而拒发——授权生命周期、凭据版本、配额三者在同一条 SQL 上提交。**以条件 UPDATE 成功时刻为配额与授权的线性化点**:UPDATE 提交后、`issueToken`/响应返回前的并发状态变化(revoke/reset/删空 Binding)属已知极窄 TOCTOU 窗口,本函数不检测、不补偿——该 token 首次回源(`resolveSession` 每请求回源判定)即失败,已消耗名额**不退还**(AC-EDGE-13 文档化行为);不为消除该窗口引入服务端 Session/Grant 存储。
- **Postconditions**:仅当 ① `sec` 摘要匹配 ② 条件 UPDATE 命中(RETURNING 非空,自证快照时刻至 UPDATE 提交时刻 `ACTIVE`、未过期、cv 未变、配额未触顶) ③ 至少一条 Binding 的 account 存活 ④ WHERE `auth_key_enabled=1` 时 `authKey` 摘要匹配——全部成立时返回 token 与配置;`used_sessions`(物理列 `access_count`)恰 +1;幂等重放命中路径(①③④ 已通过)返回缓存 token 且零配额消耗、零写库(AC-SESS-10);其余任何路径零配额消耗、零 token。本函数只承诺 UPDATE 时刻的合法性与计数原子性,不承诺响应时刻 token 仍可用(R2-A3);配额成功口径为「客户端可恢复地获得凭据」——UPDATE 已提交但响应丢失,由同 key 重放恢复(R3-A3)。
- **Loop invariants**:N/A。
- **Errors**:①②③ 失败 → `SHARE_UNAVAILABLE`(不可区分);④ 失败 → `SHARE_AUTH_REQUIRED`。429 为运输层,先于本函数。

### `shareAuthService.resolveSession(c, sessionToken) -> ShareContext`(扩展 `share-auth-service.js:274-296`)
- **Preconditions**:token 为 `s1` 四段格式。
- **Postconditions**:验签通过、行存在、`lid` 匹配、`payload.cv ?? 0 === row.credentials_version`、effectiveStatus ∈ {ACTIVE, ACCESS_LIMIT_REACHED}、至少一 Binding account 存活 → 返回 `{shareId, bindings: [{bindingId, accountId, windowStartEmailId}], messageLimit, otpExtractionEnabled, showFullAddress, expiresAt}`;对输入与行零副作用。
- **Loop invariants**:N/A。
- **Errors**:一切失败 → `SHARE_UNAVAILABLE`。

### `shareScopedEmailRepository.listForBinding(c, ctx, bindingId, cursor?, limit) -> EmailRow[]`(改造 `share-scoped-email-repository.js:60-92`)
- **Preconditions**:`bindingId ∈ ctx.bindings`(调用方已校验);`limit ≥ 1`。
- **Postconditions**:返回集恒满足 `account_id = binding.accountId AND account_id > 0 AND email_id > binding.windowStartEmailId AND is_del = NORMAL AND status != SAVING`,按 `email_id` DESC,行数 ≤ min(limit, 50, ctx.messageLimit ?? ∞),且全部属于该 Binding 可见集(最新 N 截断在 SQL 内完成,不在应用层)。
- **Loop invariants**:N/A(单查询)。
- **Errors**:范围外/不存在一律空集,由调用方映射 `SHARE_UNAVAILABLE`;不抛「不存在 vs 越权」可区分错误。

### `mailShareService.consumeSessionQuota(c, shareId, expectedCv) -> boolean`(新建,内嵌于 establishSession 流)
- **Preconditions**:行存在;`expectedCv` 为快照读取的 `credentials_version`。
- **Postconditions**:单条条件 UPDATE,WHERE 同时含 `status = 'ACTIVE'`、`expires_at > now`、`credentials_version = :expectedCv`、`(max_sessions IS NULL OR access_count < max_sessions)`(R1-A4:生命周期 + 凭据版本 + 配额共提交,不只闭合配额竞态)。返回 true 时 `used_sessions`(物理列 `access_count`)恰 +1 且提交时刻上述条件全部成立;返回 false 时行零变更。单条 SQL,无先读后写。
- **Loop invariants**:N/A。
- **Errors**:D1 故障向上抛(基础设施层翻译),不吞。

### `shareMailService.maskAddress(address, showFullAddress) -> string`(新建)
- **Preconditions**:`address` 为 `local@domain` 形式的非空字符串。
- **Postconditions**:`showFullAddress=true` → 原样返回;false → local-part 仅保留首字符 + `***`,domain 原样(`a***@x.com`);幂等(mask(mask(x)) = mask(x))。
- **Loop invariants**:N/A。
- **Errors**:非法输入返回固定占位 `***`,不抛(展示函数,fail-safe)。

## 管理后台页面与外部访问页交互

### 管理模块(新建 `mail-vue/src/views/share-admin/`,layout 内)

- **路由**:layout 子路由 + `meta.perm='share:manage'`(沿用 `perm/perm.js` `permsToRouter` 动态路由与 `ShareIndicator.vue:21-27` 的 `hasPerm` 判定模式);767px 断点遵循既有移动约定。
- **列表页**:分页表格(名称/类型/绑定邮箱摘要/effectiveStatus 四态徽标/`used_sessions/max_sessions`/到期时间/最后访问);筛选 status;行操作:详情、撤销、删除。
- **详情抽屉**:Binding 清单(增删邮箱,调 `PUT /mailShare/bindings`)、配置编辑(调 `PUT /mailShare/update`)、AuthKey 区(状态 + 重置按钮,重置后一次性展示新 Key,复用 ShareDialog 的一次性密钥展示模式 `ShareDialog.vue:161-189`)。
- **创建向导**:四预设(单邮箱验证码 / 临时邮箱 / 多邮箱验证码池 / 自定义)纯前端预填表单字段(D18);提交走升级后 create;成功后一次性展示 `shareUrl`(+`authKey`)。**结果未知恢复(R3-A6/AC-CAP-14)**:提交超时/响应丢失时以同一 `Idempotency-Key` 重试;重放只返回 `shareId`/`lid` 无 `sec` → 向导识别 `idempotentReplay` 且无明文,引导 Owner 对该分享 revoke/delete 后重新 create 取得新链接;禁止换 key 盲目重复创建。`SHARE_CAPABILITY_V2=false` 时多邮箱/AuthKey/配额表单项以「能力未激活」置灰(AC-LIFE-11)。
- **旧入口**:收件箱 `ShareIndicator`+`ShareDialog` 保留,继续单邮箱快捷创建(AC-ADMIN-08);对话框尾部加「前往分享管理」跳转。

### 外部访问页(演进 `mail-vue/src/views/share/`,匿名 chunk)

- **路径形态不变**:单/多邮箱统一 `/s/<lid>#<sec>`——`isAnonymousShareVisit` 正则(`init/init.js:18-20`)、路由白名单(`router/index.js:157-161`)、`captureShareSecret`/`clearShareSession` 守卫(`:181-183`)、session.js 全套零改动或近零改动。页面按 session 响应的 `shareType` 分支渲染。
- **AuthKey 交互**:bootstrap 建会话收到 `SHARE_AUTH_REQUIRED` → 呈现 Key 输入态(新状态机节点 `authRequired`,叠加进 `index.vue:160` 状态机);输入后重试 establish;连续失败仅提示重试(无锁定态,R2-A6;唯一节流为边缘限流 429)。
- **建会话幂等(R3-A3/AC-SESS-10)**:bootstrap 发 `POST /share/session` 前生成 `Idempotency-Key` 并写入 sessionStorage(键 `share:est-key:<lid>`);超时/响应丢失以**同一 key** 重试(禁止换 key 盲重试),成功拿到 token 后清除该 key;离开路由的会话清理契约(AC-SEC-07)同时清除该键。
- **多邮箱渲染**:轻量原生 Tab(不引 el-tabs,保持 chunk 轻量,recon-frontend §7);每 Tab 显示掩码地址 + 新邮件角标(客户端本地水位比较得出,见「Status 水位协议」);切 Tab 拉该 Binding 的 mails 并推进该 Binding 本地水位。
- **轮询协议**:`useSharePolling` 单实例,间隔取 session 下发的 `refreshIntervalMs`(`intervalMs` 参数已支持注入,`useSharePolling.js:58`);每 tick 只打一次 StatusEndpoint(无游标参数),本地比较水位后仅对有新邮件的当前 Tab 拉 mails、拉取后推进该 Binding 水位;`auto_refresh=false` 时不启动轮询、显示手动刷新按钮;429 退避与后台暂停沿用。
- **OTP 区组件化**:从 `index.vue:255-266,31-60` 抽出 `ShareOtpCard`(featuredMail 选取 + 一键复制 + 降级),单/多邮箱页共用;`otpExtractionEnabled=false` 时整区不渲染(AC-OTP-02)。
- **剩余时间**:消费 session 响应已有的 `expiresAt`(后端零改动,见 Corrected Goal)展示倒计时。
- **隔离闸门**:新增 import 必须通过 `assert-share-chunk.js` 闭包检查;守护测试红了改 import,不改闸门。

### 展示偏好:地址掩码(R2-A7,自「权限与安全边界」移出)

掩码是**投影层展示偏好**,不是安全/隐私边界(Decision 14):`show_full_address=false`(默认)时,`shareMailService.maskAddress` 对系统生成的绑定邮箱身份字段(session/status/list/detail 投影中的 mailbox address)输出 `a***@x.com` 形态(local-part 留首字符,幂等);`true` 时原样返回。发件人默认不掩码(访客需判断来源可信度);主题/正文不承诺不出现绑定地址,命中内容不改写(SafeMailRenderer 原样渲染,邮件保真优先)。Owner 管理页对该开关的文案按「显示完整地址(展示选项)」呈现,不得暗示保密效果。验证:P-MASK-01(字段级封闭性 + 幂等),AC-MAIL-08。

## 权限与安全边界

| 边界 | 规则 |
|---|---|
| URL 形态 | 只含 `lid` + fragment `sec`;无 mailbox_id/account_id/真实地址(AC-SEC-01)。多邮箱不引入新 URL 形态 |
| Owner 面 | JWT + `share:manage` 精确 method+path(8 条);缺权限 `SHARE_FORBIDDEN`;跨用户操作 `SHARE_NOT_FOUND`。**授权矩阵(R1-A8)**:本期 `share:manage` 仅为「操作本人分享」的路由级权限,全部 Owner 端点资源谓词恒为 `user_id = 当前用户`;跨用户管理员审计不在本期;`security.js:163` 的 `c.env.admin` 邮箱豁免仅为运维超级账号的路由豁免,资源谓词不变,非跨租户产品能力 |
| Visitor 面 | 全部经 `share-auth-service` token + 每请求回源;不复用 JWT/`share:manage`/`/public/*`(AC-SEC-02);豁免仅精确白名单(AC-SEC-03/10) |
| 越权邮箱 | 范围唯一强制点 = scoped repository 的 Binding 集合条件;`bindingId`/`mailId`/`attachmentId` 篡改一律 `SHARE_UNAVAILABLE`(AC-MAIL-06/AC-EDGE-08) |
| N 封截断 | 列表/详情/附件三处服务端强制(AC-MAIL-05);「前端限 N 后端全量」被 P-SCOPE-03 property 钉死 |
| AuthKey | 只存 hash;常量时间比较;暴力防护仅靠既有 IP 边缘限流(R2-A6,128-bit Key 不可在线穷举,无失败计数/锁定状态);错误暴露面最小化(仅合法持链者见 `SHARE_AUTH_REQUIRED`) |
| 凭据日志 | `sec`/`authKey`/token 不进服务端日志、查询串、Referer(AC-SEC-09);fragment 方案与一次性捕获沿用 |
| 前端隔离 | share chunk 禁入登录态 axios/layout/Dexie/websiteConfig;会话存储清理契约含新路由态(AC-SEC-06/07) |
| 写能力 | Visitor 面零写端点;唯一服务端写(`used_sessions`/`last_access_at`)均为鉴权流内部簿记,不是资源写能力 |

## Error Handling

| Scenario | Layer | Handling(stable error code) |
|---|---|---|
| `lid` 不存在 / `sec` 错 / 过期 / 撤销 / account 全失效 / 功能关 / 配额触顶(建立时) | share-auth-service | `SHARE_UNAVAILABLE`(不可区分,防 oracle) |
| `lid`+`sec` 通过但 AuthKey 缺失/错误 | share-auth-service | `SHARE_AUTH_REQUIRED`(仅此一处可区分;缺失 vs 错误不可区分;零配额、零锁定,R2-A6) |
| token 过期 / `cv` 不匹配 / 差异态外的非 ACTIVE | share-auth-service | `SHARE_UNAVAILABLE` |
| `mailId`/`attachmentId`/`bindingId` 越出可见集 | share-mail-service / share-attachment-service | `SHARE_UNAVAILABLE`(不泄露存在性) |
| 创建携带非本人/已删 accountId | mail-share-service | `SHARE_ACCOUNT_FORBIDDEN`(整单拒绝,无部分 Binding) |
| 重复绑定同一邮箱 | mail-share-service | `SHARE_BINDING_DUPLICATE`(新码) |
| bindings 批量变更混入跨分享/跨租户/不存在的 bindingId | mail-share-service | `SHARE_BINDING_FORBIDDEN`(新码,R3-A4;整单失败零残留,不泄露存在性) |
| create/bindings 使 Binding 数超 `SHARE_BINDING_LIMIT`(50) | mail-share-service | `SHARE_BINDING_LIMIT_EXCEEDED`(新码,R3-A5;整单拒绝) |
| `SHARE_CAPABILITY_V2=false` 时的受限策略写入(multi/1→N/AuthKey 启用/有限配额) | mail-share-service | `SHARE_INVALID_CONFIG`(AC-LIFE-11;前端以「能力未激活」提示) |
| 配置越域(`refreshIntervalMs<3000`、`messageLimit<1`、`maxSessions<1`) | mail-share-service | `SHARE_INVALID_CONFIG`(新码) |
| 有效期/活跃数超管理员上限 | mail-share-service | `SHARE_DURATION_EXCEEDED` / `SHARE_LIMIT_EXCEEDED`(沿用) |
| 同 Idempotency-Key 异请求体 | mail-share-service | `SHARE_IDEMPOTENCY_CONFLICT`(沿用;指纹含新字段) |
| Owner 操作他人分享 | mail-share-service | `SHARE_NOT_FOUND`(沿用) |
| 缺 `share:manage` | security 中间件 | `SHARE_FORBIDDEN` 403(沿用) |
| 功能关闭时 Owner 写操作 | mail-share-service | `SHARE_DISABLED`(沿用) |
| 边缘限流命中 | share-rate-limit 中间件 | HTTP 429 + `Retry-After`(运输层,不映射业务码,不消耗配额) |
| `last_access_at` 等统计写失败 | share-auth-service | log + 继续签发(fire-and-forget 沿用);配额 UPDATE 失败则**必须**拒发,不属统计 |
| Session 幂等重放 KV 读/写不可用 | share-auth-service | fail-open:仍签发 token(该次无重放保护)+ `share.system.error` 日志(R3-A3 文档化风险) |
| D1 异常 / 迁移半途 | init.js / service | 逐语句幂等 + try/catch 记录;service 层向上抛翻译为 5xx,不吞不假成功 |

### 结构化观测(R1-F3 · R2-F2 补全 · 不新增事件表)

核心状态机的拒绝/异常路径打结构化日志(`console.log` JSON 一行),事件名固定清单、**无 PII、无凭据**(不含 `sec`/authKey/token/IP 明文/邮箱地址);**每条日志携带 `requestId` 与 `shareId`**(R2-F2,请求关联字段;requestId 取既有请求上下文标识)及错误分类、时间戳:

- `share.session.denied_quota` —— 配额触顶拒发
- `share.session.denied_auth` —— AuthKey 缺失/错误拒发
- `share.session.denied_cv` —— `credentials_version` 不匹配拒绝(建立或回源)
- `share.binding.cascade` —— account 删除触发的 Binding 级联剔除/撤销(含孤儿补偿)
- `share.migrate.invalid_row` —— 迁移门禁不通过的旧行 REVOKED 处置(R2-F2/AC-BIND-11)
- `share.system.error` —— 未归类系统故障(D1 异常等 5xx 翻译点,R2-F2)

事件清单与「配额/撤销/孤儿/迁移失败/系统故障」诊断类别一一对应(R2-F2:锁定类随 R2-A6 删除);无新表(D17 deferred 不变)。Cloudflare 日志承载为采集端;**发布门槛(R3-A7)**:启用 `SHARE_CAPABILITY_V2` 前,上述事件清单(至少 `share.migrate.invalid_row`、`share.session.denied_quota`、`share.system.error`)必须已有告警消费者(阈值 + 接收人),否则不得置 true(AC-LIFE-11);完整 Runbook 不在本期。

- **基线守恒**:既有 worker 16 文件/138、vue 17 文件/95、E2E 13 场景全绿(recon-crosscut §7 亲跑)是回归底线;单邮箱旧行为断言**不改**,只扩展。
- **TDD red→green 顺序**(实现期):① `v3-2-db.spec.js` 新迁移/回填/门禁断言 → ② `share-auth-service.spec.js` 配额闸门/authKey/cv → ③ `share-scoped-email-repository.spec.js` 集合化 + per-binding window + DESC 截断 → ④ `mail-share-service.spec.js` 多 accountId 创建/bindings 增删/双写/级联新语义 → ⑤ API 层与前端 spec → ⑥ `share-integration.spec.js` + E2E 新场景。
- **Property-based**(fast-check,≥100 iterations):范围封闭性、掩码幂等、配额不变量(见下)。
- **E2E 新场景**(对应 Success State 的 Verified once by):干净浏览器单/多邮箱链接、真投递验证码邮件、自动刷新与 OTP 复制、耗尽 max_sessions 后隐身窗口进不来、旧 Session TTL 内可读、撤销即断、AuthKey 输入流、`max_sessions=1` 注入响应丢失后同 key 重试成功且不超发(AC-SESS-10)。
- **迁移测试**:预置 v3_1 形状旧行(含 account 已删/归属不符的脏行)→ 跑 v3_2DB → 断言有效行 Binding 回填、无效行 REVOKED 且零 Binding(AC-BIND-11)、旧链接建会话行为不变、`max_sessions=NULL` 无配额判定、重复跑幂等(AC-LIFE-08/AC-EDGE-09)。
- **守护测试**:`assert-share-chunk.js` 覆盖新访客代码;`mail-share.schema.spec.js` 扩展新列 + 遗留列只读语义;`security-share.spec.js` 扩展新端点门控与 `/share-evil` 封闭性。

**Traceability 矩阵**(每条 AC 的验证手段;U=单测 I=集成 P=property E=E2E/前端 spec M=迁移测试):

| AC | 验证手段 | 类 |
|---|---|---|
| AC-CAP-01 | create 多 accountId → 断言 share 行 + N 条 binding 行 + URL 形状 | I |
| AC-CAP-02 | 创建/增删 Binding 后各响应 `shareType` 实时派生正确(1→single,>1→multi);扫表断言无 share_type 列 | U |
| AC-CAP-03 | 混入他人/已删 accountId → `SHARE_ACCOUNT_FORBIDDEN` 且零 binding 残留 | I |
| AC-CAP-04 | 沿用 mail-share 基线断言(lid/sec 位宽、hmac 存储、sec 仅一次)保持全绿 | U |
| AC-CAP-05 | 启用 authKey 创建 → 响应含明文一次、库中仅 hash+kid;二次查询无明文 | I |
| AC-CAP-06 | 各配置字段落库断言;`refreshIntervalMs=2999` → `SHARE_INVALID_CONFIG` | U |
| AC-CAP-07 | 预置邮件后创建 → 每 binding window = 该邮箱 MAX(email_id);并发投递下单语句原子 | I |
| AC-CAP-08 | `onlyMessagesAfterCreated=false` 创建 → 全部 binding window=0 | U |
| AC-CAP-09 | 同 Key 等价重放(含新字段)→ 同 shareId 无 sec/authKey;异指纹 → `SHARE_IDEMPOTENCY_CONFLICT` | I |
| AC-CAP-10 | 以旧 ShareDialog 载荷形状(单 accountId 无新字段)调 create → 成功且默认值 | I |
| AC-CAP-11 | 超 `SHARE_MAX_DURATION_SECONDS`/`SHARE_ACTIVE_LIMIT` → 既有错误码(基线保持) | I |
| AC-CAP-12 | 前端创建向导 spec:预设仅改表单模型,请求不含预设标识 | E |
| AC-CAP-13 | 预置 50 Binding 后 add → `SHARE_BINDING_LIMIT_EXCEEDED`;create 51 个 accountId → 同码整单拒绝零写入 | I |
| AC-CAP-14 | 幂等重放响应无 sec/authKey 明文断言;向导识别 idempotentReplay 无明文 → 「删除重建」引导交互 spec;换 key 重复创建被前端禁止 | I+E |
| AC-BIND-01 | schema spec 断言双写非 0;grep 级断言鉴权/范围代码零**读取** `mail_share.account_id`(双写路径除外) | U |
| AC-BIND-02 | ACTIVE 分享加邮箱 → binding 新行 + window 快照正确 | I |
| AC-BIND-03 | 移除 binding 后 Visitor 列表/状态即刻不含该邮箱 | I |
| AC-BIND-04 | 移除全部 binding → 行变 REVOKED + revoked_at | I |
| AC-BIND-05 | 软删/硬删 account → 对应 binding 剔除、他 binding 分享保持 ACTIVE | I |
| AC-BIND-06 | 删 account 后剩 0 binding → 分享 REVOKED | I |
| AC-BIND-07 | 重复添加同 accountId → `SHARE_BINDING_DUPLICATE`(UNIQUE 索引兜底) | U |
| AC-BIND-08 | 增删 binding 后立即拉取 → 结果集与新集合一致(P-BIND-02) | P |
| AC-BIND-09 | v3_1 形状有效旧行跑迁移 → 恰一条 binding 回填、重复跑幂等 | M |
| AC-BIND-10 | 先删 account 再并发加 Binding → 单语句条件 INSERT 零行 + `SHARE_ACCOUNT_FORBIDDEN`;注入孤儿行 → 级联/清理路径剔除 | I |
| AC-BIND-11 | 预置 account 已删/归属不符/不存在三类脏行跑迁移 → 零 Binding 回填 + 行变 REVOKED(记 revoked_at);**合法无 Binding 晚写行注入(INSERT 后、UPDATE 前)→ 保持 ACTIVE,重跑 INSERT 收编(R3-A2)**;交错时序全注入(INSERT 前/间/后/任务重启);扫表断言零非法 Binding;`share.migrate.invalid_row` 日志断言 | M |
| AC-BIND-12 | 批量变更混入无效项(跨分享/跨租户/不存在 bindingId)→ 整单 `SHARE_BINDING_FORBIDDEN` 零残留;add/remove 混合部分无效 → 整单回滚;V2=false 时 1→N 拒绝;并发两次变更序列化断言 | I |
| AC-SESS-01 | establish 成功 → used_sessions(物理列 access_count)恰 +1(RETURNING 含 status/expires/cv/配额四条件);触顶/撤销/过期/cv 变 → 拒发零变更;幂等重放命中路径零 UPDATE 零配额(与 AC-SESS-10 联测) | U |
| AC-SESS-02 | 建会话后跑 mails/mail/attachment/status 各 N 次 → used_sessions 不变(P-SESS-02) | P |
| AC-SESS-03 | 前端 spec:sessionStorage 有效 token 时 bootstrap 不调 `/share/session` | E |
| AC-SESS-04 | E2E:新隐身窗口打开 → used_sessions +1 | E |
| AC-SESS-05 | token exp = min(expires_at, iat+TTL);无任何续期端点(API 面枚举) | U |
| AC-SESS-06 | 触顶后既有 token 读请求仍 200(P-SESS-03) | I |
| AC-SESS-07 | 触顶后新建 session → `SHARE_UNAVAILABLE`;E2E 隐身窗口进不来 | I+E |
| AC-SESS-08 | 更换请求源 IP 头重放读请求 → 仍 200 | I |
| AC-SESS-09 | session 响应含 shareType/mailboxes/expiresAt/config;统计写失败注入 → 仍签发 | I |
| AC-SESS-10 | 同 Idempotency-Key 重放 → 同 token、used_sessions 不变;新 key/无 key → 正常消耗;KV 故障注入 → 仍签发 + `share.system.error` 日志;前端同 key 重试 spec;E2E max_sessions=1 响应丢失重试不超发 | I+E |
| AC-SESS-11 | 配额 UPDATE RETURNING 空或语句抛错 → 拒发、零消耗(取代旧 mail-share AC-LIFE-14 对闸门的适用) | I |
| AC-AUTH-01 | 启用 Key 后无 Key/错 Key establish → `SHARE_AUTH_REQUIRED`、零 token、used_sessions 不变 | I |
| AC-AUTH-02 | lid 不存在/sec 错 + 任意 authKey 组合 → 恒 `SHARE_UNAVAILABLE`(P-AUTH-01) | P |
| AC-AUTH-03 | 库中无明文断言;比较走常量时间工具(代码断言 + 单测) | U |
| AC-AUTH-04 | resetAuthKey 后旧 token 读 → `SHARE_UNAVAILABLE`;新 Key 建会话成功(P-AUTH-02) | I |
| AC-AUTH-05 | 连续多次错误 Key 后正确 Key 仍立即成功(无锁定);扫 schema 断言无 `mail_share_auth_fail` 表;代码级断言无失败计数写路径 | U+I |
| AC-AUTH-06 | 限流命中 → 429 + Retry-After、非业务码、used_sessions 不变(基线扩展) | I |
| AC-AUTH-07 | 状态机全迁移断言:enable/reset/disable 后 hash/kid/enabled/cv 组合合法;`auth_key_enabled=1` IFF hash 与 kid 均非空(R2-F1);update 端点改 Key 字段被拒 | U |
| AC-AUTH-08 | disable → hash/kid 清空 + enabled=0 + cv+1;旧 token 读 → `SHARE_UNAVAILABLE`;新建会话不再要求 Key | I |
| AC-MAIL-01 | 多 binding 下越邮箱查询 → 空/`SHARE_UNAVAILABLE`(P-BIND-01) | P |
| AC-MAIL-02 | 两邮箱不同 window → 各自下界独立生效 | U |
| AC-MAIL-03 | messageLimit=N 各邮箱投 N+2 封 → 各返回最新 N;N=1 合法 | U |
| AC-MAIL-04 | 新邮件到达 → 最旧滚出,列表与详情均不可再取 | I |
| AC-MAIL-05 | 直接按 mailId 取被滚出/窗口外邮件与附件 → `SHARE_UNAVAILABLE`(P-SCOPE-03) | P |
| AC-MAIL-06 | 篡改 mailId/attachmentId/bindingId 指向他分享 → `SHARE_UNAVAILABLE` 无存在性泄露 | I |
| AC-MAIL-07 | 投影键集合断言(白名单,无 user_id/account_id 原值/is_del/status) | U |
| AC-MAIL-08 | show_full_address 双态下响应地址形状断言(P-MASK-01);发件人不掩码 | P |
| AC-MAIL-09 | onlyMessagesAfterCreated=false → 历史邮件可见且仍受 N 截断 | I |
| AC-OTP-01 | otp 开 → 投影 code 恒等 email.code(P-OTP-04) | P |
| AC-OTP-02 | otp 关 → 投影无 code 键;前端 spec 不渲染 OTP 区;摄取链 spec 基线不变 | U+E |
| AC-OTP-03 | code='' 邮件 → 列表/详情正常返回,前端正常渲染 | E |
| AC-OTP-04 | E2E 真投递含码邮件 → OTP 区出现 + 复制成功 | E |
| AC-OTP-05 | auto_refresh 双态前端 spec:轮询启/停 + 手动刷新按钮 | E |
| AC-OTP-06 | 写入 2000 → 落库/下发均被钳制为 3000 | U |
| AC-OTP-07 | 多邮箱页轮询 spec:每 tick 恰一次 status 请求,无 N 路并发 | E |
| AC-OTP-08 | 429 注入 → 按 Retry-After 退避继续,不清会话(基线扩展) | E |
| AC-OTP-09 | API 面断言无游标参数;`latestEmailId=null` 无可见邮件;窗口外与被 N 滚出邮件注入 → latestEmailId 不反映(侧信道封闭);前端水位 map 推进/首帧基准/Binding 增删对齐 spec | I+P+E |
| AC-ADMIN-01 | 管理列表组件 spec:字段齐全 + 路由 meta perm | E |
| AC-ADMIN-02 | get 本人 → 详情+bindings+config;他人 shareId → `SHARE_NOT_FOUND` | I |
| AC-ADMIN-03 | update 各字段 → 落库 + 下次 Visitor 请求生效 | I |
| AC-ADMIN-04 | 下调 max_sessions ≤ used_sessions → 接受且 effectiveStatus=ACCESS_LIMIT_REACHED | U |
| AC-ADMIN-05 | resetAuthKey → 新明文一次 + cv+1 + auth_key_enabled=1 | I |
| AC-ADMIN-06 | revoke → REVOKED+revoked_at;再启用尝试被拒(基线保持) | I |
| AC-ADMIN-07 | delete → share/binding/幂等行全删,零孤儿(batch 原子) | I |
| AC-ADMIN-08 | ShareDialog 基线 spec 保持全绿(旧契约可用) | E |
| AC-ADMIN-09 | 三种非 ACTIVE 计算态行在列表可见且态正确 | I |
| AC-ADMIN-10 | 移除 share:manage → 8 端点全 `SHARE_FORBIDDEN`(security-share 扩展) | I |
| AC-SEC-01 | URL 构造单测 + E2E 断言 URL 无 account/mailbox 标识 | U+E |
| AC-SEC-02 | Visitor 端点带 JWT 无 share token → 拒;带 share token 访问 Owner 端点 → 拒 | I |
| AC-SEC-03 | excludeExact 精确集合断言;`/share-evil`/`/share/mailboxes/statusX` 不豁免 | I |
| AC-SEC-04 | Visitor 面路由枚举断言零写端点 | U |
| AC-SEC-05 | 附件跨 binding 越权 → `SHARE_UNAVAILABLE`;响应无 /oss/ 直链 | I |
| AC-SEC-06 | assert-share-chunk 守护测试覆盖新页面依赖闭包 | E |
| AC-SEC-07 | 前端 spec:离开路由/收到 UNAVAILABLE → sessionStorage 键清除(基线扩展) | E |
| AC-SEC-08 | 常量时间比较 + 原子条件写代码路径断言(无先读后写) | U |
| AC-SEC-09 | headers E2E + 日志采样断言无 sec/authKey/token | E |
| AC-SEC-10 | 前缀近似路径请求 → 401/403(mail-share 旧 charter 的 LEAK-06 前缀封闭性基线保持) | I |
| AC-LIFE-01 | DB 中 status 值域断言仅 ACTIVE/REVOKED(全场景跑完后扫表) | I |
| AC-LIFE-02 | effectiveStatus 全组合真值表(P-LIFE-02) | P |
| AC-LIFE-03 | 建会话→撤销→读 → `SHARE_UNAVAILABLE`(基线保持) | I |
| AC-LIFE-04 | 触顶态:新建拒 + 旧 token 放行(与 AC-SESS-06 同用例双断言) | I |
| AC-LIFE-05 | 过期后新建与旧 token 均拒 | I |
| AC-LIFE-06 | cleanup 跑后到期 share 的 binding 行同批清除,零孤儿 | I |
| AC-LIFE-07 | SHARE_ENABLED=0 期间 Visitor 全拒;恢复后旧 ACTIVE 可用(基线保持) | I |
| AC-LIFE-08 | 迁移后旧链接 establish/读全流程行为与迁移前一致 | M |
| AC-LIFE-09 | account 删除 → 经 binding JOIN 的级联断言(account-delete-share 扩展) | I |
| AC-LIFE-10 | 双写断言:create/bindings 增删后主表 account_id = 主 Binding 且非 0;`SHARE_CAPABILITY_V2=false` 时 multi create 被拒;回填重跑收编旧 Worker 晚写行;四条发布路径按「迁移/发布协议」逐一注入验证(含随机路由新旧 Worker 混跑无策略差异) | M+I |
| AC-LIFE-11 | V2=false 下四路受限写入(multi create/1→N bindings/AuthKey enable/有限 maxSessions)全部 `SHARE_INVALID_CONFIG` + 行为等同旧单邮箱(双写仍进行)断言;V2=true 后放行;前端「能力未激活」降级 spec | I+E |
| AC-EDGE-01 | 同 token 高频轮询 → used_sessions 不变(与 P-SESS-02 合并) | P |
| AC-EDGE-02 | 并发 establish 竞争最后名额 → 恰 max 次成功(P-SESS-01) | P |
| AC-EDGE-03 | E2E:浏览中撤销 → 下一拍停轮询+清存储+不可用态 | E |
| AC-EDGE-04 | 浏览中移除一邮箱 → 下拍消失、余箱正常 | I+E |
| AC-EDGE-05 | 持会话中 resetAuthKey → 下一请求失败;新 Key 重进消耗新配额 | I |
| AC-EDGE-06 | messageLimit=1 单封/滚动场景断言 | U |
| AC-EDGE-07 | 零邮件分享 → 空列表 200,无历史泄露 | I |
| AC-EDGE-08 | 他分享 bindingId → `SHARE_UNAVAILABLE`(与 AC-MAIL-06 同族用例) | I |
| AC-EDGE-09 | 迁移旧行 used_sessions>0 且 max=NULL → 无配额判定 | M |
| AC-EDGE-10 | 剩余有效期 < TTL → token exp 被 expires_at 截短 | U |
| AC-EDGE-11 | status 与 mails 同周期调用 → 零配额、同 token、同范围 | I |
| AC-EDGE-12 | 错误 Key → `SHARE_AUTH_REQUIRED` 且 used_sessions 不变、无锁定副作用;限流命中 → 429 独立、零配额(与 AC-AUTH-06 同族) | I |
| AC-EDGE-13 | 状态变更提交于条件 UPDATE **前**的并发交错注入 → 全部正确拒发、零配额、无超发;UPDATE 成功**后**注入(TOCTOU)→ token 首次回源 `SHARE_UNAVAILABLE`、名额不退还(文档化行为断言) | I+P |
| AC-EDGE-14 | 迁移旧行 access_count>0,首设 max_sessions 有限值(缺省 resetUsedSessions=true)→ access_count 置 0、新会话可建立;显式 false → 计数保留、立即 ACCESS_LIMIT_REACHED | I |

## Correctness Properties

### P-BIND-01: Binding 集合封闭性

For any 有效 ShareContext 与任意查询参数组合, THE ShareScopedEmailRepository SHALL 只返回 `account_id` 属于该分享现存 Binding 集合的邮件行,且每行满足其所属 Binding 的 `window_start_email_id` 下界与全部中间态排除条件。

**Validates: AC-MAIL-01, AC-MAIL-02, AC-MAIL-06**

### P-BIND-02: Binding 增删即时性

For any Binding 增删操作序列, THE ShareMailService SHALL 使操作完成后的任意 Visitor 读请求结果集与「按当前 Binding 集合重新计算的可见集」一致(无缓存滞留)。

**Validates: AC-BIND-03, AC-BIND-08, AC-EDGE-04**

### P-SESS-01: 配额不超发

For any 并发的 Session 建立请求序列与任意 `max_sessions = M`, THE ShareAuthService SHALL 使成功签发的累计次数恒不大于 M,且 `used_sessions` 终值等于成功次数。

**Validates: AC-SESS-01, AC-SESS-07, AC-EDGE-02**

### P-SESS-02: 读请求零配额消耗

For any 已建立 Session 的读请求序列(mails/mail/attachment/status,含 429 与失败), THE ShareAuthService SHALL 保持 `used_sessions` 不变。

**Validates: AC-SESS-02, AC-EDGE-01, AC-EDGE-11**

### P-SESS-03: 触顶不清场

For any 在 `used_sessions` 达到 `max_sessions` 之前签发的 sessionToken, THE ShareAuthService SHALL 在该 token 自身 `exp` 之前、分享未撤销未过期且 `credentials_version` 未变更的条件下持续接受其读请求。

**Validates: AC-SESS-06, AC-LIFE-04**

### P-AUTH-01: Visitor 失败不可区分性(扩展)

For any 未通过 `lid`+`sec` 校验的 Visitor 请求(不存在/密钥错/过期/撤销/触顶/功能关), THE ShareAuthService SHALL 返回同一 `SHARE_UNAVAILABLE` 形状;`SHARE_AUTH_REQUIRED` SHALL 仅出现在 `lid`+`sec` 已通过的请求上。

**Validates: AC-AUTH-01, AC-AUTH-02, AC-EDGE-08**

### P-AUTH-02: credentials_version 单调失效

For any AuthKey 重置序列, THE MailShareService SHALL 使 `credentials_version` 严格单调递增,且 THE ShareAuthService SHALL 拒绝一切携带小于当前版本 `cv` 的 token。

**Validates: AC-AUTH-04, AC-EDGE-05**

### P-SCOPE-03: message_limit 服务端封闭性

For any `message_limit = N` 与任意邮件到达序列, THE ShareMailService SHALL 使列表、详情、附件三类端点可及的邮件集合恒等于每 Binding 可见窗口内按 `email_id` DESC 的前 N 封;被滚出集合的邮件 SHALL 经任何参数组合均不可再获取。

**Validates: AC-MAIL-03, AC-MAIL-04, AC-MAIL-05, AC-EDGE-06**

### P-MASK-01: 身份字段掩码封闭性与幂等(R1-A3 收窄)

For any `show_full_address=false` 的分享与任意 Visitor 响应, THE ShareMailService SHALL 使**一切系统生成的绑定邮箱身份字段**(session/status/list/detail 投影中的 mailbox address,含 Binding 标识随附地址)均为掩码形态;且 maskAddress SHALL 幂等。本性质 SHALL NOT 约束用户邮件内容字段(发件人/主题/正文)——发件人默认不掩码,命中绑定地址的主题/正文原样保真(property test 以真实含址正文数据可同时通过,不需规避或删改内容)。

**Validates: AC-MAIL-08**

### P-OTP-04: code 字段条件存在性

For any Visitor 投影输出, `code` 键存在 IFF 该分享 `otp_extraction_enabled=true`;且其值恒等于 `email.code` 原值(含空串),永不由分享链推断产生。

**Validates: AC-OTP-01, AC-OTP-02**

### P-LIFE-02: 状态判定纯函数性

For any `mail_share` 行与时刻 `now`, effectiveStatus(row, now) SHALL 为确定性纯函数且判定优先级恒为 REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE;计算过程 SHALL 零写库。

**Validates: AC-LIFE-01, AC-LIFE-02**

## Link table (§0.15B)

| 节点 | Producer | Consumer |
|---|---|---|
| Share URL `/s/<lid>#<sec>` | `mail-vue/src/views/email/build-share-url.js:1-9`(沿用)+ to-build 管理模块创建向导 | `mail-vue/src/views/share/session.js:76-104` `captureShareSecret/consumeShareSecret`(沿用) |
| `POST /mailShare/create` 扩展 payload | to-build(管理模块创建向导)+ `ShareDialog.vue:92-139`(旧形状兼容) | `mail-worker/src/api/mail-share-api.js:23-28` → `mail-share-service.js`(扩展) |
| `mail_share_binding` 行 | to-build(create/bindings 写入 + v3_2DB 门禁回填,落 `init.js` 注册链 `init.js:31-32` 之后) | to-build `share-scoped-email-repository` 集合化查询;rework `mail-share-service.js:394-415` 级联;extend `mail-share-cleanup-service.js:20-28` |
| `mail_share.account_id` 双写(Expand 期,R2-A1) | to-build(create/bindings 变更同批写主 Binding 的 account_id,禁止写 0) | 旧版本 Worker 兼容窗口内的读路径(部署面消费者,非本仓代码);Contract 阶段停止双写后无消费者 |
| `POST /share/session`(+authKey) | `mail-vue/src/views/share/index.vue:514-556` bootstrap(扩展 authRequired 态) | `mail-worker/src/api/share-api.js:54-58` → `share-auth-service.js:243-272`(扩展闸门/Key) |
| sessionToken `s1`(payload+`cv`) | `share-auth-service.js:155-180` issueToken(扩展) | `share-auth-service.js:182-207,274-296` verifyToken/resolveSession(扩展 cv 比对) |
| `used_sessions` 配额闸门 | to-build 条件 UPDATE(替换 `share-auth-service.js:236-241` recordAccess 语义) | `share-auth-service.js:25-33` effectiveStatus(扩展 ACCESS_LIMIT_REACHED)→ Owner 列表投影 `mail-share-service.js:354-364` |
| `auth_key_hash`/`credentials_version` | to-build `POST /mailShare/resetAuthKey` + create(经 `digestShareSecret` 同款设施 `share-auth-service.js:86-89`) | to-build establishSession 第二因子 + resolveSession cv 校验 |
| `GET /share/mailboxes/status` | to-build(share-api 新端点,挂 `share-rate-limit.js` + `security.js:23-29` 白名单加行) | to-build 多邮箱访客页 + `useSharePolling.js:56-214`(扩展调用序) |
| `GET /share/mails`(bindingId/DESC/N 截断) | `share-api.js:60-69`(扩展) | `views/share/index.vue` 列表区(扩展)+ to-build 多邮箱 Tab |
| Visitor 投影(掩码/otp 裁剪/Binding 标识) | `share-mail-service.js:46-63` project(扩展) | to-build `ShareOtpCard` + SafeMailRenderer(`components/safe-mail/index.vue`,零改动)|
| Owner 管理端点(get/update/bindings/delete/resetAuthKey) | to-build `mail-share-api.js` 5 端点 + `security.js:103` premKey 扩展 | to-build `views/share-admin/` 列表/详情抽屉 |
| `SHARE_CAPABILITY_V2` 全能力栅栏(R3-A1) | 部署环境变量(发布负责人按激活前置置位) | to-build create/update/bindings/resetAuthKey 写入口门控校验 + to-build 前端「能力未激活」降级提示 |
| Session 幂等重放 KV `share:est:<lid>:<key>`(R3-A3) | to-build establishSession 成功后写入(既有 `c.env.kv` 绑定,`security.js:117` 同款设施;`KvConst` 新增前缀 `mail-worker/src/const/kv-const.js:1-7`) | to-build establishSession 重放查询路径 + to-build 访客页 bootstrap 同 key 重试 |
| **Final sink** | — | 未登录浏览器中的访客页:展示掩码邮箱、自动刷新、可复制 OTP;E2E `tests/e2e/specs/`(扩展场景)为 Success State 的机器判据 |

每条 `to-build` 均对应后续 tasks.md 条目;`existing` 节点锚点已于 2026-08-24 工作树复核。

## 已知限制与技术债

交付时已知、且**本期明确不修**的三条。写在这里而不是留在过程产物里,是为了让接手者只读 spec 就能看到。

| ID | 债目 | 锚点 | 处置 |
|---|---|---|---|
| **D-1** | 死分支 `setting.share`。`isShareDisabled()` 两处各判一次 `setting.share === 1 \|\| setting.share === '1'` 作为「站点级关分享」开关,但仓内没有任何地方写入过 `setting.share`,该分支恒为 false —— 实际生效的只有环境变量 `SHARE_ENABLED`。 | `mail-worker/src/service/mail-share-service.js:60`<br>`mail-worker/src/service/share-auth-service.js:69` | 不修、不删。它是为将来的站点设置项预留的读点,删它要动两个已收口的服务文件并重跑其定点 spec,收益为零。 |
| **D-2** | Expand 阶段双写未停。`syncPrimaryAccountId()` 在每次 Binding 变更时把 `mail_share.account_id` 与 `window_start_email_id` 同步为主 Binding 的值,保证兼容窗口内旧 Worker 仍能按主表列服务单邮箱语义。 | 定义 `mail-worker/src/service/mail-share-service.js:730-760`<br>调用点 `:863`(create)`:1228`(binding 变更)<br>ADR `## Consequences` | 不修。Contract(停双写、`account_id` 降为遗留列)的前置是部署侧事实(确认无旧 Worker 在途),不是代码判断,属后续版本任务。 |
| **D-3** | 存 token 复活时的配置降级。刷新页面后若 sessionStorage 仍有有效 token,前端不重建会话(省一个配额名额),因而拿不到 `config`/`expiresAt`:倒计时消失、刷新间隔回落到 `POLL_INTERVAL_MS`、`autoRefresh` 回落到 true,直到会话重新建立。 | `mail-vue/src/views/share/index.vue:904-910`<br>钉住的断言 `mail-vue/src/views/share/index.spec.js:1396-1411` | 已知限制,不修。AC-SESS-03(复活不多耗配额)优先于 AC-OTP-05。 |

## Update Log

- 2026-08-24 · executor(规格撰写执行者):Mode 1 CREATE 首次落盘。front-matter 按 spec-deliverable.md §Template 2 schema(先读模板、后读仓内旧 spec,只借领域词汇);Current-State Inventory 30 行锚点来自三份 recon 并抽查亲验;修正 recon-frontend §1 一处记述(session 响应实际已含 `expiresAt`,`share-auth-service.js:266-271`)。tasks.md 依模板铁律待 spec-cross-review 通过后再产。
- 2026-08-24 · executor(R1 修订执行者)消化第 1 轮异构评审 `review.sub.md`(过筛:全采纳):
  - R1 · A1 → 采纳(DDL 删 RENAME COLUMN,全程 expand-only:物理列保留 `access_count`,应用层读写旧列名、DTO 映射 `usedSessions`,旧 Worker 兼容可回滚;改 Decision 4、DDL、Corrected Goal、闸门 SQL)
  - R1 · A2 → 采纳(DDL 删 `share_type` 列;Decision 1 改为 Binding 计数实时派生,`mail_share_binding` 唯一真源;update 端点与迁移段同步)
  - R1 · A3 → 采纳(P-MASK-01 收窄为系统生成的绑定邮箱身份字段;发件人/主题/正文不承诺、命中内容不改写;Decision 14 同步)
  - R1 · A4 → 采纳(establishSession/consumeSessionQuota 重写为单一线性化点:条件 UPDATE 同时含 `status='ACTIVE'`+`expires_at>now`+`credentials_version=:cv`+配额;不签发即死 token;矩阵补 AC-EDGE-13)
  - R1 · A5 → 采纳(新增「AuthKey 状态机」小节:disabled→enable→reset→disable,字段不变量 enabled IFF hash 非空,cv 规则与既有 Session 影响逐迁移定死;resetAuthKey 支持 action 参数)
  - R1 · A6 → 采纳(锁定改 `(shareId, IP)` 维度,新表 `mail_share_auth_fail`(ip_hash 无 PII),10 次/5 分钟写死、成功清零;删 mail_share 三列;Decision 9 重写)
  - R1 · A7 → 采纳(新增「Status 游标协议」小节:游标所有权/推进时机/范围规则与 scoped repository 同源/Binding 变更/重连语义;矩阵补 AC-OTP-09)
  - R1 · A8 → 采纳(权限表补授权矩阵:`share:manage` 本期仅本人分享路由权限,`c.env.admin` 豁免为运维超级账号、资源谓词不变)
  - R1 · A9 → 采纳(新增「Binding 写入的并发一致性」:单语句条件 INSERT…SELECT 含 account 存活/归属,失败 `SHARE_ACCOUNT_FORBIDDEN`,清理补偿孤儿;D1 约束与 cleanup 库存行同步;矩阵补 AC-BIND-10)
  - R1 · F1 → 采纳(Decision 8 补 Key 规格:128-bit CSPRNG、base64url、22 字符定长,校验仅 trim)
  - R1 · F2 → 采纳(list 行补分页契约:size 默认 20/上限 100、排序 `share_id DESC`、无参 deprecated 上限 500)
  - R1 · F3 → 采纳(Error Handling 后新增「结构化观测」:5 个固定事件名、无 PII 无凭据、无新表)
- 2026-08-24 · executor(R2 修订执行者)消化第 2 轮异构评审 `review2.sub.md`(主 AI 过筛:P0/P1 全采纳、P2 轻量):
  - R2 · A1 → 采纳(新增「迁移/发布协议」专节:Expand 双写主 Binding 禁止写 0、`SHARE_MULTI_ENABLED` 门控、读路径只信 Binding、Contract 停双写、回滚预案,含三条路径验收;新增 Decision 20;改 Overview、保留列段、Inventory、create/bindings API 行、Link table 增双写节点;矩阵补 AC-LIFE-10)
  - R2 · A2 → 采纳(「Status 游标协议」重写为「Status 水位协议」:唯一裁决不接受 sinceEmailId,始终返回 per-binding `latestEmailId`(null=无邮件)+可选 `latestReceivedAt`、响应去 `newCount`,hasNew 由客户端 sessionStorage 水位 map(键 `share:status:<lid>`)本地比较;API 表去 since 参数;改 Overview/Corrected Goal/Decision 16/多邮箱渲染/轮询协议;矩阵 AC-OTP-09 重写)
  - R2 · A3 → 采纳(线性化承诺收敛:establishSession 流程/Postconditions 删「不签发即死 token」承诺,明确 UPDATE 成功时刻为线性化点、UPDATE→issueToken 为已知极窄 TOCTOU、token 回源失败名额不退还、不建服务端 Session/Grant 表;Decision 4 补线性化承诺;语义表同步;矩阵 AC-EDGE-13 改为「UPDATE 前正确拒绝 + TOCTOU 文档化断言」)
  - R2 · A4 → 采纳(回填 SQL 重写:JOIN account 门禁(存活/`is_del=NORMAL`/`user_id` 匹配),不满足旧行 UPDATE 置 REVOKED 不建 Binding、打 `share.migrate.invalid_row`;两语句幂等可重跑;矩阵补 AC-BIND-11,迁移测试行同步)
  - R2 · A5 → 采纳(Decision 5 补配额纪元基线:首设有限值默认 `resetUsedSessions=true` 置 0、显式 false 保留;update API 行加 `resetUsedSessions?` 参数;矩阵补 AC-EDGE-14)
  - R2 · A6 → 采纳(删除 `mail_share_auth_fail` 表:DDL 节改为删除说明、cleanup 清理项移除、Decision 9 重写为「仅边缘限流」、架构图/Inventory/语义表/安全边界表/Error Handling/AuthKey 状态机去锁定;矩阵 AC-AUTH-05/AC-EDGE-12 重写)
  - R2 · A7 → 采纳(Decision 14 改写为「展示偏好,非安全边界」;新增「展示偏好:地址掩码」小节落 UI/投影侧,自安全边界移出;Owner 端文案不得暗示保密效果)
  - R2 · F1 → 采纳(AuthKey 字段不变量收紧:enabled=1 IFF hash 与 kid 均非空,纳入 schema/service 双侧断言、迁移检查与异常恢复;矩阵 AC-AUTH-07 同步)
  - R2 · F2 → 采纳(结构化观测补 `share.migrate.invalid_row`/`share.system.error` 两事件,删 `denied_lock`;每条日志带 requestId/shareId、无凭据;诊断类别与事件清单一一对应)
- 2026-08-24 · executor(R3 修订执行者)消化第 3 轮异构评审 `review3.sub.md`(主 AI 过筛裁决:3 P0 + 4 P1 采纳;P2-F1/F2 不在本轮指令内,未动):
  - R3 · A1 → 采纳(`SHARE_MULTI_ENABLED` 升级为 `SHARE_CAPABILITY_V2` 全能力发布栅栏:改写「迁移/发布协议」节为全能力激活栅栏 + 四条路径验收(新增路径④随机路由)、Decision 20 重写、Overview/create/update/bindings/resetAuthKey API 行同步、激活前置含告警消费者;Link table 增栅栏节点;矩阵 AC-LIFE-10 更新 + 补 AC-LIFE-11)
  - R3 · A2 → 采纳(迁移无效行 UPDATE 重写为显式 account 事实谓词(NOT EXISTS 存活/归属 JOIN),废弃「无 Binding」判据;新增「交错安全」段:INSERT 与 UPDATE 之间的合法旧写不误 REVOKED、由重跑收编,交错时序测试纳入矩阵 AC-BIND-11)
  - R3 · A3 → 采纳(新增「Session 建立幂等恢复(KV 结果重放)」专节:配额成功口径=客户端可恢复地获得凭据;`Idempotency-Key` + KV `share:est:<lid>:<key>`(TTL=min(120s, token 剩余寿命),`c.env.kv` 既有绑定)同 key 重放零配额;KV 不可用 fail-open 签发 + `share.system.error`、文档标风险;establishSession 流程/Postconditions 更新;session API 行加头;访客页补同 key 重试交互;E2E 补 max_sessions=1 场景;Link table 增 KV 节点;矩阵补 AC-SESS-10)
  - R3 · A4 → 采纳(bindings API 行重写为全有或全无原子命令:remove 三重谓词 `binding_id+share_id+owner`,跨分享混入整单 `SHARE_BINDING_FORBIDDEN`,1→N 受 V2 门控;Error Handling 增新码;矩阵补 AC-BIND-12)
  - R3 · A5 → 采纳(常量 `SHARE_BINDING_LIMIT`=50 落 create/bindings 两写入口,超限 `SHARE_BINDING_LIMIT_EXCEEDED` 整单拒绝;Error Handling 增新码;矩阵补 AC-CAP-13)
  - R3 · A6 → 采纳(管理模块创建向导补「结果未知恢复」:重放无明文 → 引导 revoke/delete 后重建,禁止换 key 盲建;create API 行标注恢复流程;矩阵补 AC-CAP-14)
  - R3 · A7 → 采纳(结构化观测节补发布门槛一句话:启用 V2 前关键事件必须已有告警消费者(阈值+接收人),否则不得置 true;「日志检索即消费端」改为「采集端 + 门槛」;完整 Runbook 不在本期)
- 2026-08-24 · 主 AI:T-29 审查 APPROVED p0=0（`review-t29.md`）。P2-1 CHANGE：ADR Consequences 旧名 `SHARE_MULTI_ENABLED` 改为现行 `SHARE_CAPABILITY_V2`。P2-2 CHANGE：D-3 生产锚点 `index.vue:902-908` → `:904-910`。勾选 T-29。
- 2026-08-24 · executor(T-29 收尾执行者):**邮箱分享能力交付。** 单/多邮箱统一 Binding 模型、累计 Session 配额闸门、可选 AuthKey 第二因子、访客页多邮箱 Tab 与 OTP 提取全部落地;`SHARE_CAPABILITY_V2` 生产默认仍为 false,多邮箱/AuthKey/有限 `max_sessions` 三项能力代码就位但整体冻结,激活是部署动作。三套测试基线:worker 18 files / 626、vue 22 files / 252、E2E 19 passed / 0 skipped。front-matter `status: converged → shipped`、`shipped_commit: 190f704`;ADR 转 Accepted 并补「实施结论」。本轮同时修掉 `expiresAt` 残留(`clearMailboxView` 与 `exitShare` 各补一行清零,先红后绿两条单测 + 一条 E2E 死壳断言),补齐 96 个 i18n 键(访客 10 + 管理端 86,zh/en 双语),新增本节「已知限制与技术债」D-1/D-2/D-3。
