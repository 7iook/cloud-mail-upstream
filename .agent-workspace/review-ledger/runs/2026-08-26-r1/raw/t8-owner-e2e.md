# T8 · Owner 浏览器验收与 e2e Owner 邮箱种子

## 结论

本主题无 finding。

## 实际查证

1. **Owner 登录前提已补齐。** `tests/e2e/harness/worker-entry.js:130-149` 幂等创建与 `OWNER_EMAIL` 同址、归属同一 `userId` 的 account 行；`:175-183` 导出 `ownerAccountId`。这与 `mail-worker/src/service/user-service.js:32-44` 的登录初始化契约一致：`loginUserInfo` 会按用户邮箱读取 account 并解引用 `account.name`。
2. **新增 account 行未打破现有 e2e 前提。** `tests/e2e/harness/worker-entry.js:151-165` 原有 `MAILBOX` / `MAILBOX_2` 的 ID 和邮箱不变；全量检索 `tests/e2e/specs/**` 未发现依赖 account 总数、accountList 分页条数或“Owner 恰有两个邮箱”的断言。`tests/e2e/wrangler-e2e.toml:23-29` 还明确令该 Owner 等于 e2e admin，而 `mail-worker/src/service/mailbox-provision.js:139-160` 对 admin 不执行角色 accountCount / availDomain 配额分支，因此新增主邮箱不会吃掉本套 P2 用例的建号余量。
3. **P1 用例确实区分了停页 tick，而非只验证最终回源。** `tests/e2e/specs/owner-share-lifecycle.spec.js:60-64` 先钉住同一行是 `ACTIVE`，随后不做 reload/focus/visibility 操作，直接等待其变成 `EXPIRED`。管理页的网络回源只在初始 `fetchList`、visibility 与 focus 触发（`mail-vue/src/views/share-admin/index.vue:163-228`）；停留期间能改变状态的路径是 `useShareClock` 的 1 秒 interval（`mail-vue/src/views/share-admin/use-share-clock.js:23-30`）。`:66-72` 又分别覆盖刷新后仍过期及收件箱徽章归零。
4. **P2 浏览器断言与 DB 层守护形成闭环。** `tests/e2e/specs/owner-share-lifecycle.spec.js:24-43` 从真实向导粘贴两个未注册地址，验证两条链接、关窗无确认及列表出现两行；`mail-worker/test/mail-share-emails.spec.js:205-228` 另行断言同一个 `db.batch()`、两条 share、每条恰一条 Binding，`:243-252` 覆盖未知域名零写入，`:402-440` 覆盖 UNIQUE 竞态两支。不存在“只有 UI 数量断言、持久化语义无人守护”的缺口。
5. **P3 的负向断言不是只靠固定等待。** `tests/e2e/specs/owner-share-lifecycle.spec.js:37-43` 在 500ms 后同时断言 MessageBox 为 0、结果区已关闭、列表已刷新出两行；旧 confirm 路径会阻止结果区关闭，因而不能靠“弹窗晚一点出现”蒙混过关。Playwright 配置为单 worker、零 retry（`tests/e2e/playwright.config.js:4-11`），未发现并行共享 D1 的竞态面。
6. **P4 必做浏览器导航已有可执行用例。** `tests/e2e/specs/visitor-unavailable.spec.js:15-41` 对 missing / revoked 真导航断言 404、空 body、零业务 DOM，并确认 EXPIRED 仍为 200 SPA；`tests/e2e/specs/visitor-revoke-live.spec.js:9-39` 覆盖已打开页面撤销后 reload 到 404 且停止请求。
7. **P5 证据对账结果（跨主题移交，不作为 T8 finding）。** 当前仓库与 `/opt/cursor/artifacts` 均无图片/视频文件，`tests/e2e/**` 也无 screenshot / viewport 用例；可见证据只有 `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:401-402` 的“截图 desktop 1280 / mobile 390”文字，没有可复核路径。该项不在提交 `3706222` 的 Owner 验收 diff，也未获 T8 的跨 diff 风险预算；应由 T9 的 `Evidence ↔ 实际提交内容` 预算归账。

## 验证边界

- 按 read-only 要求未运行会生成 `mail-worker/dist` 与 `tests/e2e/.mf-state` 的浏览器套件；本结论来自提交 diff、测试源码、生产消费符号与判据文件的逐项静态对账。
- `risk_spread`: T8 两项预算内已分别追到 `tests/e2e/specs/**` / `tests/e2e/fixtures/share.js` 与三个 Owner UI hook；未在 T8 下登记跨预算 finding。
