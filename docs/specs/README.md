# Spec 索引 — Feature Specifications

> **AI 入口**:查"某个功能设计当初为什么这么定 / 现在什么状态 / 与哪个 ADR 关联" → 先读本表 → 点进对应 spec 的 `design.md`。
>
> spec = 功能级设计工作区(design.md + requirements.md + tasks.md + `review*.md`)。生命周期 drafting → shipped/superseded。
> 决策定边界写 ADR(`../architecture/`,若存在),不写 spec;spec 写"某功能怎么实施 + 评审如何收敛"。
>
> 检索方式(AI 友好):
>
> - 按状态:`grep -H "^status:" docs/specs/*/design.md`
> - 按标签:`grep -H "^tags:.*<标签>" docs/specs/*/design.md`
> - 按关联 ADR:`grep -H "related_adrs:.*ADR-XXX" docs/specs/*/design.md`
> - 已收敛未 ship:`grep -l "^status: converged" docs/specs/*/design.md`

## 索引表(新增 spec 时追加一行 · 或跑 `python C:\Users\7\.agents\scripts\sync-spec-index.py docs/specs` 自动重生 AUTO-INDEX 区块)

<!-- BEGIN AUTO-INDEX -->
<!-- 本区块由 sync-spec-index.py 自动重生成,人工修改会被覆盖。人工内容请写在本注释外的其它区域。 -->

| slug | title | status | domain | one_line | related |
|---|---|---|---|---|---|
| [mail-share](./mail-share/) | 邮箱临时分享 —— 不交出密码的匿名只读授权与验证码提取 | converged | business | 所有者创建不可猜链接，未登录访客只读授权窗内的邮件与验证码 | ADR-mail-share-capability-boundary |
| [mailbox-share-capability](./mailbox-share-capability/) | 邮箱能力分享 —— 单/多邮箱统一授权、Session 配额与可选认证 | reviewing | business | 在既有 mail-share 上扩展多邮箱 Binding、Session 配额闸门与可选认证 Key | mail-share · ADR-mailbox-share-capability-extension |

<!-- END AUTO-INDEX -->

## 生命周期状态机

```
drafting  ──►  reviewing  ──►  converged  ──►  in-impl  ──►  shipped
   │              │                │              │             │
   └──────────────┴────────────────┴──────────────┴──►  abandoned
                                                          │
                                                          └──►  superseded (被新 spec 取代)
```

- `drafting → reviewing`:主 AI 或用户 · 首次跑 spec-cross-review 时
- `reviewing → converged`:主 AI 判定 · APPROVED 或 P0=0 且可进 tasks
- `converged → in-impl`:主 AI 自动 · tasks.md 开始勾第一个 checkbox
- `in-impl → shipped`:主 AI 自动 · tasks.md 全部完成 + 填 `shipped_commit`
- `* → abandoned/superseded`:用户命令(或被新 spec 取代)

**⛔ `spec-cross-review` 只自动回写 4 个白名单字段**(`review_rounds_done / last_review_status / last_review_p0 / last_updated`),**不触碰 `status`** —— 状态转移是人的判断,防评审误判连锁污染。

## 新增一份 spec 的步骤

1. 决定是否值得建(见 `~/.kiro/skills/engineering-agent/references/spec-deliverable.md` §When to emit · 默认 NO)。
2. `mkdir docs/specs/<slug>/`(slug = kebab-case)。
3. 建 `design.md` + `requirements.md`;**design.md 顶部必落 YAML front-matter**(schema 见 spec-deliverable §Spec Front-matter),status 起始 = `drafting`。
4. 跑 `python C:\Users\7\.agents\scripts\sync-spec-index.py docs/specs/` 让本表 AUTO-INDEX 区块跟上(若仓有 pre-commit hook 会提醒)。
5. 首次跑 `spec-cross-review` 前把 status 改 `reviewing`;评审收敛后主 AI 改 `converged`;开工时改 `in-impl`;交付时改 `shipped` + 填 `shipped_commit`。
6. commit 时把 `docs/specs/README.md` + 该 spec 三件套一起 staged。

## Legacy 提示

- 若仓库有 `.kiro/specs/`(IDE 私有 · 不入 git)· 建议 `git mv` 到 `docs/specs/` 让 spec 走 git 追踪(见 spec-deliverable §SPEC LOCATION RED LINE)
- 历史 spec 未回填 front-matter 的 · sync-spec-index.py 会跳过并在 Legacy 段列出

<!-- 本 README 由 sync-spec-index.py --bootstrap 从模板首次建成。人工可在 AUTO-INDEX 标记块之外自由编辑;AUTO-INDEX 内容由脚本重生成。 -->
