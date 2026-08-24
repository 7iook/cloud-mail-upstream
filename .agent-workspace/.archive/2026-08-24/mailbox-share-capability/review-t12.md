# T-12 Multi-Mailbox Create Review

**VERDICT: NEEDS_CHANGES**

范围：生产代码与测试严格审查 `5a81065..b6f5a28`；当前 HEAD `695394f` 仅用于核对后续 Evidence，且 `b6f5a28..HEAD` 未改写 `mail-share-service.js` / `mail-share-service.spec.js`。当前未跟踪的 prompt、`review-t08.md` 等文件均排除。

## Strengths

- `mail-worker/src/service/mail-share-service.js:379-560` 把 share、N 条 Binding、主 Binding 双写与幂等记录放进同一 D1 batch；Binding INSERT 依赖本批创建的 `lid`，share INSERT 落空时不会遗留 Binding。
- `mail-worker/src/service/mail-share-service.js:397-405,442-454` 在实际写语句上重复校验全部 account 的存活与归属，并用单条 `INSERT ... SELECT` 为每个邮箱取自己的 `MAX(email_id)`；测试包含预检后删除 account 的反证场景。
- `mail-worker/src/service/mail-share-service.js:311-325,336-360,596-619` 首次响应才返回 `sec` / AuthKey，重放不返回两类明文，AuthKey 只存复用 pepper 的 hash+kid。
- `mail-worker/src/service/mail-share-service.js:233-266` 完整接入 multi/AuthKey/有限 maxSessions/非空 messageLimit 的 V2 fence；`wrangler.toml` 没有打开生产开关。
- 新增测试覆盖多邮箱原子写、主 Binding 双写、归属竞态、配置、AuthKey、同版本幂等重放及 V2=false 负向路径；fresh focused 与全量 worker suite 均全绿。

## P0 / P1 / P2 findings

| id | severity | file:line | claim | falsification experiment |
|---|---|---|---|---|
| P0-1 | Critical | `mail-worker/src/service/mail-share-service.js:151-176,363-371,581-586` | **What's wrong:** T-12 把旧单邮箱请求指纹从四字段 `{accountId,durationSeconds,name,remark}` 改成十二字段 canonical body，但重放仍只接受与存量 hash 严格相等的一个值。滚动窗口内，旧 Worker 成功创建、响应丢失后，同一旧载荷落到新 Worker 会返回 `SHARE_IDEMPOTENCY_CONFLICT`，不会进入安全重放。**Why it matters:** 直接破坏 AC-CAP-09/14 与交付契约的响应丢失恢复，也违反 AC-LIFE-10 所要求的旧/新 Worker 混跑可回滚性；Owner 丢失 `sec`/AuthKey 后拿不到约定的 replay 结果。**How to fix:** 对“单邮箱 + 全旧默认值”的兼容载荷在 Expand 窗口继续持久化旧 canonical hash，且新代码接受存量旧 hash；或引入显式指纹版本并兼容旧值。补 old→new 与 new→old 两个滚动路由回归。 | 对同一 `{accountId:909101,durationSeconds:3600,name:'',remark:''}` 计算基线与 T-12 canonical SHA-256：旧 `d5c870…52bf`，新 `6ddde5…8a33`，`match=false`；基线 `5a81065` 与当前代码都在不等时抛 conflict，因此该路径确定失败。 |
| P1-1 | Important | `mail-worker/src/service/mail-share-service.js:111-126,151-167,233-266` | **What's wrong:** 新配置没有完整做请求值域校验。`toFlag` 会把除少量精确 false token 外的任意值（如 `"invalid"`、`2`、`{}`）静默转成 1；`toNullableCount` 也让 `true` 变成合法的 1。**Why it matters:** AC-CAP-06 要求配置“校验取值域后随行存储”；当前 malformed JSON 可意外启用 AuthKey、关闭地址掩码或写入有限配额，而不是返回 `SHARE_INVALID_CONFIG`。**How to fix:** 在 normalization 边界只接受契约允许的 boolean/0/1 与整数表示，其余拒绝，并为五个 flag 与两个 count 增加表驱动负向测试。 | 代码级反例：`toFlag('invalid', 0) === 1`、`toFlag({}, 0) === 1`、`toNullableCount(true) === 1`；现有 `assertCreateBody` 只检查转换后的数值，无法再辨认非法原始类型，测试也未覆盖这些输入。 |
| — | Minor | — | 未发现 P2 缺陷。 | — |

## Requirement checks

| 检查项 | 结论 | 证据 |
|---|---|---|
| AC-CAP-01 / 多邮箱单批创建 | PASS | `mail-share-service.js:520-535` 同批执行 share → bindings → syncPrimary → idempotency；`:668-686` 断言一条 share、N 条 Binding 与 URL 形状。 |
| AC-CAP-02 / 派生 shareType、无列 | PASS（新建路径） | `mail-share-service.js:298-325` 从实际 Binding 数组派生；`:688-703` 同时扫 D1 schema 证明无 `share_type`。 |
| AC-CAP-03 / 归属、删除、零残留 | PASS | `mail-share-service.js:397-405` 是写入侧最终门禁；测试 `:724-752,1058-1081` 覆盖他人、软删、malformed 与预检后删除，均零 share/Binding。 |
| AC-CAP-05 / AuthKey | PASS | `mail-share-service.js:596-619` 生成 128-bit base64url Key并只存 hash+kid；测试 `:883-954` 覆盖长度、pepper/kid、一次返回、重放/list/日志无明文。 |
| AC-CAP-06 / 配置 | **PARTIAL（P1-1）** | refresh/count 下界与落库正确，但 boolean/count 原始类型未按契约封闭。 |
| AC-CAP-07/08 / per-Binding window | PASS | `mail-share-service.js:442-454` 单条 INSERT 为每个 account 原子取 MAX 或写 0；`:834-881` 覆盖独立水位、false 与无额外 MAX 往返。 |
| AC-CAP-09/14 / create 幂等与丢响应 | **FAIL（P0-1）** | 同版本重排/重复集合与 secrets omission 通过，但滚动发布中相同旧请求的存量 hash 与新 hash 不兼容，无法重放。 |
| AC-CAP-10 / 旧载荷 | PASS（普通创建） | `mail-share-service.js:128-167` 回落 `accountId`；`:1028-1054` 证明单 Binding 与全部默认值。跨版本重放不通过，见 P0-1。 |
| AC-CAP-13 / Binding 上限 | PASS | `mail-share-service.js:242-244` 在 fence/ownership 前拒绝 >50；`:769-784` 钉住 50/51 边界。 |
| AC-OTP-06 / refresh 下限 | PASS | create 对 `<3000` 返回 `SHARE_INVALID_CONFIG`；既有 session 投影仍通过 `clampRefreshInterval` 钳制存量脏数据。 |
| AC-LIFE-10 / 双写 | PASS（数据双写） | `mail-share-service.js:464-484` 同一 UPDATE 双写主 Binding 的 `account_id` 与 `window_start_email_id`，并禁止无 Binding 时写 0；滚动幂等仍被 P0-1 阻塞。 |
| AC-LIFE-11 / V2 fence | PASS | `mail-share-service.js:254-265` 拦五类受限 create 配置；`:1096-1144` 验证 false 下拒绝且生产 `wrangler.toml` 无活跃赋值。 |

## Phase 2–7 checks

| Phase | 结论 | 说明 |
|---|---|---|
| Phase 2 · Code Quality | PARTIAL | SQL/helpers 命名清楚、无 broad catch 吞错、敏感数据未进日志；输入归一化过宽，见 P1-1。 |
| Phase 3 · Architecture | FAIL | API→service→D1 batch→response 链路单向且无平行实现；但指纹协议不是 Expand-compatible，见 P0-1。 |
| Phase 4 · Testing | PARTIAL | fresh 106/106 与 17/289 全绿，断言是真实 D1 行为；缺旧/新 Worker 指纹互操作和 malformed config 负向测试，现有绿灯未覆盖两个 finding。执行说明记录了 red 37 failed→green 与并发删除反证，未在本只读审查中回退复跑 red。 |
| Phase 5 · tasks.md Evidence | PASS | T-12 与 T-12.1/.2 均有 commit、verify+EXIT、files、AC 四项；`b6f5a28` 可解析且 fresh verify 已复跑。 |
| Phase 6 · Production Readiness | BLOCKED | schema/secret/fence 方向安全，生产开关未打开；滚动发布恰是 P0-1 的失败条件，当前不可合并。 |
| Phase 7 · 全链路/交付契约 | PARTIAL | 生产 caller 已确认：`mail-share-api.js:23-28` 原样 spread body + header，落到 `normalizeCreateBody`、batch 与 response；multi/AuthKey/messageLimit 新符号均有生产 consumer。最终 HTTP sink 的旧单邮箱集成测试存在，但 T-12 尚无 multi create 的 HTTP 级断言。 |

## HOLD vs CHANGE

- **HOLD**：一 share + N Binding 的 D1 batch；写入侧 account 存活/归属门禁；per-Binding 单语句 window 快照；主表 account/window 双写；`accountIds` 优先并去重排序；Binding count 派生 `shareType` 且不落列；AuthKey 复用 pepper、只存 hash+kid、首次返回；同版本重放不回 `sec`/AuthKey；五路 V2 fence；生产 `wrangler.toml` 保持关闭。
- **CHANGE**：① 让 legacy-compatible create 指纹跨旧/新 Worker 双向兼容，并补滚动路由重放测试；② 严格封闭新配置的原始输入类型/值域，非法值返回 `SHARE_INVALID_CONFIG`。

## 主 AI 过筛（2026-08-24）

主 AI 独立复算（`node` WebCrypto，载荷 `{accountId:909101,durationSeconds:3600,name:'',remark:''}`）：

- 旧 4 字段：`d5c870aaf938ac6df25f53f9847c50073d56e7abcac76be846b786af95e852bf`
- 新 12 字段：`6ddde52742eae28fe8de1b8a5490e04900d2c7d207730b08beca5597caab8a33`
- `match=false`，与审查员探针一致。

| ID | 真伪 | 比重 | 根因 | 裁决 |
|---|---|---|---|---|
| P0-1 | 真。`replayOrConflict` 只接受精确相等；T-12 把指纹从四字段改成十二字段。`exec-t12-note.md` 遗留风险 2 已承认 24h 窗口 CONFLICT，但未关 AC-CAP-14。 | 滚动发布丢响应后按规格不得换 key；CONFLICT 会让 Owner 拿不到 `sec`，再换 key 会双建。不是「记个债就过」。 | 指纹协议不是 Expand-compatible。 | **CHANGE**：单邮箱 + 全旧默认值的兼容载荷，持久化旧 4 字段 hash，且重放同时接受旧/新 hash。非兼容载荷（multi / AuthKey / 有限配额 / 非默认 flag）仍只走新 hash。禁止加版本列或第二张表。补 old→new 与 new→old 两条回归。 |
| P1-1 | 真。`toFlag('invalid')===1`、`toFlag({})===1`、`toNullableCount(true)===1`；`assertCreateBody` 只看转换后数值。 | AC-CAP-06 取值域。静默打开 AuthKey/关掩码是真伤害。 | 归一化过宽。 | **CHANGE**：flag 只收 `true/false/0/1/'0'/'1'/'true'/'false'` 与缺省；count 只收整数或 null/空串；其余 `SHARE_INVALID_CONFIG`。布尔 `true/false` 既有用例必须继续绿。 |

未勾选尾：T-12 代码审查 CHANGE 落地 → T-13 / T-09 / T-10 → T-29。

## Recommendations

- 补一条真实 `/mailShare/create` HTTP 集成用例，覆盖 `accountIds[]`、`shareType/bindings` 与重放无 secrets；当前 route spread 静态正确，但最终 sink 只由旧单邮箱 HTTP 用例覆盖。
- Charter 文档的 create API/Decision 20 仍只枚举 multi/AuthKey/maxSessions，未同步列出已冻结的 messageLimit fence；以 requirements AC-LIFE-11 与 T12-R3 为准补齐文档，避免 T-15 update 漏接。

## Verification

- `git merge-base --is-ancestor 5a81065 b6f5a28` → EXIT 0。
- `git diff --check 5a81065..b6f5a28` → EXIT 0。
- `git diff --exit-code b6f5a28..HEAD -- mail-worker/src/service/mail-share-service.js mail-worker/test/mail-share-service.spec.js` → EXIT 0，确认 docs Evidence commit 未改目标文件。
- `pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache` → EXIT 0，1 file / 106 tests passed。
- `pnpm --dir mail-worker test --no-cache` → EXIT 0，17 files / 289 tests passed。
- rolling fingerprint probe → 旧/new SHA-256 分别为 `d5c870…52bf` / `6ddde5…8a33`，`match=false`。
- `mail-worker/package.json` 无 lint/typecheck script，故无对应可运行 gate。

## VERDICT
status: NEEDS_CHANGES
critical_count: 1
important_count: 1
minor_count: 0
ready_to_merge: NO
one_line: D1 原子创建、双写、AuthKey 与 V2 fence 主链正确且 289 测试全绿，但滚动版本指纹不兼容会让旧 Worker 丢响应后的 create 无法安全重放，且新配置值域校验不封闭。
