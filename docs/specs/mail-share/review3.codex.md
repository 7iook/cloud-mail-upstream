> **[主 AI 下一步]** 读完本 review 修完 spec 后:若本轮已收敛(R3 或 APPROVED / p0=0)→ **调 `post-review-introspection` skill** 做「初稿→评审→最终稿」三阶段复盘,落 `introspection-<slug>.md`。仍需 R+1 → 修完 spec 再跑下轮。

---

# 第 3 轮评审结论

## 真实业务边界清单

| 场景 | 严格按当前方案的行为 | 评审结论 |
|---|---|---|
| 单用户、单邮箱、单 Visitor | 创建 capability URL，Visitor 换取 Session 后读取创建点之后的邮件 | 主链路成立 |
| 一个用户管理多个邮箱 | Share 绑定 `user_id + account_id`，查询再绑定 `account_id + window_start_email_id` | 边界方向正确；需核实创建快照与邮件写入的并发顺序 |
| 同一邮箱存在多条 Share | 各 Share 拥有独立 secret、期限、窗口和撤销状态 | 合理；活跃数量限制必须原子执行 |
| 同一链接被多人、多设备访问 | 所有持链者共享同一授权；系统不能识别“真正接收人” | 符合 capability 语义；`access_count` 不能解释为人数或阅读确认 |
| 多用户/多租户 | 文档声明无 Tenant，隔离边界等同于 User | 需负责人确认这是产品事实，而不是当前数据库缺少 Tenant 字段后作出的架构简化 |
| Account 转移所有者 | 转移期间旧 Share 不可用，但记录仍为 `ACTIVE` | 存在转回后旧授权复活风险，必须明确永久撤销还是动态冻结 |
| 创建 Share 时邮件并发到达 | 先取最大 `email_id` 再创建记录；是否同一事务未定义 | “创建前/后”边界可能漂移 |
| 短时间大量来信 | wait 每批最多返回 20 条，可继续用游标追赶 | 可实现，但“同一 cursor 内容不变”与动态数据集矛盾 |
| 多 Visitor 长时间等待 | 每个前台 Visitor 每秒一次 D1 查询，最多持续 25 秒后重连 | 只有单请求预算，没有租户级/全局容量预算 |
| 请求超时、响应丢失 | 创建或 regenerate 成功后若首次响应丢失，重放不返回 `sec` | 已明确为不可恢复重复检测，但会产生有效却不可使用的授权 |
| Worker/服务重启 | Share 和幂等记录落 D1；Session 无状态验签 | 基本可恢复；事务跨表原子性仍未定义 |
| Session 签名密钥轮换 | 有 `kid` 和双 key 窗口 | 基本完整 |
| Share Secret 的 PEPPER 轮换 | `sec_hmac` 没有 `kid` 或旧 PEPPER 验证窗口 | 轮换可能瞬间令全部存量链接失效 |
| 功能开关关闭再开启 | Share 行保持 `ACTIVE`，关闭期间不可访问 | 重新开启后旧链接会恢复，需产品确认 |
| Share 过期或撤销 | 邮件 API 立即拒绝 | 主契约成立 |
| 已取得附件 URL 后 Share 过期 | `/oss/<key>` 仍可永久访问 | 与“临时授权、到期立即不可用”根本冲突 |
| HTML 邮件含追踪像素/远程资源 | 当前要求原样加载 | 发件方可感知 Visitor IP、时间和 User-Agent |
| iframe 自动高度和链接跳转 | iframe 同时禁止脚本、同源和弹窗能力 | 当前契约无法完整实现 |
| Cloudflare 限速触发 | 可能返回边缘 429，也可能要求映射成统一业务错误 | 响应、重试和不可区分性契约未定 |
| 历史数据迁移 | 新 Share 表无历史行；旧邮件只作为窗口下界计算依据 | 无需迁移 Share 数据；需核实旧邮件 `email_id` 的完整性、唯一性及索引 |
| 人工修改数据库/配置 | 未定义状态修复、审计或约束策略 | 不建议首期建设自动修复器，但应明确人工操作禁区和恢复手册 |

---

## 业务现实判决表（反 Solution-Jumping）

| 新建能力、接口或字段 | 真实场景 | 缺失影响 | 是否已有机制覆盖 | 分类与判决 |
|---|---|---|---|---|
| `mail_share.share_id` | Owner 管理一条授权 | 无稳定管理标识 | 无 | **A，必须** |
| `lid + sec_hmac` | 未登录 Visitor 持链访问 | 无法建立资源级授权 | 全局 public token 不适用 | **A，必须** |
| `user_id + account_id` | Owner 只能分享自己的邮箱 | 越权、串邮箱 | 账户归属可部分复用 | **A，必须** |
| `window_start_email_id` | 只允许查看创建后的邮件 | 泄露历史邮件 | 无等价机制 | **A，必须** |
| `status + revoked_at` | Owner 随时关闭链接 | 无法主动止损 | 无 | **A，必须** |
| `expires_at` | 临时授权自动失效 | 授权无限存续 | 无 | **A，必须** |
| `delete_at` 与 CleanupTask | 清理过期安全记录 | 数据持续增长 | 现有清理机制需核实 | **B，可实现但先定保留期** |
| `name` | 区分多个分享对象 | 易误关仍在使用的链接 | 创建时间不足 | **A，必须** |
| `remark` | Owner 记录用途 | 管理便利和误操作风险 | `name` 可部分覆盖 | **A/B，可保留** |
| `access_count` | 判断链接是否建立过 Session | 缺少弱可观测性 | 边缘日志可能覆盖，需核实 | **B，可延后**；不可作为阅读证明 |
| `last_access_at` | 判断最近是否建立过 Session | 缺少弱可观测性 | 日志可能覆盖，需核实 | **B，可延后** |
| `create_time` | 排序和审计 | 无法追踪授权创建时间 | 通用审计字段可能已有 | **A，必须** |
| `share_idempotency` | 写请求超时重试 | 重复创建或反复轮换 | 无可确认的现有机制 | **B，必须但须补原子契约** |
| `POST /mailShare/create` | Owner 创建授权 | 核心业务无法发生 | 无 | **A，必须** |
| `GET /mailShare/list` | Owner 管理已有授权 | 无法发现和撤销遗留链接 | 无 | **A，必须** |
| `DELETE /mailShare/revoke` | Owner 主动止损 | 泄漏后只能等待过期 | 无 | **A，必须** |
| `PUT /mailShare/regenerate` | 链接疑似泄露但授权范围仍需保留 | 只能撤销并重新创建 | revoke + create 可覆盖 | **B，可延后**；不是首期不可缺能力 |
| `POST /share/session` | Secret 只提交一次 | 后续请求需反复携带主 secret | 可直接每次验 sec，但暴露面更大 | **B，合理** |
| `GET /share/mails` | Visitor 查看邮件列表 | 核心业务无法完成 | 无 | **A，必须** |
| `GET /share/mail` | Visitor 查看正文和验证码 | 核心业务无法完成 | 列表若返回完整正文可覆盖但泄漏面更大 | **A，必须** |
| 自动出现新邮件 | 等待验证码时无需手刷 | 用户操作中断、延迟 | 客户端增量轮询可覆盖 | **A，必须** |
| 25 秒服务端长轮询、每秒查 D1 | 实现自动刷新 | 没有它仍可客户端轮询 | 客户端轮询已可覆盖 | **D，不建议直接定稿**；先以容量实测证明必要 |
| 三个独立 `share:*` 权限 | 不同角色分别创建、查询、撤销 | 当前未给出这种角色场景 | 单一 `share:manage` 可覆盖 | **D，不建议实现三份权限**；补角色矩阵或简化 |
| 全局功能开关 | 紧急关闭高风险功能 | 事故时不能快速止损 | 部署回滚可能覆盖但较慢 | **B，建议保留** |
| `SafeMailRenderer` | 安全展示不可信邮件 HTML | 发信人内容可攻击主页面 | 现有渲染路径被文档判定不安全 | **B，必须** |
| 登录态页面同步迁移 Renderer | 消除同一类既有风险 | 登录用户仍暴露 | 单独平台安全任务可覆盖 | **B，可同批但须独立验收** |
| iframe 自动高度 | 改善长邮件阅读 | 仅产生内层滚动体验问题 | 固定高度/用户展开可覆盖 | **D，不建议按当前不可实现方案做** |
| 附件 DTO 与公开 `/oss` URL | Visitor 可能需要邮件附件 | 当前核心 OTP 场景未证明损失 | 邮件正文与验证码已覆盖主目标 | **D，不建议本期实现**；且破坏撤销边界 |
| Cloudflare Rate Limiting | 防自动化滥用 | 资源被批量消耗 | 平台能力正是覆盖机制 | **B，复用平台，不自建 D1 计数** |
| 独立匿名 axios/bootstrap | 防登录态跳转及 token 外泄 | 匿名页面不可用或泄密 | 现有客户端不满足 | **B，必须** |
| `sessionStorage` | 同 tab 刷新恢复 | 刷新后凭据丢失 | 内存存储不能恢复 | **B，合理；须补退出清理与按 lid 隔离** |
| 新索引 | 保证范围查询和轮询性能 | 数据量增长后扫描退化 | 既有索引是否覆盖需核实 | **B，按查询计划决定** |
| CSP/no-store/no-referrer | 防 secret、正文进入外围系统 | 敏感数据扩散 | 无完整现有覆盖 | **B，必须** |
| ADR | 固化授权边界选择 | 后续可能错误复用全局 public token | 决策卡不能完全替代长期边界记录 | **B，合理** |

---

## 当前方案继续实施的风险

### R3-A1 · 附件公开直链破坏临时授权和撤销边界

- **层次：架构级**
- **定位锚点：** requirements.md「`[AC-SEC-18] THE ShareMailService SHALL 在 Visitor 邮件详情 DTO 中返回附件元数据`」
- **问题：** MailShare 到期或撤销只能关闭邮件 API，已下发的 `/oss/<key>` 仍可永久下载。文档一方面将能力定义为“临时授权、销毁后立即不可用”，另一方面明确接受附件不随 Share 失效。
- **问题根因：** 把“现有附件地址已经公开”误当成“向新的匿名 Visitor 再传播一次不会扩大授权面”。旧入口缺陷不等于新功能可以绕过自己的生命周期边界。
- **业务影响：** Owner 点击销毁后仍无法阻止附件访问；敏感附件泄漏无法止损。
- **架构影响：** 同一邮件出现两个授权真源：正文由 MailShare 控制，附件由永久 URL 控制。
- **修改建议：** 本期删除附件能力；若附件确有业务刚需，必须通过 ShareAuthService 下的受控下载端点或短期签名 URL，并确保撤销、过期、账户转移同步生效。
- **优先级：P0**

### R3-A2 · SafeMailRenderer 的沙箱、完整渲染和自动高度契约无法同时成立

- **层次：架构级**
- **定位锚点：** requirements.md「#### 沙箱渲染模型」
- **问题：**
  - iframe 禁止 `allow-scripts`，内部 `ResizeObserver/postMessage` 无法运行。
  - 禁止 `allow-same-origin` 后，父页面不能直接读取 iframe DOM 高度。
  - 未启用对应 sandbox 能力时，`target="_blank"` 链接可能无法打开。
  - 设计页外层 CSP 只允许 `img-src 'self'`，需求又要求远程图片原样加载，策略互相冲突。
  - 远程图片和样式会把 Visitor 的访问时间、IP 等暴露给邮件发送方。
- **问题根因：** 将“脚本绝对禁行”“完整 HTML 原样兼容”“自动高度”“远程资源加载”四个互相制约的目标合并为一个实现。
- **业务影响：** 长邮件可能被截断或出现双滚动；链接失效；追踪像素泄露访问行为。
- **架构影响：** 安全边界依赖浏览器 sandbox/CSP 的精确组合，但文档尚未给出可执行的最终组合。
- **修改建议：** 首期选择脚本禁行优先，接受固定高度/内层滚动；默认阻断远程资源并提供用户显式加载；逐浏览器验证链接行为。不要为了自动高度加入 frame 内脚本。
- **优先级：P1**

### R3-A3 · 长轮询只有单请求成本，没有生产级总容量和退避模型

- **层次：架构级**
- **定位锚点：** requirements.md「#### 读模型契约（A5）」
- **问题：** 文档只证明每个 wait 最多查询 D1 25 次，没有计算并发 Visitor、同链接多设备、客户端重连风暴、Worker 重启、D1 超时及边缘超时下的总请求量。
- **问题根因：** 把“每个请求成本有上限”误当成“系统总成本有上限”。
- **业务影响：** 热门链接或重连风暴可持续制造 D1 查询；超时后客户端若立即重试会放大故障。
- **架构影响：** 关键读路径缺少全局容量基线、客户端退避、抖动和降级策略。
- **修改建议：** 先以更简单的客户端增量轮询作为基线；若保留长轮询，补并发模型、容量公式、超时分类、指数退避+jitter、服务重启与 429/5xx 行为，并用生产规模压测作开工门禁。
- **优先级：P1**

### R3-A4 · 幂等表不足以判断请求等价，跨表写入也没有原子边界

- **层次：架构级**
- **定位锚点：** requirements.md「**幂等与并发语义（A4 · R2-A4 收敛）**」
- **问题：** AC 要求同 Key 仅在请求体等价时重放，但辅助表只列 `response_fingerprint`，没有明确请求指纹；同 Key 不同请求体如何响应未定义。Share 行与幂等行是否同事务写入也未说明。
- **问题根因：** 只收敛了“幂等记录放在哪里”，没有补齐幂等状态机与部分成功语义。
- **业务影响：** 网络超时可能产生孤儿 Share、无对应幂等记录，或不同请求体误取旧结果。
- **架构影响：** 写操作不具备确定的 exactly-once-effect 边界。
- **修改建议：** 明确规范化请求指纹、Key 冲突错误、Share 与幂等行的同事务提交、失败回滚及 24 小时清理顺序；统计字段失败不得影响授权建立。
- **优先级：P1**

### R3-A5 · 边缘 429 与统一 `SHARE_UNAVAILABLE` 契约互相冲突

- **层次：架构级**
- **定位锚点：** requirements.md「### Requirement 9: 滥用防护（本期最小）」
- **问题：** Cloudflare 可在 Worker 前直接返回 429，而 P-AUTH-01、错误注册表又把“限速”纳入统一 `SHARE_UNAVAILABLE`。文档把最终策略延后到实现文档决定。
- **问题根因：** 同时要求平台边缘短路和应用层逐字节统一响应，却没有选择权威错误边界。
- **业务影响：** 客户端不知道应该等待重试还是认为链接永久失效；边缘 HTML/429 可能破坏统一 JSON 解析。
- **架构影响：** API 契约由部署配置偶然决定，不同环境行为可能不同。
- **修改建议：** 在 spec 内固定一种方案。推荐明确 429 + `Retry-After` 为独立的可恢复运输层错误，并将限速从 P-AUTH-01 的不可区分集合移除；客户端按退避策略处理。
- **优先级：P1**

### R3-A6 · Share Secret 的 PEPPER 没有轮换和故障恢复契约

- **层次：架构级**
- **定位锚点：** requirements.md「- **Share Secret (`sec`)**」
- **问题：** Session 签名密钥支持 `kid` 和双 key，但 `sec_hmac` 只依赖单一 `PEPPER`，未记录 key 版本，也未定义旧 key 验证窗口。
- **问题根因：** 只设计了 Session 凭据的轮换，没有覆盖长期 Share verifier 的密钥生命周期。
- **业务影响：** 正常密钥轮换或密钥事故恢复可能使全部存量链接同时失效。
- **架构影响：** 两类 HMAC 凭据采用不同生命周期模型，运维不可预测。
- **修改建议：** 明确 PEPPER 是不可轮换直到全部 Share 自然失效，还是采用 `pepper_kid + 新旧 key 验证窗口`；同时定义密钥丢失和紧急吊销行为。
- **优先级：P1**

### R3-A7 · Visible Window 的创建切点没有并发原子语义

- **层次：架构级**
- **定位锚点：** requirements.md「`[AC-SHARE-06] THE MailShareService SHALL 把创建时刻该邮箱的最大 email_id`」
- **问题：** “读取当前最大 email_id”和“插入 Share”之间若有新邮件到达，该邮件究竟属于创建前还是创建后没有定义。
- **问题根因：** 用两次数据库操作近似业务时间切点，却未指定事务和串行化顺序。
- **业务影响：** 极端并发下 Visitor 可能看到 Owner 点击完成前已存在的邮件，或漏掉创建后应可见的第一封邮件。
- **架构影响：** Visible Window 的核心不变量缺少唯一线性化点。
- **修改建议：** 将窗口快照和 Share 插入放在同一事务，并把事务提交顺序定义为业务切点；若 D1/ORM 无法保证，改用创建时间加稳定复合游标。具体能力需实现方核实。
- **优先级：P1**

### R3-F1 · 动态邮件集合无法满足“同一 cursor 返回相同内容”

- **层次：普通功能缺陷**
- **定位锚点：** requirements.md「`[AC-RT-09] THE ShareMailService SHALL 按 email_id 升序返回列表`」
- **问题：** 新邮件持续加入时，同一 cursor 再请求必然可能多出数据，与“返回相同内容”的幂等读断言冲突。
- **问题根因：** 混淆了稳定排序与快照一致性。
- **业务影响：** 验收测试无法稳定通过，实现方可能错误缓存动态结果。
- **架构影响：** 读接口没有 snapshot/version，却承诺了快照语义。
- **修改建议：** 只保证同一数据快照内顺序稳定、不重复、不跳过；不要承诺动态集合内容恒等。若必须恒等，需显式 snapshot 上界，但本场景没有业务必要。
- **优先级：P1**

### R3-F2 · Account 转移与功能开关可能使旧授权自动复活

- **层次：普通功能缺陷**
- **定位锚点：** requirements.md「`[AC-LIFE-09] IF MailShare 指向的 account 已被删除或已转移所有者`」
- **问题：** Share 行状态保持 `ACTIVE`，只在访问时检查 Account。Account 转走后再转回，或功能开关关闭后再开启，旧链接会重新可用。
- **问题根因：** 把“临时不可访问”和“安全事件导致永久失效”都建模为动态有效性判断。
- **业务影响：** Owner 可能认为转移邮箱或紧急关停已经终止旧授权，之后授权却无提示恢复。
- **架构影响：** 状态回退语义不明确，人工操作与自动判定可能冲突。
- **修改建议：** 产品明确两类事件的恢复语义。推荐 Account 所有者变化永久撤销相关 Share；全局开关可作为临时冻结，但重新开启前需明确是否恢复旧链接。
- **优先级：P1**

### R3-F3 · Session 在同源页面导航后的清理和多 Share 隔离未定义

- **层次：普通功能缺陷**
- **定位锚点：** design.md「| **Session 存储（R2-F1）** |」
- **问题：** `sessionStorage` 在同 tab、同源页面导航后仍存在；文档只规定关闭 tab 清除，没有规定离开分享页、切换不同 `lid`、撤销和鉴权失败后的清理。
- **问题根因：** 只设计了刷新恢复，没有覆盖完整浏览器导航生命周期。
- **业务影响：** 返回旧页面可能误用另一 Share 的 token；同源其他页面脚本可继续读取残留凭据。
- **架构影响：** 匿名凭据的客户端生命周期比服务端 Session 契约更宽。
- **修改建议：** token 按 `lid` 命名隔离；鉴权失败、撤销确认和显式退出时清除；确认是否在离开分享路由时清除。该问题可随客户端实现补齐。
- **优先级：P2**

---

## 推荐的更优实现方向

### 本期必须实现

1. 保留 `lid + sec`、fragment、Share Session、逐请求回源和 scoped repository。
2. 保留创建、列表、撤销、有效期、Visible Window、OTP 读取和纯文本正文。
3. 先将附件从本期删除，避免建立不可撤销的第二授权通道。
4. SafeMailRenderer 首期采用：
   - 默认纯文本；
   - HTML 使用无脚本、无同源权限的 sandbox iframe；
   - 固定合理高度或内层滚动；
   - 默认不加载远程资源，用户显式选择后再加载。
5. Visible Window 快照和 Share 创建采用一个明确事务切点。
6. 幂等记录、Share 变更和活跃数量约束在同一事务边界内完成。
7. 固定边缘 429、客户端退避和统一错误的边界。
8. 明确 Account 转移、功能开关恢复和两类 HMAC 密钥轮换语义。

### 可延后

- `regenerate`：首期已有 revoke + create 的稳定替代流程。
- `access_count`、`last_access_at`：不影响核心分享能力。
- HTML 自动高度。
- 独立的 `share:create/query/revoke` 权限拆分；首期可使用单一 manage 权限。
- 服务端长轮询：可先用 3～5 秒客户端增量查询，生产数据证明有必要后再升级。

### 不建议实现

- 复用永久公开 `/oss` URL 的附件分享。
- 为 iframe 自动高度加入 frame 内脚本。
- D1 自建鉴权失败计数和全局指标系统。
- 把同一 cursor 的动态查询承诺成快照恒等。
- 在没有真实角色矩阵时建立三份细粒度 Share 权限。

更简单稳定的推荐链路是：

`Owner 创建授权 → 单事务确定窗口并落 Share → Visitor 建立 Session → scoped repository 增量查询 → 默认纯文本/严格 sandbox 展示 → 到期或撤销统一失效`

首期不需要附件、自动高度、访问指标和服务端长轮询，也能完整实现核心业务目标。

---

## 开工前代码核验清单

以下均为**需实现方核实**，本轮未读取源码：

### 当前领域模型和数据库结构

- `account.user_id` 是否确实是唯一且恒稳的归属真源？
- `account` 是否存在软删除、禁用、转移、回收或 ID 复用语义？
- `email.email_id` 是否 NOT NULL、全局唯一且严格单调？
- `email.account_id` 是否所有历史行都完整且没有脏关联？
- D1 当前版本是否支持本方案要求的事务、条件更新和 `RETURNING`？
- TEXT 时间列是否统一采用可比较的 UTC 格式、固定精度和时区？
- 现有迁移器遇到部分失败时是否会继续并留下半迁移状态？

### 现有接口、任务和事件链路

- 邮件写入、附件写入与邮件行提交是否属于同一完成事件？
- Account 删除或转移是否已有领域事件可用于撤销 Share？
- 是否已有统一 CleanupTask 可注册 `delete_at` 和幂等记录清理？
- Worker 重启、部署切换或请求取消时，长轮询是否能及时终止？
- `/share/*` 是否能按具体 method + path 精确放行而不是 `startsWith`？

### 数据真正来源及字段完整性

- `email.code` 是否可能为空、过期、延迟回填或被人工改写？
- `email.text` 是否保证存在；HTML 降级时为空应展示什么？
- 附件元数据与对象存储是否可能不一致或晚于邮件行提交？
- `email_id` 是否能可靠表达“分享创建前后”，还是需要时间加 ID 的复合游标？
- Owner 列表所需邮箱地址是否来自仍可能被删除的 Account 行？

### 账户、租户和业务实体映射

- 产品是否真的没有组织、团队、管理员代管或共享邮箱等 Tenant 语义？
- 一个 Account 是否可能被多个 User 使用或授权？
- Account 转移是否应永久撤销旧 Share？
- Account 禁用后再启用是否应恢复旧 Share？
- 普通用户是否都应默认拥有创建匿名分享的权限？

### 已有状态机、幂等和失败恢复机制

- 项目是否已有通用 Idempotency-Key 表、请求指纹或事务 helper？
- 同 Key 不同请求体当前约定返回什么稳定错误？
- Share 行与幂等行能否在一个事务中提交？
- `access_count` 是否会使用原子 `SET access_count = access_count + 1`？
- 统计写入失败是否会错误阻断合法 Session？
- PEPPER 与 Session 签名密钥是否已有统一的 `kid` 和轮换设施？
- 功能开关关闭再开启时，已有系统通常是冻结还是永久撤销？

### 历史 Git、旧实现和废弃逻辑

- 历史上是否做过公开邮箱、临时 token、附件签名或分享链接能力？
- 当前 `/public/*` 为什么采用全局 token，是否存在不能复用的历史约束？
- 是否曾因 D1 事务、TEXT 时间比较、附件鉴权或路由白名单出现事故？
- 被废弃的 OTP、限速和净化设计是否会遗留任务或测试继续要求实现？

### 前后端已有类似能力

- 前端是否已有可复用的匿名路由壳、独立请求实例和 Session 清理逻辑？
- 是否已有通用安全 iframe 组件，而非再建第二套 Renderer？
- 是否已有客户端增量轮询、退避、后台暂停和取消请求的 composable？
- 是否已有统一复制降级组件？
- 后端是否已有 owner-scoped repository 或资源授权上下文？

### 测试覆盖、规模和性能基线

- 测试运行器是否已能在隔离 D1 中真正执行事务测试？
- 生产最大邮件表行数、单 Account 邮件量和峰值写入速率是多少？
- 预计并发 Share、单 Share Visitor 数和轮询 QPS 是多少？
- `(account_id, email_id)` 查询在生产量级下是否确实命中覆盖索引？
- 25 秒 wait 在 Worker 限制下是否会被代理、部署或客户端提前终止？
- Cloudflare 限速响应是否为统一 JSON，是否带 `Retry-After`？
- Chromium、Firefox、Safari 下 sandbox、srcdoc、CSP、外链和高度行为是否一致？
- 全新浏览器、刷新、后退、同 tab 切换两个 Share、撤销中等待等场景是否有 E2E 覆盖？
- 是否有附件过期后仍可访问的负例测试，以防误称撤销完整？

---

## 必须由产品/业务/技术负责人确认的问题

1. **附件是否真是首期业务刚需？** 若是，是否接受“销毁后仍永久可下载”；若不接受，必须从本期删除或建设受控下载端点。
2. 产品所称“租户”是否等同于 User，还是存在组织、团队、代管账号和共享邮箱？
3. Account 转移是否永久撤销全部旧 Share？
4. 全局功能开关重新开启后，旧 Share 应恢复还是保持失效？
5. 创建 Share 的业务切点以请求进入、事务提交还是 UI 收到成功响应为准？
6. 是否接受创建/regenerate 首次响应丢失后必须再次轮换、且期间存在一个未知有效链接？
7. `access_count` 和 `last_access_at` 是否会驱动实际管理决策；若不会，是否同意延后？
8. 是否有真实角色需要“能创建但不能查询/撤销”等权限组合；没有则是否改为单一 manage 权限？
9. 是否接受首期 HTML 使用固定高度/内层滚动，优先保证脚本隔离？
10. 远程图片默认加载造成访问追踪是否符合隐私预期？
11. 自动出现新邮件是否必须约 1 秒，还是 3～5 秒客户端轮询已满足业务？
12. PEPPER 轮换是否允许全部存量链接失效？
13. 边缘限速是否应向 Visitor 明确返回可恢复的 429，而不是伪装成永久不可用？

---

## 落地决定

**调整方案后开发。**

资源级 capability、状态计算、逐请求校验和 scoped repository 已基本收敛，无需推倒重设计；但附件永久直链直接破坏临时授权边界，沙箱渲染、幂等原子性、创建窗口、限速响应和密钥轮换仍存在开工阻断。

```yaml
patch_plan:
  - issue_id: R3-A1
    severity: P0
    target_file: requirements.md
    anchor: "- [AC-SEC-18] THE ShareMailService SHALL 在 Visitor 邮件详情 DTO 中返回附件元数据"
    action: replace_section
    intent: 删除永久公开附件直链，或将附件下载纳入可随 Share 到期和撤销的统一授权边界
    rationale_short: 当前附件在 Share 失效后仍可访问，破坏临时授权核心契约
  - issue_id: R3-A2
    severity: P1
    target_file: requirements.md
    anchor: "#### 沙箱渲染模型"
    action: replace_section
    intent: 收敛脚本隔离、链接行为、远程资源、隐私和高度策略为可同时实现且可跨浏览器验收的组合
    rationale_short: 禁止脚本和同源访问时无法按当前方案执行自动高度，CSP 与远程资源要求亦冲突
  - issue_id: R3-A3
    severity: P1
    target_file: requirements.md
    anchor: "#### 读模型契约（A5）"
    action: replace_section
    intent: 补充总并发容量、重连风暴、超时退避和降级模型，并以客户端增量轮询作为简单基线比较
    rationale_short: 单次查询上界不能证明生产总负载可控
  - issue_id: R3-A4
    severity: P1
    target_file: requirements.md
    anchor: "**幂等与并发语义（A4 · R2-A4 收敛）**"
    action: replace_section
    intent: 明确请求指纹、同 Key 异请求冲突、跨表同事务提交、回滚和清理语义
    rationale_short: 当前幂等表不能验证请求等价且部分成功边界未定义
  - issue_id: R3-A5
    severity: P1
    target_file: requirements.md
    anchor: "### Requirement 9: 滥用防护（本期最小）"
    action: replace_section
    intent: 固定边缘 429 与应用错误的权威边界、响应形状、Retry-After 和客户端退避行为
    rationale_short: Cloudflare 前置短路无法同时保证统一 SHARE_UNAVAILABLE 响应
  - issue_id: R3-A6
    severity: P1
    target_file: requirements.md
    anchor: "- **Share Secret (`sec`)**"
    action: append_after
    intent: 定义 PEPPER 的版本标识、轮换窗口、存量 Share 验证和紧急吊销策略
    rationale_short: 单一 PEPPER 轮换会不可预测地使全部存量链接失效
  - issue_id: R3-A7
    severity: P1
    target_file: requirements.md
    anchor: "- [AC-SHARE-06] THE MailShareService SHALL 把创建时刻该邮箱的最大 `email_id`"
    action: replace_section
    intent: 为窗口快照与 Share 插入定义同一事务中的唯一线性化点
    rationale_short: 并发来信可能漂移创建前后邮件的可见边界
  - issue_id: R3-F1
    severity: P1
    target_file: requirements.md
    anchor: "- [AC-RT-09] THE ShareMailService SHALL 按 `email_id` 升序返回列表"
    action: pattern_rewrite
    intent: 将动态集合的内容恒等承诺改为稳定排序、不重复和不跳过语义
    rationale_short: 没有 snapshot 上界时同一 cursor 的返回内容会随新邮件变化
  - issue_id: R3-F2
    severity: P1
    target_file: requirements.md
    anchor: "- [AC-LIFE-09] IF MailShare 指向的 `account` 已被删除或已转移所有者"
    action: replace_section
    intent: 明确 Account 转移和功能开关恢复是否永久撤销、临时冻结或允许旧授权复活
    rationale_short: 当前动态校验会使旧 Share 在状态回退后无提示重新可用
```

## VERDICT
status: NEEDS_CHANGES
p0_count: 1
p1_count: 8
one_line: capability 主干已收敛，但附件永久直链破坏撤销边界，且沙箱、并发窗口、幂等、限速与密钥轮换契约仍需开工前定稿。
