# Recon · T-23 ShareDialog 兼容保持(快捷入口)(W4 第四棒)

| 字段 | 值 |
|---|---|
| 范围 Scope | T-23 / T-23.1,`docs/specs/mailbox-share-capability/tasks.md:492-494` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`,HEAD `c5d6bbd`(T-20 代码在 `672da73`,其上是 approve 文档提交) |
| 侦察日期 | 2026-08-24 11:36 UTC |
| 依据 AC | **AC-CAP-10**(`requirements.md:64`,旧单邮箱 create 载荷继续被接受)、**AC-ADMIN-08**(`requirements.md:162`,ShareDialog 继续可用为快捷创建入口,完整管理 SHALL NOT 塞回对话框) |
| T-21 实时状态 | **未落盘**。`views/share-admin/` 仍只有 `index.vue` / `status.js` / `index.spec.js` 三个文件。T-23 与 T-21 **零文件交集**,可真并行 |
| T-22 实时状态 | 未落盘。T-22 会改 `request/mail-share.js` 的 `createMailShare`(条件展开),T-23 **不碰该文件**,两棒无冲突(§6) |
| 基线 | **本次实测**:`pnpm --dir mail-vue test` → **18 文件 / 113 用例 / EXIT=0**(2026-08-24 11:36) |
| 快照校验 | `ShareDialog.vue` `a60da935…` · `ShareDialog.spec.js` `9cb48f58…` · `ShareIndicator.vue` `81bc5563…` · `ShareIndicator.spec.js` `a3899052…` · `request/mail-share.js` `4621ee26…` · `perm/perm.js` `78475ff6…`。**执行前 `md5sum` 比对,不一致就重读** |
| 性质 | 只读侦察。未改任何生产/测试/spec 文件、未提交;本文件是唯一产物 |
| 已读技能 | frontend-design · impeccable · ui-ux-pro-max · ponytail(**lite**:每处给出更懒的替代,由主 AI/用户点选) |

---

## 0. 一句话结论 · 四个决定成败的事实

**① 这是全 W4 最小的一棒,而且比想象的还小 —— 基线里 T-23 需要的两块地基已经现成。**
- `ShareDialog.spec.js:51` 的 `el-dialog` stub 模板**已经写了 `<slot name="footer" />`**:`'<div class="el-dialog-stub" v-if="modelValue"><slot /><slot name="footer" /></div>'`。加 footer 插槽**不需要动 stub 表**。
- `ShareDialog.spec.js:96-99` 的 `mountDialog()` **已经建了 pinia 并写入 `permKeys: ['share:manage']`**。加权限判据**不需要动挂载基建**。
这两处是 `0151e40` 原始提交就带的(已 `git show` 核实,不是 T-20 加的)。**T-23 的生产代码增量应在 ~20 行量级,spec 增量 3 条用例。任何超出这个量级的方案都该被质疑。**

**② 「跳转」不能用 `useRouter()`,必须用仓内既有的 router 单例 —— 否则 spec 里拿不到可断言的对象。**
`router/index.js:213` 在 `MODE === 'test'` 下 **default 导出 `null`**(注释原文:vitest 导入本模块会在 Pinia 之前触发导航)。因此:
- 组件侧写 `import router from "@/router/index.js"` + `router.push({name: 'share-admin'})` —— 这是全仓 12 处的既有范式(`layout/aside/index.vue:78`、同目录的 `views/email/index.vue:44`)。
- spec 侧必须补 `vi.mock('@/router/index.js', () => ({ default: { push } }))` —— **范式已存在**:`views/share-admin/index.spec.js:25-31` 就是这么写的。
- **反例(别做)**:`useRouter()` 在 ShareDialog.spec 里返回 `undefined`(没装 router 插件),要么静默 no-op 断言不到、要么得给 mount 塞一个真 memory router —— 后者是为了测一个 `push` 而引入整套路由基建。

**③ 权限判据必须自己带 `Array.isArray` 护栏,否则会在无权用户上抛异常。**
`perm/perm.js:23-26` 的 `hasPerm` 直接 `permKeys.includes(...)`;`user.permKeys` 为 `undefined` 时**抛 TypeError**。同目录的 `ShareIndicator.vue:21-27` 已经为此写了 `canManageShare()` 的六行护栏形状 —— **照抄它,不要裸调 `hasPerm`**。
这个判据不是装饰:`share-admin` 路由由 `permsToRouter`(`perm/perm.js:62-72`)在登录时按 `share:manage` **动态 `addRoute`**(`init/init.js:57-60`、`views/login/index.vue:410-413`)。无权用户身上这条路由**根本不存在**,`router.push({name:'share-admin'})` 会抛 vue-router 的 "No match for name"。

**④ 「保持旧契约绿」这句话在 T-23 手上只有一种可执行形态:在组件边界钉住 create 请求体。**
T-22 会把 `createMailShare` 改成条件展开(recon-t22 §0①),而 `request/mail-share.spec.js:51-56` 用 `toEqual` 钉住的是**运输层**形状。T-23 能补、也只该补的是**组件层**形状:`ShareDialog` 传给 `createMailShare` 的第一个实参必须恰为 `{accountId, durationSeconds, name, remark}` 四键。现有 6 条用例里**没有任何一条断言过这个 body**(`:158` 只断言调用次数、`:182-186` 只断言 key)。**这是 T-23 唯一真正新增的回归价值,不是走过场。**

---

## 1. 成功态定义(用户视角,逐条可验)

| # | 用户视角事实 | 验收手段 |
|---|---|---|
| S1 | 邮箱页点「分享」角标 → 对话框照旧开,填名称/备注/时长 → 点「创建」→ 拿到一次性链接。**行为与今天逐帧一致** | `ShareDialog.spec.js` 既有 6 条一字不改仍绿 |
| S2 | 这次创建走的还是**旧四字段单邮箱契约**,后端按 AC-CAP-10 建恰一条 Binding | 新增用例:`createMailShare` 第一个实参 `toEqual` 四键 |
| S3 | 对话框**尾部**多一个「前往分享管理」,点它落到 `/share-admin` | 新增用例:`router.push` 以 `{name:'share-admin'}` 调用恰一次 |
| S4 | 没有 `share:manage` 的人看不到这个入口,也不会因此撞上路由不存在的报错 | 新增用例:`permKeys: []` → 入口不渲染、点不到 |
| S5 | 对话框里**没有**多出绑定管理 / AuthKey / 配额编辑 / 四预设向导。完整管理仍然只在 `/share-admin` | 新增用例(反向闸门):对话框 DOM 内无 `[data-test="share-detail-drawer"]` / `[data-test="share-create-wizard"]` 等管理钩子 |

**S5 的存在理由**:AC-ADMIN-08 的后半句是 `SHALL NOT 塞回对话框`。这是一条**否定式验收**,没有断言就等于没验收。它同时是 T-24 之后任何人往这个对话框加东西时的绊线。

---

## 2. 文件白名单(精确)

### 2.1 允许写(恰 2 个,全在 `views/email/`)

| 文件 | 动作 | 预算 |
|---|---|---|
| `mail-vue/src/views/email/ShareDialog.vue` | **加 `<template #footer>` 插槽 + 一个 perm computed + 一个 `goShareAdmin()` + footer 的 scoped 样式** | 生产代码 **≤25 行**(模板 ~10 / 脚本 ~10 / 样式 ~8) |
| `mail-vue/src/views/email/ShareDialog.spec.js` | **只追加**:1 个 `vi.mock('@/router/index.js')` + 3 条新用例。**既有 6 条断言一字不改** | +~45 行 |

> **本任务不允许改写任何既有断言。** 与 T-21 不同(recon-t21 §4.3 有一条 T-20 预置的交接闸门必须翻面),T-23 的 6 条既有用例**全部**是要保住的基线,`git show 0151e40` 核实它们是 W4 之前的原始资产。**执行者若发现某条既有断言变红,那就是实现做错了,不是断言过时了 —— 停下上报,不要改断言。**

### 2.2 明确不碰

| 文件 | 理由 |
|---|---|
| `mail-vue/src/views/email/ShareIndicator.vue` · `ShareIndicator.spec.js` | §4:零改动结论 |
| `mail-vue/src/views/email/index.vue` | 挂载点已就绪(`:20-32`),`v-model` + `@changed` 接线不变;跳转是对话框内部行为,不需要往上冒泡 emit |
| `mail-vue/src/views/email/build-share-url.js` · `.spec.js` | 只被 import 复用,一个字不改(T-22 也这么约定) |
| **`mail-vue/src/request/mail-share.js` · `mail-share.spec.js`** | **T-22 的写点**(`createMailShare` 条件展开)。T-23 在这里改一行都会和 T-22 撞车,且 T-23 根本不需要新端点 |
| `mail-vue/src/i18n/zh.js` · `en.js` | T-28/T-29 单写者(`tasks.md:27` / `:530`)。T-23 只在 §5 登记键 |
| `mail-vue/src/perm/perm.js` | T-20 刚落 `share:manage` 路由;`hasPerm` / `permsToRouter` 直接消费,不改 |
| `mail-vue/src/router/index.js` | 路由是 `addRoute` 动态注册的,不需要静态声明;`beforeEach` 是 W5 的事 |
| `mail-vue/src/views/share-admin/**` | T-20 已定稿 / T-21 / T-22 的地盘。**T-23 不 rewrite share-admin** |
| `mail-vue/src/layout/**` | T-20 已在 `aside/index.vue:29-33` 加过菜单入口 |
| `mail-vue/src/views/share/**` · `request/share.js` · `composables/useSharePolling.js` | 访客域 W5。从 ShareDialog import 会以「构建失败」形态打红 `share-chunk.spec.js`(它跑真实 vite build) |
| `mail-worker/**` | 后端契约 W3 已封口 |
| `tests/e2e/**` | W6 |

---

## 3. 怎么跳(可直接照抄的形状)

### 3.1 模板:footer 插槽

`el-dialog` 的 `footer` 具名插槽是仓内既有范式(`views/sys-setting/index.vue:565` 等 4 处 `<template #footer><div class="dialog-footer">…`)。ShareDialog 目前**没有** footer,追加即可,**不动 `<el-dialog>` 的任何既有 prop**:

```html
    <!-- 位置:</el-dialog> 之前,share-list 之后 -->
    <template #footer>
      <div class="share-dialog-footer">
        <span class="footer-hint">{{ tf('shareDialogAdminHint') }}</span>
        <el-button v-if="canManage" data-test="goto-share-admin" @click="goShareAdmin">
          {{ tf('shareGotoAdmin') }}
        </el-button>
      </div>
    </template>
```

- `data-test="goto-share-admin"` 是 spec 的唯一钩子。
- 用 `el-button` 而不是裸 `<a href="/share-admin">`:裸链接会整页刷新,丢掉 SPA 状态与已加载的 pinia,是 `back-behavior` / `state-preservation`(ui-ux-pro-max §9)的直接违反。
- **不要**用 `type="primary"`:对话框里唯一的主 CTA 是「创建分享」(`:20`)。一个界面一个 primary(`primary-action`,ui-ux-pro-max §4)。这个跳转是次要出口,用默认(text/default)。
- **不要**用 `v-perm="'share:manage'"` 指令:它在 `main.js` 全局注册,spec 的 `mount` 不注册它 → Vue 只会 warn「Failed to resolve directive」而**照常渲染**,S4 的负例会假绿。而且该指令的实现是 `el.parentNode.removeChild(el)`(`perm/perm.js:18`),对 footer 这种响应式节点是硬删,不可逆。

### 3.2 脚本:三段

```js
import router from "@/router/index.js"          // 与同目录 index.vue:44 同款写法
import { hasPerm } from '@/perm/perm.js'
import { useUserStore } from '@/store/user.js'

// permKeys 缺失时 hasPerm 会在 undefined 上调 includes 抛错;
// 形状照抄同目录 ShareIndicator.vue:21-27,不另立判据。
function canManageShare() {
  const keys = useUserStore().user && useUserStore().user.permKeys
  return Array.isArray(keys) ? hasPerm('share:manage') : false
}
const canManage = computed(() => canManageShare())

function goShareAdmin() {
  emit('update:modelValue', false)          // 先关,再跳
  router.push({ name: 'share-admin' })
}
```

**「先关再跳」不是洁癖**:`el-dialog` 默认 `lock-scroll`,并把自己 teleport 到 body。从 `/inbox` 跳走会连带卸载 `views/email/index.vue` 及其子树,虽然 element-plus 在 unmount 时会解锁,但**开着的遮罩在路由切换的那一帧会闪一下**。显式先关是一行的事(`modal-escape`,ui-ux-pro-max §9)。

**路由名是 `share-admin`**,不是路径字符串:`perm/perm.js:62-72` 里 `path: '/share-admin'` / `name: 'share-admin'`,`views/share-admin/index.spec.js:256-266` 已把这四个 meta 字段钉死。用 name 跳,路径将来变了也不用改这里。

### 3.3 样式:不要抄这个文件自己的历史包袱

`ShareDialog.vue:228-290` 里有一批裸 hex(`#b88230` / `#fdf6ec` / `#dcdfe6` / `#909399` / `#ebeef5` / `#606266`),暗色主题下全坏。**这是 recon-t21 §6.1 点名的历史包袱。T-23 新增的 footer 样式必须走 CSS 变量**(`--secondary-text-color` / `--regular-text-color`),不要"保持风格一致"地再加一个裸 hex。

```css
.share-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;              /* 窄屏换行,不撑破对话框(width 固定 680px) */
}

.footer-hint {
  color: var(--secondary-text-color);
  font-size: 13px;
}
```

注意 `<style scoped>`(不带 `lang="scss"`)是这个文件的现状(`:227`),**保持原样**,别顺手改成 scss —— 那会让 diff 从 25 行变成 65 行。

> ponytail(lite)**更懒的替代**:去掉 `footer-hint` 那行提示,footer 只放一个按钮。省 ~6 行(1 行模板 + 1 个 i18n 键 + 4 行样式)。代价:用户不知道点进去能干什么,「前往分享管理」四个字得自己解释自己。**我按有提示选,主 AI 可以砍。**

---

## 4. ShareIndicator 要不要改 —— **不要,零改动**

结论:**`ShareIndicator.vue` 与 `ShareIndicator.spec.js` 一个字不改。** 四条理由:

1. **职责已经对了。** 它的契约是 AC-MGMT-04:显示**当前邮箱**的 ACTIVE 分享数(`:37-42`)+ `emit('open')`(`:8`)。跳转不是它的职责,任务书原文是「**对话框尾部**加跳转」。
2. **加进来就是导航冗余。** T-20 已经在 `layout/aside/index.vue:29-33` 放了一个 `v-perm="'share:manage'"` 的侧栏菜单项直通 `share-admin`。角标再来一个,同一屏就有三个入口(侧栏 / 角标 / 对话框尾部)指向同一个页面 —— `avoid-mixed-patterns` + `overloaded nav`(ui-ux-pro-max §9)。对话框尾部那个之所以有价值,是因为**用户已经在对话框里、且此刻正需要更多能力**,是上下文出口;角标上的那个则是纯重复。
3. **它的数据来源没有被 W4 动过。** `:50` 的 `listMailShares()` 走的是无参全量分支,`request/mail-share.js:47-52` 的注释与 `mail-share.spec.js:67-76` 的 `toEqual(['/mailShare/list'])` 双向钉死了它。T-20 加分页参数时特意保住了这条路径。**T-23 无事可做。**
4. **它的 spec mock 形状不同,碰它会溢出预算。** `ShareIndicator.spec.js:12-14` 用的是**不带 `importOriginal` 的整模块 mock**(只导出 `listMailShares`)。一旦 ShareIndicator 引入任何第二个 `mail-share.js` 导出,这个 mock 就得改成展开式 —— 无谓的连带改动。

**登记为已知瑕疵(不在 T-23 修)**:ShareIndicator 依赖的是后端**已标记 deprecated 的全量扫描分支**。哪天后端停掉它,角标计数会静默变 0。这是 W2/W3 留下的债,归 T-29 tech-debt 台账,**T-23 不修不删**。

---

## 5. i18n:只登记,不落盘(交 T-29)

T-23 需要 2 个新键。**`i18n/zh.js` 与 `en.js` 一个字不改**(`tasks.md:530` 明写 T-29.2 是单写者)。

| 键 | zh | en |
|---|---|---|
| `shareGotoAdmin` | 前往分享管理 | Go to share management |
| `shareDialogAdminHint` | 绑定多个邮箱、访问密钥、配额与详情都在分享管理页。 | Multi-mailbox binding, access keys, quotas and details all live on the share management page. |

**落盘前怎么渲染** —— 采用 T-20 已审查通过的 `tf()` 回退范式(`views/share-admin/index.vue:109-127`),原样搬一个最小版进 ShareDialog:

```js
const { t, te } = useI18n()      // 现在是 const { t } = useI18n()(:90),加一个 te
const PENDING_COPY = {
  shareGotoAdmin: '前往分享管理',
  shareDialogAdminHint: '绑定多个邮箱、访问密钥、配额与详情都在分享管理页。'
}
function tf(key) { return te(key) ? t(key) : (PENDING_COPY[key] || key) }
```

**必须知道的副作用**:`PENDING_COPY` 只有中文,而 `ShareDialog.spec.js:103` 挂的是 `locale: 'en'`。T-29 落盘前,**英文界面上这两处会显示中文**。T-20 已经在整个 share-admin 页面上接受了同样的取舍(10 个键),T-23 沿用同一口径是一致的,但**这个事实要原文写进 exec note**,不要让审查者以为是 bug。

**spec 的断言纪律**:三条新用例**只断言 `data-test` 钩子、`router.push` 实参、`createMailShare` 实参**,**不断言任何文案**。理由同 recon-t21 §7:键没落盘,文案断言今天是空转的。

> ponytail(lite)**更懒的替代**:不引 `tf()`/`PENDING_COPY`,按钮直接用既有键 `shareManage`(`en.js:340` = `'Share'` / `zh.js:340` = `'分享'`)。零新键、零回退机制、英文下文案还是对的。代价:按钮写着「分享」,和它上面那个「创建分享」主按钮语义撞车,用户读不出"这是个跳转"。**见迷雾 F1,建议主 AI 裁决。**

---

## 6. 与 T-21 / T-22 的边界(T-23 明确**不做**什么)

| 别人的东西 | T-23 的动作 |
|---|---|
| T-21 的 `ShareDetailDrawer.vue` / `ShareRowActions.vue`(绑定增删 / 配置 diff / AuthKey 三迁移) | **不搬进对话框、不 import、不做简版**。S5 用例正面挡住 |
| T-21 计划往 `views/share-admin/status.js` 追加的 `isMutableStatus` | 不用、不抢这个写点。对话框只显示 `effectiveStatus` 文案,`ShareDialog.vue:128-135` 的 `statusLabel` 三态映射**保持原样**(它只认 ACTIVE/EXPIRED/REVOKED,不认 `ACCESS_LIMIT_REACHED` —— 那是**旧契约的一部分**,改它就破 S1) |
| T-22 的 `ShareCreateWizard.vue` / `presets.js`(四预设 / V2 降级 / 幂等恢复) | **不搬、不预留插槽、不抽公共组件**。对话框的创建区(`:9-23`)一行不改 |
| T-22 对 `createMailShare` 的条件展开 | **不碰该函数**。反过来,T-23 新增的 body 断言是 T-22 的**安全网**:T-22 若把条件展开写错(比如无脑塞 `accountIds: []`),`ShareDialog.spec.js` 会替它红 |
| T-22 计划复用的一次性密钥展示模式(recon-t21 §5 / recon-t22 §6) | **不抽 `OneShotSecret.vue`**。ShareDialog 的四段模式(模板 `:25-39` / 派生 `:109-126` / 关闭即清 `:152-159` / 唯一赋值点 `:161-189`)是被 `:144-162` 钉住的**原件**,T-23 的职责是让它保持不动,不是重构它 |
| T-20 的 `views/share-admin/index.vue` 列表页 | **不 rewrite、不改一个字**。跳转只用路由名,不 import 任何 share-admin 文件 |

**文件冲突结论**:T-23 的两个文件与 T-21(7 个文件)、T-22(6 个文件)**交集为空**。W4 「T-21/T-22/T-23 不同文件并行」的假设在 T-23 这一支**成立**(在 T-21↔T-22 之间不成立,见 recon-t21 §4.4 / recon-t22 §0⑤)。

---

## 7. T-23.1 红灯清单(恰 3 条新增)

主文件 `mail-vue/src/views/email/ShareDialog.spec.js`。**只在文件头补一个 mock,在 describe 里追加 3 条 `it`。**

**基建增量(唯一一处非 `it` 的改动)**:
```js
const { createMailShare, listMailShares, revokeMailShare, confirm, routerPush } = vi.hoisted(() => ({
    …既有四个不动…,
    routerPush: vi.fn()
}))
// 范式与 views/share-admin/index.spec.js:25-31 同款
vi.mock('@/router/index.js', () => ({ default: { push: routerPush } }))
```
> mock 的模块字符串**与组件里的 import 字符串写成同一个**(`@/router/index.js`),消除任何别名解析的不确定性。`beforeEach` 里加 `routerPush.mockReset()`。
> `mountDialog()` 需要能接受空权限:把 `useUserStore().user = { permKeys: ['share:manage'] }` 改成 `useUserStore().user = { permKeys }`,`permKeys` 默认值 `['share:manage']`。**这是形参默认值的追加,不是断言改写**,既有 6 条调用点不需要动。

| # | 用例 | 关键断言 | 覆盖 |
|---|---|---|---|
| **J1** | 尾部跳转落到 share-admin | 点 `[data-test="goto-share-admin"]` → `routerPush` 调用恰 1 次且实参 `toEqual({name: 'share-admin'})`;并断言 `wrapper.emitted('update:modelValue')` 最后一次是 `[false]`(先关再跳) | AC-ADMIN-08 |
| **J2** | 无 `share:manage` 时不给这个出口 | `mountDialog({}, [])`(空 permKeys)→ `[data-test="goto-share-admin"]` 不存在;`routerPush` 零调用。**同时断言创建区仍在**(`[data-test="create-share"]` 存在)—— 证明降级的是入口不是整个对话框 | AC-ADMIN-08 · §0③ |
| **J3** | ★旧四字段 create 契约不变 + 管理能力没被塞回来 | ① 点创建 → `createMailShare.mock.calls[0][0]` **`toEqual`** `{accountId: 11, durationSeconds: 3600, name: '', remark: ''}`(显式 `not.toHaveProperty('accountIds')` / `('authKeyEnabled')` / `('maxSessions')` / `('messageLimit')`)<br>② 同一 wrapper 上断言对话框内**不存在**任何管理钩子:`[data-test="share-detail-drawer"]` / `[data-test="share-create-wizard"]` / `[data-test="binding-add"]` / `[data-test="authkey-once"]` 全为 `false` | **AC-CAP-10** · **AC-ADMIN-08 后半句** |

**J3 的两半为什么合一条**:它们是同一个命题的两面 ——「这个对话框仍然只是旧的快捷创建入口」。拆成两条会让 fixture 重复一遍而断言价值不增。若审查要求拆,拆成 J3a/J3b 也行,**但 `toEqual` 的四键断言一条都不能少**。

### 必须继续绿的既有断言(全部,零改写)

- `views/email/ShareDialog.spec.js` **既有 6 条**(`:136` 风险告警 / `:144` 明文只出现一次且不进列表 / `:164` 同 key 重试 / `:189` 撤销需确认 / `:206` 渲染 API 的 `effectiveStatus` / `:223` 访问计数措辞)。
- `views/email/ShareIndicator.spec.js` 2 条 —— T-23 不碰该组件,天然绿。
- `views/email/build-share-url.spec.js` —— 不碰。
- `request/mail-share.spec.js` 6 条 —— T-23 对 request 层零改动。
- `views/share-admin/index.spec.js` 全部(含 `:243-252` 那条 T-20 留给 T-21 的交接闸门)—— **T-23 不得触发它**;只要不 import share-admin 就天然安全。
- `views/share/share-chunk.spec.js` —— 它跑**真实 vite build**,是事实上的构建闸门。ShareDialog 新增的两个 import(`@/router/index.js` / `@/perm/perm.js`)都是登录态既有依赖,且 `views/email/index.vue:44,48` 已经在同一条链上引过 router,**不会引入新的跨域耦合**。但执行后必须实跑一次确认。
- `init/init.spec.js` · `router/index.spec.js` —— 不碰。

---

## 8. 设计判定(impeccable:Operate 模式)

这是登录态邮箱页里的一个**任务型对话框**。impeccable 的 Operate 定义直接适用:可扫读性 / 一致性 / 原生预期 **>** 表达欲。frontend-design 那套「大胆美学 / 特色字体 / 渐变网格」在这里是**反指标** —— T-23 的整个任务性质就是「什么都别变」。

已按上述判定内化的决策(**不再单独请示**):

- **位置在 footer,不在正文顶部**:正文顶部第一行是 `shareCreateWarning` 风险告警(`:8`),那是这个对话框的语义锚点,不能被一个导航链接抢在前面。footer 是"我在这儿做完了,接下来去哪"的天然位置。
- **单个次级按钮 + 一行说明,不做 banner / 不做 el-alert**:`el-alert` 会带来图标+边框+背景色三层视觉重量,在一个已经有黄色告警块(`:228-232`)的对话框里再加一块,是 `whitespace-balance` 的直接违反。
- **不加图标**:加了就得进 `@iconify/vue`,而这个对话框目前**零图标**。破坏 `icon-style-consistent`,换不来任何理解增益。
- **触控目标**:`el-button` 默认 32px 高,低于 44px 建议值。**接受现状** —— 这个对话框里现有的 3 个按钮(创建/复制/撤销)全是默认尺寸,单独把 footer 那个放大成 `size="large"` 反而是不一致。登记为与全仓一致的已知偏差。
- **窄屏**:`el-dialog` 固定 `width="680px"`(`:5`),窄屏由 element-plus 自身收窄。footer 用 `flex-wrap: wrap` 兜住换行即可,**不新增 `@media` 断点**(这个文件目前一个媒体查询都没有,加第一个就是给 T-29 留一处新的口径分歧)。
- **不动 `<el-dialog>` 的任何既有 prop**:不加 `destroy-on-close`、不加 `append-to-body`、不改 `width`。这些都会改变既有生命周期,而 `:152-159` 的「关闭即清明文」正建立在当前生命周期上。

---

## 9. 迷雾清单(需要主 AI / 用户裁决,恰 3 条)

> 其余已由本侦察裁决:用 router 单例不用 `useRouter` · 路由用 name 不用 path · 先关对话框再跳 · footer 插槽不动 stub 表 · ShareIndicator 零改动 · 不抽 `OneShotSecret` · 不改裸 hex · 不加图标 · 不加媒体查询 · 不动 `el-dialog` 既有 prop · 既有 6 条断言零改写。

**F1 · i18n 落盘前的文案策略:抄 T-20 的 `tf()`/`PENDING_COPY`,还是复用既有键 `shareManage`?**
- **抄 `tf()`(建议)**:文案语义准确(「前往分享管理」),与 T-20 已审查通过的口径一致。代价:把一个**临时机制**复制到第二个文件,且 T-29 落盘前**英文界面会显示中文**;T-29 收口时要记得删两处 `PENDING_COPY` 而不是一处。
- **复用 `shareManage`**:零新键、零机制、英文下文案正确。代价:按钮写「分享 / Share」,和上方主按钮「创建分享 / Create share」语义撞车,读不出这是个跳转。
- **需要点头的原因**:这不是 T-23 单个任务的取舍 —— 它决定 T-29 要清理几处临时回退,属于 W4 的口径问题。

**F2 · footer 要不要做第二道 `hasPerm` 判定?**
对话框的**唯一入口**是 `ShareIndicator`,而后者本身已经 `v-if="canManage"`(`ShareIndicator.vue:4`)。严格说,无权用户根本打不开这个对话框,footer 的 `v-if="canManage"` 是**第二处同判据**(ponytail 反对重复判据)。
- **判(建议)**:它是 `router.push({name:'share-admin'})` 在路由未注册时抛 vue-router 异常的**唯一防线**(§0③),而且 J2 这条负例是可断言的真回归;成本是 6 行 + 一次 `useUserStore` 调用。
- **不判**:省 6 行 + 一条用例,依赖「入口已挡」这个不变量。风险:哪天有人从别处复用 ShareDialog(比如 T-24 之后的重构),这个不变量静默失效。
- **需要点头的原因**:这是「防御深度 vs 单一判据」的取舍,而本项目在 `ShareIndicator.vue:21-27` / `:44-47` 已经有过一次「同一判据写两遍」的先例(渲染时判一次、refresh 时再判一次)—— 说明仓内口径倾向于判,但值得主 AI 确认。

**F3 · 顺手修 `ShareDialog.vue:228-290` 的裸 hex 吗?**
这个文件有 6 处裸 hex,暗色主题下配色是坏的(recon-t21 §6.1 已点名为历史包袱)。T-23 是**唯一**被授权写这个文件的任务,不趁现在改,下一次有人打开它可能是 T-29 之后。
- **不改(建议)**:T-23 的任务性质是「兼容保持」,改样式会让 diff 从 ~25 行涨到 ~40 行且引入视觉回归风险,而 spec 里**没有任何断言能守住配色** —— 改坏了没人知道。登记进 T-29 的 tech-debt 台账。
- **改**:一次性还清,6 处变量替换。
- **需要点头的原因**:「顺手修历史包袱」在本项目是需要授权的越界动作(和 T-16 之后的几次裁决同性质),不该由执行者静默决定。

---

## 10. 风险与陷阱

| # | 风险 | 处置 / 防线 |
|---|---|---|
| **R1** | ★用 `useRouter()` → 测试里是 `undefined`,`router?.push` 静默 no-op,J1 假绿或直接报错 | §0② · 用 `import router from "@/router/index.js"` + `vi.mock` |
| **R2** | ★裸调 `hasPerm('share:manage')`,`permKeys` 为 undefined 时抛 TypeError 炸掉整个对话框 | §0③ · 照抄 `ShareIndicator.vue:21-27` 的 `Array.isArray` 护栏 |
| **R3** | ★无权用户身上 `share-admin` 路由**根本没注册**(`addRoute` 动态),`push` 抛 "No match for name" | §0③ · F2 的 `v-if="canManage"` 就是这条的防线 |
| **R4** | ★用 `v-perm` 指令做权限:spec 不注册指令 → 只 warn 不删节点 → J2 假绿 | §3.1 · 用 `v-if` + computed |
| **R5** | 顺手把 stub 表 / `mountDialog` 大改,连带打红既有 6 条 | footer slot 与 pinia 权限**基线已就绪**(§0①),`mountDialog` 只加一个形参默认值 |
| **R6** | 把 `statusLabel`(`:128-135`)"补全"成四态(加 `ACCESS_LIMIT_REACHED`) | **旧契约的一部分**。这是 share-admin `status.js` 的职责,对话框加了就是把管理能力往回塞 · S1/S5 |
| **R7** | 顺手改 `createMailShare`(想"顺便支持新字段") | §2.2 · 那是 T-22 的写点,改了必冲突 |
| **R8** | 把提示做成 `el-alert`,而 stub 表里 `el-alert`(`:71-74`)恰好存在 → 编译过、视觉重量爆炸 | §8 · 用一个 `<span>` |
| **R9** | 跳转时不关对话框 → 路由切换那帧遮罩闪烁 / body scroll-lock 竞态 | §3.2 · 先 `emit('update:modelValue', false)` |
| **R10** | 新增 import 触发 `share-chunk.spec.js` 以"构建失败"形态红 | §7 末 · 两个新 import 都在既有登录态链上;执行后实跑确认 |
| **R11** | footer 用裸 `<a href>` → 整页刷新,丢 SPA 状态 | §3.1 |
| **R12** | 基于**记忆**而非当前文件写代码(T-21/T-22 都还没落盘,share-admin 随时会变) | 执行前 `md5sum` 比对表头六个哈希 |
| **R13** | 偷偷改 i18n 文件 | §2.2 · T-29 单写者 |
| **R14** | 改写既有 6 条断言里的任意一条 | §2.1 · 与 T-21 不同,T-23 **没有**任何被授权的断言翻面。红了就上报 |

---

## 11. 验证命令与基线

```bash
# 定点(红 → 绿)
pnpm --dir mail-vue exec vitest run src/views/email/ShareDialog.spec.js --no-cache

# 邻接回归(同域 + 契约相邻 + 构建闸门)
pnpm --dir mail-vue exec vitest run \
    src/views/email/ShareIndicator.spec.js \
    src/views/email/build-share-url.spec.js \
    src/request/mail-share.spec.js \
    src/views/share-admin/index.spec.js \
    src/views/share/share-chunk.spec.js

# 全量(基线 18 文件 / 113 用例,2026-08-24 11:36 实测 EXIT=0)
pnpm --dir mail-vue test

# 构建(T-20 收口时跑过绿;footer 是纯模板增量,仍应复跑)
pnpm --dir mail-vue build
```

**基线口径**:vue **18 文件 / 113 用例**(本次实测)· worker 18 / 619 · E2E 13。
T-23 是**纯前端、且不碰 request 层**的任务,`pnpm --dir mail-worker test` 与 `node tests/e2e/run.mjs` **不跑**,exec note 按惯例标 `unverified`,**不假称绿**。
交付判据:定点 6 → **9** 条全绿(只增不减),全量与 18/113 比 **只增不减**。

---

## 12. 执行前自检清单

- [ ] 表头六个 `md5sum` 与当前工作树一致;不一致就重读 `ShareDialog.vue` / `.spec.js` / `ShareIndicator.*` / `request/mail-share.js` / `perm/perm.js`
- [ ] §9 三条迷雾已取得裁决(i18n 策略 / footer 是否二次判权 / 裸 hex 修不修)
- [ ] 改动**只有 2 个文件**,都在 `mail-vue/src/views/email/`;`git status` 里没有第三个
- [ ] `ShareDialog.spec.js` 既有 **6 条断言一字未改**;只追加了 mock、`mountDialog` 的形参默认值、3 条 `it`
- [ ] 跳转走 `import router from "@/router/index.js"` + `router.push({name: 'share-admin'})`;spec 的 `vi.mock` 字符串与之**逐字相同**
- [ ] 权限判据带 `Array.isArray` 护栏,形状与 `ShareIndicator.vue:21-27` 一致;**没有**用 `v-perm` 指令
- [ ] 点击时**先** `emit('update:modelValue', false)` **再** push
- [ ] J3 的 `toEqual` 四键断言在位,且显式 `not.toHaveProperty` 了 `accountIds`/`authKeyEnabled`/`maxSessions`/`messageLimit`
- [ ] S5 反向闸门在位:对话框内无 drawer / wizard / binding / authkey 钩子
- [ ] `<el-dialog>` 的既有 prop 一个没动;`statusLabel` 三态映射一个没动;创建区 `:9-23` 一行没动
- [ ] footer 新增样式**零裸 hex**,走 `--secondary-text-color` 等变量;`<style scoped>` 未改成 scss;未新增 `@media`
- [ ] `zh.js` / `en.js` 一字未改;§5 的两个键原样进 exec note
- [ ] `request/mail-share.js` / `mail-share.spec.js` / `views/share-admin/**` / `ShareIndicator.*` 改动 **0 行**
- [ ] 定点 9/9 绿;邻接 5 份全绿(含跑真实 build 的 `share-chunk.spec.js`);`pnpm --dir mail-vue test` ≥ 18/116;`pnpm --dir mail-vue build` 绿
- [ ] exec note 写明:英文 locale 下两处新文案在 T-29 前显示中文(若采纳 F1 的 `tf()` 方案)

---

## 13. 参考锚点索引

```
契约   docs/specs/mailbox-share-capability/requirements.md:64(AC-CAP-10)、:162(AC-ADMIN-08)
       docs/specs/mailbox-share-capability/tasks.md:492-494(T-23)、:546-547(W4 并行说明)
       :27 / :530(i18n 单写者 = T-28/T-29)
前端   mail-vue/src/views/email/ShareDialog.vue:1-7(el-dialog 既有 prop,勿动)
       :8(风险告警,语义锚点)、:9-23(创建区,勿动)、:25-39(★一次性明文展示)
       :41-74(列表区)、:75(★</el-dialog> —— footer 插槽插入点)
       :85-91(props/emits/useI18n —— 加 te 的位置)、:109-126(派生值)
       :128-135(★statusLabel 三态,旧契约的一部分)、:152-159(关闭即清)
       :161-189(★submitCreate —— 四字段 body 的唯一产地)、:227-291(★裸 hex 历史包袱)
       mail-vue/src/views/email/ShareDialog.spec.js:8-13(hoisted mocks)
       :48-76(★stub 表 —— :51 已含 footer slot)、:96-116(★mountDialog —— :99 已写 permKeys)
       :136-230(★既有 6 条,零改写)、:158(只断言次数,未断言 body ← T-23 的空白)
       mail-vue/src/views/email/ShareIndicator.vue:4(v-if canManage)、:21-27(★权限护栏形状)
       :44-56(refresh + 无参 list)、:58(defineExpose)
       mail-vue/src/views/email/ShareIndicator.spec.js:12-14(不带 importOriginal 的整模块 mock)
       mail-vue/src/views/email/index.vue:20-32(挂载点)、:44(router import 范式)、:80-82(onShareChanged)
       mail-vue/src/perm/perm.js:3-21(v-perm 指令:硬删节点)、:23-26(★hasPerm 无护栏)
       :29-37(permsToRouter)、:62-72(★share-admin 路由定义:path/name/meta)
       mail-vue/src/router/index.js:143-178(beforeEach)、:213(★MODE==='test' → default 为 null)
       mail-vue/src/init/init.js:57-60 · mail-vue/src/views/login/index.vue:410-413(★addRoute 动态注册)
       mail-vue/src/layout/aside/index.vue:29-33(T-20 已有的侧栏入口 + router.push 范式)
       mail-vue/src/views/share-admin/index.vue:109-127(★tf()/PENDING_COPY 回退范式)
       mail-vue/src/views/share-admin/index.spec.js:25-31(★vi.mock('@/router') 范式)
       :243-252(T-20 留给 T-21 的交接闸门 —— T-23 不得触发)、:255-273(路由 perm 断言)
       mail-vue/src/request/mail-share.js:19-31(★createMailShare 四字段 —— T-22 的写点)
       :47-52(无参 list 的 deprecated 分支注释)
       mail-vue/src/request/mail-share.spec.js:40-58(★运输层 toEqual 四键)、:67-76(无参 list)
       mail-vue/src/views/sys-setting/index.vue:565-573(el-dialog #footer 范式)
       mail-vue/src/views/share/assert-share-chunk.js:10-15(FORBIDDEN 表 —— 跑真实 vite build)
       mail-vue/vitest.config.js(mode='test' + jsdom + element-plus inline)
前锋   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-t21-drawer.md
       §5(一次性明文四段模式)、§6.1(★裸 hex 历史包袱点名)、§9.2(把 views/email/** 划给 T-23)
       .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-t22-wizard.md
       §0①(createMailShare 四字段写死)、§2.2(把 views/email/** 划给 T-23)、§2.3(index.vue 锚点)
       .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-t20-share-admin.md
```
