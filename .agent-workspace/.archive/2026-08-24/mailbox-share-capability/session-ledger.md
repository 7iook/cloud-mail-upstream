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
| W0 | T-02 / T-03 / T-04 | ✅ 已实现，待提交 | executor | 主 AI 三套 17/180 · 17/95 · 13 |
| W1 | T-05→T-08 侦察 | ✅ 已落盘 | plan-reality-recon | `recon-w1-auth-chain.md` |
| W1 | T-05 | ⏳ 下一派 | executor | 等本批 commit |
| W1–W6 | T-06–T-29 | 未开始 | — | 等 T-05 |

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

## 冲突热区占用

| 文件 | 当前写者 | 备注 |
|---|---|---|
| `init.js` | T-01 收口 | 其后只读 |
| `share-auth-service.js` | T-05 即将独占 | W1 串行 |
| `share-api.js` | 无（T-07 起写） | 热区补登记 |
| `security.js` | 无 | T-14 / T-17 |
| `mail-share-service.js` | 无 | W2/W3 串行 |
| i18n | 无 | T-29 收口 |

## Update Log

- 2026-08-24 · 主 AI：Goal 武装；核验 HEAD=`e120a04` 无实现；建分支 `cursor/mailbox-share-capability-dcb6`；派 T-01 executor + W0 recon。
- 2026-08-24 · executor(T-01)：TDD 红→绿完成，**未提交**。红：`pnpm --dir mail-worker exec vitest run test/v3-2-db.spec.js` → 12/12 failed（`dbInit.v3_2DB is not a function` / `no such table: mail_share_binding`）；T-01.3 红（stash 掉 `src/entity` 后）`mail-share.schema.spec.js` 模块解析失败。绿：同命令 12/12 passed，`mail-share.schema.spec.js` 6/6 passed，全量 `pnpm --dir mail-worker test` 17 文件 / 153 测试全绿（基线 16/138，净增 1 文件 15 测试）。改动：`src/init/init.js`（注册链 `v3_1DB` 之后加 `v3_2DB`；11 条 expand-only ALTER + `mail_share_binding` + `idx_msb_share_account`/`idx_msb_account` + 两条幂等 SQL 收敛到 `backfillShareBindings` / `revokeInvalidShares` 两个唯一 SQL 真源 + `share.migrate.invalid_row` 结构化日志）、`src/entity/mail-share.js`（+11 列映射，`access_count` 物理名保留、无 `share_type`）、新增 `src/entity/mail-share-binding.js`、新增 `test/v3-2-db.spec.js`、扩展 `test/mail-share.schema.spec.js`。零 DROP / 零 RENAME / 未建 `mail_share_auth_fail` / 未动 `SHARE_CAPABILITY_V2` / 未动 `share-auth-service.js`·`mail-share-service.js`·`security.js`·`wrangler.toml`·i18n·tasks.md。遗留风险见回复。
- 2026-08-24 · 主 AI：独立复跑 `pnpm --dir mail-worker test` → 17/153 绿。tasks.md 勾选 T-01。裁决 R1/R3/R5 如上。准备提交本批并派 T-02–T-04 串行 executor + T-01 reviewer。
- 2026-08-24 · 主 AI：独立复跑三套 EXIT=0（worker 17/180、vue 17/95、E2E 13）。tasks.md 勾选 T-02/T-03/T-04；补 T-01 Evidence EXIT/行号。T-01 审查 P0-1 CHANGE、P0-2 HOLD。准备提交 W0 剩余并派 T-05。
- 2026-08-24 · executor(T-02→T-03→T-04 串行)：三任务 TDD 红→绿完成，**未提交**、**未动 tasks.md**。**T-02** 红：`pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/mail-share.schema.spec.js` → 4 failed（`syncPrimaryAccountId is not a function`），绿：同命令 34/34 passed。新增 `syncPrimaryAccountId(c, shareId)`（**返回未执行的 D1 语句**供 T-12/T-13/T-18 塞进同一 `c.env.db.batch()`；单条条件 UPDATE，`SET` 与 `EXISTS` 两处子查询都带 `b.account_id > 0`，无可用 Binding 时零变更 → 绝不写 0）。grep 断言落在 `mail-share.schema.spec.js`（`?raw` 导入源码）：`share-auth-service.js` 恒为 4 处 `row.accountId`（允许清单冻结至 T-08）、`share-scoped-email-repository.js` 恒为 0。**T-03** 红：同 spec → 17 failed（`SHARE_V2_INTENT` undefined / `assertCapabilityV2` is not a function / `SHARE_BINDING_LIMIT` undefined），绿：43/43 passed。新增 `assertCapabilityV2(c, intent)`（env 解析照 `isShareDisabled` 形状，缺失/`false`/`0`/`''` 一律 false → `BizError('SHARE_INVALID_CONFIG')`；只认环境变量，不读 `setting` 死分支）、`SHARE_BINDING_LIMIT=50`、`SHARE_V2_INTENT` 四意图常量、`SHARE_EVENT` 六事件名常量 + `logShareEvent(event, fields)`（一行 JSON，恒带 `requestId`/`shareId`）。`wrangler.toml` 仅注释声明 `SHARE_CAPABILITY_V2`（照裁决 R5，未硬写 false）；`wrangler-vitest.toml` 写 `"false"`。init.js 未动，其 `share.migrate.invalid_row` 保持字面量，并加守护断言「init.js 不 import mail-share-service」。**T-04** `test/setup.js` 只加 seed 工厂 `seedShareRow`（含 v3_2DB 全部新列，`userId`/`accountId` 非正即抛，杜绝 0 主账号）与 `seedBindingRow`，**零 DDL**（建表仍只在 init.js）；三套基线以注释记录（历史地板 16/138、17/95、E2E 13；T-01 后 worker 17/153 且会继续涨，故不写成断言）。三套全绿：worker **17 文件 / 180 测试**、vue **17 文件 / 95 测试**、E2E **13 passed**（Linux 上 `node tests/e2e/run.mjs` 正常跑通，无需 mark unverified）。旧凭据断言（lid 128-bit / sec 256-bit / HMAC 存库）与 `SHARE_ACTIVE_LIMIT`/`SHARE_MAX_DURATION_SECONDS` 上限断言全部原样保留未改写。改动仅 6 文件：`src/service/mail-share-service.js`、`test/mail-share-service.spec.js`、`test/mail-share.schema.spec.js`、`test/setup.js`、`wrangler.toml`、`wrangler-vitest.toml`。未动 `init.js`·`share-auth-service.js`·`security.js`·i18n·charter specs·mail-vue。遗留风险见回复。
