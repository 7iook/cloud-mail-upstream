# Recon-Frontend · Mail Share 前端现状 vs 新需求(管理模块 + 访客单/多邮箱页)

- 模式:Mode R(现实侦察)
- 日期:2026-08-24
- 仓库:/workspace(HEAD detached @ 7d7fdf1)
- 侦察范围:mail-vue 前端(share 访客页、Owner 管理入口、轮询、SafeMailRenderer、路由/引导隔离、i18n)+ 必要的 worker API 面核对
- 证据基线 commit:`0151e40`(feat(vue): Mail Share 前端)、`7544d97`(feat(worker) 后端)、`ddbedbb`/`7d7fdf1`(评审修复,SHARE_SESSION_TTL 86400→900)

---

## 1. 访客页现状:结构与状态机

单文件页面 `mail-vue/src/views/share/index.vue`(705 行,自带 scoped 样式,不挂 layout)。

**状态机**(`state` ref,`index.vue:160`,渲染于 `index.vue:8-13`):
`loading → ready | unavailable | timedout | limited | exited`,另有独立叠加态 `rateLimited`(`index.vue:166`,显示 share-wait 提示条 `index.vue:24-28`)。

**ready 态页面结构**(`index.vue:30-123`):
1. 顶栏:标题 + 邮箱地址 + 「离开」按钮(`index.vue:7-22`)。
2. OTP 高亮区 `data-share-code`(`index.vue:31-60`):`featuredMail` 计算属性取「选中邮件的 code,否则最新一封含 code 的邮件」(`index.vue:255-266`);32px 大字 + 一键复制 + 复制降级(隐藏 input 手动选中,`index.vue:48-55`)+ 来源发件人行。
3. 邮件列表 `data-share-mail-list`(`index.vue:68-87`):按 `mailId` 倒序(`listMails`,`index.vue:246`),仅主题 + 发件人两行,无未读标记、无时间戳显示、无搜索。
4. 详情区(`index.vue:89-121`):选中邮件(默认最新一封,`index.vue:248-253`)经 `SafeMailRenderer` 渲染(默认纯文本),附远程图片提示与附件受控下载按钮。

**会话/恢复逻辑**:`bootstrap()`(`index.vue:514-556`)从 fragment 密钥(`session.js:95-104` `consumeShareSecret`)或 `sessionStorage`(`share:session:<lid>`,`session.js:13-25`)建会话;`recoverFromUnavailable`(`index.vue:346-397`)在内存尚存 `sec` 时静默重建一次(`justRecovered` 防死循环);首屏用 `MAX_CATCHUP_PAGES=40` 循环补页(`index.vue:442-477`)。

**访客页刻意不显示的东西**(与新需求直接相关):剩余有效时间、到期时刻、邮箱状态(ACTIVE/即将过期)、轮询刷新指示。后端 `POST /share/session` 只返回 `sessionToken + mailbox`(`index.vue:531-541` 消费面证实),**不返回 expiresAt** ——访客侧「剩余时间」目前无数据源。

## 2. Owner 创建/管理 UI:仅对话框,无独立模块

- **入口只有一个**:收件箱页 `mail-vue/src/views/email/index.vue:20-32` —— `ShareIndicator`(徽标,显示当前邮箱 ACTIVE 分享数,`ShareIndicator.vue:37-42`)点击打开 `ShareDialog`。
- `ShareDialog.vue` 是 680px 的 el-dialog:创建表单(name/remark/时长四档 1h/6h/1d/7d,`ShareDialog.vue:92-97`)+ 一次性链接展示(`shareSecretOnce`)+ 幂等键轮换(`ShareDialog.vue:217-219` watch 表单变化即换 key)+ 分享列表(状态/创建/失效/访问计数/最后访问)+ 销毁(带确认,`ShareDialog.vue:191-208`)。
- **确认不存在独立管理页**:`views/setting/index.vue`、`views/sys-setting/index.vue`、`views/role/` 均无 share 相关内容(rg 证实无命中);路由表 `router/index.js:8-78` 无 share 管理路由;权限动态路由由 `perm/perm.js` `permsToRouter` 生成,现有权限只有单一 `share:manage`(worker 侧种子 `mail-worker/src/init/init.js:93`,默认只赋 role_id=1 即管理员角色,`init.js:110-117`)。
- 请求层 `mail-vue/src/request/mail-share.js` 仅三个端点:`POST /mailShare/create`(带 Idempotency-Key)、`GET /mailShare/list`、`DELETE /mailShare/revoke`——与 worker 侧 `mail-share-api.js:23/30/35` 一一对应。**无 update / 无 detail / 无按 share 查会话 / 无分页参数**(list 全量返回)。

## 3. 轮询/准实时机制

`mail-vue/src/composables/useSharePolling.js`(独立 composable,有 spec):
- **间隔**:固定 3000ms(`POLL_INTERVAL_MS`,`useSharePolling.js:9`),setTimeout 链式调度(`schedule`,`useSharePolling.js:105-114`),非 setInterval,天然防重叠;每 tick 前 `AbortController` 取消在飞请求(`useSharePolling.js:136-138`)。
- **暂停**:`visibilitychange` 监听,`document.hidden` 时清定时器 + abort(`useSharePolling.js:181-191`);回前台立即补一拍 `schedule(0)`。
- **游标**:`cursor = 本批最后一条 mailId`(`useSharePolling.js:151-156`),与后端 `GET /share/mails?cursor=&limit=` 增量契约(requirements.md 读模型 R3-A3)对齐;页面侧 `mergeMails` 按 mailId 去重合并(`index.vue:205-214`)。
- **429 退避**:读 `Retry-After`(数值秒或 HTTP 日期均可,`share.js:17-30` `parseRetryAfter`)延后下一拍(`useSharePolling.js:168-170`),不视为死链(AC-RT-15)。
- **死链**:`SHARE_UNAVAILABLE` → `notifyUnavailable` 停止一切并回调 `onUnavailable`(`useSharePolling.js:116-129`),页面据此走恢复/展示死链流程。
- **单实例单会话**:composable 只支持一个 `sessionToken` + 一个 cursor。多邮箱聚合页若每邮箱一个会话,需 N 个实例或改造为多路复用(见 §6)。

登录态收件箱另有一套内联 `while(true)` 轮询(`views/email/index.vue:95-131`),requirements.md 已明确判其无卸载清理、不复用——**不要**把它当第二个可复用轮询源。

## 4. SafeMailRenderer 与 OTP 展示复用点

- `mail-vue/src/components/safe-mail/index.vue`:双模式(纯文本 `<pre>` / 沙箱 iframe),props `text/html/content/height/defaultMode`(`index.vue:71-81`);沙箱 `allow-popups allow-popups-to-escape-sandbox`、无 `allow-scripts`/`allow-same-origin`(`srcdoc.js:16-17`),内层 CSP `script-src 'none'`(`srcdoc.js:19`),固定高度 72vh/展开 90vh(`srcdoc.js:21-22`)+ 内层滚动;注入失败降级纯文本;**自带 zh/en 内建文案 + i18n key 覆盖机制**(`index.vue:92-137`),匿名页无全量 i18n 也能工作。登录态详情页与分享页共用(AC-SEC-10),多邮箱页可直接复用,零改造。
- OTP 展示:数据源是后端白名单 DTO 里的 `code` 字段(只读 `email.code`,AC-OTP-14);前端「取最新含 code 邮件」的选择逻辑在 `share/index.vue:255-266`(`featuredMail`),复制走 `useCopyWithFallback`(Clipboard → execCommand → 手动选中三级降级,`useCopyWithFallback.js:165-191`)。**该 OTP 区块目前内嵌在页面里,未抽成组件**——多邮箱页要用,需先抽 `ShareOtpCard`(小改造)。

## 5. 路由/引导隔离约束(改造时必须保持)

1. **路由守卫白名单**:`router/index.js:157-161` —— `to.name === 'share'` 时 `captureShareSecret` + `clearOtherShareSessions` 后直接放行,不查 token。新增访客多邮箱路由必须加进同等白名单,否则被 `next({name:'login'})` 拦截(`router/index.js:163`)。
2. **离开即清会话**:`afterEach` 中 `from.name === 'share' && to.name !== 'share'` → `clearShareSession`(`router/index.js:181-183`,AC-VISIT-15 安全契约)。多邮箱路由若单独命名,此判断需扩展,否则跨 share 路由跳转会误清/漏清。
3. **匿名引导短路**:`init/init.js:18-20` `isAnonymousShareVisit` 用正则 `/(?:^|\/)s\/[^/]+/` 匹配路径,命中则跳过 `websiteConfig()`/用户加载(`init.js:34-36`);`init/assert-share-entry.js` 有守护测试断言该 return 在 `websiteConfig` 之前。**多邮箱访客页若用新路径(如 `/m/:gid`),正则必须同步扩展,且守护测试要跟着改**。
4. **构建产物隔离闸门**:`views/share/assert-share-chunk.js:10-15` 构建后扫描 share chunk 的依赖闭包,禁止出现 `dexie`、`account:query`(layout 权限)、`location.reload`(登录态 axios 拦截器)、`websiteConfig`。**多邮箱访客页的所有 import 都要留在这个隔离闭包内**:不能引 `@/axios/index.js`(有 reload)、不能引 layout/store 重件;网络层只能走 `request/share.js` 的独立 `shareHttp` axios 实例(`share.js:3-5`,无 cookie、无登录拦截器)。
5. **fragment 密钥一次性**:`session.js:76-83` 守卫阶段捕获 `#sec` 进内存 Map 并立即清 URL;多邮箱链接若沿用 `#<sec>` 形态可直接复用 `captureShareSecret/consumeShareSecret`。

## 6. 差距清单(新需求 vs 现状)

### 6a. Admin 管理模块

| 新需求项 | 前端现状 | 后端现状 | 差距级别 |
|---|---|---|---|
| 独立管理列表页 | 无,仅 ShareDialog 内嵌列表 | `GET /mailShare/list` 全量无分页 | 前端新建页面;列表大了要后端加分页/筛选 |
| 创建单邮箱分享 + 复制链接 | ✅ ShareDialog 已有(含幂等、一次性密钥) | ✅ | 可整体搬迁复用 |
| 创建多邮箱分享 / 增删邮箱绑定 | ❌ | ❌ 数据模型 1 share = 1 account(requirements.md Glossary MailShare) | **后端数据模型级新建**(绑定表/聚合 lid) |
| 状态展示(ACTIVE/EXPIRED/REVOKED) | ✅ `statusLabel`(ShareDialog.vue:128-135) | ✅ effectiveStatus 计算态 | 无 |
| 到期时间 | ✅ 列表展示 expiresAt | ✅ | 无 |
| used/max sessions(会话次数上限) | ❌ 仅 access_count 观测 | ❌ **且 R2 用户裁决明确「访问次数上限不在本期」**(requirements.md:7) | 需推翻旧裁决 + 后端字段/判定 |
| message_limit(邮件条数上限) | ❌ | ❌ 无此概念(只有 Visible Window) | 后端新字段 + 投影链改造 |
| 刷新策略可配 | ❌ 访客固定 3s | ❌ | 后端下发配置 + useSharePolling 接参(已支持 `intervalMs` 入参,`useSharePolling.js:58`,改造小) |
| 访问密码开/关 + 重置密钥 | ❌ | ❌ **「访问密码」与 regenerate 均被 R2/R3 裁决排除**(requirements.md:7, AC-SHARE-13/AC-LIFE-05 deprecated) | 需推翻旧裁决;重置密钥≈复活 regenerate |
| 销毁(revoke) | ✅ | ✅ | 无 |
| 物理删除(delete) | ❌ 仅定时清理 delete_at(AC-LIFE-07) | ❌ 无 Owner 主动删除端点 | 后端新端点 |
| 预设(OTP latest-1 / 临时 3-5 / 多池 / 自定义) | ❌ | 视预设语义:纯前端表单预填 = 零后端;若含 message_limit/多邮箱则依赖上排差距 | 语义待定(见雾清单) |

### 6b. 访客单邮箱页(OTP 等待优化)

现状已覆盖:OTP 高亮 + 一键复制 + 复制降级、邮件列表、3s 自动刷新、后台暂停、429 退避、死链/超时/离开态。
差距:① **剩余时间/到期倒计时**——后端 session DTO 不返回 expiresAt,需后端加字段(信息最小化裁量,见雾清单);② 「最新状态」指示(上次刷新时间/新邮件到达动效)——纯前端补;③ 视觉层面目前是极简无设计系统的原生样式(见 §7)。

### 6c. 访客多邮箱聚合页(全新)

前端全部为新建:邮箱 Tab/列表、新邮件/OTP 角标、切换邮箱、共享配置展示。**硬前置**:后端聚合分享契约(一个 lid 对多 account?会话 token 覆盖范围?每邮箱独立 cursor 还是聚合流?)完全不存在。前端可复用件:`shareHttp`、`useSharePolling`(每邮箱一实例,或加 `accountId` 参数多路化)、`SafeMailRenderer`、`useCopyWithFallback`、session.js 全套、OTP 区块(需先抽组件)。**新邮件角标依赖「非激活 Tab 也在轮询」**——N 个邮箱并发轮询会放大请求量,与 Cloudflare 边缘限速(AC-ABUSE-08)相互作用,需要契约层面定「聚合轮询接口」还是「逐邮箱轮询 + 更长间隔」。

## 7. 移动端/响应式现状

- 访客页:`max-width:720px; margin:0 auto; padding:24px`(`index.vue:572-581`),单列流式,天然移动可用但无断点、无移动专项优化;字体 system-ui;无 Element Plus 组件(仅探测全局 `ElMessage`,`index.vue:485`),包体极小——**多邮箱页若引入 el-tabs 等重组件会显著增大隔离 chunk,建议延续轻量原生风格**。
- iframe 内层有 viewport meta + `img{max-width:100%}`(`srcdoc.js:27-31`);超宽表格横向滚动为已接受代价(`srcdoc.js:12-13`)。
- 登录态 UI 有全局移动逻辑(`router/index.js:192-204` `accountShow/asideShow` 按 767/1025px),但 share 路由不挂 layout、不受其影响;新建的**管理模块页挂在 layout 下,需遵循既有 767px 约定**。

## 8. 可复用组件/composable 清单(file:line)

| 资产 | 位置 | 复用方式 |
|---|---|---|
| shareHttp 匿名 axios 实例(429/信封/Bearer 处理) | `mail-vue/src/request/share.js:3-147` | 多邮箱页直接用;新增聚合端点在此文件加函数 |
| useSharePolling(3s/暂停/游标/退避) | `mail-vue/src/composables/useSharePolling.js:56-214` | 每邮箱一实例即可用;`intervalMs`/`listShareMails` 已可注入 |
| useCopyWithFallback 三级复制降级 | `mail-vue/src/composables/useCopyWithFallback.js:120-209` | 原样复用 |
| SafeMailRenderer(沙箱正文,自带 zh/en 兜底文案) | `mail-vue/src/components/safe-mail/index.vue:69-192` + `srcdoc.js` | 原样复用 |
| session.js(sessionStorage 键隔离/fragment 捕获) | `mail-vue/src/views/share/session.js:1-104` | lid 维度已通用,多邮箱聚合 lid 可直接沿用 |
| OTP 高亮区块逻辑(featuredMail 选取 + 复制) | `mail-vue/src/views/share/index.vue:255-266,479-491,31-60` | **需抽组件**后共享给单/多邮箱页 |
| ShareDialog 创建表单 + 一次性密钥展示 + 幂等键轮换 | `mail-vue/src/views/email/ShareDialog.vue:8-39,98-139,161-189` | 管理模块的「创建」弹层可整体迁移/包装 |
| ShareIndicator 权限判定模式 | `mail-vue/src/views/email/ShareIndicator.vue:21-27`(hasPerm('share:manage')) | 管理路由 meta 权限沿用 |
| buildShareUrl | `mail-vue/src/views/email/build-share-url.js:1-9` | 原样复用(多邮箱链接若同形态) |
| i18n 键(share* 46 条 ×zh/en) | `mail-vue/src/i18n/zh.js:340-385`、`en.js` 同段 | 新键按同前缀追加 |
| 守护测试三件套 | `views/share/assert-share-chunk.js`、`init/assert-share-entry.js`、各 `.spec.js` | 改路由/引导时必须同步更新 |

## 9. 并行工作包拆分建议(前端)

前置声明:**WP-F0(契约)不落地前,F2/F3 的后端依赖字段全是空中楼阁**;拆包按「可独立验收」切,不按技术层切。

| 包 | 范围 | 目标 | 依赖 | 可并行 | 建议 AI 数 |
|---|---|---|---|---|---|
| WP-F0 契约冻结(非编码) | 多邮箱分享 API 形态、admin 扩展字段(session 上限/message_limit/auth key)、访客 expiresAt 下发 | 主 AI + 后端侧共同产出 API 契约文档 | 雾清单用户裁决 | — | 主 AI 自持 |
| WP-F1 访客单邮箱页优化 | `views/share/index.vue` + 新抽 `ShareOtpCard`/状态条组件 | 剩余时间(若契约放行)、刷新指示、OTP 区块组件化、视觉打磨 | expiresAt 依赖 F0;其余可先行 | ✅(组件化部分不等 F0) | 1 |
| WP-F2 访客多邮箱聚合页 | 新路由 `/m/:gid`(或复用 `/s/`)、Tab/列表、角标、多路轮询 | 新页面全量 | **硬依赖 F0**;复用 F1 抽出的组件(串行于 F1 的组件化子步) | F0 后可与 F3 并行 | 1-2 |
| WP-F3 管理模块页 | 新路由 + `views/share-admin/`、列表/筛选/详情抽屉、创建向导(预设)、绑定管理 | 独立管理页;ShareDialog 逻辑迁入 | 列表/创建/revoke 可先用现有 3 端点做骨架;扩展字段依赖 F0 | ✅ 与 F1 并行 | 1-2 |
| WP-F4 隔离与守卫改造 | `router/index.js`、`init/init.js` 正则、`assert-share-entry/chunk` 守护测试 | 新访客路由进白名单且不破坏隔离闸门 | 与 F2 同人做(强耦合),**不要单独派** | — | 并入 F2 |
| WP-F5 i18n + 响应式收尾 | zh.js/en.js 新键、移动断点核对 | 文案完整 | F1/F2/F3 定稿后 | 串行收尾 | 1 |

**风险交叉区(冲突点,主 AI 派发时注意)**:
- `router/index.js` + `init/init.js`:F2(访客路由)与 F3(管理路由)都要改——建议 F3 只加 layout 子路由(低风险),访客白名单/守卫扩展全部收归 F2,**二者不得同时改守卫逻辑**。
- `i18n/zh.js`/`en.js`:三个包都会加键,同文件追加易冲突——统一由 F5 收口,或各包用独立追加段落 + 主 AI 归并。
- `views/share/index.vue`:F1 重构(抽组件)与 F2 复用组件存在先后序——F1 的「组件抽取」子步必须先于 F2 开工,否则 F2 会复制粘贴出重复实现。
- `assert-share-chunk.js` FORBIDDEN 闭包:F2 任何 import 失误(如引 `@/axios/index.js`)会让守护测试红,这是设计好的闸门,**红了改 import 而不是改闸门**。

## 10. 雾清单(必须由用户裁决的业务决策,平语言)

1. **推翻旧裁决确认**:访问密码(auth on/off)、访问/会话次数上限、重置密钥(≈regenerate)在 2026-08-16/17 的 R1-R3 裁决中被你明确排除出「严格最小集」(requirements.md:7)。这次要做,等于推翻当时的裁决——确认推翻,还是这些仍缓一期?
2. **多邮箱分享的产品形态**:访客拿到的是「一条链接看 N 个邮箱」,还是「N 条链接的一个聚合入口」?撤掉其中一个邮箱时,访客正看着它会发生什么(立即消失/提示)?这决定后端是全新数据模型还是轻量聚合层。
3. **管理模块的服务对象**:是给每个 Owner 管自己的分享(现状 share:manage 语义),还是给管理员管全站所有人的分享(需要新权限 + 跨用户列表)?「admin share management」两种读法差一个权限体系。
4. **预设的语义**:「OTP latest-1」是访客只看得到最新 1 封邮件(需要 message_limit 落库),还是仅仅页面置顶最新验证码(现状已如此)?「临时 3-5」的 3-5 指什么单位(封数/天数/次数)?预设是前端表单快捷键还是后端持久化模板?
5. **访客侧信息披露**:给访客显示剩余有效时间,需要后端把 expiresAt 下发给匿名会话——之前刻意最小化访客可见信息。放开吗?
6. **刷新策略可配的边界**:允许 Owner 把访客轮询调快于 3 秒吗?这直接顶到 Cloudflare 边缘限速(AC-ABUSE-08)和多邮箱并发轮询的放大效应,建议只允许 3s/5s/10s 档位,不开自由值——请确认。
7. **访客搜索/状态过滤(多邮箱需求里提到 search/status)**:搜索在客户端已拉取的邮件里做(零后端),还是要后端全文检索?前者本期可做,后者是新端点。

---

## 附:计划假设核对(plan vs reality 速览)

| 假设(新需求隐含) | 现实 | 判定 |
|---|---|---|
| 已有访客分享页可扩展 | `views/share/index.vue` 完整可用,状态机健全 | [match] |
| 已有管理界面可增强 | 只有收件箱内的 ShareDialog,无独立模块、无路由、无 setting 集成 | [deviation:仅对话框] |
| 已有轮询机制 | useSharePolling 成熟(3s/暂停/游标/退避),但单会话单游标 | [match,多路化需小改] |
| 多邮箱能力已有雏形 | 前后端均为 1 share = 1 account,零雏形 | [doc-missing:全新建] |
| 管理字段(次数上限/密码/重置) 待补 UI | 这些字段被既往用户裁决明确排除,后端无存储无端点 | [deviation:先裁决后动工] |

领域模型核对:仓内无 `docs/domain/` 目录;mail-share 的中间层契约实际记录在 `docs/specs/mail-share/requirements.md`(Success State、读模型、会话清理契约)与 `design.md`。若本轮扩展落地,建议主派发方将「分享聚合/绑定」维度表补进正式领域模型文档。
