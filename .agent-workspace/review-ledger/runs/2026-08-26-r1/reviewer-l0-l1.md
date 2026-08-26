# Reviewer L0 + L1 · 2026-08-26-r1

读码工作树: `/tmp/review-share-fullchain`（被审 HEAD `9b6eb8072fe73c93518e872037702a2e8e54056b`）
/workspace 工作区停在 main，**不是**被审代码。禁止用 /workspace 的业务源码当下真相。
范围: `12cec61a0d4a1e7c99d1316b9ef9b75715c893b3..9b6eb8072fe73c93518e872037702a2e8e54056b`
themes.md: `/workspace/.agent-workspace/review-ledger/runs/2026-08-26-r1/themes.md`
scope.md: `/workspace/.agent-workspace/review-ledger/runs/2026-08-26-r1/scope.md`

## L0 通用内核（不得被后续层覆盖或删改）

- 证据先于结论。没有本条消息内跑过/读过的证据，不许下判断。出现「应该 / 可能 / 看起来 / 似乎」= 违规。
- 不许无中生有。报的每条都要能被 Read 复现。宁可少报，不要凑数。
- 不报风格偏好。只报能指到判据条款、或会真实出问题的。
- 不要复述上下文。直接给 findings。
- 无问题就明说「本主题无 finding」+ 列出实际查证了哪几点(带锚点)。
- 每条 finding 必须给全下列字段，缺任一项该条作废:
  - severity: P0 / P1 / P2 / suggestion
  - anchor: `<相对仓库根路径>:<行号>`（必须是你真读过的行，相对 /tmp/review-share-fullchain 即仓库相对路径）
  - symbols: 函数/类/常量名
  - rule_source: 指到具体条款；仓库无条款时写可复现的契约/测试/安全不变量/运行时证据锚点。**无任何可验证依据才降级为 suggestion**
  - identity_scope: 稳定作用域/契约/符号身份；不得使用行号
  - failure_mode / trigger / impact / required_fix: 各一句。required_fix 禁下游补丁式建议
  - verify: 一条可执行命令 + 期望退出码；给不出写 `unverified: <原因>`
  - risk_spread: 未跨出主题 diff 写 `none`；跨出则写具名风险及 origin/hops/surfaces/stop 的实际追踪结果。无预算的跨 diff finding 非法
- 只改 raw 报告文件，不改业务代码，不 git commit。

## L1 仓库事实

判据源（必须实际打开读）:
- docs/specs/mail-share/design.md
- docs/specs/mail-share/requirements.md
- docs/specs/mailbox-share-capability/design.md
- docs/specs/mailbox-share-capability/requirements.md
- docs/architecture/ADR-mail-share-capability-boundary.md
- docs/architecture/ADR-mailbox-share-capability-extension.md
- docs/architecture/ADR-share-credential-recoverability.md
- 本轮 archive: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/` 下决策卡 / p4 入口清单 / RCA / visitor UI 设计卡
- 仓库根无 AGENTS.md / ARCHITECTURE_RULES.md / CLAUDE.md

机械闸门（禁重复人工审）:
- 仅 `ci-workflow: deploy-cloudflare.yml`：push 到 main 且路径命中 mail-worker/** 或 mail-vue/** 时做 Cloudflare 部署。
- **不覆盖** 单测 / lint / 类型 / 密钥扫描 / 架构闸门。仓库无 lefthook / pre-commit / .githooks。
- 不得把「CI 已测过正确性」或决策卡自填的「854/370/23 全绿」当成机械闸门已覆盖。

历史台账: 无（本仓库首轮 bootstrap）。全部 finding 按新条目报，不要编 F-XXXX persists。

生产反模式只在能指到仓库条款或可复现契约/测试/安全不变量时作为命名引用（God Class / Shotgun / Trust-the-client / Swallow / 无回归）。不能把 catalog 本身当 rule_source。
