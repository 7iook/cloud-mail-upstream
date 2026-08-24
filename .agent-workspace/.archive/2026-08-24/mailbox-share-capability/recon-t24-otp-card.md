# T-24 侦察 · ShareOtpCard 抽取(W5 第一根横杠)

| 字段 | 值 |
|---|---|
| 任务 | T-24 / T-24.1 `ShareOtpCard` 组件抽取 |
| 分支 | `cursor/mailbox-share-capability-dcb6` |
| HEAD | `1edca2d`(W4 收口后,T-20..T-23 APPROVED) |
| 性质 | 只读侦察,未改任何生产/测试文件 |
| 行号基准 | 全部行号按本次 HEAD 现场核对,**不沿用 recon-t22** |

---

## 0. 一句话结论

后端契约已经全备(`config.otpExtractionEnabled` 在 `/share/session` 响应里、`code` 键在关闭时整键消失),前端 `index.vue` **至今一个字都没读 `config`**。T-24 的真实工作量 = 「搬 4 段代码 + 补 1 条 config 读取 + 补测试」,不是「新建一个组件文件」。抽取本身零行为变更是可达的,唯一必须新增的行为是 `otpExtractionEnabled=false` 整区不渲染。

---

## 1. 可执行文件清单

### 1.1 需要写的文件(仅这 5 个)

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `mail-vue/src/views/share/ShareOtpCard.vue` | **新建** | 承接 featuredMail 选取 + 复制 + 降级 + OTP 区样式 |
| 2 | `mail-vue/src/views/share/mail-fields.js` | **新建**(推荐) | 只导出 `senderLine`;父子共用,见 §3.3 |
| 3 | `mail-vue/src/views/share/index.vue` | 改 | 删除搬走的段落 + 接 `config.otpExtractionEnabled` |
| 4 | `mail-vue/src/views/share/index.spec.js` | **只扩展** | 现有 18 条 `it()` 一字不改,新增 otp 开关/空 code 两类 |
| 5 | `mail-vue/src/views/share/ShareOtpCard.spec.js` | 新建(可选) | 若把新断言全放 4,则本文件不必存在 |

### 1.2 必须只读、零改动的文件

| 文件 | 为什么不能碰 |
|---|---|
| `mail-vue/src/router/index.js:69-72`(路由)、`:157-161`(访客守卫)、`:180-183`(afterEach 清理) | 任务负面清单显式禁止;`share-chunk.spec.js:14-16` 正则钉死这三行形状 |
| `mail-vue/src/init/init.js:18-20` `isAnonymousShareVisit` 正则 + `:34-36` 提前 return | `assert-share-entry.js:2-8` 断言 share 守卫必须在首个 `websiteConfig()` 之前 return |
| `mail-vue/src/views/share/session.js` | `share:session:<lid>` 键与 `/s/<lid>#<sec>` 路径形态归 T-26 |
| `mail-vue/src/views/share/assert-share-chunk.js` | 隔离闸门本体。T-25.3 才扩展它;T-24 若被它红了,改 import 不改闸门 |
| `mail-vue/src/composables/useCopyWithFallback.js` | 复制降级已完备(`copy()` 返回 `{copied, path, text, selectableEl}`),直接消费,零改 |
| `mail-vue/src/composables/useSharePolling.js` | 归 T-25(status 拉取)/ T-26(`intervalMs` 注入) |
| `mail-vue/src/request/share.js` | 归 T-26(status 函数 + `Idempotency-Key`) |
| `mail-vue/src/i18n/zh.js` / `en.js` | i18n 单写者是 T-29。T-24 **不需要任何新键**,见 §5.3 |
| 全部 `mail-worker/**` | 后端契约已就绪,T-24 纯前端 |

### 1.3 验证命令

```
pnpm --dir mail-vue exec vitest run src/views/share/index.spec.js          # 定点,秒级
pnpm --dir mail-vue exec vitest run src/views/share/                       # 含 share-chunk 构建闸门(180s)
pnpm --dir mail-vue test                                                   # 全量基线
pnpm --dir mail-vue build                                                  # 生产构建
```

---

## 2. 抽取切割线(HEAD `1edca2d` 实测行号)

### 2.1 搬走 → `ShareOtpCard.vue`

| 现址 | 行数 | 内容 | 落点 |
|---|---|---|---|
| `index.vue:31-60` | 30 | `<section v-if="featuredMail" class="share-otp" data-share-code>` 整段(含 `data-share-copy` 按钮、`data-share-code-from`、`.share-otp-select` 隐形 input、`data-share-copy-result`) | 子组件 `<template>` 根 |
| `index.vue:132` | 1 | `import { useCopyWithFallback } from '@/composables/useCopyWithFallback.js'` | 子组件 |
| `index.vue:158` | 1 | `const { copy, selectableRef } = useCopyWithFallback()` | 子组件 |
| `index.vue:167` | 1 | `const copyResult = ref('')` | 子组件 |
| `index.vue:170-172` | 3 | `hasShareCode(code)` | 子组件(唯一调用者是 featuredMail) |
| `index.vue:255-266` | 12 | `const featuredMail = computed(...)` | 子组件 |
| `index.vue:275-277` | 3 | `bindSelectable(el)` | 子组件 |
| `index.vue:479-491` | 13 | `async function copyFeaturedCode()` | 子组件(**`typeof ElMessage === 'function'` 守卫逐字保留**,见 §4.2) |
| `index.vue:608-658` | 51 | `.share-otp` / `.share-otp-label` / `.share-otp-row` / `.share-otp-value` / `.share-otp-select` / `.share-otp-select.is-visible` | 子组件 `<style scoped>` |
| `index.vue:595` | 1 | 共享规则里的 `.share-otp-row button,` 这一行选择器 | 拆到子组件(见 §4.1) |

搬移合计:模板 30 行 + 脚本 34 行 + 样式 52 行。

### 2.2 从 `index.vue` 净删除(不搬)

| 行 | 内容 | 理由 |
|---|---|---|
| `:306` | `copyResult.value = ''`(在 `clearMailboxView`) | 状态随子组件走,父级引用会变成未定义 |
| `:419` | `copyResult.value = ''`(在 `exitShare`) | 同上 |
| `:429` | `copyResult.value = ''`(在 `resetMailbox`) | 同上 |

**为什么不需要把重置动作接回子组件**:这 3 处的调用者最终都会让 `state !== 'ready'` —— `clearMailboxView` 只被 `showDeadShare`(`state='unavailable'`)与 `showTimedOut`(`state='timedout'`)调用;`exitShare` 置 `'exited'`;`resetMailbox` 只被 `bootstrap` 调用而 `bootstrap:518` 同步就把 `state` 置 `'loading'`。而模板 `:30` 的 `v-if="state === 'ready'"` 包住整个 body,子组件被真卸载,内部 `copyResult` 自然归零,且中间不会有一次带旧值的重渲染(Vue 渲染在同 tick 内不插队)。→ 不需要 `defineExpose({reset})`,不需要 `v-model:copyResult`,不需要 emit。这是本任务最容易被过度设计的一处。**但它是 Fog-1,必须由一条测试钉住**。

### 2.3 新增到 `index.vue`(唯一新行为)

```
bootstrap()   :531-542  createShareSession 成功分支 → 读 data.config?.otpExtractionEnabled
reestablish() :333-343  同一条读取(否则重建会话后开关丢失)
```

建议只落一个单行 helper(例如 `applyShareConfig(data)`),把 `otpEnabled` 一个 ref 写掉。理由见 §5.2:T-26 要在同一位置再读 `autoRefresh` / `refreshIntervalMs`,留一个可扩展点比让 T-26 重写 bootstrap 便宜。

**默认值必须是 `true`,这是硬约束**:现有 18 条测试的 `createShareSession.mockResolvedValue({ sessionToken, mailbox })` 全部不带 `config`,其中 `:318`、`:345`、`:446` 三条明确期望 `[data-share-code]` 渲染。`config` 缺失 → 视为开启。安全性不受影响,因为真正的权威是后端:`share-mail-service.js:105` 在关闭时把 `code` 整键删掉,前端就算默认 true 也拿不到码。同理 `bootstrap:548-553` 的 sessionStorage 复活路径根本不调 `/share/session`、拿不到 `config`,也只能靠这条默认值 + 后端裁剪活着。

### 2.4 子组件建议签名(不要多给)

```
props: mails    Array   —— 已按当前 Tab 过滤过的列表(T-25 负责过滤,T-24 直接给全量)
       selected Object|null —— 父级 selectedMail.value
       enabled  Boolean —— 默认 true;false 时整区不渲染
emits: 无
```

`featuredMail` 在子组件内由 `props.selected` + `props.mails` 算出,与 `:255-266` 逐字同构。**不要**加 `bindingId` / `mailboxes` / `shareType` 任何多邮箱概念的 prop —— 那是 T-25 的地盘,T-24 提前塞进去就是替 T-25 猜形状。

---

## 3. 必须留在 `index.vue` 的东西

### 3.1 结构性(动了就破闸门)

| 位置 | 内容 | 谁在钉 |
|---|---|---|
| `:4` | `data-share-shell="cloud-mail-share-shell"` | `assert-share-chunk.js:8` 的 `MARKER` 靠它定位 share chunk 入口,再顺相对 import 爬全图。**绝不能挪进子组件** |
| `:30` | `<div v-if="state === 'ready'" data-share-body>` | `index.spec.js:314` |
| `:123` | `<div v-else data-share-body></div>` | 同上 |
| `:5` | `:data-share-state="state"` | 18 条测试里 12 条读它 |
| `:565-568` | `defineExpose({ noteShareFailure, exitShare })` | `index.spec.js:245` 直接 `wrapper.vm.noteShareFailure(...)` |

### 3.2 逻辑性(与 OTP 卡片无关,原地不动)

- 状态机与会话:`:160-166`(去掉 167 的 `copyResult`)、`:201-203 currentLid`、`:292-294 hadWorkingSession`
- 列表与选中:`:174-176 mailKey`、`:187-189 hasHtml`、`:205-214 mergeMails`、`:246 listMails`、`:248-253 selectedMail`、`:270-273 isSelected`
- 拉取与轮询:`:216-228 fetchMails`、`:230-233 onPolledMails`、`:235-244 polling`、`:432-440 rememberCursor`、`:442-477 beginMailbox`
- 失败恢复全链:`:279-290 logShareFailure`、`:296-307 clearMailboxView`、`:309-316 showDeadShare`、`:318-325 showTimedOut`、`:327-344 reestablishSession`、`:346-397 recoverFromUnavailable`、`:399-404 noteShareFailure`、`:406-421 exitShare`、`:423-430 resetMailbox`
- 入口:`:514-556 bootstrap`、`:558 watch`、`:560-563 onUnmounted`
- 正文与附件:`:89-121` 详情区、`:95-99` `SafeMailRenderer`、`:493-512 downloadAttachment`
- i18n 本地化:`:191-193 tx`、`:195-199 applyShareLocale`

### 3.3 `senderLine`(`:178-185`)—— 唯一的父子共用函数

三个调用点:`:47`(OTP 区,要搬走)、`:84`(列表项)、`:93`(详情头)。

- **推荐**:抽到 `mail-vue/src/views/share/mail-fields.js`,父子各 import 一行。相对同目录 import,`assert-share-chunk.js:68-77` 能正常爬进图,不引入任何禁忌依赖;而且 T-25 的 Tab 组件几乎肯定还要用它。
- **更懒的替代**:在子组件里复制这 8 行,不新建文件。差异是 8 行重复 vs 1 个新文件。若执行者选这条,请在 T-24 笔记里留一句,别让 T-25 再复制第三份。

`tx`(`:191-193`)同理,但只有 3 行且依赖 `useI18n()` 实例 —— 子组件自己 `const { t, te } = useI18n()` 再写 3 行 `tx` 即可,测试挂载时 i18n 是 `global.plugins` 注入的,子组件拿得到。不建议为 3 行再造文件。

---

## 4. 两个容易踩的实现细节

### 4.1 scoped CSS 会断

`index.vue` 的 `<style scoped>` 里 `.share-otp*` 规则在标记搬进子组件后**不再命中**(父级 scoped 属性只落在子组件根元素上,不进内部 DOM)。所以 `:608-658` 必须整体搬进 `ShareOtpCard.vue` 的 `<style scoped>`,并且把 `:594-600` 这条四选择器共享规则里的 `.share-otp-row button,` 拆出来,在子组件里单独写 `font: inherit; cursor: pointer;`。父级只留 `.share-top button, .share-list button, .share-atts button`。

仓库里没有任何 CSS 快照/视觉测试,漏搬样式不会红灯,只会静默变丑 —— 这是 Fog-3。

### 4.2 `ElMessage` 是 AutoImport 出来的

`index.vue:485` 用的是裸 `ElMessage`,靠 `vite.config.js:42-44` 的 `AutoImport({resolvers:[ElementPlusResolver()]})` 注入;`vitest.config.js` 只剥了 PWA 插件,AutoImport 在测试里同样生效。所以:

- `.vue` 子组件里继续写裸 `ElMessage` 是可行的,不要手动 `import { ElMessage } from 'element-plus'`(那会绕开 resolver 的按需样式)。
- `typeof ElMessage === 'function'` 这层守卫**逐字保留**。它同时兜住了 resolver 未生效的环境,删掉可能在某些 mock 场景炸 ReferenceError。
- element-plus 本来就已经在 share chunk 里(`assert-share-chunk.js:10-15` 的 `FORBIDDEN` 四条不含 element-plus),这不是新增违规。

### 4.3 `index.spec.js:503-512` 的文本级 import 断言会漏掉新文件

那条 `does not import logged-in graph modules...` 只 `readFileSync('src/views/share/index.vue')`。抽取后 `ShareOtpCard.vue` **不在它的覆盖范围内**,而构建级的 `share-chunk.spec.js` 只查 Dexie / `account:query` / `location.reload` / `websiteConfig` 四条,查不到 `@/store/user` 和 `@/axios/index`。

修法(属于「扩展」不属于「改写」,不破单邮箱旧断言只增不改的铁律):把该条测试里的单文件读取改成对 `['index.vue', 'ShareOtpCard.vue']` 循环同一组正则。断言集合一字不改,只是多跑一个文件。

---

## 5. 契约现状(执行者不必再查)

### 5.1 `otpExtractionEnabled` 的两条真相通道

| 通道 | 位置 | 语义 |
|---|---|---|
| 会话响应 | `share-auth-service.js:392-412 buildSessionPayload` → `data.config.otpExtractionEnabled` | 布尔;同层还有 `autoRefresh` / `refreshIntervalMs` / `messageLimit`,以及 `shareType` / `mailboxes[]` / `expiresAt`(后三者归 T-25/T-26) |
| 邮件投影 | `share-mail-service.js:103-105` | `code` **键本身**只在开关为 true 时存在(`...(ctx.otpExtractionEnabled === true ? { code } : {})`),关闭时不是 null 而是整键消失 |

前端 `hasShareCode`(`:170-172`)判的是 `code != null && String(code) !== ''`,所以「关闭 → 无 code 键 → featuredMail 为 null → 整区不渲染」**目前已经成立**。T-24 加 `config` 读取是把服务端意图前移一层(少一次「有码但不该显示」的窗口),不是修 bug。这一层关系直接决定 Fog-2 里测试该怎么写。

### 5.2 `bootstrap` 是 T-24 / T-26 的共享热区

`index.vue:514-556`:T-24 要在 `:531-542` 插 config 读取,T-26 要在同一段插 `Idempotency-Key` 生成 + `share:est-key:<lid>` + `authRequired` 分支。两者串行、T-24 先行(依赖图 `tasks.md:584-585` 已定 T-24 先于 T-25/T-26)。T-24 把 config 读取收敛成一个 helper 调用,T-26 就是往 helper 里加字段,而不是重排 bootstrap。

### 5.3 i18n:T-24 零新键

`en.js:378-385` 已有 `shareVisitCode` / `shareVisitCopy` / `shareVisitCopied` / `shareVisitCopyManual` / `shareVisitFrom`,`zh.js` 同前缀段对应齐全。OTP 区用到的 5 个键全部在册,搬运不产生新键。若执行者发现确需新键,只在任务笔记记录,**不落 i18n 文件**(单写者 T-29,`tasks.md:27`)。

---

## 6. 基线现实校正

| 项 | tasks.md 写的 | 实测 |
|---|---|---|
| `views/share/index.spec.js` 用例数 | 「15 态基线」(`tasks.md:535`) | **18 条 `it()`**:`share view session shell` 8 条(`:149/163/173/184/229/241/255/266`)+ `share view visitor mailbox` 10 条(`:300/318/345/367/380/393/431/446/467/503`) |
| 切割行号 `index.vue:255-266,31-60` | — | **与 HEAD `1edca2d` 完全吻合**,可直接用 |

绿灯口径按 18 条,不是 15 条。执行者报数时若报 15,说明跑漏了一个 describe。

必须存活的 DOM 钩子(测试直接选中,不得改名):`[data-share-code]`(`:315/333/464`)、`[data-share-copy]`(`:338/360`)、`[data-share-code-from]`(`:335/336`)、`[data-share-copy-result]` 及其属性值 `copied` / `manual`(`:342/363/364`)。

---

## 7. 迷雾清单(3 条,按风险降序)

**Fog-1 · `copyResult` 随卸载归零是否真成立**
§2.2 的论证依赖「三条重置路径最终都离开 `ready`」+「Vue 不会在同 tick 插一次带旧值的渲染」。前者已逐条走过调用链,后者是框架保证但没有测试钉住。风险场景:`route.params.lid` 变化触发 `watch`→`bootstrap`→`resetMailbox`,若将来有人在 `resetMailbox` 与 `state='loading'` 之间插入 `await`,旧的 `copied` 文案就会闪一帧。
→ 处置:T-24 新增一条测试 —— 复制成功后 `exitShare()`,再让同一 lid 重新 ready,断言 `[data-share-copy-result]` 不存在。这条测试值 1 行代码的保险费。若测试红了,退回「父持 `copyResult` + `v-model`」方案,而不是硬调渲染时序。

**Fog-2 · `otpExtractionEnabled=false` 该由哪条通道驱动测试**
成功判据要求「false 隐藏 OTP 区」,但现实有两条通道(§5.1),而 `tasks.md:535` 没说清测哪条。两种写法结论不同:只 mock `config:{otpExtractionEnabled:false}` 而 mail 仍带 `code`,测的是前端新逻辑;只让 mail 不带 `code`,测的是既有行为、新代码零覆盖。
→ 处置:两条都写。(a) `config.otpExtractionEnabled=false` + mail **带** `code` → `[data-share-code]` 不存在(证明前端开关生效);(b) `config` 缺失 + mail 带 `code` → 渲染(证明默认 true,守住 18 条旧基线);(c) mail 的 `code=''` → 邮件正常出现在 `[data-share-mail-list]`,只是 OTP 区不出(`index.spec.js:300-316` 已覆盖此形态,可复用其 mock 形状)。

**Fog-3 · scoped 样式搬迁无测试兜底**
`.share-otp*` 51 行 + `.share-otp-row button` 拆分,漏搬/漏拆一律静默,全量测试仍然绿。
→ 处置:执行完对 `pnpm --dir mail-vue build` 产物或本地页面做一次肉眼确认(码字号 32px / letter-spacing 0.12em / `.is-visible` 降级框显形),或在 T-24 里加一条最轻的断言:`copyResult === 'manual'` 时 `.share-otp-select` 带 `is-visible` 类。后者已能覆盖降级路径最关键的一处样式契约。

---

## 8. T-25 / T-26 不得从本任务偷走的东西

### T-24 独占、后续任务只能消费不能重做

1. **`ShareOtpCard.vue` 的存在与 props 签名**(`mails` / `selected` / `enabled`)。T-25 做多邮箱 Tab 时,只能把**已过滤好的** `mails` 传进来,不许改成传 `bindingId` 让卡片自己过滤,也不许为多邮箱再造第二个 OTP 组件。
2. **复制路径的唯一实现**。`useCopyWithFallback` 的消费点在且只在 `ShareOtpCard.vue`。T-25/T-26 不得在 `index.vue` 或 Tab 组件里另起一条 `navigator.clipboard` 调用。
3. **`featuredMail` 选取算法**(先看 selected、否则从尾向前找首个有码者)。多邮箱下语义仍是「当前可见列表内选取」,T-25 通过换入参改变结果,不得改算法本体。
4. **`data-share-code` / `data-share-copy` / `data-share-code-from` / `data-share-copy-result` 四个钩子的归属**。它们随卡片走,T-25 加 Tab 角标要用新的 `data-*`,不许复用或改写这四个。
5. **`config.otpExtractionEnabled` 的读取点**。T-24 在 `bootstrap` + `reestablishSession` 落一次;T-26 读 `autoRefresh` / `refreshIntervalMs` 时**扩展同一个 helper**,不许另开一处读 `data.config`。

### T-24 不得抢的(留给下游)

- **T-25**:`shareType` 分支、原生 Tab、掩码地址、新邮件角标、`share:status:<lid>` 水位 map、`useSharePolling` 的 status 扩展、`assert-share-chunk.js` 的 import 白名单扩展。T-24 的卡片里不出现任何 `mailboxes` / `bindingId` 字样。
- **T-26**:`authRequired` 状态节点(`index.vue:160` 的状态机加节点)、`Idempotency-Key` 与 `share:est-key:<lid>`、`refreshIntervalMs` 注入、`auto_refresh=false` 的手动刷新按钮、429 `Retry-After` 退避、`expiresAt` 倒计时、`request/share.js` 的 status 函数。T-24 读 `config` 时**只取 `otpExtractionEnabled` 一个字段**,不顺手把 `autoRefresh` 也接上。
- **T-29**:任何 `i18n/zh.js` / `en.js` 的落盘。

### 三方共同禁区

`router/index.js` 的 share 路由与访客守卫、`init/init.js` 的 share 正则与提前 return、`/s/<lid>#<sec>` 路径形态、`session.js` 的 `share:session:` 键前缀、`data-share-shell="cloud-mail-share-shell"` 标记 —— 任何一个波次都不许动。禁入 share chunk 的依赖(登录态 axios / layout / Dexie / websiteConfig)在 T-24 里天然不会引入:新组件只依赖 `vue`、`vue-i18n`、`@/composables/useCopyWithFallback.js` 和同目录相对文件。

---

## 9. 主 AI 迷雾裁决（2026-08-24 · 独立核对切割线后）

现场核对 HEAD `1edca2d`：`:31-60` / `:255-266` / `:479-491` / `:608-658` / `:595` 与侦察一致。`index.spec.js` 实测 **18** 条 `it()`（session shell 8 + visitor mailbox 10）。`tasks.md` 原写「15 态」以 18 为准。

| ID | 裁决 | 落点 |
|---|---|---|
| Fog-1 | **CHANGE** | `copyResult` 随 `state !== 'ready'` 卸载归零。禁止 `defineExpose` / `v-model` / 父持 `copyResult`。新增测试：复制成功 → `exitShare()` → 同 lid 再 ready → `[data-share-copy-result]` 不存在。若红，退回父持方案，不要调渲染时序。 |
| Fog-2 | **CHANGE** | (a) `config.otpExtractionEnabled=false` + mail **带** `code` → 无 OTP 区（覆盖新逻辑）；(b) 缺 config 默认 true → 既有 AC-OTP-07 用例已覆盖，**不另造重复用例**；(c) `code=''` 既有 `:300` 已覆盖。 |
| Fog-3 | **CHANGE** | 新增 clipboard reject 后 `.share-otp-select` 带 `is-visible`；另加源码断言 `ShareOtpCard.vue` 含 `32px` / `0.12em` / `.is-visible`，且 `index.vue` 不再有 `.share-otp {`。不建视觉测试框架。 |
| T24-SENDER | **CHANGE** | `senderLine` 必须抽到 `mail-fields.js`，禁止在子组件复制 8 行。 |
| T24-CONFIG | **CHANGE** | `applyShareConfig(data)` 只读 `otpExtractionEnabled`；仅严格 `false` 隐藏；缺省 / 非 false 视为 true。`bootstrap` 开头必须 reset 为 true（防跨 lid 残留）。T-26 只许扩展此 helper，不许另开读取点。 |
| T24-NO-SPEC | **HOLD** | 新断言全部进 `index.spec.js`。不建 `ShareOtpCard.spec.js`。 |

旧 18 条 `it()` 正文只扩不改。唯一允许改写：AC-VISIT-10 文本断言改为对 `index.vue` / `ShareOtpCard.vue` / `mail-fields.js` 循环同一组正则。
