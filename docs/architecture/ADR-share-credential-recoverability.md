# ADR: 分享凭据 `sec` 的可恢复性(部分取代「明文恰一次」不变量)

## Status

Proposed

> 本 ADR 部分取代 `docs/specs/mail-share/requirements.md:75` 记载的原裁决(「`sec` 不可再次读取是安全不变量,`sec` 丢失即丢失」)。
> 取代范围**仅限 `sec`**;AuthKey 的「明文恰一次」(AC-CAP-05)**不受影响,继续有效**。
> 实现完成并稳定运行前保持 Proposed,验收后转 Accepted。

## Context

### 原决策与它当时成立的理由

2026-08-16/17 的 R1–R3 裁决确立了一条安全不变量:`sec` 只以 `HMAC-SHA256(sec, PEPPER[kid])` 落库,明文只在创建响应中出现一次,此后不存在于任何存储。配套条款:

| 条款 | 出处 | 内容 |
|---|---|---|
| AC-CAP-04 | `mailbox-share-capability/requirements.md:58` | 「**只以**」摘要形式存储 |
| AC-SHARE-04 | `mail-share/requirements.md:61` | 不得存储「或**可据以重建** `sec` 的数据」 |
| 幂等语义 | `mail-share/requirements.md:75` | 定位为重复操作检测,**不是**可恢复幂等;重放不得重复下发 `sec` |
| `regenerate` | 同上 · `design.md:295-297` | 本期不做,语义保留为后续约定;泄露场景用 revoke + create 替代 |

这条不变量的价值是真实的:**在当前实现下,即便攻击者拿到整个 D1 数据库加 pepper,也还原不出任何一条 `sec`**(HMAC 单向、2^256 空间)。明文不是「藏得好」,是根本不存在。

### 促使重新裁决的业务事实

Owner 在管理台创建分享后,链接明文只在创建成功那一刻的对话框里出现;点「我已保存」或关闭对话框即置空(`ShareCreateWizard.vue:553-558`、`:582-584`),此后**管理台任何位置都无法再看到已创建分享的链接**——详情抽屉、行操作、列表页均无入口。

用户(项目所有者)在 2026-08-25 明确要求:「在前端点击查看详情,可以看到这个邮箱当初创建的分享链接是哪个」「不需要像 key 那样只展示一次」。

这不是「链接被前端藏起来了」——侦察核实链接**从未被掩码**,复制按钮也一直存在(`ShareCreateWizard.vue:35-49`)。痛点精确地是:**明文在响应之后就不存在了**。

### 两条约束住方案空间的硬事实

1. **存量分享永远无法回填。** 任何加密存储方案上线前创建的分享,其 `sec` 明文已不存在于世界任何地方。加密列只能对**新建**分享生效。因此「让 Owner 重新拿到一条可用链接」的能力在任何路径下都是必需的,不是可选项。
2. **`regenerate` 的完整语义已存在且经过三轮评审**,只是被标记停用:`design.md:295-297` 正文完整,AC-SHARE-13 / AC-LIFE-05 / AC-LIFE-11 是 `{status: deprecated, by: R3-regenerate}`,**一字未删**。启用它的成本是取消标记,零新增列、零新增密钥、零安全回归。

## Decision

**采用双轨,`sec` 的可恢复性仅对新建分享放宽,AuthKey 完全不变。**

### 轨二 · 重新生成(覆盖存量与泄露场景 · 先行)

启用 `POST /mailShare/regenerate`,取消上述三条 AC 的 deprecated 标记,按 `design.md:295-297` 既有语义实现:仅 `effectiveStatus=ACTIVE` 可调;原子更新 `lid` 与凭据;**保持** `expires_at` 与 `window_start_email_id` 不变;`credentials_version + 1` 使在途访客会话立即失效;`EXPIRED`/`REVOKED` 拒绝,须新建授权。

### 轨一 · 可逆加密存储(仅覆盖上线后新建的分享)

新增密文列存储 `sec`,Owner 鉴权后可经专用端点解密取回完整链接。

**持久化协议**(选算法不等于定协议,以下为不可放宽的契约):

| 项 | 契约 |
|---|---|
| 算法 | AES-256-GCM,密钥经 HKDF-SHA256 从 KEK 材料派生(`info` 固定常量 `"share-sec-kek"`,`salt` 用 kid) |
| KEK 材料 | 运维按 **base64url 编码的 32 字节 CSPRNG 输出**生成(`openssl rand -base64 32` 或等价);⛔ 不接受口令短语。**实现侧把配置字符串的 UTF-8 字节原样作为 HKDF 的 IKM,不做 base64 解码** —— HKDF-Extract 本就接受任意长度 IKM,熵不受影响,而跳过解码消除了唯一一个「两个环境对同一份密钥各自解码、静默派生出不同密钥」的分歧点(`openssl rand -base64` 用标准字母表 `+/`,base64url 用 `-_`,解码器选错不会报错只会解出别的字节)。⚠️ **此决定在有生产密文之后不可更改** —— 改了旧密文就解不开。 |
| envelope | 版本化 `v1:<kek_kid>:<base64url(nonce)>:<base64url(ciphertext‖tag)>`,版本号在最前 |
| nonce | 每次加密独立 CSPRNG 生成 96-bit。⛔ **绝不由 shareId / 计数器 / 时间戳派生**——GCM 下 nonce 重用即机密性崩塌 |
| AAD | 绑定 **`lid`**(本 ADR 初稿写的是 `shareId`,**实现时改绑 `lid`,已采纳**)。理由:`share_id` 是 `autoIncrement` 主键,INSERT 之后才存在,绑它就只能「先插行、再 UPDATE 补密文」——那个中间态里的行密文为空,**与真正的存量旧行完全同形**,解密方无法分辨「上线前创建」与「刚写了一半」。`lid` 有 `UNIQUE` 索引(`idx_mail_share_lid`)、与 `sec` 同一次铸造并在同一条 INSERT 里落库,阻断「密文被搬到另一行」的性质不变,且额外获得:regenerate 换 lid 后旧密文自然解不开,而非悄悄交回一个已失效的 `sec`。⚠️ **解密方必须传 `lid`**。 |
| kid 真源 | **密码学真源 = envelope 内自带的 kid**;数据行上的 `kek_kid` 列是它的**可查询镜像**(供运维统计"还有多少行用旧键")。本 ADR 初稿把列写成真源,与实现不符 —— 解密必须从 envelope 取 kid,否则密文就不是自描述的、换个列值就解不开。两者由同一次加密的返回值原子写入,不会分叉。密钥环只负责按 kid 提供材料;⛔ 不得反向用环顺序或变量名推断某行该用哪个键 |
| KEK 存放 | `wrangler secret`,⛔ **禁止落 `setting` 表**(与 Turnstile secret 的存法不同,后者不是加密密钥) |
| 轮换 | 复用 `collectKeyedSecrets`(`share-auth-service.js:124`)。⚠️ **本 ADR 初稿把它写成「泛型 kid 环,加第三个环即可」,该描述有误** —— 它的签名是 `(currentKid, currentValue, prevKid, prevValue)`,是固定的 **current + prev 双键**结构,不支持任意多键。KEK 因此沿用与 pepper / 签名密钥完全相同的四变量命名:`SHARE_SEC_KEK` / `SHARE_SEC_KEK_KID` / `SHARE_SEC_KEK_PREV` / `SHARE_SEC_KEK_PREV_KID`(见 `share-auth-service.js:153-167` 的既有用法)。双键足以覆盖轮换期新旧并存,**不要为 KEK 单独扩展成多键**——那会让三种密钥的管理方式分叉。 |

**四类失败必须分开**,不得折叠成同一句「不可恢复」——否则部署事故与数据损坏会被伪装成正常降级:

| 情形 | 判据 | 对 Owner | 告警 |
|---|---|---|---|
| 旧记录无密文 | 密文列 NULL | 「创建于功能上线前,不可恢复,可重新生成」 | 否(正常) |
| KEK 暂缺 | 环内无任何键 | 「服务配置异常」 | **是**(部署事故) |
| 未知 kid | 行上 kid 不在环内 | 「密钥已轮换退环,可重新生成」 | 记事件 |
| 认证失败 | GCM tag 校验不通过 | 「凭据数据异常」 | **是**(数据完整性事故) |

**KEK 缺失分创建与读取两个阶段**:创建阶段 **fail-closed 直接拒绝**(⛔ 绝不允许「创建成功但没加密」——那会静默产出一批要等几天后点详情页才发现无法恢复的分享);读取阶段降级并告警,不报 500。

### 不纳入本决策的

- **AuthKey 保持不可恢复**。AC-CAP-05 一字不改。用户明确认可访问密钥「只展示一次」的现有行为。
- **不做批量重加密**。分享是有到期时间的短生命周期对象,旧 kid 行随 `delete_at` 自然消失;退环判据是一条可执行查询(`kek_kid = '<旧kid>' AND delete_at > now()` 计数为 0),不为不存在的场景加基础设施。

## Consequences

### 正面

- Owner 在详情页随时取回并复制新建分享的完整链接,不再依赖创建那一刻是否手快保存。
- 存量分享与泄露场景有了明确出路(`regenerate`),这条能力此前完全缺失——`sec` 一丢只能 revoke + create,连带作废已分发的链接。
- 加密与轮换复用既有 kid 环设施,不引入第二套密钥管理机制。

### 代价

- **凭据保护等级下降,这是本决策交出去的核心性质。** 变更前:拿到全库加 pepper 也还原不出任何 `sec`。变更后:**同时拿到 D1 与 KEK,即可离线批量还原上线后所有分享链接**。这一条已向用户明确陈述两次并获确认。
- **从零新建加解密能力。** 全仓 6 处 `crypto.subtle` 全是摘要或 HMAC 签名(`crypto-utils.js:20`、`jwt-utils.js:35-64`、`share-auth-service.js:102-116`),无一处 encrypt/decrypt。
- **现有安全护栏对本变更自动让路。** 所有守卫(含 `share-integration.spec.js:248-267` 的全库扫描)都是**明文子串扫描,密文照过**——加密方案上线时不会有任何测试跳出来提醒。必须人工补三条断言:解密端点鉴权、KEK 缺失 fail-closed、AuthKey 仍不可恢复。
- **新增运维密钥** `SHARE_SEC_KEK`(+ 轮换期的 `SHARE_SEC_KEK_<kid>`)。配置遗漏会直接阻断创建(fail-closed),这是有意的——好过静默产出不可恢复的分享。
- 解密端点是新的凭据暴露面,须限流 + 审计(记 who/when/whichShare,不记明文)。

### 撤销门槛

回退到「完全不可恢复」需要:(1) 删除密文列或将其清空;(2) 恢复 AC-CAP-04 / AC-SHARE-04 原文;(3) **保留 `regenerate`** —— 它此后是 Owner 找回链接的唯一手段,删掉它等于回到本 ADR 之前那个真实痛点。
换言之**轨二不可撤销,轨一可撤销**。这也是两轨先后顺序的理由:先交付轨二,即使轨一后来被推翻,能力也不倒退。

### 停止条件(实现期)

若 KEK 在预览环境无法做到与 D1 真正分离(例如受平台限制只能落 `setting` 表),**轨一停止**,退回仅轨二并向用户重新汇报。把加密密钥与密文存在同一个库里,等于没有加密。

## Alternatives considered

### 1. 沿用现状(保持不可恢复)

**拒绝理由**:这正是用户报告的痛点本身。Owner 关掉对话框即永久失去链接,而当前连 `regenerate` 都没有,唯一出路是 revoke + create,连带作废已分发出去的链接。

### 2. 仅做 `regenerate`,不碰存储

**部分采纳为轨二,但不充分。** 它能给出「一条新的可用链接」,回答不了用户的实际诉求「看当初创建的那一条是哪个」。对于已把链接分发给多方的场景,重新生成意味着要重新通知所有人。

### 3. 明文列存储

**拒绝理由**:代价与可逆加密相同(都要 D1 泄露即失守),但少了 KEK 这一层——攻击者只需拿到数据库。加密存储把「拿到库」提高到「同时拿到库与密钥」,成本差异实质。

### 4. 会话内不销毁(仅前端保留)

即不改后端,Owner 关闭对话框后仍能在同一浏览器会话内回看。

**拒绝理由**:刷新页面或换设备即失效,没有解决「事后查看」;且对存量分享完全无效。属于让痛点显得缓解、实际未解决的伪方案。

### 5. 创建时勾选「允许日后查看」(opt-in 加密)

**拒绝理由**:用户明确表达「不需要像 key 那样只展示一次」,即期望默认可见。opt-in 把认知负担推给每次创建操作,而勾选与否的后果(以后能不能看)在勾选那一刻并不显著。若未来需要为高敏分享提供「阅后即焚」语义,可再以显式开关引入,方向相反、不冲突。

## References

- 决策卡:`.agent-workspace/.archive/2026-08-25/share-hardening/share-hardening-decision-card.md` §1.4 / §1.3.1
- 侦察:`.agent-workspace/.archive/2026-08-25/share-hardening/recon-credential-recoverable.md`
- 被部分取代:`docs/specs/mail-share/requirements.md:61,75`、`docs/specs/mailbox-share-capability/requirements.md:58`
- 保留语义来源:`docs/specs/mail-share/design.md:295-297`(后续 regenerate 约定)
- 同构先例:`mail-share-service.js:1331-1370`(`resetAuthKey` 三态迁移 + 条件 UPDATE 守卫)
- 密钥环设施:`share-auth-service.js:118-131`(`collectKeyedSecrets` 泛型 kid 环)
