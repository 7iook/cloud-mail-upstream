# T-24 执行笔记 · ShareOtpCard 抽取(W5 第一根横杠)

| 字段 | 值 |
|---|---|
| 任务 | T-24 / T-24.1 `ShareOtpCard` 组件抽取 + `config.otpExtractionEnabled` 读取 |
| 分支 | `cursor/mailbox-share-capability-dcb6`(未 commit / push / stash / 切分支) |
| 派单 | `prompt.t24.exec.txt` |
| 侦察+裁决 | `recon-t24-otp-card.md`(§9 六条裁决全部按原样执行,未重开) |
| 前置阅读 | frontend-design / impeccable / ui-ux-pro-max / ponytail(lite) 四份 SKILL.md 已读。按派单第 11 行「保持现有 OTP 卡片外观,不重设计」执行:零新颜色、零 `el-card` / `el-steps`、零新字号,样式逐条搬迁 |

---

## 1. 落盘文件(4 个,与派单「Files you may write」完全一致)

| 文件 | 动作 | 行数变化 |
|---|---|---|
| `mail-vue/src/views/share/ShareOtpCard.vue` | 新建 | +150 |
| `mail-vue/src/views/share/mail-fields.js` | 新建 | +9(仅 `senderLine`) |
| `mail-vue/src/views/share/index.vue` | 改 | +12 / −126(净 −114) |
| `mail-vue/src/views/share/index.spec.js` | 只扩展 | +88 / −6 |
| `.../exec-t24-note.md`(本文件) | 新建 | — |

`git status` 工作区改动面 = 上述 4 个 + 本笔记,无越界。

**未创建** `ShareOtpCard.spec.js`(裁决 T24-NO-SPEC = HOLD)。
**未触碰**:`router/index.js`、`init/init.js`、`session.js`、`assert-share-chunk.js`、`useSharePolling.js`、`request/share.js`、`useCopyWithFallback.js`、`i18n/zh.js`、`i18n/en.js`、任何 `mail-worker/**`、`share-admin/**`、`ShareDialog.*`。i18n 零新键(recon §5.3 确认 5 个键已在册)。

---

## 2. 测试计数

| 口径 | 命令(全部 `--no-cache`) | 结果 |
|---|---|---|
| 基线(改动前) | `vitest run --no-cache src/views/share/index.spec.js` | **18 passed**(session shell 8 + visitor mailbox 10),与 recon §6 校正后的 18 条一致,非 tasks.md 的「15 态」 |
| TDD 红(仅追加测试、未抽组件) | 同上 | **22 tests · 3 failed / 19 passed** |
| TDD 绿(抽取+接线后) | 同上 | **22 passed**(18 旧 + 4 新) |
| 隔离闸门 | `vitest run --no-cache src/views/share/share-chunk.spec.js` | **1 passed**(share chunk 内无 Dexie / `account:query` / `location.reload` / `websiteConfig`) |
| 全量 | `pnpm --dir mail-vue test -- --no-cache` | **21 files · 189 passed** |
| 全量(直呼 vitest 复核) | `vitest run --no-cache` | **21 files · 189 passed** |

前后对比:index.spec.js 18 → 22(+4);mail-vue 全量 185 → 189(+4)。

### 2.1 TDD 顺序(未倒置)

先只改 `index.spec.js`,跑出红,再动生产代码。红的三条:

1. **Fog-2(a)** `hides the OTP zone when the session config turns extraction off…` — `AssertionError: expected true to be false`,即「config 关了但 `[data-share-code]` 仍在」。这是**缺行为**红,不是语法红,正是派单第 43 行要求看到的那一条。
2. **AC-VISIT-10**(改写为三文件循环)— `ENOENT ShareOtpCard.vue`。
3. **Fog-3 source** — `ENOENT ShareOtpCard.vue`。

另两条新测试在红阶段就是绿的,这是**设计如此**,已在派单里预期:

- **Fog-1**(复制成功 → `exitShare()` → 同 lid 再 ready → 无 `[data-share-copy-result]`):抽取前 `copyResult.value = ''` 还在,自然绿。它的作用是**先上锁再拆锁**——锁住 recon §2.2 的论证,使随后删掉那三行 reset 不会静默回归。删完仍绿 = 论证成立,无需回退到「父持 `copyResult` + `v-model`」。
- **Fog-3 runtime**(clipboard reject + execCommand false → `.share-otp-select` 带 `is-visible`):同理,锁住 class 绑定跨文件搬迁不丢。派单要求「不要改写既有 reject 测试,加兄弟测试」,已照办,`:345` 那条原文未动。

红/绿证据:`t24_red_new_tests_first.log`、`t24_green_three_suites.log`。

### 2.2 旧 18 条的改动边界

17 条正文一字未改。唯一改写的是 AC-VISIT-10(派单第 63-64 行 + 裁决明确许可的那一条):单文件 `readFileSync('index.vue')` 改成对 `['index.vue', 'ShareOtpCard.vue', 'mail-fields.js']` 循环**同一组 7 条正则**。断言集合本身一字未增删,只是多跑两个文件——这修掉了 recon §4.3 指出的覆盖漏洞(抽取后新文件会掉出文本级 import 断言的射程,而构建级 `share-chunk.spec.js` 的 4 条 FORBIDDEN 查不到 `@/store/user` / `@/axios/index`)。

---

## 3. 实现要点(逐条对齐 §9 裁决)

| 裁决 | 落地 |
|---|---|
| Fog-1 CHANGE | 净删 `index.vue` 三处 `copyResult.value = ''`(`clearMailboxView` / `exitShare` / `resetMailbox`)。**未**加 `defineExpose({reset})` / `v-model:copyResult` / emit。`copyResult` 只活在子组件里,随 `state !== 'ready'` 卸载归零。测试已钉。 |
| Fog-2 CHANGE | 只写 (a) 一条新用例;(b) 缺 config 默认 true 复用既有 AC-OTP-07,(c) `code=''` 复用既有 `:300`,**均未另造重复用例**(派单第 67-68 行)。 |
| Fog-3 CHANGE | runtime 断言 + source 断言两条都落。source 条同时反向钉住 `index.vue` 不再匹配 `/\.share-otp\s*\{/`。未引入任何视觉测试框架。 |
| T24-SENDER CHANGE | `senderLine` 抽到 `mail-fields.js`,父子各 `import` 一行,**未**在子组件复制那 8 行。父级列表项 `:84` 与详情头 `:93` 继续用它,调用点形状未变。 |
| T24-CONFIG CHANGE | 单一 helper `applyShareConfig(data)`,函数体正是派单第 97 行那一行:`otpEnabled.value = !(data && data.config && data.config.otpExtractionEnabled === false)`。仅严格 `false` 隐藏;`undefined` / `null` / 缺 `config` / 非布尔一律 true。调用点恰两处:`bootstrap` 成功分支(写 token 之后)与 `reestablishSession`(写 token 之后)。`bootstrap` 开头 `resetMailbox()` 之后立刻 `otpEnabled.value = true`,防跨 lid 残留。**未**读 `autoRefresh` / `refreshIntervalMs` / `shareType` / `mailboxes` / `expiresAt`。 |
| T24-NO-SPEC HOLD | 新断言全进 `index.spec.js`。 |

### 3.1 子组件签名(不多不少)

```
props: mails Array | selected Object|null | enabled Boolean(default true)
emits: 无
```

无 `bindingId` / `mailboxes` / `shareType` / `autoRefresh`,子组件源码内不出现这些字样。`featuredMail` 与 `index.vue:255-266` 逐字同构,只把 `selectedMail.value` / `mails.value` 换成 `props.selected` / `props.mails`。整区开关落在根节点 `v-if="enabled && featuredMail"`,算法本体未动。

父级挂载传的是 `mails` 而非 `listMails`(派单第 93 行)——`featuredMail` 的「从尾向前找」依赖升序原序,传倒序的 `listMails` 会把「最新有码邮件」变成「最旧」。

### 3.2 保留原样的东西

`data-share-shell="cloud-mail-share-shell"`、`data-share-body`(两处)、`:data-share-state`、`defineExpose({ noteShareFailure, exitShare })` 全部原地未动。四个 DOM 钩子 `data-share-code` / `data-share-copy` / `data-share-code-from` / `data-share-copy-result` 随卡片整体搬迁,名字与属性值(`copied` / `manual`)未改。

`typeof ElMessage === 'function'` 守卫逐字保留,**未**写 `import { ElMessage } from 'element-plus'`(recon §4.2:裸标识符靠 vite AutoImport 注入,手动 import 会绕开 resolver 的按需样式)。

子组件自己 `useI18n()` 再写 3 行 `tx`,未与父级共享(派单第 82 行)。

---

## 4. 样式搬迁的独立核对(Fog-3 的真实兜底)

recon §4.4 指出:仓库没有 CSS 快照/视觉测试,漏搬样式**不会红灯、只会静默变丑**。source 断言只查 3 个片段,覆盖不到全部 6 条规则。所以另做了两层核对:

**(1) 规则级 diff**(`t24_otp_css_parity.log`):把 `git show HEAD:index.vue` 与新 `ShareOtpCard.vue` 的 `<style scoped>` 解析成「选择器 → 声明集合」再比对。

```
rule bodies identical after the move : True
dropped during the move              : none
invented during the move             : none
index.vue now, .share-otp* rules     : NONE (all moved)
```

四选择器共享规则的拆分也验了:HEAD 的 `.share-top button, .share-otp-row button, .share-list button, .share-atts button` → 父级留 `.share-top button, .share-list button, .share-atts button`、子组件独立写 `.share-otp-row button`,**三处声明体完全相同**(`font: inherit; cursor: pointer`)。

**(2) 像素级 before/after**(`otp_card_before_after.png`):在 `/tmp` 起了一次性 vite harness(未写入仓库),左列渲染从 `git show HEAD` 程序化抽出的原始 section + 原始 scoped style,右列挂载真实的 `ShareOtpCard.vue`,两列套各自版本的 `.share-shell` 外壳样式。idle 与 manual 降级两种状态并排,渲染一致:码字号 32px、`letter-spacing 0.12em`、tabular-nums、卡片 `#f6f8fa` 底 + `#d0d7de` 边 8px 圆角、降级输入框显形为 100% 宽 + 8px padding + 6px 圆角。右下角多出的焦点环与蓝色选中态是真实运行差异——右列是真的点了复制按钮走完 `useCopyWithFallback` 的 manual 分支(`selectInElement` 会 focus + select),左列只是静态挂了 `is-visible` 类。

---

## 5. 遗留风险

1. **sessionStorage 复活路径拿不到 config**(recon §2.3 已述,非本任务引入)。`bootstrap` 走 `readShareSession(lid)` 分支时根本不调 `/share/session`,`otpEnabled` 只能停在默认 `true`。此时安全性由后端兜底:`share-mail-service.js:103-105` 在开关为 false 时把 `code` **整键删掉**,前端拿不到码,`featuredMail` 自然为 null,整区不渲染。**结论:不是漏洞,但它意味着前端这层开关是「提前收敛」而非「唯一防线」**——若将来有人改后端让 `code` 在关闭时仍下发,刷新路径会漏出 OTP 区。留给 T-26 在做 `authRequired` / 会话重建时顺手评估是否给复活路径也补一次 config 拉取。

2. **`.share-otp-row button` 的选择器语义变窄了一点**。原来它是父级 scoped 规则,现在是子组件 scoped 规则,只命中卡片内的按钮。当前卡片内只有「复制」一个按钮,行为等价;但 T-25 若往卡片里加第二个按钮,它会自动继承 `font: inherit; cursor: pointer`,与 HEAD 语义一致,无需额外处理。

3. **`props.selected` 用了 `type: Object, default: null`**。父级传 `selectedMail`(computed,可为 null)。Vue 对 `type: Object` + `null` 不告警,当前 22 条测试含多条 null 场景全绿。若 T-25 改传 plain object 之外的结构需重看。

4. **新测试的 lid 复用**。Fog-1 那条在同一个 `it()` 里挂了两次 `lid-a`,第一个 wrapper 在 `afterEach` 统一 unmount(沿用文件既有的 `wrappers` 数组约定),未改 `mountShare` 与 `afterEach`。

5. **T-25 / T-26 边界**已按 recon §8 守住:卡片内零 `mailboxes` / `bindingId` / `shareType` 字样;`useCopyWithFallback` 的消费点收敛为 `ShareOtpCard.vue` 唯一一处;`applyShareConfig` 是 `data.config` 的唯一读取点,T-26 往里加字段即可,不必重排 `bootstrap`。

---

## 6. 证据文件

| 文件 | 内容 |
|---|---|
| `t24_red_new_tests_first.log` | TDD 红:22 tests / 3 failed,含 Fog-2(a) 的缺行为断言失败原文 |
| `t24_green_three_suites.log` | 三条 verify 命令(全 `--no-cache`)的绿:22 / 1 / 189 |
| `t24_otp_css_parity.log` | `.share-otp*` 6 条规则的搬迁 diff + 共享按钮规则拆分核对 |
| `otp_card_before_after.png` | HEAD 原件 vs 新组件的并排渲染(idle + manual 降级) |
