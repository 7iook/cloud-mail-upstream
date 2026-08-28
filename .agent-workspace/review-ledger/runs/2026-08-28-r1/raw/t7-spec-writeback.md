# T7 · 规范、性质与决策卡回写

- 审查提交：`0f4f52c`
- 审查范围：仅该提交的 T7 文档 diff，以及 `themes.md` T7 明示的判据源
- 结论：2 条历史 finding 持续存在；无新增 finding
- risk_spread：`none`

## Finding 1

- persists: `F-0020`
- severity: `P2`
- anchor: `docs/specs/mail-share/design.md:6`
- symbols: front-matter `status`、`last_review_status`、`last_review_p0`、`last_updated`、`shipped_commit`，`Update Log`
- rule_source: `docs/specs/README.md:30-40,51` 规定实现开始后从 `converged` 进入 `in-impl`，交付时进入 `shipped` 并填写 `shipped_commit`；`docs/specs/mail-share/design.md:745-754` 已把 2026-08-26 的落地整改称为 shipped spec 更新。
- identity_scope: `mail-share` design 的机器可发现生命周期元数据与正文已交付记录的一致性。
- failure_mode: `0f4f52c` 再次修改该文档正文的失败响应、错误码、Traceability、性质和 Update Log，却未修改 front-matter；当前仍为 `status: converged`、`last_review_status: NEEDS_CHANGES`、`last_review_p0: 1`、`last_updated: 2026-08-16`、`shipped_commit: null`。正文已记录 2026-08-26 shipped 整改，front-matter 仍表示尚未交付且上次审查有 P0。
- trigger: 规格索引生成器或后续 agent 按 `status` / `shipped_commit` 过滤现行、已交付 spec。
- impact: 已落地且继续修订的 mail-share 判据源会被排除在 shipped 集合外，或被错误解释为仍有 P0 的旧版设计；`docs/specs/README.md:22` 也继续生成 `converged` 状态。
- required_fix: 在规格生命周期的责任层回填真实 `status`、`last_updated`、`shipped_commit` 与审查结果，并由 front-matter 重新生成 `docs/specs/README.md` AUTO-INDEX；若该 charter 有意保持 `converged`，则必须在 front-matter 可机读字段中明确 post-ship 修订的替代状态，而不能只在正文称 shipped。
- verify: 运行 front-matter/索引一致性检查，断言 `mail-share` 不再同时满足“正文含 2026-08-26 shipped 整改”与 `status: converged` / `shipped_commit: null`，且 `docs/specs/README.md` 对该 slug 的状态与 front-matter 一致。
- risk_spread: `none`

## Finding 2

- persists: `F-0021`
- severity: `P2`
- anchor: `docs/architecture/ADR-mailbox-share-capability-extension.md:26`
- symbols: Accepted ADR `Decision`、Visitor failure partition、`P-AUTH-01`、gone 404
- rule_source: `docs/architecture/ADR-mailbox-share-capability-extension.md:5` 将该 ADR 标为 Accepted；`docs/specs/mail-share/design.md:578-582` 与 `docs/specs/mail-share/requirements.md:86,110` 已明确把无行/`REVOKED` 的 gone 从 `SHARE_UNAVAILABLE` 族移出，改为 HTTP 404 空 body。
- identity_scope: Mailbox Share Accepted 架构决定中的 Visitor 失败可区分边界。
- failure_mode: `0f4f52c` 重写 design 的 `P-AUTH-01`，但 Accepted extension ADR 仍规定只有 `lid+sec` 通过者可见 `SHARE_AUTH_REQUIRED`，“其余保持不可区分 `SHARE_UNAVAILABLE`”；ADR 未追加 dated amendment、partial supersession 或 gone 例外。因此现行 spec 与 Accepted ADR 对无行/撤销的响应分族仍给出相反判据。
- trigger: 后续架构设计、审查或实现只读取 Accepted ADR 的 Decision，而不读取 2026-08-26 spec changelog。
- impact: gone 404 会被当作违反 Accepted 架构决定，或旧的 `SHARE_UNAVAILABLE` 行为会被重新引入，P4 的有意推翻无法沿 ADR 链追溯。
- required_fix: 在 `ADR-mailbox-share-capability-extension.md` 的 Decision 责任层追加 dated amendment/partial-supersession，明确无行/`REVOKED` gone 为 HTTP 404 空 body并链接修订后的 AC；若该反转需要独立 ADR，则由新 ADR 显式 supersede 该句。
- verify: 读取 Accepted extension ADR，断言其 Visitor failure partition 明确包含 gone 404 例外及修订日期，并且不再能把无行/撤销解释为 `SHARE_UNAVAILABLE`。
- risk_spread: `none`

取证校正：历史台账把 F-0021 的 anchor 写成 `ADR-mail-share-capability-boundary.md:1`，但该文件当前 `docs/architecture/ADR-mail-share-capability-boundary.md:5` 为 `Proposed`，也没有承载冲突的失败分族句；实际仍冲突且为 Accepted 的来源是上述 extension ADR。本条保持 F-0021 的 identity，不新开 finding。

## 其余核对

- `docs/specs/mail-share/design.md:754` 已改为真实路径 `mail-vue/src/views/share-admin/status.js`；在 `docs/` 中对旧 `mail-vue/src/views/share/status.js` / `views/share/use-share-clock.js` 精确检索均为 0 命中。F-0019 不重开。
- 决策卡 `share-fullchain-decision-card.md:388,391` 的 `1288ac8` 同时包含决策卡、审查 prompt 与 `share-fullchain-decision-card.review1.sub.md`；该 review 文件记录 `NEEDS_CHANGES`、`p0_count: 3`。DOC/REV Evidence 对应。
- 决策卡 `share-fullchain-decision-card.md:400` 的 `d602ec6` 包含 worker 文档/API 404 链及相关客户端、测试；`e309ad4` 的 `mail-vue/src/views/share/index.vue` diff 实际新增 `handleShareGone`、`markShareGone` 与 reload/blank 出口。P4 Evidence 对应。
- `docs/specs/mailbox-share-capability/requirements.md:55` 的 `{amended: ...}` + 删除线保留原文，与同仓 `mail-share/requirements.md:86,110,116` 的 revised/amended 记录方式一致。
- 新错误码同时存在于 `docs/specs/mail-share/design.md:197` 的稳定注册表和 `docs/specs/mailbox-share-capability/design.md:434-435` 的错误处理表。F-0018 不重开。
- F-0006、F-0007、F-0018、F-0019 按历史 resolved 排除；本轮未将其重新编号或重报。
