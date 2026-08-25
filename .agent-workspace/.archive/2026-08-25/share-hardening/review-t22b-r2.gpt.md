# T-22b 第二轮独立代码复审

审查基线：`632a931`；范围：工作区 21 个已跟踪改动文件。按要求先读上一轮报告，未读取任何 `fix-*.md` / `exec-*.md`。

## Strengths

- `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:149-184,521-590,803-899`：详情抽屉已有可操作的续期控件；预设/指定时刻落到 `form.expiresAtLocal`，`buildPatch()` 只在与详情快照不同时写入 `expiresAt`，未修改时不会误发。
- `mail-worker/src/service/mail-share-service.js:984-1003,1038-1057,1371-1389`：续期上限以 `create_time` 为基准，`expires_at/delete_at` 同语句更新；CAS 的 `credentials_version + expires_at` 真正在 `UPDATE ... WHERE` 中，零命中再分流。
- `mail-worker/src/service/share-auth-service.js:209-223,261-326`：token 的结构与时间不变量已收口到 `parseToken()`；正常读取和过期 token 续期都复用该边界。
- 独立实跑：后端 `pnpm vitest run test/mail-share-service.spec.js test/share-auth-service.spec.js test/share-api.spec.js` → EXIT=0，325 tests passed；前端 `pnpm vitest run src/request/share.spec.js src/views/share-admin/ShareDetailDrawer.spec.js src/views/share/index.spec.js` → EXIT=0，122 tests passed；`git diff --check 632a931` → EXIT=0。

## 上轮四条逐项判定

### P0-1：已关闭

- 代码证据：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:149-184` 提供“保持/按预设延长/指定时刻”控件；`:573-590` 把选择写入本地到期值；`:803-840` 的 `buildPatch()` 仅在 `isRenewDirty()` 为真时生成 UTC `expiresAt`；`:843-899` 完成前端校验、请求和错误上屏。
- 业务链路：控件值 → `form.expiresAtLocal` → `patch.expiresAt` → `updateMailShare(body)` 已贯通；`ShareDetailDrawer.spec.js:618-727` 同时覆盖“改了会发”“没改不发”“改后选保持不发”。
- 前后端口径：前端 `ShareDetailDrawer.vue:525-567` 与后端 `mail-share-service.js:984-997` 都从创建时刻计算总上限；后端配置可比前端镜像更严格时，`:889-895` 会把 `SHARE_DURATION_EXCEEDED` 明确显示给管理员，不会静默失败。

### P0-2：已关闭；上一轮对“并发撤销必须再加 CAS”的表述过宽

- CAS 已进入写语句：`mail-worker/src/service/mail-share-service.js:1038-1057` 的 `WHERE` 同时含 `credentials_version = ?` 与 `expires_at = ?`，`:1371-1389` 将预读快照原值绑定进去。它不是只读检查。
- 零命中分流正确：`:1060-1069` 重新走 `loadMutableShare()`；行不存在/已撤销/已过期返回 `SHARE_NOT_FOUND`，行仍活跃但快照变化返回 `SHARE_UPDATE_CONFLICT`。前端在 `ShareDetailDrawer.vue:896-900` 给出可操作提示。
- 并发撤销原本已安全：`mail-share-service.js:451-457` 的撤销写把 `status` 改为 `REVOKED`，而续期写 `:1045-1048` 已有 `status = 'ACTIVE'`；撤销先提交则续期零命中，续期先提交则撤销随后合法提交，二者都有可解释线性顺序。因此撤销无需再由两列 CAS 识别。
- CAS 对共享 `prepareUpdate()` 的扩散未发现误报缺陷：所有 owner patch 都先读同一行再写；期间若凭据轮换或另一 owner update 改了 CAS 列，返回冲突要求重读是保守且一致的语义。常规字段修改本身不改 `credentials_version`，只有续期改 `expires_at`；测试 `mail-share-service.spec.js:2899-2970` 覆盖凭据轮换、撤销、双续期及普通改名。

### P1-3：已关闭

- 单一解析边界：`mail-worker/src/service/share-auth-service.js:225-289` 的 `parseToken()` 统一完成验签、基本字段和 `hasSaneLifetime()`；`:294-300` 的 `verifyToken()` 只追加“当前未过期”，`:318-331` 的续期只追加 share/lid/cv/grace 判据，没有第二套时间结构校验。
- 签发与上限自洽：`:209-223` 的 `sessionTtl()` 同时供 `issueToken()` 使用，解析上限 `maxTokenLifetime()` 取当前 TTL 与默认 900 秒的较大值，避免配置降到 300 秒后误杀此前合法签发的 900 秒 token。对应回归测试在 `share-auth-service.spec.js:2181-2224`。
- “无 exp token 被读路径视为永不过期”属实且已修：旧 `verifyToken()` 的 `payload.exp <= now` 对 `undefined` 为 false；新 `hasSaneLifetime()` 在 `share-auth-service.js:226-237` 要求 `iat/exp` 都是有限数，缺失 `exp` 或 `iat` 均在共享解析边界拒绝。测试覆盖缺失/非数 `iat`，实现逻辑也直接覆盖缺失 `exp`。

### P2-4：已合理归置，但尚未从工作区物理拆分

- `tests/e2e/specs/capability-v2-fence.spec.js:33-56` 仍是 6 行独立错误码断言变更；`git log --all` 显示来源为更早的 V2 fence 工作，和续期/CAS/token 修复无因果关系。
- 当前尚未提交，无法从代码证明最终会单独 commit；但改动边界清晰、无生产行为耦合。合入时应按其历史来源单独提交并在提交说明注明来源。

## Issues

### P0

无。

### P1

无。

### P2

#### 1. 畸形 token 测试缺少“exp 缺失/非数”的直接样本

- 锚点：`mail-worker/test/share-auth-service.spec.js:2143-2180`
- What：测试直接覆盖了 `iat` 缺失/非数、`exp <= iat` 和超长生命周期，但没有单独构造 `exp` 缺失、`null` 或字符串的有效签名 token。
- Why：生产实现 `share-auth-service.js:233-237` 已正确拒绝，因此不是当前功能缺陷；但上一轮明确指出 `exp` 结构关系，缺直接回归样本会让未来有人只保留 `iat` 校验时不易被测试捕获。
- How：在现有畸形 token 表中补 `exp` 缺失、`null`、字符串三类，并同时断言 `resolveSession()` 与续期路径拒绝。

## 新增测试质量

- CAS 并发测试不是空过：`mail-share-service.spec.js:2874-2970` 用代理把干扰精确插入预读与 `UPDATE` 之间，并断言数据库最终状态；移除对应 WHERE 列会使凭据轮换/双续期用例翻红。
- 续期 UI 测试同时验证正反路径：`ShareDetailDrawer.spec.js:618-653` 对“改了会发、未改不发、改后回退不发”分别断言请求体/调用次数。
- token 测试以有效签名畸形 payload 走真实解析边界，不是只测 helper 或 mock；唯一覆盖不足见 P2。

## 7-Phase 结论

1. Spec Conformance：通过；上轮三项功能缺口均已关闭，无新核心需求遗漏。
2. Task-Ledger Evidence：not applicable；本次审查不以任务清单为验收对象。
3. Code Quality：通过；续期、CAS、token 解析均保持单入口，无平行实现。
4. Domain Model：not applicable；本轮没有适用的 `docs/domain/*-model.md`。
5. Upstream Root Cause：通过；修复落在 owner update 写谓词和 token 解析边界。
6. Whole Path：通过；管理员续期链路、访客 token 续期链路都有生产 caller 与 HTTP/组件验证。
7. Business Reality：通过；新增能力直接服务“管理员延长分享”和“同一访客不重复占配额”，未发现技术空缺被扩成无需求功能。

## VERDICT
status: APPROVED
critical_count: 0
important_count: 0
minor_count: 1
ready_to_merge: YES
one_line: 上轮 P0-1、P0-2、P1-3 已由真实生产链路和并发/畸形输入回归关闭，P2-4 边界已明确，仅剩一项非阻断的 token 测试覆盖补强。
