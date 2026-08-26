# T7 独立审查 · spec writeback

## 审查范围

- 主题：T7 · 把本轮口径改动回写进决策卡与 shipped spec
- 提交：`1288ac85af8d51329862355cbc8d07b1ad7d22b9`、`82f330e720acb70069e77dda1f84ee0360b96c67`、`9b6eb8072fe73c93518e872037702a2e8e54056b`
- 判据：`themes.md` T7 `review_focus` 1–5；交叉核对 T1/T2/T3 点名源码
- 机械闸门：未重复审 `deploy-cloudflare.yml`；该工作流只部署，不覆盖本主题的 spec 一致性与测试证据
- 历史台账：无

## 取证

### 1. spec 与实现逐句核对

- `mail-worker/src/api/share-api.js:61-116` 共注册五个 Visitor 路由：`session`、`mails`、`mailboxes/status`、`mail`、`attachment`；五者均由 `withShare(...)` 包裹。`withShare` 在 `:24-44` 将内部 `SHARE_DESTROYED` 翻成 `nativeGoneResponse()`，因此 AC-VISIT-04 所称“全部访客 API”在当前路由集合内有实现依据。
- `mail-vue/src/views/share/index.vue:762-767,789-797` 显示 `handleShareGone()` 先调用 `clearMailboxView()`；后者依次清除 `share:session:<lid>` 与 `share:est-key:<lid>`，随后才执行 `markShareGone()` 和 reload/blank。AC-SEC-07 的清理顺序与实现一致。
- P1 的实际 SSOT 是 `mail-vue/src/views/share-admin/status.js:26-47`，时钟是同目录 `use-share-clock.js:1-55`。决策卡 `share-fullchain-decision-card.md:113` 也写的是这个路径；只有 shipped spec `docs/specs/mail-share/design.md:754` 写成不存在的 `mail-vue/src/views/share/status.js`。

### 2. Deprecated 范围

- `docs/specs/mailbox-share-capability/design.md:300` 明确只废弃“向导账号下拉/前缀拼接作为创建前置”，同一行同时保留 `accountId`/`accountIds` 兼容契约。
- `mail-vue/src/views/share-admin/presets.js:7-22` 的 `CREATE_BODY_KEYS` 同时保留 `accountIds` 与 `emails`；`mail-vue/src/request/mail-share.js:42-54` 仅在非空 `emails` 时不发送 account id，旧入口仍发送 `accountId(s)`。该 Deprecated 表述不会把 AC-CAP-10 的快捷入口误废弃。

### 3. P4 推翻记录完整性

- 四条点名 AC 已保留原文删除线并注明 `{revised: 2026-08-26, by: share-fullchain P4}`：mail-share 的 AC-VISIT-04/AC-LIFE-03，以及 mailbox-share-capability 的 AC-AUTH-02/AC-EDGE-03；AC-SEC-07 也有 dated amendment。
- 但改写没有覆盖同一 shipped spec 内仍处于 active 的其它规范段、形式化性质与 Traceability。具体冲突见 T7-02～T7-04。
- 账号删除不是抽象边角：`mail-worker/src/service/account-service.js:154-159,243-247` 在删除前调用分享级联；`mail-worker/test/account-delete-share.spec.js:206-225` 明确断言删除导致 `REVOKED`，随后 `resolveSession` 返回 `SHARE_DESTROYED`。这与 mail-share AC-LIFE-09 仍写 `SHARE_UNAVAILABLE` 直接冲突。

### 4. Evidence 可复算性

- 决策卡给出了三条完整命令：`pnpm -C mail-worker test`、`pnpm -C mail-vue test`、`SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs`，命令形状可复现。
- 按本次指令未为对齐数字复跑长测试套件，因此 `25 files / 854 passed`、`26 files / 370 passed`、`23 passed` 均记为 **unverified**；本审查没有可报告的测试退出码。
- P5 截图证据不可复现：决策卡 `:206,267` 明定桌面 1280 与移动 390 必须截图或 GUI 验收、不得只靠钩子测试；任务 `:401-402` 却只写“截图 desktop 1280 / mobile 390”，没有文件名、路径、哈希或查看方式。归档目录没有图片/HAR/视频，当前 `/opt/cursor/artifacts` 也为空。

### 5. 归档内容安全

- `.agent-workspace/.archive` 已有同构的 `2026-08-24/mailbox-share-capability/prompt.round1.sub.txt`，提交 prompt 属既有归档惯例。
- 对本主题归档按私钥头、常见 API key/token/password 赋值、私网 IPv4 等模式检索未命中。命中的 `secret`/`token` 均是规格术语，URL 仅 Vue 与 MDN 公共文档；未发现凭据、内网地址或第三方私有信息。

## Findings（七项字段）

```yaml
findings:
  - issue_id: T7-01
    severity: P1
    target_file: docs/specs/mail-share/design.md
    anchor: "**P1 · 局部修订 Owner 展示纪律（AC-LIFE-08 行内 amended）**"
    action: pattern_rewrite
    intent: 将 P1 SSOT 路径改为实际存在的 mail-vue/src/views/share-admin/status.js，并把 use-share-clock.js 同样锚定到 share-admin 目录
    rationale_short: 当前 shipped spec 指向不存在的 views/share/status.js，实际实现与决策卡都在 views/share-admin，错误锚点会诱导后续实现另建第二 SSOT

  - issue_id: T7-02
    severity: P1
    target_file: docs/specs/mail-share/requirements.md
    anchor: "- [AC-VISIT-14] THE MailShareApp SHALL"
    action: pattern_rewrite
    intent: 以 dated amendment 同步 AC-VISIT-14、AC-LIFE-09、AC-RT-16，将 gone 的清理与 HTTP 404 分支从 SHARE_UNAVAILABLE 分支中拆出，同时保留被推翻原文
    rationale_short: AC-VISIT-04 已规定所有 REVOKED 为 gone 404，但三个 active AC 仍分别声称撤销、账号删除或任意非 ACTIVE 返回 SHARE_UNAVAILABLE；账号删除实现与测试已证明会先 REVOKE 再返回 SHARE_DESTROYED

  - issue_id: T7-03
    severity: P1
    target_file: docs/specs/mail-share/design.md
    anchor: "**错误码边界**："
    action: pattern_rewrite
    intent: 同步当前规范段、Share Session 契约、正式函数 Errors、Error Handling、Traceability 与 P-AUTH-01，统一为 gone 404 与 unavailable 两族；历史记录保持原样
    rationale_short: 错误码注册表、函数后置条件、错误表、测试矩阵和性质仍把不存在/销毁纳入 SHARE_UNAVAILABLE，直接否定同文件 2026-08-26 Update Log 与已修订 AC

  - issue_id: T7-04
    severity: P1
    target_file: docs/specs/mailbox-share-capability/design.md
    anchor: "- **Decision 8 · AuthKey**"
    action: pattern_rewrite
    intent: 同步 Decision 8、错误语义表、Visitor API 表、正式函数 Errors、Error Handling、Traceability 与 P-AUTH-01，使不存在/REVOKED 明确走 SHARE_DESTROYED 到裸 404，其余失败保持 SHARE_UNAVAILABLE
    rationale_short: requirements 的 AC-AUTH-02/AC-EDGE-03 已修订，但 design 的多处当前态契约仍写其余一律 SHARE_UNAVAILABLE，且 Traceability 仍要求不存在恒为 SHARE_UNAVAILABLE、撤销读维持旧基线

  - issue_id: T7-05
    severity: P2
    target_file: .agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md
    anchor: "- [x] P5 按 UI 设计卡改访客视觉（桌面+移动验收）"
    action: replace_section
    intent: 为桌面 1280 与移动 390 验收补可访问的 artifact 路径与结果，若证据已丢失则将该项明确标为 unverified 而非声称已有截图
    rationale_short: 本卡把截图定为必做且禁止仅凭钩子测试收尾，但勾销 Evidence 没有任何可定位产物，归档与指定 artifact 目录均无法复核该声明
```

## 结论

`NEEDS_CHANGES`。P4 的核心 AC 留痕、五个 Visitor API 包裹、gone 前清理顺序、create `emails[]` 契约及 Deprecated 边界均有实现证据；但 shipped spec 仍有一处错误 SSOT 路径和三组当前态契约冲突，尚不能作为后续评审的可靠判据源。P5 视觉验收的勾销证据也缺少可复现锚点。

## VERDICT
status: NEEDS_CHANGES
p0_count: 0
p1_count: 4
p2_count: 1
one_line: P4 主 AC 已留痕，但两份 shipped design 与 mail-share active AC 仍保留旧 SHARE_UNAVAILABLE 口径，且 P1 路径和 P5 证据不可复核。
