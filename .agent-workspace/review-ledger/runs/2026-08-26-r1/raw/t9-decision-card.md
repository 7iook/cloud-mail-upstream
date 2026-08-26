# T9 · 决策产物入库与任务清单回写

结论：NEEDS_CHANGES（P2 × 3）

## T9-F1

- severity: P2
- anchor: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:400`
- symbols: `P4 Evidence`、`handleShareGone`、`recoverFromUnavailable`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:142,193-196,399-400` 与 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/p4-destroyed-entrypoints.md:14` 均把“已打开 SPA 收到 gone 后 reload/清空文档”列为 P4 完成条件。
- identity_scope: `share-fullchain-decision-card::任务清单::P4::文档+API+已打开SPA完成声明`
- failure_mode: P4 Evidence 只登记 `d602ec6` 和三个 worker 文件，但真正让页面消费 `ShareGoneError` 的 `handleShareGone`、`recoverFromUnavailable` 及相关 import 全部由 `e309ad4` 写入 `mail-vue/src/views/share/index.vue`，因此登记的提交本身没有闭合已打开页面出口。
- trigger: 后续审计者按 Evidence 的 `commit: d602ec6` 复核、回滚或移植 P4。
- impact: 台账会把尚未接上页面 consumer 的提交误判为 P4 全链路完成；若把 `e309ad4` 当纯视觉提交回滚，销毁后的已打开页面会失去原生 404 出口。
- required_fix: 在 P4 Evidence 中补记 `e309ad4` 及 `mail-vue/src/views/share/index.vue`/对应 spec，并显式记录该提交同时承载 P4 SPA 接线与 P5 视觉，不能只按 subject 处理。
- verify: `! git diff-tree --no-commit-id --name-only -r d602ec6690e9671487ecd735c7fa640d41496bde | rg -q '^mail-vue/src/views/share/index\.vue$' && git diff-tree --no-commit-id --name-only -r e309ad4a17c46dcfff896b9d967b322cca4389a7 | rg -q '^mail-vue/src/views/share/index\.vue$'`；期望退出码 0。
- risk_spread: `name=Evidence ↔ 实际提交内容; origin=share-fullchain-decision-card.md:P4 Evidence; hops=1; surfaces=d602ec6,e309ad4,mail-vue/src/views/share/index.vue; stop=已用 diff 与 blame 定位 SPA gone consumer 全部属于 e309ad4`

## T9-F2

- severity: P2
- anchor: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:402`
- symbols: `P5 Evidence`、`desktop 1280`、`mobile 390`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:206,267` 明定桌面 1280 与移动 390 的截图或 GUI 验收为必做，且不得只靠钩子测试收尾。
- identity_scope: `share-fullchain-decision-card::任务清单::P5::视觉验收证据`
- failure_mode: P5 被勾选并声称已有两张截图，但 Evidence 没有任何文件名、路径或哈希；该 archive 提交也没有图片/HAR/录像，当前 `/opt/cursor/artifacts` 为空，因而无法读取或复核所称视觉证据。
- trigger: 后续审计者按任务清单检查 1280/390 两个最终视觉 sink。
- impact: P5 可在没有可读取视觉产物的情况下被认定完成，OTP 字号、移动端全宽按钮、触控尺寸和 token 色等 jsdom/钩子测试覆盖不到的要求没有持久证据。
- required_fix: 为两个视口落盘具名、可读取的持久截图（或等价录像），在 P5 Evidence 中写出精确路径与视口；若产物已丢失，则把 P5/总 VERIFY 改回未验证状态，重新验收后再勾选。
- verify: `! git ls-tree -r --name-only 9b6eb8072fe73c93518e872037702a2e8e54056b .agent-workspace/.archive/2026-08-26/share-link-fullchain | rg -qi '\.(png|jpe?g|webp|gif|har|mp4)$' && ! git show 9b6eb8072fe73c93518e872037702a2e8e54056b:.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md | rg -q '/opt/cursor/artifacts/[^ ]+\.(png|jpe?g|webp|gif|mp4)'`；期望退出码 0。
- risk_spread: `name=Evidence ↔ 实际提交内容; origin=share-fullchain-decision-card.md:P5 Evidence; hops=1; surfaces=e309ad4,本轮 archive 树; stop=已确认提交树无视觉产物且 Evidence 无具体 artifact 路径`

## T9-F3

- severity: P2
- anchor: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:388`
- symbols: `DOC Evidence`、`REV Evidence`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:385-392` 以勾选状态和 `Evidence/files/commit` 字段承担决策产物的可追溯账本职责。
- identity_scope: `share-fullchain-decision-card::任务清单::DOC/REV产物提交身份`
- failure_mode: DOC 与 REV 已勾选，但两个 Evidence 的 `commit` 仍是 `pending`；实际决策卡、prompt 与 review 三个文件都已由 `1288ac8` 入库。
- trigger: 后续审计者按 `commit` 字段定位生成 prompt、送审结果和改向记录的不可变版本。
- impact: 台账把已经提交的核心决策产物继续标成未定提交，无法从清单直接复原本轮文档审查输入与输出的版本边界。
- required_fix: 把 DOC 与 REV 两行的 `commit: pending` 回写为 `1288ac85af8d51329862355cbc8d07b1ad7d22b9`，并保持文件清单与该提交的实际三文件归属一致。
- verify: `git show 9b6eb8072fe73c93518e872037702a2e8e54056b:.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md | rg -n 'commit: pending' && git show --format= --name-only 1288ac85af8d51329862355cbc8d07b1ad7d22b9 | rg '^\.agent-workspace/.archive/2026-08-26/share-link-fullchain/(share-fullchain-decision-card\.md|prompt\.round1\.sub\.txt|share-fullchain-decision-card\.review1\.sub\.md)$'`；期望退出码 0。
- risk_spread: none

## 已查证且未形成 finding

- 三条 P0 改向均有落地锚点：`mailbox-provision.js` 为共享建号边界，`account-service.add` 已改道；`createFromEmails` 在 V2=false 时按地址分组为 N 条单分享；account/share/binding 语句进入同一次 `c.env.db.batch()`。
- `pnpm -C mail-vue test` 实跑为 26 files / 370 passed，退出码 0。worker 当前工作树缺 `mail-worker/node_modules`，同命令实跑退出码 1（`vitest: not found`）；未安装依赖以保持只读。e2e 目录静态枚举为 23 个 `test(...)`，但同样未因缺依赖而触发会自动安装/构建的 `run.mjs`。
- `prompt.round1.sub.txt` 已全文读取并扫描常见 token、私钥、API key、凭据赋值、内网地址模式；未命中可识别凭据或私密网络地址，只有 Vue/MDN 公共文档 URL。
