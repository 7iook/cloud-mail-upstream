# Recon · T-29 收尾(文档 / ADR / i18n / 台账)

- 日期:2026-08-24
- 分支:`cursor/mailbox-share-capability-dcb6`
- 起始 HEAD `4909e7b`;侦察期间协调者并发提交了 `64de5b9`(T-28 收口),**本文行号已全部按 `64de5b9` 复核**
- 前置:T-27 CLOSED(`190f704`,`review-t27.md` APPROVED p0=0 p1=0 p2=1);T-28 CLOSED(`64de5b9`,纯回归,Evidence 记 `commit: none (checkpoint, no code delta)`)
- 侦察性质:**只读**。本文件是本次唯一落盘产物,未改任何生产代码/测试/规格,未提交、未切换分支。

## 0. 成功态复述(执行者照此收敛,不得漂移)

运维/接手者只读仓库就能看出这条能力已交付:

1. ADR 状态是 **Accepted** 且带实施结论;`design.md` front-matter 有 `shipped_commit`。
2. 中文访客 / 英文访客 / 管理端 UI 都不再出现 `PENDING_COPY` 兜底或裸 key。
3. README 有一段说明"邮箱分享能力"。
4. 已知遗留缺陷**写下来**,而不是默默留着。

负向约束(必须保持):`SHARE_CAPABILITY_V2` 生产默认仍为 false;**不新造第二份 changelog SSOT**;不重写 W0–W6 历史;不改 `tests/e2e/**`(除 §5 那条被推荐的单断言);不重开 T-27 Fog-1/2/3、T-26 Fog-3 形状、T-25 P1-4。

---

## 1. 迷雾裁决表(6 条,全部从代码得出)

| # | 迷雾 | 裁决(证据) |
|---|---|---|
| **F-1** | CHANGELOG 到底在哪? | **仓内不存在任何 changelog 文件**。`find . -iname "*changelog*"`(排除 node_modules)=0 命中;`git log --diff-filter=D -- '*CHANGELOG*'`=空,历史上也没删过。`README.md:12-14` 的 release badge 指向 GitHub Releases —— 版本流水的真源在**仓外**。→ **不新建 `CHANGELOG.md`**。T-29.2 的"CHANGELOG 行"落到既有 SSOT:三份 `## Update Log`(`tasks.md:675` / `design.md:672` / `requirements.md:249`)+ ADR 的实施结论段。理由见 §7。 |
| **F-2** | ADR 真实路径与当前状态? | 路径与任务书一致:`docs/architecture/ADR-mailbox-share-capability-extension.md`。当前 `## Status`(第 3 行)下第 5 行为 `Proposed(stub · 随 ... charter 落盘,实现验收后补全并转 Accepted)` —— 原文已自带"验收后转 Accepted"的承诺,T-29 只是兑现它。该 ADR **无 YAML front-matter**,只有 `## Status` / `## Context` / `## Decision` / `## Consequences` / `## References` 五段。注意:前继 ADR `ADR-mail-share-capability-boundary.md:3-5` 同样停在 `Proposed` —— **不在 T-29 范围,不要顺手翻它**。 |
| **F-3** | 缺失 i18n 键全量清单? | **96 个,全部 zh.js 与 en.js 双缺**(无一个已存在,无重复登记)。W4 管理端 86 个(5 份 `PENDING_COPY` 去重后的并集)+ W5 访客页 10 个。会话说的"W5 共 10 个"**核实为真**(T-26 新 8 + T-25 遗留 `shareVisitMailboxes` / `shareVisitNewMail`);但那只是访客页,**管理端另有 86 个从未被计数**。全表见 §3。 |
| **F-4** | `expiresAt` 残留是不是只有 `clearMailboxView`? | **不是。同根第二处:`exitShare()`。** 详见 §5。**建议 T-29 一并修**(两行赋值),理由与爆炸半径见 §5。 |
| **F-5** | 改哪个 README、哪一段? | **根 `README.md` 的 `## 功能介绍`(第 49 行)**,以及其英文镜像 **`README-en.md` 的 `## Features`(第 44 行)**。`mail-worker/` 与 `mail-vue/` **没有 README**(仓内 README 只有 5 个:根 2 个 + `tests/e2e/README.md` + `docs/specs/README.md` + `mail-vue/public/tinymce/langs/README.md`,后三个都不是产品说明)。插入点见 §6。 |
| **F-6** | 双写 / `setting.share` 债务引用哪个 file:line? | 见 §7 台账表,三条全部带精确锚点。 |

---

## 2. T-29.1 · 文档收口(最省改法)

### 2.1 ADR 转 Accepted

`docs/architecture/ADR-mailbox-share-capability-extension.md`

- **第 5 行**整行替换:`Proposed(stub · …)` → `Accepted(2026-08-24 · 实现验收通过,见下「实施结论」)`。
- 在 `## Consequences` 之后、`## References`(第 48 行)之前插入一个 `## 实施结论` 小节。内容只写**已被证据钉住的事实**,不要复述 Decision:
  - 三套测试基线:worker 18 files / 626 · vue 22 files / 250 · E2E 19 passed / 0 skipped(来源 `review-t27.md` 测试证据段 + `tasks.md:671`)。
  - 落地偏离:无。R1–R3 全部裁决按原文实现;`access_count` 物理列未 RENAME;`share_type` 未落库。
  - **发布态**:`SHARE_CAPABILITY_V2` 生产默认 **false**(`mail-worker/wrangler.toml:58` 仅有注释声明,无赋值;`mail-share-service.js:67-70` 的 `isCapabilityV2Enabled` 缺省即 false)。多邮箱 / AuthKey / 有限 `max_sessions` 三项能力**代码就位但整体冻结**,激活是部署动作(迁移完成 + 回填重跑 + 无旧 Worker + 告警消费者就绪),不在本次交付内。
  - Expand 阶段**仍在双写**,Contract(停双写)是后续版本任务 —— 与 §7 台账 D-2 同指。

> ⚠️ Accepted 必须同时说清"默认关闭",否则运维会误读成能力已生效。这是本次收尾最容易出的事实错误。

### 2.2 `design.md` front-matter

`docs/specs/mailbox-share-capability/design.md:12` `shipped_commit: null` → 填值。

**取值建议:`190f704`。** 依据:它是 W6 交付并被 APPROVED 的最后一个实现提交(T-27),`tasks.md:610` 已把它登记为 T-27 的 `commit`。最后一个**生产代码**提交其实是 `6e8bc10`(T-26),而 T-28 自己的 Evidence 明写 `commit: none (checkpoint, no code delta)` —— 也就是说 `190f704` 之后再无实现落地,它就是"全部任务通过验收"的时点,贴合 `docs/specs/README.md:38-41` 生命周期机对 `shipped` 的定义。T-29 自身的提交无法自引用,不作候选。

**顺带一个字段(建议做,成本 1 行)**:同 front-matter 第 6 行 `status: converged` → `shipped`。`docs/specs/README.md:38-41` 明写 `in-impl → shipped` 的条件是"tasks.md 全部完成 + 填 `shipped_commit`",T-29 勾完即满足;若只填 `shipped_commit` 而 status 停在 `converged`,索引表与 ADR 的 Accepted 自相矛盾,正是成功态第 1 条要避免的。同时手改 `docs/specs/README.md:23` AUTO-INDEX 那一行的 `converged` → `shipped`(该区块虽标注"自动重生成会覆盖人工修改",但脚本是从 design.md front-matter 重生的,手改到与 front-matter 一致是幂等的,不会被改回)。

### 2.3 两份 spec `## Update Log` 各加一行

- `docs/specs/mailbox-share-capability/tasks.md:675`(**追加在列表顶部**,该文件是倒序)
- `docs/specs/mailbox-share-capability/design.md:672`(**追加在列表末尾**,该文件是正序)
- `requirements.md:249` 同为正序 —— 任务书写的是"两份 spec",而实际有三份文档带 Update Log。**按任务书字面只写 tasks.md 与 design.md 两份即可**;requirements.md 的 Update Log 记的是评审轮次修订,本次无 AC 变更,不必追加。

同时把 `tasks.md:10` 的状态行 `in-progress · T-27/T-28 APPROVED · T-29 侦察` 改成收尾态,并勾上 T-29 / T-29.1 / T-29.2 三个 checkbox(带 Evidence)。T-28 已由 `64de5b9` 勾完(`tasks.md:635`),不要重复处理。

**一处顺手纠偏(1 行)**:`tasks.md:27` 冲突热区表把 `mail-vue/src/i18n/{zh,en}.js` 的唯一写者记为 **T-28**,但 T-28 已在 `64de5b9` 以"纯回归、零 diff"收口,真实写者是 **T-29.2**(`tasks.md:645` 自己也这么写)。改这一格,免得下一个人按热区表去找 T-28 根本不存在的 i18n 提交。

---

## 3. T-29.2 · i18n 全量清单(96 键 · 单写者一次落盘)

### 3.1 落盘位置

`mail-vue/src/i18n/zh.js` 与 `en.js` **只有这两个 locale**(`ls src/i18n/` = `en.js` `index.js` `zh.js`)。两文件的 share 段都是文件尾部:zh 第 340–385 行、en 第 340–385 行,第 386 行即闭合 `}`。→ **追加点 = 第 385 行 `shareVisitNoSubject` 之后、闭合 `}` 之前**,给 385 行补逗号。两文件同结构,纯尾部追加,零冲突。

### 3.2 W5 访客页 · 10 键

这 10 个在 `views/share/index.vue` 里用 `tx(key, fallback)` 调用,**已有英文兜底**,所以英文访客现在看到的是正常英文,中文访客看到的也是英文(缺 zh 才是真缺陷)。

> **en.js 的取值铁律:逐字照抄 fallback**。`index.spec.js` 以 `locale: 'en'` 挂载并对文案做语义正则断言(`:261-263` `/timed out/i` `/original link/i`、`:388` `/no longer available/i`、`:1154` authRequired 态 **不得**匹配 `/attempt|remaining|locked|too many/i`)。照抄 fallback = 渲染结果逐字不变 = 这些断言零风险。改写英文措辞才会踩雷。

| # | key | 现有英文 fallback(= en.js 应填值) |
|---|---|---|
| 1 | `shareVisitAuthTitle` | This share needs an access key. |
| 2 | `shareVisitAuthLabel` | Access key |
| 3 | `shareVisitAuthChecking` | Checking... |
| 4 | `shareVisitAuthSubmit` | Open |
| 5 | `shareVisitAuthRetry` | That key did not work. Check it and try again. |
| 6 | `shareVisitMailboxes` | Mailboxes |
| 7 | `shareVisitNewMail` | New mail |
| 8 | `shareVisitRefreshing` | Checking... |
| 9 | `shareVisitRefresh` | Check for new mail |
| 10 | `shareVisitExpiresIn` | Link expires in |

zh 值需新译(参照既有 `shareVisit*` 段的语气,如 `shareVisitAuthTitle: '打开这个分享需要访问密钥。'`)。`applyShareLocale()`(`views/share/index.vue:290-294`)按 `navigator.language` 选 zh/en,访客页是唯一会真跑 zh 的分享界面。

### 3.3 W4 管理端 · 86 键

来自 5 份 `PENDING_COPY` 映射的去重并集,**全部只有中文、没有英文**。第三列是现成中文文案 → 直接搬进 zh.js;en.js 需要新写英文。

来源文件:`share-admin/index.vue:120-131`(admin-list) · `share-admin/ShareCreateWizard.vue:356-401`(wizard) · `share-admin/ShareDetailDrawer.vue:352-401`(drawer) · `share-admin/ShareRowActions.vue:47-51`(row-actions) · `email/ShareDialog.vue:105-107`(ShareDialog)。

| # | key | 现有中文(= zh.js 应填值) | 使用处 |
|---|---|---|---|
| 1 | `shareStatusLimitReached` | 已达访问上限 | admin-list + drawer |
| 2 | `shareTypeSingle` | 单邮箱 | admin-list + drawer |
| 3 | `shareTypeMulti` | 多邮箱 | admin-list + drawer |
| 4 | `shareBoundMailboxes` | 绑定邮箱 | admin-list + drawer |
| 5 | `shareSessionQuota` | 会话用量 | admin-list + drawer |
| 6 | `shareQuotaUnlimited` | 不限 | admin-list + wizard + drawer |
| 7 | `shareFilterStatus` | 状态 | admin-list |
| 8 | `shareFilterAll` | 全部 | admin-list |
| 9 | `shareAdminForbidden` | 你没有分享管理权限，请联系管理员。 | admin-list |
| 10 | `shareRefresh` | 刷新 | admin-list |
| 11 | `shareWizardOpen` | 新建分享 | wizard |
| 12 | `shareWizardTitle` | 新建分享 | wizard |
| 13 | `shareWizardPresetStep` | 选一个用途 | wizard |
| 14 | `sharePresetSingleOtp` | 单邮箱验证码 | wizard |
| 15 | `sharePresetSingleOtpHint` | 把一个邮箱的验证码分给同事，1 小时后自动失效。 | wizard |
| 16 | `sharePresetTempMailbox` | 临时邮箱 | wizard |
| 17 | `sharePresetTempMailboxHint` | 对方需要看到完整地址去别处注册，有效期 24 小时。 | wizard |
| 18 | `sharePresetMultiOtp` | 多邮箱验证码池 | wizard |
| 19 | `sharePresetMultiOtpHint` | 一个链接汇总多个邮箱的验证码，需平台已激活该能力。 | wizard |
| 20 | `sharePresetCustom` | 自定义 | wizard |
| 21 | `sharePresetCustomHint` | 全部选项展开，自己配。 | wizard |
| 22 | `shareWizardAdvanced` | 高级选项 | wizard |
| 23 | `shareWizardMailboxes` | 分享的邮箱 | wizard |
| 24 | `shareWizardDuration` | 有效期 | wizard |
| 25 | `shareWizardLinkLabel` | 分享链接 | wizard |
| 26 | `shareWizardShareId` | 分享 ID | wizard |
| 27 | `shareWizardLinkId` | 链接 ID | wizard |
| 28 | `shareOnlyAfterCreated` | 只显示创建之后收到的邮件 | wizard |
| 29 | `shareOnlyAfterCreatedHint` | 创建后无法更改这一项。 | wizard |
| 30 | `shareCapabilityInactive` | 能力未激活 | wizard |
| 31 | `shareCapabilityInactiveHint` | 平台尚未开放多邮箱、访问密钥与用量上限。已为你关掉这几项，其余设置可以照常提交。 | wizard |
| 32 | `shareCapabilityUnknownHint` | 若平台尚未开放该能力，带这几项的提交会被拒绝。 | wizard |
| 33 | `shareCapabilityRecheck` | 重新检测 | wizard |
| 34 | `shareCreateUnknownTitle` | 没收到服务器的回应 | wizard |
| 35 | `shareCreateUnknownHint` | 分享可能已经建好了。请用同一把钥匙重试 —— 换一把会建出第二个分享。表单已锁定，以免重试时改动了内容。 | wizard |
| 36 | `shareCreateRetrySameKey` | 用同一把钥匙重试 | wizard |
| 37 | `shareReplayGuidance` | 这次提交命中了之前的同一请求，链接明文不会再发放。请撤销或删除这个分享，然后重新创建一个新链接。 | wizard |
| 38 | `shareWizardCloseConfirm` | 关闭后将无法再看到这个链接（和密钥）。确认已经保存好了吗？ | wizard |
| 39 | `shareCreatedSaved` | 我已保存 | wizard |
| 40 | `shareWizardCountTooSmall` | 上限至少是 1；留空表示不限。 | wizard |
| 41 | `shareName` | 名称 | wizard + drawer |
| 42 | `shareRemark` | 备注 | wizard + drawer |
| 43 | `shareMaxSessions` | 会话上限 | wizard + drawer |
| 44 | `shareMessageLimit` | 邮件条数上限 | wizard + drawer |
| 45 | `shareOtpExtraction` | 提取验证码 | wizard + drawer |
| 46 | `shareAutoRefresh` | 自动刷新 | wizard + drawer |
| 47 | `shareRefreshInterval` | 刷新间隔（毫秒，最小 3000） | wizard + drawer |
| 48 | `shareRefreshIntervalTooSmall` | 刷新间隔不能小于 3000 毫秒。 | wizard + drawer |
| 49 | `shareShowFullAddress` | 显示完整地址（展示选项） | wizard + drawer |
| 50 | `shareShowFullAddressHint` | 只影响分享页上邮箱地址的显示方式。关闭它不会改变邮件正文、主题或发件人里出现的地址。 | wizard + drawer |
| 51 | `shareAuthKey` | 访问密钥 | wizard + drawer |
| 52 | `shareBindingLoadMore` | 加载更多邮箱 | wizard + drawer |
| 53 | `shareBindingLimitReached` | 一个分享最多绑定 50 个邮箱。 | wizard + drawer |
| 54 | `shareDetailTitle` | 分享详情 | drawer |
| 55 | `shareDetailLoadError` | 详情加载失败，请刷新重试。 | drawer |
| 56 | `shareDetailReadonly` | 这个分享已不可修改（已过期或已销毁），仅供查阅。 | drawer |
| 57 | `shareDetailGone` | 这个分享已不存在，已为你刷新列表。 | drawer |
| 58 | `shareBindingAdd` | 添加邮箱 | drawer |
| 59 | `shareBindingRemove` | 移除 | drawer |
| 60 | `shareBindingRemoveConfirm` | 移除后，这个邮箱的邮件会立刻从分享页消失。 | drawer |
| 61 | `shareBindingRemoveLastConfirm` | 这是最后一个邮箱，移除它会同时销毁整个分享。 | drawer |
| 62 | `shareBindingConflict` | 绑定关系刚被改动过，已为你刷新，请重新确认。 | drawer |
| 63 | `shareBindingNoneAvailable` | 没有可添加的邮箱了。 | drawer |
| 64 | `shareConfigTitle` | 配置 | drawer |
| 65 | `shareConfigSaved` | 已保存 | drawer |
| 66 | `shareConfigNoChange` | 没有需要保存的改动。 | drawer |
| 67 | `shareConfigRejected` | 这项配置未被接受：可能超出了当前允许的取值，或这项能力尚未开放。请调整后重试。 | drawer |
| 68 | `shareResetUsedSessionsTitle` | 是否把已用会话数清零？ | drawer |
| 69 | `shareResetUsedSessionsHint` | 这是这个分享第一次设置会话上限。清零后按新上限重新计数；保留计数可能让它立刻触顶。 | drawer |
| 70 | `shareResetUsedSessionsYes` | 清零并保存 | drawer |
| 71 | `shareResetUsedSessionsNo` | 保留计数并保存 | drawer |
| 72 | `shareAuthKeyOn` | 已启用 | drawer |
| 73 | `shareAuthKeyOff` | 未启用 | drawer |
| 74 | `shareAuthKeyEnable` | 启用 | drawer |
| 75 | `shareAuthKeyReset` | 重置 | drawer |
| 76 | `shareAuthKeyDisable` | 关闭 | drawer |
| 77 | `shareAuthKeyEnableHint` | 启用后，新的访问需要这把密钥；已经打开的访问不受影响。 | drawer |
| 78 | `shareAuthKeyKillConfirm` | 这会立刻让所有已打开的访问失效，访客需要用新密钥重新打开。 | drawer |
| 79 | `shareAuthKeyDisableConfirm` | 关闭后不再需要密钥，同时立刻让所有已打开的访问失效。 | drawer |
| 80 | `shareAuthKeyOnce` | 新密钥只显示这一次，关闭后无法再查看。请立即复制并妥善保存。 | drawer |
| 81 | `shareAuthKeySaved` | 我已保存 | drawer |
| 82 | `shareAuthKeyFailed` | 无法完成：可能是这项能力尚未开放，或分享状态刚刚变化。请刷新后重试。 | drawer |
| 83 | `shareDetail` | 详情 | row-actions |
| 84 | `shareDeleteConfirm` | 彻底删除这个分享及其全部记录？此操作不可恢复，且与「销毁」不同——删除后列表里也不再保留审计记录。 | row-actions |
| 85 | `shareDeleteSuccess` | 已删除 | row-actions |
| 86 | `shareGoAdmin` | 前往分享管理 | ShareDialog |

> `shareDeleteSuccess`(#85)只经 `run(deleteMailShare, 'shareDeleteSuccess')` → `tf(successKey)` 间接引用(`ShareRowActions.vue:99` + `:72`);`#1-3` / `#14,16,18,20` 经 `labelKey` 间接引用(`share-admin/status.js:4-7`、`presets.js:60-118`)。静态搜 `tf('...')` 会漏掉这 8 个 —— **按 `PENDING_COPY` 并集落盘,不要按调用点落盘。**

### 3.4 落盘后是否要删 `PENDING_COPY`?

**不要删。** `tf()` 是 `te(key) ? t(key) : (PENDING_COPY[key] || key)` —— 键补齐后 `PENDING_COPY` 自动变成不可达兜底,留着零成本、零风险;删它要动 5 个生产 `.vue` 文件、每个都得重跑定点 spec,完全不符合 ponytail lite。`session-ledger.md:198` 写的"T-29 清 PENDING_COPY"应理解为"清掉它的**生效路径**",不是删代码。若坚持要删,请另开任务,不要塞进 T-29。

### 3.5 ⚠️ en.js 的四条硬约束(唯一真实的爆炸半径)

管理端 spec **全部以 `locale: 'en'` + 真实 `en.js` 挂载**(`ShareDetailDrawer.spec.js:146`、`ShareCreateWizard.spec.js:173`、`share-admin/index.spec.js:124`、`ShareRowActions.spec.js:52`、`ShareDialog.spec.js:109`)。今天 `te(key)` 为 false 所以渲染的是中文兜底;**补上 en.js 后渲染内容会整体从中文变英文**。已核查全部文案断言,没有一条钉死字面量,但有 4 条形状断言必须满足:

1. **四个状态标签互不相同** —— `share-admin/index.spec.js:187-189` 断言 4 个 `share-status` 文本去重后仍是 4。新键 `shareStatusLimitReached` 的英文不得撞上既有 `Active` / `Expired` / `Revoked`(建议 `Session limit reached`)。
2. **销毁 ≠ 删除的确认文案** —— `ShareRowActions.spec.js:101-105` 断言 `shareDeleteConfirm` ≠ 既有 `shareRevokeConfirm`(en.js:356)。
3. **移除最后一个邮箱 ≠ 普通移除;重置 ≠ 关闭** —— `ShareDetailDrawer.spec.js:337-354`(`shareBindingRemoveLastConfirm` ≠ `shareBindingRemoveConfirm`)与 `:630-634`(`shareAuthKeyKillConfirm` ≠ `shareAuthKeyDisableConfirm`)。
4. **掩码开关不得承诺保密** —— `ShareDetailDrawer.spec.js:772-783` 对 `shareShowFullAddress` / `shareShowFullAddressHint` 跑黑名单正则 `/保密|加密|安全|私密|secret|hidden|hide|private|privacy|secure|protect/i`。该测试的注释原文就写着"词表覆盖 zh 与 en,好让这道闸门在 T-29 换上真译文后依然成立"。**英文提示里不能出现 `hide` / `hidden`** —— "does not hide addresses in the body" 这种自然写法会直接把它打红。建议 `Only changes how the mailbox address is displayed on the share page. Turning it off does not change addresses that appear in the mail body, subject or sender.`

另有一条低风险项:`ShareDialog.spec.js:229-230` 断言过期行文本匹配 `/expired/i` 且**不**匹配 `/active/i`。`shareGoAdmin` 渲染在对话框页脚、不在 `share-row` 内,英文取 `Go to share management` 安全。

**验证口径**:改完 i18n 至少跑 `pnpm --dir mail-vue test`,预期仍为 22 files / 250 passed(基线只增不减)。worker 与 E2E 不受 i18n 影响,但 T-29 收尾理应三套齐跑一次。

---

## 4. T-26 Fog-3 · 登记为已知限制(不是新功能)

`views/share/index.spec.js:1396-1411` 已把该行为钉成断言,注释原文:「Fog-3:复活路径拿不到 config,刷新策略与倒计时按缺省降级 —— 这是已知限制,不是回归」。

事实:sessionStorage 里存着 token 时,bootstrap 不再调 `createShareSession`(省一个配额名额,AC-SESS-03 优先),因此拿不到 `config` 与 `expiresAt`,于是 `bootstrap()`(`views/share/index.vue:905-908`)的缺省值原样生效:`otpEnabled=true`、`autoRefresh=true`、`refreshIntervalMs=POLL_INTERVAL_MS`、`expiresAt=''`(**无倒计时、无手动刷新按钮**)。

→ 写进 §7 台账 **D-3**,一句话说清"刷新一次页面后倒计时和自定义刷新间隔会消失,直到会话重新建立"。**不做任何代码改动**,不新增端点、不改复活路径。裁决已在 `session-ledger.md:180` 锁定,不重开。

---

## 5. T27-P2-1 / T27-L1 · `expiresAt` 残留(F-4 详解)

### 5.1 同根盘点(四条清理路径全查)

| 路径 | 位置 | 清 `expiresAt`? |
|---|---|---|
| `bootstrap()` | `views/share/index.vue:902-908` | ✅ 第 908 行 `expiresAt.value = ''` |
| `clearMailboxView()` | `:660-671` | ❌ **缺** —— 被 `showDeadShare()`(`:673-680`,撤销/失效)与 `showTimedOut()`(`:682-689`,会话超时)调用 |
| `exitShare()` | `:810-825` | ❌ **缺** —— 这是 `clearMailboxView` 的**内联复制**(逐行同形:清 session/est-key、`sessionToken`、`mailbox`、`mails`、`selectedId`、`rateLimited`),同样漏了 `expiresAt` |
| `resetMailbox()` | `:827-833` | 不适用 —— 只在 `bootstrap()` 内被调用,紧跟其后的第 908 行已经清了 |
| `onUnmounted` | `:969` | 不适用 —— 组件即将销毁 |

**结论:不止一处。** 除审查记录的 `clearMailboxView` 外,`exitShare` 是同根第二处。倒计时节点 `<time data-share-expires>` 的渲染条件是 `v-if="expiresLabel"`(`:17-22`),**与 `state` 无关**,挂在 `<header>` 里对所有状态可见 —— 所以 `unavailable` / `timedout` / `exited` 三个终态都会残留倒计时,直到它自然走到 0。

### 5.2 建议:**纳入 T-29**

修法就是两行赋值(`clearMailboxView` 与 `exitShare` 各加 `expiresAt.value = ''`)。属 `mail-vue`,T-29 白名单内;两个函数都不在任何单 owner 热区的活跃占用下(`session-ledger.md:196-198` 只锁 `request/mail-share.js` 与 `share-admin/*`)。

更省的写法是让 `exitShare()` 直接调用 `clearMailboxView()` 消掉这份重复,但那会改动 `exitShare` 的执行顺序语义(`pageSecret` / `justRecovered` 的清理时机),风险高于收益 —— **ponytail lite:就加两行赋值,不做去重重构。**

### 5.3 爆炸半径

- **现有 E2E 不会变红。** `tests/e2e/specs/visitor-revoke-live.spec.js:47-51` 的 `deadShell()` 只读三样:header 文案、`[data-share-body]` 文本、以及一个**显式枚举**的活体元素计数器 `[data-share-mail-list], [data-share-code], [data-share-auth], [data-share-empty], [data-share-exit], [data-share-refresh], [data-share-tabs]` —— `[data-share-expires]` **被刻意排除在外**,spec 第 42-46 行的注释白纸黑字说明了原因("这处残留是 mail-vue 缺陷,mail-vue 不在本任务白名单,记在 exec-t27-note.md 而不钉在这里,好让将来的修复不会把这条打红")。修复后三个读数全部不变。
- **现有 vue 单测不会变红。** `index.spec.js` 全部 4 处 `[data-share-expires]` 断言(`:1405` `:1453` `:1460` `:1476`)都在 `ready` 态或存 token 复活态下取值,没有一条经过 `clearMailboxView` / `exitShare`。
- **可选:补 1 条 E2E 断言把 AC-EDGE-03 的死壳钉死。** 在 `visitor-revoke-live.spec.js` 现有 `waitShareState(page, 'unavailable')`(第 25 行)之后加一行 `expect(await page.locator('[data-share-expires]').count()).toBe(0)`。
  - **为什么不会 flake**:`showDeadShare()` 在**同一个同步函数体内**先 `clearMailboxView()` 再 `state.value = 'unavailable'`,Vue 在同一次 flush 里渲染两者;`waitShareState` 等的就是 `data-share-state="unavailable"` 落定,那一刻 `expiresLabel` 必然已为空。不引入新的等待、不依赖计时、不依赖网络。
  - **代价**:这会动 `tests/e2e/**`。T-28 禁的是"改断言让红变绿",而这是**新增**一条此前无人覆盖的断言,方向相反。**建议加**;若协调者想把 e2e 完全冻到 T-28 之后,那就只改两行生产代码、把这条断言记进台账留待后续 —— 两种都自洽,不要两头都不做。

---

## 6. README 段落(F-5 详解)

两份 README 的功能清单结构完全对称,末项都是"更多功能 / More Features: 开发中"。**在末项之前插入一条 bullet**,与既有条目同格式(emoji + 粗体标题 + 冒号 + 一句话):

- `README.md` —— 插在第 71 行(`🤖 人机验证`)与第 73 行(`📜 更多功能`)之间。
- `README-en.md` —— 插在第 66 行(`🤖 CAPTCHA`)与第 68 行(`📜 More Features`)之间。

内容要点(一句话,不写实现细节):一条不可猜链接把 1 个或多个邮箱在限定时间内只读交给未登录访客,支持会话次数上限、可选访问密钥与验证码提取。**不要在 README 里写 `SHARE_CAPABILITY_V2`** —— README 是给用户看的功能介绍,开关语义属于 ADR 与部署文档;真要提一句"多邮箱/访问密钥需平台启用"也可以,但别展开。

**不做**:不加新的 `## 章节`、不改目录结构树、不动技术栈表 —— 任务书明写"不要提议文档重写"。

---

## 7. Tech-debt 台账(F-1 落点 + F-6 锚点)

### 7.1 台账放哪

**仓内没有任何 tech-debt 文件**(`find -iname "*debt*"` = 0 命中)。为不新造 SSOT,建议**在 `docs/specs/mailbox-share-capability/design.md` 的 `## Update Log`(第 672 行)之前,新增一节 `## 已知限制与技术债`**。理由:design.md 已经是这条能力的设计真源,front-matter 的 `shipped_commit` 也在这里;`docs/specs/README.md:2-4` 明确指引"查某功能当初为什么这么定 / 现在什么状态 → 读对应 spec 的 design.md"。放到 `.agent-workspace/` 是错的 —— 那是会被归档的过程产物,运维读不到,违背成功态第 4 条。

### 7.2 三条债目(带精确锚点,**T-29 只登记、不修**)

| ID | 债目 | 锚点 | 处置 |
|---|---|---|---|
| **D-1** | 死分支 `setting.share`。`isShareDisabled()` 在两处各判一次 `setting.share === 1 \|\| setting.share === '1'` 作为"站点级关分享"开关,但仓内**没有任何地方写入过 `setting.share`**(`rg "setting\.share\|settings\.share"` 只命中这两个读点),所以该分支恒为 false,实际生效的只有环境变量 `SHARE_ENABLED`。 | `mail-worker/src/service/mail-share-service.js:60`<br>`mail-worker/src/service/share-auth-service.js:69` | **不修、不删。** 它是为将来的站点设置项预留的,删了要动两个 W1/W2 已收口的服务文件并重跑其定点 spec,收益为零。 |
| **D-2** | Expand 阶段双写未停。`syncPrimaryAccountId()` 在每次 Binding 变更时把 `mail_share.account_id` 与 `window_start_email_id` 同步为主 Binding 的值,保证兼容窗口内旧 Worker 仍能按主表列服务单邮箱语义。Contract(确认无旧 Worker 后停止双写、把 `account_id` 降为遗留列)是**后续版本任务**。 | 定义 `mail-worker/src/service/mail-share-service.js:730-760`(注释 730-736)<br>调用点 `:863`(create) `:1228`(binding 变更)<br>ADR `## Consequences` 第 41 行 | **不修。** 停双写的前置是部署侧事实(无旧 Worker 在途),不是代码判断;`tasks.md:664` 的 gate 已经明确这类动作不在任务清单内静默执行。 |
| **D-3** | 存 token 复活的配置降级(T-26 Fog-3)。刷新页面后若 sessionStorage 仍有有效 token,前端不重建会话(省配额),因而拿不到 `config`/`expiresAt`,倒计时消失、刷新间隔回落到 `POLL_INTERVAL_MS`、`autoRefresh` 回落到 true。 | `mail-vue/src/views/share/index.vue:902-908`<br>钉住的断言 `mail-vue/src/views/share/index.spec.js:1396-1411`<br>裁决 `session-ledger.md:180` | **已知限制,不修。** AC-SESS-03(不多耗配额)优先于 AC-OTP-05。 |

若 §5 的 E2E 断言被决定推迟,再加一条 **D-4**:`[data-share-expires]` 缺席未在 E2E 层钉住,`visitor-revoke-live.spec.js` 的死壳比较仍不含倒计时节点。

### 7.3 AC-ADMIN-08 怎么闭环

`requirements.md:162`:既有 `ShareDialog` 须继续可用为快捷创建入口、调用升级后的 create 契约,完整管理能力位于新建管理模块、不得塞回对话框。T-29 是**证据登记**,不是代码改动 —— 现状已满足:`views/email/ShareDialog.vue` 仍在,唯一新增的键是 `shareGoAdmin`(跳转到管理模块的链接),`canManageShare()`(`:115-121`)用 `share:manage` 守门。在 T-29.2 的 Evidence 里引这两个锚点即可。

---

## 8. 执行清单(建议的最小改动集 · 9 个文件)

| # | 文件 | 改动 |
|---|---|---|
| 1 | `docs/architecture/ADR-mailbox-share-capability-extension.md` | 第 5 行转 Accepted;`## References` 前插 `## 实施结论`(须写明 V2 默认 false) |
| 2 | `docs/specs/mailbox-share-capability/design.md` | 第 12 行 `shipped_commit: 190f704`;第 6 行 `status: shipped`;`## Update Log` 末尾 +1 行;`## Update Log` 前插 `## 已知限制与技术债`(D-1/D-2/D-3) |
| 3 | `docs/specs/mailbox-share-capability/tasks.md` | 第 10 行状态;第 27 行 i18n 写者 T-28→T-29.2;勾 T-29/T-29.1/T-29.2(:643/:644/:645)+ Evidence;`## Update Log`(:675)顶部 +1 行 |
| 4 | `docs/specs/README.md` | 第 23 行索引 `converged` → `shipped` |
| 5 | `mail-vue/src/i18n/zh.js` | 第 385 行后追加 96 键中文 |
| 6 | `mail-vue/src/i18n/en.js` | 第 385 行后追加 96 键英文(访客 10 键逐字照抄 fallback;管理 86 键新译,守 §3.5 四条约束) |
| 7 | `README.md` | 第 71/73 行之间 +1 条 bullet |
| 8 | `README-en.md` | 第 66/68 行之间 +1 条 bullet |
| 9 | `mail-vue/src/views/share/index.vue` | `clearMailboxView()`(:671 前)与 `exitShare()`(:823 后)各加 `expiresAt.value = ''` |

可选第 10 项:`tests/e2e/specs/visitor-revoke-live.spec.js` 第 25 行后 +1 条 `[data-share-expires]` 计数断言(理由与非 flake 论证见 §5.3)。

**不改**:任何 `mail-worker/**`;`tests/e2e/**` 除上述可选一行;5 份 `PENDING_COPY` 映射;`ADR-mail-share-capability-boundary.md`;`requirements.md`。

**验收**:`pnpm --dir mail-vue test`(22/250)+ `pnpm --dir mail-worker test`(18/626)+ `node tests/e2e/run.mjs`(19 passed / 0 skipped),只增不减。

## Update Log

- 2026-08-24 · 主 AI 裁决:F-1 不新建 CHANGELOG.md；F-3 落盘 96 键；F-4 两处 expiresAt 一并修；T29-PENDING HOLD 不删映射；T29-E2E CHANGE 加一条死壳断言；T29-SHIP `190f704` + status shipped。
- 2026-08-24 · 行号按并发落地的 `64de5b9`(T-28 收口)复核修订:`tasks.md` Update Log 669→675、T-29 系列 637-640→643-645;`design.md` status 行 5→6;`docs/specs/README.md` 索引行 24→23。结论无变化。
- 2026-08-24 · T-29 收尾侦察落盘。F-1 裁定仓内无 changelog、不新建;F-3 核出 96 个缺失键(会话所述"10 个"仅覆盖访客页,管理端 86 个此前未计);F-4 查出 `expiresAt` 残留有 `clearMailboxView` 与 `exitShare` 两处同根,建议纳入 T-29;识别 en.js 落盘的 4 条形状断言约束(掩码文案禁用 `hide`/`hidden` 为最易踩雷项)。
