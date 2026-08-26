# CROSS · 具名跨主题契约边独立审查

- 被审范围：`origin/main..origin/cursor/share-link-fullchain-8a38`，worktree `/tmp/share-review`，HEAD `9b6eb80`
- 主题：`CROSS`
- 已逐边检查：E1、E4、E5、E6、E8、E9、E11；E12 按指令跳过
- `same-file` / `ordering` 未单列；仅 E1 中已经造成契约传播与回滚耦合的提交拆分进入 finding
- 机械闸门：已确认 `.github/workflows/deploy-cloudflare.yml` 只做部署；未重复执行
- 历史台账：无
- 结论：4 条 finding（3 medium，1 low）

## Findings

### CROSS-01 · 展示时钟越界成为写入资格的第二真源

- severity: medium
- theme: `CROSS · T2×T7`
- anchor: `docs/specs/mail-share/requirements.md:116` 的 AC-LIFE-08 amendment；`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:468-470,602-604,930-932,1009-1011,1067-1070`；对照 `mail-worker/src/service/mail-share-service.js:1515-1527,1582-1591,1650-1658`
- evidence: T7 写回的 AC-LIFE-08 明定 `liveEffectiveStatus` 只属于展示层，鉴权与写入仍以服务端每请求计算为唯一真源，且“前端结果不得回写”。T2 却把 `isMutableStatus(liveStatus(detail))` 赋给 `writable`，并在保存、Binding、AuthKey、regenerate 的按钮和函数入口统一短路。`liveStatus` 使用浏览器 `Date.now()`，服务端写谓词使用 Worker 的 `nowText()`；两者没有共享时钟或校时契约。
- failure_mode: Owner 设备时钟快于 Worker 时，前端先把仍被服务端视为 ACTIVE 的记录算成 EXPIRED，所有写请求在发出前即被拦截；反向时钟漂移则仍由服务端拒绝。展示结果因此不只是 UI 快照，而成为不对称的本地授权闸门。
- impact: Owner 会在服务端有效期内失去续期、改配置、增删 Binding、AuthKey 操作和 regenerate，尤其“续期”会因按钮提前失效而无法自救；同时后续消费者无法按 shipped spec 判断应信浏览器时钟还是服务端状态，形成第二真源。
- required_fix: 将视觉状态与命令资格拆开：徽章和文案继续消费 `liveStatus`，写请求不得由客户端推导的 EXPIRED 静默短路，应送到服务端由 `loadMutableShare` / 条件 UPDATE 判定；服务端返回状态拒绝后再刷新详情并转只读。增加浏览器时钟快于 Worker 的契约测试，证明“显示 EXPIRED”不等于“客户端自行拒绝发写请求”。

### CROSS-02 · `SHARE_BINDING_LIMIT` 被跨语义复用为批量分享条数上限

- severity: medium
- theme: `CROSS · T3×T7`
- anchor: `docs/specs/mailbox-share-capability/requirements.md:67`（AC-CAP-13）；`docs/specs/mailbox-share-capability/design.md:300`（`POST /mailShare/create`）；`mail-worker/src/service/mail-share-service.js:23-24,377-393,1200-1202`；`mail-vue/src/views/share-admin/ShareCreateWizard.vue:476-480,514-515`
- evidence: AC-CAP-13 将 `SHARE_BINDING_LIMIT=50` 定义为“每分享 Binding 数量上限”，触发条件是某一条分享的 Binding 数超过 50。T3 在 V2=false 时把 N 个地址分流成 N 条单分享，每条只有 1 个 Binding，却仍在 `assertCreateBody` 以 `body.emails.length > SHARE_BINDING_LIMIT` 拒绝；T7 的 API 契约表随后把这个实现行为写成 `emails` 数量上限，前端也镜像为 `EMAIL_LIMIT=50`。同一常量现在同时代表“每分享绑定数”和“每请求创建分享数”两个不同维度。
- failure_mode: V2=false、地址去重后为 51 个、且用户活跃分享余量足够时，本应生成 51 条各含 1 个 Binding 的合法单分享；请求却在分流前返回 `SHARE_BINDING_LIMIT_EXCEEDED`。错误码还向第三方消费者声称是 Binding 超限，而实际没有任何一条分享接近 Binding 上限。
- impact: 合法批量请求被稳定拒绝，API 的错误维度与 AC-CAP-13 不一致；后续若只调整每分享 Binding 上限，会无意改变批量创建吞吐，反之亦然，两个独立容量策略被锁死为同一个真源。
- required_fix: 不要复用 `SHARE_BINDING_LIMIT`。若业务确需批量请求上限，建立独立且有依据的 batch-size 契约、常量和错误语义；否则 V2=false 应先按单分享分流并只受每条 Binding 上限与 `SHARE_ACTIVE_LIMIT` 约束。同步 Worker、前端镜像和 shipped API 表，并增加“51 个地址、每条 1 Binding、活跃余量充足”的边界测试。

### CROSS-03 · gone 契约提供方与唯一页面消费者分属两个可独立回退的提交

- severity: medium
- theme: `CROSS · T1×T5`
- anchor: 提供方提交 `d602ec6690e9671487ecd735c7fa640d41496bde` 的 `mail-vue/src/request/share.js`、`views/share/session.js`、`composables/useSharePolling.js`；消费方提交 `e309ad4a17c46dcfff896b9d967b322cca4389a7` 的 `mail-vue/src/views/share/index.vue`，符号 `handleShareGone` / `recoverFromUnavailable`
- evidence: `git show --stat d602ec6` 显示 T1 已引入 `ShareGoneError`、`markShareGone`、`reloadShareDocument`、`blankShareDocument`，但没有修改 `views/share/index.vue`。在该提交树上，`index.vue:807-856` 的 `recoverFromUnavailable` 不识别 `isShareGone`；初次建 Session 的 404 经 `fromSession` 落到业务 `showDeadShare`，已打开页的 404 则命中 `:815` 的非 unavailable 分支，仅置 `rateLimited`。`git show e309ad4:mail-vue/src/views/share/index.vue` 才在 `:789` 加入 `handleShareGone`、在 `:837` 接入 `isShareGone`；该提交名义主体却是 T5 视觉。
- failure_mode: checkout/bisect 到 T1 提供方提交，或为回退视觉而单独 revert T5 提交时，请求层已经把 404 升格为新的 gone 契约，但唯一页面消费者未跟上：访客看到业务不可用页或限流状态，而不是清存储后 reload 到原生 404。
- impact: 当前 HEAD 完整，但提交级回滚、cherry-pick 与 bisect 不再保持契约原子性；一次无意的视觉回退会同时撤掉 T1 的安全/生命周期行为，故这不是单纯 ordering 问题。
- required_fix: 将 `index.vue` 的 gone imports、`handleShareGone`、`recoverFromUnavailable` 分支及对应测试归入 T1 契约提交，使 T1 提供方提交自身可运行；T5 只保留视觉变更。至少用“仅 T1”与“HEAD 去掉 T5 视觉”两棵树验证 404 页面恢复契约。

### CROSS-04 · shipped spec 把展示 SSOT 指向不存在的路径

- severity: low
- theme: `CROSS · T2×T7`
- anchor: `docs/specs/mail-share/design.md:754` 的 `mail-vue/src/views/share/status.js`；实际实现 `mail-vue/src/views/share-admin/status.js:1-47`，消费点 `mail-vue/src/views/email/ShareIndicator.vue:20-21` 与 `mail-vue/src/views/share-admin/*`
- evidence: T7 的 Update Log 声明 P1 SSOT 位于 `mail-vue/src/views/share/status.js`，但在 `mail-vue/src/views/**/status.js` 中唯一存在的是 T2 新增的 `share-admin/status.js`；代码消费者也全部从 `@/views/share-admin/status.js` 或同目录 `./status.js` 导入。
- failure_mode: 后续第六个消费面按 shipped spec 查找或导入 SSOT 时找不到目标；若为满足文档另建 `views/share/status.js`，会直接产生第二套状态映射/过期算法。
- impact: 当前运行不受影响，但 T7 作为后续实现与评审的判据源已无法提供可复现源码锚点，并放大 `liveEffectiveStatus` 漂移成第二真源的概率。
- required_fix: 将 shipped spec 的路径改为实际 `mail-vue/src/views/share-admin/status.js`，并把 `use-share-clock.js` 同样锚定到 `share-admin` 目录；不要新增兼容转发文件来迁就错误文档。

## 逐边结论

- E1 `T1 --contract-change--> T5`：有 finding，见 CROSS-03。HEAD 消费完整，但提交/回退边界不原子。
- E4 `T1 --shared-ssot--> T7`：未形成 cross finding。当前五个 Visitor API 均经 `withShare`，`SHARE_DESTROYED` 由 `BizError` 稳定翻译为裸 404；文档入口同样由 `nativeGoneResponse` 收口。
- E5 `T2 --shared-ssot--> T7`：有 finding，见 CROSS-01、CROSS-04。运行边界和源码锚点各有一处漂移。
- E6 `T3 --shared-ssot--> T7`：有 finding，见 CROSS-02。其余 `emails` 优先级、V2 分流、首次/重放响应外形与现有前端消费者对齐。
- E8 `T3 --contract-change--> T6`：未形成 cross finding。向导按 `{shares:[...]}` 渲染两条 `data-test="share-url"`，T6 的两链接断言可命中；幂等重放不由这条 E2E 覆盖，但未发现调用点把重放对象误当首次响应。
- E9 `T2 --contract-change--> T6`：未形成 cross finding。`data-status` 与 `share-active-count` 两个消费钩子存在且取自 `liveStatus`；20 秒 TTL 对明显时区偏移会以“初始即 EXPIRED”或“30 秒内不翻转”失败，不会假绿。
- E11 `T3 --shared-ssot--> T2`：未形成 cross finding。单条与批量创建都以同一个 UTC `YYYY-MM-DD HH:mm:ss` 字符串写 `expires_at`，list/get 原样投影，`expiresAtUtcMs` 明确补 `Z` 按 UTC 解析；未发现第二个格式真源。

## 转主 AI（不作为 CROSS finding）

- T3 内部：`replayBatchFromLids` 只在 `rows.length===0` 时抛 `SHARE_NOT_FOUND`，未校验回读到的 distinct share 数等于幂等记录中的 `lids.length`；批量中仅一条被保留期清理时会返回幸存子集。该问题落在 T3 单主题幂等重放内部，请转对应主题。
- T2 内部：`ShareIndicator` 无参 list 只拿后端 deprecated 分支的最新 500 条再本地计数，超过 500 条保留记录时会漏算当前邮箱的 ACTIVE 分享。该问题落在 T2 单主题聚合内部，请转对应主题。

## VERDICT

status: NEEDS_CHANGES
medium_count: 3
low_count: 1
one_line: gone 的提交级契约不原子，Owner 展示时钟越界成写闸门，且 create 文档把每分享 Binding 上限错误复用为批量分享条数上限。
