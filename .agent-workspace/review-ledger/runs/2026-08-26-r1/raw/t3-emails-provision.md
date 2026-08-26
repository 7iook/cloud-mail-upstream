# T3 · Owner 完整邮箱建分享审查

## 取证

- 被审树：`/tmp/share-review`，`HEAD=9b6eb8072fe73c93518e872037702a2e8e54056b`；主体提交 `fabe6e841109dfb84b8b4da651c7caa03a5d7db4`。
- `pnpm -C mail-worker test -- mail-share-emails.spec.js`：EXIT=0，实际执行 `25 files / 854 tests` 全绿。
- `pnpm -C mail-vue test -- src/views/share-admin/ShareCreateWizard.spec.js src/views/share-admin/presets.spec.js`：EXIT=0，实际执行 `26 files / 370 tests` 全绿。
- Cloudflare D1 官方文档（2026-06-22）：`batch()` 顺序执行；只有 statement **失败**才回滚整批，`changes=0` 仍是成功结果。<https://developers.cloudflare.com/d1/worker-api/d1-database/>
- Cloudflare D1 官方限制（2026-04-21）：每次 Worker invocation 为 Paid 1000 / Free 50 queries，batch 内每条 statement 分别受限。<https://developers.cloudflare.com/d1/platform/limits/>
- 复算：50 个全新地址且带幂等键时，当前 batch 为 `1 + 50 + 3*50 + 1 = 202` 条 statement；`node -e` 实测输出 `batchStatementsWithIdempotency:202`。
- `/tmp/share-review` 审查后 `git status --short` 为空。

## Findings

### T3-01

severity: P0
anchor: mail-worker/src/service/mail-share-service.js:1275
symbols: createFromEmails, prepareShareInsertByEmails, prepareBindingInsertByEmails, prepareAccountInsert
rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` DC-P0-3（101-106：任一地址失败整单零写入、同一 D1 batch）；`docs/specs/mailbox-share-capability/design.md` 的 `POST /mailShare/create` 契约；Cloudflare D1 `batch()` 官方事务语义
identity_scope: V2=false 的 emails 批量分流整单原子性
failure_mode: 每条 share 的归属计数只检查 `item.group`；某组变成零行不会让 D1 statement 失败，其他组及新 account 会提交，随后代码才在已提交事务外发现 `shareRows.every(...)` 为假。
trigger: 多地址 V2=false 创建在 `planMailboxProvision` 后、`db.batch()` 前，其中一个已复用邮箱被另一请求软删或改变归属，而至少一个其他组仍合法。
impact: Owner 会收到 `SHARE_ACCOUNT_FORBIDDEN` 或无明文的部分重放响应，但数据库已留下部分 ACTIVE 分享、Binding、account，消耗配额且违背“整单失败零残留”。
required_fix: 在 SSOT 写入层用完整规范化 emails 集合建立一个会在失配时令 batch statement 报错的事务断言，并让 account/share/binding 全部依赖该断言；不能再用各组 `changes=0` 后置判错模拟回滚。
verify: `pnpm -C mail-worker test -- mail-share-emails.spec.js` → EXIT=0；新增确定性竞态用例，在 `beforeBatch` 软删第二个复用邮箱且不主动抛错，断言 share/account/idempotency 三类写入均为 0。
risk_spread: `d1-batch-atomicity`；沿 createFromEmails → 孪生 INSERT → mail-share-emails.spec.js 取证，已在三条谓词零行语义处停止。

### T3-02

severity: P1
anchor: mail-worker/src/service/mail-share-service.js:1260
symbols: createFromEmails, prepareAccountInsert, prepareShareInsertByEmails, prepareBindingInsertByEmails, syncPrimaryAccountId
rule_source: `docs/specs/mailbox-share-capability/design.md` 的 create 契约允许最多 50 个 emails；`docs/specs/mailbox-share-capability/requirements.md` AC-CAP-13；Cloudflare D1 官方 50/1000 queries-per-invocation 限制
identity_scope: emails 批量创建在 Cloudflare D1 Free 部署上的可达上限
failure_mode: 每个全新地址生成 1 条 account INSERT 和 3 条 share/binding/sync statement，幂等键再加首尾 2 条；50 地址仅 batch 已有 202 条，超过 Free invocation 的 50-query 硬限制，且尚未计入 batch 前读取和 batch 后逐分享 `loadBindings`。
trigger: Workers Free 部署提交接近契约上限的 V2=false 多地址批量，尤其 50 个尚未开通的地址。
impact: UI 明示“一次最多 50 个地址”，但受支持的 Free 部署会返回平台错误而非 N 条链接；事务和业务错误映射均无法把它恢复成契约响应。
required_fix: 在 `createFromEmails` 上游把每地址多 statement 改为集合化 SQL，使 50 地址连同预读/回读都落在最低受支持计划的 invocation 查询预算内；若不再支持 Free 或不再承诺 50，必须同步收紧公开契约与 UI，而不能只捕获平台错误。
verify: unverified: 本地 Miniflare 不施加 Cloudflare 账户计划的 invocation query quota；需在 Workers Free 预览环境以 50 个全新地址执行 Owner create E2E，并期望 HTTP 业务成功、返回 50 条链接。
risk_spread: `d1-batch-atomicity`；只复算 createFromEmails 的 statement 组装并对照 D1 官方限制，未进入其他写链路。

### T3-03

severity: P1
anchor: mail-worker/src/service/mailbox-provision.js:148
symbols: planMailboxProvision, countOwnedMailboxes, prepareAccountInsert, provisionMailbox
rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` P2 Account 写边界（97：配额是共享建号不变量）；`mailbox-provision.js:10-19` 声明建号不变量唯一居所
identity_scope: 角色 accountCount 配额的并发写入不变量
failure_mode: 配额只在 batch 外执行 `owned + missing.length > limit` 预读；唯一 account INSERT 文本没有 accountCount 写侧谓词，所以两个并发请求可同时按旧计数通过，再顺序提交并共同越过角色配额。
trigger: 非 admin、有限 `role.accountCount`，两个并发设置页或 emails 创建请求各增加不同的新地址，且二者在任一 INSERT 前完成预校验。
impact: 该角色可得到超过配置上限的 account 行及对应分享；SSOT 收口后配额仍只是 TOCTOU 提示而非不变量。
required_fix: 把 accountCount 的条件写守卫下沉到 `prepareAccountInsert` 这一唯一 INSERT 层，并按同批 missing 位次折算，令设置页与分享入口共享同一原子配额判定。
verify: `pnpm -C mail-worker test -- mail-share-emails.spec.js` → EXIT=0；新增带 barrier 的双请求用例，让两次 plan 都读到相同 owned，断言最终 NORMAL account 数不超过 role.accountCount，输家返回稳定配额错误。
risk_spread: `provision-invariant-parity`；在 mailbox-provision 与 account-service 两个许可面核对配额读写后停止。

### T3-04

severity: P1
anchor: mail-worker/src/service/user-service.js:309
symbols: configuredDomains, userService.add, loginService.register, publicService.addUser, settingService.query
rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` 关键不变量 2（36-38：`configuredDomains(c)` 精确匹配，禁止对 JSON 字符串 `.includes`）
identity_scope: `c.env.domain` 的全仓解析与成员判定契约
failure_mode: T3 只让 mailbox provision 走数组化精确匹配；`user-service.js:309`、`login-service.js:64`、`public-service.js:107` 仍直接对原始 `c.env.domain` 调 `.includes`，`setting-service.js:48-63` 又保留第二份 JSON 解析。
trigger: Dashboard 以 JSON 字符串配置 `["example.com"]`，注册/批量建用户使用 `user@xample.co`；实测字符串 `.includes("xample.co")` 为 true，而 `configuredDomains(...).includes("xample.co")` 为 false。
impact: 未配置域名仍可从旧写入口建出 user/account；同一邮箱走 T3 emails 路径会被拒、走存量 accountId 路径却可分享，域名授权和双入口行为分叉。
required_fix: 将 `configuredDomains` 抽到无业务依赖的配置 SSOT，并让列出的全部 `c.env.domain` 读点只消费该解析结果，删除各入口的原始字符串 `.includes`/重复 JSON 解析。
verify: `pnpm -C mail-worker test` → EXIT=0；为登录注册、管理员 add、public addUser 分别加入 JSON-string + 子串域名用例，三路均期望稳定拒绝且零 user/account 写入。
risk_spread: `env-domain-ssot`；已枚举全部直接读点并标出三处宽匹配与一处重复解析，命中 stop_when 后未追入注册/登录内部链路。

### T3-05

severity: P1
anchor: mail-worker/src/service/mail-share-service.js:672
symbols: replayBatchFromLids, batchReplayLids, replayFromIdempotency
rule_source: `mail-worker/src/service/mail-share-service.js:661` 明示“任一行没了则整单 SHARE_NOT_FOUND”；`docs/specs/mailbox-share-capability/requirements.md` AC-CAP-14 的同 key create 重放契约
identity_scope: 一把 Idempotency-Key 对应的 V2=false 批量响应完整性
failure_mode: `replayBatchFromLids` 只在查询结果完全为空时抛错，没有比较请求 lids 与返回的唯一 lids；N 条里少任意一条时会把剩余子集包装成成功的 `{shares, idempotentReplay}`。
trigger: 批量创建后 Owner 单独删除其中一条，或保留期清理分批删掉一条，随后以原 Idempotency-Key 重放。
impact: 向导把残缺子集当作整批真实结果展示，原命令的成功集合被静默改写；Owner无法区分“原批次只有这些”与“部分已丢失”，后续撤销/重建会遗漏。
required_fix: 在 replay SSOT 中按请求 lids 校验返回集合恰好等长且逐 lid 命中；任一缺失即整单 `SHARE_NOT_FOUND`，并保持原 lids 顺序组装响应。
verify: `pnpm -C mail-worker test -- mail-share-emails.spec.js` → EXIT=0；新增“创建两条→删除其中一条→同 key 重放”用例，期望 `SHARE_NOT_FOUND` 而不是单元素 shares。
risk_spread: `d1-batch-atomicity`；仅核对批量幂等行、按 lid 回读与前端既定 response 消费，已在零行语义处停止。

### T3-06

severity: P2
anchor: mail-worker/src/service/mailbox-provision.js:102
symbols: planMailboxProvision, accountService.add, PROVISION_DENIED.PREFIX_FORBIDDEN
rule_source: `git diff fabe6e8^ fabe6e8 -- mail-worker/src/service/account-service.js mail-worker/src/service/mailbox-provision.js` 可复现旧谓词 `getName(email).includes(content)`；DC-P0-2 只批准下沉 SSOT，并未批准扩大前缀黑名单
identity_scope: 设置页既有 emailPrefixFilter 判定语义
failure_mode: 搬迁把 prefix 与 token 两端都转小写，旧的大小写敏感过滤被静默改成大小写不敏感；实测旧谓词对 `SpamBox`/`spam` 为 false，新谓词为 true。
trigger: 现有 `emailPrefixFilter` 含小写 token，而 Owner 添加仅大小写不同的邮箱前缀。
impact: 升级前可创建的地址在升级后被设置页和分享入口拒绝，属于 SSOT 搬迁夹带的兼容性变化，现有测试未覆盖。
required_fix: 在 provision SSOT 保留旧的大小写敏感谓词；若产品要改为大小写不敏感，应先单独修订配置契约并补迁移/回归证据。
verify: `pnpm -C mail-worker test -- mail-share-emails.spec.js` → EXIT=0；新增 `emailPrefixFilter=spam`、`SpamBox@example.com` 的 accountService.add 兼容用例，并断言与提交前行为一致。
risk_spread: `provision-invariant-parity`；六条建号不变量逐项核对后定位到前缀过滤漂移，未进入注册/登录/OAuth。
