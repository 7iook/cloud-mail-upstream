# T-05 执行说明 · effectiveStatus 四态 + establish/resolve 差异放行

- 日期:2026-08-24
- 执行者:executor(sub-task executor)
- 分支:`cursor/mailbox-share-capability-dcb6` · 基线 HEAD `3834456`(**未提交、未推送**,按派单要求)

## 成功态(主 AI 原文照抄,未改写)

NOT "effectiveStatus has a fourth enum", BUT a visitor who already has a live session can keep reading mail after the share hits max_sessions, AND a new visitor cannot open a new session on that share. Must NOT persist ACCESS_LIMIT_REACHED / EXPIRED. Must NOT break existing unlimited (max_sessions NULL) shares.

### 逐条核验

| 成功态子句 | 验证证据 |
|---|---|
| 已有 session 触顶后仍可读 | `test/share-auth-service.spec.js:398-428`:`max_sessions=1` 建会话 → `access_count=1` → `resolveSession` 返回 `effectiveStatus:'ACCESS_LIMIT_REACHED'` 且不抛;读路由 `share-api.js:60-79`(`/share/mails`、`/share/mail`)直连 `resolveSession`、无 ACTIVE 闸门 → 邮件读取真实放行 |
| 新访客不能再建会话 | 同用例:同 `lid`+`sec` 二次 `establishSession` → 字节相同的 `SHARE_UNAVAILABLE`;`access_count` 仍为 1(拒发发生在 `recordAccess` 之前) |
| 不落库计算态 | `spec:467-491` 扫本文件全部 seeded 行 `status ∈ {ACTIVE, REVOKED}`,并全表断言 `status IN ('ACCESS_LIMIT_REACHED','EXPIRED')` 计数为 0 |
| 不破 NULL 无限额分享 | 既有断言 `spec:202-207`(原 188-193)、`spec:281`(原 266)、`spec:346`(原 331)零改写通过(行号仅因文件头部插入而平移 +15);新增 `spec:430-442` 覆盖「已配额但未触顶」仍 ACTIVE |

## 红

命令:`pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js`(源码回退到 HEAD 版、仅测试就位)

- **EXIT=1** · `Tests 3 failed | 13 passed (16)`
- 失败原因全部是行为缺失,非语法/import:
  1. `expected 'ACTIVE' to be 'ACCESS_LIMIT_REACHED'`(property 真值表,`spec:379`)——第四态分支不存在
  2. `resolveSession` 返回 `effectiveStatus:'ACTIVE'` 而非 `'ACCESS_LIMIT_REACHED'`(`spec:413`)——硬编码常量 + 未拆 allow list
  3. `Error: expected SHARE_UNAVAILABLE`(`spec:477`)——触顶行仍被 `establishSession` 放行
- 日志:`/opt/cursor/artifacts/t05_red_share_auth_spec.log`

`spec:430-442`(未触顶仍 ACTIVE)与 `spec:444-465`(EXPIRED/REVOKED 优先于触顶)在红阶段即通过 —— 二者是**回归护栏**而非驱动实现的红:前者钉死 NULL/未触顶行为不因拆分而漂移,后者钉死新分支必须插在 EXPIRED 之后(若插到 EXPIRED 之前会立即变红)。

## 绿

- `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js` → **EXIT=0** · `16 passed (16)` · `/opt/cursor/artifacts/t05_green_share_auth_spec.log`
- `pnpm --dir mail-worker test` → **EXIT=0** · `Test Files 17 passed (17)` · `Tests 185 passed (185)`(基线 180 + 本任务新增 5)· `/opt/cursor/artifacts/t05_green_full_worker_suite.log`

## 改了什么(file:lines)

| 文件 | 位置 | 内容 |
|---|---|---|
| `mail-worker/src/service/share-auth-service.js` | `25-38` | `effectiveStatus` 在 EXPIRED 之后、ACTIVE 之前插入 `ACCESS_LIMIT_REACHED`;首谓词严格为 `row.maxSessions != null`(松等,同时排除 `undefined`),未使用 `Number(...) > 0` |
| 同上 | `228-238` | `assertShareActive` 拆为 `assertAllowed(row, allowed)` + 两张 allow list 常量 `ESTABLISH_ALLOWED=['ACTIVE']` / `RESOLVE_ALLOWED=['ACTIVE','ACCESS_LIMIT_REACHED']`;`row.accountId > 0` 半边原样保留,返回算得的态供调用方复用 |
| 同上 | `269` | `establishSession` → `assertAllowed(row, ESTABLISH_ALLOWED)` |
| 同上 | `299,306` | `resolveSession` → `assertAllowed(row, RESOLVE_ALLOWED)`,返回体 `effectiveStatus` 由硬编码 `'ACTIVE'` 改为算得值 |
| `mail-worker/test/share-auth-service.spec.js` | `2` | `import fc from 'fast-check'` |
| 同上 | `98-137` | `insertShare` 工厂加可选 `maxSessions` / `accessCount`;列名动态拼接,**默认不写这两列** → 既有用例保持 `max_sessions` NULL、`access_count` 走 DB 默认 0 |
| 同上 | `355-396` | P-LIFE-02 property 真值表,`numRuns: 200`(≥100);`Object.freeze` 入参 + 同参二次调用同结果 + 前后 `COUNT(*) FROM mail_share` 相等 → 纯函数零写库;另钉死 `maxSessions:0 → ACCESS_LIMIT_REACHED`、`null`/`undefined` → ACTIVE(直接杀死 `Number(x)>0` 写法) |
| 同上 | `398-428` | P-SESS-03 关门不清场 |
| 同上 | `430-442` | 未触顶双路径放行 |
| 同上 | `444-465` | EXPIRED / REVOKED 在 resolve 侧压过触顶(AC-LIFE-05) |
| 同上 | `467-491` | 持久化值域扫表断言 |
| `mail-worker/package.json` | `14` | `"fast-check": "4.9.0"`,精确钉版、无 `^`/`~`(`pnpm --dir mail-worker add -D fast-check@4.9.0`) |
| `mail-worker/pnpm-lock.yaml` | — | 仅经 `pnpm add` 产生 |

未触碰派单禁改清单中的任何文件(`git status` 仅上述 4 个 M)。`establishSession` 第 4 参仍为 `deps = {}`;`recordAccess` 仍是 fire-and-forget;AC-LIFE-14 用例未改。

## 遗留风险

1. **【已知洞 · 归 T-08,本任务按令不修】附件下载会拒掉触顶但仍在线的 session。** `share-attachment-service.js:104-111` 的 `assertActiveShareContext` 写死 `shareContext.effectiveStatus !== 'ACTIVE'` 即拒。`resolveSession` 现在会对触顶行返回 `ACCESS_LIMIT_REACHED`,于是 `/share/attachment`(`share-api.js:81-86`)在触顶后失效,而 `/share/mails`、`/share/mail` 正常 —— AC-SESS-06「关门不清场」在附件面上是**部分未达成**。与 recon §3.1 第 5 点裁决一致(该文件属 T-08 交付契约),现有测试不因此变红(附件 spec 自造 ctx、不经 DB;且当前全仓无任何写 `max_sessions` 的生产路径)。T-08 必须把这行改成 allow list。
2. **生产侧目前无法真的触顶。** `mail-share-service.js` 的 create SQL 不写 `max_sessions`(Owner 面缺该字段 = 已知 T-15 洞,按令未动),因此四态分支在真实数据上暂时恒不命中;当前证据全部来自 service 层直测 + 手写 seed。T-15 打通 Owner 面后需补一条端到端(建带配额分享 → 触顶 → 老 token 仍读得到)。
3. **`max_sessions = 0` 语义已按 `>=` 钉死为「立即触顶」**,已在测试固化。若产品后续想把 0 解释为「不限」,须同时改 requirements/design,不能只改实现。
4. **配额闸门(T-06)未做,当前拒发只靠读快照后的 `assertAllowed`**,存在读-判-写之间的并发超发窗口(两个请求同时读到 `access_count = max-1` 会双双放行)。这正是 T-06 单语句条件 UPDATE 要消解的,本任务的测试未对并发做任何承诺。

## Review Findings

- **无方向性偏差,按派单执行。** 派单给出的全部锚点与工作树逐条对齐后无误:`share-auth-service.js:25-33` 的三态 early-return 结构、`assertShareActive:222-226` 被 establish/resolve 共用、`resolveSession` 硬编码 `'ACTIVE':293`、既有三态断言行号(188-193/266/331)、`mail-share` 实体已含 `maxSessions:21` 与 `accessCount:17`、`init.js:41` 已加 `max_sessions` 列 —— 均命中,无需自纠。
- **跨域只读核查,未跨域改动**:为验证成功态是否真的成立(而非只让本文件测试变绿),读了 `share-api.js:54-86`、`share-attachment-service.js:96-111`、`mail-share-service.js:163-182`、`mail-share.schema.spec.js:142-147`,确认① 邮件读路径无 ACTIVE 闸门 → 成功态成立;② 附件路径有闸门 → 记为遗留风险 1;③ Owner 列表 `projectOwnerRow` 直接复用 `effectiveStatus`,其行 `max_sessions` 恒 NULL 故行为不变;④ `mail-share.schema.spec.js:146` 冻结 `share-auth-service.js` 的 `row.accountId` 读取恰为 4 处 —— 拆分后仍为 4 处(`assertAllowed` 1 + establish 1 + resolve 2),全量套件已验证该护栏未破。
- **fast-check 在 workers pool 下可用**(`@cloudflare/vitest-pool-workers` + `singleWorker`),property 200 轮耗时可忽略,无需额外 `deps.optimizer` 配置。

## Update Log

- 2026-08-24 · executor:T-05 落地。红 EXIT=1(3 failed / 16,原因为第四态与差异放行缺失)→ 绿 EXIT=0(spec 16/16;全量 17 files / 185 tests)。改动 4 文件:`share-auth-service.js:25-38,228-238,269,299,306`、`share-auth-service.spec.js`(+5 用例、工厂扩参)、`package.json:14` 钉 `fast-check@4.9.0`、lock。踩到的坑:`resolveSession` 返回值的下游消费者 `share-attachment-service.js:108` 会拒掉 `ACCESS_LIMIT_REACHED`,属 T-08 契约,已记为遗留风险 1。未 commit、未 push。
