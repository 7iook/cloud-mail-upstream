# T-25 执行笔记 · 访客多信箱 Tab + 水位 + 单次轮询

| 字段 | 值 |
|---|---|
| 任务 | T-25 访客页多信箱原生 Tab、未读水位徽标、每 tick「1 status + 1 mails」 |
| 分支 | `cursor/mailbox-share-capability-dcb6`(未 commit / push / stash / 切分支;未 `git add`) |
| 派单 | `prompt.t25.exec.txt` |
| 侦察+裁决 | `recon-t25-tabs.md`(先读 §11。§0「只能客户端过滤、零后端」按派单被 Fog-1 CHANGE 取代,未重开) |
| 前置阅读 | frontend-design / impeccable / ui-ux-pro-max / ponytail(lite) 四份 SKILL.md 已读。按派单「在既有 GitHub-light toolbox token 内做原生 Tab」执行:零 `el-tabs`、零新调色板、零动效库,Tab 用的 `#d0d7de` / `#0969da` / `#1f2328` / `#f6f8fa` / `#4b5563` 全部是本文件既有色值 |

---

## 1. 落盘文件(9 改 + 2 新,与派单可写清单一致)

| 文件 | 动作 | 行数变化 |
|---|---|---|
| `mail-worker/src/service/share-mail-service.js` | 改 | +46 / −9 |
| `mail-worker/src/api/share-api.js` | 改 | +5 / −1 |
| `mail-worker/test/share-api.spec.js` | 只扩展 | +137 / −0 |
| `mail-worker/test/share-mail-service.spec.js` | 只扩展 | +69 / −0 |
| `mail-vue/src/request/share.js` | 改 | +15 / −3 |
| `mail-vue/src/request/share.spec.js` | 只扩展 | +53 / −0 |
| `mail-vue/src/views/share/status-watermark.js` | 新建 | +108(5 个导出纯函数) |
| `mail-vue/src/views/share/status-watermark.spec.js` | 新建 | +170(15 个 `it()`) |
| `mail-vue/src/views/share/index.vue` | 改 | +323 / −66 |
| `mail-vue/src/views/share/index.spec.js` | 只扩展 | +344 / −4 |
| `mail-vue/src/composables/useSharePolling.spec.js` | 只扩展 | +32 / −0 |

**未触碰(逐条对应派单 negative)**:`router/index.js` 访客守卫、`init/init.js` 正则、`/s/<lid>#<sec>` 形状、`views/share/session.js`、`i18n/zh.js` / `i18n/en.js`(两个新文案走 `tx(key, fallback)` 兜底,零新键)、`ShareOtpCard.vue`(props 仍是 `mails/selected/enabled`,无 `bindingId`)、`assert-share-chunk.js` 闸门体。

**`useSharePolling.js` 生产源零编辑**:

```
$ git diff --stat mail-vue/src/composables/useSharePolling.js
(空)
```

---

## 2. 测试计数

| 口径 | 命令(全部 `--no-cache`) | 结果 |
|---|---|---|
| worker 定向 | `vitest run --no-cache test/share-api.spec.js test/share-mail-service.spec.js` | **38 passed**(12 + 26) |
| vue 定向四套 | `vitest run --no-cache index.spec.js status-watermark.spec.js request/share.spec.js useSharePolling.spec.js` | **64 passed** |
| 隔离闸门 | `vitest run --no-cache src/views/share/share-chunk.spec.js` | **1 passed** |
| vue 全量 | `pnpm --dir mail-vue test -- --no-cache` | **22 files · 218 passed** |
| worker 全量 | `pnpm --dir mail-worker test -- --no-cache` | **18 files · 626 passed** |
| e2e(未改动,回归确认) | `playwright test` | **13 passed** |

前后对比:

| spec | 前 | 后 | 增 |
|---|---|---|---|
| `mail-vue/src/views/share/index.spec.js` | 22 | 32 | +10 |
| `mail-vue/src/views/share/status-watermark.spec.js` | — | 15 | +15(新) |
| `mail-vue/src/request/share.spec.js` | 7 | 10 | +3 |
| `mail-vue/src/composables/useSharePolling.spec.js` | 6 | 7 | +1 |
| `mail-worker/test/share-api.spec.js` | 8 | 12 | +4 |
| `mail-worker/test/share-mail-service.spec.js` | 23 | 26 | +3 |

全量:mail-vue 189 → 218(+29,即 10+15+3+1);mail-worker 619 → 626(+7,即 4+3)。

### 2.1 TDD 顺序(worker 红在先,未倒置)

1. **worker 红**:先只写 `GET /share/mails?bindingId=<A>` 那条,跑出 `expected 1 to be 2`(带 bindingId 仍返回合并列表),再动 `share-api.js` / `share-mail-service.js`。
2. **vue 红**:`request/share.spec.js` 红在 `getShareMailboxesStatus is not a function`;`status-watermark.spec.js` 红在 `Cannot find module './status-watermark.js'`;`index.spec.js` 新块红在无 `[data-share-tabs]`。三处红都是**缺行为/缺模块**红,不是断言写错。
3. 再实现,最后跑全量。

### 2.2 旧 22 条的改动边界

22 条正文一字未改。`index.spec.js` 的 4 行删除全部是许可范围:3 行是 `vi.hoisted` mock 对象加 `getShareMailboxesStatus` 造成的行重排(派单第 62 行明确要求加),1 行是 AC-VISIT-10 的文件循环数组追加 `status-watermark.js`(派单「AC-VISIT-10 loop may append」)。两个 `beforeEach` 都加了默认 `{ mailboxes: [{ bindingId: 0, latestEmailId: null }] }`。

---

## 3. 实现要点(逐条对齐 Fog 裁决)

| 裁决 | 落地 |
|---|---|
| **Fog-1**(接 `listForBinding`) | `share-api.js` 用 `query.bindingId == null \|\| query.bindingId === ''` 判空:无 bindingId 走原 `list()` 合并列表(T-25 之前的客户端不受影响),有 bindingId(含 `"0"`)走 `listForBinding()`。`pollTick` **不传 cursor**。水位推进用**返回页里真实存在的最大 mailId**(`advanceFromPage`),不是 `status.latestEmailId`。 |
| **T25-TAB-LOAD** | `selectTab` 切过去后,若 `mails` 里没有该 binding 的行,立刻发一次 `fetchMails({ bindingId })`,不等下一个 tick。 |
| **T25-ACTIVE-0** | `applyShareConfig` → `setMailboxes(data.mailboxes)` → `pickActiveBinding()`,单信箱也会把 `activeBinding` 设成 `mailboxes[0].bindingId`(可能是 `0`)。全文件零 `if (bindingId)` 真值判断,一律 `== null`。`pollTick` 在 `activeBinding` 为 null 时把 `bindingId: null` 交给 `listParams`,后者丢掉该参数 → 退化成不带 bindingId 的合并 `list()`,**不会**因此返回 `{list: []}`。 |
| **Fog-2** | `getShareMailboxesStatus` 就写在 `request/share.js`,复用同一个 `shareHttp`;`listShareMails` 经 `listParams` 拿到可选 `bindingId`。**零第二个 axios 实例**。 |
| **Fog-3** | `useSharePolling.js` 生产源零编辑(diff 为空);水位测试独立在 `status-watermark.spec.js`;composable spec 只 +1 条注入式 fetcher 测试;N-way 断言在 `index.spec.js`。 |
| **T25-ALWAYS-FETCH** | `pollTick` = 1 次 status + 1 次 mails(active binding,无 cursor)。`!hasNew` **不跳过** mails 调用——水位只驱动徽标。 |
| **bindingId 0 有效 / 不泄露存在性** | `narrowToBinding` 只接受 `Number.isSafeInteger(id) && id >= 0`;未知/异形/他人 binding 一律返回 `[]` 而非报错。 |

### 3.1 `bindingId=0` 的一处刻意绕行(已在源码注释里写明)

`share-scoped-email-repository.js` 的 `listForBinding` 内部用 `resolveRowId`,它把 `0` 映射成 `null`(真实行 id 不会是 0)。所以服务层按 id 分流:

- `bindingId > 0` → `repo.listForBinding(c, scoped, bindingId, ...)`(裁决要求的「接 listForBinding」)
- `bindingId === 0` → `repo.list(c, scoped, ...)`,其中 `scoped` 是**已经窄化到该 binding 的 ctx**

两条路径读的是同一个 `VisibleWindow ∩ latest-N`,scope 等价,只是 0 这条不经过 `resolveRowId`。没有改 repository(不在可写清单内)。

### 3.2 水位语义(`status-watermark.js`,5 个纯函数)

存储在 `share:status:<lid>`,与 `share:session:<lid>` **分开**——阅读进度不是凭证,退出不清。

- `reconcile(map, statusList)`:首帧把每个 binding 的当前 head 作为基线种下并回报 `seeded`,所以**开页那一刻不会因为历史积压而满屏徽标**;status 里消失的 binding 连水位一起丢。
- `hasNew(map, id, latest)`:未知 key 读作 `Infinity` 而非 `0`,即「还没有基线的 binding 这一帧保持安静」。
- `advance(map, id, mailId)`:`Math.max`,单调不回退。
- key 一律 `String(id)`(JSON 对象键本就是字符串),空判一律 `== null`,因为 `0` 是合法 binding。

### 3.3 Tab 的 UI 决策

原生 `<nav role="tablist">` + `<button role="tab">`,`aria-selected` / `aria-controls` / roving `tabindex`(选中 0、其余 -1)/ ← → 键切换并移焦点。选中态是**字重 600 + 2px 底边线**,不只靠颜色(WCAG 1.4.1)。徽标是 8px `#0969da` 圆点,带 `role="img"` + `aria-label`,不是纯装饰。`isMulti` 要求 `shareType === 'multi'` **且** `mailboxes.length > 1` 两个条件,脏数据不会渲染出空 tablist。

### 3.4 顺手修掉的一个真实 bug

E2E 录像里看到:在 A Tab 点「复制」出现 Copied 确认后切到 B Tab,确认文案仍挂在 B 的卡片上(等于对着 B 的验证码谎称已复制)。修法是给 `ShareOtpCard` 加 `:key="activeBinding"`,切 Tab 即重挂载,子组件内的 `copyResult` 自然归零 —— 没有给卡片加 prop,守住了「ShareOtpCard props 不变」这条 negative。`index.spec.js` 里有一条测试钉住它。

---

## 4. 真浏览器证据(`t25_e2e_browser_evidence.log` + 截图/录像)

本地 wrangler worker + 构建后的 SPA,第二个 Binding 行用与 worker 单测相同的方式写库,其余全是真实链路。日志实测:

```
tabs      [ 'e***@example.com', 's***@example.com' ]
watermarks after seeding frame {"365":322,"366":323}   ← 首帧只种基线,零徽标
injected  {"emailId":324,...,"accountId":9}            ← 往兄弟信箱投一封新信
badged    [ 's***@example.com' ]                       ← 只有兄弟 Tab 亮点
requests since new mail [
  '/api/share/mailboxes/status', '/api/share/mails?limit=50&bindingId=365',
  '/api/share/mailboxes/status', '/api/share/mails?limit=50&bindingId=365'
]                                                       ← 每 tick 恰好 1+1,且只打 active
after switch code  ...991122...                        ← 切过去立刻看到新码
badges left 0
```

录像里的逐 tick 账本同样是 `tick = status + mails(active)`,点 Tab 时额外一次 `mails(348)` 即 T25-TAB-LOAD 的立即拉取,之后 active 变成 348、tick 跟着切过去。

| 证据文件 | 内容 |
|---|---|
| `t25_final_verification.log` | 五条 verify 命令(全 `--no-cache`)+ `useSharePolling.js` 空 diff |
| `t25_e2e_browser_evidence.log` | 真浏览器走查日志 + 逐 tick 请求账本 + e2e 13 绿 |
| `share_tabs_first_mailbox.png` | 多信箱首屏:两个掩码 Tab,首帧无徽标 |
| `share_tabs_sibling_badge.png` | 兄弟 Tab 收到新信后亮点,active 不亮 |
| `share_tabs_second_mailbox.png` | 切到兄弟 Tab:新码在位、徽标清零 |
| `share_visitor_multi_mailbox_walkthrough.mp4` | 端到端走查录像 |

---

## 5. 遗留风险

1. **`mailbox` 头部在多信箱下仍显示 session 返回的单个地址**。这是 T-25 之前就有的渲染,不在本任务可写范围的语义内,`index.spec.js` 的断言因此收敛到 `[data-share-tabs]` 区域内判定「不出现明文地址」。多信箱页顶部该显示什么(share 名称?N 个信箱?)建议在 T-26 连同 `expiresAt` / `autoRefresh` 的头部信息一起定。

2. **sessionStorage 复活路径拿不到 `mailboxes`**。与 T-24 记录的 `otpEnabled` 同一条路径:走 `readShareSession(lid)` 分支时不调 `/share/session`,`mailboxes` 初始为空 → `isMulti` 为 false → 首帧无 Tab。但第一个 tick 的 status 会通过 `syncMailboxesFromStatus` 把 Tab 补出来,只是**地址列缺失,退化显示 `***`**(masked 地址只随 session 响应下发)。不是功能缺失,是刷新后一瞬的降级标签。T-26 若给复活路径补一次 config 拉取,这条一并消失。

3. **`syncMailboxesFromStatus` 在 status 返回空数组时选择「不动」**。空 `mailboxes` 更可能是后端瞬时异常而非「所有信箱都被删了」,清空会让页面突然无 Tab。代价是真删到零时要等到下一次 session 重建才反映。AC-EDGE-04 要求的「掉一个 binding」场景(非空但少一项)是精确处理的:掉 Tab、掉它的 mail 行、掉水位、active 回落到第一个。

4. **水位不设上限清理**。`share:status:<lid>` 每个 lid 一条,sessionStorage 随标签页结束即散,未做 LRU。访客在一个标签页里连开几十个不同 share 才可能堆积,量级上不构成问题。

5. **`beginMailbox` 的补页循环现在按 active binding 补**。首屏只补 active 那个信箱的历史页,兄弟 Tab 的历史在点过去时由 T25-TAB-LOAD 拉第一页(50 条,不再往前翻)。也就是说**兄弟 Tab 只保证最近 50 条,active Tab 才有完整补页**。这符合「每 tick 至多 1 次 mails」的成本约束,但如果 T-26 要给兄弟 Tab 也做无限上滑,需要给 `selectTab` 接上同样的 cursor 循环。
