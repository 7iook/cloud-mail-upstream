# Task Tracker · mailbox-share-capability

> **What this is** — 本 charter 的 LIVING 执行清单(Template 3)。执行者实时读取、逐项勾选、在每项下追加一行更新日志。它是「已完成 / 未完成 / 受阻」的唯一真源。**格式固定,勿改版式**;勾 `- [x]` 必须带证据(red+green 命令输出 / 文件路径 / commit),否则保持 `- [ ]`。

| 字段 | 值 |
|---|---|
| 来源 Source | docs/specs/mailbox-share-capability/design.md(converged,R1–R3 已裁决) |
| 类型 Type | feature |
| 创建 Created | 2026-08-24 |
| 状态 Status | in-progress · W0/W1 收口 · T-12 复审通过 · T-09 冻结 · T-10/T-13 并行 |

**图例 Legend**: `- [ ]` 待办 · `- [x]` 完成(必须带证据) · 行尾 `— ⛔ BLOCKED:<原因>` / `— ⏭ SKIPPED:<理由>` / `— ⏳ PENDING:<原因>` · 子任务标 `*` = red→green 测试类子任务(TDD 红灯先行)

## Overview

交付顺序一句话:**W0 迁移+双写+V2 栅栏+测试基建 → W1 授权链串行改造(配额闸门/KV 幂等/四态/AuthKey) → W2 Binding CRUD+范围集合化+status 端点 → W3 Owner API+perm+cleanup → W4 前端管理模块 → W5 访客页多邮箱 → W6 E2E 扩展+文档收口**;基线守恒(worker 138 / vue 95 / E2E 13 全绿)贯穿全程,单邮箱旧断言只扩展不改写。

## 冲突热区 · 单 owner 铁律

| 文件 | 唯一写者 | 规则 |
|---|---|---|
| `mail-worker/src/init/init.js` | T-01 | v3_2DB 全部 DDL/回填/门禁只落 T-01;其余任务只读 |
| `mail-worker/src/service/share-auth-service.js` | W1(T-05→T-06→T-07→T-08) | W1 内严格串行,禁止并行派发;ShareContext 形状在 T-08 冻结后 W2 才可消费 |
| `mail-worker/src/api/share-api.js` | W1(T-07/T-08 读头透传)→T-14(status 端点) | 热区表补登记(recon-w1);W1 与 T-14 跨波次串行 |
| `mail-worker/src/security/security.js` | T-14(excludeExact 一行)、T-17(premKey) | 两处改动跨波次天然串行;同波次内禁止第二写者 |
| `mail-worker/src/service/mail-share-service.js` | 同波次内单写者(W2:T-12→T-13 串行;W3:T-15→T-16→T-18 串行) | 跨波次串行,波次内不并行 |
| `mail-vue/src/i18n/zh.js` / `en.js` | T-28 统一收口 | W4/W5 各任务只在任务文档记录所需新键,不直接改 i18n 文件 |

---

## Tasks

### W0 · 地基:迁移 / 双写 / V2 栅栏 / 测试基建

- [x] T-01 v3_2DB 迁移:`mail_share` 加列 + `mail_share_binding` 新表 + 门禁回填(⚠️ 模型/迁移级变更,方案已由 design.md R2-A4/R3-A2 裁决,执行不得偏离两条幂等 SQL)
  - **Evidence**
    - verify: 红 `pnpm --dir mail-worker exec vitest run test/v3-2-db.spec.js` → EXIT=1（12 failed, `v3_2DB is not a function`）；绿同命令 → EXIT=0（12 passed）；主 AI `pnpm --dir mail-worker test` → EXIT=0（当时 17/153）
    - files: `mail-worker/src/init/init.js:33,38-137` · `mail-worker/src/entity/mail-share.js:21-31` · `mail-worker/src/entity/mail-share-binding.js:1-10` · `mail-worker/test/v3-2-db.spec.js:1-367` · `mail-worker/test/mail-share.schema.spec.js:18-140`
    - AC: AC-BIND-09, AC-BIND-11, AC-LIFE-08, AC-EDGE-09
    - commit: 4f72418
  - [x]* T-01.1 红:新建 `mail-worker/test/v3-2-db.spec.js` —— 预置 v3_1 形状旧行(含 account 已删/归属不符/不存在三类脏行 + 合法行),断言:有效行恰一条 Binding 回填、脏行置 `REVOKED`(记 `revoked_at`)且零 Binding、重复跑幂等、`access_count` 原值保留;注入「旧写落在 INSERT 前 / INSERT 与 UPDATE 之间 / UPDATE 后 / 任务重启后」全部交错时序,断言合法无 Binding 晚写行不被误 REVOKED(R3-A2);跑一次确认因 `v3_2DB` 不存在而红
    - _Requirements: AC-BIND-09, AC-BIND-11, AC-EDGE-09_
    - **Evidence** verify: `pnpm --dir mail-worker exec vitest run test/v3-2-db.spec.js` → EXIT=1（12/12 failed, `dbInit.v3_2DB is not a function`） · files: `mail-worker/test/v3-2-db.spec.js:1-367` · AC: AC-BIND-09/11, AC-EDGE-09 · commit: 4f72418
  - [x] T-01.2 绿:`mail-worker/src/init/init.js` 注册链尾(`init.js:31-32` 之后)新增 `v3_2DB()`:11 条 `ALTER TABLE mail_share ADD COLUMN`(照 design「Data Models」清单,expand-only 零 RENAME 零 DROP)+ `CREATE TABLE IF NOT EXISTS mail_share_binding` + 两索引(`UNIQUE(share_id, account_id)`、`idx_msb_account`)+ 回填 `INSERT ... SELECT ... JOIN account ... WHERE NOT EXISTS`(门禁:存活/`is_del=NORMAL`/`user_id` 匹配)+ 无效行 `UPDATE ... SET status='REVOKED'`(显式 account 事实谓词,禁止以「无 Binding」判脏)+ `share.migrate.invalid_row` 结构化日志
    - _Requirements: AC-BIND-09, AC-BIND-11, AC-LIFE-08_
    - **Evidence** verify: `pnpm --dir mail-worker exec vitest run test/v3-2-db.spec.js` → EXIT=0（12 passed） · files: `mail-worker/src/init/init.js:33,38-137` · AC: AC-BIND-09/11, AC-LIFE-08 · commit: 4f72418
  - [x] T-01.3 实体:`mail-worker/src/entity/mail-share.js` 加 11 列映射;新建 `mail-worker/src/entity/mail-share-binding.js`;`mail-worker/test/mail-share.schema.spec.js` 扩展 DDL-实体一致性断言(新列 + binding 表 + 遗留列语义)
    - _Requirements: AC-LIFE-08_
    - **Evidence** verify: `pnpm --dir mail-worker exec vitest run test/mail-share.schema.spec.js` → EXIT=0 · files: `mail-worker/src/entity/mail-share.js:21-31` · `mail-worker/src/entity/mail-share-binding.js:1-10` · `mail-worker/test/mail-share.schema.spec.js:18-140` · AC: AC-LIFE-08 · commit: 4f72418

- [x] T-02 双写契约(Expand 阶段):`mail_share.account_id` = 主 Binding,鉴权零读取
  - **Evidence**
    - verify: 红 stash 回 T-01 后 `vitest run test/mail-share-service.spec.js test/mail-share.schema.spec.js` → EXIT=1（`syncPrimaryAccountId is not a function`）；绿同命令 → EXIT=0；主 AI `pnpm --dir mail-worker test` → EXIT=0（17/180）
    - files: `mail-worker/src/service/mail-share-service.js:275-289` · `mail-worker/test/mail-share-service.spec.js:463-529` · `mail-worker/test/mail-share.schema.spec.js:142-156`
    - AC: AC-LIFE-10, AC-BIND-01
    - commit: e878760
  - [x]* T-02.1 红:`mail-worker/test/mail-share.schema.spec.js` 与 `mail-worker/test/mail-share-service.spec.js` 加断言 —— 任何写路径后主表 `account_id` 恒等于现存最小 `binding_id` 的 `account_id` 且非 0;grep 级断言鉴权/范围代码(`share-auth-service.js`、`share-scoped-email-repository.js`)零读取 `mail_share.account_id`(双写路径除外)
    - _Requirements: AC-LIFE-10, AC-BIND-01_
    - **Evidence**
      - verify: `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/mail-share.schema.spec.js` → EXIT=0（54 tests）；grep 围栏冻结 `share-auth-service.js` 既有 4 处 `row.accountId` 至 T-08，`share-scoped-email-repository.js` 读取数 = 0
      - files: `mail-worker/test/mail-share.schema.spec.js:142-151` · `mail-worker/test/mail-share-service.spec.js:463-529`
      - AC: AC-LIFE-10, AC-BIND-01
      - commit: e878760
  - [x] T-02.2 绿:`mail-worker/src/service/mail-share-service.js` 新增 `syncPrimaryAccountId` 助手(单语句条件 UPDATE,供 T-12/T-13/T-18 在同一 `c.env.db.batch()` 内调用);迁移回填行天然满足(T-01 已带 account_id)
    - _Requirements: AC-LIFE-10_
    - **Evidence**
      - verify: `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js` → EXIT=0；helper 返回未执行 D1 语句；无 Binding 时零变更不写 0
      - files: `mail-worker/src/service/mail-share-service.js:275-289`
      - AC: AC-LIFE-10
      - commit: e878760

- [x] T-03 `SHARE_CAPABILITY_V2` 全能力栅栏基建(默认 false)
  - **Evidence**
    - verify: 红 helper 缺失 → EXIT=1；绿 `assertCapabilityV2` 四 intent 在 V2=false/missing 抛 `SHARE_INVALID_CONFIG`、V2=true 放行 → EXIT=0
    - files: `mail-worker/src/service/mail-share-service.js:16-82` · `mail-worker/wrangler.toml:58-60` · `mail-worker/wrangler-vitest.toml:40-41` · `mail-worker/test/mail-share-service.spec.js:557-674`
    - AC: AC-LIFE-11
    - commit: e878760
  - [x]* T-03.1 红:`mail-worker/test/mail-share-service.spec.js` 加断言 —— V2=false 时四路策略写入(multi create / bindings 使绑定数 1→N / AuthKey enable / 有限 `maxSessions`)一律 `SHARE_INVALID_CONFIG`;V2=true 放行
    - _Requirements: AC-LIFE-11_
    - **Evidence**
      - verify: `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js` → EXIT=0；按 intent 单测门控助手（四写路径尚未存在，接线属 T-12/T-13/T-15/T-16）
      - files: `mail-worker/test/mail-share-service.spec.js:595-632`
      - AC: AC-LIFE-11
      - commit: e878760
  - [x] T-03.2 绿:`mail-worker/src/service/mail-share-service.js` 新增 `assertCapabilityV2(c, intent)` 门控助手 + `SHARE_BINDING_LIMIT=50` 常量;`mail-worker/wrangler.toml` 声明 `SHARE_CAPABILITY_V2` 变量(默认 false);结构化观测事件名常量落位(`share.session.denied_quota` / `denied_auth` / `denied_cv` / `share.binding.cascade` / `share.migrate.invalid_row` / `share.system.error`,含 requestId/shareId 字段约定);各写入口的实际接线在 T-12/T-13/T-15/T-16 完成
    - _Requirements: AC-LIFE-11_
    - **Evidence**
      - verify: `git grep -n "SHARE_CAPABILITY_V2" -- mail-worker/wrangler.toml` → 仅注释声明；`wrangler-vitest.toml` 显式 `"false"`；缺省当 false
      - files: `mail-worker/src/service/mail-share-service.js:16-82` · `mail-worker/wrangler.toml:58-60` · `mail-worker/wrangler-vitest.toml:40-41`
      - AC: AC-LIFE-11
      - commit: e878760

- [x] T-04 测试基建扩展 + 基线守恒快照
  - **Evidence**
    - verify: 主 AI `pnpm --dir mail-worker test` → EXIT=0（17/180）；`pnpm --dir mail-vue test` → EXIT=0（17/95）；`node tests/e2e/run.mjs` → EXIT=0（13 passed）
    - files: `mail-worker/test/setup.js:18-126`
    - AC: AC-CAP-04, AC-CAP-11
    - commit: e878760
  - **Follow-up (W0 review P0-3 / P1-2)**
    - verify: 红 `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/mail-share.schema.spec.js` → EXIT=1（17 failed / 55 passed）；主 AI 绿同命令 → EXIT=0（72/72）
    - files: `mail-worker/test/setup.js:60-63,105,123` · `mail-worker/src/service/mail-share-service.js:73-83` · `mail-worker/test/mail-share-service.spec.js:556-730`
    - AC: AC-TEST-02
    - commit: 3cce543
  - [x] T-04.1 `mail-worker/test/setup.js` 扩展:binding 表建表/seed 工厂、含新列的 share 行工厂;记录三套基线数字(worker 16 文件/138、vue 17 文件/95、E2E 13)作为回归底线
    - **Evidence**
      - verify: `git grep -n "CREATE TABLE" -- mail-worker/test/setup.js` → 无匹配；历史地板 16/138、17/95、E2E 13 写在注释
      - files: `mail-worker/test/setup.js:17-126`
      - AC: AC-TEST-01, AC-TEST-02
      - commit: e878760
  - [x]* T-04.2 红→绿:跑 `pnpm --dir mail-worker test`、`pnpm --dir mail-vue test`、`node tests/e2e/run.mjs` 确认迁移落地后基线全绿(旧凭据规格断言 `lid` 128-bit/`sec` 256-bit/HMAC 存库、`SHARE_ACTIVE_LIMIT`/`SHARE_MAX_DURATION_SECONDS` 上限断言保持)
    - _Requirements: AC-CAP-04, AC-CAP-11_
    - **Evidence**
      - verify: `pnpm --dir mail-worker test` → EXIT=0（17/180）；`pnpm --dir mail-vue test` → EXIT=0（17/95）；`node tests/e2e/run.mjs` → EXIT=0（13 passed）；旧凭据/上限断言仍绿
      - files: `mail-worker/test/mail-share-service.spec.js:154-166,244-252,345` · `mail-worker/test/setup.js:17-20`
      - AC: AC-CAP-04, AC-CAP-11
      - commit: e878760

### W1 · 授权链改造(share-auth-service.js 单 owner,T-05→T-08 严格串行)

- [x] T-05 effectiveStatus 四态 + establish/resolve 差异放行
  - **Evidence**
    - verify: 红 `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js`（仅测试就位、源码回退 HEAD）→ EXIT=1（3 failed / 13 passed，行为缺失非语法）；绿同命令 → EXIT=0（16/16）；主 AI `pnpm --dir mail-worker test` → EXIT=0（17 files / 185 tests）
    - files: `mail-worker/src/service/share-auth-service.js:25-38,227-239,269,299,306` · `mail-worker/test/share-auth-service.spec.js:355-493` · `mail-worker/package.json:14`
    - AC: AC-LIFE-01, AC-LIFE-02, AC-LIFE-04, AC-LIFE-05, AC-LIFE-07, AC-SESS-06
    - commit: c7789e6
  - [x]* T-05.1 红:`mail-worker/test/share-auth-service.spec.js` 加 `effectiveStatus` 全组合真值表(property,fast-check ≥100 轮):优先级 REVOKED > EXPIRED > ACCESS_LIMIT_REACHED > ACTIVE、纯函数零写库;`establishSession` 拒一切非 ACTIVE,`resolveSession` 对 `ACCESS_LIMIT_REACHED` 放行(唯一差异态);扫表断言持久化 status 值域仅 ACTIVE/REVOKED
    - **P-LIFE-02: 状态判定纯函数性** _Validates: AC-LIFE-01, AC-LIFE-02_
    - **P-SESS-03: 触顶不清场** _Validates: AC-SESS-06, AC-LIFE-04_
    - _Requirements: AC-LIFE-01, AC-LIFE-02, AC-LIFE-04, AC-LIFE-05, AC-LIFE-07, AC-SESS-06_
    - **Evidence**
      - verify: 红同上命令 → EXIT=1（真值表拿到 ACTIVE、resolve 硬编码 ACTIVE、触顶行仍被 establish 放行）
      - files: `mail-worker/test/share-auth-service.spec.js:355-493`
      - AC: AC-LIFE-01, AC-LIFE-02, AC-LIFE-04, AC-SESS-06
      - commit: c7789e6
  - [x] T-05.2 绿:改造 `mail-worker/src/service/share-auth-service.js:25-33` `effectiveStatus` 加 `ACCESS_LIMIT_REACHED` 分支(`max_sessions IS NOT NULL AND access_count >= max_sessions`);`assertShareActive` 拆分为按调用方区分;`SHARE_ENABLED` 冻结语义与过期双重封顶断言保持
    - _Requirements: AC-LIFE-02, AC-LIFE-04_
    - **Evidence**
      - verify: 绿 `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js` → EXIT=0（16/16）；主 AI 全量 `pnpm --dir mail-worker test` → EXIT=0（17/185）；`fast-check` 精确钉 `4.9.0`
      - files: `mail-worker/src/service/share-auth-service.js:25-38,227-239,269,299,306` · `mail-worker/package.json:14`
      - AC: AC-LIFE-02, AC-LIFE-04
      - commit: c7789e6

- [x] T-06 配额闸门:`consumeSessionQuota` 单语句条件 UPDATE(取代 fire-and-forget `recordAccess`)
  - **Evidence**
    - verify: 红 `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js`（仅测试就位、源码回退 HEAD）→ EXIT=1（7 failed / 19 passed / 26；6 路并发实测超发 6、8 路并发实测超发 8）；绿同命令 → EXIT=0（26/26）；主 AI `pnpm --dir mail-worker test` → EXIT=0（17/213）；`pnpm --dir mail-vue test` → EXIT=0（17/95）；`node tests/e2e/run.mjs` → EXIT=0（13 passed）
    - files: `mail-worker/src/service/share-auth-service.js:253-328` · `mail-worker/test/share-auth-service.spec.js:383-405,634-891`
    - AC: AC-SESS-01, AC-SESS-02, AC-SESS-05, AC-SESS-07, AC-SESS-11, AC-EDGE-01, AC-EDGE-02, AC-EDGE-13
    - commit: 6209960
    - review: `review-t06.md` · APPROVED · p0=0
  - [x]* T-06.1 红:`mail-worker/test/share-auth-service.spec.js` —— 成功建会话 `access_count` 恰 +1(RETURNING 含 status/expires/cv/配额四条件);触顶/撤销/过期/cv 变 → 拒发零变更;并发抢最后名额恰 max 次成功(P-SESS-01,必须 `Promise.allSettled` 并发,串行 await 是假绿);读请求序列(mails/mail/attachment)零配额消耗(P-SESS-02;status 端点属 T-14,本任务以 resolveSession 源码无写护栏代替);条件 UPDATE 前状态变更注入 → 正确拒发;UPDATE 后 TOCTOU 注入 → token 首次回源失败、名额不退还(文档化行为);配额 UPDATE 失败/RETURNING 空 → 拒发(AC-SESS-11)
    - **P-SESS-01: 配额不超发** _Validates: AC-SESS-01, AC-SESS-07, AC-EDGE-02_
    - **P-SESS-02: 读请求零配额消耗** _Validates: AC-SESS-02, AC-EDGE-01, AC-EDGE-11_
    - _Requirements: AC-SESS-01, AC-SESS-02, AC-SESS-05, AC-SESS-07, AC-SESS-11, AC-EDGE-01, AC-EDGE-02, AC-EDGE-10, AC-EDGE-13_
    - **Evidence**
      - verify: 红同上命令 → EXIT=1（7 条行为缺失：AC-SESS-11 仍签发、6/8 路并发超发、cv/revoke/expire 谓词缺失、denied_quota 未打、consumeSessionQuota 尚不存在）
      - files: `mail-worker/test/share-auth-service.spec.js:383-405,634-891`
      - AC: AC-SESS-01, AC-SESS-07, AC-SESS-11, AC-EDGE-02
      - commit: 6209960
  - [x] T-06.2 绿:`share-auth-service.js` 重写 `establishSession` 流程(读快照取 cv → 校验 → 条件 UPDATE `WHERE status='ACTIVE' AND expires_at > now AND credentials_version = :cv AND (max_sessions IS NULL OR access_count < max_sessions) RETURNING` → 非空才 `issueToken`);`last_access_at` 与 `access_count` 同在闸门成功语句,establish 路径不再保留 fire-and-forget 库写;`exp = min(expires_at, iat+TTL)` 不变、无续期路径;快照已触顶与闸门落空两处均打 `share.session.denied_quota`(reason=`quota_snapshot`/`quota_race`);无先读后写两步状态变更(AC-SEC-08;读快照取 cv 保留)
    - _Requirements: AC-SESS-01, AC-SESS-05, AC-SESS-11, AC-SEC-08_
    - **Evidence**
      - verify: 绿 `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js` → EXIT=0（26/26）；主 AI 全量 worker 17/213、vue 17/95、E2E 13，均为 EXIT=0
      - files: `mail-worker/src/service/share-auth-service.js:253-328`
      - AC: AC-SESS-01, AC-SESS-05, AC-SESS-11, AC-SEC-08
      - commit: 6209960

- [x] T-07 Session 建立幂等恢复:KV 结果重放(R3-A3)
  - **Evidence**
    - verify: 红 `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-api.spec.js`（仅测试就位、源码回退 HEAD）→ EXIT=1（7 failed / 33 passed / 40）；绿同命令 → EXIT=0（40/40）；主 AI 独立复跑 `share-auth-service.spec.js` → EXIT=0（34/34，含 `max_sessions=1` AC-SESS-10 重放）· `share-api.spec.js` → EXIT=0（7/7）；全量 worker 套件后续独立复跑 17/289 EXIT=0（T-08+T-12 入库后）
    - files: `mail-worker/src/const/kv-const.js:7` · `mail-worker/src/api/share-api.js:56-57` · `mail-worker/src/service/share-auth-service.js:21-23,196,287-329,346-358,385-395` · `mail-worker/test/share-auth-service.spec.js:940-1148` · `mail-worker/test/share-api.spec.js:315-346`
    - AC: AC-SESS-10
    - commit: c2087ce
    - decision: T07-R1 CHANGE（KV 查询在 `loadLiveAccount` 之后、快照配额/`assertAllowed` 之前）
    - review: `review-t07.md` · APPROVED · p0=0；工件审查 A1/A2 HOLD（T-26 / design.md:241 fail-open）
  - [x]* T-07.1 红:`mail-worker/test/share-auth-service.spec.js` —— 同 `Idempotency-Key` 重放 → 同 token、`access_count` 不变、零 UPDATE;新 key/无 key → 正常消耗;KV 故障注入 → 仍签发(fail-open)+ `share.system.error` 日志;TTL = min(120s, token 剩余寿命)
    - _Requirements: AC-SESS-10_
    - **Evidence**
      - verify: 红同上命令 → EXIT=1（7 条行为缺失：同 key 重放仍走配额、HTTP 重放未接线、KV 故障未 fail-open；`remaining < 60` 不写在红期空过）
      - files: `mail-worker/test/share-auth-service.spec.js:940-1148` · `mail-worker/test/share-api.spec.js:315-346`
      - AC: AC-SESS-10
      - commit: c2087ce
  - [x] T-07.2 绿:`mail-worker/src/const/kv-const.js` 新增 `share:est:` 前缀;`share-auth-service.js` establishSession 在 ①③④ 校验通过后查 KV `share:est:<lid>:<key>`,命中直接返回缓存 token,未命中走 T-06 条件 UPDATE、成功后写 KV(既有 `c.env.kv` 绑定,同 `security.js:117` 设施)
    - _Requirements: AC-SESS-10_
    - **Evidence**
      - verify: 绿同上命令 → EXIT=0（40/40）；主 AI 独立 34/34 + 7/7，均为 EXIT=0。T07-R1 把 KV 查询挪到快照配额判定之前，补 `max_sessions=1` 重放用例
      - files: `mail-worker/src/const/kv-const.js:7` · `mail-worker/src/api/share-api.js:56-57` · `mail-worker/src/service/share-auth-service.js:346-358`
      - AC: AC-SESS-10
      - commit: c2087ce

- [x] T-08 AuthKey 第二因子 + `credentials_version` + ShareContext 集合化 + session 响应扩展
  - **Evidence**
    - verify: 红（执行者 worktree 回退生产文件）`pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-api.spec.js test/share-attachment-service.spec.js --no-cache` → EXIT=1（17 failed / 62 passed / 79）；绿同命令 → EXIT=0（79/79）；主 AI 独立复跑同上四文件含 T-12 → EXIT=0（185/185：auth 56 · api 8 · attachment 15 · mail-share 106）；全量 `pnpm --dir mail-worker test --no-cache` → EXIT=0（17/289）
    - files: `mail-worker/src/service/share-auth-service.js:185-202,303-413,487-590` · `mail-worker/src/api/share-api.js:54-61` · `mail-worker/src/service/share-attachment-service.js:106-112` · `mail-worker/test/share-auth-service.spec.js:1238-1804` · `mail-worker/test/share-api.spec.js:363-410` · `mail-worker/test/share-attachment-service.spec.js:144-157` · `mail-worker/test/mail-share.schema.spec.js:143-146`
    - AC: AC-AUTH-01, AC-AUTH-02, AC-AUTH-03, AC-AUTH-04, AC-AUTH-05, AC-AUTH-06, AC-SESS-08, AC-SESS-09, AC-EDGE-05, AC-EDGE-12, AC-LIFE-03
    - commit: 5a81065
    - decision: ④ AuthKey 在 `loadLiveBindings` 之后、KV 之前；过期/撤销 + 错 Key 先撞 `SHARE_AUTH_REQUIRED`（过了 lid+sec）；围栏 `row.accountId` 读取 4→3
    - review: `exec-t08-note.review1.sub.md` · 工件 A1 CHANGE / A2–A4 HOLD；代码审查 `review-t08.md` NEEDS_CHANGES → C1/I1/M1 `bc2b4e2`；复审 `review-t08-r2.md` APPROVED p0=0
  - [x]* T-08.1 红:`mail-worker/test/share-auth-service.spec.js` —— 启用 Key 后无 Key/错 Key → `SHARE_AUTH_REQUIRED`、零 token、零配额、无锁定副作用(扫 schema 断言无 `mail_share_auth_fail` 表);`lid` 不存在/`sec` 错 + 任意 authKey 组合恒 `SHARE_UNAVAILABLE`(P-AUTH-01 property);reset 后旧 token 回源 → `SHARE_UNAVAILABLE`、新 Key 建会话成功且消耗新配额(P-AUTH-02);cv 严格单调;换 IP 头重放读请求仍 200;429 独立运输层、零配额;session 响应含 `shareType`/`mailboxes`(掩码)/`expiresAt`/`config` 四件、KV 写失败注入仍签发(fail-open,与 T-07.1 合并;配额 UPDATE 失败改走 AC-SESS-11 拒发)
    - **P-AUTH-01: Visitor 失败不可区分性** _Validates: AC-AUTH-01, AC-AUTH-02, AC-EDGE-08_
    - **P-AUTH-02: credentials_version 单调失效** _Validates: AC-AUTH-04, AC-EDGE-05_
    - _Requirements: AC-AUTH-01, AC-AUTH-02, AC-AUTH-03, AC-AUTH-04, AC-AUTH-05, AC-AUTH-06, AC-SESS-08, AC-SESS-09, AC-EDGE-05, AC-EDGE-12, AC-LIFE-03_
    - **Evidence**
      - verify: 红（执行者）同上三 spec → EXIT=1（17 failed / 62 passed / 79）；主 AI 未再回退复现红（实现已入库 `5a81065`）
      - files: `mail-worker/test/share-auth-service.spec.js:1238-1804` · `mail-worker/test/share-api.spec.js:363-410` · `mail-worker/test/share-attachment-service.spec.js:144-157`
      - AC: AC-AUTH-01, AC-AUTH-02, AC-AUTH-04, AC-SESS-09
      - commit: 5a81065
  - [x] T-08.2 绿:`share-auth-service.js` —— `establishSession` 加 `authKey?` 第三参(复用 `digestShareSecret` 同款 HMAC+pepper,`share-auth-service.js:86-89`,常量时间比较);token payload 加 `cv`(保持 `s1` 版本,旧 token 按 `cv=0`);`resolveSession` 扩展:cv 回源比对 + ShareContext 集合化(返回 `{shareId, bindings: [{bindingId, accountId, windowStartEmailId}], messageLimit, otpExtractionEnabled, showFullAddress, expiresAt}`,**形状在此冻结,W2 只消费不改**);拒绝路径打 `share.session.denied_auth`/`denied_cv` 日志
    - _Requirements: AC-AUTH-03, AC-AUTH-04, AC-SESS-09, AC-SEC-08_
    - **Evidence**
      - verify: 绿三 spec → EXIT=0（79/79）；主 AI 独立 56+8+15 + 全量 worker 17/289、vue 17/95、E2E 13，均为 EXIT=0。围栏棘轮 4→3 同 commit
      - files: `mail-worker/src/service/share-auth-service.js:185-202,303-413,487-590` · `mail-worker/src/api/share-api.js:54-61` · `mail-worker/src/service/share-attachment-service.js:106-112`
      - AC: AC-AUTH-03, AC-AUTH-04, AC-SESS-09, AC-SEC-08
      - commit: 5a81065

- [x] T-09 Checkpoint · W1 收口:`pnpm --dir mail-worker test` 全绿(基线 138 只增不减),ShareContext 契约冻结公告
  - 有疑问(如旧 spec 断言需要语义扩展)先问用户再动。
  - **Evidence**
    - verify: 主 AI 独立 `pnpm --dir mail-worker test --no-cache` → EXIT=0（17/317）；`pnpm --dir mail-vue test` → EXIT=0（17/95）；`node tests/e2e/run.mjs` → EXIT=0（13）。地板 16/138 只增不减。无旧 spec 语义冲突，未改断言口径。
    - files: `mail-worker/src/service/share-auth-service.js:348-368` · `.agent-workspace/.archive/2026-08-24/mailbox-share-capability/share-context-freeze.md`
    - AC: W1-ctx（bindings 为真源；`accountId`/`windowStartEmailId` 垫片至 T-11）
    - commit: dd1de15

### W2 · 读路径与 Binding CRUD(依赖 T-08 冻结的 ShareContext;文件不冲突时 T-10/T-12 可与 W1 后半并行起跑)

- [ ] T-10 scoped repository 集合化 + per-binding window + message_limit DESC 截断
  - [ ]* T-10.1 红:`mail-worker/test/share-scoped-email-repository.spec.js` —— 集合封闭性 property:任意 ctx/参数组合只返回现存 Binding 集合内的行,每行满足所属 Binding 独立 `window_start_email_id` 下界 + `account_id > 0` + `is_del=NORMAL` + `status != SAVING`(P-BIND-01);`messageLimit=N` 各邮箱投 N+2 封 → 各返回最新 N(DESC),N=1 合法;`onlyMessagesAfterCreated=false` → 下界 0 仍受 N 截断;零邮件 → 空集不报错
    - **P-BIND-01: Binding 集合封闭性** _Validates: AC-MAIL-01, AC-MAIL-02, AC-MAIL-06_
    - **P-SCOPE-03: message_limit 服务端封闭性** _Validates: AC-MAIL-03, AC-MAIL-04, AC-MAIL-05, AC-EDGE-06_
    - _Requirements: AC-MAIL-01, AC-MAIL-02, AC-MAIL-03, AC-MAIL-09, AC-EDGE-07_
  - [ ] T-10.2 绿:改造 `mail-worker/src/service/share-scoped-email-repository.js:60-92` —— 单值等值改 `inArray` + per-binding 下界、`email_id` DESC、`limit ≤ min(50, messageLimit)`;新增 `listForBinding(c, ctx, bindingId, cursor?, limit)`;N 截断在 SQL 内完成不在应用层
    - _Requirements: AC-MAIL-01, AC-MAIL-02, AC-MAIL-03_

- [ ] T-11 投影层(掩码/OTP 裁剪/Binding 标识)+ 详情/附件可见集复查
  - [ ]* T-11.1 红:`mail-worker/test/share-mail-service.spec.js` —— 掩码封闭性+幂等 property(`show_full_address` 双态下系统生成的绑定邮箱身份字段形状,发件人不掩码、含址正文原样,P-MASK-01);`code` 键存在 IFF `otp_extraction_enabled=true` 且值恒等 `email.code` 原值含空串(P-OTP-04);投影白名单键集合断言(新增 Binding 标识/掩码地址,无 `user_id`/`account_id` 原值/`is_del`/`status`)
    - **P-MASK-01: 身份字段掩码封闭性与幂等** _Validates: AC-MAIL-08_
    - **P-OTP-04: code 字段条件存在性** _Validates: AC-OTP-01, AC-OTP-02_
    - _Requirements: AC-MAIL-07, AC-MAIL-08, AC-OTP-01, AC-OTP-02, AC-OTP-03_
  - [ ] T-11.2 绿:`mail-worker/src/service/share-mail-service.js:46-63` `project` 扩展(Binding 标识 + 掩码地址 + code 条件剔除);新建 `maskAddress(address, showFullAddress)`(local-part 留首字符 + `***`,幂等,非法输入返回 `***` 不抛);摄取链 `mail-worker/src/email/email.js` 零改动(don't touch)
    - _Requirements: AC-MAIL-07, AC-MAIL-08_
  - [ ]* T-11.3 红:`mail-worker/test/share-mail-service.spec.js` + `share-attachment-service.spec.js` —— 直接按 `mailId` 取被 N 滚出/窗口外邮件与附件 → `SHARE_UNAVAILABLE`(P-SCOPE-03 的详情/附件半边);新邮件到达使最旧滚出后,列表与详情均不可再取;`messageLimit=1` 单封/滚动场景;篡改 `mailId`/`attachmentId`/`bindingId` 指向他分享 → `SHARE_UNAVAILABLE` 无存在性泄露;附件响应无 `/oss/` 直链
    - _Requirements: AC-MAIL-04, AC-MAIL-05, AC-MAIL-06, AC-SEC-05, AC-EDGE-06, AC-EDGE-08_
  - [ ] T-11.4 绿:`share-mail-service.js` 详情路径复查可见集(window ∩ 最新 N);`mail-worker/src/service/share-attachment-service.js:126-161` 三重校验扩展为多 Binding 集合(`shareContext.accountId` 单值假设改造),服务端为唯一强制点
    - _Requirements: AC-MAIL-05, AC-SEC-05_

- [x] T-12 create 多邮箱扩展(mail-share-service.js 本波次第一写者)
  - **Evidence**
    - verify: 红（执行者，测试就位、源码回退）`pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` → EXIT=1（37 failed / 68 passed / 105）；绿同命令 → EXIT=0（当时 105/105，收尾补并发删除探针后 106）；主 AI 独立复跑含 T-08 四文件 → EXIT=0（185/185，其中 mail-share 106/106）；全量 `pnpm --dir mail-worker test --no-cache` → EXIT=0（17/289）
    - files: `mail-worker/src/service/mail-share-service.js:19-25,107-168,233-266,379-633` · `mail-worker/test/mail-share-service.spec.js:503-557,667-1145` · `mail-worker/src/api/mail-share-api.js:23-28`（`{...body}` 已透传，本任务零改）
    - AC: AC-CAP-01, AC-CAP-02, AC-CAP-03, AC-CAP-05, AC-CAP-06, AC-CAP-07, AC-CAP-08, AC-CAP-09, AC-CAP-10, AC-CAP-13, AC-CAP-14, AC-OTP-06, AC-LIFE-10, AC-LIFE-11
    - commit: b6f5a28
    - decision: T12-R1 写入侧拒绝 `<3000`；T12-R2 主表 window 双写；T12-R3 V2 另拒 `messageLimit`；T12-R6a/R6b seed 改写 + `accountIds` 优先
    - review: `exec-t12-note.review1.sub.md` · 工件 A1/H1 HOLD · E1 CHANGE；代码审查 `review-t12.md` NEEDS_CHANGES → P0-1/P1-1 `6b5d29b`；复审 `review-t12-r2.md` APPROVED p0=0
  - [x]* T-12.1 红:`mail-worker/test/mail-share-service.spec.js` —— 多 `accountIds` 创建 → share 行 + N 条 binding 行 + URL 形状不变;`shareType` 实时派生(1→single,>1→multi,扫表断言无 share_type 列);混入他人/已删 accountId → `SHARE_ACCOUNT_FORBIDDEN` 零残留;51 个 accountId → `SHARE_BINDING_LIMIT_EXCEEDED` 整单拒;`refreshIntervalMs=2999` → `SHARE_INVALID_CONFIG`;per-binding window 原子快照(true→各邮箱 MAX(email_id),false→0);authKey 启用 → 明文恰一次、库中仅 hash+kid;幂等重放(指纹含新字段+排序 accountIds)→ 同 shareId 无 sec/authKey 明文;旧 ShareDialog 单 accountId 载荷 → 默认值创建成功
    - _Requirements: AC-CAP-01, AC-CAP-02, AC-CAP-03, AC-CAP-05, AC-CAP-06, AC-CAP-07, AC-CAP-08, AC-CAP-09, AC-CAP-13, AC-CAP-14, AC-OTP-06_
    - **Evidence**
      - verify: 红（执行者）同上 → EXIT=1（37 failed / 68 passed / 105）；主 AI 未再回退复现红（实现已入库 `b6f5a28`）
      - files: `mail-worker/test/mail-share-service.spec.js:667-1145`
      - AC: AC-CAP-01, AC-CAP-02, AC-CAP-03, AC-CAP-05, AC-CAP-09, AC-CAP-13
      - commit: b6f5a28
  - [x] T-12.2 绿:`mail-share-service.js` —— `loadOwnedAccount`(`:104-110`)改批量 IN 校验;create 收新字段 + 取值域校验(`refresh_interval_ms` 钳 ≥3000)+ `c.env.db.batch()` 写 share/bindings/幂等行 + T-02 双写 + T-03 V2 门控接线;`mail-worker/src/api/mail-share-api.js:23-28` create 端点透传新载荷(兼容旧形状)
    - _Requirements: AC-CAP-01, AC-CAP-06, AC-CAP-10, AC-LIFE-10, AC-LIFE-11_
    - **Evidence**
      - verify: 绿 spec → EXIT=0（106/106）；主 AI 全量 worker 17/289、vue 17/95、E2E 13，均为 EXIT=0。API 端点 `{...body, idempotencyKey}` 已透传，未改 `mail-share-api.js`
      - files: `mail-worker/src/service/mail-share-service.js:151-168,233-266,379-633` · `mail-worker/src/api/mail-share-api.js:23-28`
      - AC: AC-CAP-01, AC-CAP-06, AC-CAP-10, AC-LIFE-10, AC-LIFE-11
      - commit: b6f5a28

- [ ] T-13 bindings 增删:全有或全无原子命令 + `PUT /mailShare/bindings` 端点
  - [ ]* T-13.1 红:`mail-worker/test/mail-share-service.spec.js` —— add 单语句条件 `INSERT ... SELECT`(account 存活/归属),与 account 删除并发 → 零行 + `SHARE_ACCOUNT_FORBIDDEN`;重复绑定 → `SHARE_BINDING_DUPLICATE`(UNIQUE 兜底);remove 三重谓词 `binding_id+share_id+owner`,跨分享/跨租户 bindingId 混入 → 整单 `SHARE_BINDING_FORBIDDEN` 零残留;删光 → REVOKED;增删后立即拉取结果集与新集合一致(P-BIND-02 property);V2=false 时 1→N 拒绝;超 50 → `SHARE_BINDING_LIMIT_EXCEEDED`
    - **P-BIND-02: Binding 增删即时性** _Validates: AC-BIND-03, AC-BIND-08, AC-EDGE-04_
    - _Requirements: AC-BIND-02, AC-BIND-03, AC-BIND-04, AC-BIND-07, AC-BIND-08, AC-BIND-10, AC-BIND-12, AC-CAP-13_
  - [ ] T-13.2 绿:`mail-share-service.js` 新增 bindings 变更(同一 `c.env.db.batch()`:add 条件 INSERT + remove + window 快照 + 双写主表 + 删空转 REVOKED);`mail-worker/src/api/mail-share-api.js` 新增 `PUT /mailShare/bindings`
    - _Requirements: AC-BIND-02, AC-BIND-12, AC-LIFE-10_

- [ ] T-14 status 水位端点 `GET /share/mailboxes/status`(无游标,R2-A2)
  - [ ]* T-14.1 红:`mail-worker/test/share-api.spec.js` + `share-integration.spec.js` —— API 面断言不接受 `sinceEmailId`/任何游标参数;返回每 Binding 在 VisibleWindow ∩ message_limit ∩ 排除条件内的 `latestEmailId`(无可见邮件为 null)+ 可选 `latestReceivedAt`;窗口外/被 N 滚出邮件注入 → 水位不反映(侧信道封闭);与 mails 同周期调用零配额、同 token 同范围;`/share/mailboxes/statusX` 前缀近似不豁免
    - _Requirements: AC-OTP-09, AC-EDGE-11, AC-SEC-03_
  - [ ] T-14.2 绿:`mail-worker/src/api/share-api.js` 新增端点(经 `resolveSession` + scoped repository 同一范围条件,不建第二套范围模型);挂 `mail-worker/src/security/share-rate-limit.js` `SHARE_READ_RATE_LIMITER`;`mail-worker/src/security/security.js:23-29` `excludeExact` 追加 `{ method: 'GET', path: '/share/mailboxes/status' }` 恰一行(security.js 热区:本任务只许动这一行)
    - _Requirements: AC-OTP-09, AC-SEC-03_

### W3 · Owner 管理面 + perm + cleanup(mail-share-service.js 串行:T-15→T-16→T-18)

- [ ] T-15 Owner API 扩展:get / update / delete + list 分页与新投影
  - [ ]* T-15.1 红:`mail-worker/test/mail-share-service.spec.js` —— get 本人 → 详情+bindings+config,他人 shareId → `SHARE_NOT_FOUND`;update 各字段落库、下次 Visitor 请求生效、不可改 `lid/sec/expires_at`、SHALL NOT 触碰 auth_key 字段;`maxSessions` NULL→有限值缺省 `resetUsedSessions=true` 置 0、显式 false 保留计数立即 `ACCESS_LIMIT_REACHED`;下调 `max_sessions ≤ used_sessions` 接受且态正确;delete → share/binding/幂等行全删零孤儿(batch 原子);list 分页(size 默认 20/上限 100,`share_id DESC`,无参 deprecated 上限 500)+ 行含 shareType/effectiveStatus 四态/usedSessions/maxSessions/bindings 摘要;非 ACTIVE 计算态行可见可审计
    - _Requirements: AC-ADMIN-01, AC-ADMIN-02, AC-ADMIN-03, AC-ADMIN-04, AC-ADMIN-06, AC-ADMIN-07, AC-ADMIN-09, AC-EDGE-14_
  - [ ] T-15.2 绿:`mail-share-service.js` 新增 get/update/delete + list 改经 Binding JOIN(`:354-364` 扩展);`mail-worker/src/api/mail-share-api.js` 新增 `GET /mailShare/get`、`PUT /mailShare/update`、`DELETE /mailShare/delete`;update 中有限 `maxSessions` 过 V2 门控
    - _Requirements: AC-ADMIN-02, AC-ADMIN-03, AC-ADMIN-07, AC-LIFE-11_

- [ ] T-16 AuthKey 状态机:`POST /mailShare/resetAuthKey`(enable/reset/disable 单入口)
  - [ ]* T-16.1 红:`mail-worker/test/mail-share-service.spec.js` —— 状态机全迁移断言:enable(生成 128-bit CSPRNG/base64url/22 字符 Key,明文恰一次,cv 不变)/reset(换 hash+kid,cv+1)/disable(清 hash+kid+enabled=0,cv+1,无明文);不变量 `auth_key_enabled=1` IFF hash 与 kid 均非空(schema/service 双侧);enable 需 V2=true
    - _Requirements: AC-AUTH-07, AC-AUTH-08, AC-ADMIN-05_
  - [ ] T-16.2 绿:`mail-share-service.js` 实现 resetAuthKey(复用 `digestShareSecret` 设施);`mail-worker/src/api/mail-share-api.js` 新增端点
    - _Requirements: AC-AUTH-07, AC-ADMIN-05, AC-LIFE-11_

- [ ] T-17 perm 路径:`premKey['share:manage']` 扩展 8 条 + security-share 门控回归(security.js 热区第二写点)
  - [ ]* T-17.1 红:`mail-worker/test/security-share.spec.js` —— 移除 `share:manage` → 8 条 `/mailShare/*` 全 `SHARE_FORBIDDEN`;Visitor 端点带 JWT 无 share token → 拒,share token 访问 Owner 端点 → 拒;Visitor 面路由枚举零写端点;`/share-evil` 前缀封闭性基线保持
    - _Requirements: AC-ADMIN-10, AC-SEC-02, AC-SEC-04, AC-SEC-10_
  - [ ] T-17.2 绿:`mail-worker/src/security/security.js:103` `premKey['share:manage']` 由 3 条扩为 8 条(create/list/revoke/get/update/bindings/delete/resetAuthKey);不动 `excludeExact` 之外任何豁免语义
    - _Requirements: AC-ADMIN-10_

- [ ] T-18 级联撤销经 Binding JOIN + cleanup 清理守恒
  - [ ]* T-18.1 红:`mail-worker/test/account-delete-share.spec.js` 扩展 —— 软删/硬删 account → 对应 Binding 剔除、余箱分享保持 ACTIVE、剩 0 → REVOKED、双写主表同步;`mail-worker/test/mail-share-cleanup.spec.js` 扩展 —— cleanup 跑后到期 share 的 binding 行同批删除零孤儿、注入孤儿 Binding → 补偿剔除
    - _Requirements: AC-BIND-05, AC-BIND-06, AC-LIFE-06, AC-LIFE-09, AC-BIND-10_
  - [ ] T-18.2 绿:`mail-share-service.js:394-415` `revokeByAccountIds` 改经 Binding JOIN(打 `share.binding.cascade` 日志);`mail-worker/src/service/mail-share-cleanup-service.js:20-28` 同批删 binding + 孤儿补偿;`mail-worker/src/service/account-service.js` 挂钩点(`:159,184,250`)保持调用不变
    - _Requirements: AC-LIFE-06, AC-LIFE-09_

- [ ] T-19 Checkpoint · 后端收口:`pnpm --dir mail-worker test` 全绿 + `share-integration.spec.js` 扩展多邮箱/配额/AuthKey 端到端集成用例

### W4 · 前端管理模块(layout 域,登录态 axios)

- [ ] T-20 管理模块路由 + 列表页(`mail-vue/src/views/share-admin/`,新建)
  - [ ] T-20.1 `mail-vue/src/request/mail-share.js` 扩展 8 端点函数(get/update/bindings/delete/resetAuthKey + list 分页参数);`mail-vue/src/router/index.js` 加 layout 子路由 + `meta.perm='share:manage'`(沿用 `perm/perm.js` `permsToRouter` 动态路由;**不动**访客白名单/守卫逻辑,那属 W5)
  - [ ]* T-20.2 红→绿:新建 `views/share-admin/index.spec.js` —— 列表字段齐全(名称/类型/绑定摘要/effectiveStatus 四态徽标/used_sessions/max_sessions/到期/最后访问)+ status 筛选 + 路由 meta perm;767px 断点遵循既有移动约定
    - _Requirements: AC-ADMIN-01_

- [ ] T-21 详情抽屉:Binding 管理 + 配置编辑 + AuthKey 区
  - [ ]* T-21.1 红→绿:`views/share-admin/` 组件 spec —— Binding 增删调 `PUT /mailShare/bindings`;配置编辑调 `PUT /mailShare/update`(含 `resetUsedSessions` 确认交互);AuthKey 区状态展示 + enable/reset/disable(新 Key 一次性展示,复用 `mail-vue/src/views/email/ShareDialog.vue:161-189` 一次性密钥展示模式);掩码开关文案为「显示完整地址(展示选项)」不得暗示保密效果
    - _Requirements: AC-ADMIN-02, AC-ADMIN-03, AC-ADMIN-05_

- [ ] T-22 创建向导:四预设 + 幂等恢复 + V2 降级
  - [ ]* T-22.1 红→绿:向导 spec —— 四预设(单邮箱验证码/临时邮箱/多邮箱验证码池/自定义)仅前端表单预填,请求不含预设标识;提交带 `Idempotency-Key`,结果未知同 key 重试,重放识别 `idempotentReplay` 且无 `sec` 明文 → 引导 revoke/delete 后重建,禁止换 key 盲建;V2=false 时多邮箱/AuthKey/配额表单项以「能力未激活」置灰;成功后一次性展示 `shareUrl`(+`authKey`),复用 `mail-vue/src/views/email/build-share-url.js`
    - _Requirements: AC-CAP-12, AC-CAP-14, AC-LIFE-11_

- [ ] T-23 ShareDialog 兼容保持(快捷入口)
  - [ ]* T-23.1 红→绿:`mail-vue/src/views/email/ShareDialog.spec.js` 基线全绿保持(旧契约单邮箱创建可用);对话框尾部加「前往分享管理」跳转;完整管理能力不塞回对话框
    - _Requirements: AC-CAP-10, AC-ADMIN-08_

### W5 · 访客页多邮箱(匿名 chunk 隔离域;T-24 组件抽取先行)

- [ ] T-24 `ShareOtpCard` 组件抽取(单邮箱页重构,为多邮箱页复用铺路)
  - [ ]* T-24.1 红→绿:从 `mail-vue/src/views/share/index.vue:255-266,31-60` 抽出 `ShareOtpCard`(featuredMail 选取 + 一键复制走 `mail-vue/src/composables/useCopyWithFallback.js` + 复制降级);`otpExtractionEnabled=false` 整区不渲染;`code=''` 邮件正常渲染不隐藏;`views/share/index.spec.js` 15 态基线保持全绿
    - _Requirements: AC-OTP-02, AC-OTP-03, AC-OTP-04_

- [ ] T-25 多邮箱 Tab + 本地水位 map + 单实例轮询 + 隔离守护
  - [ ]* T-25.1 红:`views/share/index.spec.js` 与 `mail-vue/src/composables/useSharePolling.spec.js` 扩展 —— 每 tick 恰一次 status 请求无 N 路并发;水位 map(sessionStorage 键 `share:status:<lid>`,值 `{bindingId: watermark}`)推进语义:仅消费过的 Binding 推进、首帧建基准不渲染角标、Binding 增删对齐(新增建基准/已删丢弃);浏览中移除一邮箱 → 下拍消失余箱正常
    - _Requirements: AC-OTP-07, AC-OTP-09, AC-EDGE-04_
  - [ ] T-25.2 绿:`views/share/index.vue` 按 session 响应 `shareType` 分支渲染,轻量原生 Tab(不引 el-tabs)显示掩码地址 + 新邮件角标;`useSharePolling.js` 扩展为拉 status → 本地比较 → 仅当前 Tab 拉 mails;路径形态保持 `/s/<lid>#<sec>`,`mail-vue/src/init/init.js:18-20` 正则与 `mail-vue/src/router/index.js:157-183` 守卫零改动
    - _Requirements: AC-OTP-07, AC-OTP-09_
  - [ ]* T-25.3 隔离守护:`mail-vue/src/views/share/assert-share-chunk.js` + `share-chunk.spec.js` 覆盖全部新增 import(禁入登录态 axios/layout/Dexie/websiteConfig;守护测试红了改 import 不改闸门);`mail-vue/src/init/assert-share-entry.js` 基线保持
    - _Requirements: AC-SEC-06_

- [ ] T-26 authRequired 态 + 建会话幂等重试 + 刷新策略消费 + 会话清理
  - [ ]* T-26.1 红:`views/share/index.spec.js` + `views/share/session.spec.js` 扩展 —— 收到 `SHARE_AUTH_REQUIRED` → 呈现 Key 输入态(状态机 `index.vue:160` 加 `authRequired` 节点),输入后重试,连续失败仅提示重试无锁定态;bootstrap 发请求前生成 `Idempotency-Key` 写 sessionStorage 键 `share:est-key:<lid>`,超时同 key 重试禁止换 key,成功后清除;sessionStorage 有效 token 时 bootstrap 不调 `/share/session`;间隔取下发 `refreshIntervalMs`(`useSharePolling.js:58` `intervalMs` 注入),`auto_refresh=false` 不启轮询 + 手动刷新按钮;429 按 `Retry-After` 退避不清会话;离开路由/收 UNAVAILABLE → 清 `share:session:<lid>` 与 `share:est-key:<lid>`;倒计时消费 session 响应既有 `expiresAt`
    - _Requirements: AC-AUTH-01, AC-SESS-03, AC-SESS-10, AC-OTP-05, AC-OTP-08, AC-SEC-07, AC-EDGE-03_
  - [ ] T-26.2 绿:`views/share/index.vue` bootstrap(`:514-556`)与 `views/share/session.js` 落实上述行为;`mail-vue/src/request/share.js` 加 status 函数与 `Idempotency-Key` 头透传
    - _Requirements: AC-SESS-03, AC-SESS-10_

### W6 · E2E 扩展 + 收口(串行)

- [ ] T-27 E2E 新场景(`tests/e2e/specs/`,跑 `node tests/e2e/run.mjs`)
  - [ ]* T-27.1 多邮箱访客页:干净浏览器打开 multi 链接 → Tab 切换、真投递验证码邮件、OTP 复制、角标出现与消费
    - _Requirements: AC-OTP-04, AC-SEC-01_
  - [ ]* T-27.2 配额与幂等:耗尽 `max_sessions` 后新隐身窗口进不来(建会话 +1 计数);`max_sessions=1` + 注入响应丢失 → 同 key 重试拿同一 token、`used_sessions` 恒 1 不超发
    - _Requirements: AC-SESS-04, AC-SESS-07, AC-SESS-10_
  - [ ]* T-27.3 撤销即时 + AuthKey 流 + V2 开关:浏览中撤销 → 下一拍停轮询清存储展示不可用态;AuthKey 输入流(错 Key 重试→正确 Key 进入);`SHARE_CAPABILITY_V2=false` 下四路受限写入被拒、随机路由新旧行为无策略差异(依 AC-LIFE-10 四条路径注入);headers 断言无 `sec`/authKey/token 泄露
    - _Requirements: AC-EDGE-03, AC-AUTH-01, AC-LIFE-10, AC-LIFE-11, AC-SEC-09_

- [ ] T-28 Checkpoint · 三套全量回归:`pnpm --dir mail-worker test` + `pnpm --dir mail-vue test` + `node tests/e2e/run.mjs` 全绿,单邮箱旧断言零改写(基线 138/95/13 只增不减);未跑项一律标 `unverified`

- [ ] T-29 收尾:文档 / CHANGELOG / ADR / i18n
  - [ ] T-29.1 `docs/architecture/ADR-mailbox-share-capability-extension.md` 由 Proposed 转 Accepted(补实施结论);design.md front-matter `shipped_commit` 回填;两份 spec `## Update Log` 各追加一行
  - [ ] T-29.2 `mail-vue/src/i18n/zh.js:340-385` 同前缀段与 `en.js` 对应段统一追加 W4/W5 全部新键(i18n 热区收口,单写者);`README.md` 分享能力段落更新 + CHANGELOG 行;tech-debt 台账登记(死分支 `setting.share` 不修不删、Contract 阶段停双写为后续版本任务)
    - _Requirements: AC-ADMIN-08_

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "name": "W0 地基", "tasks": ["T-01", "T-02", "T-03", "T-04"],
      "note": "T-01 独占 init.js 先行;T-02/T-03/T-04 依赖 T-01 表结构,其后组内可并行" },
    { "id": 1, "name": "W1 授权链", "tasks": ["T-05", "T-06", "T-07", "T-08", "T-09"], "serial": true,
      "note": "全部触碰 share-auth-service.js,单 owner 严格串行 T-05→T-06→T-07→T-08→T-09(checkpoint);T-08 冻结 ShareContext 契约" },
    { "id": 2, "name": "W2 读路径+Binding CRUD", "tasks": ["T-10", "T-11", "T-12", "T-13", "T-14"],
      "note": "依赖 T-08 冻结的 ShareContext;链内约束:T-10→T-11 串行(repo→投影),T-12→T-13 串行(同 mail-share-service.js),T-14 独立;T-11 消费 T-10;若文件不冲突,T-12(mail-share-service)可与 W1 后半(share-auth-service)并行起跑" },
    { "id": 3, "name": "W3 Owner API+perm+cleanup", "tasks": ["T-15", "T-16", "T-17", "T-18", "T-19"],
      "note": "T-15→T-16→T-18 串行(同 mail-share-service.js);T-17 独占 security.js 可与之并行;T-19 checkpoint 收口" },
    { "id": 4, "name": "W4 前端管理模块", "tasks": ["T-20", "T-21", "T-22", "T-23"],
      "note": "依赖 W3 契约;T-20 先行(路由+request 层),T-21/T-22/T-23 其后可并行(不同文件);i18n 新键只记录不落盘,T-29 收口" },
    { "id": 5, "name": "W5 访客页多邮箱", "tasks": ["T-24", "T-25", "T-26"],
      "note": "依赖 W2 契约(status/session 响应);T-24 组件抽取先行,T-25/T-26 依赖之且同触 views/share/index.vue,串行;可与 W4 整体并行(前端两域不共文件)" },
    { "id": 6, "name": "W6 E2E+收口", "tasks": ["T-27", "T-28", "T-29"], "serial": true,
      "note": "依赖 W1–W5 全部完成;T-27→T-28→T-29 串行" }
  ],
  "gates": [
    "T-01 为模型/迁移级变更:方案已由 design.md R2-A4/R3-A2 用户裁决,执行偏离两条幂等 SQL 须停下上报",
    "SHARE_CAPABILITY_V2 生产置 true 的激活前置(迁移完成+回填重跑+无旧 Worker+告警消费者)是部署动作,不在本清单任何任务内静默执行"
  ]
}
```

## Update Log

- 2026-08-24 · 主 AI:T-09 Evidence `commit` 回写 `dd1de15`。未勾选尾：T-10 / T-11 / T-13 → T-29。
- 2026-08-24 · 主 AI:T-08/T-12 复审 APPROVED p0=0。T-09 冻结公告已落。并行派 T-10 / T-13。未勾选尾：T-10 / T-11 / T-13 → T-29。
- 2026-08-24 · 主 AI:T-08 审查 CHANGE 入库 `bc2b4e2`（AuthKey enable 谓词 + KV 绑 cv）；T-12 审查 CHANGE 入库 `6b5d29b`（旧指纹双向兼容 + flag 值域）。主 AI 独立 定点 90/90 + mail-share 132/132 + 全量 worker 17/317、vue 17/95、E2E 13，均为 EXIT=0。未勾选尾：T-09 / T-10 / T-13 → T-29。
- 2026-08-24 · 主 AI:T-08 代码审查 NEEDS_CHANGES（C1/I1/M1 CHANGE）；T-12 代码审查 NEEDS_CHANGES（P0-1/P1-1 CHANGE）。并行派修复。未勾选尾：审查收口 → T-09 / T-10 / T-13 → T-29。
- 2026-08-24 · 主 AI:T-08/T-12 工件审查过筛。T08-A1 CHANGE；T08-A2/A3/A4 HOLD。T12-E1 CHANGE；T12-A1/H1 HOLD。代码审查未回。未勾选尾：T-09 / T-10 / T-13 → T-29。
- 2026-08-24 · 主 AI:T-08 / T-12 勾选。T-08 `5a81065`（AuthKey+cv+ShareContext，围栏 4→3）；T-12 `b6f5a28`（多邮箱 create+V2 栅栏）。主 AI 独立 185/185 + 全量 17/289 EXIT=0。未勾选尾：T-09 / T-10 / T-13 → T-29。
- 2026-08-24 · 主 AI:T-07 勾选。`c2087ce`。T07-R1 CHANGE：KV 在快照配额判定前。主 AI 独立 34/34 + 7/7 EXIT=0。前端 key 归 T-26。未勾选尾：T-08 / T-12 → T-29。
- 2026-08-24 · 主 AI:T-06 审查 APPROVED p0=0（`review-t06.md`）。循环 import 与空 `options` HOLD。未勾选尾：T-07 / T-12 → T-29。
- 2026-08-24 · 主 AI:T-06 勾选。主 AI 独立复跑 worker 17/213、vue 17/95、E2E 13，均为 EXIT=0。`recordAccess` 已删；闸门空/抛错拒发；并发 `Promise.allSettled` 抢最后名额恰 1。未勾选尾：T-07 → T-29。
- 2026-08-24 · executor(tasks 撰写执行者):Template 3 首次落盘。29 个父任务 / 7 个波次(W0–W6),107 条 AC 全量映射(每任务 `_Requirements` 聚类),9 条 Correctness Properties 挂到核心逻辑任务(T-05/T-06/T-08/T-10/T-11/T-13);冲突热区(`init.js`/`security.js`/`share-auth-service.js`/`mail-share-service.js`/i18n)单 owner 规则成表;全部文件路径已对 2026-08-24 工作树逐一核实(`mail-worker/test/` 17 spec、`kv-const.js`、`tests/e2e/specs/` 等),零虚构路径。依据:design.md(converged,R1–R3)+ requirements.md(107 AC)+ 三份 recon。
- 2026-08-24 · 主 AI(实现会话):接手直接进入 W0。代码现实 HEAD `e120a04` 无 `v3_2DB`/Binding 实体/`SHARE_CAPABILITY_V2`。分支 `cursor/mailbox-share-capability-dcb6`。T-01 已派 executor；W0 可执行范围与 T-02/T-03/T-04 拆分已派 plan-reality-recon。未勾选任何 `[x]`（尚无 Evidence）。台账:`.agent-workspace/.archive/2026-08-24/mailbox-share-capability/session-ledger.md`。
- 2026-08-24 · 主 AI:T-01 勾选。主 AI 独立复跑 `pnpm --dir mail-worker test` → 17/153 绿。W0 侦察裁决（不改 charter）:R1 T-02.1 grep 收窄为「不新增读取 + 允许清单固定 share-auth-service 既有 4 处直至 T-08」；R3 回填 SQL 保持原文不加 `status='ACTIVE'`，孤儿 Binding 交 T-18；R5 `wrangler.toml` 仅注释声明 `SHARE_CAPABILITY_V2`（与既有 SHARE_* 一致），缺省/false 由代码与 `wrangler-vitest.toml` 承担，禁止 toml 硬写 false 覆盖 dashboard。W0 剩余 T-02→T-03→T-04 单执行者串行。
- 2026-08-24 · 主 AI:T-02/T-03/T-04 勾选。主 AI 复跑三套 → worker 17/180、vue 17/95、E2E 13，均为 EXIT=0。T-01 审查 P0-1 CHANGE（Evidence 补 EXIT 与 path:lines）；P0-2 HOLD（`mailShareBinding` 生产消费者是 T-10/T-12，T-01.3 要求本波次落实体，禁止假 import）。W1 裁决：ShareContext 保留 `bindings[0]` 派生标量至 T-11；`establishSession` 第 4 参改为 options；Idempotency-Key 在 `share-api.js` 读头；T-06 配额 UPDATE 失败必须拒发（改写 AC-LIFE-14 旧断言）；`last_access_at` 可写入闸门成功语句，统计失败另挂 F&F；T-05 需钉死安装 `fast-check`。热区表补登记 `share-api.js`。
