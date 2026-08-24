# 决策卡 · 邮件分享能力加固与扩展(share-hardening)

- 日期:2026-08-25 · 仓库 `F:\Email\cloud-mail-upstream`
- 类型:✨ Feature flow(混合两条 bug 修复)· 产 Boundary Decision Card,**不产 spec 三件套**(charter 触发闸门未通过:无新子系统、无跨 session 交接)
- 状态:**待异构评审 → 待用户批准 → 未开工**
- 侦察输入(6 份,全部 read-only 落盘):
  - `recon-config-keys.md` · 密钥与配置链路
  - `recon-timezone.md` · 时间序列化与时区契约
  - `recon-frontend-share-ui.md` · 前端展示 / 复制 / 条数上限
  - `recon-ratelimit-batch-ttl.md` · 限流 / 批量 / 有效期
  - `recon-v2-fence-prereq.md` · 栅栏激活前置(见 §1.6)
  - `recon-credential-recoverable.md` · 凭据可逆存储方案(见 §1.4)

---

## 🏗️ 1. 边界决策

### 1.0 成功状态(§0.15B · 必填 · 有来源)

> **NOT**「后端补了 `.utc()`、前端加了自定义有效期输入框、新增了批量端点」,
> **BUT** 部署者按 README 一次配齐即可创建分享而不撞 500;管理员在管理台看到的失效时间与访客页倒计时**在生产与本地都指向同一时刻**;管理员随时能取回已创建分享的完整链接并复制;管理员能一次为 N 个邮箱各生成一条独立链接;有效期不再被 7 天档位卡住。
>
> **不该发生**:① 修完时区后本地开发环境反而显示错误(两处必须同批)② 放开有效期后可创建无上限时长的分享 ③ 凭据可恢复化之后,数据库单点泄露即可还原全部历史链接 ④ 批量创建成为无限流的滥用放大器。
>
> 来源:用户原话(问题一 / 问题二 / 四条需求)+ 消费方前置条件(`mail-vue/src/utils/day.js:83-85` 全仓时间约定 · `mail-worker/src/security/security.js:73-81` 权限双表契约)。

### 1.1 Bounded Context

分享子系统(`mail-worker/src/service/mail-share-service.js` · `share-auth-service.js` · `share-scoped-email-repository.js` · `mail-vue/src/views/share/` · `views/share-admin/`)。本轮不外溢到邮件收发、账号、鉴权核心域;唯一跨域接触点是复用 `turnstile-service.js`(基础设施层,只读复用不改)。

### 1.2 本轮八项交付与分类(§0.17 业务现实闸门)

| # | 谁 · 在什么操作中 · 得到什么结果(负向条件) | 现实核实结论 | 来源类型 | 分类 | 本轮 |
|---|---|---|---|---|---|
| A | **部署者**按 README 一次配齐环境变量即可创建分享(不该发生:配齐前撞不可理解的 500 · 密钥被 commit 进仓库) | 部分成立。ADR `ADR-mail-share-capability-boundary.md:55` 写了、部署层没落地;且 `.dev.vars` **未被 gitignore**(实测 `git check-ignore` EXIT=1) | 用户原话 + 侦察发现(gitignore) | A 业务必需 + 安全 | ✅ |
| B | **管理员与访客**看到的失效时刻指向同一物理时间(不该发生:修完生产对了本地反而错) | **归因反转**。访客页正确,管理台三处零转换才是生产缺陷 | 用户原话(现象) · 归因由侦察推翻 | A 业务必需 | ✅ |
| C | **管理员**在详情页随时看到并复制当初创建的完整链接(不该发生:老分享静默显示空白而不说明原因) | 前两条**已实现**(从未掩码 · 复制按钮已有);只有第三条成立且需架构变更 | 用户原话 + 二次确认 | A(仅第三条) | ✅ |
| D | **访客**只看到每个邮箱最新 N 封邮件,新邮件挤掉最旧的 | 确认为「每邮箱动态取最新 N 封」,SQL 实时求值,语义合理 | 用户原话(要求确认) | 确认保留,零改动 | ✅ 仅文档 |
| E | **管理员**点「启用访问密钥」被拒时,能从提示分辨是「能力未开放」还是「自己配置写错」(不该发生:管理员以为系统故障去翻日志) | **不是 bug**,是 `SHARE_CAPABILITY_V2` 栅栏按设计生效。但三种语义(状态不匹配 / 配置越域 / 发布栅栏)共用一个错误码,`mail-share-service.js:1329-1330` 注释自承「语义只能靠语句顺序保住」。**交付契约**:栅栏路径改抛独立错误码 `SHARE_CAPABILITY_NOT_ENABLED`(HTTP 沿用现有信封),前端提示「该能力尚未开放,请联系管理员开启」而非裸码;`SHARE_INVALID_CONFIG` 收窄为真正的配置越域。归 T-03 同批(它已在改这条链路的日志),e2e 覆盖「V2=false 时启用密钥」 | 用户误报为 bug → 侦察定性;**真实损失已在本轮发生**(用户本人耗时误判) | B 稳定性 | ✅ |
| F | **访客**遭遇暴力猜链接时被验证码拦下(不该发生:第三方验证服务故障导致合法访客全被挡在门外) | 前提不成立(登录侧是 Turnstile+累计计数;分享侧已有 CF 原生限流)。**相对既有限流的增量**:CF binding 按 `CF-Connecting-IP` 计数 10 次/60s,挡不住①分布式低频猜测(每 IP 每分钟 1 次、上千 IP 并发,永不触发阈值)②已知 `lid` 后对 `sec` 的慢速枚举。验证码把成本从「换 IP」抬到「过人机验证」,这是限流拿不到的维度 | 用户原话(前提被侦察推翻 · 增量价值由本卡补证) | B 稳定性 | ✅ 部分 |
| G | **管理员**一次操作为 N 个邮箱各拿到一条互相隔离的链接,分发给 N 个不同的人 | 现有 `accountIds[]` 是「一条链接绑 N 邮箱」,用户要的是「N 邮箱各一条链接」(用户二次确认为语义 B) | 用户原话 + 二次确认 | A 业务必需 | ✅ |
| H | **管理员**能选择超过 7 天但不超过安全上限的有效期(不该发生:放开后可建十年期分享) | 7 天只在前端两个下拉框;后端生产**根本无上限** | 用户原话 + 反向缺口由侦察发现 | A + 反向补 B | ✅ |

**判定为 D 类(技术洁癖)而不做的**:无。八项均有真实业务损失或安全暴露面。

### 1.3 三项用户已裁决的方向(2026-08-25 · 不可由执行者推翻)

1. **栅栏 `SHARE_CAPABILITY_V2`:本轮开启**,但必须先逐项核实四条激活前置(§1.6),缺任一项则停下报告,**不得为赶进度直接置 true**。
2. **凭据可重复查看:双轨——可逆加密(新建) + 重新生成(存量与泄露场景)**。用户第一次裁决选了可逆存储;随后侦察发现两个他当时不知道的事实(存量永远无法回填 · 重新生成已有过评审的现成设计稿),**已回到用户二次确认**,用户明确「详情页要能看到当初创建的链接、默认可见、AuthKey 保持一次性」。安全代价已二次告知并获接受。详见 §1.4。
3. **批量创建:语义 B**——N 个邮箱各生成各自独立的一条链接,互相看不到对方邮件。

### 1.3.1 已比较并否决的方案(记录已发生的取舍 · 防止执行者重新发明)

**凭据恢复(三档)**:

| 档 | 方案 | 代价 | 判决 |
|---|---|---|---|
| 沿用现状 | 保持不可恢复,丢了就 revoke + create | 零成本 | ❌ 否决。用户明确要求详情页可见,且这正是当前痛点本身 |
| 局部调整 | **仅**做重新生成(轨二),不碰存储 | 零新增列 / 零新增密钥 / 零安全回归;设计稿已过三轮评审 | ⚠️ **必需但不充分**。它是存量分享的唯一出路,故保留为轨二;但它只能给「新链接」,答不了用户「看当初那条」 |
| 边界重构 | 可逆加密存储(轨一) | 从零建加密体系;推翻 AC-SHARE-04 / AC-CAP-04;安全等级下降 | ✅ 采纳为轨一,**仅覆盖新建分享** |

**停止条件**:若 KEK 管理在预览环境验证时无法做到与 D1 真正分离(例如只能落 `setting` 表),则轨一停止,退回仅轨二并向用户重新汇报。

**批量创建(三档 · 出自 `recon-ratelimit-batch-ttl.md §4.5`)**:

| 档 | 方案 | 判决 |
|---|---|---|
| 沿用现状 | 前端循环调用现有单条 `create` | ❌ 否决。N 次 HTTP 零服务端节流,而 `create` 当前**零限流**,等于把滥用放大器交给前端;事务性与重试全推给前端 |
| 局部调整 | 改造现有 `create` 加 `splitPerAccount` 标志 | ❌ 否决。`normalizeCreateBody:192-212` 的字段顺序是幂等指纹的一部分,仓库已标注为红线,加字段即打断滚动发布兼容 |
| 新增端点 | `POST /mailShare/batchCreate` | ✅ 采纳。绕开幂等红线,且能就地为批量单独定限流与部分失败契约 |

**停止条件**:若批量在 50 个邮箱上撞 D1 单语句 100 绑定参数上限(`mail-share-service.js:299-302` 已警告)且无法分片解决,则降低单批上限并在 UI 明示,不改为前端循环。

### 1.4 凭据可恢复的边界(来源 `recon-credential-recoverable.md` · 用户 2026-08-25 二次确认)

**用户目标(原话)**:「在前端点击查看详情,可以看到这个邮箱当初创建的分享链接是哪个」+「不需要像 key 那样只展示一次」。
→ 解析:① 详情页**默认**可见完整链接,不做创建时勾选 ② **AuthKey 保持一次性**(用户明确认可 key 的现有行为),只有 `sec` 纳入可恢复范围。

**两条硬事实(决定了必须双轨,不是二选一)**:

1. **存量分享永远无法回填。** 上线前创建的分享,其 `sec` 明文在创建响应发出后即不存在于任何存储。加密列只能对**新建**分享生效。
2. **「重新生成」的设计稿已存在且过了三轮评审**,只是被标记停用:`docs/specs/mail-share/design.md:295-297`「后续 regenerate 约定」正文完整,配套 AC-SHARE-13 / AC-LIFE-05 / AC-LIFE-11 是 `{status: deprecated, by: R3-regenerate}`,**正文一字未删**,取消标记即可启用。零新增列、零新增密钥、零安全回归。

**因此本轮采用双轨**:

| 轨 | 覆盖对象 | 详情页行为 |
|---|---|---|
| 轨一 · 可逆加密存储 `sec` | 上线后**新建**的分享 | 直接显示完整链接 + 复制按钮(复用 `useCopyWithFallback`) |
| 轨二 · 重新生成链接 | **存量**分享 + 任何链接泄露场景 | 显示「不可恢复,可重新生成一条」+ 操作入口 |

**轨二不是可选项**——存量分享只能靠它,且它是泄露场景的唯一处置手段。

**技术边界(硬约束,执行者不得放宽)**:

- **加密算法**:AES-GCM(Cloudflare 官方确认 Workers 完整支持 `crypto.subtle` 的 AES-GCM 与 HKDF `deriveKey`)。**全仓现无任何 encrypt/decrypt**——6 处 `crypto.subtle` 全是摘要或 HMAC 签名(`crypto-utils.js:20`、`jwt-utils.js:35-64`、`share-auth-service.js:102-116`),这是从零新建的能力。

- **⛔ 密文持久化协议(选算法不等于定协议 · 执行者不得自行发明)**:

  | 项 | 契约 |
  |---|---|
  | envelope | 版本化:`v1:<kek_kid>:<base64url(nonce)>:<base64url(ciphertext‖tag)>`。**版本号在最前**,未来换算法不需要猜格式 |
  | nonce | 每次加密**独立 CSPRNG 生成 96-bit**,复用既有 `randomToken`。⛔ **绝不允许**由 shareId / 计数器 / 时间戳派生——GCM 下 nonce 重用即机密性崩塌 |
  | AAD | 绑定 `shareId`,防止密文被整列搬到另一行后仍可解密 |
  | 认证标签 | GCM 内建 128-bit tag,随密文存储,解密失败即认证失败,**不得吞掉** |
  | kid 查找 | 复用 `collectKeyedSecrets` 的 kid 环。读取时按行上 `kek_kid` 取键;**写入恒用当前 kid**(与 `resetAuthKey:1357` 的 pepper 前滚同构) |
  | 轮换 | 加新 KEK 到环 → 新写入用新 kid → 旧行按旧 kid 继续可解 → 旧 KEK 退环后旧行降级为「不可恢复,可重新生成」,**不报错** |

- **⛔ 四类失败必须分开,不得折叠成同一句「不可恢复」**(否则部署事故与数据损坏会被伪装成正常降级):

  | 情形 | 判据 | 对管理员 | 日志/告警 |
  |---|---|---|---|
  | 旧记录无密文 | 密文列为 NULL | 「此分享创建于功能上线前,不可恢复,可重新生成」 | 不告警(正常) |
  | KEK 暂缺 | 环里一个键都没有 | 「服务配置异常,请联系管理员」 | **告警**(部署事故) |
  | 未知 kid | 行上 kid 不在环内 | 「密钥已轮换退环,不可恢复,可重新生成」 | 记事件,不告警 |
  | 认证失败 / 密文损坏 | GCM tag 校验不通过 | 「凭据数据异常」 | **告警**(数据完整性事故) |
- **密钥轮换复用既有机制**:`collectKeyedSecrets`(`share-auth-service.js:118-131`)是纯泛型 kid 环,`kek_kid` 直接加第三个环,**不新造轮换机制**。
- **KEK 与 D1 分离**:走 `wrangler secret put`,**禁止**落 `setting` 表(Turnstile secret 那种存法在这里不适用)。
- **解密端点**:仅 Owner 鉴权后可调,**必须限流 + 审计日志**(记 who/when/whichShare,不记明文)。
- **AuthKey 不纳入**:`auth_key_hash` 保持不可恢复,AC-CAP-05 一字不改。
- **⛔ KEK 缺失必须分创建阶段与读取阶段,不得共用一条降级**(否则会静默产出一批事后才发现无法恢复的新分享):
  - **创建阶段(写)**:KEK 缺失 → **拒绝创建**,返回明确的服务配置异常 + 告警。⛔ 绝不允许「创建成功但没加密」——那等于用户以为拿到了可恢复的分享,实际没有,且要等到几天后点详情页才发现。
  - **读取阶段(查看链接)**:KEK 缺失 → 降级为「服务配置异常,请联系管理员」+ 告警(见 §1.4 四类失败表),**不得**报 500 崩溃,也**不得**伪装成「存量不可恢复」这类正常降级。
  - 两阶段共同点:都必须告警,因为 KEK 缺失恒为部署事故,不是正常业务状态。
- **`credentials_version` 复用**:核实结论是它**原本不是**为此设计的(属 AuthKey reset,`ADR-...extension.md:15`),但机制可原样复用——重新生成时 `cv+1` 即刻踢掉在途访客会话。`resetAuthKey`(`mail-share-service.js:1331-1370`)是逐段可对应的同构先例。

**契约冲突条款(必须在 ADR 中显式取代,不得静默违反)**:

- `mail-share/requirements.md:61` **AC-SHARE-04**「或可据以重建 `sec` 的数据」—— 核心冲突条款。
- `mailbox-share-capability/requirements.md:58` **AC-CAP-04**「只以」—— 核心冲突条款。
- `mail-share/requirements.md:75` 记载的原裁决:「`sec` 不可再次读取是安全不变量,`sec` 丢失即丢失」—— 本轮**正是在推翻这条**,ADR 必须记录推翻理由与用户裁决日期。
- 常被误指的 AC-SHARE-03 **不冲突**(它约束的是存密文,本方案正是存密文)。

**⚠️ 安全护栏会自动让路(必须人工补)**:现有守卫(含 `share-integration.spec.js:248-267` 的全库扫描)**全是明文子串扫描,密文照过**。也就是说加密方案上线时,**不会有任何测试跳出来提醒**。真会打红的只有几处列快照断言。→ **必须新增针对性测试**:断言解密端点鉴权、断言 KEK 缺失时 fail-closed、断言 AuthKey 仍不可恢复。

**安全代价(诚实陈述,已向用户告知并获确认)**:今天即便拿到全库加 pepper 也还原不出 `sec`(HMAC 单向、2^256 空间)——**明文是真的不存在**,这是本轮要交出去的性质。改动后,**同时拿到 D1 与 KEK 即可离线批量还原上线后的所有分享链接**。最划算的压制措施是「只加密 `sec`、AuthKey 保持不可恢复」,零成本且不动 AC-CAP-05,已采纳。

### 1.5 状态机与不变量(本轮新增/受影响)

- **不变量 I-1(时间)**:`mail_share` 的 `expires_at` / `delete_at` / `create_time` 与服务端 `nowText()` **必须同为 UTC 裸串**。当前分享模块是全仓唯一违反者。修复后该不变量由「运行环境恰好是 UTC」的隐式约定,升级为代码显式保证。
- **不变量 I-2(有效期 · 缺失时的行为已统一)**:`durationSeconds ≤ 有效上限`,且**任何部署下都存在有效上限**。
  - 当前实现 `mail-share-service.js:269-275` 在变量未配置时返回 `null` = 无上限,**这本身就是缺陷**(生产正处于此状态)。
  - **裁定**:代码内置**兜底上限 90 天**。`SHARE_MAX_DURATION_SECONDS` 存在时取其值,缺失时取兜底值,**永不退化为无上限**。这样「必须显式配置」是运维最佳实践,而「缺失」不再等于「不设防」——两者不再互相矛盾。
  - 配套:超限错误码沿用 `SHARE_DURATION_EXCEEDED`;部署验收断言「不配该变量时创建 91 天分享被拒」;测试基线 `86400` 的多处夹具随 T-22 一并评估。
- **不变量 I-3(批量 · 明确为「逐项部分成功」,不是整批原子)**:
  - **裁决**:批量采用**部分成功**语义。理由:① N 个邮箱里混入一个越权邮箱时,不该拖垮其余 N-1 个 ② D1 单语句有 100 个绑定参数上限(`mail-share-service.js:299-302` 已警告),50 邮箱 × 每条 3 语句的整批原子事务本身就不可靠。
  - **原子性边界 = 单个邮箱**:每个邮箱的「share 行 + binding 行 + 幂等行」三者要么全写要么全不写;**跨邮箱之间无事务**。
  - **响应契约**:`{created:[...], failed:[{accountId, code}]}`,HTTP 恒 200(部分失败不是请求失败)。
  - **幂等粒度 = 每邮箱一个子键**:`<Idempotency-Key>#<accountId>`。重试整批时,已成功的邮箱走重放路径(返回原 shareId 且**不再下发 `sec`**,与现有 create 重放语义一致),只有 failed 的邮箱真正重新创建。**这是「重试不产生重复链接」的唯一保障。**
  - **前端状态机**:必须能表达「7 成 3 败」并提供「只重试失败项」,不得只给「全部重来」。
  - ⛔ 原「任一条失败不得留下半写状态」的表述**已作废**——它与部分成功契约直接矛盾,是本卡 R1 评审抓到的 P0(A2)。
- **不变量 I-4(凭据)**:AuthKey 明文恰一次的既有不变量**保持不变**;仅 `sec` 的可恢复性被本轮放宽。

### 1.6 栅栏激活前置核实(来源 `recon-v2-fence-prereq.md`)

**四项前置:零项可从代码判定为「已满足」。** 用户已裁决本轮开启,但开启动作必须卡在下列核实之后。

| # | 前置 | 代码侧结论 | 判定 | 运维确认动作 |
|---|---|---|---|---|
| 1 | 迁移完成 | 资产完整:11 个 V2 列 + `mail_share_binding` + 2 索引全在 `init.js:38-89` 的 `v3_2DB`。但**无 `.sql` 文件、无迁移版本表**,全是幂等 `ALTER`/`CREATE IF NOT EXISTS`;且**只由人工访问 `GET /api/init/{jwt_secret}` 触发**(`init-api.js:4`),部署不触发、cron 不含 | ⚠️ 需查库 | `wrangler d1` 查 `mail_share` 是否已有 `auth_key_hash` 等列、`mail_share_binding` 是否存在 |
| 2 | 回填重跑完成 | `backfillShareBindings`(`init.js:93-106`)把存量 share 的 `account_id` 带门禁回填进 Binding 表,幂等可重跑。**无独立脚本,重跑 = 再访问一次 init URL** | ⚠️ 需查库 | 查 pending 计数为 0,且两次查询数字稳定 |
| 3 | 无旧 Worker 在途 | 代码里查不到,纯平台事实。旧基线锚点在 `mail-share-service.js:223`(`5a81065`) | ⚠️ 需平台确认 | `wrangler deployments list` |
| 4 | 告警消费者就位 | 6 个事件、9 个产出点就位,但告警规则是 Cloudflare 侧配置,仓库内零对应物。`wrangler.toml:6-7` 的 `[observability]` 只是采集端 | ⚠️ 需平台确认 + **有代码缺口,见下** | Cloudflare 侧核对告警规则 |

**第 4 项的两条代码缺口(本轮发现,建议同批修)**:

- 全部 8 个 `logShareEvent` 调用点**都没传 `requestId`**,线上恒为 `null`。`mail-share-service.js:84-85` 注释写「恒带 requestId」但 `:87` 默认值就是 `null`——**注释描述的是计划不是事实**,与 `design.md:451` 要求不符,告警无法按请求关联。
- `share.migrate.invalid_row` 绕过 SSOT 手写 `console.log`(`init.js:127`),字段形状与其余五个不同(无 `requestId` 键)。它恰是发布门槛点名必须告警的三个事件之一,**按字段过滤的告警规则会整类漏掉**。

**回退安全性:已核实成立。** 栅栏是纯写入侧断言(`:77-82` 只有 `if/throw`),不改任何数据;`share-auth-service.js` 全文不读该开关,已写入的 AuthKey 与配额继续无条件执行;清空 / 缩减 / `disable` 路径全部放行,Owner 能主动降级但系统绝不代劳。**但开与关的安全前提是同一个——无旧 Worker 在途。**

**两套开启指引**:

- **本地**:`mail-worker/.dev.vars` 追加 `SHARE_CAPABILITY_V2 = "true"` 后重启(已核实无 `--env`,顶层 `.dev.vars` 生效且 `wrangler-dev.toml` 无同名冲突)。
- **生产**:Dashboard 明文环境变量,**绝不取消 `wrangler.toml:58` 的注释**(`keep_vars` 拦不住 toml 里显式写的值,取消注释会把 Dashboard 的 true 覆盖回 false)。
- ⛔ **取值只能是 `true` / `1`**。`isCapabilityV2Enabled`(`mail-share-service.js:67-70`)是严格值匹配 `flag === '1' || flag === 1 || flag === true || flag === 'true'`——填 `TRUE` / `True` 会**静默判为关闭且不报任何错**。

### 1.7 ADR 准入(必填)

**需要 ADR:是。** 理由:凭据从「不可恢复摘要」改为「可逆加密」是**难以撤回的安全边界变更**,且直接推翻现有 `ADR-mailbox-share-capability-extension.md` 的 capability-URL 决策——后人必然会问「为什么当初决定不可恢复,后来又改了」。

- 落 `docs/architecture/ADR-share-credential-recoverability.md`,状态 `Proposed`,在编码前成文并指导实现,完工翻 `Accepted`。
- 同时在原 ADR 追加一行「已被 ADR-share-credential-recoverability 部分取代(仅 `sec`,AuthKey 不变)」,**不整篇重写**。
- 其余七项均为实现细节或既有决策的落地,不单独立 ADR。

---

## 🔍 2. 既有实现检索(反造轮子 · 每条带锚点)

| 待建能力 | 检索结论 | 处置 |
|---|---|---|
| 复制到剪贴板 | **已有 SSOT** `mail-vue/src/composables/useCopyWithFallback.js:120-209`(clipboard → execCommand → 手动选中三级降级),4 个消费者 | 直接复用,**禁止新建** |
| 人机验证 | **已有** `mail-worker/src/service/turnstile-service.js:5-33`;前端脚本 `mail-vue/index.html:20-24` 已全站加载 | 复用 service,分享页新增挂载点 |
| 访客侧限流 | **已有 CF 官方 binding** `mail-worker/src/security/share-rate-limit.js:55-72` + `wrangler.toml:12-20`,保护 5 个端点 | 复用;**不重造** KV/D1 计数(该文件 `:5-7` 注释即当初否决记录) |
| 时区转换 | **已有 SSOT** `mail-vue/src/utils/day.js:83-85` `tzDayjs()` | 管理台三处改为调用它 |
| 凭据摘要 | **已有** `share-auth-service.js:113-116` `digestShareSecret` + `pepper_kid` 轮换机制 | 加密方案复用同款 kid 轮换设计 |
| 密钥轮换 kid 机制 | **已有** `pepper_kid`(`entity/mail-share.js:8`) | 新增 `kek_kid` 同构,不发明新机制 |
| AuthKey 状态迁移端点 | **已有同构先例** `mail-share-service.js:1331` `resetAuthKey`(enable/reset/disable 三态 + 条件 UPDATE 守卫) | 若需「重新生成链接」按同构写法 |

**外部检索**:`share-rate-limit.js:9-27` 已内嵌 CF Rate Limiting 平台约束(`period` 仅 10 或 60 秒)的契约注释,本轮不需重新查证。Workers 运行时恒 UTC 一条,由 `recon-timezone.md` 提供官方文档与 workerd#2328 维护者原话背书。

---

## 📐 3. 接口契约与链路表

### 3.1 Goal → Outcome 链路表

> 每跳必须能回答:谁产出什么 → 谁消费它 → 用户侧看到什么结果 → 失败时怎样。**consumer 必须是真实消费方**(页面 / 服务 / 告警规则 / 人),不是存储列,也不是验证命令。

| # | 链路 | Producer | Artifact(产出物) | Consumer(真实消费方) | 最终结果(用户可观察) | 失败行为 / 当前缺口 |
|---|---|---|---|---|---|---|
| L1 | 密钥不入库 | `.gitignore` **待建** | 被忽略的 `.dev.vars` | **git 提交流程**(非 `check-ignore`,那只是验证手段) | 部署者本地配密钥而不会误提交 | 缺口:当前完全未忽略,一次 `git add -A` 即泄露 |
| L2 | 部署可执行 | `wrangler.toml` 注释 + README **待建** | 5 项变量的配置指引 | **部署者(人)** | 一次配齐即可创建分享 | 缺口:ADR 有、部署入口无 |
| L3 | 时间写入统一 | `mail-share-service.js:1139-1142`(+`share-auth-service.js:44`、`cleanup:35-36`)**待改** | UTC 裸串 `expires_at` | 下游 L4 / L5 / 清理任务 / 过期判定 | — (中间产物) | **存量混合格式已裁决,见下** |
| L4 | 管理台显示 | 上游 L3 | 同上 | `share-admin/index.vue:73`、`ShareDetailDrawer.vue:49`、`ShareDialog.vue:57` **待改**(接 `tzDayjs`) | 管理员看到正确本地时刻 | 缺口:三处零转换,生产少显示 8 小时 |
| L5 | 访客倒计时 | 上游 L3 | 同上 | `share/index.vue:560-566` **已正确** | 访客看到正确剩余时间 | 无缺口,**不动** |
| L6 | 新分享链接可查看 | 创建服务写加密列 **待建** | 版本化密文 envelope + `kek_kid` | 解密端点 **待建** → 管理台详情页 **待建** | 管理员随时看到并复制完整链接 | 四类失败分类见 §1.4;**KEK 未注册则整条链路不可用** |
| L6b | 解密可审计 | 解密端点 **待建** | 审计事件(who/when/whichShare,不含明文) | **日志告警消费者**(与 L11 同一 sink) | 凭据查看行为可追溯 | 缺口:审计事件与告警规则均待建 |
| L7 | 存量分享可重新生成 | `POST /mailShare/regenerate` **待建**(语义已存于 `design.md:295-297`) | 新 `lid`/`sec` + `cv+1` + **新 `sec` 的密文 envelope**(与 create 同一加密路径) | 管理台详情页入口 **待建** · `share-auth-service` 会话校验(已有,读 `cv`) | 管理员拿到新链接,**且这条新链接此后可反复查看**(不再只看一次) | 缺口:未进权限双表 / 限流 / e2e。⚠️ 用户可见副作用(踢访客)必须在 UI 二次确认。⛔ **新 `sec` 必须走同一加密写入**,否则重新生成出来的链接又退回一次性,双轨自相矛盾;KEK 缺失时 regenerate 与 create 同样 fail-closed 拒绝 |
| L8 | 批量创建 | `POST /mailShare/batchCreate` **待建** + `security.js:73-81`/`:112-121` 双表 **待改** | N 条独立分享 + N 个子幂等键 | `request/share.js` **待建** → 向导批量 UI **待建** | 管理员一次拿到 N 条隔离链接 | 部分失败按 §1.5 I-3;**重试只重试 failed 项** |
| L9 | 访客验证码 | `websiteConfig` `siteKey`(`setting-service.js:215` 已有,分享页**未接线**) | Turnstile token | `share/index.vue` 挂载 **待建** → `createShareSession` **待改** → `share-api.js:55` 校验 **待建** → `turnstile-service.js:5-33`(已有) | 合法访客通过验证建立会话 | 四类失败见 §3.2;**上游故障降级策略见同处** |
| L10 | 自定义有效期 | `ShareCreateWizard.vue:413-418` + `ShareDialog.vue:124-129` **待改** | `durationSeconds` | `mail-share-service.js:338-342` 校验(已有) → `expires_at` → 清理任务 → 会话配额 | 管理员可选超 7 天且受控的有效期 | **阻塞:上限值 / 续期范围 / TTL 联动未裁决(§6)** |
| L11 | 栅栏可观测 | 8 个 `logShareEvent` 调用点 **待改**(补 `requestId`)+ `init.js:127` **待改**(收归 SSOT) | 带 `requestId` 的标准事件 | **Cloudflare 告警规则**(仓库外 · 待运维建) | 发布异常被及时发现 | 缺口:`requestId` 恒 null;`invalid_row` 字段形状不同会被规则整类漏掉 |
| L12 | 栅栏启用 | 运维核验四项前置(§1.6)→ Dashboard | `SHARE_CAPABILITY_V2="true"` | `assertCapabilityV2:81` 的 8 个调用点(已有) | 访问密钥 / 条数上限 / 多邮箱创建解锁 | 值写 `TRUE` **静默失效**;前置未核即开 = 旧 Worker 在途时的策略降级入口 |

**最终 sink**:管理台页面 · 访客页 · D1 `mail_share` 表 · **Cloudflare 告警规则**(L6b / L11 的真实 sink,在仓库外,必须与运维确认到位,否则这两条是死产出)。

**L3 存量混合格式数据的裁决(修写入侧不会自动订正历史行)**:

- **画像门禁(T-10 前置)**:先跑一次只读盘点,**先量化再决定**,不凭感觉。工具已落 `tests/tools/share-timezone-audit.mjs`(默认只读,`--fix` 才写,内置守恒对账)。
  - ⛔ **原判据已被证伪,勿再使用**:本卡初稿写的「`create_time` 与 `expires_at` 差值不等于合法 `durationSeconds` 档位」**不成立** —— 两者来自同一次 `dayjs()` 调用,时区偏移在相减时互相抵消,差值恒等于 `durationSeconds`,与时区无关。
  - ✅ **正确指纹**:`mail_share.create_time` 由 JS 提供,而同一个 `db.batch()` 里插入的 `mail_share_binding.create_time` 落到 SQLite `CURRENT_TIMESTAMP`(恒 UTC),**两者之差即写入进程的 UTC 偏移**,正确行约为 0。
  - **本地库已跑**:1 行有 binding,偏移超阈值 0 行,ACTIVE 受影响 0 行 → 不订正存量。**生产库 `unverified`,需运维用同一命令跑一次再决定。**
- **裁定(按画像结果二选一,不留第三种模糊态)**:
  - 受影响行**全部已过期** → **明确不修存量**,在卡里记「已确认无 ACTIVE 受影响行」,理由是过期行只进清理任务,偏移 8 小时最多让它晚 8 小时被删。
  - 存在 ACTIVE 受影响行 → **一次性 UPDATE 订正**(`expires_at`/`delete_at` 各减去写入时区偏移),同批做守恒对账(订正前后行数一致、无 NULL、时间仍晚于 `create_time`)。
- ⛔ **禁止**「兼容读」这条路——在读取侧按启发式猜某一行是哪种时区,会把一个一次性数据问题变成永久的双语义,正是本轮要消灭的东西。

**真跑一次的 e2e 姿势**(非单测):本地 `wrangler dev` 起 worker,浏览器实操一遍「创建分享 → 管理台看失效时间 → 访客页看倒计时 → 两者比对是否同一时刻 → 关闭对话框后重新取回链接 → 批量为 3 个邮箱各建一条 → 访客页触发验证码」。时区一项因 Windows ICU 忽略 `TZ`(nodejs/node#4230)**无法在本地做 UTC 对照**,必须补一个断言 `dayjs.utc()` 输出格式的单测作为替代证据,并在 Cloudflare 预览环境复验一次。

### 3.2 新增/变更接口契约

| 接口 | 变更 | 入参 | 出参 | 错误码 |
|---|---|---|---|---|
| `POST /mailShare/batchCreate` | **新增** | `accountIds[]`(去重后每个各建一条 · 上限 50)+ 与 create 同款配置字段 + `Idempotency-Key`(子键 `<key>#<accountId>`) | `{created:[{accountId, shareId, lid, sec, shareUrl}], failed:[{accountId, code}]}` | **请求级失败与逐项失败必须分开**,见下 |
| `POST /mailShare/regenerate` | **新增**(语义已存于 `design.md:295-297`,取消 deprecated 即可) | `shareId` + `Idempotency-Key` | `{shareId, lid, sec, shareUrl}` · `sec` 仅首次 | 仅 `effectiveStatus=ACTIVE` 可调;`EXPIRED`/`REVOKED` → `SHARE_NOT_FOUND`。**保持** `expires_at` 与 Visible Window 不变 |
| `POST /mailShare/revealSec`(暂名) | **新增** | `shareId` | `{shareUrl}` | 四类失败分开返回,见 §1.4;**KEK 缺失不得报 500** |
| `POST /share/session` | **变更** | 增 `turnstileToken`,**条件必填**(见下) | 不变 | **新增分享侧专用码**,禁止把 `botVerifyFail` 的 i18n 文案漏给匿名访客 |
| `PUT /mailShare/update` | **待定** | 是否放开 `expiresAt` 续期(`UPDATE_FIELDS:935-944` 白名单外) | — | **§6 前置阻塞决策,先答后做** |

**批量端点的两级失败契约(治「HTTP 恒 200 吞掉非法请求」)**:

| 级别 | 触发 | HTTP | 响应 |
|---|---|---|---|
| **请求级失败** | 未登录 / 无 `share:manage` / `accountIds` 非数组或为空 / 去重后数量 > 50 | 非 200,走既有错误信封 | **不产出任何分享行**,`created`/`failed` 都不返回 |
| **逐项失败** | 单个 `accountId` 越权 / 已删除 / 该项写库失败 | 200 | 该项进 `failed[]`,其余照常进 `created[]` |

**⛔ 幂等判定只在子键层,请求级不对 `accountIds` 集合做指纹冲突判定。** 这是「只重试失败项」能成立的前提:重试时传的是原集合的**子集**,若照搬 create 的「同 key 不同 payload 即冲突」语义,合法重试会 100% 被拒。每个 `<key>#<accountId>` 子键独立判重放——已成功的邮箱走重放路径(返回原 shareId 且不再下发 `sec`),failed 的邮箱正常创建。传全集重试与传子集重试因此等价,前端两种做法都对。

补充规则:`accountIds` **服务端去重**后再计数与创建(前端传重复不报错,但不重复建)。

**Turnstile 策略契约(单一真源 · 治「前端显示验证码但后端不强制」)**:

| 项 | 契约 |
|---|---|
| 启用判定 | **唯一真源 = 后端 `setting` 表的分享验证码开关**。前端只从 `websiteConfig` 读该开关决定是否渲染;⛔ 前端渲染与否**不构成**后端是否校验的依据 |
| token 必填条件 | 开关开启 **且** `siteKey` 非空 → 必填,缺失即拒。开关关闭 → 忽略传入的 token(不报错) |
| 无 `siteKey` | 视为**未配置完成**,后端不强制、前端不渲染,并记一条配置告警事件。**不得**出现「后端强制但前端拿不到 siteKey」这种把所有访客锁在门外的组合 |
| token 无效 / 过期 | 拒绝 + 分享侧专用错误码,前端提示重新验证并**自动刷新 widget** |
| 上游超时 / Turnstile 不可用 | **fail-open**,放行并记告警事件。理由:分享侧已有 CF 原生限流做硬顶(`share-rate-limit.js`),验证码是叠加的第二层;若 fail-closed,Cloudflare 侧一次抖动就会让**全部合法访客**无法访问已分发出去的链接,损失远大于短时放宽 |
| 校验插入位置 | API 层 `share-api.js:55`,**不进** `establishSession`(该函数 `:511-538` 有已冻结的顺序契约) |

**幂等红线**:`normalizeCreateBody:192-212` 与 `legacyCompatibleBody:228-246` 的字段顺序是幂等指纹的一部分,仓库已明确标注禁改。批量走**新端点**而非改造 `create`,正是为绕开这条红线。

---

## 🧪 4. 测试边界(TDD Red)

先写失败测试,每条名字即业务场景:

1. `worker 在 UTC+8 进程内创建分享时,expires_at 仍写入 UTC 裸串` —— 覆盖 L3 根因,替代无法在 Windows 做的 TZ 对照实验。
2. `管理台在 UTC+8 浏览器显示的失效时间,与后端 UTC 裸串指向同一时刻` —— 覆盖 L4 生产缺陷。
3. `未配置 SHARE_MAX_DURATION_SECONDS 时,超长 durationSeconds 被拒` —— 覆盖 I-2,当前会通过(说明缺陷存在)。
4. `批量为 3 个邮箱创建,其中 1 个越权:另 2 个成功建成且 lid 互不相同,越权项进 failed[] 且该邮箱零残留` —— 覆盖 I-3 逐项部分成功。
4b. `批量部分失败后带同一 Idempotency-Key 重试:已成功的邮箱走重放不再下发 sec 也不新建行,只有 failed 项被真正创建` —— 覆盖子键幂等,这是「重试不产生重复链接」的唯一保障。
4c. `KEK 未配置时创建分享:请求被明确拒绝,不产出任何分享行` —— 覆盖 §1.4 创建阶段 fail-closed。
5. `KEK 缺失时读取:查看链接端点返回「服务配置异常」并产出告警事件,既不是 500 也不是「存量不可恢复」` —— 覆盖 §1.4 读取阶段契约。⚠️ 与 4c(创建阶段直接拒绝)是**两条不同断言**,不得合并。
6. `V2 栅栏关闭时,启用访问密钥的错误提示可与配置越域区分` —— 覆盖 E 项可辨识性。

**边界用例(≥3)**:① 批量 50 个邮箱(`SHARE_BINDING_LIMIT` 上限)撞 D1 单语句 100 绑定参数上限(`mail-share-service.js:299-302` 注释已警告)② 并发双击批量创建(幂等键重放)③ 有效期设 10 年时 `delete_at = 到期 + 保留期` 的清理任务与 `idx_mail_share_delete_at` 索引行为。

**会打红的存量用例(需同批处理,不得静默改绿)**:`mail-worker/test/mail-share-service.spec.js:306-315`、`test/share-api.spec.js:498`(有效期上限断言),以及断言「库中仅 hash / 明文恰一次」的用例(清单待 §1.4 回填)。

---

## 🛡️ 5. 防腐层与注册检查

- **Turnstile 校验插入位置**:放 API 层 `share-api.js:55`,**不进** `share-auth-service.establishSession`。理由:该函数 `:511-538` 有已冻结的顺序契约(AuthKey 必须先于重放查询),插入校验会污染它。
- **权限双表**:新端点必须同步 `security.js:73-81` 与 `:112-121` 两处,该文件 `:109-111` 注释明确警告漏改后果。
- **限流注册**:`POST /mailShare/create` 当前**零限流**,批量落地会放大滥用面,同批补上。
- **频率配置的双源矛盾**:CF binding 的 `limit`/`period` 运行时不可读不可改。**采用 R1 保守方案**——CF binding 保持速率的唯一真源(改数值走 5 个 toml + 重新部署),后台只做「验证码开关」这一个可配项。理由:R2 的分层语义需要在文档里写死「binding=硬顶 / DB=验证码阈值」才不被后人误读,而 R2 的计数器又要走 KV/D1——正是 `share-rate-limit.js:5-7` 当初否决过的路。**不为一个可热配的数字制造第二个真源。**
- **i18n**:新增有效期档位、批量 UI、验证码提示、「查看链接」入口的中英文案。
- **配置注册(唯一清单 · 本轮所有环境变量在此收口 · 新增能力不得另起清单)**:

  | 变量 | 类型 | 本地 | 预览/生产 | 缺失后果 | 部署验收 |
  |---|---|---|---|---|---|
  | `SHARE_SEC_PEPPER` | secret | `.dev.vars` | `wrangler secret put` | 创建分享抛裸 `Error` → 500 | 创建一条分享成功 |
  | `SHARE_SESSION_SIGNING_KEY` | secret | `.dev.vars` | `wrangler secret put` | 访客建会话 `SHARE_UNAVAILABLE` | 访客页能打开 |
  | `SHARE_SEC_PEPPER_KID` | var | 可选,默认 `v1` | 可选 | 无(有默认) | — |
  | **`SHARE_SEC_KEK`** | **secret · 本轮新增** | `.dev.vars` | `wrangler secret put` · ⛔**禁止落 `setting` 表** | **创建分享被拒**(非静默降级) | 不配时创建被拒;配了则新建分享详情页能看到链接 |
  | **`SHARE_SEC_KEK_<kid>`** | **secret · 轮换期并存** | 同上 | 同上 | 旧 kid 行不可解 → 降级「可重新生成」 | 跨 kid 行均可查看 |
  | **`SHARE_SEC_KEK_KID`** | **var · 本轮新增** | 默认 `v1` | 显式配置 | 轮换无法前滚 | 与新写入行的 `kek_kid` 一致 |

  **KEK 材料格式与多键协议**(单个变量无法支撑「新旧并存轮换」,故在此定死):
  - **材料格式**:base64url 编码的 **32 字节随机串**(生成:`openssl rand -base64 32` 或等价 CSPRNG)。⛔ 不接受口令短语——`collectKeyedSecrets` 环里存的是密钥材料不是密码。
  - **KDF**:HKDF-SHA256,`info` 固定为 `"share-sec-kek"` 字符串常量,`salt` 用 kid,派生出 AES-256-GCM key。同一 KEK 材料在任何环境派生出的 key 必须一致(否则跨环境导数据即全部解不开)。
  - **多键协议**:当前键读 `SHARE_SEC_KEK`,其 kid 由 `SHARE_SEC_KEK_KID` 指定;历史键按 `SHARE_SEC_KEK_<kid>` 命名逐个注册进环。**kid 的单一真源 = 数据行上的 `kek_kid` 列**,环只负责按 kid 提供材料;⛔ 不得反过来用环的顺序或变量名推断某行该用哪个键。
  | `SHARE_MAX_DURATION_SECONDS` | var · 本轮显式化 | `.dev.vars` | `wrangler.toml` | **无上限**(当前生产即此状态) | 超上限创建被拒 |
  | `SHARE_CAPABILITY_V2` | var | `.dev.vars` = `"true"` | Dashboard,⛔ 不取消 toml 注释 · 值只能 `true`/`1` | 四类策略写入被拒 | 启用访问密钥成功 |

  **KEK 轮换顺序**(与 pepper 同构,不发明新流程):加新 KEK 进环 → 新写入用新 kid → 旧行按旧 kid 继续可解 → 确认无旧 kid 行后退环。⛔ **禁止**先退旧键再加新键。

  **旧 kid 行的退出机制(治「无法执行『确认无旧 kid 行』这个停止条件」)**:
  - **不做批量重加密**。分享是**有到期时间的短生命周期对象**,旧 kid 行会随 `delete_at` 自然消失,为它写一个重加密任务是为不存在的场景加基础设施。
  - **退环停止条件(可执行)**:`SELECT COUNT(*) FROM mail_share WHERE kek_kid = '<旧kid>' AND delete_at > now()` 返回 0。这条查询就是判据,不靠估算。
  - **紧急轮换(KEK 疑似泄露,等不到自然过期)**:直接退环,受影响行按「未知 kid」降级为「不可恢复,可重新生成」并记事件。**安全事件下宁可让管理员重新生成,也不为保住可查看性而留着已泄露的密钥。**
  - **用户影响**:轮换期间跨 kid 的行照常可查看(环内多键);退环后旧行的「查看链接」变为「可重新生成」,分享本身**继续有效不受影响**——退环只影响 Owner 能否回看,不影响访客能否访问。

  **缺失检测**:启动或首次使用时,KEK 缺失必须产出一条**告警级**事件(§1.4 四类失败表),⛔ 不得长期以「存量不可恢复」的正常降级掩盖配置遗漏。

  5 个 wrangler 文件的一致性由单一工作包(T-11)收口。

---

## 6. ⛔ T-22 前置阻塞决策(R1 评审 F3 采纳 · 从「不阻塞」上调)

**上调理由**:这三项不是实现参数,而是决定「突破 7 天」是否真实可用的产品约束。不裁决就写不出校验值、定不了 `UPDATE_FIELDS` 白名单、也无法判断长有效期会不会因配额提前耗尽而形同虚设。**T-22 开工前必须有答案。**

1. ~~最大有效期取值~~ → **已在 §1.5 I-2 裁定:代码内置兜底 90 天**,不再是待裁决项。此处仅剩执行细节:测试基线 `86400` 的多处夹具(§侦察表 #9~#12)是否同步上调,由 T-22 执行者按测试意图决定,不需用户裁决。
2. ~~续期是否在本轮~~ → **已裁决(2026-08-25 用户):纳入本轮。** `expiresAt` 加入 `UPDATE_FIELDS:935-944` 白名单,管理员可直接为快到期的分享延期,**`lid`/`sec` 不变、已在看的访客不受影响**。约束:延期后的新到期时间同样受 I-2 兜底上限约束(从**创建时刻**起算,不是从延期时刻起算,否则可无限续成永久分享);`delete_at` 同步顺延;仅 `effectiveStatus=ACTIVE` 可延期,EXPIRED/REVOKED 拒绝(与 regenerate 同一状态门)。
3. ~~长有效期下的配额语义~~ → **已裁决(2026-08-25 用户):把自动重建排除出配额计数。** `maxSessions` 从此只统计「真人新打开一次链接」,这才符合管理员对「最多允许几个人看」的直觉。
   - **实现要点**:`consumeSessionQuota`(`share-auth-service.js:430-442`)当前在每次 `establishSession` 都 `access_count+1`。需区分**首次建立**与**TTL 到期后的自动续期重建**——后者不计数。判据由执行者按现有代码结构定(候选:会话 token 携带原始 `iat` 或首建标记,续期时透传),但必须保证**不可被访客伪造成永远不计数**。
   - `SHARE_SESSION_TTL` **保持 900 秒不动**,不上调——避免放大档案 `share-session-ttl-limitation` 记录的同标签页 sessionStorage 残留窗口。

---

## 7. 工作包拆分与文件所有权(2026-08-25 · 用户裁定拆卡后开工)

**拆分理由**:三轮评审 P0 未收敛,根因是单卡跨节一致性维护成本超过价值密度(见 Update Log 终止判定)。拆开后每包只维护自身一致性,跨节不一致从结构上消失。

**文件所有权矩阵(同一文件同一时刻只允许一个包持有 · 防并行冲突)**:

| 包 | 范围 | 独占文件 | 依赖 | 可否立即开工 |
|---|---|---|---|---|
| **W-A · 时区** | 后端三处 `dayjs()` → `dayjs.utc()` + 管理台三处接 `tzDayjs` + 存量画像门禁 | `mail-share-service.js`(仅时间行)· `share-auth-service.js:44` · `mail-share-cleanup-service.js` · `share-admin/index.vue` · `ShareDetailDrawer.vue` · `ShareDialog.vue`(仅时间行) | 无 | ✅ **立即** |
| **W-B · 配置与安全** | `.gitignore` 补 `.dev.vars`(P0)+ 5 项环境变量注释 + README 部署指引 + `secret put` 指引 | `.gitignore` · `wrangler*.toml`(5 个)· `README*.md` | 无 · **完全不碰 `.js`,故可与 W-A 真并行** | ✅ **立即** |
| **W-C · 可观测与错误码** | 8 个 `logShareEvent` 补 `requestId` + `init.js:127` 收归 SSOT + 栅栏错误码拆出 `SHARE_CAPABILITY_NOT_ENABLED` | `mail-share-service.js`(日志行与错误码行)· `init.js` | **等 W-A 交出 `mail-share-service.js`** | ⏸ W-A 后 |
| **W-D · 凭据双轨** | regenerate(轨二)+ 可逆加密(轨一)+ 解密端点 + 详情页入口 + 安全护栏测试 | `mail-share-service.js` · `share-auth-service.js` · 新增 entity 列 · `ShareDetailDrawer.vue` | **需 ADR 先落 Proposed**;等 W-C 交出文件 | ⏸ ADR 后 |
| **W-E · 批量与有效期** | `batchCreate` 端点 + 权限双表 + 向导批量 UI + 自定义有效期 + I-2 兜底上限 + **续期(`expiresAt` 进白名单)** + **配额排除自动重建** | `security.js` · `mail-share-api.js` · `ShareCreateWizard.vue` · `request/share.js` · **`ShareDialog.vue`(有效期档位)** | §6 前置决策**已于 2026-08-25 全部裁决**;⚠️ **须等 W-A 交出 `ShareDialog.vue` 与 `share-auth-service.js`**(配额计数在后者) | ⏸ W-A 后 |
| **W-F · 栅栏启用** | 四项前置运维核实 + Dashboard 开启 + e2e | 无代码 · 运维动作 | 需 W-C 完成(告警可用性是第 4 项前置) | ⏸ 最后 |

**并行策略**:W-A ‖ W-B 立即并行(零文件交集)→ W-C → W-D(需 ADR)‖ W-E(需前置决策)→ W-F 收口。

## 任务清单

> 未勾选 = 未完成。每项完成需就地补 `**Evidence**`(commit / verify 命令+EXIT / files / AC)+ 追加 Update Log。

### 阶段 0 · 开工前(阻塞后续)
- [x] T-00 `.gitignore` 补 `.dev.vars`(P0 安全)
  - **Evidence**:`commit 0733b6b` · `verify: git check-ignore -v mail-worker/.dev.vars → .gitignore:33:.dev.vars EXIT=0`(修复前 EXIT=1)· `files: .gitignore:28-34 · mail-worker/.dev.vars.example(新建)` · `AC: 决策卡 §1.2 A 项负向条件「密钥被 commit 进仓库」`
  - **Update Log**:2026-08-25 · 规则含 `!.dev.vars.example` 例外以保留模板;同 diff 内的 `.ace-tool/` 一行非本轮产物,已在 commit message 中标注。
- [ ] T-01 栅栏四项激活前置逐项核实(§1.6 四条运维命令),缺项则停下报告 · **零项可从代码判定,必须真跑命令,禁止推定已满足**
- [ ] T-03 告警可用性缺口(第 4 项前置的代码侧障碍):8 个 `logShareEvent` 调用点补传 `requestId` + `init.js:127` 的 `share.migrate.invalid_row` 收归 SSOT
- [x] T-02 `ADR-share-credential-recoverability.md` 落 Proposed
  - **Evidence**:`commit pending` · `verify: 人工核对 ADR 六段结构与仓库现有 ADR 一致 + 被取代 ADR 已留反向指针` · `files: docs/architecture/ADR-share-credential-recoverability.md(新建) · docs/architecture/ADR-mail-share-capability-boundary.md:37(追加取代指针)` · `AC: 决策卡 §1.7 ADR 准入`
  - **Update Log**:2026-08-25 · 记录了推翻 `requirements.md:75`「`sec` 不可再次读取是安全不变量」的理由与代价;写明**轨二不可撤销、轨一可撤销**,这是两轨先后顺序的依据;补了实现期停止条件(KEK 无法与 D1 分离则轨一停止)。五条替代方案含用户初次裁决时未知的两条硬事实。

### 阶段 1 · 可并行(三条独立轨)
- [x] T-10 时区根因修:后端 3 个 service 改用 `toUtc()` + 管理台 3 处接 `tzDayjs`(同批)+ 存量画像门禁
  - **Evidence**:`commit b717d4f` + `9f7af98`(补漏掉的 `toUtc` import)· `verify: pnpm --dir mail-worker test → 18 files/629 passed/EXIT=0` · `pnpm --dir mail-vue test → 22 files/190 passed/EXIT=0` · `node tests/tools/share-timezone-audit.mjs <本地d1> → 0 受影响行/EXIT=0` · `files: mail-share-service.js:53,289,1142 · share-auth-service.js:46,218 · mail-share-cleanup-service.js:37-38 · share-admin/index.vue:73 · ShareDetailDrawer.vue:49 · ShareDialog.vue:57 · vitest.config.js · share-auth-service.spec.js(functionSource)` · `AC: 决策卡 §1.2 B 项 + 不变量 I-1`
  - **Update Log**:2026-08-25 · 详见 `exec-wa-timezone.md`。三点要记住:① 访客页本来就是对的,生产真正错的是管理台三处零转换 ② 顺带治好两个测试基础设施问题——`Date.prototype` 补丁在 `singleWorker` 单 isolate 下跨文件泄漏(并行 7 败 → 串行 1 败,且串行还更快),以及 `core.autocrlf=true` 让源码文本断言恒假(已证明改动前后同样失败,属既有缺陷)③ **`unverified`**:红证据缺失(代理中断前未留存)、e2e 未真跑、生产库画像未跑。
- [x] T-11 配置文档化:5 个环境变量的 `wrangler.toml` 注释 + README 部署指引 + `secret put` 指引
  - **Evidence**:`commit 0733b6b` · `verify: 见 exec-wb-config.md 的变量名一致性 grep` · `files: mail-worker/wrangler.toml · README.md · README-en.md · mail-worker/.dev.vars.example` · `AC: 决策卡 §1.2 A 项`
  - **Update Log**:2026-08-25 · 含 `SHARE_CAPABILITY_V2` 取值陷阱的显著标注(填 `TRUE`/`True` 会被静默判为关闭)。
- [ ] T-12 分享页 Turnstile 接线(后端专用错误码 + API 层校验 + 前端挂载 + token 传递)

### 阶段 2 · 串行(共享文件)
- [ ] T-20a 轨二 · 重新生成链接:取消 AC-SHARE-13 / AC-LIFE-05 / AC-LIFE-11 的 deprecated 标记,按 `design.md:295-297` 既有语义实现(仅 ACTIVE · 保持 `expires_at` 与 Visible Window · `cv+1` 踢在途会话 · EXPIRED/REVOKED 拒绝)· **同批完成权限双表注册 + 限流 + UI 二次确认(踢访客是用户可见副作用)** · 存量分享唯一出路,先于 T-20b
- [ ] T-20b 轨一 · `sec` 可逆加密存储 + 解密端点(限流 + 审计)+ 管理台详情页链接展示(新分享显示链接 / 老分享显示「可重新生成」)· 复用 `collectKeyedSecrets` 加 `kek_kid` 环
- [ ] T-20c 安全护栏补齐:现有明文子串扫描守卫对密文无效,新增「解密端点鉴权 / KEK 缺失 fail-closed / AuthKey 仍不可恢复」三条断言
- [ ] T-21 批量创建端点 + 权限双表 + 向导批量 UI + create 限流补齐
- [ ] T-22 自定义有效期(两处下拉 P-03 同改)+ `SHARE_MAX_DURATION_SECONDS` 显式化 + 测试夹具

### 阶段 3 · 收口
- [ ] T-30 栅栏开启 + e2e 真跑一遍 + 存量打红用例处理。**e2e 必含**:存量分享重新生成 / 批量部分失败后只重试失败项 / 无权限调解密端点 / 未知 kid / Turnstile 上游故障 / 告警真的触达
- [ ] T-31 `design.md` 补三条模型语义(限流分层 / 批量逐项幂等 / 有效期上限)+ ADR 翻 Accepted
- [ ] T-32 与运维确认 L6b / L11 的告警规则真实落地(**仓库外 sink**,不确认则这两条是死产出)

## Update Log

- 2026-08-25 · 决策卡初稿。6 路侦察输入,九成计划假设被现实推翻;三项方向由用户裁决(栅栏开启 / 可逆存储 / 批量语义 B)。§1.4 与 §1.6 待两路侦察回填。
- 2026-08-25 · §1.4 / §1.6 回填完成。凭据方向经二次确认改为**双轨**(可逆加密覆盖新建 + 重新生成覆盖存量),依据是两条用户初次裁决时未知的事实:存量永远无法回填、重新生成已有过三轮评审的现成设计稿。
- 2026-08-25 · **R1 异构评审**(codex · gpt-5.6-sol · `artifact-decision-card`)→ `NEEDS_CHANGES` · P0=4 · P1=5 · 9/9 锚点校验通过无幻觉。逐条过筛处置:
  - `R1 · A1 链路表不足以证明生产闭环` → **采纳**。§3.1 重建为 Goal→Outcome 五列表,补 L6b(解密审计)/ L7(重新生成)/ L11(告警可观测)三条缺失链路;修正把存储列与验证命令误写成 consumer 的两处。
  - `R1 · A2 批量事务语义自相矛盾` → **采纳**(本卡自身缺陷)。裁定为**逐项部分成功**:原子性边界 = 单个邮箱,幂等子键 `<key>#<accountId>`,前端须支持只重试失败项。作废原「整批零残留」表述。
  - `R1 · A3 AES-GCM 缺存储契约` → **采纳**。§1.4 补版本化 envelope / 独立 CSPRNG nonce(明令禁止派生)/ AAD 绑 shareId / kid 查找与轮换规则 / 四类失败分类表。
  - `R1 · A4 KEK 未进配置注册闭环` → **采纳**。§5 改为唯一配置清单表,纳入 `SHARE_SEC_KEK` / `SHARE_SEC_KEK_KID` 的本地与生产注册方式、轮换顺序、缺失告警、部署验收。
  - `R1 · F1 成功状态缺来源映射` → **精简采纳**。§1.2 表补「谁·在什么操作中·得到什么结果(负向条件)」与「来源类型」两列;未按模板为八项各写五段式(决策卡不是 spec,过度形式化本身是 over-engineering)。
  - `R1 · F2 Turnstile 启用与失败语义未定义` → **采纳**。§3.2 补策略契约表:唯一启用真源在后端、token 条件必填、无 siteKey 组合防呆、上游故障**fail-open**(理由:CF 限流已是硬顶,fail-closed 会因一次抖动锁死全部合法访客)。
  - `R1 · F3 有效期三项被标不阻塞` → **采纳**。§6 从「不阻塞」上调为 **T-22 前置阻塞决策**,并把配额语义细化为三个可选项。
  - `R1 · F4 缺替代方案比较(Solution-Jumping)` → **改法不同后采纳**。评审要求「补比较」,但比较其实已在 6 路侦察中发生、只是没落进卡里;故新增 §1.3.1 **记录已发生的取舍**(凭据三档 / 批量三档 + 各自停止条件),而不是重开一轮比较。
  - `R1 · F5 E 项缺真实业务影响` → **采纳且不删**。评审提示「答不出则删」——答得出:三种语义共用一个错误码,管理员无法分辨「能力未开放」与「自己配置写错」,**真实损失本轮已发生**(用户本人误判为 bug 并耗时排查)。已补角色/操作/负向条件。
  - **驳回:0 条**。本轮评审锚点全中、无 over-engineering 建议,不存在需要 `rejected` 的意见。
- 2026-08-25 · **R2 异构评审** → `NEEDS_CHANGES` · P0=3 · P1=5。三个 P0 **全部是 R1 修订自身引入的不一致**(改了正文没改测试 / 新不变量与旧实现冲突 / 降级策略只覆盖了一半阶段),说明 R1 的修订面没有闭合。处置:
  - `R2 · A1 批量测试项仍要求整批原子` → **采纳**。§4 测试项 4 改为逐项部分成功,并补 4b(子键幂等重试)与 4c(创建阶段 KEK 缺失)。这是我改 I-3 时漏改测试边界造成的自相矛盾。
  - `R2 · A2 有效期上限缺失即无上限,违反同一安全不变量` → **采纳**。I-2 改为**代码内置兜底 90 天**,`SHARE_MAX_DURATION_SECONDS` 缺失时取兜底值而非退化为无上限。这样「必须显式配置」降级为运维最佳实践,与「缺失不设防」的矛盾从根上消失。
  - `R2 · A3 KEK 缺失未区分创建阶段与读取阶段` → **采纳**(本轮最有价值的一条)。原表述只定义了读取降级,意味着 KEK 缺失时**创建仍会成功**,产出一批要等管理员几天后点详情页才发现无法恢复的分享。改为创建阶段 fail-closed 直接拒绝,读取阶段降级并告警,两阶段都必须告警。
  - `R2 · F1 Turnstile 相对既有限流的增量价值未证明` → **采纳**。§1.2 F 项补出限流拿不到的两个维度:分布式低频猜测(每 IP 每分钟 1 次永不触发 10/60s 阈值)与已知 `lid` 后对 `sec` 的慢速枚举。
  - `R2 · F2 HTTP 恒 200 吞掉非法请求` → **采纳内容,自行定位**。脚本报该条锚点 `anchor_not_unique`(hits=3),按 skill 规则不 blind-apply,但意见实质成立:未登录 / 超上限 / 幂等键冲突属请求级失败,不该混进 `failed[]` 返回 200。§3.2 新增两级失败契约表 + 服务端去重规则。
  - `R2 · F3 E 项未贯通到稳定错误码` → **采纳**。补交付契约:栅栏路径改抛 `SHARE_CAPABILITY_NOT_ENABLED`,`SHARE_INVALID_CONFIG` 收窄为真正的配置越域,归 T-03 同批,e2e 覆盖。
  - `R2 · F4 存量混合格式数据未裁决` → **采纳**。§3.1 补画像门禁(先量化 ACTIVE 受影响行)+ 二选一裁定(全过期则明确不修 / 有 ACTIVE 则一次性订正带守恒对账),并**明令禁止「兼容读」**——那会把一次性数据问题变成永久双语义。
  - `R2 · F5 旧 kid 行退环停止条件不可执行` → **采纳**。§5 补:不做批量重加密(分享是短生命周期对象,会随 `delete_at` 自然消失),退环判据是一条可执行的 COUNT 查询;紧急轮换直接退环并降级,不为保住可查看性留已泄露密钥。
- 2026-08-25 · **R3 异构评审** → `NEEDS_CHANGES` · P0=5 · P1=7。**P0 轨迹 4 → 3 → 5,未收敛。** 逐条核实后判定:五条**全部是真缺陷,且全部由前两轮修订自身引入**(非评审挑刺)。已全部修复:
  - `R3 · A1 子键幂等与「同 key 不同 payload 冲突」不可兼容` → **采纳**。这是本轮最严重的自相矛盾:我定了子键幂等以支持「只重试失败项」,却又照搬 create 的集合指纹冲突判定,导致合法重试 100% 被拒。已删除请求级集合指纹判定,明确幂等只在子键层,传全集或子集重试等价。
  - `R3 · A2 测试项 5 仍写旧的 KEK 降级语义` → **采纳**。与 R2·A1 同类错误(改正文漏改测试),已改为读取阶段契约并显式标注与 4c 创建阶段是两条不同断言。
  - `R3 · A3 单 KEK 变量无法实现新旧并存轮换` → **采纳**。§5 补 KEK 材料格式(base64url 32 字节)、KDF 参数(HKDF-SHA256 + 固定 info + kid 作 salt)、多键命名协议(`SHARE_SEC_KEK_<kid>`),并定死 kid 单一真源 = 数据行上的 `kek_kid` 列。
  - `R3 · A4 regenerate 的新 sec 未接入加密存储` → **采纳**。链路断裂:若不接,重新生成出来的链接又退回一次性,双轨自相矛盾。L7 已明确新 `sec` 走同一加密写入,且 KEK 缺失时与 create 同样 fail-closed。
  - `R3 · A5 90 天既已裁定又列为待裁决` → **采纳**。§6 第 1 项已划掉并指向 §1.5 I-2 的裁定,只保留执行细节。
  - **未跑第四轮复审。** 判定依据见下条。
- 2026-08-25 · **评审循环终止判定(§0.13 行动阈值 · skill「round 3 仍有 P0 → 停,不硬凑」)**:P0 轨迹 4→3→5 呈现的不是设计缺陷密度,而是**单张决策卡的一致性维护成本已超过其价值密度**——本卡承载 8 项交付、13 条链路、4 个不变量、7 个环境变量,任改一处需同步 4-6 处,而评审每轮都在这份持续变大的文档里稳定地找出新的跨节不一致。这与 `spec-cross-review` skill 记载的 release-orchestration-wiring 病症(7 轮 p0 无一为 0,后几轮多为文档自指不一致)同形。**处置:停止在单卡上循环评审,改为按独立轨拆分后各自开工**——拆开后每个工作包只需维护自身一致性,跨节不一致这一类问题从结构上消失。三个 P0 密集区(凭据加密协议 / 批量幂等 / 有效期与配额)各自独立,天然可拆。
