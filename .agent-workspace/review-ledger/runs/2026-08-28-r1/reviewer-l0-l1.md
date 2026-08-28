# Reviewer L0 + L1 · 2026-08-28-r1

## L0 通用内核（不得被 L1/L2 覆盖）

- 证据先于结论。没有本条消息内跑过/读过的证据，不许下判断。出现「应该 / 可能 / 看起来 / 似乎」= 违规。
- 每条 finding 必须给全：severity / anchor / symbols / rule_source / identity_scope / failure_mode / trigger / impact / required_fix / verify。缺任一项该条作废。
- `anchor` 必须是你真读过的 `<相对仓库根>:<行号>`。
- 判据优先仓库条款；仓库无明文时可引用可复现接口契约、测试后置条件、语言/平台安全不变量或运行时证据。无任何可验证依据才降 `suggestion`。
- severity 由影响与触发条件决定，不由文档覆盖率决定。
- 不重复 mechanical gates。不报风格偏好。无问题写「本主题无 finding」+ 实际查证锚点。
- `risk_spread`：跨出主题 diff 必须写具名风险追踪结果；未跨出写 `none`。无预算的跨 diff finding 非法。
- required_fix 指向上游最早正确责任层，禁下游补丁式建议。

## L1 仓库事实

机械闸门（禁重复人工审）：
- `.github/workflows/deploy-cloudflare.yml`：仅部署，无 lint/test 闸门。
- 无 lefthook / pre-commit / .githooks / AGENTS.md / ARCHITECTURE_RULES.md。

判据源（必须实读，不要凭印象）：
- `docs/specs/mail-share/design.md`
- `docs/specs/mail-share/requirements.md`
- `docs/specs/mailbox-share-capability/design.md`
- `docs/specs/mailbox-share-capability/requirements.md`
- `docs/architecture/ADR-mail-share-capability-boundary.md`
- `docs/architecture/ADR-mailbox-share-capability-extension.md`
- `docs/architecture/ADR-share-credential-recoverability.md`
- `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md`
- `.agent-workspace/.archive/2026-08-26/share-link-fullchain/visitor-share-ui-design.md`
- `.agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md`

历史台账 resolve-once（按主题文件过滤；status=waived/invalidated 不要再报；open/persists 标 `persists: F-XXXX`）：

T1 `mail-share-service.js` / emails 测试：
- F-0003 resolved · account 配额原子谓词
- F-0004 resolved · D1 batch 零行 INSERT vs 整单（close_note 指向已被 790c550 删除的 1/0 哨兵）
- F-0011 resolved · replayBatchFromLids lid 集合相等
- F-0030 suggestion open · D1 batch 行可见性

T2 `mailbox-provision.js`：
- F-0008 P2 open · configuredDomains vs leftover includes
- F-0009 P2 open · emailPrefixFilter 大小写
- F-0010 P2 open · provision → user-service → account-service 间接环
- F-0002 resolved · 缺 role fail-closed

T3 gone / rate-limit：
- F-0001 resolved · sessionStorage SecurityError 阻断 gone 退场
- F-0022 resolved · /S/ 大小写绕过 SHARE_DOC_PATH

T4 visitor SPA gone / overflow：
- F-0027 P2 open · 390 视口 header 溢出
- F-0028 resolved · 超长外部文本撑破视口
- F-0029 P2 open · 终态卡未垂直居中

T5 visitor ElMessage：
- 同上 F-0027 / F-0029（同文件）

T6 wizard：
- F-0005 resolved · unknownResult vs rotateIdempotencyKey
- F-0023 P2 open · 「我已保存」按钮语义
- F-0024 P2 open · 错误远离 emails 输入

T7 spec：
- F-0006/0007/0018/0019 resolved
- F-0020 P2 open · design front-matter vs shipped changelog
- F-0021 P2 open · P4 未 amend Accepted ADR

T8 merge：不重开 2026-08-26-r1 已判 30 条；只回归本轮 fix 覆盖段。

T9 ledger：对照 `ledger.jsonl` / `INDEX.md` / `state.json` / `runs/2026-08-26-r1/` / `runs/2026-08-27-r1/`。
