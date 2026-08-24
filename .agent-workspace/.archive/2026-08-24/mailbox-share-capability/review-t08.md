# T-08 AuthKey / credentials_version / ShareContext Review

**VERDICT: NEEDS_CHANGES**

范围：审查 `a0f23eb..5a81065` 中 T-08 的生产代码与测试；提交内 T-07 归档文档仅作上下文，不作为生产行为证据。`5a81065` 至当前 HEAD `695394f` 的七个目标文件无后续漂移；`695394f` 仅补录 T-08/T-12 Evidence。按冻结裁决接受：AuthKey 位于 `options.authKey`，校验顺序为 `matchSec → loadLiveBindings → matchAuthKey → KV replay → quota UPDATE`，过期/撤销且错 Key 在 `lid+sec` 已通过后返回 `SHARE_AUTH_REQUIRED`，P-AUTH-01 只覆盖缺失 `lid` / 错误 `sec`。

## P0 / P1 / P2 findings

| id | severity | file:line | claim | falsification experiment |
|---|---|---|---|---|
| T08-C1 | P0 / Critical | `mail-worker/src/service/share-auth-service.js:509-540` | AuthKey 是否启用只按 SELECT 快照判断，而作为授权线性化点的条件 UPDATE 只复核 `credentials_version`、生命周期与配额。`enable` 按 AC-AUTH-07 明确不 bump `credentials_version`，因此请求可先读到 `auth_key_enabled=0`，Owner 随后完成 enable，旧请求仍命中 UPDATE 并签发一个在当前 keyed share 上有效的无 AuthKey token，直接违反 AC-AUTH-01 与交付成功状态。 | 用现有 `injectingDb.before` 在无 Key 请求完成快照后、quota UPDATE 执行前把行原子更新为 `auth_key_enabled=1` + 有效 hash/kid，当前实现会返回 token 且 `access_count=1`；修复后应零 token、零配额。将 AuthKey 策略快照（至少 enabled 状态）加入同一条件 UPDATE 的谓词，并补此竞态测试。 |
| T08-I1 | P1 / Important | `mail-worker/src/service/share-auth-service.js:455-460,521-526,580-585` | KV 重放值未绑定当前 `credentials_version`。旧版本 token 写入 KV 后若 reset/disable bump `cv`，访客用新 Key 与同一 `Idempotency-Key` 重试会通过当前 Key 校验，却直接拿回旧 token、零新配额；该响应在下一次 `resolveSession` 立即死亡，违反 AC-EDGE-05“新 Key 重新进入并消耗新配额”。 | keyed share 用 key K0 + idem I 建立，随后把 hash 换成 K1 并将 cv 0→1，再用 K1 + I 建立。当前实现返回与首次相同的 cv=0 token、计数仍为 1，且 resolve 失败；应把旧 cv 缓存视为 miss，签发 cv=1 token、计数变为 2 且 resolve 成功。 |
| T08-M1 | P2 / Minor | `mail-worker/test/mail-share.schema.spec.js:143-146` | 围栏注释称剩余三处 `row.accountId` 全在“零 Binding 回落分支”，但其中 `share-auth-service.js:284` 位于所有 establish/resolve 都经过的 `assertAllowed`。断言数字 3 正确，说明文字会误导后续 AC-BIND-01 收口。 | 对照三处实际读取：`:284`、`:311`、`:314`。仅后两处属于影子 Binding 回落；修正文案即可，棘轮仍保持 3。 |

## Requirement checks

| 检查项 | 结论 | 证据 |
|---|---|---|
| AC-AUTH-01 / 03 · AuthKey 第二因子 | PASS（非并发路径） | `share-api.js:54-61` 从 body 读取 `authKey`；`share-auth-service.js:185-201,506-519` 复用 `SHARE_SEC_PEPPER` ring、按 `auth_key_kid` HMAC 并常量时间比较。无/错 Key 在 KV 与 quota 之前拒绝，定向测试覆盖零 token、零配额。 |
| AC-AUTH-01 · enable 并发 | **FAIL · T08-C1** | `consumeSessionQuota` 的 WHERE 没有复核 `auth_key_enabled`；而 `enable` 不 bump cv，快照后的策略变化不会使 UPDATE 落空。 |
| AC-AUTH-02 / 冻结错误顺序 | PASS | `lid/sec` 在 `:493-499` 先统一为 `SHARE_UNAVAILABLE`；只有通过后才可能在 `:509-519` 暴露 `SHARE_AUTH_REQUIRED`。过期/撤销 + 错 Key 按冻结裁决先返回 AuthRequired；P-AUTH-01 property 只覆盖缺 lid / 错 sec。 |
| AC-AUTH-04 / AC-EDGE-05 · cv 失效 | PASS（直接重入）/ **FAIL（同 idem 重入）** | token 在 `:219-228` 携带 cv，`resolveSession :577-585` 每次回源拒绝版本不一致，旧无 cv token 按 0 兼容；但 `:523-525` 无条件信任旧 KV 结果，形成 T08-I1。 |
| AC-AUTH-05 / 06 / AC-EDGE-12 | PASS | 未新增失败表/计数/锁定；错 Key 不进入 quota；HTTP 路由继续由 `SHARE_SESSION_RATE_LIMITER` 包裹，service 未吞并 429 运输层语义。 |
| AC-AUTH-07 / 08 | PARTIAL（写侧按 tasks 属 T-16） | 本范围正确消费 enabled/hash/kid/cv，reset/disable 的旧 token 失效已覆盖；Owner 状态机端点不属于 T-08。但 T08-C1 表明当前消费端尚不能安全承接“不 bump cv 的 enable”。 |
| AC-SESS-08 | PASS | token 与 resolve 路径不读取 IP；HTTP 测试以不同 `CF-Connecting-IP` 建立和读取仍成功。 |
| AC-SESS-09 | PASS | `buildSessionPayload :392-411` 返回 `shareType`、掩码后的 `mailboxes`、`expiresAt` 与完整 config；refresh interval 下发钳至 ≥3000。API 集成测试验证真实 `/share/session` 信封。 |
| ShareContext 集合冻结 | PASS | `buildShareContext :351-368` 按 bindingId 排序后的结果构造 `bindings[]`，冻结每个 binding、数组和外层对象；保留 W2 前所需 scalar shim。 |
| AC-LIFE-03 / 读请求状态 | PASS | `resolveSession` 每请求回源并只放行 ACTIVE / ACCESS_LIMIT_REACHED；撤销与过期拒绝，配额触顶不清退既有 token。 |
| attachment `ACCESS_LIMIT_REACHED` | PASS | `share-attachment-service.js:106-114` 仅增加 ACTIVE / ACCESS_LIMIT_REACHED 白名单，REVOKED / EXPIRED 仍拒；两层测试均覆盖。 |
| schema fence 4→3 | PASS（注释需修） | `mail-share.schema.spec.js:142-151` 将 `share-auth-service.js` 读取数钉为 3、scoped repository 钉为 0；fresh run 9/9。T08-M1 只涉及注释准确性。 |
| T-08 Evidence 门 | PASS | `tasks.md` 的 T-08/T-08.1/T-08.2 均有 commit、verify、files、AC 四项；`5a81065` 可解析，Evidence 记录提交 `695394f` 可解析且位于其后。 |

## Phase 1–7 checks

| Phase | 结论 | 审查结果 |
|---|---|---|
| Phase 1 · Spec Compliance | FAIL | 正常路径、错误不可区分性、响应与 context 均对齐；AuthKey enable 竞态违反 AC-AUTH-01，cv bump 与 KV 组合违反 AC-EDGE-05。未发现测试绕过、xfail 或删除既有断言。 |
| Phase 2 · Code Quality | PASS | API 只做运输解析，授权收口在 service；稳定 BizError code、无 broad catch 吞授权失败、凭据未进入日志。新增 helper 边界清晰。 |
| Phase 3 · Architecture | FAIL | quota UPDATE 被定义为授权线性化点，却未收口 AuthKey enable 策略；KV 结果也未与 cv 生命周期合流，形成两个授权真相时刻。 |
| Phase 4 · Testing | FAIL | fresh 定向 79/79 与 fence 9/9 全绿，红→绿 Evidence 完整；但没有“disabled 快照→并发 enable→gate”及“cv bump + 同 idem replay”两条跨功能回归，因此绿灯未覆盖两个失败路径。 |
| Phase 5 · tasks.md Evidence | PASS | T-08 三层任务 Evidence 齐全，目标 hash 有效，独立复跑命令与记录一致。 |
| Phase 6 · Production Readiness | FAIL | 无 schema 迁移、旧 token cv=0 兼容、日志无 secret；但 T08-C1 是认证绕过，T08-I1 会向正确新凭据返回必死 token。 |
| Phase 7 · 全链路 / 交付契约 | FAIL | API→AuthKey→KV→quota→token→resolve→HTTP/ShareContext 全部有真实生产 consumer；但最终授权 sink 未保证“keyed share 无 Key 绝不签发”，且 cv bump 后重入链路可能被旧 KV 截断。 |

## HOLD vs CHANGE

- **HOLD**：`authKey` 走 JSON body / service options；`matchSec → loadLiveBindings → matchAuthKey → KV` 顺序；过期/撤销 + 错 Key 的冻结错误语义；HMAC+pepper kid 与常量时间比较；无 lockout 表；token `cv` 与旧 token=0 兼容；ShareContext 深冻结；session 响应扩展；attachment 放行 ACCESS_LIMIT_REACHED；schema fence 数字 3。
- **CHANGE**：把 AuthKey enable 状态纳入 quota 授权线性化点并补竞态测试；KV replay 命中前验证 token cv 与当前行一致，旧版本缓存按 miss 处理并补 reset/disable + 同 idem 测试；修正 fence 注释。

## 主 AI 过筛（2026-08-24）

| ID | 真伪 | 比重 | 根因 | 裁决 |
|---|---|---|---|---|
| T08-C1 | 真。`consumeSessionQuota` WHERE 只有 `status`/`expires_at`/`cv`/配额，无 `auth_key_enabled`。AC-AUTH-07 明确 enable 不 bump cv，快照 `enabled=0` 后 Owner enable，旧请求仍能命中 UPDATE。 | 认证绕过，非过度工程。 | 授权线性化点漏了第二因子策略。 | **CHANGE**：谓词加快照 `auth_key_enabled`（0/1 整数）。落空走既有 `quota_race`→`SHARE_UNAVAILABLE`。禁止靠 enable bump cv 修补。 |
| T08-I1 | 真。`readReplayCache` 无条件返回；reset/disable bump cv 后，新 Key + 同 idem 会拿回旧 cv token，`resolveSession` 立即死亡。 | 违反 AC-EDGE-05「新 Key 重新进入并消耗新配额」。 | KV 重放未与 cv 生命周期合流。 | **CHANGE**：hit 后 `verifyToken`，`(payload.cv ?? 0) === (row.credentialsVersion ?? 0)` 才算 hit；stale/校验失败当 miss。enable 不 bump cv，同 key 重放旧 token 仍合法（AC-AUTH-07），勿误伤。`design.md` Session 幂等节补一句交叉语义。 |
| T08-M1 | 真。`:284` 在 `assertAllowed`，不是零 Binding 回落。数字 3 正确。 | 注释误导。 | 文案。 | **CHANGE**：只改 `mail-share.schema.spec.js:143-146` 注释。 |

未勾选尾：T-08 代码审查 CHANGE 落地 → T-09 / T-10 / T-13 → T-29。

## Update Log

- 2026-08-24 · 主 AI:C1/I1/M1 已入库 `bc2b4e2`。`consumeSessionQuota` WHERE 含 `auth_key_enabled`；KV hit 绑 `cv`；围栏注释已改。主 AI 独立 定点 90/90 + 全量 17/317 EXIT=0。

## Recommendations

- 在 `design.md` 的 establish/KV 交叉语义中明确：只有 token cv 与当前行一致的缓存值才算 AC-SESS-10 的有效 hit；stale-cv 值属于 miss。这样 AC-SESS-10 与 AC-EDGE-05 不再由实现自行猜优先级。
- T-16 实现 `enable` 前先落 T08-C1 的 gate predicate；不要靠 enable bump cv 修补，因为冻结状态机明确要求 enable 不使既有 Session 失效。

## Verification

- `git merge-base --is-ancestor a0f23eb 5a81065` → EXIT 0。
- `git rev-parse --verify 695394f^{commit}` → EXIT 0；`git merge-base --is-ancestor 5a81065 695394f` → EXIT 0。
- `git diff --check a0f23eb..5a81065` → EXIT 0。
- `git diff --exit-code 5a81065..HEAD -- <七个目标文件>` → EXIT 0，确认 Evidence/T-12 后续提交未改写本次目标文件。
- `pnpm --dir mail-worker exec vitest run test/share-auth-service.spec.js test/share-api.spec.js test/share-attachment-service.spec.js --no-cache` → EXIT 0，3 files / 79 tests passed。
- `pnpm --dir mail-worker exec vitest run test/mail-share.schema.spec.js --no-cache` → EXIT 0，1 file / 9 tests passed。
- 未重复运行全量 worker suite；`695394f` 的 T-08 Evidence 记录主 AI 已独立运行 `pnpm --dir mail-worker test --no-cache` → EXIT 0（17/289）。本结论不依赖该记录判绿：两项阻塞来自当前生产控制流中可枚举的并发交错。

## VERDICT
status: NEEDS_CHANGES
critical_count: 1
important_count: 1
minor_count: 1
ready_to_merge: NO
one_line: AuthKey 正常链路完整，但 enable 未进入授权线性化谓词可并发绕过第二因子，且 cv bump 后旧 KV 重放会返回必死 token。
