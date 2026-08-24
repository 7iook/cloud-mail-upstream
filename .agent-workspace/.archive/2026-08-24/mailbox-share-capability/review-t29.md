VERDICT APPROVED

# T-29 · mailbox-share-capability 收尾审查

## P0

无。`p0=0`。

## P1

无。`p1=0`。

## P2

- **P2-1 · Accepted ADR 的 Consequences 仍残留旧栅栏名。** `docs/architecture/ADR-mailbox-share-capability-extension.md:41` 仍称双写风险由 `SHARE_MULTI_ENABLED` 门控；该标识已被 `SHARE_CAPABILITY_V2` 取代。当前 Decision 与实施结论分别在 `:24`、`:53` 正确写明 V2 默认 false，生产配置也正确，因此不阻塞本轮，但 Accepted 文档的这一处会误导按 Consequences 检索部署开关的接手者。建议仅把 `:41` 的旧名改为 `SHARE_CAPABILITY_V2`。
- **P2-2 · D-3 的生产锚点被本轮两行改动推后。** `docs/specs/mailbox-share-capability/design.md:680` 引用 `mail-vue/src/views/share/index.vue:902-908`，当前 `bootstrap()` 与配置缺省清理实际位于 `:904-910`；原范围从上一函数的闭合括号开始，且漏掉核心 `refreshIntervalMs` / `expiresAt` 两行。债目事实与测试锚点仍正确，建议把该锚点更新为 `:904-910`。

## 审查结论

- **范围与负向约束成立。** `a7172fb..7a412e5` 只有提交 `7a412e5`；产品改动限于两份 README、ADR/spec 元数据、两份 locale、访客页两行清理及对应测试，另有执行记录与 session ledger 收口。`mail-worker/**`、`docs/architecture/ADR-mail-share-capability-boundary.md`、`docs/specs/mailbox-share-capability/requirements.md` 在该范围内均为零差异，`CHANGELOG.md` 不存在。`docs/specs/mailbox-share-capability/tasks.md:643-645` 的 T-29 / T-29.1 / T-29.2 仍为 `[ ]`，符合“审查后由协调者勾选”的锁定流程。
- **文档收口成立。** ADR 已转 Accepted，并在 `docs/architecture/ADR-mailbox-share-capability-extension.md:48-55` 增加实施结论；`SHARE_CAPABILITY_V2` 默认 false、受控能力整体冻结、激活属于部署动作均写明，Decision `:24` 也再次明确默认 false。`docs/specs/mailbox-share-capability/design.md:6,12` 为 `status: shipped` / `shipped_commit: 190f704`，没有自引 `7a412e5`；`:672-680` 仅登记 D-1/D-2/D-3，没有 D-4。`docs/specs/README.md:23` 已同步 shipped。
- **README 成立。** `README.md:73` 与 `README-en.md:68` 各新增一条邮箱分享能力说明，均涵盖不可猜链接、未登录只读、时限、会话上限、可选访问密钥与验证码提取，且两份 README 均未出现环境变量名。
- **i18n 集合与形状成立。** 独立校验基线 zh/en 各 384 个唯一键，Head 各 480 个唯一键，新增恰 96 个；两侧差集为空、重复键为 0，新增位置紧跟 `shareVisitNoSubject`。新增集合恰等于 5 份 `PENDING_COPY` 的 86 键并集加访客 10 键；访客 10 个英文值与 `mail-vue/src/views/share/index.vue` 的 `tx()` fallback 逐字相等。`mail-vue/src/i18n/en.js:396` 的 `shareStatusLimitReached` 为 `Session limit reached`；删除/销毁、末邮箱/普通移除、重置/关闭确认文案均互异；`:444-445` 的展示文案未命中保密黑名单，锁定 hint 逐字匹配。
- **PENDING_COPY 与接线成立。** 5 个生产 Vue 文件在审查范围内零差异，且各保留一份 `PENDING_COPY` 与 `tf()` fallback：`mail-vue/src/views/share-admin/index.vue:120-134`、`ShareCreateWizard.vue:356-404`、`ShareDetailDrawer.vue:352-404`、`ShareRowActions.vue:47-54`、`mail-vue/src/views/email/ShareDialog.vue:105-110`。补键后 `te(key) ? t(key)` 成为既有生产消费路径；间接 `labelKey` / `successKey` 键也包含在验证过的 86 键并集中，没有建立第二份文案真源。
- **F-4 是上游最小修复。** 生产 Vue 差异严格只有 `mail-vue/src/views/share/index.vue:671` 与 `:825` 两处 `expiresAt.value = ''`；前者从 `clearMailboxView()` 一次覆盖 unavailable/timedout，后者保持 `exitShare()` 原执行顺序，没有改成调用 `clearMailboxView()`，也没有其它 Vue 行为变化。两条新单测位于 `mail-vue/src/views/share/index.spec.js:1482-1518`，分别钉住 dead-share 与主动离开。
- **E2E 接在真实生产节点。** `tests/e2e/specs/visitor-revoke-live.spec.js:24-28` 在进入 unavailable 后对生产模板 `mail-vue/src/views/share/index.vue:17-22` 的 `[data-share-expires]` 断言 count=0；这是新增覆盖，不是改写旧红断言。
- **V2 栅栏保持关闭。** `mail-worker/wrangler.toml:58-60` 仍只有注释声明，`mail-worker/src/service/mail-share-service.js:67-69` 对缺省值返回 false；`tests/e2e/wrangler-e2e.toml` 无 V2 变量，`mail-worker/wrangler-vitest.toml:40-41` 仍为 `"false"`。本提交未改 Worker、未加入密钥或凭据值。
- **用户成功态仍有端到端证据。** 强制重建后的 19 条浏览器用例覆盖未登录新访客、不可猜链接、多邮箱 Tab/OTP 复制、AuthKey、Session 配额、撤销/过期、无跨邮箱读取、轮询与幂等重放；本轮新增的倒计时断言与既有全链路一起通过。

## 测试证据

- `pnpm --dir mail-vue test -- --no-cache` → EXIT=0，**22 files / 252 passed**。
- `pnpm --dir mail-worker test -- --no-cache` → EXIT=0，**18 files / 626 passed**。
- E2E 前端口检查：环境无 `ss`，以 `fuser 8788/tcp` 加 Python bind 探针确认无监听 PID，输出 `PORT_8788_FREE`；未 kill 任何进程。
- `SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs` → EXIT=0，先重建 `mail-vue` bundle，再跑 Chromium **19 passed / 0 skipped**；`visitor-revoke-live` 通过。
- i18n 独立运行时/源码集合校验 → `I18N_OK baseline=384/384 head=480/480 added=96 pending_union=86 visitor=10 symmetric=true duplicates=0`；四组英文形状与锁定 hint 全过。
- 无落盘变异测试：在 Vitest 读取 `index.vue` 时仅以内存 hook 去掉两处 `expiresAt` 赋值，再定点运行新增两条用例 → **1 file failed / 2 failed / 53 skipped**，两处均为 `[data-share-expires]` “expected true to be false”；证明两条回归测试会在无修复时变红，工作树未被改写。
- `git diff --check a7172fb..7a412e5` → EXIT=0；受保护路径零差异、Head 无 `CHANGELOG.md` 的范围闸门 → `RANGE_GUARDS_OK`。

## VERDICT
status: APPROVED
critical_count: 0
important_count: 0
minor_count: 2
ready_to_merge: YES
one_line: T-29 的文档、96 键 i18n、两处 expiresAt 根因修复及强制重建 E2E 均满足锁定裁决，仅有两处非阻塞文档锚点/旧标识需后续校正。

## Update Log

- 2026-08-24 · 主 AI过筛：采信 APPROVED p0=0。P2-1/P2-2 均用当前文件核实为真，随勾选提交改 ADR `:41` 与 D-3 锚点 `:904-910`（文档校正，不重开审查）。历史 R2 Update Log 中的 `SHARE_MULTI_ENABLED` 不改。
