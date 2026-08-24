# Exec · T-29 收尾(文档 / ADR / i18n / 台账)

- 日期:2026-08-24
- 分支:`cursor/mailbox-share-capability-dcb6`,起始 HEAD `a7172fb`
- SSOT:`recon-t29-wrap.md`;裁决 `session-ledger.md` F-1 / F-3 / F-4 / T29-PENDING / T29-E2E / T29-SHIP,本次一条未重开
- 强度:ponytail lite
- **未提交、未 stash、未切分支;tasks.md 的 T-29 三个 checkbox 未勾(留给协调者审查后勾)**

---

## 0. 成功态自检

| # | 成功态 | 落点 | 状态 |
|---|---|---|---|
| 1 | 运维只读仓库看得出已交付 | ADR `## Status` = Accepted + `## 实施结论`;`design.md` front-matter `status: shipped` / `shipped_commit: 190f704`;`docs/specs/README.md` 索引行 shipped | ✅ |
| 2 | 中/英访客与管理端不再出 `PENDING_COPY` 兜底或裸 key | zh.js / en.js 各 +96 键(384 → 480,双侧无差集) | ✅ |
| 3 | README 有一段分享能力 | `README.md` / `README-en.md` 各 +1 条 bullet | ✅ |
| 4 | 遗留缺陷写下来 | `design.md` 新增 `## 已知限制与技术债` D-1/D-2/D-3 | ✅ |

负向约束(逐条 grep 复核,见 §5):`SHARE_CAPABILITY_V2` 生产仍只有注释;未建 `CHANGELOG.md`;未重写 W0–W6 历史;5 份 `PENDING_COPY` 映射一字未删;`ADR-mail-share-capability-boundary.md`、`requirements.md`、`mail-worker/**` 零 diff。

---

## 1. 三套测试计数

| 套件 | 命令 | 结果 |
|---|---|---|
| vue | `pnpm --dir mail-vue test -- --no-cache` | **22 files / 252 passed** |
| worker | `pnpm --dir mail-worker test -- --no-cache` | **18 files / 626 passed** |
| E2E | `node tests/e2e/run.mjs` | **19 passed / 0 skipped** |

vue 由基线 250 → 252:F-4 新增两条单测,**没有一条既有断言被改写**。E2E 仍是 19 个 test —— 新断言加在既有 test 内部,不新增用例。worker 与基线完全一致(本次没碰 `mail-worker/**`)。

跑 E2E 前 `ss -lptn 'sport = :8788'` 空、`ps` 无 wrangler 进程,未 kill 任何 PID。

日志:`/opt/cursor/artifacts/t29_unit_suites.log`、`/opt/cursor/artifacts/t29_e2e_suite.log`。

---

## 2. F-4 `expiresAt` 残留 · 先红后绿

### 2.1 红(测试先行,生产代码未动)

在 `mail-vue/src/views/share/index.spec.js` 的 `share view expiry countdown and cleanup` describe 内加两条(复用既有倒计时测试的 UTC 字符串形状 `expiresAt: '2026-08-24 12:30:00'` + `setSystemTime('2026-08-24T12:00:00Z')`):

1. `drops the countdown when the share turns out to be gone` —— ready 且倒计时读到 `30m` → `noteShareFailure({ code: 'SHARE_UNAVAILABLE', ... }, true)` → 断言 `[data-share-expires]` 不存在。
2. `drops the countdown when the visitor leaves the share` —— ready 且倒计时读到 `30m` → 点 `[data-share-exit]` → 断言 state `exited` 且 `[data-share-expires]` 不存在。

```
 FAIL  src/views/share/index.spec.js > share view expiry countdown and cleanup > drops the countdown when the share turns out to be gone
 FAIL  src/views/share/index.spec.js > share view expiry countdown and cleanup > drops the countdown when the visitor leaves the share
AssertionError: expected true to be false // Object.is equality
- Expected
+ Received
- false
+ true
 ❯ src/views/share/index.spec.js:1498:63
 ❯ src/views/share/index.spec.js:1517:63

 Test Files  1 failed | 21 passed (22)
      Tests  2 failed | 250 passed (252)
```

两条都停在同一处 —— `[data-share-expires]` 仍在。红灯原因正是 recon §5 的诊断:倒计时节点的渲染条件 `v-if="expiresLabel"` 与 `state` 无关。

### 2.2 绿(两行赋值,不做去重重构)

`mail-vue/src/views/share/index.vue`:

- `clearMailboxView()` 末尾 `rateLimited.value = false` 之后 `+ expiresAt.value = ''`(覆盖 `showDeadShare` / `showTimedOut` 两个调用者)
- `exitShare()` 中 `rateLimited.value = false` 与 `state.value = 'exited'` 之间 `+ expiresAt.value = ''`

按 T29-F4 裁决**没有**把 `exitShare` 改成调用 `clearMailboxView`(那会挪动 `pageSecret` / `justRecovered` 的清理时机)。

```
 Test Files  22 passed (22)
      Tests  252 passed (252)
```

### 2.3 E2E 层的红→绿(意外收获,值得记下)

按 T29-E2E 裁决,在 `tests/e2e/specs/visitor-revoke-live.spec.js` 的 `waitShareState(page, 'unavailable')` 之后加一行:

```js
await expect(page.locator('[data-share-expires]')).toHaveCount(0)
```

第一次 `node tests/e2e/run.mjs` **这条红了**:

```
Expect "toHaveCount" with timeout 15000ms
  waiting for locator('[data-share-expires]')
    19 × locator resolved to 1 element
       - unexpected value "1"
  1 failed  ·  18 passed (1.0m)
```

**根因不是修复无效,是构建产物陈旧。** `tests/e2e/run.mjs:36-38` 只在 `mail-worker/dist/index.html` 不存在或 `SHARE_E2E_REBUILD=1` 时才重建前端,那次跑的仍是修复前的 bundle。这反过来成了 E2E 层的红灯证据。`SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs` 重建后 19/19 全绿。

> ⚠️ 留给后续:任何改了 `mail-vue/src/**` 又要跑 E2E 的任务,必须带 `SHARE_E2E_REBUILD=1`,否则 E2E 验的是上一版前端。这次是断言变红把它逼了出来;若当时只加生产代码不加断言,就会拿着一个"全绿"的假证据收工。

同文件里 T-27 留下的那段注释("showDeadShare 清了 mailbox view 但没清 expiresAt …… 记在 exec-t27-note.md 而不钉在这里")已随之改写 —— 它描述的缺陷本次已修,留着就是错误文档。除此之外未动任何其它 e2e spec。

---

## 3. i18n · 96 键

落盘位置按 recon §3.1:两文件都追加在 `shareVisitNoSubject` 之后、闭合 `}` 之前,给原末行补逗号。

**计数复核**(用 `git show HEAD:...` 取基线,import 后数 `Object.keys`):

```
baseline zh 384  en 384
after    zh 480  en 480
zh-only [] / en-only []      ← 双侧无差集
git diff --numstat: 97 1 en.js · 97 1 zh.js
```

480 − 384 = **96**,与 recon §3 的清单数一致。这个等式同时排掉了"重名键被静默覆盖"—— 对象字面量里的重复 key 只会让 `Object.keys` 少一个,数对了就说明 96 个全是新键。`shareName` / `shareRemark` 此前确实只作为 `shareNamePlaceholder` / `shareRemarkPlaceholder` 存在,不构成重复。

- 访客 10 键 en.js:**逐字照抄** recon §3.2 的 fallback,渲染结果与今天一字不差,`index.spec.js` 的语义正则断言零风险。
- 访客 10 键 zh.js:按任务书给定译文。
- 管理端 86 键 zh.js:逐字照抄 recon §3.3 的 `PENDING_COPY` 中文。
- 管理端 86 键 en.js:新写英文,守 §3.5 四条形状约束(见 §4)。

按 T29-PENDING HOLD,5 份 `PENDING_COPY` 映射**原样保留**。键补齐后 `tf()` 的 `te(key)` 恒真,映射自动退化为不可达兜底,零成本零风险。

---

## 4. en.js 的四条硬约束 · 实际取值

管理端 5 份 spec 全部以 `locale: 'en'` 挂真实 `en.js`,补键后渲染内容整体由中文兜底翻成英文。四条形状断言的实测落点:

| # | 约束(spec 锚点) | 取值 | 结果 |
|---|---|---|---|
| 1 | 四个状态标签去重后仍是 4(`share-admin/index.spec.js:187-189`) | `shareStatusLimitReached: 'Session limit reached'`,与 `Active` / `Expired` / `Revoked` 互异 | ✅ |
| 2 | 删除确认 ≠ 销毁确认(`ShareRowActions.spec.js:101-105`) | `shareDeleteConfirm` 以 `Delete this share and every record of it for good?` 开头,与 `shareRevokeConfirm`(`Destroy this share link? …`)全然不同 | ✅ |
| 3 | 移除最后一个 ≠ 普通移除;重置 ≠ 关闭(`ShareDetailDrawer.spec.js:337-354` / `:630-634`) | `shareBindingRemoveLastConfirm`(`This is the last mailbox…`)≠ `shareBindingRemoveConfirm`(`Once removed…`);`shareAuthKeyKillConfirm`(`This ends every visit that is already open, and visitors will need the new key…`)≠ `shareAuthKeyDisableConfirm`(`Turning it off means no key is needed any more…`) | ✅ |
| 4 | 掩码开关不得承诺保密(`ShareDetailDrawer.spec.js:772-783`) | 见下 | ✅ |

### 4.1 为绕开 hide-regex 而调整的措辞(唯一一处)

黑名单:label `/保密\|加密\|安全\|私密\|secret\|hidden\|hide\|private\|privacy\|secure\|protect/i`,hint `/保密\|加密\|私密\|secret\|encrypt\|privacy\|secure\|protect/i`。

- `shareShowFullAddress: 'Show the full address (display option)'` —— 自然英译本会是 "…(does not hide it elsewhere)" 之类,`hide` 直接踩 label 黑名单。改用中性的 `display option`,与中文「（展示选项）」同义。
- `shareShowFullAddressHint`:采用任务书锁定串
  `Only changes how the mailbox address is displayed on the share page. Turning it off does not change addresses that appear in the mail body, subject or sender.`
  最自然的写法("does not hide addresses in the body")会同时踩 `hide`;`displayed` / `does not change` 表达同一事实且不含任何黑名单词。

其余 84 个管理端英文键按中文原意直译,无需为正则改写措辞。附带低风险项 `shareGoAdmin: 'Go to share management'`(渲染在 `ShareDialog` 页脚,不在 `share-row` 内,`ShareDialog.spec.js:229-230` 的 `/expired/i` + `not /active/i` 不受影响)—— 实跑确认全绿。

---

## 5. 负向约束的机器复核

```
$ git grep -n SHARE_CAPABILITY_V2 -- mail-worker/wrangler.toml tests/e2e/wrangler-e2e.toml
mail-worker/wrangler.toml:58:#SHARE_CAPABILITY_V2 = "false"	#分享全能力发布栅栏(AC-LIFE-11),缺省即 false,代码把「缺失」当 false
        ← 生产仍是注释、无赋值;e2e toml 零命中(该文件本就没有这一项)

$ ls CHANGELOG.md                → absent
$ git grep -c PENDING_COPY -- 'mail-vue/src/views/**/*.vue'
  ShareDialog.vue:2 · ShareCreateWizard.vue:2 · ShareDetailDrawer.vue:2 · ShareRowActions.vue:2 · share-admin/index.vue:2   ← 5 份俱在

$ git diff --stat -- docs/architecture/ADR-mail-share-capability-boundary.md \
                     docs/specs/mailbox-share-capability/requirements.md mail-worker/
        (空)
```

---

## 6. 改动清单(9 个文件)

| # | 文件 | 改动 |
|---|---|---|
| 1 | `docs/architecture/ADR-mailbox-share-capability-extension.md` | 第 5 行 → `Accepted(2026-08-24 · …)`;`## References` 前插 `## 实施结论`(三套基线 22/252 · 18/626 · 19;**生产 V2 默认 false、能力整体冻结、激活是部署动作**;落地偏离无;仍在 Expand 双写) |
| 2 | `docs/specs/mailbox-share-capability/design.md` | front-matter `status: shipped` + `shipped_commit: 190f704`;`## Update Log` 前插 `## 已知限制与技术债`(D-1/D-2/D-3,带 file:line 锚点);Update Log 末尾 +1 行(正序) |
| 3 | `docs/specs/mailbox-share-capability/tasks.md` | 冲突热区表 i18n 唯一写者 `T-28` → `T-29.2`;Update Log 顶部 +1 行(倒序)。**checkbox 与 Status 字段未动** |
| 4 | `docs/specs/README.md` | AUTO-INDEX 中 `mailbox-share-capability` 行 `converged` → `shipped`(与 front-matter 一致,脚本重生成幂等) |
| 5 | `mail-vue/src/i18n/zh.js` | +96 键中文 |
| 6 | `mail-vue/src/i18n/en.js` | +96 键英文 |
| 7 | `README.md` | 人机验证与更多功能之间 +1 条「🔗 邮箱分享」bullet(未提 `SHARE_CAPABILITY_V2`) |
| 8 | `README-en.md` | CAPTCHA 与 More Features 之间 +1 条「🔗 Mailbox Sharing」bullet |
| 9 | `mail-vue/src/views/share/index.vue` | `clearMailboxView()` 与 `exitShare()` 各 +1 行 `expiresAt.value = ''` |

外加两份测试文件:`mail-vue/src/views/share/index.spec.js`(+2 条用例)、`tests/e2e/specs/visitor-revoke-live.spec.js`(+1 条断言,并改写一段已失效的注释)。

**T-29 三个 checkbox 未勾**;`tasks.md` 第 10 行 Status 保持协调者留下的 `in-progress · T-27/T-28 APPROVED · T-29 实现` 原样。

---

## 7. AC-ADMIN-08 的闭环证据(留给协调者填 Evidence)

按 recon §7.3,T-29 只做证据登记,不改代码。现状即满足:`mail-vue/src/views/email/ShareDialog.vue` 仍在并继续作为快捷创建入口,本次唯一新增的键是 `shareGoAdmin`(跳往管理模块的链接文案,`ShareDialog.vue:105-107` 的 `PENDING_COPY`),完整管理能力仍只在 `views/share-admin/`;`canManageShare()`(`ShareDialog.vue:115-121`)以 `share:manage` 守门。`ShareDialog.spec.js` 本轮全绿,未改一行。

## 8. 未做 / 留给后续

- `PENDING_COPY` 映射未删(T29-PENDING HOLD)。若要删,是 5 个生产 `.vue` 文件 + 5 份定点 spec 的独立任务。
- D-1 死分支 `setting.share`、D-2 Contract 停双写、D-3 复活路径配置降级 —— 三条只登记不修,已写进 design.md。
- recon §7.2 备选的 D-4 **未加**:E2E 断言已按 T29-E2E 落地,D-4 的前提(断言被推迟)不成立。
- `requirements.md` 的 Update Log 未追加(recon §2.3:本次无 AC 变更,任务书也只要求两份)。

---

## 9. 协调者独立复跑(2026-08-24)

主 AI 不采信执行者自报,在同一工作树独立重跑:

| 套件 | 命令 | 结果 |
|---|---|---|
| i18n 形状 | `node /tmp/verify-t29-i18n.mjs` | zh/en 各 480 unique、差集空、四条硬约束全过、hint 锁定串逐字匹配 |
| vue | `pnpm --dir mail-vue test -- --no-cache` | **22 files / 252 passed** |
| worker | `pnpm --dir mail-worker test -- --no-cache` | **18 files / 626 passed** |
| E2E | `SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs` | **19 passed / 0 skipped**; `visitor-revoke-live` 11.6s 绿 |

抽查:两处 `expiresAt.value = ''` 在 `index.vue:671` / `:825`;ADR Status=Accepted 且实施结论写明生产 V2 默认 false;`design.md` `status: shipped` / `shipped_commit: 190f704`;无 `CHANGELOG.md`;5 份 `PENDING_COPY` 仍在;`mail-worker/**` / 旧 ADR / `requirements.md` 零 diff;T-29 三个 checkbox 仍为 `[ ]`。

---

## 10. 审查收口(2026-08-24)

`review-t29.md` VERDICT APPROVED，p0=0 p1=0 p2=2。协调者过筛后勾选 T-29。P2-1/P2-2 随勾选提交改文档，不重开审查。
