# T-25 侦察 · 访客页多邮箱 Tab + 水位 map + 单实例轮询(W5 第二根横杠)

| 字段 | 值 |
|---|---|
| 任务 | T-25 / T-25.1 / T-25.2 / T-25.3 |
| 分支 | `cursor/mailbox-share-capability-dcb6` |
| 基线 | **HEAD `d6ecf8b`**(全部行号/断言数按 `git show HEAD:<file>` 逐条核对) |
| 工作树现状 | T-24 正在并行改动:`M index.vue` / `M index.spec.js` / `?? ShareOtpCard.vue` / `?? mail-fields.js` **均未提交**。本侦察一律不以工作树为准 |
| 性质 | 只读侦察,未改任何生产/测试文件 |

---

## 0. 一句话结论

后端 status 端点(`GET /share/mailboxes/status`)与 session 的 `shareType` / `mailboxes[]` 已全备,但 **`GET /share/mails` 并没有实现 design.md:337 承诺的 `bindingId` 参数** —— 它返回的是跨全部 Binding 归并的一条列表(每封自带 `bindingId`)。因此 T-25 的「仅当前 Tab 拉 mails」只能是**客户端过滤**,不是第二个请求维度;而 `useSharePolling.js` 本身**一行都不用改**(它早就接受注入的取数函数)。T-25 的真实工作量 = 「水位纯函数一个小文件 + index.vue 加一层 Tab 与过滤 + 组合式 tick + 测试」。

---

## 1. 可执行文件清单

### 1.1 需要写的文件(6 个,其中 2 个新建)

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `mail-vue/src/views/share/status-watermark.js` | **新建** | 水位 map 的纯函数:`readWatermarks` / `writeWatermarks` / `reconcile` / `hasNew` / `advance`。无 Vue 依赖,可单测,见 §3 |
| 2 | `mail-vue/src/views/share/index.vue` | 改 | `shareType` 分支 + 原生 Tab + `visibleMails` 过滤 + 组合式 tick,见 §2 |
| 3 | `mail-vue/src/request/share.js` | 加 **1 个导出** | `getShareMailboxesStatus({sessionToken, signal})`。HEAD `:153-176` 只有 mails/mail/attachment 三个,无 status。归属见 Fog-2 |
| 4 | `mail-vue/src/views/share/index.spec.js` | **只扩展** | HEAD 实测 **18** 条 `it()`(session shell 8 + visitor mailbox 10),正文一字不改 |
| 5 | `mail-vue/src/composables/useSharePolling.spec.js` | **只扩展** | HEAD 实测 **6** 条 `it()`。见 Fog-3:composable 零改,这里只补「注入式组合 fetcher 每 tick 恰一次」1 条 |
| 6 | `mail-vue/src/views/share/status-watermark.spec.js` | 新建 | 水位推进语义的主战场(首帧基准 / 仅消费者推进 / 增删对齐 / 脏 JSON) |

### 1.2 必须只读、零改动的文件

| 文件 | 为什么不能碰 |
|---|---|
| `mail-vue/src/composables/useSharePolling.js` | **本任务零改**,理由见 §4.1。改它是本任务最大的过度设计风险 |
| `mail-vue/src/router/index.js:69-72`(路由)/ `:157-161`(访客守卫)/ `:180-183`(afterEach 清理) | 任务负面清单显式禁止;`share-chunk.spec.js:14-16` 三条正则钉死形状 |
| `mail-vue/src/init/init.js:18-20` 正则 + `:34-36` 提前 return | `assert-share-entry.js:2-8` 断言 share 守卫必须在首个 `websiteConfig()` 之前 return |
| `mail-vue/src/views/share/assert-share-chunk.js` | 闸门本体。T-25.3 的真实内容是「跑通」不是「改闸门」,见 §6 |
| `mail-vue/src/views/share/session.js` + `session.spec.js` | `share:session:` 前缀与 `/s/<lid>#<sec>` 形态归 T-26。**水位 map 不进 session.js**,自带新文件 |
| `mail-vue/src/views/share/ShareOtpCard.vue` / `mail-fields.js` | T-24 独占。T-25 只按 §5 传 props |
| `mail-vue/src/composables/useCopyWithFallback.js` | 复制唯一实现在 ShareOtpCard,T-25 不得另起 |
| `mail-vue/src/i18n/zh.js` / `en.js` | 单写者 T-29。T-25 需要 2 个新键,**只记录不落盘**,见 §7 |
| 全部 `mail-worker/**` | 后端契约已就绪。Fog-1 的裁决若为「不改后端」,则 T-25 全程零 worker diff(可用 `git diff --stat mail-worker` 为空自证) |

### 1.3 验证命令

```
pnpm --dir mail-vue exec vitest run src/views/share/status-watermark.spec.js      # 纯函数,亚秒
pnpm --dir mail-vue exec vitest run src/views/share/index.spec.js src/composables/useSharePolling.spec.js
pnpm --dir mail-vue exec vitest run src/views/share/                              # 含 share-chunk 构建闸门(180s)
pnpm --dir mail-vue test                                                          # 全量基线
pnpm --dir mail-vue build                                                         # 生产构建
```

---

## 2. 切割线(HEAD `d6ecf8b` 实测行号)

### 2.1 `index.vue` 模板:三处切口

| 位置 | 现状 | T-25 动作 |
|---|---|---|
| `:30` `<div v-if="state === 'ready'" data-share-body>` 之后、`:31` OTP 区之前 | 无 | **插入** Tab 条(`v-if="isMulti"`)。必须在 `data-share-body` **之内**,`data-share-shell`(`:4`)之外的东西一律不动 |
| `:63` `v-if="!mails.length"` / `:74` `v-for="item in listMails"` | 直接读 `mails` / `listMails` | 改读 `visibleMails` / `visibleListMails`(§2.3)。**`data-share-empty` / `data-share-mail-list` / `data-share-mail` 三个钩子名不许改** |
| `:31-60` OTP 区 | T-24 会搬成 `<ShareOtpCard>` | T-25 只把 `:mails` 从全量换成 `visibleMails`。若 T-24 尚未落地,T-25 **不得**顺手抽卡片 |

Tab 条建议形状(新钩子,不复用 T-24 的四个):

```
<nav v-if="isMulti" class="share-tabs" data-share-tabs role="tablist" :aria-label="tx('shareVisitMailboxes', 'Mailboxes')">
  <button v-for="box in mailboxes" :key="box.bindingId"
          type="button" role="tab"
          :data-share-tab="box.bindingId"
          :aria-selected="isActiveTab(box) ? 'true' : 'false'"
          @click="selectTab(box.bindingId)">
    {{ box.address }}
    <span v-if="tabHasNew(box.bindingId)" class="share-tab-dot" data-share-tab-badge
          :aria-label="tx('shareVisitNewMail', 'New mail')"></span>
  </button>
</nav>
```

### 2.2 `index.vue` 脚本:新增的状态(4 个 ref/computed,不要更多)

| 新增 | 类型 | 说明 |
|---|---|---|
| `shareType` | `ref('single')` | 由 session 响应写入;缺省 `'single'`(旧 mock 全部不带该字段,18 条基线靠这条默认活着) |
| `mailboxes` | `ref([])` | session 响应的 `mailboxes[]`,原样存(`{bindingId, address}`) |
| `activeBinding` | `ref(null)` | 当前 Tab 的 `bindingId`。**存数字不存字符串**,与响应同型 |
| `watermarks` | `ref({})` | 水位 map 的内存镜像;每次变更整体 `writeWatermarks(lid, map)` |

`isMulti = computed(() => shareType.value === 'multi' && mailboxes.value.length > 1)`。
两个条件都要:`shareType` 是服务端派生值,`mailboxes.length` 是渲染前提,只信一个会在脏数据下渲染出一个空 tablist。

### 2.3 过滤:三个 computed 的重挂

HEAD 现状:

```
:246  const listMails   = computed(() => [...mails.value].reverse())
:248  const selectedMail= computed(() => ... mails.value ...)
:255  const featuredMail= computed(() => ... mails.value ...)   ← T-24 搬走
```

T-25 在 `mails`(`:164`)与这三者之间插一层:

```
const visibleMails = computed(() => {
    if (!isMulti.value || activeBinding.value == null) return mails.value
    return mails.value.filter((item) => item.bindingId === activeBinding.value)
})
```

然后 `listMails` / `selectedMail` 的 `mails.value` 全部换成 `visibleMails.value`,`<ShareOtpCard :mails="visibleMails">`。

**`bindingId == null` 的邮件被过滤掉是正确的**:`share-mail-service.js:73-77 resolveBindingId` 只在 account 不在 binding 集里才返回 null,那种行不该出现在任何 Tab。
**`bindingId` 可以是 `0`**:`share-auth-service.js:310-318`,无 binding 行的旧单邮箱形态以 `bindingId: 0` 呈现。所以 §3 的所有判空一律用 `== null`,**禁止 `if (bindingId)`**。这是本任务最容易埋的一颗雷(0 是合法键)。

### 2.4 切 Tab 的副作用(恰两行)

```
function selectTab(bindingId) {
    activeBinding.value = bindingId
    selectedId.value = ''          // 让 selectedMail 回落到该 Tab 最新一封
}
```

不需要 per-tab 记忆 `selectedId`(YAGNI:切回来自动选最新,与单邮箱页首屏语义一致)。水位推进**不在这里做** —— 放在 tick 里(§4.2),否则「切过去但轮询还没回来」会把尚未展示的邮件也算作已消费。

### 2.5 session 响应的读取点(与 T-24 共用同一 helper)

T-24 已在 `bootstrap`(`:531-542`)与 `reestablishSession`(`:333-343`)落 `applyShareConfig(data)` 只读 `otpExtractionEnabled`。
T-25 **扩展同一个 helper**,加读 `shareType` / `mailboxes`,并在 `mailboxes` 变化后调 `reconcile`(§3)。不许另开一处读 `data`。
`bootstrap` 开头必须把 `shareType` 重置为 `'single'`、`mailboxes` 重置为 `[]`、`activeBinding` 重置为 `null`(防跨 lid 残留),与 T24-CONFIG 裁决的 reset 同一处。

**sessionStorage 复活路径拿不到 `mailboxes`**:`bootstrap:548-553` 不调 `/share/session`。此时 `shareType` 停在 `'single'` → 不渲染 Tab,列表退化为归并全量。这是可接受的降级(刷新后仍能看全部邮件,只是没有 Tab),**不要**为它把 `mailboxes` 也塞进 sessionStorage —— 那会把掩码地址落盘,且与 T-26 的会话清理契约打架。若主 AI 认为必须有 Tab,正确解法是 T-26 的「有效 token 时不调 `/share/session`」裁决里带上一次 status 重建,不属 T-25。

---

## 3. 水位 map:键、形状与五条推进语义

### 3.1 键与形状(spec 硬约束)

| 项 | 值 | 出处 |
|---|---|---|
| 存储 | `sessionStorage` | requirements.md:145 |
| 键 | `` `share:status:${lid}` `` | tasks.md:539 / design.md:348 |
| 值 | JSON 对象 `{"<bindingId>": <watermark:number>}` | 同上 |
| watermark 语义 | 该 Binding **已消费**的最大 `emailId`;无邮件基准为 `0` | design.md:348-350 |

JSON 对象键天然是字符串,所以内存里也统一用 `String(bindingId)` 作 map 键,只在与响应比对时转回数字。**`bindingId: 0` 序列化为 `"0"`,反序列化后必须仍被当作有效键**(见 §2.3 的 0 值雷)。

建议导出面(纯函数,无 Vue,可被 `assert-share-chunk` 闭包安全爬到):

```
export const SHARE_STATUS_KEY_PREFIX = 'share:status:'
export function shareStatusKey(lid)
export function readWatermarks(lid)                  // 脏 JSON / 非对象 → {}
export function writeWatermarks(lid, map)
export function reconcile(map, statusList)           // → { map, seeded: string[] }
export function hasNew(map, bindingId, latestEmailId)
export function advance(map, bindingId, emailId)     // 单调不回退
```

### 3.2 五条推进语义(逐条对应验收)

| # | 语义 | 实现 | 验收 |
|---|---|---|---|
| 1 | **首帧建基准,该帧不渲染角标** | `reconcile`:map 无该键 → 写 `latestEmailId ?? 0`,并把该 key 放进 `seeded`;`hasNew` 对 `seeded` 内的键当帧恒为 false | AC-OTP-09「宁可少报一帧,绝不误报」 |
| 2 | **仅消费过的 Binding 推进** | 只有 `activeBinding` 且本 tick 真的取回了 mails 之后,才 `advance(map, activeBinding, latestEmailId)` | design.md:348 |
| 3 | **Binding 新增 → 建基准** | 同 1(reconcile 以响应集合为准) | requirements.md:145 |
| 4 | **Binding 删除 → 丢弃水位** | `reconcile` 只保留响应里出现的键,其余 `delete` | requirements.md:145 |
| 5 | **单调不回退** | `advance` 取 `Math.max(prev, next)`;`latestEmailId` 变小(邮件被删/滚出)不倒退水位 | 防角标闪现 |

`hasNew(map, b, latest) = latest != null && latest > (map[String(b)] ?? Infinity)`——用 `?? Infinity` 而不是 `?? 0`,可以让「键不存在」天然不报角标,省掉一次 `seeded` 判断;但 `reconcile` 仍要真的写入基准,否则下一帧还是没键。两种写法二选一,别两条都写。

### 3.3 清理归属

`share:status:<lid>` **不随离开路由清除**。理由:AC-SEC-07 点名的只有 `share:session:<lid>`(T-26 再加 `share:est-key:<lid>`),那两个是凭据;水位是「已读进度」,清掉只会让下次进入重建基准(不误报,但丢失跨会话未读)。
`bootstrap` 已有 `clearOtherShareSessions(lid)`(`:524`)按 `share:session:` 前缀清理**其他 lid**;T-25 **不要**顺手给它加 `share:status:` 前缀——那会改动 T-26 的文件与语义。若主 AI 判定水位也要按 lid 隔离清理,写进 T-26 的清理契约,不在 T-25 做。

---

## 4. status + mails 如何接入 `useSharePolling`

### 4.1 `useSharePolling.js` 零改动(本节是本任务的核心判断)

`useSharePolling.js:56-58` 的签名早就是「注入取数函数」:

```
const fetchMails = options.listShareMails || defaultListShareMails
```

`tick()`(`:131-179`)对注入函数的全部要求只有两条:接受 `{sessionToken, cursor, limit, signal}`、返回 `{list}`。它免费提供的东西,T-25 一条都不用重写:

- 429 → `parseRetryAfter` 退避后继续(`:168-171`)——AC-OTP-08 白拿
- `SHARE_UNAVAILABLE` → `notifyUnavailable` 停轮询 + 回调(`:172-175`)——AC-EDGE-03 白拿
- `document.hidden` 暂停 / 恢复即拍(`:47-49,181-191`)
- 每 tick 一个 `AbortController`,重入自动 abort 前一发(`:136-138`)
- `intervalMs` 注入位(`:58`)——T-26 的 `refreshIntervalMs` 白拿

`index.vue:235-244` 现在注入的是 `fetchMails`。T-25 只需把注入的函数换成组合版:

```
const polling = useSharePolling({
    sessionToken, limit: PAGE_LIMIT,
    listShareMails: pollTick,        // ← 唯一改动
    onMails: onPolledMails,
    onUnavailable: (err) => { void noteShareFailure(err) }
})
```

**不要**给 composable 加 `listStatus` / `onStatus` / `mode` 参数。加了就等于把「多邮箱业务」塞进一个通用定时器,而且 `useSharePolling.spec.js` 的 6 条基线要跟着长分支。

### 4.2 `pollTick` 的形状(一 tick = 1 次 status + 至多 1 次 mails)

```
async function pollTick({ sessionToken, signal }) {
    const data = await getShareMailboxesStatus({ sessionToken, signal })   // ① 恰一次
    const list = Array.isArray(data && data.mailboxes) ? data.mailboxes : []
    const { map, seeded } = reconcile(watermarks.value, list)              // ② 增删对齐 + 首帧基准
    watermarks.value = map
    writeWatermarks(currentLid(), map)
    syncMailboxesFromStatus(list)                                          // ③ AC-EDGE-04:已删邮箱下拍消失

    const head = list.find((item) => item.bindingId === activeBinding.value)
    if (!head || seeded.includes(String(head.bindingId)) || !hasNew(map, head.bindingId, head.latestEmailId)) {
        return { list: [] }                                                // 当前 Tab 无新邮件 → 不拉 mails
    }
    const page = await listShareMails({ sessionToken, limit: PAGE_LIMIT, signal })   // ④ 至多一次,无 bindingId
    watermarks.value = advance(map, head.bindingId, head.latestEmailId)     // ⑤ 消费后才推进
    writeWatermarks(currentLid(), watermarks.value)
    return page
}
```

要点:

- **④ 不传 `cursor`**。见 Fog-1:HEAD 的 mails 游标是「取更旧」语义,当作「取更新」用会静默拉不到新邮件。status 已经告诉我们有新的了,直接取最新一页 + `mergeMails`(`:205-214` 按 mailId 去重排序)即可,`rememberCursor`(`:432-440`)在轮询路径上应当停用(`beginMailbox` 的首屏补齐分页仍然用它,那条路径的 cursor 方向是对的)。
- **⑤ 在 mails 成功之后**。放前面会在 429/网络失败时错误地把邮件标成已消费。
- 抛错不接:让 429 / UNAVAILABLE 原样冒泡给 composable(`:164-178`)。`pollTick` 里**不许** try/catch 吞掉。
- `syncMailboxesFromStatus`:status 返回集合是现存 Binding 的真源。某邮箱被移除 → 从 `mailboxes.value` 剔除 + 若它是 `activeBinding` 则回落到第一个 + 从 `mails` 里滤掉它的邮件。这一条就是 AC-EDGE-04 的全部实现。

### 4.3 请求数账本(用来写断言)

| 场景 | status | mails |
|---|---|---|
| 每个 tick | **恰 1**(与 Binding 数无关) | 0 或 1 |
| 当前 Tab 无新邮件 | 1 | **0** |
| 当前 Tab 有新邮件 | 1 | 1 |
| 3 个 Binding 全有新邮件 | 1 | **1**(只拉当前 Tab) |

对比 HEAD:今天是每 tick 无条件 1 次 mails。T-25 之后总请求数**不增反降**。AC-OTP-07 的断言写法:`expect(statusMock).toHaveBeenCalledTimes(1)` + `expect(mailsMock).not.toHaveBeenCalledWith(expect.objectContaining({ bindingId: expect.anything() }))`。

---

## 5. 与 T-24 的接口(只消费,不重做)

| T-24 产物 | T-25 怎么用 | 禁止 |
|---|---|---|
| `ShareOtpCard.vue` props `mails` / `selected` / `enabled` | `:mails="visibleMails"` `:selected="selectedMail"` `:enabled="otpEnabled"` | 加 `bindingId` / `mailboxes` / `shareType` 任何 prop;让卡片自己过滤 |
| `featuredMail` 选取算法(先 selected,否则从尾向前找首个有码者) | 换入参改结果 | 改算法本体 |
| `data-share-code` / `data-share-copy` / `data-share-code-from` / `data-share-copy-result` | 不碰 | 复用这四个名字做角标 |
| `useCopyWithFallback` 唯一消费点 | 不碰 | 在 index.vue 或 Tab 里另起 `navigator.clipboard` |
| `mail-fields.js` 的 `senderLine` | Tab 若要显示发件人就 import 同一份 | 复制第三份 |
| `applyShareConfig(data)` | 扩展它读 `shareType`/`mailboxes` | 另开一处读 `data.config` |

**若 T-24 尚未 APPROVED 落地,T-25 不得提前动手** —— 两者同触 `index.vue`,tasks.md:585 已定串行。

---

## 6. 隔离守护(T-25.3)的真实内容

1. **`assert-share-chunk.js` 本体不改。** `FORBIDDEN`(`:10-15`)四条已覆盖 Dexie / `account:query` / `location.reload` / `websiteConfig`;闭包爬图(`:65-83`)在**构建产物**上跟相对 import,`@/` 别名早被 Vite 改写成相对路径,新文件天然入图。T-25 只需跑绿 `share-chunk.spec.js`,确认 `violations === []`。
2. **真正要改的是 `index.spec.js:503-512` 的 AC-VISIT-10 文本级断言。** 它只 `readFileSync('src/views/share/index.vue')`。T-24 已计划把它改成对文件数组循环;T-25 只往数组里追加 `status-watermark.js`(以及 Tab 若拆了组件的话该文件)。断言集合一字不改。若 T-24 最终没改成循环,T-25 自己改——这属「扩展」不属「改写」。
3. **`assert-share-entry.js` 零改动**,`init.js` 也零改动,所以那条基线自动保持。
4. T-25 新增的 import 只有 `vue` 与同目录相对文件 + `@/request/share.js`(已在图内)。**不许**为了 Tab 引 `element-plus` 的 `el-tabs`(tasks.md:541 显式禁止,且会把 Tabs 组件拖进匿名 chunk)。

---

## 7. UI 口径(不引新设计语言)

现页面是「GitHub 亮色工具箱」:`system-ui` 字体栈、`#d0d7de` 边框、`#f6f8fa` 底、`#0969da` 选中色、6/8px 圆角(`index.vue:571-705`)。Tab **必须落在同一套 token 里**,不得引入新字体/新主色/渐变/动效库。

必须做到的几条(都是一行成本):

- `role="tablist"` / `role="tab"` / `aria-selected`,与列表项现有的 `aria-current`(`:80`)语义区分开。
- 选中态**不能只靠颜色**:`aria-selected` + 2px 底边(复用 `#0969da`)。列表项已有先例(`:678-680` 用 `border-color`)。
- 角标**不能只靠一个色点**:`aria-label` 给读屏(需 i18n 新键),视觉上点 + 选中态即可,不要数字(status 不返回 `newCount`,数不出来,硬编也是撒谎)。
- 触控目标 ≥44px:`padding: 10px 12px` 即达标,与 `.share-list button`(`:671`)同值。
- N 个掩码地址在 375px 上会溢出:`display:flex; flex-wrap:wrap; gap:8px`。**不要**做横向滚动 + 滚动指示器,那是三倍代码换同一结果。
- 掩码地址形如 `a***@example.com`,`font-variant-numeric` 之类一律不需要。

**i18n 新键(只记录,不落盘,T-29 收口)**:`shareVisitMailboxes`(tablist 标签)、`shareVisitNewMail`(角标读屏文本)。HEAD `en.js:369-385` 现有 17 个 `shareVisit*` 键,无这两个。落地前用 `tx('key', 'English fallback')`(`:191-193`)兜底,与全页一致。

---

## 8. 基线现实校正

| 项 | 文档写的 | HEAD `d6ecf8b` 实测 |
|---|---|---|
| `GET /share/mails` 接受 `bindingId?`(multi 必带) | design.md:337 | **不接受**。`share-api.js:65-74` 只读 `cursor`/`limit`,调 `shareMailService.list` 返回跨 Binding 归并列表。`listForBinding` 只存在于 repo 层(`share-scoped-email-repository.js:149-154`),**没有任何 API 调用它** |
| 「切 Tab 拉该 Binding 的 mails」 | design.md:401 | 不可直译。归并列表每封自带 `bindingId`(`share-mail-service.js:92`),过滤是客户端行为 |
| `views/share/index.spec.js` 基线 | tasks.md:535 写 18 | **18** ✓(session shell 8:`:149/163/173/184/229/241/255/266`;visitor mailbox 10:`:300/318/345/367/380/393/431/446/467/503`) |
| `useSharePolling.spec.js` 基线 | 未写 | **6** 条 `it()`(`:65/78/90/111/127/152`) |
| status 响应形状 | design.md:336 | ✓ `{mailboxes:[{bindingId, latestEmailId, latestReceivedAt}], serverTime}`(`share-api.js:79-83` + `share-scoped-email-repository.js:187-194`) |
| session 响应形状 | design.md:335 | ✓ `{sessionToken, mailbox, shareType, mailboxes:[{bindingId,address}], expiresAt, config:{...}}`(`share-auth-service.js:392-411`) |
| `bindingId` 值域 | 未写 | **可以是 0**(旧单邮箱形态,`share-auth-service.js:313`;`toBindingKey` 刻意保留 0,`share-scoped-email-repository.js:56-59`) |

必须存活的 DOM 钩子(测试直接选中,不得改名):`[data-share-state]`、`[data-share-body]`、`[data-share-mail-list]`、`[data-share-mail]`、`[data-share-empty]`、`[data-share-wait]`、`[data-share-exit]`、`[data-share-attachment]`,以及 T-24 的四个 OTP 钩子。
T-25 新增的钩子建议:`[data-share-tabs]`、`[data-share-tab="<bindingId>"]`、`[data-share-tab-badge]`。

---

## 9. 迷雾清单(3 条,按风险降序)

**Fog-1 · `/share/mails` 没有 `bindingId`,且轮询游标方向是反的**

两个事实叠在一起,决定了 T-25 的取数形态:

(a) design.md:337 承诺的 `bindingId` 参数**没实现**(§8 第一行)。要么客户端过滤归并列表,要么 T-25 顺手改 `share-api.js` 把 `listForBinding` 接出来 —— 后者是跨域改后端、动 W2 已收口的文件、要补 worker 测试。

(b) 更麻烦:T-10 把 repo 从 `ASC + gt(emailId, cursor)` 改成 `DESC + lt(emailId, cursor)`(`git show bca7bc2^` 对比 `share-scoped-email-repository.js:131`),游标语义从「取更新」翻成「取更旧」。而 `useSharePolling.js:154-155` 仍把返回列表最后一封的 id 当成「已看到的最新」写回 `cursor`,`index.vue:432-440 rememberCursor` 也是同一假设。结果:**首屏非空的邮箱,轮询会一直往回翻旧页,新邮件永远不出现**。现存测试全部照不到 —— vue 侧 mock 了 `listShareMails`;e2e `visitor-live-delivery.spec.js:8` 明确先断言 `[data-share-empty]`(空箱起步,cursor 停在 null,恰好绕开)。

→ **建议裁决**:两条都用「status 驱动 + 客户端过滤」一次解决,零后端改动。当前 Tab 有新邮件时**不带 cursor** 拉最新一页,`mergeMails` 去重(`:205-214` 已按 mailId 建 Map);`rememberCursor` 只保留在 `beginMailbox` 的首屏补齐路径。这样 (a) 不需要后端参数,(b) 的错误游标在轮询路径上被绕过。
→ 若主 AI 判定 (b) 是必须独立记账的回归,建议**单开一条修复任务**(它影响的是单邮箱页的既有行为,不是多邮箱新功能),T-25 仍按上述形态实现。
→ 若主 AI 反而要求接出 `bindingId` 参数:那是后端 + 前端两处改动,且与「一 tick 一次 mails」不冲突但会让 §4.2 的 ④ 多带一个参数;T-25 范围会明显变大,须先扩派单。

**Fog-2 · status 请求函数落在 `request/share.js`,但那是 T-26 的文件**

`recon-t24-otp-card.md` §1.2 与 session-ledger:176 都把 `request/share.js` 记在「T-25/T-26」名下,tasks.md:549 却把「`request/share.js` 加 status 函数」写进 **T-26.2**。而 T-25.2 又要求「`useSharePolling` 扩展为拉 status」—— 没有请求函数就拉不动。

→ **建议裁决**:T-25 写这一个导出 `getShareMailboxesStatus({sessionToken, signal})`(约 6 行,与 `listShareMails` `:153-159` 同构),T-26 只在同文件加 `Idempotency-Key` 头透传。两者本就串行(tasks.md:585),不构成并发冲突;把 tasks.md:549 的「加 status 函数」划给 T-25 即可。
→ 反向方案(T-25 自己在 `views/share/` 下另写一个 axios 调用)会造出第二个 share HTTP 客户端,绕开 `shareHttp` 的 429 拦截器(`:139-147`),直接违反 AC-OTP-08。**不要选。**

**Fog-3 · `useSharePolling.js` 到底改不改,T-25.1 的 spec 落在哪**

tasks.md:539 要求扩展 `useSharePolling.spec.js`,tasks.md:541 要求「`useSharePolling.js` 扩展为拉 status」。但 §4.1 论证了 composable 零改即可满足全部验收 —— 「扩展」的其实是**注入进去的函数**,不是 composable 本身。

→ **建议裁决**:`useSharePolling.js` 零改。水位推进语义(首帧基准 / 仅消费者推进 / 增删对齐 / 单调 / 脏 JSON)全部落 `status-watermark.spec.js`(纯函数,亚秒级,覆盖率最高);`useSharePolling.spec.js` 只加 **1 条**:注入一个「内部先调 status 再条件调 mails」的 fetcher,断言每 tick status 恰 1 次、无新邮件时 mails 0 次;「每 tick 恰一次 status 无 N 路并发」的端到端版本放 `index.spec.js`(那里有真实组件与 mock 请求层)。
→ 若主 AI 坚持 composable 内置 status:代价是 6 条基线要跟着长分支、429/abort 两条路径各自多一个分支组合,且 composable 从「通用轮询器」退化成「share 多邮箱专用」。**不建议。**

---

## 10. T-26 / 其他任务不得从 T-25 偷走的东西

### T-25 独占、后续只能消费

1. **`share:status:<lid>` 键、`{bindingId: watermark}` 值形状、`status-watermark.js` 的五条推进语义。** T-26 做会话清理时**不得**顺手清这个键(§3.3),更不得改键名或把它塞进 `session.js`。
2. **`getShareMailboxesStatus` 的签名与「每 tick 恰一次」的调用点。** T-26 只许在 `request/share.js` 加 `Idempotency-Key` 头透传、在 `useSharePolling` 注入 `intervalMs`;不许再加第二处 status 调用,不许改回 N 路。
3. **`pollTick` 组合形态(status → 本地比较 → 条件拉 mails)。** T-26 的 `auto_refresh=false` 手动刷新按钮**必须复用同一个 `pollTick`**,不得另写一条取数路径 —— 两条路径就是两套水位推进语义。
4. **`shareType` / `mailboxes[]` 的读取点**:并入 T-24 的 `applyShareConfig(data)`。T-26 读 `autoRefresh` / `refreshIntervalMs` / `expiresAt` 时**扩展同一个 helper**,不许另开。
5. **`visibleMails` 过滤 + 切 Tab 清 `selectedId`** 的语义。T-26 的 `authRequired` 态在 `state !== 'ready'` 分支,天然不碰这层。
6. **`data-share-tabs` / `data-share-tab` / `data-share-tab-badge` 三个钩子。** T-26 的倒计时与手动刷新按钮用自己的新 `data-*`,不许复用。

### T-25 不得抢的(留给下游)

- **T-24**:`ShareOtpCard.vue` 与 `mail-fields.js` 的存在与签名、`featuredMail` 算法、复制路径、四个 OTP `data-*` 钩子、`config.otpExtractionEnabled` 的读取。T-24 未 APPROVED 前 T-25 不动 `index.vue`。
- **T-26**:`authRequired` 状态节点(`index.vue:160` 状态机加节点)、`Idempotency-Key` 与 `share:est-key:<lid>`、`refreshIntervalMs` 注入、`auto_refresh=false` 的手动刷新按钮、`expiresAt` 倒计时、离开路由的会话清理扩展、`session.spec.js`。T-25 读 session 响应时**只取 `shareType` / `mailboxes`**,不顺手接 `autoRefresh` / `expiresAt`。
- **T-29**:`i18n/zh.js` / `en.js` 任何落盘(§7 的两个新键只记录)。

### 三方共同禁区

`router/index.js` 的 share 路由与访客守卫、`init/init.js` 的 share 正则与提前 return、`/s/<lid>#<sec>` 路径形态、`session.js` 的 `share:session:` 键前缀、`data-share-shell="cloud-mail-share-shell"` 标记(`index.vue:4`)、`assert-share-chunk.js` 的 `FORBIDDEN` 四条 —— 任何波次都不许动。禁入 share chunk 的依赖(登录态 axios / layout / Dexie / websiteConfig / `el-tabs`)在 T-25 里不会引入:新代码只依赖 `vue`、`@/request/share.js` 与同目录相对文件。

---

## 11. 主 AI 迷雾裁决（2026-08-24 · 独立核对 API / 游标 / 0 值后）

现场核对（不以 T-24 工作树为准）：

- `share-api.js:65-74` 只读 `cursor`/`limit`，调 `shareMailService.list`；`listForBinding` 仅 repo 层，**服务层也没有包装**（`share-mail-service.js:163-175`）。
- 列表 SQL 确是 `DESC + lt(cursor)`（`share-scoped-email-repository.js:131-133`）。`beginMailbox` 的补页方向与此一致（取更旧）。`useSharePolling` 把本页最后一行当下一拍 cursor，在非空箱上等于持续翻旧页，**新邮件不进轮询路径**。e2e 从空箱起步所以照不到。
- design.md:337 / :348 已写：`bindingId?`（multi 必带）+ 水位推进到**已拉取的最大 email_id**，不是 status 的 `latestEmailId`。
- 否证「零后端 + 不带 cursor 拉全局最新一页」：多 Binding 时全局 `limit=50` 会挤掉安静邮箱的新信；若再按 status `latestEmailId` 推进水位，角标消失且邮件永不出现。

| ID | 裁决 | 落点 |
|---|---|---|
| Fog-1 | **CHANGE（否决零后端）** | 接线已存在的 `listForBinding`：`share-mail-service` 加同构包装；`GET /share/mails` 在 `bindingId` 缺省时仍走归并 `list`（保旧客户端），有值时走 `listForBinding`。`pollTick` **不传 cursor**，传当前 `activeBinding`（含 `0`）。水位按 design 推进到**本页实际最大 mailId**，页面未包含 `latestEmailId` 则不推进、下拍重试。不单开游标回归任务：T-25 的 status 门 + 无 cursor 拉最新页就是单邮箱 live-delivery 的修复。 |
| T25-TAB-LOAD | **CHANGE** | 首帧 `reconcile` 会给未看过的 Tab 建基准 → `hasNew=false`。`selectTab` 若该 Binding 在 `mails` 里还没有行，必须立刻 `listForBinding` 一次，不能等轮询。 |
| T25-ACTIVE-0 | **CHANGE** | 单邮箱也要把 `activeBinding` 设成 `mailboxes[0].bindingId`（可为 `0`），只是不渲染 Tab。`pollTick` 在 `activeBinding == null` 时不得直接 `{list:[]}` 停刷。判空一律 `== null`。 |
| Fog-2 | **CHANGE** | `getShareMailboxesStatus` 与 `listShareMails` 的可选 `bindingId` 都由 **T-25** 写进 `request/share.js`。T-26 同文件只加 `Idempotency-Key`。禁止在 `views/share/` 另起 axios。 |
| Fog-3 | **CHANGE** | `useSharePolling.js` **零改**。水位语义进 `status-watermark.spec.js`；composable spec 只加 1 条注入式 tick 断言；N 路并发的端到端断言进 `index.spec.js`。 |
| T25-WAIT-T24 | **HOLD** | T-24 未 APPROVED 前 **不派 T-25 实现**，不同触 `index.vue`。 |
