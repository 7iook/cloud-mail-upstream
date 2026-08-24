# Recon · T-20 管理模块路由 + 列表页(W4 第一棒)

| 字段 | 值 |
|---|---|
| 范围 Scope | T-20 / T-20.1 / T-20.2,`docs/specs/mailbox-share-capability/tasks.md:455-458` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`,HEAD `fa61326`(T-18 已 APPROVED,T-19 只动 `mail-worker/test/share-integration.spec.js`,与 T-20 零文件交集) |
| 侦察日期 | 2026-08-24 |
| 依据 AC | AC-ADMIN-01(主),旁及 AC-ADMIN-09(非活跃行仍可审计)、AC-ADMIN-10(perm)、R1-F2(分页契约) |
| 热区状态 | `mail-vue/src/request/mail-share.js` 自 T-11 后无写者;`mail-vue/src/perm/perm.js` 全仓零任务占用;`views/share-admin/` **目录不存在**,全新建 |
| 基线 | **已实测**:`pnpm --dir mail-vue test` → 17 文件 / 95 用例 / EXIT=0(2026-08-24 10:49) |
| 性质 | 只读侦察。**未改任何生产/测试文件、未提交**;本文件是唯一产物 |
| 已读技能 | frontend-design · impeccable · ui-ux-pro-max · ponytail(结论已内化进 §6/§7,不单列附录) |

---

## 0. 一句话结论

T-20 的技术难度全在**三条会静默打红/打歪的细节**上,而不在页面本身:

① **`listMailShares()` 的既有基线断言是精确单参数**——`mail-share.spec.js:50` 写的是 `expect(http.get).toHaveBeenCalledWith('/mailShare/list')`,只有一个实参。给它加一个恒传的 `{ params }` 第二参,这条基线**立刻红**,而它属于「单邮箱旧断言只扩不改写」的守恒面。正确写法是**无参时仍只传一个实参**(§3.2)。

② **路由不该落在 `router/index.js`**。任务书字面写「`router/index.js` 加 layout 子路由」,但同一句又要求「沿用 `perm/perm.js` `permsToRouter` 动态路由」——两者互斥:落 `router/index.js` 的 `children` 就是**无条件注册**,`meta.perm` 退化成一句没人读的注释。design.md:389 的措辞才是可执行的那个:路由对象落 `perm/perm.js` 的 `routers['share:manage']`,由 `init.js:57-60` 的 `router.addRoute('layout', …)` 挂成 layout 子路由。**`router/index.js` 目标改动 0 行**——顺带也就天然满足了「不动访客白名单/守卫」(那段 `beforeEach` 就在这个文件里,§4.3)。

③ **403 能渲染,但只有一条真路径**。全仓的 403 是 **HTTP 200 + body `{code:403, message:'SHARE_FORBIDDEN'}`**(`hono.js:29` 的 `onError` 恒 `c.json(...)` 不带状态码,`security.js:183` 抛 `BizError('SHARE_FORBIDDEN', 403)`),axios 拦截器 `axios/index.js:39-48` 把 body-403 走**警告 toast + reject**,**不清 token、不跳登录**——与 401 分支(`:28-38` 清 token + `router.replace('/login')`)彻底分开。所以 T-20 只要在 `listMailShares` 的 reject 上认 `code === 403 || message === 'SHARE_FORBIDDEN'`,就能渲染独立的 403 面板。**冷启动无权限时拿到的是 404 不是 403**(路由压根没注册),想把那一条也变成 403 必须动 `router.beforeEach` —— 那是 W5 的地,**不要碰**(§5)。

---

## 1. 问题直答(六问)

| # | 问题 | 结论 | 详见 |
|---|---|---|---|
| 1 | 现有 request / router / ShareDialog / 列表页范式;perm.meta 如何门控;767px 约定在哪 | request 只有 3 个函数;路由分静态(`router/index.js`)+ 动态(`perm/perm.js` × `init.js`)两套,**门控靠「有 perm 才 addRoute」而不是靠 meta**;列表页有两套范式(卡片 `reg-key` / 表格 `user`);767px 是 CSS `@media` + JS `window.innerWidth` 双轨,共 12 个文件在用 | §2 |
| 2 | T-20 能否渲染 403(不只 401) | **能,且成本极低**(一个 `isShareForbidden(err)` 判据 + 一个面板分支)。403 是 body code 不是 HTTP status,拦截器已把它与 401 分流。冷启动 403 做不到也不该做 | §5 |
| 3 | 白名单 / 禁改 | 允许写 5 个(request / perm / 新建 view 2 个 / 新建 spec 1 个)+ 1 个待裁决(aside 入口)。**禁改** `i18n/zh.js`·`en.js`(T-28/T-29 单写者)、`router/index.js`、`views/share/**`、`axios/index.js`、任何 `mail-worker/**` | §9 §10 |
| 4 | 组件切分(不吞 T-21) | T-20 = `index.vue`(容器 + 筛选 + 分页 + 四种态)+ `status.js`(纯函数四态映射,零依赖,T-21/T-22 直接复用)。**不建 drawer、不建 form、不放行操作按钮**;行只暴露稳定的 `data-share-id` 钩子供 T-21 挂 | §6 |
| 5 | 测试命令 + 基线 | 定点 `pnpm --dir mail-vue exec vitest run src/views/share-admin/index.spec.js --no-cache`;全量 `pnpm --dir mail-vue test`,基线 **17 文件 / 95 用例**(已实测 EXIT=0) | §11 |
| 6 | 真正用户所有的迷雾 | 恰 3 条:aside 入口是否纳入 T-20 / 行操作归 T-20 还是 T-21 / 列表形态取卡片还是表格。其余全部我已裁决 | §13 |

---

## 2. 现状盘点

### 2.1 request 层(`mail-vue/src/request/mail-share.js`,42 行)

| 现有导出 | 形状 | 备注 |
|---|---|---|
| `newIdempotencyKey()` | 纯函数,`crypto.randomUUID` + 手搓回落 | T-22 要用,T-20 不动 |
| `createMailShare(body, key)` | `POST /mailShare/create`,body 四字段硬编码,带 `Idempotency-Key` 头 | **一字不动**(payload 扩展归 T-22) |
| `listMailShares()` | `http.get('/mailShare/list')`,**零参数** | T-20 的唯一改造点 |
| `revokeMailShare(shareId)` | `http.delete('/mailShare/revoke', { params: { shareId } })` | 不动 |

对照 `mail-share-api.js:23-68` 的 8 条端点,**缺 5 条**:`get`(GET query)、`update`(PUT body)、`bindings`(PUT body)、`delete`(DELETE query)、`resetAuthKey`(POST body)。任务书说的「扩展 8 endpoint 函数」= 新增 5 + 改造 `list` 1 + 保留 create/revoke 2,合计覆盖 8 端点。

### 2.2 路由:两套注册路径,门控靠注册与否

```
静态  router/index.js:8-78   routes[]  → layout.children = [email, content, setting, star]
                                       → 同级 login / test / share(/s/:lid)/ 404 通配
动态  perm/perm.js:39-122    routers{} → permsToRouter(permKeys) 只吐「持有该 perm」的路由对象
      init/init.js:57-60               → routers.forEach(r => router.addRoute('layout', r))
```

- **门控语义**:`permsToRouter` 只在 `permKeys.includes(perm) || permKeys.includes('*')` 时吐路由。没有 perm → 路由从不存在 → 访问落 `/:pathMatch(.*)*` 的 **404**。
- 现有 7 个动态路由的 meta 形状恒为 `{ title, name, menu }`,**没有任何一个带 `perm` 字段**;T-20 的 `meta.perm` 是新增字段,`router/index.js:193-199` 的 `afterEach` 只读 `meta.menu` / `meta.name`,加字段不影响它。
- `'*'` 只发给环境管理员(`user-service.js:35`:`userRow.email === c.env.admin ? ['*'] : permService.userPermKeys(...)`),而 `security.js:181` 对同一个 admin 邮箱又开了后门。所以 **`'*'` 用户不会出现「前端有路由、后端 403」的分叉**——这条曾经看起来最像 403 来源的路径,实际不成立(§5.2)。

### 2.3 ShareDialog:可复用的既有形状

`views/email/ShareDialog.vue`(291 行)已经是一个「列表 + 状态标签 + 行」的最小实现,T-20 该抄的是它的**结构而非组件**:

- 行 DOM:`data-test="share-row"` + `:data-status="row.effectiveStatus"`(`:47-49`)—— 这个「状态进 data 属性」的写法让 spec 不用碰文案就能断言四态,**T-20 原样沿用**。
- `statusLabel(row.effectiveStatus)` 走 i18n key 映射;现有映射只有 3 态(`shareStatusActive/Expired/Revoked`),**缺 `ACCESS_LIMIT_REACHED`**(§10)。
- `ShareIndicator.vue:20-26` 的 `canManageShare()`:`hasPerm` 前先 `Array.isArray(keys)` 兜底 —— 因为 `store/user.js` 的 `user` 初值是 `{}`,`hasPerm` 里 `permKeys.includes` 会 TypeError。**任何直接调 `hasPerm` 的新代码都必须照抄这个兜底**。

### 2.4 列表页范式:两套,一套明显更省

| 范式 | 代表 | 移动适配方式 | 代码量 |
|---|---|---|---|
| **卡片列表** | `views/reg-key/index.vue`(573 行)、`el-scrollbar` + `v-for` div + `el-tag` + `el-dropdown` | 纯 CSS `@media (max-width: 767px)`(`:546`),JS 只有一行 `const isMobile = window.innerWidth < 1025`(`:134`)用于 `el-empty` 尺寸 | 小 |
| **表格** | `views/user/index.vue`(1294 行)、`el-table` + 双 `el-pagination` | JS `window.onresize → adjustWidth()`(`:1018-1038`)逐列算宽:`typeShow = width > 767`、`pagerCount`、`layout`、`phonePageShow`… 12 个响应式开关 | 大 |

`views/role/index.vue:402` 也是 JS 轨(`desShow.value = window.innerWidth > 767`)。**两轨都是「既有移动约定」,767 这个数字是共识**(12 处命中:`layout/header:421`、`layout/main:97,107,128,151`、`layout/account:559`、`router/index.js:195`、`user:1030,1170`、`role:402`、`reg-key:546`、`analysis:299` 等)。

### 2.5 样式令牌:已有一套,禁止裸 hex

`style.css:108-143` 的 `:root` 与 `:145` 的 `.dark` 是成对的语义变量层(`--light-border` / `--base-fill` / `--secondary-text-color` / `--regular-text-color` / `--el-color-primary-*` …)。**新页面所有颜色必须走这套变量或 element-plus 的 `--el-*`**,写死 hex 会在暗色主题下直接坏掉(ui-ux-pro-max §「Token-driven theming」/ impeccable Operate 模式的硬约束)。

### 2.6 后端契约(只读确认,T-20 不改)

`GET /mailShare/list`(`mail-share-service.js:1372-1410`):

| 入参 | 语义 |
|---|---|
| `page` / `size` | `size` 默认 20、上限 100(`:20-21`);`page` 从 1 起;脏值**钳位不报错**(`clampPositive:993-998`) |
| `status` | 必须 ∈ `['ACTIVE','EXPIRED','REVOKED','ACCESS_LIMIT_REACHED']`(`:27`),否则抛 `SHARE_INVALID_CONFIG` |
| 三者全缺 | 走 **deprecated 全量**:不分页、硬顶 500 行,响应带 `deprecated: true` |

响应:`{ list, total }`,分页时补 `page` / `size`。行字段(`projectOwnerRow:424-456`)AC-ADMIN-01 要的全都在:`name` · `shareType`(`'single'|'multi'`,由 Binding 计数派生)· `bindings[]`(`{bindingId, accountId, mailbox}`,`loadBindingSummaries:491-509`)· `effectiveStatus`(四态)· `usedSessions`(= `accessCount` 的别名,两键并存)· `maxSessions`(可为 `null` = 不限)· `expiresAt` · `lastAccessAt`(可为 `null`)· `mailbox` · `revokedAt` · `createTime`。**列表与详情共用同一套键名**(`:421-423` 的注释),所以 T-21 抽屉不会有第二套字段名。

---

## 3. T-20.1 · request 层:8 端点函数

### 3.1 目标形状(5 新增 + 1 改造)

| 函数 | 端点 | 传参方式 | 依据 |
|---|---|---|---|
| `getMailShare(shareId)` | `GET /mailShare/get` | `{ params: { shareId } }` | `mail-share-api.js:35`(读 `c.req.query()`) |
| `updateMailShare(body)` | `PUT /mailShare/update` | body | `:40`(读 `c.req.json()`) |
| `updateMailShareBindings(body)` | `PUT /mailShare/bindings` | body `{ shareId, add[], remove[] }` | `:59` / `updateBindings:1186-1189` |
| `deleteMailShare(shareId)` | `DELETE /mailShare/delete` | `{ params: { shareId } }` | `:46` |
| `resetMailShareAuthKey(body)` | `POST /mailShare/resetAuthKey` | body `{ shareId, action }` | `:53` / `resetAuthKey:1331-1332`(读 `params.action`) |
| `listMailShares(params?)` | `GET /mailShare/list` | **见 §3.2** | `:30` |

**裁决(我定)**:这 5 个新函数**只做透传,不做字段白名单**。`createMailShare` 那种逐字段 `Number()/String()` 归一是它的历史包袱(为了钉死幂等 body 的形状),复制到 5 个函数上会变成「前端第二份字段白名单」,与后端 `UPDATE_FIELDS`(`mail-share-service.js:935-944`)必然漂移——后端已经有完整的值域校验与栅栏,前端再抄一遍是双真源。透传即可。

**唯一的例外是 `shareId`**:三个 query 端点(`get`/`delete`/`revoke`)后端走 `toShareId`,前端保持与既有 `revokeMailShare` 同款(直接把值塞进 `params`),不额外包装。

### 3.2 🔴 `listMailShares` 的分页参数:必须保留「无参 = 单实参」

`mail-share.spec.js:50` 的基线断言是**精确匹配**:

```js
expect(http.get).toHaveBeenCalledWith('/mailShare/list')      // 恰一个实参
```

`toHaveBeenCalledWith` 对实参个数敏感。所以下面这种最自然的写法**直接把基线打红**:

```js
// ✗ 会红:无参调用也变成两个实参
export function listMailShares(params = {}) {
    return http.get('/mailShare/list', { params })
}
```

正确形状(同时保住 ShareDialog / ShareIndicator 两个既有无参调用点的 deprecated 兼容语义):

```js
// ✓ 无参 → 单实参(旧调用点与后端 deprecated 全量分支都不变)
export function listMailShares(params) {
    const query = toListQuery(params)
    return query ? http.get('/mailShare/list', { params: query }) : http.get('/mailShare/list')
}
```

`toListQuery` 只保留 `page` / `size` / `status` 三个键中**实际给了值**的那些,全空则返回 `null`。多余的键不要往上传:后端 `hasValue(params,'status')` 只看这三个,传别的不报错但会让 spec 断言变脆。

**另一条既有调用点**:`ShareIndicator.vue:19` 的 `listMailShares()` 也是无参,同样受这条保护。

### 3.3 `isShareForbidden(err)`:403 判据的唯一真源

镜像 `request/share.js:39-44` 的 `isShareUnavailable` —— 那是访客域已经立住的范式(`err.code === X || err.message === X`,双向兼容 body-code 与 Error-message 两种形状)。Owner 域照抄:

```js
export function isShareForbidden(err) {
    if (!err) return false
    return err.code === 403 || err.message === 'SHARE_FORBIDDEN'
}
```

放在 `request/mail-share.js` 而不是页面里:T-21/T-22/T-23 都会撞同一个码,判据分散到四个组件就是四份漂移。**这是 ponytail 阶梯第 2 级(复用仓内既有模式)的直接产物,不是新抽象。**

---

## 4. T-20.1 · 路由

### 4.1 落点:`perm/perm.js` 的 `routers` 表(**不是** `router/index.js`)

在 `routers` 对象里新增一个键(位置建议紧跟 `'email:send'` 之后,因为分享是个人能力不是管理能力):

```js
'share:manage': [{
    path: '/share-admin',
    name: 'share-admin',
    component: () => import('@/views/share-admin/index.vue'),
    meta: {
        title: 'shareManage',      // 复用既有 i18n 键,零新增
        name: 'share-admin',
        menu: true,
        perm: 'share:manage'       // 本任务新增的 meta 字段
    }
}]
```

- `path` / `name` 用 `share-admin`,与目录名、`meta.name` 三处一致(仓内既有 7 条动态路由全部遵守 `name === meta.name` 这条隐式约定,`sys-setting` / `all-email` / `reg-key` 都是)。
- `menu: true` 是必须的:`router/index.js:193` 的 `afterEach` 只对 `meta.menu` 为真的路由做移动端 `accountShow/asideShow` 复位;设 false 会让手机端从收件箱跳过来时账号栏残留。而 `share-admin` 不在 `['content','email','send']` 里,所以会走 `accountShow = false` 分支 —— **这正是管理页该有的行为**(不显示邮箱侧栏),零额外代码。
- **`title` 复用既有键 `shareManage`(zh「分享」/ en 已存在)**,不新增 i18n 键。

### 4.2 与任务书字面的偏差(必须登记)

tasks.md:456 写「`mail-vue/src/router/index.js` 加 layout 子路由 + `meta.perm`」。**执行者不要照字面做**:

- 落 `router/index.js:14-55` 的 `children` 数组 = 无条件注册,任何登录用户都能进 `/share-admin`,`meta.perm` 变成没人读的字符串,与同句的「沿用 `permsToRouter` 动态路由」自相矛盾,也与 AC-ADMIN-01 的「权限 meta 沿用 `share:manage`」在语义上背离。
- design.md:389 的措辞是可执行版本:「layout 子路由 + `meta.perm='share:manage'`(沿用 `perm/perm.js` `permsToRouter` 动态路由)」——`addRoute('layout', …)` 出来的**就是** layout 子路由。
- 结论:**`router/index.js` 目标改动 0 行**。这同时把「不动访客白名单/守卫(W5)」变成了物理保证,而不是一句自律 —— `beforeEach` 的 share 白名单(`:157-161`)与 `afterEach` 的 session 清理(`:181-183`)都在这个文件里。

### 4.3 `meta.perm` 目前没有消费者 —— 这是**故意**的

全仓没有任何 `beforeEach` 读 `to.meta.perm`。加一个读它的全局守卫需要改 `router/index.js:143-178` 的 `beforeEach`,那正是 W5 的地盘。所以 `meta.perm` 在 T-20 里是**声明式契约 + 可断言的锚点**(T-20.2 直接断言它),不是运行时门控;运行时门控由「有 perm 才 `addRoute`」承担。**不要为了让 `meta.perm` 有用而去写守卫。**

---

## 5. 403 可渲染性(用户点名的问题)

### 5.1 结论:能,一条路径,~8 行代码

链路逐段核实:

```
security.js:183   throw new BizError('SHARE_FORBIDDEN', 403)      ← 缺 share:manage 且非环境 admin
hono.js:29        return c.json(result.fail(err.message, err.code))
                  ⇒ HTTP 200 + body { code: 403, message: 'SHARE_FORBIDDEN' }   ★ 不是 HTTP 403
axios/index.js:39 data.code === 403 → ElMessage(warning) + reject(data)
                  ⇒ 不清 token、不 router.replace('/login')(那是 :28-38 的 401 分支)
页面              listMailShares(...).catch(err => { if (isShareForbidden(err)) forbidden = true })
```

三条必须写进实现注释的事实:

1. **403 是 body code,不是 HTTP status。** `axios/index.js:74-77` 的**错误**拦截器里那条 `if (error.status === 403) { location.reload() }` 针对的是**传输层** 403(边缘/网关),我们的 403 走不到那里。**任何让后端改成真 HTTP 403 的念头都要否掉** —— 那会让整页 `location.reload()` 无限刷。
2. **不要给 list 请求加 `noMsg: true`。** 加了确实能压掉那个 `SHARE_FORBIDDEN` 原文 toast(`axios/index.js:24-26`),但同一个分支会把 **401 的清 token + 跳登录一起吞掉**,把一个显示瑕疵换成一个鉴权回归。既有 `noMsg` 只用在两个 `latest` 长轮询上(`request/email.js:12,24`、`all-email.js:16`),那两个本来就不该跳登录。**裁决:不用 noMsg,接受一次 toast,页面自己再渲染 403 面板。**
3. **403 不清 token 是正确行为**,spec 要正面钉住(§8 用例 F2):`localStorage.token` 在 403 后仍在。

### 5.2 冷启动无权限拿到的是 **404 不是 403** —— 且不该修

没有 `share:manage` 的用户刷新页面 → `init.js:57` 的 `permsToRouter` 不吐这条路由 → `/share-admin` 落 `router/index.js:73-77` 的 `/:pathMatch(.*)*` → 渲染 `views/404`。想把这一条也变成 403,只有两条路,**都要否掉**:

- 无条件注册路由 + 全局守卫查 perm → 要改 `router/index.js` 的 `beforeEach`(W5 独占),且破坏 §4.1 的门控模型;
- 在 404 页里嗅探路径 → 在 404 页里硬编码分享模块的路径,典型的 shotgun surgery。

**能真实触发 403 面板的场景(这才是它存在的理由)**:
- 会话中途角色被改掉 `share:manage`。前端 `permKeys` 是 `init()` 时快照进 pinia 的,路由**一旦 `addRoute` 就永不移除**;`userStore.refreshUserInfo()`(`store/user.js:15-19`)会刷新 `permKeys` 但不会回收路由。此时页面还在,每一次 list 都是 403。
- 用户已经停在 `/share-admin`,管理员在后台撤权,用户点「刷新」按钮。
- (**不成立**,别写进注释)`'*'` 用户:`'*'` 只发给 `c.env.admin`(`user-service.js:35`),而 `security.js:181` 对同一邮箱开了后门,所以 `'*'` 不会 403。

### 5.3 不要加「挂载时 `hasPerm` 自检」这条第二路径

看上去很自然:`onMounted` 里 `hasPerm('share:manage')` 为假就直接渲染 403。但它与 API-403 完全同域(能到达页面就说明路由在,路由在就说明当时有 perm;perm 事后消失时那次 list 必然 403),**是同一件事的第二个判据**,两条路径迟早漂移成两种文案。ponytail 阶梯:一条路径、一个测试。**裁决:只走 API-403。**

---

## 6. 组件切分:T-20 与 T-21 的边界

### 6.1 T-20 落两个文件,就两个

| 文件 | 职责 | 为什么是它 |
|---|---|---|
| `mail-vue/src/views/share-admin/index.vue` | 列表容器:取数 / status 筛选 / 分页 / 行渲染 / 四种非常态(loading·empty·error·forbidden) | AC-ADMIN-01 的全部 |
| `mail-vue/src/views/share-admin/status.js` | **纯函数**:`effectiveStatus → { labelKey, tone }` + `shareType → labelKey` + `quotaText(used,max)` | 零 import、可单测、T-21 抽屉与 T-22 向导必然复用同一套四态映射。**这是唯一一个值得先抽的文件**——不抽它,T-21 会复制一份四态 switch,四态语义就有了两个真源 |

**不建**:`ShareAdminTable.vue` / `ShareStatusBadge.vue` / `useShareAdminList.js` / `ShareAdminFilters.vue`。单页面一个消费者的组件拆分是 ponytail 明令禁止的「一个实现的接口」;真到 T-21 需要复用某段模板时再抽,那时抽的形状才是对的。

### 6.2 不吞 T-21 的具体边界

| 能力 | 归属 | T-20 要做的 |
|---|---|---|
| 详情抽屉(Binding 增删 / 配置编辑 / AuthKey 区) | T-21 | **零** |
| 行操作按钮(详情 / 撤销 / 删除) | 建议 T-21(见 §13 迷雾 2) | 行上暴露稳定钩子 `data-test="share-row"` + `:data-share-id="row.shareId"` + `:data-status="row.effectiveStatus"`,**不放按钮、不 emit、不留空的操作列** |
| 创建向导 / 四预设 | T-22 | **零**(页面上连「新建」按钮都不放) |
| ShareDialog 跳转入口 | T-23 | **零** |

「留一个 `@open-detail` 的空 emit 给 T-21」是典型的 for-later 脚手架 —— 没有消费者的 emit 就是死代码。T-21 那时自己加 3 行 emit 声明比现在猜它要什么便宜。

### 6.3 设计取向(impeccable 判定:**Operate** 模式)

这是登录态管理台,不是 landing page。impeccable 的 Operate 定义直接适用:**可扫读性、一致性、原生预期 > 表达欲;品牌只活在精确的细节里**。frontend-design 那套「大胆美学方向 / 不寻常字体 / 渐变网格」在这里是**反指标** —— 它会让这一页与仓内其它 7 个管理页(reg-key / user / role / …)割裂,而一致性在 Operate 模式里排在表达之前。

落地为四条硬约束:

1. **颜色只走 §2.5 的变量层**(`--light-border` / `--base-fill` / `--secondary-text-color` / `--el-color-*`),零裸 hex,否则 `.dark` 主题(`style.css:145`)下必坏。
2. **字体不动**。`style.css:31` 的 body font-family 是全站唯一真源,页面级覆盖 = 割裂。
3. **四态徽标不能只靠颜色**(ui-ux-pro-max §1 `color-not-only`、§6 `color-not-decorative-only`):颜色 + 文案并存,并把状态同时写进 `data-status` 属性。建议 tone 映射 `ACTIVE→success / EXPIRED→info / ACCESS_LIMIT_REACHED→warning / REVOKED→danger`(`el-tag` 原生四个 type,零自定义色)。
4. **配额用等宽数字**(`font-variant-numeric: tabular-nums`,§6 `number-tabular`):`used/max` 是逐行对齐的数据列,比例字体会让它抖。这是本页唯一一处「品牌活在细节里」的地方,一行 CSS。

### 6.4 767px:走 CSS 单轨,不走 JS 多轨

两套既有约定里选**卡片列表 + 纯 CSS 断点**(`reg-key` 轨),不选 `el-table` + `adjustWidth()`(`user` 轨):

- `user/index.vue` 那套要维护 12 个响应式开关(`:1024-1037`)、双 `el-pagination`、`window.onresize` 全局赋值(**注意它是 `window.onresize =` 覆盖式赋值,多页共存时后挂载的会顶掉先挂载的** —— 已是既有隐患,T-20 不要再加一个)。
- AC-ADMIN-01 要展示 8 个字段;窄屏下 8 列表格必然横向滚动(§5 `horizontal-scroll` 是明令 anti-pattern),卡片式换行天然成立。
- 对 T-20.2 的直接好处:卡片是原生 div,spec 里**不用 stub `el-table`/`el-table-column`**(`el-table` 的 scoped slot 在 jsdom 里 stub 起来很脏)。只需 stub `el-tag` / `el-select` / `el-option` / `el-pagination` / `el-empty`,与 `ShareDialog.spec.js:48-74` 那份 stub 表同源。

断点写法照 `reg-key/index.vue:546`:

```less
@media (max-width: 767px) { /* 卡片单列、字段纵向堆叠、内边距收紧 */ }
```

JS 侧只允许一行 `const isMobile = window.innerWidth < 1025`(仅供 `el-empty :image-size`),与 `reg-key:134` 逐字同源。

---

## 7. 页面结构与状态机(给执行者的实现骨架)

```
share-admin/index.vue
├─ header-actions            ← 复用 reg-key:3-17 的 .header-actions 布局与 --header-actions-border
│   ├─ el-select  status     ← 五个选项:全部 + 四态;change → 回到第 1 页重新拉
│   └─ Icon ion:reload       ← 刷新(reg-key:15 同款)
├─ el-scrollbar
│   ├─ loading               ← components/loading,套 reg-key:21-23 的 loading-show/hide 类
│   ├─ [forbidden]  data-test="share-admin-forbidden"   ← isShareForbidden(err)
│   ├─ [error]      data-test="share-admin-error"       ← 其它任何 reject
│   ├─ [empty]      el-empty + t('shareEmpty')          ← list.length === 0 且无错
│   └─ [rows] v-for data-test="share-row" :data-share-id :data-status
│        ├─ 名称(name || mailbox || shareId)          ← 同 ShareDialog:52 的回落链
│        ├─ 类型徽标 shareType single|multi
│        ├─ 绑定摘要 bindings[].mailbox,>2 条折叠为「a, b +N」
│        ├─ 状态徽标 effectiveStatus(四态,tone + 文案)
│        ├─ 配额 usedSessions / (maxSessions ?? ∞)      ← tabular-nums
│        ├─ 到期 expiresAt
│        └─ 最后访问 lastAccessAt || '-'                ← ShareDialog:62 同款回落
└─ el-pagination v-if="total > size"   ← 单个,layout 由 CSS 收窄而非 JS 切换
```

四种非常态**互斥且穷尽**:`loading` → (`forbidden` | `error` | `empty` | `rows`)。这四条是 T-20.2 各自一条用例的骨架。

**取数副作用只有一处**:`onMounted` + `watch([status, page, size])` 合并成一个 `fetchList()`,筛选变更时 `page` 先复位 1 再拉(否则「第 3 页 + 切筛选 → 空页」是必现 bug)。**同一时刻只允许一个在飞的请求**:用一个自增 `reqSeq`,回来时对不上就丢弃(避免快速切筛选时旧响应后到覆盖新结果)。这不是过度设计 —— 它是 §8 用例 L4 的被测对象。

---

## 8. T-20.2 红灯清单(`mail-vue/src/views/share-admin/index.spec.js`,新建)

### 8.1 测试基建(照抄既有,别自创)

- mount 范式逐字照 `ShareDialog.spec.js:96-116`:`createPinia()` + `setActivePinia` + `useUserStore().user = { permKeys: ['share:manage'] }` + `createI18n({ legacy:false, locale:'en', messages:{ en } })`。
- `vi.hoisted` + `vi.mock('@/request/mail-share.js', async (importOriginal) => ({ ...actual, listMailShares }))` —— **必须用 `importOriginal` 展开**,否则 `isShareForbidden` 这个同模块导出会被 mock 抹掉,页面里的判据直接 undefined。
- element-plus 全局 stub 表照 `ShareDialog.spec.js:48-74` 扩两项(`el-select`/`el-option` 已有,补 `el-pagination` / `el-empty` / `el-scrollbar`)。
- **文案断言只用 `en.js` 里已存在的键**(§10):新键在 T-29 落盘前会渲染成键名占位。断言一律打在 `data-test` / `data-status` / 数值上。

### 8.2 用例清单

| # | 用例 | 关键断言 | 覆盖 |
|---|---|---|---|
| **L1** | 列表字段齐全 | 单行内同时可见:`name` · `shareType`(single/multi 两行分别断言)· 全部 `bindings[].mailbox` · `data-status === effectiveStatus` · `usedSessions` 与 `maxSessions` 两个数 · `expiresAt` · `lastAccessAt` | **AC-ADMIN-01** |
| **L2** | 四态徽标各自可辨 | 四行 mock(ACTIVE/EXPIRED/REVOKED/ACCESS_LIMIT_REACHED),`[data-status="…"]` 各命中 1;四个徽标的**文案两两不同**(防「四态映射漏一个、fallback 成同一句」的假绿) | AC-ADMIN-01 · AC-ADMIN-09 |
| **L3** | `maxSessions: null` 渲染为不限而非 `null`/空 | 该行配额文本不含 `null`,且 `usedSessions` 仍可见 | AC-ADMIN-01 |
| **L4** | status 筛选发出正确请求 | 选 `REVOKED` → `listMailShares` 最后一次调用的实参含 `status:'REVOKED'` 且 `page === 1`;先翻到第 2 页再切筛选,断言 `page` 已复位 1 | AC-ADMIN-01 |
| **L5** | 分页恒带参(不落 deprecated) | 首屏调用实参含 `page`/`size`;翻页后 `page` 递增;`total <= size` 时分页控件不渲染 | R1-F2 |
| **L6** | **无参兼容基线不破** | 直接对 `request/mail-share.js` 断言:`listMailShares()` → `http.get` 恰一个实参(§3.2)。**这条放在 `request/mail-share.spec.js` 的扩展里而非页面 spec** | 基线守恒 |
| **F1** | 403 渲染独立面板 | `listMailShares` reject `{ code:403, message:'SHARE_FORBIDDEN' }` → `[data-test="share-admin-forbidden"]` 存在;`[data-test="share-admin-error"]` **不存在**;无 `share-row` | 用户点名 |
| **F2** | 403 不等于登出 | 同上前置 + `localStorage.setItem('token','t')` → 断言 token **仍在**(403 不清 token) | 用户点名 |
| **F3** | 非 403 错误走通用错误态 | reject `{ code:500, message:'SHARE_DISABLED' }` → `error` 面板在、`forbidden` 面板不在 | 分流证伪 |
| **E1** | 空态 | `{ list: [], total: 0 }` → 空态在、错误/403 面板都不在 | AC-ADMIN-01 |
| **R1** | 路由 meta perm | 从 `permsToRouter(['share:manage'])` 取出该路由,断言 `path === '/share-admin'`、`meta.perm === 'share:manage'`、`meta.menu === true` | AC-ADMIN-01 · AC-ADMIN-10 |
| **R2** | **无 perm 不吐路由**(反向) | `permsToRouter(['email:send'])` 结果中**不含** `share-admin`;`permsToRouter(['*'])` 中**含** | AC-ADMIN-10 |
| **M1** | 767 断点遵循既有约定 | 读 `index.vue` 源文本断言含 `@media (max-width: 767px)`(与 `assert-share-chunk.js` / `assert-share-entry.js` 的「源码断言」范式同源,`init.spec.js:53-56` 是现成先例);**不要**在 jsdom 里改 `window.innerWidth` 断言 CSS —— jsdom 不跑 media query | 任务书 767 要求 |

**R1/R2 建议单独放 `mail-vue/src/perm/perm.spec.js`(新建)**,而不是塞进页面 spec:`permsToRouter` 是纯函数,页面 spec 里为它拉一遍 pinia + i18n 是浪费。执行者二选一皆可,但**不要**为它去改 `router/index.spec.js`(那份是 W1 的访客守卫基线,109 行全是 share 路由语义,加 owner 路由用例会污染它的主题)。

### 8.3 必须继续绿的既有断言

- `request/mail-share.spec.js:47-52`(2 条)—— L6 的保护对象,**只扩不改**。
- `views/email/ShareDialog.spec.js`(整份)—— 它 mock 了 `@/request/mail-share.js`,新增导出不影响;但若把 `createMailShare` 的 body 归一改掉就会红。**不要动 create。**
- `views/email/ShareIndicator.spec.js` —— 无参 `listMailShares()` 调用点。
- `src/router/index.spec.js`(6 条)—— `router/index.js` 0 行改动即天然全绿。
- `src/init/init.spec.js`(4 条)—— 它 `vi.mock('@/perm/perm.js', () => ({ permsToRouter: () => [] }))`,perm.js 改动对它透明。

---

## 9. 文件白名单

### 9.1 允许写

| 文件 | 改动 | 约束 |
|---|---|---|
| `mail-vue/src/request/mail-share.js` | +5 端点函数、`listMailShares` 加可选参数、+`isShareForbidden` | `newIdempotencyKey` / `createMailShare` / `revokeMailShare` **一字不动**;无参 list 保持单实参(§3.2) |
| `mail-vue/src/perm/perm.js` | `routers` 表 +1 键 `'share:manage'` | `permsToRouter` / `hasPerm` / 默认导出指令**函数体不动**;既有 7 条路由不动 |
| `mail-vue/src/views/share-admin/index.vue` | 新建 | 颜色只走 CSS 变量;`@media (max-width: 767px)`;无行操作按钮 |
| `mail-vue/src/views/share-admin/status.js` | 新建 | 纯函数,零 import |
| `mail-vue/src/views/share-admin/index.spec.js` | 新建 | §8 |
| `mail-vue/src/request/mail-share.spec.js` | 扩展(L6 + 新函数的 URL/参数断言) | 现有 2 条只扩不改 |
| `mail-vue/src/perm/perm.spec.js` | 新建(可选,R1/R2 落点) | 见 §8.2 |
| `mail-vue/src/layout/aside/index.vue` | **待裁决**,见 §13 迷雾 1 | 若纳入:+1 `el-menu-item` + `v-perm="'share:manage'"`,复用 `$t('shareManage')`,零新 i18n 键 |

### 9.2 明确不碰

| 文件 | 归属 / 理由 |
|---|---|
| `mail-vue/src/i18n/zh.js` · `en.js` | **T-28/T-29 单写者**(tasks.md:27 明文)。T-20 只在 §10 登记所需键,一个字都不落盘 |
| `mail-vue/src/router/index.js` | §4.2:目标 0 行。`beforeEach` 的访客白名单 / `afterEach` 的 session 清理属 W1 已冻结 + W5 待办 |
| `mail-vue/src/views/share/**` · `composables/useSharePolling.js` · `request/share.js` | 访客域,W5(T-24/T-25/T-26)。**两域网络层不共享**(design.md:135),别从 owner 页 import 任何访客域文件 |
| `mail-vue/src/axios/index.js` | 全局拦截器。403/401 分流是 T-20 的**前提**不是改造对象(§5.1 事实 2) |
| `mail-vue/src/init/init.js` | `assert-share-entry.js` 的守护测试盯着它;`addRoute` 循环无需任何改动 |
| `mail-vue/src/views/email/ShareDialog.vue` · `ShareIndicator.vue` | T-23(跳转入口)。T-20 不往对话框里塞任何东西 |
| `mail-vue/src/views/404/**` | §5.2:不要在 404 页里嗅探分享路径 |
| `mail-worker/**` | 后端契约 W3 已封口;T-19 正在写 `share-integration.spec.js`,零交集 |
| `tests/e2e/**` | W6 |

---

## 10. i18n:只登记,不落盘(交 T-29)

### 10.1 可直接复用的既有键(零新增)

`shareManage`(菜单/标题)· `shareStatusActive` · `shareStatusExpired` · `shareStatusRevoked` · `shareMailbox` · `shareExpiresAt` · `shareCreatedAt` · `shareLastAccess` · `shareEmpty` · `shareListError`。

### 10.2 T-20 新增键清单(zh.js / en.js 同前缀段,T-29 统一追加)

| 键 | zh 建议 | en 建议 | 用处 |
|---|---|---|---|
| `shareStatusLimitReached` | 已达访问上限 | Access limit reached | 四态第四态(**现有映射只有 3 态**) |
| `shareTypeSingle` | 单邮箱 | Single mailbox | 类型徽标 |
| `shareTypeMulti` | 多邮箱 | Multiple mailboxes | 类型徽标 |
| `shareBoundMailboxes` | 绑定邮箱 | Bound mailboxes | 绑定摘要标签 |
| `shareSessionQuota` | 会话用量 | Sessions used | `used/max` 标签 |
| `shareQuotaUnlimited` | 不限 | Unlimited | `maxSessions === null` |
| `shareFilterStatus` | 状态 | Status | 筛选器 placeholder |
| `shareFilterAll` | 全部 | All | 筛选器第一项 |
| `shareAdminForbidden` | 你没有分享管理权限,请联系管理员。 | You do not have permission to manage shares. Contact an administrator. | 403 面板 |

共 **9 个新键 × 2 语言**。执行者需在 exec note 里原样带上这张表,T-29 直接抄。

**W4 期间的既定后果**(tasks.md:27 的必然推论,不是缺陷):这 9 个键落盘前,页面上会渲染键名本身。spec 因此**只断言 `data-test` / `data-status` / 数值,不断言这 9 条文案**。

---

## 11. 验证命令与基线

```bash
# 定点(红 → 绿)
pnpm --dir mail-vue exec vitest run src/views/share-admin/index.spec.js --no-cache

# 邻接回归(受本次改动直接波及的四份)
pnpm --dir mail-vue exec vitest run src/request/mail-share.spec.js src/views/email/ShareDialog.spec.js \
    src/views/email/ShareIndicator.spec.js src/router/index.spec.js src/init/init.spec.js

# 全量(基线 17 文件 / 95 用例,已实测 EXIT=0)
pnpm --dir mail-vue test
```

**跨栈基线(T-20 不应改变其中任何一个)**:worker 18 文件 / 598 用例 · vue 17 / 95 · E2E 13。T-20 是纯前端任务,worker 与 E2E **不需要跑**,但 exec note 里要按惯例标注为 `unverified`(未跑)而不是假称绿。

---

## 12. 风险与陷阱

| # | 风险 | 说明与处置 |
|---|---|---|
| **T1** | **`listMailShares` 加参打红既有基线** | §3.2。`toHaveBeenCalledWith('/mailShare/list')` 对实参个数敏感。防线:L6 |
| **T2** | **路由落错文件** | §4.2。落 `router/index.js` 会让 `meta.perm` 变装饰、让无权限用户也能进页面、还顺手把 W5 的守卫文件变成脏文件。防线:R2 反向用例 |
| **T3** | **把 403 做成 HTTP 403** | `axios/index.js:74-77` 对传输层 403 是 `location.reload()`。后端一旦真返 403 状态码,整页无限刷。T-20 不改后端,但审查时要认这条 |
| **T4** | **给 list 加 `noMsg: true`** | 会连 401 的清 token + 跳登录一起吞掉(`axios/index.js:24-26` 是同一个早退分支)。§5.1 事实 2 |
| **T5** | **`hasPerm` 在空 user 上 TypeError** | `store/user.js:6` 初值 `user: {}`,`perm.js:24` 直接解构 `permKeys` 再 `.includes`。任何新调用点都要照 `ShareIndicator.vue:21-25` 先 `Array.isArray` 兜底。(§5.3 裁决不加挂载自检后,本条只在执行者自作主张加自检时才会踩) |
| **T6** | **四态漏一态假绿** | 只写 3 个 case + 一个 fallback,`ACCESS_LIMIT_REACHED` 渲染成与 `EXPIRED` 相同的文案,单看用例 L1 是绿的。防线:L2 断言四条文案两两不同 |
| **T7** | **`maxSessions: null` 直接进模板** | 后端明确 `null` = 不限(`:444`)。裸插值会渲染成空或 `null`。防线:L3 |
| **T8** | **切筛选不复位 page** | 停在第 3 页切到只有 2 条的筛选 → 空页 + 空态,像 bug。防线:L4 后半 |
| **T9** | **快速切筛选时旧响应后到** | 无请求序号 → 旧结果覆盖新结果。§7 的 `reqSeq` |
| **T10** | **`window.onresize =` 覆盖式赋值** | `user/index.vue:1018` 与 `role/index.vue` 都在用覆盖式赋值,两页共存时互相顶掉(既有隐患)。T-20 走 CSS 单轨,**不要再加第三个** |
| **T11** | **jsdom 里断言 media query** | jsdom 不计算 CSS media query,`setup.js:1-14` 那个 `matchMedia` 桩恒返回 `matches:false`。767 只能用源码文本断言(M1) |
| **T12** | **spec 的 mock 抹掉同模块导出** | `vi.mock('@/request/mail-share.js')` 不展开 `importOriginal` → `isShareForbidden` 变 undefined → 403 用例以「函数不存在」的错误原因红/绿。照 `ShareDialog.spec.js:15-23` 的写法 |
| **T13** | **绑定摘要里出现空地址** | 账号被硬删后 `loadBindingSummaries:505` 给 `mailbox: ''`(T-18 的 cleanup 补偿臂之外的窗口)。渲染时空串要回落成占位符,别渲染出一个空的逗号分隔项 |
| **T14** | **偷偷改 i18n 文件** | zh/en 是 T-28/T-29 单写者热区。少一个字都算越界 |
| **T15** | **顺手把 T-21 的抽屉/按钮做了** | §6.2。W4 的 T-21/T-22/T-23 靠「不同文件」并行(tasks.md:523),T-20 一旦在 `index.vue` 里铺开抽屉,并行槽就塌成串行 |

---

## 13. 迷雾清单(真正用户所有的裁决,恰 3 条)

> 其余全部已由本侦察裁决:request 透传不做白名单 · 路由落 perm.js 且 `router/index.js` 0 行 · 403 只走 API 单路径不加挂载自检 · 不用 noMsg · `status.js` 是唯一先抽的文件 · 四态 tone 用 el-tag 原生四型 · CSS 单轨 767 · i18n 只登记 9 键。

**F1 · aside 菜单入口是否纳入 T-20?**
路由建好但侧栏没入口,用户只能手敲 `/share-admin` —— 实质是死代码;而 T-23 的「前往分享管理」跳转在 ShareDialog 里,进不去收件箱分享弹窗的人仍然摸不到。`layout/aside/index.vue` **不在热区表、也没有任何任务点名**,属无主文件。
**我的建议:纳入。** 在「设置」之后、`manage-title` 分组**之前**插一条 `el-menu-item`(分享是 Owner 个人能力,不是管理员能力),`v-perm="'share:manage'"`,文案复用既有 `$t('shareManage')`,零新 i18n 键,改动约 5 行,`layout/header/index.copy.spec.js` 是 header 的基线、与 aside 无关,零测试风险。
**需要用户点头的原因**:这是对 tasks.md T-20.1 文件清单的一次扩张,且「分享放个人组还是管理组」是产品心智判断。

**F2 · 行操作(撤销 / 删除 / 详情)归 T-20 还是 T-21?**
design.md:391 把「行操作:详情、撤销、删除」写进了列表页描述,但 AC-ADMIN-01 只要求展示字段,而 T-21 的标题只写了「详情抽屉」——撤销/删除**无明确归属**。
**我的建议:归 T-21。** 理由:撤销/删除要引入 `ElMessageBox` 确认交互、错误码分支(`SHARE_NOT_FOUND` 并发)、以及删除后的列表刷新语义,这三样与 T-21 的变更类交互同源;放进 T-20 会让本任务从「只读列表」变成「读写页」,红灯用例翻倍,也让 T-21 失去独立并行的价值。
**需要用户点头的原因**:与 design.md 字面有偏差,且直接决定 T-20 的验收面大小。

**F3 · 列表形态:卡片列表(reg-key 轨)还是 `el-table`(user 轨)?**
两者都是仓内既有约定。我在 §6.4 给了完整论证并**建议卡片**(8 字段窄屏不横滚、CSS 单断点、spec 不用 stub `el-table`、代码量约为表格轨的 1/3)。
**需要用户点头的原因**:这决定了整个管理模块的视觉基调 —— T-21 抽屉、T-22 向导都会跟着这个基调走,改起来是全 W4 返工,不是一页返工。

---

## 14. 执行前自检清单(给 T-20 执行者)

- [ ] §13 三条迷雾已取得裁决(aside 入口 / 行操作归属 / 列表形态)
- [ ] `listMailShares()` **无参调用仍只传一个实参**,`request/mail-share.spec.js:50` 基线绿
- [ ] 5 个新端点函数为纯透传,未在前端复制后端字段白名单
- [ ] `isShareForbidden` 落在 `request/mail-share.js`,判据 `code===403 || message==='SHARE_FORBIDDEN'`,镜像 `share.js:39-44`
- [ ] 路由落 `perm/perm.js` 的 `routers['share:manage']`,`meta` 为 `{title:'shareManage', name:'share-admin', menu:true, perm:'share:manage'}`
- [ ] **`mail-vue/src/router/index.js` 改动 0 行**;`beforeEach` / `afterEach` 一字未动
- [ ] 403 面板与通用错误面板是两个不同的 `data-test`,且 403 后 token 仍在
- [ ] 未给任何请求加 `noMsg`
- [ ] 只新建 `index.vue` + `status.js` 两个生产文件;无 drawer / 无 form / 无行操作按钮 / 无空 emit
- [ ] 所有颜色走 `style.css` 的 CSS 变量或 `--el-*`,零裸 hex;`.dark` 下自查一遍
- [ ] 四态徽标颜色 + 文案并存,并写进 `data-status`;配额列 `tabular-nums`
- [ ] `@media (max-width: 767px)` 已写;JS 侧无 `window.onresize` 赋值
- [ ] `zh.js` / `en.js` 一字未改;9 个新键已在 exec note 登记成表
- [ ] 切筛选复位 `page=1`;有 `reqSeq` 丢弃过期响应
- [ ] 定点红→绿;邻接 5 份 spec 全绿;`pnpm --dir mail-vue test` 与基线比只增不减(17/95 → 18/95+N)

---

## 15. 参考锚点索引

```
契约   docs/specs/mailbox-share-capability/requirements.md:155(AC-ADMIN-01)、:163(AC-ADMIN-09)
       docs/specs/mailbox-share-capability/design.md:135(前端两域隔离)、:301(list 分页契约)
       :388-391(管理模块 / 列表页规格)、:392(详情抽屉 = T-21 边界)、:665(端点 ↔ 前端映射)
       docs/specs/mailbox-share-capability/tasks.md:27(i18n 单写者)、:455-458(T-20)、:460-461(T-21)
       :522-523(W4 并行说明)
请求   mail-vue/src/request/mail-share.js:1-42(3 函数,本次扩展点)
       mail-vue/src/request/mail-share.spec.js:47-52(★ 无参单实参基线)
       mail-vue/src/request/share.js:32-44(isShareRateLimited / isShareUnavailable · 判据范式)
       mail-vue/src/axios/index.js:17-70(响应拦截:401 清 token / 403 仅 toast)、:74-77(传输层 403 → reload)
路由   mail-vue/src/perm/perm.js:29-37(permsToRouter)、:39-122(routers 表,本次落点)、:3-26(v-perm 指令 / hasPerm)
       mail-vue/src/router/index.js:8-78(静态 routes)、:143-178(beforeEach 访客白名单 · 禁改)
       :180-206(afterEach:meta.menu 与 767 复位)、:193-199
       mail-vue/src/init/init.js:57-60(addRoute('layout', …))
页面   mail-vue/src/views/reg-key/index.vue:1-64(卡片列表范式)、:134(isMobile)、:546(767 CSS)
       mail-vue/src/views/user/index.vue:107-132(双分页)、:1018-1038(adjustWidth JS 轨 · 不采用)
       mail-vue/src/views/email/ShareDialog.vue:44-72(行 DOM / data-status / 字段回落链)、:161-189(一次性密钥 · T-21 复用)
       mail-vue/src/views/email/ShareIndicator.vue:20-26(hasPerm 空 user 兜底)、:50(无参 list 调用点;ShareDialog.vue:144 同)
       mail-vue/src/layout/aside/index.vue:8-67(菜单 · v-perm · manage-title 分组)
样式   mail-vue/src/style.css:31-38(全站字体/行高)、:108-143(:root 令牌)、:145-174(.dark 配对)
后端   mail-worker/src/api/mail-share-api.js:23-68(8 端点方法/传参方式)
       mail-worker/src/service/mail-share-service.js:371-378(OWNER_ROW_COLUMNS)、:383-388(状态 CASE)
       :424-456(projectOwnerRow · 行字段真源)、:491-509(bindings 摘要)、:935-944(UPDATE_FIELDS)
       :993-1019(分页/筛选归一)、:1372-1410(list)、:1186-1189(bindings 入参)、:1331-1332(resetAuthKey action)
       mail-worker/src/security/security.js:72-81(requirePermsExact)、:112-121(premKey)、:163-186(403 分支)
       mail-worker/src/hono/hono.js:9-30(onError:恒 HTTP 200 + body code)
       mail-worker/src/service/user-service.js:32-36('*' 只发环境 admin)
测试   mail-vue/src/views/email/ShareDialog.spec.js:1-116(mock/stub/mount 范式 · 直接照抄)
       mail-vue/src/router/index.spec.js:1-109(访客守卫基线 · 不加 owner 用例)
       mail-vue/src/init/init.spec.js:53-56(源码文本断言范式 · M1 用例依据)
       mail-vue/src/test/setup.js:1-14(matchMedia 桩恒 false)
       mail-vue/vitest.config.js:31-46(jsdom · include src/**/*.spec.js · element-plus inline)
前锋   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-frontend.md:92(767 约定)、:119(WP-F3)
       .../recon-t18-cascade.md(本文件的体例来源)
```
