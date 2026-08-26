# T7 · shipped spec 契约回写审查

审查提交：`82f330e720acb70069e77dda1f84ee0360b96c67`

## Finding 1

- severity: P1
- anchor: `docs/specs/mail-share/design.md:411`
- symbols: `P-AUTH-01`、`AC-VISIT-04`、`AC-VISIT-07`、`AC-LIFE-03`、Traceability 矩阵
- rule_source: `docs/specs/mail-share/requirements.md:86,110` 与 `docs/specs/mailbox-share-capability/requirements.md:107,210` 已把 gone 定义为 HTTP 404 空 body；同提交新增的 Update Log `docs/specs/mail-share/design.md:749-752` 也声明测试契约已同步。
- identity_scope: Visitor gone（`lid` 无行或 `status='REVOKED'`）的失败分族及其验证契约。
- failure_mode: 两份 requirements 已把 gone 切成 404 族，但 `mail-share/design.md:162,192,197,230,366,411,414,426,578-582` 与 `mailbox-share-capability/design.md:429,514,561,572,617-621` 仍把不存在/撤销纳入 `SHARE_UNAVAILABLE` 或逐字节相同性质，同一 shipped spec 同时给出互斥判据。
- trigger: 后续 reviewer、测试生成器或维护者从 Correctness Properties、Error Handling 或 Traceability 矩阵取判据时会继续要求 missing/revoked 与 expired/bad-sec 同貌。
- impact: 正确的 404 实现会被判为回归，或旧的 `SHARE_UNAVAILABLE` 行为会按仍属现行的性质段被重新引入。
- required_fix: 在两份 design 中一次性重写失败响应、Error Handling、`P-AUTH-01` 与相关 Traceability 行，并同步 `mail-share/requirements.md:97,154` 等仍把撤销归入 `SHARE_UNAVAILABLE` 的相邻 AC，使 gone 只属于 404 族、其余失败才属于 unavailable 族。
- verify: `python3 -c 'from pathlib import Path; a=Path("docs/specs/mail-share/design.md").read_text(); b=Path("docs/specs/mailbox-share-capability/design.md").read_text(); assert "四种非法输入（不存在/错 sec/过期/已销毁）响应逐字节相同" not in a; assert not any("销毁后访问" in x and "SHARE_UNAVAILABLE" in x for x in a.splitlines()); assert not any("lid 不存在/sec 错 + 任意 authKey" in x and "SHARE_UNAVAILABLE" in x for x in b.splitlines()); assert not any("建会话→撤销→读" in x and "SHARE_UNAVAILABLE" in x for x in b.splitlines()); assert "不存在/密钥错/过期/撤销/触顶/功能关" not in b'`；期望退出码 `0`。
- risk_spread: none（四个命中文件均属于 T7 提交的 spec surface）。

## Finding 2

- severity: P1
- anchor: `docs/specs/mailbox-share-capability/requirements.md:55`
- symbols: `POST /mailShare/create`、`AC-CAP-01`、`AC-CAP-03`、`AC-CAP-09`、`AC-LIFE-11`、`buildEmailCreateResponse`、`assertCreateBody`
- rule_source: 本提交写入的 `docs/specs/mailbox-share-capability/design.md:300` 与决策卡 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:87-109` 定义了 `emails[]`、find-or-create、V2=false 的 N 条单分享、`{shares:[...]}` 及两个稳定错误码。
- identity_scope: Owner `POST /mailShare/create` 的 `emails[]` 外部请求、响应、幂等与发布栅栏契约。
- failure_mode: capability requirements 和 Traceability 矩阵完全没有 `emails[]`、批量分流、`SHARE_EMAIL_INVALID`、`SHARE_DOMAIN_NOT_CONFIGURED`，仍只规定 accountId 集合创建一条 share；同时 `AC-LIFE-11` 仍规定栅栏错误为 `SHARE_INVALID_CONFIG`，与新 API 表及实现的 `SHARE_CAPABILITY_NOT_ENABLED` 冲突。
- trigger: 后续实现或验收只按 requirements/AC 执行单/多邮箱 create 时，会把多地址理解为一条 multi、在 V2=false 下拒绝，或继续断言旧栅栏错误码。
- impact: 本主题声称写回的第二项对外契约没有进入可验收 AC，API 表、requirements 与实现会继续三方漂移。
- required_fix: 在 capability requirements 中新增或修订 create AC，完整固定 emails 优先级、建号副作用与整单原子性、V2=true/false 分流、单对象/`shares[]` 响应、幂等指纹及错误码，并为这些分支补齐 Traceability 行且统一 `AC-LIFE-11` 的实际栅栏码。
- verify: `python3 -c 'from pathlib import Path; s=Path("docs/specs/mailbox-share-capability/requirements.md").read_text(); required=("emails[]","SHARE_EMAIL_INVALID","SHARE_DOMAIN_NOT_CONFIGURED","SHARE_CAPABILITY_NOT_ENABLED","{shares"); assert all(x in s for x in required); assert any("emails" in x and x.startswith("- [AC-CAP-") for x in s.splitlines())'`；期望退出码 `0`。
- risk_spread: none（缺口位于本提交已修改的 capability requirements/design 契约面内）。

## Finding 3

- severity: P2
- anchor: `docs/specs/mail-share/design.md:197`
- symbols: `错误码（稳定注册表）`、`SHARE_DESTROYED`、`SHARE_EMAIL_INVALID`、`SHARE_DOMAIN_NOT_CONFIGURED`
- rule_source: `docs/specs/mail-share/requirements.md:86` 明定 `SHARE_DESTROYED` 的内部码边界，`docs/specs/mailbox-share-capability/design.md:300,434-435` 明定两个新的 Owner 侧稳定错误码。
- identity_scope: Mail Share 对外及内部转换使用的稳定错误码命名空间。
- failure_mode: 名为“稳定注册表”的现行段落仍声称 `SHARE_UNAVAILABLE` 覆盖不存在/销毁，且三个本轮新增码一个都未注册。
- trigger: 后续代码审查、前端映射或文档生成以稳定注册表作为错误码全集时会遇到这三个未登记码。
- impact: 正确实现会被当作野码，且 `SHARE_DESTROYED` 究竟只供内部 404 转换还是可出响应体没有单一注册真源。
- required_fix: 更新稳定注册表，移除 `SHARE_UNAVAILABLE` 对 gone 的归属，登记两个 Owner 侧公开码，并把 `SHARE_DESTROYED` 明确登记为只能在 `withShare` 内转换、不得进入响应体的内部码。
- verify: `python3 -c 'from pathlib import Path; s=Path("docs/specs/mail-share/design.md").read_text(); line=next(x for x in s.splitlines() if x.startswith("错误码（稳定注册表）")); assert all(c in line for c in ("SHARE_DESTROYED","SHARE_EMAIL_INVALID","SHARE_DOMAIN_NOT_CONFIGURED")); assert "不存在/过期/销毁" not in line'`；期望退出码 `0`。
- risk_spread: none（注册表与新码定义均在 T7 的四份 spec surface 内）。

## Finding 4

- severity: P2
- anchor: `docs/specs/mail-share/design.md:754`
- symbols: `liveEffectiveStatus`、`useShareClock`
- rule_source: 决策卡 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:113-117` 把 Owner 展示 SSOT 定位在 `mail-vue/src/views/share-admin/status.js`；工作树中该文件与同目录 `use-share-clock.js` 均存在，而 `mail-vue/src/views/share/status.js` 不存在。
- identity_scope: Owner 展示态 SSOT 的文档路径身份。
- failure_mode: Update Log 把 Owner 管理面状态实现锚到访客目录下一个不存在的 `views/share/status.js`，并把 `use-share-clock` 写成无目录锚点。
- trigger: 后续 agent 按 shipped spec 追踪 `liveEffectiveStatus` 或评估 Owner 展示回归面时会进入错误的匿名访客目录。
- impact: P1 的真实 SSOT 和五个 Owner consumer 无法从规格锚点复现，文档回写失去可追踪性。
- required_fix: 把两处锚点改为完整真实路径 `mail-vue/src/views/share-admin/status.js` 与 `mail-vue/src/views/share-admin/use-share-clock.js`。
- verify: `test ! -e "mail-vue/src/views/share/status.js" && test -f "mail-vue/src/views/share-admin/status.js" && test -f "mail-vue/src/views/share-admin/use-share-clock.js" && rg -q 'mail-vue/src/views/share-admin/status\.js.*mail-vue/src/views/share-admin/use-share-clock\.js' "docs/specs/mail-share/design.md"`；期望退出码 `0`。
- risk_spread: name=`文档锚点 ↔ 真实文件路径`; origin=`docs/specs/mail-share/design.md` 2026-08-26 Update Log; hops=`1`; surfaces=`mail-vue/src/views/share-admin/`、`mail-vue/src/views/share/`; stop=`错误路径零命中，两个真实文件均在 share-admin 命中`。

## Finding 5

- severity: P2
- anchor: `docs/specs/mail-share/design.md:6`
- symbols: front-matter `status`、`last_updated`、`shipped_commit`、`docs/specs/README.md` AUTO-INDEX
- rule_source: `docs/specs/README.md:30,51` 定义生命周期必须从 `converged` 经 `in-impl` 到 `shipped`，交付时填写 `shipped_commit`；本提交的 `docs/specs/mail-share/design.md:747` 又明确称其为 shipped spec。
- identity_scope: `mail-share` 与 `mailbox-share-capability` 两份 charter 的生命周期和发现元数据。
- failure_mode: `mail-share` 仍是 `status: converged`、`shipped_commit: null`、`last_updated: 2026-08-16`，README 索引也仍显示 converged；capability 虽为 shipped，但本轮正文已在 2026-08-26 更新而 `last_updated` 仍为 2026-08-24。
- trigger: 索引生成、规格发现或后续 agent 按 front-matter 过滤 shipped/current spec 时会把基础 charter 排除或把本轮修订视为旧版本。
- impact: 本提交的目标是把新行为写回 shipped 判据源，但判据源的机器可发现状态否认其已交付或已在本日更新。
- required_fix: 按仓库生命周期规则回填 `mail-share` 的真实 shipped 状态与实际交付提交，更新两份 design 的 `last_updated`，并从 front-matter 重新生成 README 索引。
- verify: `python3 -c 'from pathlib import Path; a=Path("docs/specs/mail-share/design.md").read_text().split("---",2)[1]; b=Path("docs/specs/mailbox-share-capability/design.md").read_text().split("---",2)[1]; i=Path("docs/specs/README.md").read_text(); assert "status: shipped" in a and "shipped_commit: null" not in a and "last_updated: 2026-08-26" in a; assert "last_updated: 2026-08-26" in b; assert "| [mail-share](./mail-share/) " in i and "| shipped |" in next(x for x in i.splitlines() if "[mail-share](./mail-share/)" in x)'`；期望退出码 `0`。
- risk_spread: none（front-matter 与索引均为本主题的 spec 生命周期面，未追踪运行时代码）。

## Finding 6

- severity: P2
- anchor: `docs/specs/mail-share/design.md:747`
- symbols: `ADR-mailbox-share-capability-extension` Decision、Visitor failure partition
- rule_source: `docs/architecture/ADR-mailbox-share-capability-extension.md:5,26` 是 Accepted ADR，并仍规定除 AuthKey 分支外的不存在/撤销等失败保持不可区分 `SHARE_UNAVAILABLE`；修订后的 `docs/specs/mailbox-share-capability/requirements.md:107` 已规定 gone 为 HTTP 404。
- identity_scope: Accepted Mailbox Share capability 边界中的 Visitor 错误暴露决策。
- failure_mode: “不新开 ADR”本身不违反现有准入门槛，但提交也没有给现有 Accepted ADR 加修订/部分取代记录，导致 ADR 的现行 Decision 与 shipped spec 直接冲突。
- trigger: 架构评审或后续边界改动优先读取 Accepted ADR 而不是 dated spec changelog 时，会继续把 gone 放进 `SHARE_UNAVAILABLE` 族。
- impact: 同一授权边界拥有两个相反的现行架构决定，且 ADR 的 Accepted 权重会使本轮有意推翻失去可追溯性。
- required_fix: 无需为本轮强制新建 ADR，但必须在现有 Accepted extension ADR 中追加 dated amendment/partial-supersession，明确 gone 404 分族并链接修订 AC；若团队判定该安全性质反转达到新 ADR 门槛，则改以新 ADR 显式 supersede，而不能保持当前静默冲突。
- verify: `python3 -c 'from pathlib import Path; s=Path("docs/architecture/ADR-mailbox-share-capability-extension.md").read_text(); assert "Accepted" in s; assert "gone" in s and "HTTP 404" in s; assert "其余保持不可区分" not in s or "部分取代" in s or "amend" in s.lower()'`；期望退出码 `0`。
- risk_spread: none（该 ADR 是 T7 refs 且 review_focus #5 明示的直接判据，不是主题外扩散）。
