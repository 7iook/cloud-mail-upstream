# Exec Note · T-23 ShareDialog 兼容保持 + 前往分享管理(W4 第四棒)

| 字段 | 值 |
|---|---|
| 任务 | T-23 / T-23.1 · ShareDialog 旧契约保持 + 尾部跳转 share-admin |
| 分支 | `cursor/mailbox-share-capability-dcb6`(**未 commit / 未 push / 未 stash / 未切分支**) |
| HEAD | `00b0ae1`(T-21 已落盘) |
| 执行日期 | 2026-08-24 |
| 依据 | `recon-t23-sharedialog.md` + `prompt.t23.exec.txt`(三条迷雾已由派单裁决,见 §3) |
| 依据 AC | **AC-CAP-10**(旧单邮箱 create 载荷继续被接受)· **AC-ADMIN-08**(对话框仍是快捷创建入口,完整管理 SHALL NOT 塞回对话框) |
| 已读技能 | frontend-design · impeccable · ui-ux-pro-max · ponytail(lite) |
| 基线 | vue 20 文件 / **153** 用例 → 20 文件 / **157** 用例,只增不减 |

---

## 1. 改动文件(恰 2 个生产/测试文件,全部在白名单内)

| 文件 | 性质 | 行数 | 内容 |
|---|---|---|---|
| `mail-vue/src/views/email/ShareDialog.vue` | 改 | +40 / -1 | `<template #footer>` 一个次级按钮 + `tf()`/`PENDING_COPY` + `canManageShare()` + `goShareAdmin()` |
| `mail-vue/src/views/email/ShareDialog.spec.js` | 改(**只扩不改**) | +79 / -4 | `vi.mock('@/router/index.js')` + `mountDialog` 第二形参 + `routerPush.mockReset()` + 4 条新用例 |
| 本文件 | 新建 | — | exec note |

**执行前 `md5sum` 比对通过**(recon 表头六个哈希,`ShareIndicator.spec.js` 与 recon 记录的截断值差最后一位,该文件本任务零改动,不影响)。

**明确 0 行改动**(`git status --porcelain` 实测确认只有上述两个 ` M`):
`mail-vue/src/request/mail-share.js` · `mail-share.spec.js` · `views/share-admin/**` · `views/email/ShareIndicator.vue` · `ShareIndicator.spec.js` · `views/email/index.vue` · `build-share-url.js` · `i18n/zh.js` · `i18n/en.js` · `router/index.js` · `perm/perm.js` · `layout/**` · `mail-worker/**` · `tests/e2e/**`。

---

## 2. 红 → 绿

```
红   pnpm --dir mail-vue exec vitest run src/views/email/ShareDialog.spec.js --no-cache
     → 10 tests | 1 failed
       × closes itself before landing the owner on share-admin (AC-ADMIN-08)
         Unable to get [data-test="goto-share-admin"] within: <div class="el-dialog-stub" …>
     （J2 / J3 / S5 是否定式闸门,改动前天然绿——它们守的是「不许出现/不许改变」,
       其红灯形态是未来某人加错东西时才触发,这是设计意图,不是空转。J1 是唯一的正向红。）

绿(定点+相邻) ShareDialog / ShareIndicator / request-mail-share             3 文件 / 18 用例
绿(定点+邻接) 上述 + share-admin/index + share/share-chunk + build-share-url  6 文件 / 35 用例
绿(全量)      pnpm --dir mail-vue test -- --no-cache                        20 文件 / 157 用例
绿(构建)      pnpm --dir mail-vue build                                     ✓ built in 6.79s
```

`share/share-chunk.spec.js`(跑**真实 vite build** 的构建闸门)绿 —— 证实新增的 `@/router/index.js` / `@/perm/perm.js` / `@/store/user.js` 三个 import 没有把登录态依赖拖进访客 chunk(R10 已排除)。

**跨栈基线**:worker 18 文件 / 619 用例、E2E 13 —— 本任务纯前端且不碰 request 层,两者**未跑,标记 `unverified`**(非假称绿)。

---

## 3. 三条迷雾的落地形态(派单裁决 → 实现)

### F1 · i18n 策略 → 采纳 `tf()` + `PENDING_COPY`,但**只一个键**

派单 T23-COPY 明令:`shareGoAdmin` 一个新键,不复用 `shareManage`。同时把 recon §3.1 里的 `shareDialogAdminHint` 提示行**砍掉**(ponytail lite 给出的更懒替代被采纳):footer 只有一个按钮,省 1 个 i18n 键 + 1 行模板 + 整块 CSS。

```js
const { t, te } = useI18n()
const PENDING_COPY = { shareGoAdmin: '前往分享管理' }
function tf(key) { return te(key) ? t(key) : (PENDING_COPY[key] || key) }
```

### F2 · footer 二次判权 → **判**(派单 T23-PERM)

```js
function canManageShare() {
  const keys = useUserStore().user && useUserStore().user.permKeys
  if (!Array.isArray(keys)) { return false }
  return hasPerm('share:manage')
}
const canManage = computed(() => canManageShare())
```

形状与 `ShareIndicator.vue:21-27` **逐行相同**,两处不会各自漂移。**没有**用 `v-perm` 指令(spec 不注册指令 → 只 warn 不删节点 → J2 会假绿;且该指令实现是 `parentNode.removeChild`,对响应式节点是硬删)。

这条判据不是装饰:`share-admin` 路由由 `permsToRouter` 在登录时按 `share:manage` **动态 `addRoute`**,无权用户身上这条路由根本不存在,`router.push({name:'share-admin'})` 会抛 vue-router 的 "No match for name"。

### F3 · 裸 hex → **HOLD**(派单 T23-HEX)

`ShareDialog.vue` 的 6 处裸 hex(`#b88230` / `#fdf6ec` / `#dcdfe6` / `#909399` / `#ebeef5` / `#606266`)**一个字未动**。本次 footer **零新增 CSS**(单个 `el-button` 直接放在 `#footer` 插槽里,右对齐由 element-plus 的 `.el-dialog__footer` 原生承担),因此「新增样式零裸 hex」是以「零新增样式」的形式满足的。裸 hex 继续挂在 T-29 tech-debt 台账。

---

## 4. 跳转的落地形态

```js
import router from '@/router/index.js'   // 与同目录 index.vue:44 同款,不是 useRouter()

function goShareAdmin() {
  emit('update:modelValue', false)       // 先关
  router.push({ name: 'share-admin' })   // 再跳,用 name 不用 path
}
```

- **为什么不用 `useRouter()`**:`router/index.js:213` 在 `MODE === 'test'` 下 default 导出 `null`,而 `ShareDialog.spec.js` 没装 router 插件 —— `useRouter()` 会返回 `undefined`,J1 要么静默 no-op 假绿,要么得为一次 `push` 引入整套 memory router。
- **为什么先关再跳**:`el-dialog` 默认 `lock-scroll` 且 teleport 到 body;路由切换会卸载 `views/email/index.vue` 整棵子树,开着的遮罩在那一帧会闪。见 §6 第三张截图:点击后对话框已消失、`router.push` 已记录。
- spec 的 `vi.mock` 模块字符串与组件 import 字符串**逐字相同**(`@/router/index.js`),消除别名解析的不确定性。

---

## 5. 🔴 i18n 新增键(交 T-29 落盘,zh.js / en.js 一字未改)

| 键 | zh | en | 用处 |
|---|---|---|---|
| `shareGoAdmin` | 前往分享管理 | Go to share management | ShareDialog footer 跳转按钮 |

**复用的既有键(零新增)**:本次未复用任何键,footer 只有这一处文案。

### ⚠️ 必须写进审查视野的副作用

`PENDING_COPY` **只有中文**,而 `ShareDialog.spec.js` 挂的是 `locale: 'en'`。**T-29 落盘前,英文界面上这个按钮会显示中文「前往分享管理」。** 这是 T-20 已在整个 share-admin 页面(10 个键)接受过的同一口径,T-23 沿用是一致的 —— **不是 bug**。

### T-29 收口清单(现在是两处,不是一处)

| # | 位置 | 要删的东西 |
|---|---|---|
| 1 | `views/share-admin/index.vue:115-133` | `PENDING_COPY`(10 键)+ `tf` helper,约 15 行 |
| 2 | **`views/email/ShareDialog.vue`(本次新增)** | `PENDING_COPY`(1 键 `shareGoAdmin`)+ `tf` helper,约 9 行;模板里 `tf('shareGoAdmin')` 换回 `t('shareGoAdmin')`;`useI18n()` 的 `te` 解构可一并去掉 |

---

## 6. 用例清单(`ShareDialog.spec.js`:既有 6 条零改写 + 新增 4 条 = 10 条)

| # | 用例 | 关键断言 | 覆盖 |
|---|---|---|---|
| **J1** | closes itself before landing the owner on share-admin | 点 `[data-test="goto-share-admin"]` → `emitted('update:modelValue')` **最后一次**是 `[false]`;`routerPush` 恰 1 次且实参 `toEqual({name:'share-admin'})` | AC-ADMIN-08 |
| **J2** | hides the share-admin jump from owners without share:manage | `{permKeys:['email:send']}` → 钩子不存在、`[data-test="create-share"]` **仍在**(降级的是入口不是对话框);`{}`(permKeys 缺失)→ 钩子不存在**且不抛 TypeError**;`routerPush` 零调用 | AC-ADMIN-08 · R2 · R3 |
| **J3** | still creates with the old single-mailbox four-field body | `createMailShare.mock.calls[0][0]` **`toEqual`** `{accountId:11, durationSeconds:3600, name:'', remark:''}`,并显式 `not.toHaveProperty` `accountIds` / `authKeyEnabled` / `maxSessions` / `messageLimit` | **AC-CAP-10** |
| **S5** | keeps full share management out of the dialog | 对话框 DOM 内 `share-detail-drawer` / `share-create-wizard` / `binding-add` / `authkey-once` 四个钩子全为 `false` | **AC-ADMIN-08 后半句** |

**J3 是 T-22 的安全网**:T-22 会把 `createMailShare` 改成条件展开,`request/mail-share.spec.js` 钉的是**运输层**形状,J3 钉的是**组件层**形状 —— T-22 若无脑塞 `accountIds: []`,这里会先红。这是 T-23 唯一真正新增的回归价值。

**S5 是否定式验收的绊线**:AC-ADMIN-08 的「SHALL NOT 塞回对话框」没有断言就等于没验收。它同时挡住 T-24 之后任何人往这个对话框加管理能力。

### 基建增量(唯一三处非 `it` 的改动,均为追加)

1. `vi.hoisted` 补 `routerPush`;`vi.mock('@/router/index.js', () => ({ default: { push: routerPush } }))`
2. `mountDialog(props = {}, user = { permKeys: ['share:manage'] })` —— **形参默认值追加**,既有 6 条调用点 `mountDialog()` 行为完全不变;J2 靠它注入 `{permKeys:['email:send']}` 与 `{}`
3. `beforeEach` 加 `routerPush.mockReset()`

**既有 6 条断言一字未改**(`git diff` 实测:`:136-230` 区间零 `-` 行)。

---

## 7. 浏览器实证(临时 harness,在 `/tmp`,仓内零文件)

harness 全部在 `/tmp/t23-preview/`(vite config + index.html + main.js + 一个 `@/axios/index.js` 桩),把**真实的 `ShareDialog.vue`** 配真实 element-plus / 真实 `zh.js` 挂起来,headless chrome 截图。**仓内没有落任何 harness 文件**,`git status --porcelain` 只有 §1 的两个 ` M`。

| artifact | 证明 |
|---|---|
| `sharedialog_footer_jump_owner_with_share_manage.png` | `permKeys:['share:manage']` → footer 右下角「前往分享管理」为**次级按钮**,与上方蓝色主 CTA「创建分享」视觉层级分明(一屏一 primary) |
| `sharedialog_no_jump_without_share_manage.png` | `permKeys:[]` → footer 控件**完全不渲染**(连空 footer 高度都没有);创建区 + 列表区 + 风险告警一字不差还在 |
| `sharedialog_closes_then_pushes_share_admin.png` | 点击后:对话框**已关闭**,页面上记录 `router.push({"name":"share-admin"})` —— 先关再跳的顺序实证 |
| `t23_sharedialog_targeted_and_adjacent_specs.log` | 6 文件 / 35 用例 verbose 全绿(含跑真实 vite build 的 `share-chunk.spec.js`) |

---

## 8. 遗留 / 阻塞

**无阻塞项。** 以下是刻意留下的,不是缺口:

| # | 项 | 归属 |
|---|---|---|
| 1 | `shareGoAdmin` 未落盘,英文界面暂显中文;`PENDING_COPY` + `tf` 需删 | **T-29**(见 §5 收口清单,现在是**两处**) |
| 2 | `ShareDialog.vue:228-290` 的 6 处裸 hex,暗色主题下配色坏 | **T-29 tech-debt**。派单 T23-HEX 明令 HOLD |
| 3 | `ShareIndicator` 依赖后端已 deprecated 的全量扫描分支;后端停掉后角标计数会静默变 0 | **T-29 tech-debt**。T-23 对 ShareIndicator 零改动 |
| 4 | footer 按钮高度 32px(el-button 默认),低于 44px 触控建议值 | 与对话框内既有 3 个按钮(创建/复制/撤销)一致;单独放大反而破一致性。登记为全仓一致的已知偏差 |
| 5 | `createMailShare` 的条件展开 | **T-22**。T-23 零改动该文件,J3 是它的安全网 |
| 6 | worker / E2E 套件未跑 | 纯前端且不碰 request 层;标记 `unverified` |

**零自主扩张**:本次没有任何超出 recon + 派单的改动。相反做了一处**收缩** —— 砍掉 recon §3.1 的 `shareDialogAdminHint` 提示行(派单只批了一个键),连带省掉整块 `.share-dialog-footer` CSS。若评审认为 footer 光一个「前往分享管理」缺少解释力,加回提示行需要:1 行模板 + 1 个 i18n 键 + 6 行 flex 样式,无测试变化。
