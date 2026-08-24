# Exec Note · T-20 分享管理列表页(W4 第一棒)

| 字段 | 值 |
|---|---|
| 任务 | T-20 / T-20.1 / T-20.2 · share-admin 路由 + 列表页 |
| 分支 | `cursor/mailbox-share-capability-dcb6`(**未 commit / 未 push / 未 stash / 未切分支**) |
| 执行日期 | 2026-08-24 |
| 依据 | `recon-t20-share-admin.md` + `prompt.t20.exec.txt`(三条迷雾已由派单裁决:aside 纳入 · 行操作归 T-21 · 卡片列表) |
| 已读技能 | frontend-design · impeccable · ui-ux-pro-max · ponytail(lite) |
| 基线 | vue 17 文件 / 95 用例 → **18 文件 / 113 用例**,只增不减 |

---

## 1. 改动文件(全部在白名单内)

| 文件 | 性质 | 行数 | 内容 |
|---|---|---|---|
| `mail-vue/src/request/mail-share.js` | 改 | +54 / -3 | 新增 5 个端点函数 + `isShareForbidden` + `listMailShares` 可选参数 |
| `mail-vue/src/request/mail-share.spec.js` | 改(只扩不改) | +63 / -1 | hoisted mock 补 `put`;新增 4 条用例;既有 2 条一字未动 |
| `mail-vue/src/perm/perm.js` | 改 | +11 | `routers` 表新增 `'share:manage'` 键 |
| `mail-vue/src/layout/aside/index.vue` | 改 | +5 | 个人分组(设置之前)加一条 `el-menu-item` |
| `mail-vue/src/views/share-admin/index.vue` | 新建 | 389 | 列表容器 |
| `mail-vue/src/views/share-admin/status.js` | 新建 | 62 | 四态映射 SSOT(纯函数,零 import) |
| `mail-vue/src/views/share-admin/index.spec.js` | 新建 | 281 | 14 条用例 |
| 本文件 | 新建 | — | exec note |

**明确 0 行改动**(执行后 `git diff --name-only` 实测确认):`router/index.js` · `i18n/zh.js` · `i18n/en.js` · `axios/index.js` · `views/share/**` · `views/email/ShareDialog.vue` · `ShareIndicator.vue` · `init/init.js` · `mail-worker/**` · `tests/e2e/**`。

---

## 2. 红 → 绿

```
基线    pnpm --dir mail-vue test                     17 文件 /  95 用例
红      定点两份 spec                                 2 文件失败 / 3 用例红 + 14 用例未收集
        · index.spec.js 整份 collection 失败:Failed to resolve import "./index.vue"
        · mail-share.spec.js:分页参数断言红 / getMailShare is not a function
          / isShareForbidden is not a function
绿(定点) 同上两份                                     2 文件 / 20 用例(14 页面 + 6 请求)
绿(全量) pnpm --dir mail-vue test -- --no-cache      18 文件 / 113 用例
绿(构建) pnpm --dir mail-vue build                   ✓ built(路由是 lazy import,必须能编译)
```

**跨栈基线**:worker 18 文件 / 598 用例、E2E 13 —— 本任务是纯前端,两者**未跑,标记 `unverified`**(非假称绿)。

---

## 3. 关键实现裁决(与 recon 一致的部分不复述,只记落地形态)

### 3.1 `listMailShares()` 无参仍是单实参(recon §3.2 的红线)

```js
export function listMailShares(params) {
    const query = toListQuery(params)
    return query ? http.get('/mailShare/list', { params: query }) : http.get('/mailShare/list')
}
```

`toListQuery` 只收 `page` / `size` / `status` 三键中**实际给了值**的那些(`undefined` / `null` / `''` 全部丢弃),全空返回 `null`。
守护用例 `keeps the no-arg list call a single argument…` 对 `listMailShares()` / `listMailShares({})` / `listMailShares({status:'', page:null})` 三种调用都断言 `http.get.mock.calls` 逐条 `toEqual(['/mailShare/list'])`。既有 `mail-share.spec.js:50` 与 ShareDialog / ShareIndicator 两个无参调用点因此全绿。

### 3.2 路由落 `perm/perm.js`,`router/index.js` 0 行

`routers['share:manage']` 位于 `'email:send'` 之后(分享是个人能力),meta 为 `{title:'shareManage', name:'share-admin', menu:true, perm:'share:manage'}`。运行时门控仍由「有 perm 才 `addRoute`」承担;**没有加任何读 `to.meta.perm` 的守卫**,`beforeEach` / `afterEach` 一字未动。冷启动无权限仍落 404,这是 W5 的地,按派单未碰。

### 3.3 403 只走 API 单路径

`isShareForbidden(err)` 落在 `request/mail-share.js`(镜像 `share.js:39-44` 的 `isShareUnavailable`),判据 `err.code === 403 || err.message === 'SHARE_FORBIDDEN'`。页面 `catch` 里 `forbidden = isShareForbidden(err)` / `errored = !forbidden`,两个面板是两个不同的 `data-test`。
**未加挂载时 `hasPerm` 自检**(recon §5.3),因此本页压根没调用 `hasPerm`,`Array.isArray` 兜底无需复制。
**未给任何请求加 `noMsg`**。403 的 warning toast 由 axios 拦截器照常弹出,页面再渲染面板,与派单一致。

### 3.4 竞态与分页

- `reqSeq` 自增序号,回来时对不上直接丢弃 —— 快速切筛选时旧响应不会覆盖新结果。
- 切筛选走 `onStatusChange()`:先 `page = 1` 再 `fetchList()`(不是 watch,避免复位与拉取各触发一次)。
- `size` 是常量 20(本任务不放每页条数选择器);`total > size` 才渲染 `el-pagination`,`layout` 由 CSS 收窄而非 JS 切换。

### 3.5 视觉(impeccable **Operate** 模式)

- 卡片列表(reg-key 轨),不用 `el-table`:8 字段窄屏不横滚,spec 也不必 stub `el-table` 的 scoped slot。
- **零裸 hex**:全部走 `--el-bg-color` / `--el-border-color` / `--light-border` / `--secondary-text-color` / `--regular-text-color` / `--extra-light-fill` / `--loadding-background` / `--header-actions-border`。暗色主题实测无坏(见 artifact `share_admin_desktop_dark.png`)。
- 字体不覆盖(`style.css:31` 是全站唯一真源)。
- 四态徽标 **颜色 + 文案 + `data-status` 三重可辨**:`ACTIVE→success / EXPIRED→info / ACCESS_LIMIT_REACHED→warning / REVOKED→danger`(`el-tag` 原生四型,零自定义色)。
- 配额列 `font-variant-numeric: tabular-nums`。
- `@media (max-width: 767px)`:卡片单列 + 字段标签/值纵向堆叠 + 内边距收紧。**JS 侧零 `window.onresize`**,只有一行 `const isMobile = window.innerWidth < 1025`(仅供 `el-empty :image-size`,与 `reg-key:134` 同源)。

### 3.6 一处超出 recon 的小改动(需登记)

头部刷新键做成了真 `<button class="icon-button">`(带 `aria-label` / `title`),而不是 reg-key 那样的裸 `<Icon @click>`。理由:图标独控的键盘可达性属 ponytail「不可偷懒」清单(a11y basics),视觉上用 4 行 CSS 与既有裸图标完全一致。代价是多一个 i18n 键 `shareRefresh`(见 §4,第 10 条)。行内**没有**任何按钮,`findAll('button')` 用例守住。

---

## 4. 🔴 i18n 新增键清单(交 T-28 / T-29 落盘,zh.js / en.js 一字未改)

页面用 `tf(key)` 渲染:`te(key)` 为真取真实翻译,为假回落到下表 zh 文案(派单允许「hardcode 中文回落」),T-29 落盘当天 `tf` 自动切到真值,**页面无需再改一行**。

| # | 键 | zh | en | 用处 |
|---|---|---|---|---|
| 1 | `shareStatusLimitReached` | 已达访问上限 | Access limit reached | 四态第四态(既有映射只有 3 态) |
| 2 | `shareTypeSingle` | 单邮箱 | Single mailbox | 类型徽标 |
| 3 | `shareTypeMulti` | 多邮箱 | Multiple mailboxes | 类型徽标 |
| 4 | `shareBoundMailboxes` | 绑定邮箱 | Bound mailboxes | 绑定摘要标签 |
| 5 | `shareSessionQuota` | 会话用量 | Sessions used | `used/max` 标签 |
| 6 | `shareQuotaUnlimited` | 不限 | Unlimited | `maxSessions === null` |
| 7 | `shareFilterStatus` | 状态 | Status | 筛选器 placeholder |
| 8 | `shareFilterAll` | 全部 | All | 筛选器第一项 |
| 9 | `shareAdminForbidden` | 你没有分享管理权限，请联系管理员。 | You do not have permission to manage shares. Contact an administrator. | 403 面板 |
| 10 | `shareRefresh` | 刷新 | Refresh | 刷新键 `aria-label` / `title`(§3.6 新增) |

**复用的既有键(零新增)**:`shareManage`(路由 title + aside 文案)· `shareStatusActive` · `shareStatusExpired` · `shareStatusRevoked` · `shareExpiresAt` · `shareLastAccess` · `shareEmpty` · `shareListError`。

T-29 落盘后建议顺手删掉 `index.vue` 里的 `PENDING_COPY` 常量与 `tf` helper(约 15 行),全部换回 `$t`。

---

## 5. 用例清单(`views/share-admin/index.spec.js`,14 条)

| # | 用例 | 覆盖 |
|---|---|---|
| L1 | 单行同时可见 name / type / bindings / status / used+max / expiresAt / lastAccessAt,且带 `data-share-id` + `data-status` | AC-ADMIN-01 |
| L2 | 四态各命中 1 个 `[data-status]`,四个徽标文案**两两不同**(`new Set(labels).size === 4`) | AC-ADMIN-01 / 09 |
| L3 | `maxSessions: null` 渲染为「不限」,配额文本不含 `null` | T7 |
| L4 | 绑定摘要里空 mailbox 回落成 `#accountId`,不出现空的逗号项 | T13 |
| L5 | 首屏查询**不含** `status` 键;翻到第 2 页后切筛选,`status` 出现且 `page` 复位 1 | T8 / 派单「query only when set」 |
| L6 | 首屏恒带 `page`/`size`(不落 deprecated);`total <= size` 时分页控件不渲染 | R1-F2 |
| F1 | body-403 → forbidden 面板在、error 面板不在、零 `share-row` | 用户点名 |
| F2 | 403 后 `localStorage.token` 仍在,且 `router.replace` 未被调用(`@/router` 被 mock 成带 spy 的对象) | 用户点名 |
| F3 | `{code:500}` → error 面板在、forbidden 面板不在 | 分流证伪 |
| E1 | `{list:[],total:0}` → 空态在,错误/403 面板都不在 | AC-ADMIN-01 |
| A1 | 行内 `findAll('button')` 为 0,无 `revoke-share` | 不吞 T-21 |
| R1 | `permsToRouter(['share:manage'])` 吐出 `/share-admin`,meta 四字段齐 | AC-ADMIN-10 |
| R2 | `permsToRouter(['email:send'])` **不含**;`permsToRouter(['*'])` **含** | AC-ADMIN-10 |
| M1 | 读 `index.vue` 源文本断言含 `@media (max-width: 767px)` 且**不含** `window.onresize`(jsdom 不跑 media query) | 派单 767 要求 |

`request/mail-share.spec.js` 新增 4 条:无参单实参守护 · 分页参数形状 · 5 个新端点的 URL/传参 · `isShareForbidden` 判据。

**mock 写法**:`vi.mock('@/request/mail-share.js', async (importOriginal) => ({...await importOriginal(), listMailShares}))` —— 必须展开 `importOriginal`,否则 `isShareForbidden` 被抹成 undefined,403 用例会以「函数不存在」的错误原因变绿(recon T12)。

---

## 6. 浏览器实证(临时 harness,已删除)

用一个临时 vite harness 把**真实的 `index.vue`** 挂起来(只把 `@/request/mail-share.js` alias 到桩),playwright 截图 + 录像。harness 四个文件(`preview-t20.html` / `preview-t20/*` / `vite.preview-t20.config.js` / `tests/e2e/t20-shoot.mjs`)**已全部删除**,`git status` 实测干净。

产物在 `/opt/cursor/artifacts/`:

| 文件 | 证明 |
|---|---|
| `share_admin_desktop_light.png` | 四态四色四文案 + 全字段 + `17 / 不限` + `#16` 空邮箱回落 |
| `share_admin_desktop_dark.png` | `.dark` 下无坏色(零裸 hex 的验收) |
| `share_admin_767_cards.png` | 767px 单列卡片、字段纵向堆叠、无横向滚动 |
| `share_admin_forbidden_panel.png` | 403 独立面板 |
| `share_admin_empty_state.png` | 空态 |
| `share_admin_status_filter_and_pagination.mp4` | 翻页 → 切筛选 → 清筛选全过程 |
| `t20_share_admin_list_queries.log` | 上面那段交互对应的四次 `listMailShares` 实参 |
| `t20_red_then_green.log` / `t20_green_full_vue_suite.log` | 红→绿 |

录像对应的请求序列(真实抓取,非手写):

```
1. {"page":1,"size":20}                      首屏,无 status 键
2. {"page":2,"size":20}                      点分页第 2 页
3. {"page":1,"size":20,"status":"REVOKED"}   切筛选:status 出现 + page 复位 1
4. {"page":1,"size":20}                      清筛选:status 键消失
```

---

## 7. 遗留 / 阻塞

**无阻塞项。** 以下是刻意留给后续任务的,不是缺口:

| # | 项 | 归属 |
|---|---|---|
| 1 | 10 个 i18n 键未落盘,页面暂用 `tf` 中文回落 | **T-28 / T-29**。落盘后删 `PENDING_COPY` + `tf` |
| 2 | 行操作(详情 / 撤销 / 删除)、详情抽屉 | **T-21**。行已暴露稳定钩子 `data-test="share-row"` + `data-share-id` + `data-status`;**没有**留空 emit / 空操作列 |
| 3 | 创建向导、四预设 | **T-22**。页面上连「新建」按钮都没放 |
| 4 | ShareDialog → 分享管理的跳转入口 | **T-23** |
| 5 | 冷启动无 `share:manage` 拿到 404 而非 403 | **W5**。要改成 403 必须动 `router.beforeEach`,按 recon §5.2 与派单明令不碰 |
| 6 | `status.js` 的 `getMailShare` / `updateMailShare` / `updateMailShareBindings` / `deleteMailShare` / `resetMailShareAuthKey` 目前**只有 spec 在调**,页面没有消费者 | 派单要求「扩展 8 endpoint 函数」,T-21 / T-22 会立刻用上。5 个函数均为纯透传,未在前端复制后端字段白名单(避免与 `UPDATE_FIELDS` 双真源) |
| 7 | worker / E2E 套件未跑 | 纯前端改动,零交集;标记 `unverified` |

**一处需要审查者留意的自主扩张**:§3.6 的刷新按钮语义化多引入了第 10 个 i18n 键(`shareRefresh`)。若评审认为「不该超出 recon 登记的 9 键」,把 `<button class="icon-button">` 退回裸 `<Icon @click>` 即可,删 4 行 CSS + 1 个键,无测试变化。
