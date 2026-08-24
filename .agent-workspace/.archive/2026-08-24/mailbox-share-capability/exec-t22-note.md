# Exec Note · T-22 创建向导:四预设 + 幂等恢复 + V2 降级(W4 第三棒)

| 字段 | 值 |
|---|---|
| 任务 | T-22 / T-22.1 · share-admin 创建向导 |
| 分支 | `cursor/mailbox-share-capability-dcb6`(**未 commit / 未 push / 未 stash / 未切分支**) |
| HEAD | `4f4cc65`(T-23 已落盘;T-21 APPROVED,`00b0ae1` + `5af8675`) |
| 执行日期 | 2026-08-24 |
| 依据 | `recon-t22-wizard.md` + `prompt.t22.exec.txt`(三条迷雾均已由派单裁决,见 §3) |
| 依据 AC | **AC-CAP-12**(预设仅前端)· **AC-CAP-14**(响应丢失恢复)· **AC-LIFE-11**(V2 全能力栅栏);旁及 AC-CAP-05/09/10/13、AC-ADMIN-08 |
| 已读技能 | frontend-design · impeccable · ui-ux-pro-max · ponytail(lite) |
| 基线 | vue **20 文件 / 161 用例** → **21 文件 / 183 用例**(只增不减)· build EXIT=0 |

---

## 1. 改动文件(3 新 + 3 补丁,全部在白名单内)

| 文件 | 性质 | 规模 | 内容 |
|---|---|---|---|
| `mail-vue/src/views/share-admin/ShareCreateWizard.vue` | **新建** | 985 行 | 触发按钮 + `el-dialog` + 四预设 + 表单 + 三态结果区 |
| `mail-vue/src/views/share-admin/presets.js` | **新建** | 142 行 | 12 键白名单 · `capabilityV2` 模块级 ref · `hasFenceIntent` · 四预设数据 |
| `mail-vue/src/views/share-admin/ShareCreateWizard.spec.js` | **新建** | 621 行 | 21 条用例(W1–W18 + 3 条补充) |
| `mail-vue/src/views/share-admin/index.vue` | 锚点补丁 | **+2 / -0** | import 一行 + `<ShareCreateWizard @created="refresh"/>` 一行(预算 ≤6 行) |
| `mail-vue/src/request/mail-share.js` | 改 | +36 / -6 | **只动 `createMailShare` 一个函数** |
| `mail-vue/src/request/mail-share.spec.js` | 改(**只扩不改**) | +53 / -0 | **追加 1 条**,既有 6 条一字未动 |
| 本文件 | 新建 | — | exec note |

**`git status --porcelain` 实测**,除本 note 外恰好只有这六项。

**明确 0 行改动**(逐条核对):
`views/share-admin/status.js` · `ShareDetailDrawer.vue/.spec.js` · `ShareRowActions.vue/.spec.js` · `views/share-admin/index.spec.js` · `views/email/**`(含 `ShareDialog.vue` / `ShareIndicator.vue` / `build-share-url.js` —— 后者**只 import 复用**)· `i18n/zh.js` · `i18n/en.js` · `router/index.js` · `perm/perm.js` · `axios/index.js` · `views/share/**` · `request/share.js` · `composables/**` · `mail-worker/**` · `tests/e2e/**`。

---

## 2. 红 → 绿

```
红(request 层,先做)
  pnpm --dir mail-vue exec vitest run src/request/mail-share.spec.js --no-cache
  → 1 failed | 6 passed
    × forwards the wizard create fields verbatim and swaps accountId out for accountIds
      - "accountIds": [11,12] ... + "accountId": NaN   ← 旧函数写死四键，新字段一个都送不出去

绿(定点)      ShareCreateWizard.spec.js                                   21 用例
绿(定点+邻接) 上述 + mail-share + ShareDialog + ShareIndicator
              + share-admin/index + share/share-chunk                     6 文件 / 56 用例
绿(全量)      pnpm --dir mail-vue test -- --no-cache                      21 文件 / 183 用例
绿(构建)      pnpm --dir mail-vue build                                   ✓ built in 6.8s
```

`share/share-chunk.spec.js`(跑**真实 vite build** 的构建闸门)绿 —— 证实向导新增的 5 个 import(`@/store/account.js` / `@/composables/useCopyWithFallback.js` / `@/request/account.js` / `@/views/email/build-share-url.js` / `./presets.js`)没有把访客域或登录态依赖拖坏(recon T18)。

**跨栈基线**:交付前补跑实测,均**持平未掉**——

```
绿(worker)   pnpm --dir mail-worker test        18 文件 / 619 用例
绿(E2E)      node tests/e2e/run.mjs             13 passed (28.6s)
```

### 2.1 变异验证(7 次,证明用例不是空转)

写完实现后逐条注入缺陷并跑定点套件,确认对应用例**真的会红**(改完即回滚,`git status` 实测干净):

| # | 注入的缺陷 | 打红的用例 |
|---|---|---|
| M1 | `unknown` 态就预置灰(`!== 'active'`) | **6 条**,含 W9 / W8 / W10 / W11 / W1 |
| M2 | 结果未知时也轮换 key | **W4** |
| M3 | 删掉本地值域校验 | **W11** |
| M4 | 请求体夹带 `presetId` | **W1** |
| M5 | 不看栅栏意图就置灰 | **W11** |
| M6 | 「我已保存」不清空明文 | **W15** / W14 / W10 |
| M7 | 把 `messageLimit` 从栅栏集合里拿掉 | **W8** |

---

## 3. 三条迷雾的落地形态(派单裁决 → 实现)

### F1 · V2 探测 → **T22-V2-COLLIDE:撞后降级,`unknown` 不预置灰,跳过列表旁证**

```js
export const capabilityV2 = ref('unknown')      // presets.js 模块级，非 storage
```
- **`unknown`**:四组控件全部可用 + 一条静态 hint(`data-test="capability-unknown-hint"`)。
- **`inactive`**:四组 `disabled` + `data-test="capability-inactive"` + 复位到非受限默认值 + 「重新检测」入口回 `unknown`。
- 派单裁掉的:worker 探测端点、`VITE_` 常量、`§4.4` 列表行正向旁证(HOLD,登记为 extra)。

**置灰的三个前置条件全部落地**(`submit()` 里逐条可读):
1. `hasFenceIntent(body)` —— 本次请求体确有受栅栏意图;
2. `localError()` 已全部通过 —— 值域错误绝不会走到这一步;
3. `err.message === 'SHARE_INVALID_CONFIG'` —— DURATION / ACCOUNT / BINDING 三个码不触发降级。

**栅栏是四组不是三组**:`presets.js:hasFenceIntent` 与 UI 的 `gatedDisabled` 都覆盖 `accountIds.length>1` / `authKeyEnabled` / `maxSessions` / **`messageLimit`**。W8 与变异 M7 各钉一次。

### F2 · `createMailShare` → **T22-CREATE-EXPAND:就地条件展开**

```js
const CREATE_OPTIONAL_FIELDS = ['maxSessions','messageLimit','onlyMessagesAfterCreated',
    'otpExtractionEnabled','autoRefresh','refreshIntervalMs','showFullAddress','authKeyEnabled']
```
- 四个旧键的 `Number()` / `String()` 强制**逐字保留**;
- `accountIds` 与 `accountId` **互斥**:`source.accountIds === undefined` 才回落旧单值 —— 两个键从不同时出现;
- 其余 8 键**只在调用方显式给了才出现**(`!== undefined`);
- **request 层零归一化**:不钳 3000、不把 `false` 转 `0`、不给缺省值。后端 `normalizeCreateBody` 是唯一真源。

**没有** `createMailShareV2`,**没有**向导直连 `http.post`。

### F3 · 排期 → **T22-AFTER-T21:T-21 先落,T-22 后落**

T-21 已在 HEAD 里。T-22 **一行都没碰** `status.js` / `ShareDetailDrawer.*` / `ShareRowActions.*` / `index.spec.js`;`index.vue` 的锚点(header-actions 尾部)与 T-21 的写点(卡片区 `<ShareRowActions>` + `<ShareDetailDrawer>`)不重叠,`git diff` 实测 **+2 / -0**。

---

## 4. 幂等状态机(AC-CAP-14 的核心)

| 出口 | 判据 | 换 key? | UI |
|---|---|---|---|
| **首次成功** | `data && !data.idempotentReplay` | ✅ | 一次性展示 `shareUrl`(+`authKey`)· `emit('created')` |
| **幂等重放** | `data.idempotentReplay === true` | ❌ | `shareId` / `lid` + 「明文不再发放」+ **撤销/删除引导**;`emit('created')` 让列表把那一行拉回来 |
| **结果未知** | `!Number.isInteger(err?.code)` | ❌ | **锁表单** + 「用同一把钥匙重试」 |
| **业务拒绝** | `Number.isInteger(err.code) && typeof err.message === 'string'` | 改表单时才换 | 回表单,输入全保留 |

```js
watch(form, () => { if (!unknownResult.value) rotateIdempotencyKey() })
```
两条约束自洽:**能改表单时一定不是未知态,处于未知态时一定改不了表单。**

**不持久化 key**(无 storage / pinia / URL)。刷新页面即丢,此时列表本身就是「是否已经建好」的答案。

**偏离 recon 的一处(向上)**:recon §5.2 只在首次成功 `emit('created')`。实现里**重放也 emit** —— 「先超时、重试命中重放」这条路径下列表从未刷新过,不 emit 就等于把引导指向一个看不见的行。这是把建议变成可执行的差别。

---

## 5. 🔴 i18n 新增键(交 T-29 落盘,`zh.js` / `en.js` 一字未改)

`PENDING_COPY` 共 **44 键 = 30 新 + 14 与 T-20/T-21 共享**。`tf()` 形状与 T-20/T-21 逐行相同。

### 5.1 T-22 新增 30 键 × 2 语言

| 键 | zh | en |
|---|---|---|
| `shareWizardOpen` | 新建分享 | New share |
| `shareWizardTitle` | 新建分享 | Create a share |
| `shareWizardPresetStep` | 选一个用途 | Pick what it is for |
| `sharePresetSingleOtp` | 单邮箱验证码 | Single-mailbox codes |
| `sharePresetSingleOtpHint` | 把一个邮箱的验证码分给同事，1 小时后自动失效。 | Share one mailbox's verification codes with a teammate; expires in an hour. |
| `sharePresetTempMailbox` | 临时邮箱 | Temporary mailbox |
| `sharePresetTempMailboxHint` | 对方需要看到完整地址去别处注册，有效期 24 小时。 | The visitor sees the full address to sign up elsewhere; valid for 24 hours. |
| `sharePresetMultiOtp` | 多邮箱验证码池 | Multi-mailbox code pool |
| `sharePresetMultiOtpHint` | 一个链接汇总多个邮箱的验证码，需平台已激活该能力。 | One link covering several mailboxes; needs the capability to be active. |
| `sharePresetCustom` | 自定义 | Custom |
| `sharePresetCustomHint` | 全部选项展开，自己配。 | Every option, configured by you. |
| `shareWizardAdvanced` | 高级选项 | Advanced options |
| `shareWizardMailboxes` | 分享的邮箱 | Mailboxes to share |
| `shareWizardDuration` | 有效期 | Valid for |
| `shareWizardLinkLabel` | 分享链接 | Share link |
| `shareWizardShareId` | 分享 ID | Share ID |
| `shareWizardLinkId` | 链接 ID | Link ID |
| `shareOnlyAfterCreated` | 只显示创建之后收到的邮件 | Only show mail received after creation |
| `shareOnlyAfterCreatedHint` | 创建后无法更改这一项。 | This cannot be changed after the share is created. |
| `shareCapabilityInactive` | 能力未激活 | Capability not active |
| `shareCapabilityInactiveHint` | 平台尚未开放多邮箱、访问密钥与用量上限。已为你关掉这几项，其余设置可以照常提交。 | Multi-mailbox, access keys, and usage limits are not enabled on this platform yet. They have been turned off; everything else still works. |
| `shareCapabilityUnknownHint` | 若平台尚未开放该能力，带这几项的提交会被拒绝。 | If the platform has not enabled this yet, a submission using these will be rejected. |
| `shareCapabilityRecheck` | 重新检测 | Check again |
| `shareCreateUnknownTitle` | 没收到服务器的回应 | No response from the server |
| `shareCreateUnknownHint` | 分享可能已经建好了。请用同一把钥匙重试 —— 换一把会建出第二个分享。表单已锁定，以免重试时改动了内容。 | The share may already exist. Retry with the same key—changing it would create a second share. The form is locked so the retry cannot drift. |
| `shareCreateRetrySameKey` | 用同一把钥匙重试 | Retry with the same key |
| `shareReplayGuidance` | 这次提交命中了之前的同一请求，链接明文不会再发放。请撤销或删除这个分享，然后重新创建一个新链接。 | This request matched an earlier one; the link secret is not issued again. Destroy or delete this share, then create a new one. |
| `shareWizardCloseConfirm` | 关闭后将无法再看到这个链接（和密钥）。确认已经保存好了吗？ | Once closed, the link (and key) cannot be shown again. Have you saved them? |
| `shareCreatedSaved` | 我已保存 | I saved it |
| `shareWizardCountTooSmall` | 上限至少是 1；留空表示不限。 | A limit must be at least 1; leave it blank for unlimited. |

**与 recon §10.2 的差异(4 个新增、0 个删除)**:`shareWizardLinkLabel` / `shareWizardShareId` / `shareWizardLinkId` 是浏览器实证阶段补的可见 label(两个一次性输入框原本只有 `aria-label`,视力正常的用户分不清哪个是链接哪个是密钥);`shareWizardCountTooSmall` 是本地值域校验的文案(recon 只描述了行为没给键)。

### 5.2 与 T-20/T-21 共享的 14 键(**不重复造**,T-29 按并集去重)

`shareName` `shareRemark` `shareMaxSessions` `shareMessageLimit` `shareOtpExtraction` `shareAutoRefresh` `shareRefreshInterval` `shareRefreshIntervalTooSmall` `shareShowFullAddress` `shareShowFullAddressHint` `shareAuthKey` `shareBindingLoadMore` `shareBindingLimitReached` `shareQuotaUnlimited`

> ⚠️ **一处 fallback 文案分叉,需 T-29 择一**:`shareShowFullAddressHint` 在 `ShareDetailDrawer.vue` 里写作「…关闭它不会**隐藏**邮件正文…」,本文件写作「…关闭它不会**改变**邮件正文…」。派单对 T-22 的文案禁用词表点名了「隐藏」,所以这里避开了它;两处语义相同。落盘时以一份为准。

### 5.3 复用的既有已落盘键(零新增,走 `$t()`)

`shareCreateWarning` `shareSecretOnce` `shareReplayNoSecret` `shareCopyLink` `shareCreate` `shareMailbox` `shareNamePlaceholder` `shareRemarkPlaceholder` `shareDuration1h/6h/1d/7d` `shareDurationRequired` `shareAccountRequired` `copy` `cancel` `confirm` `copySuccessMsg`

**`shareSecretOnce` 与 `shareReplayNoSecret` 直接复用,没有为向导另造一对同义键**(派单明令)。

### 5.4 T-29 收口清单(现在是三处)

| # | 位置 | 要删的东西 |
|---|---|---|
| 1 | `views/share-admin/index.vue` | `PENDING_COPY`(10 键)+ `tf` |
| 2 | `views/share-admin/ShareDetailDrawer.vue` | `PENDING_COPY`(约 50 键)+ `tf` |
| 3 | `views/email/ShareDialog.vue` | `PENDING_COPY`(1 键)+ `tf` |
| 4 | **`views/share-admin/ShareCreateWizard.vue`(本次新增)** | `PENDING_COPY`(44 键)+ `tf`,约 50 行;模板里 `tf(...)` 换回 `t(...)`;`useI18n()` 的 `te` 可一并去掉 |

**已知副作用**(与 T-20/T-21/T-23 同一口径,不是 bug):`PENDING_COPY` 只有中文,T-29 落盘前英文界面上这些文案显示中文。

---

## 6. 用例清单(`ShareCreateWizard.spec.js` 21 条)

| # | 用例 | 关键断言 | 覆盖 |
|---|---|---|---|
| **W1** ★ | 预设只预填,不进请求体 | 依次点四个预设 → `duration` / `mask` / `data-multiple` 随之变;提交后请求体键集合 **⊆ `CREATE_BODY_KEYS`(12 键)**,且 `not.toHaveProperty` `preset` / `presetId` / `presetKey` | **AC-CAP-12** |
| **W2** | 单邮箱预设 = 旧兼容形状 | `accountIds:[11]` · `refreshIntervalMs:3000` · 五个 flag 全在 DDL 默认 · 无 `maxSessions`/`messageLimit`/`accountId` | AC-CAP-10 · `legacyCompatibleBody` |
| **W3** | 提交带 Idempotency-Key | 第二参为长度 >8 的字符串 | AC-CAP-09 |
| **W4** ★ | 结果未知 → 同 key 重试 | reject AxiosError → `wizard-unknown` 出现、`wizard-name` disabled、`mailbox-select` `data-disabled=1`、**`wizard-submit` 不存在**;点重试 → 第二次 key **`toBe`** 第一次 | **AC-CAP-14** |
| **W5** | 业务码不锁表单 | reject `SHARE_DURATION_EXCEEDED` → 表单可编辑 + **不置灰**;改一字段再提交 → key **`not.toBe`** | §5.4 |
| **W6** ★ | 重放识别 | `idempotentReplay:true` 且无 `sec`/`shareUrl` → `share-url` / `secret-once` / `authkey-once` **均不存在**,`replay-guidance` 存在,全文不含 `sec-7`;`createMailShare` **恰 2 次** | **AC-CAP-14** |
| **W7** | 重放引导 revoke/delete | `replay-guidance` 在;**无** `wizard-retry`、**无** `replay-new-key`;恰 1 次请求 | **AC-CAP-14** |
| **W8** ★ | V2 降级四组齐全 | 提交 `authKeyEnabled:true` → `SHARE_INVALID_CONFIG` → `capability-inactive` 出现;`data-multiple=0` + `authkey-toggle` / `max-sessions` / **`message-limit`** 三者 disabled | **AC-LIFE-11** |
| **W9** | unknown **不**预置灰 | 刚挂载 → 无 `capability-inactive`、有 `capability-unknown-hint`、四组全部可用 | §4.2 |
| **W10** | 降级后立即可重提 | 复位后第二次请求体 `accountIds:[11]` · `authKeyEnabled:false` · 无两个上限;「我已保存」后 `capability-recheck` 仍可点且回 `unknown` | §4.2 |
| **W11** ★ | 本地值域前置,零请求 | `refreshIntervalMs=2999` / `maxSessions=0` / `messageLimit=0` / `durationSeconds=0` / `accountIds=[]` 逐个提交 → `createMailShare` **零调用**,`capabilityV2` 仍是 `'unknown'` | §4.3(降级判据的前提) |
| **W12** | 51 邮箱前端拦下 | 零请求 + `binding-limit` 提示 + 提交按钮 disabled | AC-CAP-13 |
| **W13** | 成功一次性展示 | `share-url` 的 `element.value` 含 `#sec-7`;`secret-once` 在;`emitted('created')` 恰 1 次 | AC-CAP-05 |
| **W14** | authKey 也一次性 | 有 `authKey` → `authkey-once` 渲染该值;下一次响应无该键 → 节点消失而 `share-url` 仍在 | AC-CAP-05 |
| **W15** ★ | 明文不复活 | `@created` 后明文仍只在一次性块内;「我已保存」→ DOM 全文不含 `sec-7`;第二次创建 → `#sec-8`;关闭(confirm 恰 1 次)→ 全文不含 `sec-8` | 镜像 `ShareDialog.spec.js:144-162` |
| **W16** | `shareUrl` 回落 | 响应只有 `lid`+`sec` → `${window.location.origin}/s/lid-7#sec-7` | 复用 `build-share-url.js` |
| **W17** | 复制走既有 composable | `useCopyWithFallback` **被调用 2 次**(两个实例);`copied===true` 才弹 toast;`manual` 降级时**不**再弹 | `useCopyWithFallback` |
| **W18** | 双击提交只发一次 | 连点两次 → 恰 1 次 | `loading-buttons` |
| +1 | 单选/多选的 model 形状 | 单选时 `data-value` 是**裸 id**,多选时是数组;两种形状都归一成 `accountIds:[...]` | §7 浏览器实证发现的缺陷 |
| +2 | 邮箱游标翻页 | 首次 `accountList(0, 30, null)`;翻页 `accountList(30, 30, 30)`;不足 30 行后「加载更多」消失 | T23 · `request/account.js:3` |
| +3 | 样式契约 | 源码含 `<style lang="scss" scoped>` + `@media (max-width: 767px)`;不含 `window.onresize`;**style 块内零裸 hex** | §8.1 |

`request/mail-share.spec.js` 追加的 1 条同时钉两件事:12 键请求体逐字透传 + header 带 key;**以及**「调用方没提的键不出现」(单邮箱预设保住 `legacyCompatibleBody` 的前提)。既有 6 条(尤其 `:51-56` 的四键 `toEqual`)**一字未改**,`git diff` 实测该区间零 `-` 行。

### 既有断言未被改写(逐条实测)

- `views/share-admin/index.spec.js` —— **`git diff` 为空**,14 条全绿(含 `:295-307` 的行内钩子闸门与 `:346-350` 的源码文本断言)。
- `views/email/ShareDialog.spec.js` —— **`git diff` 为空**,10 条全绿。**J3 是本次改动的直接安全网**:它钉住 ShareDialog 的请求体仍恰好是四键、且 `not.toHaveProperty` `accountIds`/`authKeyEnabled`/`maxSessions`/`messageLimit` —— 条件展开若写成无条件,这里先红。
- `views/email/ShareIndicator.spec.js` · `views/share/share-chunk.spec.js` —— 未改,全绿。

---

## 7. 浏览器实证(临时 harness 在 `/tmp`,仓内零文件)

harness 全部在 `/tmp/t22-preview/`(vite config + index.html + Harness.vue + main.js + 一个 `@/axios/index.js` 桩),把**真实的 `ShareCreateWizard.vue` + `presets.js` + `request/mail-share.js`** 配真实 element-plus / 真实 `zh.js` / 真实 pinia 挂起来,用 playwright(复用 `tests/e2e/node_modules`,**未写入 tests/e2e**)驱动四个场景。`git status --porcelain` 只有 §1 的六项。

### 7.1 只有浏览器才看得见的两个缺陷(单测全绿时仍存在,已修 + 补测)

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| **B1** | 单邮箱预设下「分享的邮箱」显示占位符,看起来像没选 —— 但请求体里确实带着 `accountIds:[11]` | `v-model` 给了数组,而非 `multiple` 的 `el-select` 渲染不了数组,静默回落占位符 | 加 `mailboxModel` 读写代理:内部恒为数组,对外按 `multiEnabled` 给裸 id 或数组。**补 1 条用例** |
| **B2** | 390px 视口下对话框横向溢出 | `width="680px"` 是死值(recon §8.2 以为 element-plus 有 max-width 兜底 —— 实测没有;`ShareDialog.vue:5` 有同一潜在问题,属 T-23 地盘,本次不碰) | `width="min(680px, calc(100vw - 32px))"` |

另外补了一处可用性缺口:两个一次性输入框原来只有 `aria-label`,视力正常的用户分不清哪个是链接、哪个是密钥 → 加可见 `<label for>`(即 §5.1 的 `shareWizardLinkLabel` / 复用 `shareAuthKey`)。

### 7.2 实证结论(控制台断言,非肉眼)

```
scenario=success        请求体 = {durationSeconds,name,remark,accountIds,onlyMessagesAfterCreated,
                                otpExtractionEnabled,autoRefresh,refreshIntervalMs,showFullAddress,
                                authKeyEnabled}   ← 10 键，全在 12 键白名单内，无 preset*
                        share-admin refresh() 被调用 1 次（@created 真的接上了）
scenario=unknown-then-replay
                        same key on retry: true  (0d0dd288-…)   ← 同一把钥匙
                        create calls: 2                          ← 没有第三次
scenario=fence          authkey disabled: true
                        maxSessions disabled: true
                        messageLimit disabled: true              ← 第四组没漏
                        data-multiple: 0                         ← 多邮箱也降了
无 page error（两条 console.error 是组件自己的诊断日志）
```

---

## 8. 遗留 / 阻塞

**无阻塞项。** 以下是刻意留下的,不是缺口:

| # | 项 | 归属 |
|---|---|---|
| 1 | 44 个 `PENDING_COPY` 键未落盘,英文界面暂显中文;`tf` 需删 | **T-29**(§5.4 现在是四处) |
| 2 | `shareShowFullAddressHint` 两处 fallback 文案分叉 | **T-29** 择一(§5.2) |
| 3 | §4.4 的「列表行正向旁证」(命中即判 active,省掉首次撞墙) | 派单 T22-V2-COLLIDE **HOLD**,登记为 extra |
| 4 | 重放态没有「重建」按钮 | 有意省略:有了它就得配二次确认,而「改表单 → key 自动轮换 → 提交」已经是同一条路。引导文案直接指向列表的撤销/删除 |
| 5 | 邮箱选择器无搜索,只能游标翻页 | `request/account.js` 没有按邮箱搜索的端点(recon T23),超出 T-22 边界 |
| 6 | 表单脏态关闭不二次确认(只有明文未保存时确认) | 与 T-21 同款裁决,有意省略 |
| 7 | `ShareDialog.vue` 的 `width="680px"` 同样在 390px 下溢出 | **T-29 tech-debt**。T-22 对 `views/email/**` 零改动 |
| 8 | worker / E2E 套件未跑 | 纯前端;标记 `unverified` |

**零自主扩张**:除 §7.1 的两处缺陷修复 + 一处可见 label(都由浏览器实证驱动,各自带用例或截图),没有任何超出 recon + 派单的改动。相反做了两处**收缩**:不做 `el-steps`、不做重放「重建」按钮。
