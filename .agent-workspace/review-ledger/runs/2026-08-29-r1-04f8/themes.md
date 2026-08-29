# Themes · 2026-08-29-r1-04f8

range: `083c87f2d2ccc8c459adfd45fc31a43afc63256f..4ea2efc1d0d385f63df322933a2154bf329f68c9`
commits: 5 → themes: 3 · 侦察产出，非审查结论
worktree: `/tmp/review-git-8934`（现已 fast-forward 合入 `/workspace`）
models: recon=claude-opus-5-thinking-high-fast（Task 用量耗尽 · 主 AI 按 Mode R 模板代行 · 见 RUN）

判据源（scope.md「判据源」段，全部实读过）:
`docs/specs/mail-share/{design,requirements}.md` · `docs/specs/mailbox-share-capability/{design,requirements}.md` ·
`docs/architecture/ADR-mail-share-capability-boundary.md` 等三份 ADR ·
`.agent-workspace/.archive/2026-08-26/share-link-fullchain/{share-fullchain-decision-card.md,visitor-share-ui-design.md,p4-destroyed-entrypoints.md}`

提交归属总表（`6ad2686` 横跨两件业务，按语义拆开）:

| sha | 主题 |
|---|---|
| ea1434c | T3 |
| d244fc2 | T3 |
| 200daa9 | T3 |
| 6ad2686 | T1 / T2（拆） |
| 4ea2efc | T3 |

---

## T1 · 批量 emails[] 创建用批尾 NOT NULL 篱笆把部分写入翻成整单回滚

- **theme_id**: T1
- **commits**: `6ad2686`（`mail-share-service.js` / `mailbox-provision.js` / `mail-share-emails.spec.js`）
- **intent**
  Owner 一次粘贴 N 个地址必须整单成立或整单零残留。790c550 删掉从未生效的 1/0 哨兵后，批后 `meta.changes` 只能发现部分提交、撤不掉；配额谓词若按「每条同一个阈值」装配，合法整单会被拆成半单。本组把集合级配额谓词和批尾 `INSERT NULL` 篱笆装回去，让零行变成真实约束错误从而回滚。
- **surfaces**
  `mail-worker/src/service/mail-share-service.js` `createFromEmails` / `prepareBatchIntegrityFence` / `isIntegrityFence` / `settleRejectedBatch` · `mailbox-provision.js` `accountQuotaPredicateSql` / `accountQuotaPredicateBinds` / `resolveNonAdminAccountQuota` / `provisionMailbox` · `mail-worker/test/mail-share-emails.spec.js`
- **refs**
  `docs/specs/mail-share/requirements.md` AC-SHARE-12 ·
  `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-13 / AC-CAP-14 ·
  `docs/specs/mail-share/design.md` T-02（batch 可行、不得用 drizzle `.transaction()`）·
  决策卡 DC-P0-2 / DC-P0-3 · 台账 F-0004 / F-78412ce3 / F-89dcf76e / F-570b7d4c / F-0030
- **review_focus**
  1. `prepareBatchIntegrityFence`（`mail-share-service.js` ≈1107）三条 COUNT 是否分别兜住 account 配额零行、share 限额/归属零行、Binding 零行。判据 AC-CAP-13「整单拒绝 SHALL NOT 部分写入」。对照 `leaves zero rows behind when only part of the batch clears the active-share limit` 与 `rolls back the rows the batch already wrote when one share goes zero-row`。
  2. `accountQuotaPredicateBinds` 收的是当前 missing 集合、阈值 `accountCount - keys.length`。查 `provisions every missing address when the batch exactly fills the role account quota` 与 UNIQUE 重试用例：重试后 binds 是否来自缩过的 plan，而不是首次三枚。
  3. `resolveNonAdminAccountQuota` 在 `for (attempt)` **环内**每次重建。查重试时不会沿用过时 `accountCount`。判据 F-570b7d4c close_note。
  4. `isIntegrityFence` 认 `/NOT NULL/i && /mail_share_binding/i`。查真实 D1 / miniflare 抛错文本是否匹配；认不出时走 500 还是 `settleRejectedBatch`。判据：失败必须稳定码 + 零残留，不能只 500。
  5. design.md T-02「batch 内语句不得消费前序结果」与篱笆 `COUNT(*)` 读同批 INSERT 是否矛盾。查 F-0030 是否因篱笆变成承重件。判据：T-02 原文 + `createFromEmails` 头注释「batch 内状态冻结」。
  6. `insertShareAndIdempotency`（accountId 单条路径）是否仍只做批后 `meta.changes`、没有篱笆。同根因变体扫一遍，不要漏。
- **risk**: high —— 数据完整性不变量第三次改形状；篱笆依赖同批行可见性与错误文本匹配。
- **risk_spread_budget**
  - name: `d1-batch-fence`
    origin: `mail-worker/src/service/mail-share-service.js` `prepareBatchIntegrityFence`
    allowed_hops: 2（fence → createFromEmails → prepareShareInsertByEmails / prepareAccountInsert）
    allowed_surfaces: `mail-worker/src/service/`、`mail-worker/test/mail-share-emails.spec.js`
    stop_when: 已确定「零行时同批其余语句是否留库」这一个事实
  - name: `quota-predicate-set`
    origin: `mailbox-provision.js` `accountQuotaPredicateSql`
    allowed_hops: 1（provisionMailbox 设置页入口）
    allowed_surfaces: `mailbox-provision.js`、`account-service` 调用点、`mail-share-emails.spec.js`
    stop_when: 已确认设置页与分享入口共用同一谓词或明确差集

---

## T2 · 向导把 unknownResult 写进 sessionStorage 让刷新后仍能同键重放

- **theme_id**: T2
- **commits**: `6ad2686`（`ShareCreateWizard.vue` / `ShareCreateWizard.spec.js`）
- **intent**
  运输层失败后 Owner 刷新或离开分享管理页，组件实例带走 unknownResult 和幂等键，下一次提交换新钥匙盲建第二条分享。本组在请求上路前把 key+body 写入 sessionStorage，重建后先立锁再回填；同键重放拿到 NOT_FOUND/CONFLICT 时升为 remnant，只允许显式「我已核对」才轮换钥匙。
- **surfaces**
  `mail-vue/src/views/share-admin/ShareCreateWizard.vue` `writePendingCreate` / `restorePendingCreate` / `abandonPending` / `submit` · 恢复态 UI · `ShareCreateWizard.spec.js` AC-CAP-14 用例
- **refs**
  `docs/specs/mailbox-share-capability/requirements.md` AC-CAP-14 ·
  `docs/specs/mail-share/design.md`「建会话幂等」sessionStorage 选型 ·
  台账 F-420feb8d / F-e87370ba / F-92520298 / F-0023 / F-0024
- **review_focus**
  1. `writePendingCreate` 是否在 `createMailShare` **之前**落盘（含请求仍在飞、页被卸的路径）。判据 AC-CAP-14 + spec `locks a fresh mount when the tab was lost with a create still in flight`。
  2. 重试是否用落盘 body 而不是 `buildBody`。判据：同键不同指纹 = CONFLICT。对照 spec `retries with the very same key and body`。
  3. `UNRESOLVED_REPLAY_CODES` 是否只在 **replay** 分支把 NOT_FOUND/CONFLICT 升 remnant，首次确定业务拒绝仍清上下文。判据 F-e87370ba。
  4. sessionStorage 键 `mail-share:create-pending` 是否按用户隔离；登出/换号是否清掉。对照组件头注释「不会在共用浏览器上把上一个人的冻结请求交给下一个登录者」。
  5. remnant 文案键是否进了 `i18n/zh.js` / `i18n/en.js`。组件写明 T-28/T-29 才是 i18n 唯一写者，`PENDING_COPY` 只是中文兜底。
  6. 关窗是否仍保留 unknownResult（`onOpenChange` → `closeNow` 不清 pending）。对照 F-0005 已关结论是否被这次改动回退。
- **risk**: medium —— 恢复态是 AC-CAP-14 的唯一用户出口；隔离失败会盲建或把邮箱地址交给下一个人。
- **risk_spread_budget**
  - name: `pending-create-storage`
    origin: `ShareCreateWizard.vue` `PENDING_CREATE_STORAGE_KEY`
    allowed_hops: 1（logout / router / 其它写 sessionStorage 的分享页）
    allowed_surfaces: `mail-vue/src/layout/header/index.vue`、`mail-vue/src/views/share/`
    stop_when: 已确定登出或换号是否清键；不要沿访客 OTP session 继续扩散

---

## T3 · 昨日日审台账把 B1/B2 七条标关闭并推进 git-8934 游标

- **theme_id**: T3
- **commits**: `ea1434c` `d244fc2` `200daa9` `4ea2efc`
- **intent**
  把 2026-08-28-r1 的范围、聚类、归并、关闭证据留在仓内，让下一轮能接游标。不是产品功能。
- **surfaces**
  `.agent-workspace/review-ledger/**` · `.gitattributes` merge=union
- **refs**
  git-review-sweep finding-schema · 本仓 `.gitattributes`
- **review_focus**
  1. `4ea2efc` 关闭的七条（F-0004, F-78412ce3, F-89dcf76e, F-570b7d4c, F-420feb8d, F-e87370ba, F-92520298）close_note 是否带 commit + verify 退出码。判据 schema §2。
  2. `state.json` `origin/main` 游标是否停在 `083c87f`、`skipped_in_progress` 是否仍含 `cursor/git-8934`（本轮应改写）。
  3. `ledger.jsonl` 是否同 id 两行（union 残留）。本轮收尾必须跑 `verify-ledger.py`。
  4. INDEX 覆盖区「未关闭 P2=21」与 jsonl 是否对账。
- **risk**: low —— 台账接续错误会让下一轮漏审或重复劳动。
- **risk_spread_budget**: none

---

## 耦合边

- `T1 --contract-change--> T2`：T1 的 `SHARE_NOT_FOUND` / 零残留稳定码是 T2 remnant 升档的唯一服务端信号。合起来看：若 T1 在部分写入后仍写了幂等行，T2 会把 Owner 永久锁在 remnant。
- `T1 --ordering--> T3`：T3 关闭 F-0004 等，正确性依赖 T1 的篱笆真的回滚。合起来看：关账但篱笆在真 D1 上不触发 = 台账撒谎。
- `T2 --same-file--> T3`：无（T3 不改 Vue）。

无 `shared-ssot` 边。
