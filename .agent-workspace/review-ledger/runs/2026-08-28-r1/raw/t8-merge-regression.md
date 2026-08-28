# T8 · 已审 share-link-fullchain 合并与后续修复回归

结论：NEEDS_CHANGES（新增 P2 × 1；未重开 2026-08-26-r1 的 30 条 finding）

## Finding

### T8-F1 · e2e 未绑定生产新增的文档限流器，旧 404 验收只跑到了 fail-open 分支

- severity: P2
- anchor: `tests/e2e/wrangler-e2e.toml:17`
- symbols: `SHARE_READ_RATE_LIMITER`, `shareDocumentIfGone`, `shareLimiterAllows`, `expectNativeGone`, `goneDocument`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:196` 把经 wrangler 的真实导航 404/空 body/零业务 DOM列为 P4 必做验收；`themes.md:254` 明确要求在 `1da171f` 把限流插到文档路径前后复核这组六个 e2e spec 是否仍成立。
- identity_scope: `1da171f` 之后，生产 `/s/:lid` 文档入口与 `tests/e2e` wrangler 环境对 `SHARE_READ_RATE_LIMITER` 的部署形状一致性。
- failure_mode: 生产配置在 `mail-worker/wrangler.toml:17-20` 绑定 `SHARE_READ_RATE_LIMITER`，当前文档入口在查 gone 之前调用该 binding（`mail-worker/src/security/share-document-gone.js:66-75`）；限流拒绝时直接返回空 body 429。e2e 配置却在 KV binding 后直接进入 `[assets]`（本锚点），全文没有 `[[ratelimits]]` 或 `SHARE_READ_RATE_LIMITER`。`shareLimiterAllows` 对缺 binding 明确 fail-open（`mail-worker/src/security/share-rate-limit.js:56-59`），所以 `visitor-unavailable.spec.js:15-31` 与 `visitor-revoke-live.spec.js:16-29` 的 404 断言仍可绿色，但只证明“限流器不存在”的旧路径。仓内 worker 测试已直接证明真实新增分支会把 missing lid 文档改答 429（`mail-worker/test/share-document-gone.spec.js:225-235`）；因此旧 e2e 绿灯不能继续作为部署态 P4 全链回归证据。
- trigger: 运行 `SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs`；或未来改坏 binding 名、限流 key、allow 分支及限流触发后的 gone/reload 行为时。
- impact: P4 的“真实 wrangler 导航”验收会在生产新增分支完全未执行的情况下报告通过；`visitor-unavailable`、`visitor-revoke-live`、`visitor-headers` 无法发现限流层令 gone 404/reload 改形或失效，且部署工作流没有其他测试闸门补位。
- required_fix: 在 `tests/e2e` 的 wrangler 环境责任层加入与生产同名、同入口的 `SHARE_READ_RATE_LIMITER`，让默认放行的 missing/revoked/expired/live 导航实际经过 binding；再增加一个可确定触发拒绝的文档导航场景，并以 T3 对“gone 404 与前置 429”的最终契约裁决作为断言。不得继续用 binding 缺失的 fail-open 环境代表生产全链。
- verify: 修复后先断言 e2e 启动环境实际存在 `SHARE_READ_RATE_LIMITER.limit`，再定点运行 `visitor-unavailable.spec.js`、`visitor-revoke-live.spec.js`、`visitor-headers.spec.js`：放行路径保持 missing/revoked 404 空 body、expired/live 200；拒绝路径命中经裁决后的明确响应，且不能因删除 binding 而继续通过。本轮静态复核实际执行 `git diff --exit-code 864358d 083c87f -- tests/e2e`，退出 0，确认三个后续 fix 未同步任何 e2e 文件。
- risk_spread: `already-reviewed-regression-surface` · origin `1da171f` 对 `shareDocumentIfGone` 的前置限流 → hop 1 `tests/e2e/wrangler-e2e.toml` 与三份 P4 浏览器 spec；已确认生产/e2e binding 形状分叉后停止，未扩散到其余 Visitor API 或重新审查 2026-08-26-r1 功能实现。

## 合并保真

- `git show --no-patch --format='%H%n%P%n%s' 864358d` 实际输出第二父提交为 `9b6eb8072fe73c93518e872037702a2e8e54056b`；已审分支 tip 被直接作为 merge parent 纳入。
- 实际执行 `git diff --exit-code 9b6eb807 864358d -- mail-worker mail-vue tests docs`，退出 0；合并提交相对已审 tip 没有任何业务代码、测试或规范手改。
- 实际执行 `git diff --name-status 9b6eb80 864358d`，差异仅为 `f6670e0` 带入的 28 个 `.agent-workspace/review-ledger/**` 文件与 `.gitignore`。未发现解冲突夹带。

## 后续 fix 覆盖段回归

- `mail-worker/src/service/mail-share-service.js`：`0f4f52c` 增加的 account 配额谓词与 `replayBatchFromLids` lid 集合精确相等检查仍在当前文件 `:661-697,1257-1273`；`790c550` 删除完整性哨兵导致的 F-0004 失效已由本轮 T1 / cross-theme / T9 归账，T8 不重开、不复制 finding。
- `mail-worker/src/service/mailbox-provision.js`：非管理员缺 role 的 fail-closed 分支仍在 `:139-160`，F-0002 的关闭结论未被后续提交撤销；F-0008/F-0009/F-0010 原有 OPEN 身份不在 T8 重报。
- `mail-vue/src/views/share-admin/ShareCreateWizard.vue`：同组件实例内 `closeNow()` 不再清 `unknownResult`，`openDialog()` 未知态提前返回（`:596-614`），F-0005 的关闭结论仍成立；本轮 T6 新 finding 与 F-0023/F-0024 的 persists 状态由 T6 归账。
- `mail-vue/src/views/share/index.vue`：`handleShareGone` 仍先停止轮询并清理会话，清理异常后仍执行 `markShareGone` 与 reload/blank（`:820-842`）；`session.js:20-25,44-50,75-81,113-123` 已把读写删三类 sessionStorage 调用包进失败收口，F-0001 未被 `083c87f` 的提示改造破坏。`083c87f` 新增的提示/定时器问题及 F-0027/F-0029 回归由 T4/T5 归账，T8 不重复。
- 同一文件的 `.share-shell { overflow-x: hidden }` 与外部文本选择器 `overflow-wrap: anywhere` / `word-break: break-word` 仍在当前 `:1183,1499-1505`；`083c87f` 只在其间增加页内提示样式，未撤销 F-0028 的关闭依据。
- `mail-worker/src/security/share-document-gone.js`：`SHARE_DOC_PATH` 仍为大小写不敏感正则（`:15`），F-0022 未回归；`1da171f` 新增限流后 e2e 环境失真的独立身份见 T8-F1。

