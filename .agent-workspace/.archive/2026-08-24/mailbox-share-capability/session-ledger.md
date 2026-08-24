# Session Ledger · mailbox-share-capability

| 字段 | 值 |
|---|---|
| 会话目标 | 按定稿规格落地「邮箱访问能力分享」（W0→W6 / T-01→T-29） |
| 权威清单 | `docs/specs/mailbox-share-capability/tasks.md` |
| 分支 | `cursor/mailbox-share-capability-dcb6` |
| 开工 HEAD | `e120a04`（main，仅规格/侦察归档，无业务实现） |
| 主 AI 角色 | 协调 / 契约 / 回写清单 / 提交 / 验收；不直接大量改业务代码 |
| 执行模型 | `claude-opus-5-thinking-high-fast` |
| 审查模型 | `gpt-5.6-sol-xhigh-fast` |

## 本轮用户原始需求

在已交付 mail-share 之上实现 mailbox-share-capability：单/多邮箱 Binding、累计 Session 配额、可选 AuthKey、管理后台与访客 OTP 页。规格已 converged，本会话从实现开始，不重写 charter。成功状态：未登录访客凭不可猜链接（可选 AuthKey）查看绑定邮箱配置范围内最新邮件并复制验证码；达 max_sessions / 过期 / 撤销后无法新建访问；无写能力、无越权邮箱；轮询不计 Session。

## 代码现实（2026-08-24 开工核验）

- `mail-worker/src/init/init.js` 注册链止于 `v3_1DB`，**无** `v3_2DB`
- `mail-share` 实体 17 列，**无** 11 个新列、**无** `mail_share_binding`
- `SHARE_CAPABILITY_V2` 未出现在 `wrangler.toml` / `wrangler-vitest.toml`
- 基线测试文件：worker 16 spec（tasks 记 16 文件/138）、vue 与 E2E 未在本轮重数
- R3 P0 已吸入 design/tasks（全能力栅栏 / 迁移 account 事实谓词 / KV 幂等），实现不得回退到 R3 前草案

## 流水线状态

| 波次 | 任务 | 状态 | SUB | 证据 |
|---|---|---|---|---|
| W0 | T-01 v3_2DB | ✅ 已提交 `4f72418` | executor | 主 AI 复跑 17/153 绿 |
| W0 | T-01 审查 | ✅ 已回 | reviewer | P0-1 CHANGE / P0-2 HOLD |
| W0 | T-02 / T-03 / T-04 | ✅ 已提交 `e878760` | executor | 主 AI 三套 17/180 · 17/95 · 13 |
| W0 | T-02–T-04 阶段审查 | ✅ CHANGES_REQUIRED P0=3 | reviewer gpt-5.6-sol-xhigh-fast | `review-w0-t02-t04.md` |
| W1 | T-05→T-08 侦察 | ✅ 已落盘 | plan-reality-recon | `recon-w1-auth-chain.md` |
| W1 | T-05 | ✅ 已提交 `c7789e6` | executor | 主 AI 复跑 16/16 · 17/185 |
| W1 | T-06 侦察 | ✅ 已落盘 | plan-reality-recon | `recon-w1-t06-quota-gate.md` |
| W1 | T-06-P0 文档门 | ✅ 已关 | 主 AI | last_access_at 进闸门 · AC-SESS-11 · status 收窄 |
| W1 | T-06 | ✅ 已提交 `6209960` | generalPurpose≈executor | 主 AI 复跑 26/26 · 17/213 · 17/95 · E2E 13 |
| W1 | T-06 审查 | ✅ APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t06.md` |
| W1 | T-07 | ✅ 已提交 `c2087ce` | generalPurpose≈executor | 主 AI 复跑 34/34 · 7/7;代码审查 APPROVED p0=0 |
| W1 | T-08 | ✅ 已提交 `5a81065` | generalPurpose≈executor | 主 AI 复跑 auth 56 + api 8 + att 15；围栏 4→3 |
| W1 | T-08 代码审查 | ✅ R2 APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t08-r2.md` |
| W2 | T-12 侦察 | ✅ 已落盘 | explore≈plan-reality-recon | `recon-w2-t12-create.md` |
| W2 | T-12 | ✅ 已提交 `b6f5a28` | generalPurpose≈executor | 主 AI 复跑 mail-share 106/106；全量 17/289 |
| W2 | T-12 代码审查 | ✅ R2 APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t12-r2.md` |
| W1 | T-09 Checkpoint | ✅ 已提交 `dd1de15` | 主 AI | `share-context-freeze.md` · worker 17/317 |
| W2 | T-10 scoped repo | ✅ 已提交 `bca7bc2` | generalPurpose≈executor | 主 AI 复跑 repo 13 + api/integ DESC · 全量 17/349 |
| W2 | T-13 bindings PUT | ✅ 已提交 `ee2db41` | generalPurpose≈executor | 主 AI 复跑 mail-share 155/155 · 全量 17/349 |
| W2 | T-13 审查修复 | ✅ 已提交 `22d9832` | generalPurpose≈executor | 主 AI 独立 164/164 · 全量 17/358 |
| W2 | T-13 R2 | ✅ APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t13-r2.md` · `7a91fac` |
| W2 | T-11 投影+附件可见集 | ✅ 已提交 `bee72b6` | generalPurpose≈executor | 主 AI 独立 135/135 · 全量 18/410 |
| W2 | T-14 status 水位 | ✅ 已提交 `d6fa50b` | generalPurpose≈executor | 主 AI 独立 135/135 · 全量 18/410 |
| W2 | T-11 P1-1 复审 | ✅ APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t11-r2.md` |
| W3 | T-15 Owner get/update/delete + list | ✅ 已提交 `1d49bb4` · 审查修复 `cccb3bb` | generalPurpose≈executor | 主 AI 独立 198/198 · 全量 18/444 |
| W3 | T-15 审查 | ✅ R2 APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t15-r2.md` |
| W3 | T-16 AuthKey 侦察 | ✅ 已落盘 | explore≈plan-reality-recon | `recon-t16-authkey.md` |
| W3 | T-16 resetAuthKey | ✅ 已提交 `3bb1d55` | generalPurpose≈executor | 主 AI 独立 219/219 · 全量 18/465 |
| W3 | T-17 perm 侦察 | ✅ 已落盘 | explore≈plan-reality-recon | `recon-t17-perm.md` |
| W3 | T-16 审查 | ✅ APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t16.md` |
| W3 | T-17 perm 8 条 | ✅ 已提交 `d18f027` | generalPurpose≈executor | 主 AI 独立 148/148 · 全量 18/577 |
| W3 | T-17 审查 | ✅ APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t17.md` |
| W3 | T-18 级联侦察 | ✅ 已落盘 | explore≈plan-reality-recon | `recon-t18-cascade.md` |
| W3 | T-18 级联撤销 + cleanup | ✅ 已提交 `73dc371` | generalPurpose≈executor | 主 AI 独立 27/27 · 全量 18/598 |
| W3 | T-18 审查 | ✅ APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t18.md` · P2-1 HOLD |
| W3 | T-19 Checkpoint 侦察 | ✅ 已落盘 | explore≈plan-reality-recon | `recon-t19-checkpoint.md` |
| W3 | T-19 集成用例 | ✅ 已提交 `03d987c` · P1 `db1e511` | generalPurpose≈executor | 主 AI 独立 38/38 · 全量 18/619 |
| W3 | T-19 审查 | ✅ R2 APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t19-r2.md` |
| W4 | T-20 列表页侦察 | ✅ 已落盘 | explore≈plan-reality-recon | `recon-t20-share-admin.md` |
| W4 | T-20 列表页 + request | ✅ 已提交 `672da73` | generalPurpose≈executor | 主 AI 独立 20/20 · 全量 vue 18/113 · worker 18/619 · E2E 13 |
| W4 | T-20 审查 | ✅ APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t20.md` |
| W4 | T-21 抽屉侦察 | ✅ 已落盘 | executor 顺带 | `recon-t21-drawer.md` |
| W4 | T-21 详情抽屉 | ✅ 已提交 `00b0ae1` · 修复 `5af8675` | generalPurpose≈executor | 主 AI 独立 64/64 · 全量 vue 20/161 · worker 18/619 · E2E 13 |
| W4 | T-21 审查 | ✅ R2 APPROVED p0=0 | gpt-5.6-sol-xhigh-fast | `review-t21-r2.md` · P1-1/P2-1 CLOSED |
| W4 | T-22 向导侦察 | ✅ 已落盘 | explore≈plan-reality-recon | `recon-t22-wizard.md` |
| W0 | P0-3 seed ID + P1-2 日志覆盖 | ✅ 已提交 `3cce543` | generalPurpose | 主 AI 复跑 72/72 |

## 主 AI 裁决（文档能回答，不重开雾区）

| ID | 裁决 | 依据 |
|---|---|---|
| R1 | T-02.1 grep 收窄：不新增 `mail_share.account_id` 读取；`share-auth-service.js` 既有 4 处列入允许清单至 T-08 | 消除读取是 T-08 ShareContext；W0 改 auth 会破单 owner |
| R3 | 回填 INSERT 保持 design 原文，不加 `status='ACTIVE'` | 偏离裁决 SQL 触发 tasks 门禁；当前无越权；补偿属 T-18 |
| R5 | `wrangler.toml` 只写注释声明；代码缺省当 false；vitest toml 可写 `"false"` | `keep_vars` 挡不住 toml 硬值覆盖 dashboard 激活 |
| T01-P0-2 | HOLD：不把 `mailShareBinding` 提前接到读路径，也不做假 import | T-01.3 要求本波次落实体；首个生产消费者是 T-10/T-12；假接线违反 E-052 |
| W1-ctx | T-08 冻结新形状，同时保留 `bindings[0]` 派生的 `accountId`/`windowStartEmailId` 至 T-11 | 否则 T-09 基线物理上不可能绿；派生自 Binding 不读主表列 |
| W1-sig | `establishSession(c, lid, sec, options={})` | 第 4 位已被 `deps` 占用 |
| W1-idem | `Idempotency-Key` 在 `share-api.js` 读头，服务收普通参数 | 与 create 端点同形；`ctx()` 无 `c.req` |
| W1-quota | T-06 配额 UPDATE 失败必须拒发；改写 AC-LIFE-14 旧断言 | T-06 正文即闸门；旧「统计失败仍签发」不再适用于配额 |
| W1-fc | T-05 钉死安装 `fast-check`（精确版本，查 registry） | 属性测试当前跑不了 |
| W0R-P0-1 | CHANGE：子项 Evidence 补齐 verify→EXIT / files:lines / AC | review-w0 P0-1；本轮已改 tasks.md |
| W0R-P0-2 | HOLD：V2/双写/事件符号本波次无生产消费者是规格预期 | 首个消费者 T-12/T-13/T-15/T-16/T-18；假 import 违反 E-052；与 T01-P0-2 同形 |
| W0R-P0-3 | CHANGE：seed ID 改为 `Number.isSafeInteger(v) && v > 0` | 现 `v > 0` 放过 `"1e3"`/`true`/`Infinity`；违反 T-04.3 |
| W0R-P1-2 | CHANGE：`logShareEvent` 后写 canonical `event` | `fields.event` 当前可覆盖事件名 |
| W0R-P1-1 | 登记债：鉴权围栏 AST 化推迟到 T-08 | T-08 会改 `row.accountId` 读点，现在加严会白做 |
| T05-attach | 登记债：附件 `effectiveStatus !== 'ACTIVE'` 闸门归 T-08 | AC-SESS-06 附件面部分未达成；T-05 禁改该文件 |
| T06-R1 | CHANGE：tasks T-06.2 `last_access_at` 进闸门成功语句 | 与 design.md:280 / W1-quota 对齐 |
| T06-R2 | CHANGE：本 charter 新增 AC-SESS-11；旧 AC-LIFE-14 加 superseded 注 | 不改旧 charter 正文 |
| T06-R3 | 两处打 `denied_quota`，`reason`=`quota_snapshot`/`quota_race` | 只打闸门处则日常触顶零日志 |
| T07-S1 | KV `expirationTtl`：`remaining < 60` 跳过写；≥60 时 `min(120, remaining)` | Workers KV 最小值 60，临期写必然抛错 |
| T12-R1 | create/update 写入侧拒绝 `refreshIntervalMs<3000`；下发侧钳制属 T-08 | 红灯 AC-CAP-06 与绿灯「钳制」打架，按写入/下发拆 |
| T12-R2 | Expand 双写主表 `window_start_email_id` = 主 Binding 快照 | 不写则旧 Worker 窗口下界 0，越权读历史邮件 |
| T12-R3 | V2=false 另拒非 NULL `message_limit`(AC-LIFE-11 ⑤)；`onlyMessagesAfterCreated=false` / `showFullAddress=1` 接受 | 前者同构扩可见集；后两者由 R2 双写或旧默认覆盖 |
| T12-R5 | AuthKey pepper 复用 `SHARE_SEC_PEPPER` / `SHARE_SEC_PEPPER_KID`，落断言交 T-08 | 不新开环境变量 |
| T12-R6a | 授权改写 `mail-share-service.spec.js` 四条 W0 双写用例为 seed 工厂 | create 之后必写 binding，原前提失效 |
| T12-R6b | `accountIds` 与 `accountId` 同时出现时以 `accountIds` 为准 | 同时发只可能是 bug |
| T07-R1 | CHANGE:KV 查询在 `loadLiveAccount` 之后、快照配额/`assertAllowed` 之前 | design.md:357 / AC-SESS-10 `max_sessions=1` 重试;派单原位置会先被 `quota_snapshot` 拦死 |
| T07-A1 | HOLD:工件审查 A1「未写完成判决」不挡 T-07 收口 | T-07 成功态是后端 AC-SESS-10;前端入口属 T-26;代码审查 APPROVED p0=0 |
| T07-A2 | HOLD:跨 PoP 60s miss 再耗一格 | design.md:241 已写为 fail-open 风险窗口,不是未文档化缺陷 |
| T08-AUTH | HOLD:过期/撤销 + 错 Key 先撞 `SHARE_AUTH_REQUIRED` | 过了 lid+sec 才暴露 AuthKey 存在性；P-AUTH-01 只覆盖 lid 不存在 / sec 错 |
| T08-FENCE | CHANGE:主表 `row.accountId` 读取围栏 4→3 | T-08 集合化吸收了 establish/resolve 直读，棘轮只许降 |
| T08-C1 | CHANGE:配额 UPDATE 谓词加快照 `auth_key_enabled` | enable 不 bump cv；漏谓词可无 Key 签发 |
| T08-I1 | CHANGE:KV hit 必须 token.cv === 行.cv | 否则 reset 后同 idem 返回必死 token |
| T08-M1 | CHANGE:围栏注释改写 | `:284` 在 `assertAllowed`，不是零 Binding 回落 |
| T12-P0-1 | CHANGE:兼容载荷持久化并接受旧 4 字段指纹 | 主 AI 复算 d5c870…≠6ddde5…；关 AC-CAP-14 滚动窗口 |
| T12-P1-1 | CHANGE:toFlag/toNullableCount 封闭值域 | `invalid`/`true` 不得静默变 1 |
| T10-DESC | CHANGE:访客列表 ASC 黄金断言随 T-10 改为 DESC | design `listForBinding` + GET /share/mails；`share-api.js` nextCursor 仍取本页最后一行 |
| T13-DUP | HOLD:同一 account 同时出现在 add+remove → `SHARE_BINDING_DUPLICATE` | 同批 INSERT 在 DELETE 前；想重绑分两次 |
| T13-P0-1 | CHANGE:batch 写入侧钉死预检 Binding 集合；并发双替换不得变成 1→N | 审查 P0-1；D1 0-row DELETE 不回滚 |
| T13-P1-1 | CHANGE:`prepareBindingInsert` 绑定预算压到 ≤100；N=48/50 真实 owned 回归 | 官方 D1 Maximum bound parameters per query = 100 |
| T11-P1-1 | CHANGE:`maskAddress` 拒绝多 `@` 与空白，双态均 `***` | review-t11；formal `local@domain` |
| T14-R2 | HOLD:`share-api` 直调 repo 不另造 status service | review-t14 APPROVED |
| T15-STATUS | CHANGE:list 实现 `status?` 计算态筛选（design API 表有） | recon-t15；与分页 total 同一 CASE |
| T15-V2 | CHANGE:update 同时接 FINITE_MAX_SESSIONS 与 MESSAGE_LIMIT | exec-t12-note 第 5 条 |
| T15-PATCH | HOLD:禁止 update 复用 `normalizeCreateBody` | 缺省会重置未提交字段 |
| T15-PERM | HOLD:`security.js` 新路径留给 T-17 | 与 T-13 bindings 同形缺口 |
| T15-P1-1 | CHANGE:带 `status?` 的 list 走默认 page=1/size=20，无参才 deprecated 500 | review-t15；design.md:301 无参 ≠ 筛选单参 |
| T15-P1-2 | CHANGE:幂等 DELETE 经 `mail_share.user_id` EXISTS 回查，不再用子表 user_id | review-t15；无 FK 下他人 delete 不可误删调用方幂等行 |
| T16-HTTP | CHANGE:HTTP enable 用 `worker.fetch(req, env)` 喂测试 env，SELF.fetch 改 env 无效 | exec-t16-note；不改 wrangler-vitest.toml |
| T17-BOTH | HOLD:T-17 必须同时扩 `premKey` 与 `requirePermsExact`，只加一张会自锁或空转 | recon-t17-perm |
| T17-ADMIN | HOLD:admin 邮箱绕过 perm 的正向契约用例本轮不补 | 与负向种子禁 admin 贴边；登记债等单独任务 |
| T18-DUAL | CHANGE:级联双臂 — Binding 为主，无 Binding 遗留行回落主表 `account_id` | recon-t18；两臂互斥，不造第二真源 |
| T18-ORPHAN-REVOKE | CHANGE:cleanup 孤儿补偿后剩 0 活邮箱则 REVOKED | 与成功态「剩 0 则撤销」对齐，避免占活跃名额 |
| T18-P2-1 | HOLD:cleanup 用例不单独证伪「单 batch / 主表最后」 | review-t18 P2；当前实现已是单 batch，不为本轮扩测 |
| T19-P1-1 | CHANGE:leak 守卫从整格相等改为 `instr` 子串 | review-t19；`db1e511` |
| T20-ASIDE | CHANGE:T-20 纳入 aside 个人组入口，复用既有 `shareManage` 键 | recon-t20；不改 i18n 文件 |
| T20-ACTIONS | HOLD:行内撤销/删除按钮归 T-21 | T-20 只列表+筛选+分页 |
| T20-CARD | CHANGE:列表走卡片轨，不走 `el-table` | recon-t20；决定 W4 视觉基调 |
| T20-ROUTE | CHANGE:路由对象落 `perm/perm.js` 的 `routers['share:manage']`，`router/index.js` 0 行 | 任务书字面与 permsToRouter 互斥，取可执行的那个 |
| T21-INLINE | HOLD:一次性密钥不抽 `OneShotSecret.vue`，抽屉内联 | recon-t21 F1；T-22 若已合入再抽不迟 |
| T21-RESET-BOX | CHANGE:`resetUsedSessions` 走弹窗，不走内联复选框 | recon-t21 F2；任务书「确认交互」字面；一辈子第一次 |
| T21-FLIP | CHANGE:翻面 `index.spec.js` 行内 0-button 断言并在 exec note 原文登记 | recon-t21 F3；T-20 预留的交接闸门，禁止删除 |
| T22-V2-COLLIDE | CHANGE:V2 只能撞后降级；unknown 不预置灰；不加 worker 探测、不加 Vite 常量 | recon-t22 F1(a)；W3 封口；禁第二真源 |
| T22-CREATE-EXPAND | CHANGE:T-22 就地条件展开 `createMailShare`；禁止 `createMailShareV2` | recon-t22 F2(i)；旧四键 `toEqual` 必须仍绿 |
| T22-AFTER-T21 | CHANGE:T-21 先落 `index.vue`/`index.spec.js`/`status.js`；T-22 其后 rebase，且不碰 `status.js` | recon-t21 §4.4；否决 T-22 先跑 |
| T21-P1-1 | CHANGE:抽屉用 `reqGen` 丢弃迟到响应；切分享/关闭都 bump | review-t21；展示 A 写 B / 错 Key / 错关 |
| T21-P2-1 | CHANGE:AuthKey 成功后 `authKeyOnce = authKey \|\| ''`，disable 清空明文 | review-t21；失效 Key 不得继续留在 DOM |

## 冲突热区占用

| 文件 | 当前写者 | 备注 |
|---|---|---|
| `init.js` | T-01 收口 | 其后只读 |
| `mail-vue/src/request/mail-share.js` | T-20 已入库 `672da73` | T-21 只消费新函数 |
| `mail-vue/src/views/share-admin/*` | T-21 已收口 `00b0ae1`/`5af8675` | T-22 只许 `index.vue` header「新建」锚点；`status.js` / 抽屉 0 行 |
| `mail-vue/src/perm/perm.js` | T-20 已入库 `672da73` | 其后只加路由须新任务 |
| `share-auth-service.js` | T-08 复审通过 | T-09 只跑测；形状已冻结 |
| `share-api.js` | T-14 已入库 `d6fa50b` | 其后只加路由须新任务；W3 不写此文件 |
| `security.js` | T-17 已入库 `d18f027` | 其后只读，除非再加 Owner 路径 |
| `mail-share-service.js` | T-18 已入库 `73dc371` | 其后只读，除非再开任务 |
| `mail-share-cleanup-service.js` | T-18 已入库 `73dc371` | 其后只读 |
| `share-scoped-email-repository.js` | T-14 已加 `latestByBinding` | 只读，除非范围模型再变 |
| i18n | 无 | T-29 收口 |

## Update Log

- 2026-08-24 · 主 AI：T-21 R2 APPROVED p0=0。P1-1/P2-1 CLOSED。主 AI 独立 64/64 + 全量 vue 20/161 · worker 18/619 · E2E 13。未勾选尾：T-23 入库 / T-22 → T-29。
- 2026-08-24 · 主 AI：T-21 实现 `00b0ae1`。审查 NEEDS_CHANGES p0=0 p1=1 p2=1。T21-P1-1/P2-1 均 CHANGE。定点 4 files / 64 tests。R2 pending。未勾选尾：T-21 R2 / T-23 入库 / T-22 → T-29。
- 2026-08-24 · 主 AI：T-20 审查 APPROVED p0=0。T-22 侦察已落。T-21 迷雾已裁（内联密钥 / 弹窗清零 / 翻面登记）。T-22 迷雾已裁（撞后降级 / 条件展开 create / T-21 先于 T-22）。未勾选尾：T-21 → T-29。
- 2026-08-24 · 主 AI：T-20 `672da73` 入库。主 AI 独立定点 20/20 + 全量 vue 18/113 · worker 18/619 · E2E 13 · build 绿。审查 pending。未勾选尾：T-20 审查 / T-21 → T-29。
- 2026-08-24 · 主 AI：T-19 `03d987c` / P1 `db1e511` 入库。R2 APPROVED。主 AI 独立 38/38 + 全量 18/619 · 17/95 · E2E 13。T-20 侦察已落。未勾选尾：T-20 → T-29。
- 2026-08-24 · 主 AI：T-18 `73dc371` 入库。审查 APPROVED p0=0。主 AI 独立 27/27 + 全量 18/598 · 17/95 · E2E 13。T-19 侦察已落。未勾选尾：T-19 → T-29。
- 2026-08-24 · 主 AI：T-17 审查 APPROVED。T-18 侦察已落。T18-DUAL / T18-ORPHAN-REVOKE 已裁。未勾选尾：T-18 → T-29。
- 2026-08-24 · 主 AI：T-16 审查 APPROVED。T-17 `d18f027` 入库。主 AI 独立 148/148 + 全量 18/577 · 17/95 · E2E 13。未勾选尾：T-17 审查 / T-18 → T-29。
- 2026-08-24 · 主 AI：T-16 `3bb1d55` 入库。主 AI 独立 219/219 + 全量 18/465 · 17/95 · E2E 13。T-17 侦察已落（premKey 与 requirePermsExact 必须同改）。未勾选尾：T-16 审查 / T-17 → T-29。
- 2026-08-24 · 主 AI：T-15 R2 APPROVED p0=0。未勾选尾：T-16 → T-29。
- 2026-08-24 · 主 AI：T-15 审查 NEEDS_CHANGES p1=2。T15-P1-1/P1-2 CHANGE。定点红 3 → 绿 198/198；全量 18/444 · 17/95 · E2E 13。T-16 侦察已落。未勾选尾：T-15 复审 / T-16 → T-29。
- 2026-08-24 · 主 AI：T-15 `1d49bb4` 入库。T-11 R2 APPROVED。主 AI 独立 195/195 + 全量 18/441 · 17/95 · E2E 13。未勾选尾：T-15 审查 / T-16 → T-29。
- 2026-08-24 · 主 AI：T-11 P1-1 `e63998e`。T-14 审查 APPROVED。T-15 侦察已落。未勾选尾：T-11 复审 / T-15 → T-29。
- 2026-08-24 · 主 AI：T-11 `bee72b6` + T-14 `d6fa50b` 入库。T-13 R2 APPROVED。主 AI 独立 135/135 + 全量 18/410 · 17/95 · E2E 13。未勾选尾：T-11/T-14 审查 → T-15 → T-29。
- 2026-08-24 · 主 AI：T-13 CHANGE 入库 `22d9832`。T-08 R2 APPROVED p0=0。主 AI 独立 164/164 + 全量 17/358 · 17/95 · E2E 13。未勾选尾：T-13 复审 / T-11 / T-14 → T-29。
- 2026-08-24 · 主 AI：T-10 审查 APPROVED p0=0。T-13 审查 NEEDS_CHANGES：P0-1/P1-1 均 CHANGE。未勾选尾：T-13 审查修复 → T-11 / T-14 → T-29。
- 2026-08-24 · 主 AI：T-10 `bca7bc2` + T-13 `ee2db41` 入库。主 AI 独立定点 189/189 + 全量 worker 17/349、vue 17/95、E2E 13，均为 EXIT=0。未勾选尾：T-11 / T-14 → T-29。
- 2026-08-24 · 主 AI：T-09 Evidence 回写 `dd1de15`。未勾选尾：T-10 / T-11 / T-13 → T-29。
- 2026-08-24 · 主 AI：T-08/T-12 复审均 APPROVED p0=0（`review-t08-r2.md` / `review-t12-r2.md`）。T-09 冻结公告已落。并行派 T-10 / T-13。未勾选尾：T-10 / T-11 / T-13 → T-29。
- 2026-08-24 · 主 AI：T-08 CHANGE 入库 `bc2b4e2`，T-12 CHANGE 入库 `6b5d29b`。主 AI 独立 90/90 + 132/132 + 全量 17/317 · 17/95 · E2E 13，均为 EXIT=0。未勾选尾：复审 → T-09 / T-10 / T-13 → T-29。
- 2026-08-24 · 主 AI：T-08/T-12 代码审查均 NEEDS_CHANGES。T08-C1/I1/M1 CHANGE；T12-P0-1/P1-1 CHANGE（哈希 d5c870…≠6ddde5… 已独立复算）。并行派修复，文件不重叠。未勾选尾：T-08/T-12 审查收口 → T-09 / T-10 / T-13 → T-29。
- 2026-08-24 · 主 AI：T-08/T-12 工件审查均 NEEDS_CHANGES。T08-A1 CHANGE（统一快照）；T08-A2/A3/A4 HOLD。T12-A1/H1 HOLD；T12-E1 CHANGE。代码审查未回。未勾选尾：T-09 / T-10 / T-13 → T-29。
- 2026-08-24 · 主 AI：T-08 `5a81065` + T-12 `b6f5a28` 入库。主 AI 独立 185/185、全量 worker 17/289、vue 17/95、E2E 13，均为 EXIT=0。ShareContext 已冻结。未勾选尾：T-09 / T-10 / T-13 → T-29。
- 2026-08-24 · 主 AI：T07-R1 CHANGE（KV 在配额判定前）。主 AI 独立复跑 auth 34/34、share-api 7/7，均为 EXIT=0。前端 Idempotency-Key 归 T-26。未勾选尾：T-08 / T-12 → T-29。
- 2026-08-24 · 主 AI：T-06 审查 APPROVED、p0=0。循环 import 与空 `options` HOLD。未勾选尾：T-07 / T-12 → T-29。
- 2026-08-24 · 主 AI：裁 T-12 R1/R2/R3/R5/R6 并回写 design/requirements。派 T-07 与 T-12 并行（文件不重叠）。未勾选尾：T-07 / T-12 → T-29。
- 2026-08-24 · 主 AI：T-06 提交 `6209960`。独立复跑 auth spec 26/26、worker 17/213、vue 17/95、E2E 13，均为 EXIT=0。未勾选尾：T-07 → T-29。
- 2026-08-24 · 主 AI：Goal 武装；核验 HEAD=`e120a04` 无实现；建分支 `cursor/mailbox-share-capability-dcb6`；派 T-01 executor + W0 recon。
- 2026-08-24 · executor(T-01)：TDD 红→绿完成，**未提交**。红：`pnpm --dir mail-worker exec vitest run test/v3-2-db.spec.js` → 12/12 failed（`dbInit.v3_2DB is not a function` / `no such table: mail_share_binding`）；T-01.3 红（stash 掉 `src/entity` 后）`mail-share.schema.spec.js` 模块解析失败。绿：同命令 12/12 passed，`mail-share.schema.spec.js` 6/6 passed，全量 `pnpm --dir mail-worker test` 17 文件 / 153 测试全绿（基线 16/138，净增 1 文件 15 测试）。改动：`src/init/init.js`（注册链 `v3_1DB` 之后加 `v3_2DB`；11 条 expand-only ALTER + `mail_share_binding` + `idx_msb_share_account`/`idx_msb_account` + 两条幂等 SQL 收敛到 `backfillShareBindings` / `revokeInvalidShares` 两个唯一 SQL 真源 + `share.migrate.invalid_row` 结构化日志）、`src/entity/mail-share.js`（+11 列映射，`access_count` 物理名保留、无 `share_type`）、新增 `src/entity/mail-share-binding.js`、新增 `test/v3-2-db.spec.js`、扩展 `test/mail-share.schema.spec.js`。零 DROP / 零 RENAME / 未建 `mail_share_auth_fail` / 未动 `SHARE_CAPABILITY_V2` / 未动 `share-auth-service.js`·`mail-share-service.js`·`security.js`·`wrangler.toml`·i18n·tasks.md。遗留风险见回复。
- 2026-08-24 · 主 AI：独立复跑 `pnpm --dir mail-worker test` → 17/153 绿。tasks.md 勾选 T-01。裁决 R1/R3/R5 如上。准备提交本批并派 T-02–T-04 串行 executor + T-01 reviewer。
- 2026-08-24 · 主 AI：独立复跑三套 EXIT=0（worker 17/180、vue 17/95、E2E 13）。tasks.md 勾选 T-02/T-03/T-04；补 T-01 Evidence EXIT/行号。T-01 审查 P0-1 CHANGE、P0-2 HOLD。准备提交 W0 剩余并派 T-05。
- 2026-08-24 · 主 AI：W0 P0-3/P1-2 独立复跑 `mail-share-service.spec.js` + `mail-share.schema.spec.js` → EXIT=0（72/72）。只提交 setup/log 三文件，不带 T-06 在途 diff。未勾选尾：T-06 → T-29。
- 2026-08-24 · 主 AI：T-05 提交 `c7789e6`。关 T-06 文档门：tasks T-06.1/T-06.2/T-08.1 对齐 design；新增 AC-SESS-11；旧 mail-share AC-LIFE-14 加 superseded。W0 审查 P0-2 HOLD、P0-1 CHANGE 已补 Evidence。未勾选尾：T-06 → T-29。
- 2026-08-24 · 主 AI：独立复跑 T-05 `share-auth-service.spec.js` → EXIT=0（16/16）；`pnpm --dir mail-worker test` → EXIT=0（17/185）。W0 审查 CHANGES_REQUIRED：P0-1 CHANGE（补 Evidence 四要素）、P0-2 HOLD（接线属 T-12+）、P0-3 CHANGE（seed ID）。附件触顶拒下载登记 T-08。未勾选尾：T-06 → T-29。
- 2026-08-24 · 主 AI：T-03.1/T-03.2/T-04 子项 Evidence `commit` 全部回写为 `e878760`。并行派 W0 阶段审查 + T-05 executor。未勾选尾：T-05 → T-29。
- 2026-08-24 · executor(T-02→T-03→T-04 串行)：三任务 TDD 红→绿完成，**未提交**、**未动 tasks.md**。**T-02** 红：`pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/mail-share.schema.spec.js` → 4 failed（`syncPrimaryAccountId is not a function`），绿：同命令 34/34 passed。新增 `syncPrimaryAccountId(c, shareId)`（**返回未执行的 D1 语句**供 T-12/T-13/T-18 塞进同一 `c.env.db.batch()`；单条条件 UPDATE，`SET` 与 `EXISTS` 两处子查询都带 `b.account_id > 0`，无可用 Binding 时零变更 → 绝不写 0）。grep 断言落在 `mail-share.schema.spec.js`（`?raw` 导入源码）：`share-auth-service.js` 恒为 4 处 `row.accountId`（允许清单冻结至 T-08）、`share-scoped-email-repository.js` 恒为 0。**T-03** 红：同 spec → 17 failed（`SHARE_V2_INTENT` undefined / `assertCapabilityV2` is not a function / `SHARE_BINDING_LIMIT` undefined），绿：43/43 passed。新增 `assertCapabilityV2(c, intent)`（env 解析照 `isShareDisabled` 形状，缺失/`false`/`0`/`''` 一律 false → `BizError('SHARE_INVALID_CONFIG')`；只认环境变量，不读 `setting` 死分支）、`SHARE_BINDING_LIMIT=50`、`SHARE_V2_INTENT` 四意图常量、`SHARE_EVENT` 六事件名常量 + `logShareEvent(event, fields)`（一行 JSON，恒带 `requestId`/`shareId`）。`wrangler.toml` 仅注释声明 `SHARE_CAPABILITY_V2`（照裁决 R5，未硬写 false）；`wrangler-vitest.toml` 写 `"false"`。init.js 未动，其 `share.migrate.invalid_row` 保持字面量，并加守护断言「init.js 不 import mail-share-service」。**T-04** `test/setup.js` 只加 seed 工厂 `seedShareRow`（含 v3_2DB 全部新列，`userId`/`accountId` 非正即抛，杜绝 0 主账号）与 `seedBindingRow`，**零 DDL**（建表仍只在 init.js）；三套基线以注释记录（历史地板 16/138、17/95、E2E 13；T-01 后 worker 17/153 且会继续涨，故不写成断言）。三套全绿：worker **17 文件 / 180 测试**、vue **17 文件 / 95 测试**、E2E **13 passed**（Linux 上 `node tests/e2e/run.mjs` 正常跑通，无需 mark unverified）。旧凭据断言（lid 128-bit / sec 256-bit / HMAC 存库）与 `SHARE_ACTIVE_LIMIT`/`SHARE_MAX_DURATION_SECONDS` 上限断言全部原样保留未改写。改动仅 6 文件：`src/service/mail-share-service.js`、`test/mail-share-service.spec.js`、`test/mail-share.schema.spec.js`、`test/setup.js`、`wrangler.toml`、`wrangler-vitest.toml`。未动 `init.js`·`share-auth-service.js`·`security.js`·i18n·charter specs·mail-vue。遗留风险见回复。
