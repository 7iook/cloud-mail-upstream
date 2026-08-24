# T-26 侦察 · 访客页 authRequired + 建会话幂等 + 刷新策略 + 会话清理(W5 最后一根横杠)

| 字段 | 值 |
|---|---|
| 任务 | T-26 / T-26.1 / T-26.2 |
| 分支 | `cursor/mailbox-share-capability-dcb6` |
| 基线 | **HEAD `fe7b90f`**。`git diff --stat HEAD -- mail-vue mail-worker` 为空,工作树只有 4 个未跟踪 `.md`,**本文全部行号 = HEAD 行号 = 工作树行号** |
| 性质 | 只读侦察,未改任何生产/测试文件 |
| 前置阅读 | frontend-design / impeccable / ui-ux-pro-max / ponytail(lite) 四份 SKILL.md 已读;tasks.md:580-584;design.md:399-404 / :236-243 / :335;requirements.md AC-AUTH-01 / AC-SESS-03 / AC-SESS-10 / AC-OTP-05 / AC-OTP-08 / AC-SEC-07 / AC-EDGE-03;recon-t25-tabs.md §10 / §11;exec-t25-note.md §5;recon-t24-otp-card.md T24-CONFIG |

---

## 0. 一句话结论

后端四件事(`SHARE_AUTH_REQUIRED` 错误码、`Idempotency-Key` 头、`config.autoRefresh/refreshIntervalMs`、`expiresAt`)**全部已在 HEAD 就绪且被 worker 单测钉死**,T-26 是纯前端消费,worker 零 diff。但派单里「`request/share.js` 只加 Idempotency-Key」这一条**字面上不可执行**:`createShareSession(lid, sec, config)`(`request/share.js:155`)的 body 是硬编码的 `{lid, sec}`,**没有任何入口把 `authKey` 送进去**——不改这个签名,访客输入的 Key 永远到不了 `share-api.js:60`。正确的读法是「新增的 **header** 只有 `Idempotency-Key`,`authKey` 必须走 **body**」(AC-SEC-09 / T-27.3 明令 header 不得出现 authKey),这条见 Fog-1。

第二个真实结论:`useSharePolling.js` **必须改 4 处**(不是零改)。`intervalMs` 在 `:58` 是 setup 期快照,而 `refreshIntervalMs` 是 `bootstrap()` 里 await 回来的,时序上晚于 setup —— 不改就是永远 3000。改法是 3 行(见 §5),`autoStart` 参数**不需要**,证据同 §5。

---

## 1. 可执行文件清单

### 1.1 需要写的文件(8 个,零新建)

| # | 文件 | 动作 | HEAD 基线 | T-26 内容 |
|---|---|---|---|---|
| 1 | `mail-vue/src/views/share/session.js` | 改 | 104 行 / 11 导出 | `share:est-key:` 前缀 + `shareEstablishKey` / `ensureEstablishKey` / `clearEstablishKey`(约 +26 行),见 §4 |
| 2 | `mail-vue/src/views/share/session.spec.js` | **只扩展** | **6** `it()` | +5:键形状 / `ensure` 同 lid 幂等 / `clear` / 不误伤 `share:session:` 与 `share:status:` / 两次调用不同 lid 不同值 |
| 3 | `mail-vue/src/request/share.js` | 改 | 189 行 | `createShareSession` 收 `authKey`(body)+ `idempotencyKey`(header)+ 新增 `isShareAuthRequired`,约 +14 行。**不新增第二个 axios 实例** |
| 4 | `mail-vue/src/request/share.spec.js` | **只扩展** | **10** `it()` | +4:带 key 时头出现 / 不带时头缺席 / `authKey` 只在 body 不在 header/URL / `isShareAuthRequired` 真值表 |
| 5 | `mail-vue/src/composables/useSharePolling.js` | 改 | 214 行 | 只动 `:58` + 4 个消费点(`:163` `:169` `:177` `:202`),见 §5。**不加 `listStatus`/`mode`/`autoStart`** |
| 6 | `mail-vue/src/composables/useSharePolling.spec.js` | **只扩展** | **7** `it()` | +1:`intervalMs` 传 `ref`,首拍后改值 → 下一拍按新值调度 |
| 7 | `mail-vue/src/views/share/index.vue` | 改 | 876 行 | 主战场:`authRequired` 节点 + establish 收口 + 刷新策略 + 倒计时 + 清理,见 §2 |
| 8 | `mail-vue/src/views/share/index.spec.js` | **只扩展 + 1 行必改** | **35** `it()` | +约 14 条;**唯一允许改写 `:164`**,理由见 §9.2 |

### 1.2 必须零改动的文件

| 文件 | 为什么不能碰 |
|---|---|
| 全部 `mail-worker/**` | 后端已全备(§3.1 / §4.1 / §6.1 逐条给出行号证据)。T-26 结束时 `git diff --stat mail-worker` 必须为空,可自证 |
| `mail-vue/src/router/index.js:157-161`(守卫)/ `:181-183`(afterEach 清 `share:session:`) | 派单 negative 显式禁止;且 `:182` **已经**在离开 share 路由时清 `share:session:<lid>`——T-26 只需在组件侧补 `share:est-key:`,见 §7 |
| `mail-vue/src/init/init.js:18-20` / `:34-36` | `assert-share-entry.js` 钉死 |
| `mail-vue/src/views/share/assert-share-chunk.js` | 闸门本体。T-26 不引任何新依赖(只有 `vue` + 同目录相对文件 + `@/request/share.js`),`FORBIDDEN` 四条天然不触发 |
| `mail-vue/src/views/share/status-watermark.js` + `.spec.js` | T-25 独占。**`share:status:<lid>` 不在 T-26 的清理契约里**,见 §7.3 |
| `mail-vue/src/views/share/ShareOtpCard.vue` / `mail-fields.js` | T-24 独占,props 保持 `mails/selected/enabled` 三个 |
| `mail-vue/src/request/mail-share.js` | **登录态图**(`:1 import http from '@/axios/index.js'`)。share chunk 引它 = 直接违反 AC-VISIT-10 与 `assert-share-chunk` 的 `axios-index-reload` 规则。`newIdempotencyKey` 不许 import,见 §4.2 |
| `mail-vue/src/i18n/zh.js` / `en.js` | 单写者 T-29。T-26 的新键**只记录不落盘**,见 §8.2 |

### 1.3 验证命令

```
pnpm --dir mail-vue exec vitest run --no-cache src/views/share/session.spec.js src/request/share.spec.js
pnpm --dir mail-vue exec vitest run --no-cache src/views/share/index.spec.js src/composables/useSharePolling.spec.js
pnpm --dir mail-vue exec vitest run --no-cache src/views/share/share-chunk.spec.js      # 隔离闸门(~180s)
pnpm --dir mail-vue test -- --no-cache                                                   # 全量基线 22 files / 221 passed
pnpm --dir mail-worker test -- --no-cache                                                # 必须原地 18 / 626(worker 零改)
pnpm --dir mail-vue build
git diff --stat mail-worker                                                              # 必须为空
```

---

## 2. `index.vue` 切割线(HEAD `fe7b90f` 实测行号)

### 2.1 模板:四处切口(全部不动既有钩子)

| 位置 | 现状 | T-26 动作 |
|---|---|---|
| `:8-13` header 的 `<p v-else-if>` 链 | 6 个状态,无 `authRequired` | **插入一条** `v-else-if="state === 'authRequired'"`。文案是「这个分享需要一把访问密钥」,**不得**暗示尝试次数/剩余次数(R2-A6 无锁定) |
| `:13` 之后、`:14` Leave 按钮之前 | 无 | **插入** `<span v-if="expiresLabel" data-share-expires>` 倒计时。`aria-live` 一律**不加**(每秒播报是读屏灾难,ui-ux-pro-max P1) |
| `:28`(`data-share-wait`)之后、`:30`(`data-share-body`)之前 | 无 | **插入** `<form v-if="state === 'authRequired'" data-share-auth @submit.prevent>`。放在 `data-share-body` **之外**:`:139` 的 `<div v-else data-share-body></div>` 必须继续以空 div 存在(`:325` 的既有断言依赖这个钩子存在) |
| `:61`(`</nav>`)之后、`:63`(`#share-tabpanel`)之前 | 无 | **插入** `<button v-if="!autoRefresh" data-share-refresh>`。在 `data-share-body` **之内**、tabpanel **之外**(它刷新的是整页,不属于任何一个 Tab) |

新钩子(4 + 2 个,**不许复用** T-24 的 `data-share-code*` / T-25 的 `data-share-tab*`):
`[data-share-auth]`(form)、`[data-share-auth-input]`、`[data-share-auth-submit]`、`[data-share-auth-error]`、`[data-share-refresh]`、`[data-share-expires]`。

### 2.2 脚本:新增状态(6 个 ref,不要更多)

| 新增 | 类型 | 说明 |
|---|---|---|
| `autoRefresh` | `ref(true)` | 缺省 true。判定一律 `=== false` 才关(与 `:468` `otpExtractionEnabled` 同口径) |
| `refreshIntervalMs` | `ref(POLL_INTERVAL_MS)` | 从 `@/composables/useSharePolling.js` 复用 3000 常量,**不要**在 index.vue 里再写一个字面量 |
| `expiresAt` | `ref('')` | session 响应原样字符串,解析见 §6.2 |
| `nowMs` | `ref(Date.now())` | 倒计时唯一驱动源;1s `setInterval`,`onUnmounted` 清 |
| `authKeyInput` | `ref('')` | 只在内存。**绝不写 sessionStorage、绝不进 URL、绝不进日志** |
| `authError` | `ref(false)` | 布尔即可。**不要**计数器——计数器就是锁定 UI 的第一块砖(R2-A6) |

`justRecovered`、`pageSecret` 保持原状。`pageSecret`(`:190`)在 `authRequired` 期间**必须保留**,否则重试时无 `sec` 可发;`onUnmounted:739` 已经清它。

### 2.3 establish 收口:抽一个 `establishAndEnter`,不要抽两个

HEAD 现在有 **两处** `createShareSession` 调用:`bootstrap:708` 与 `reestablishSession:526`。T-26 要在两处之外再加第三处(AuthKey 提交),按 ponytail 第 2 阶(先看有没有现成的)只允许出现**一个**新函数:

```
// 唯一的 POST /share/session 出口:同 key 幂等 + 传输层失败原地重试一次
async function postSession(lid, sec, authKey) {
    const idempotencyKey = ensureEstablishKey(lid)          // ① 发请求「前」写 storage
    try {
        return await createShareSession(lid, sec, { authKey, idempotencyKey })
    } catch (err) {
        if (!isLostResponse(err)) { throw err }              // ② 只有「没拿到响应」才重试
        return await createShareSession(lid, sec, { authKey, idempotencyKey })  // ③ 同一个 key
    }
}
```

- ① `ensureEstablishKey` 读到已有键就原样返回(§4),所以「输错 Key 再试」「响应丢失后重试」自动复用同一 key,**不需要**任何额外的「禁止换 key」逻辑。
- ② `isLostResponse(err)` = 「不是 429、不是业务信封、没有 `err.response`」。**必须这么严**:业务信封说明响应已经到达(再打一次纯属浪费配额与限流额度),429 重试会自己加重限流。
- ③ 只重试 **1 次**。指数退避是 `useSharePolling` 的活,这里是建会话,失败就交给状态机。

`bootstrap:707-723` 与 AuthKey 提交共用的「拿到 token 之后」那一段(`writeShareSession` → `sessionToken` → `applyShareConfig` → `mailbox` → `state='ready'` → `beginMailbox()`,现在是 `:715-720`)抽成 `enterReady(lid, data)`。`reestablishSession:520-538` **不并进来**——它刻意不改 `state`、不调 `beginMailbox`(由 `noteShareFailure:596` 负责),并进去会把 `justRecovered` 的自愈语义搅乱。它只需把 `:526` 换成 `postSession(lid, sec, '')`。

### 2.4 `authRequired` 的三处接线

| 位置 | HEAD | T-26 |
|---|---|---|
| `bootstrap` 的 catch(`:721-723`) | `await noteShareFailure(err, true)` | 前面加 `if (isShareAuthRequired(err)) { state.value = 'authRequired'; return }`。**这一行就是全部**,§3 解释为什么现在会塌缩成 unavailable |
| 新 `submitAuthKey()` | — | 空/提交中直接 return;`isShareAuthRequired` → `authError=true` 停在原态;`isShareRateLimited` → `rateLimited=true`(AC-AUTH-06:429 是运输层,不是「Key 错」);其余 → `noteShareFailure(err, true)` |
| `resetMailbox`(`:616-622`)/ `bootstrap` reset 段(`:688-694`) | — | reset 段补 `authKeyInput=''` / `authError=false` / `autoRefresh=true` / `refreshIntervalMs=POLL_INTERVAL_MS` / `expiresAt=''`,与 T24-CONFIG 的「防跨 lid 残留」同一处 |

**负面**:不加尝试计数、不加冷却、不 disable 输入框、不显示「还剩 N 次」。唯一节流是边缘限流的 429,它已经有 `[data-share-wait]`(`:24-28`)。

### 2.5 `applyShareConfig` 扩展(T24-CONFIG:只扩展,不另开读取点)

`:467-471` 现有 4 行,**一行都不改**,只追加 3 行:

```
    autoRefresh.value       = !(data && data.config && data.config.autoRefresh === false)
    refreshIntervalMs.value = clampInterval(data && data.config && data.config.refreshIntervalMs)
    expiresAt.value         = (data && data.expiresAt) || ''
```

`clampInterval(v)` = 非有限数或 `< POLL_INTERVAL_MS` → `POLL_INTERVAL_MS`,否则 `Math.floor(v)`。这不是重复后端的 `clampRefreshInterval`(`share-auth-service.js:384-390`),而是**客户端自保**:下发 `10` 会让访客自己的浏览器每 10ms 打两个请求。3 行成本。

### 2.6 `polling.start()` 的两个门(容易漏掉第二个)

`beginMailbox` 里有 **两处** `polling.start()`:`:653`(正常路径)与 `:657`(429 后仍要继续轮询)。`autoRefresh=false` 时**两处都要门**:

```
if (autoRefresh.value) { polling.start() }
```

只门 `:653` 会出现「关掉自动刷新的分享,一旦撞上 429 反而开始自动刷新」这种反向 bug。`:329` 的 setup 期 `polling.stop()` 保持不动,它是 `autoStart` 不需要存在的原因(§5.2)。

### 2.7 手动刷新:复用 `pollTick`,不写第二条取数路径

硬约束(recon-t25 §10.3):两条取数路径 = 两套水位推进语义。`pollTick`(`:308-318`)刻意不接错误(`:305-307` 注释),所以手动路径必须自己接:

```
async function manualRefresh() {
    if (refreshing.value) { return }
    refreshing.value = true
    try {
        const page = await pollTick({ sessionToken: sessionToken.value, limit: PAGE_LIMIT })
        onPolledMails(page && page.list)          // 与 useSharePolling:158 同一个回调,不另写 merge
    } catch (err) {
        await noteShareFailure(err)               // 429 → rateLimited(:541-546);UNAVAILABLE → 自愈/死链
    } finally {
        refreshing.value = false
    }
}
```

`onPolledMails`(`:261-264`)已经是 `rateLimited=false` + `mergeMails`,直接复用;`noteShareFailure(err)` 的 `fromSession` 默认 false,所以 429 走 `:541-546` 只置 wait 态、UNAVAILABLE 走 `:562-584` 的 `pageSecret` 自愈——与自动轮询完全同语义。请求账本也一致:**一次点击 = 1 status + 1 mails**(T25-ALWAYS-FETCH)。

`refreshing` 这第 7 个 ref 是必要的:ui-ux-pro-max P2「Loading feedback」+ 防连点重入。

---

## 3. `SHARE_AUTH_REQUIRED` 今天如何塌缩成 unavailable(逐跳证据)

### 3.1 后端:错误码已就绪,且**在配额与幂等之前**抛出

| 跳 | 位置 | 事实 |
|---|---|---|
| 1 | `share-api.js:55-63` | `POST /share/session` 读 `body.authKey`(**body,不是 header**)与 `Idempotency-Key` 头,交给 `establishSession(c, lid, sec, {idempotencyKey, authKey})` |
| 2 | `share-auth-service.js:520-531` | `auth_key_enabled` 为真且 `matchAuthKey` 失败 → `throwAuthRequired()`。**位置在 `:532-538` 幂等重放查询之前、`:544-563` 配额闸门之前** |
| 3 | `share-api.js:33-35` `withShare` | `BizError` → `shareJson(c, shareResult.fail('SHARE_AUTH_REQUIRED', 501))` |
| 4 | `share-result.js` | `fail(message, code)` → `{ code: 501, message: 'SHARE_AUTH_REQUIRED' }`,**HTTP 状态是 200** |

跳 2 的顺序有两个直接后果,T-26 可以白拿:
- **错 Key 零配额、零 KV 写**(AC-AUTH-01 / AC-EDGE-12),所以「输错 3 次再输对」不会烧掉 3 个 `max_sessions`。
- **同一个 `Idempotency-Key` 跨越 authRequired 重试是安全的**:失败路径根本没写过缓存,输对后走的是全新的条件 UPDATE。这就是 §2.3 里不需要「换 key」分支的原因。

### 3.2 前端:三行代码把它变成死链

| 跳 | 位置 | 事实 |
|---|---|---|
| 5 | `request/share.js:134-143` | HTTP 200 + 有 `code` 字段 → `asEnvelope` 命中;`code !== 200` → `Promise.reject(envelope)`。**reject 出去的是普通对象 `{code:501, message:'SHARE_AUTH_REQUIRED'}`,不是 Error** |
| 6 | `index.vue:721-723` | `catch (err) { await noteShareFailure(err, true) }` —— `fromSession` 写死为 `true` |
| 7 | `index.vue:593-598` → `:540` | `recoverFromUnavailable(err, true)`:`isShareRateLimited` 假(无 `status`/`name`)→ `:548` 因 `fromSession` 为真而短路 → **`:553-556` `if (fromSession) { showDeadShare(err); return false }`** |
| 8 | `index.vue:502-509` | `showDeadShare` → `polling.stop()` + `clearMailboxView()`(清 `share:session:<lid>`) + `state='unavailable'` |

**塌缩点就是第 7 跳的 `:553`**:`fromSession=true` 是「建会话失败 = 链接死了」的粗口径,它无条件吃掉一切 session 错误。T-26 的修法**不是**改 `:553`(那会动 AC-VISIT-12 / AC-VISIT-14 两条既有断言:`:238` `:250` `:442`),而是在**第 6 跳之前**分流(§2.4 第一行)。这样 `recoverFromUnavailable` 的语义一个字不变,`index.spec.js:238-248` / `:250-262` / `:442` 三条基线自动保持绿。

### 3.3 判别函数放哪(§10 Fog-1 的一部分)

`isShareUnavailable`(`request/share.js:39-44`)与 `isShareRateLimited`(`:32-37`)都在 `request/share.js`,index.vue 从那里 import(`:153-154`)。第三个判别式放别处就是三份口径:

```
export function isShareAuthRequired(err) {
    return Boolean(err) && (err.code === 'SHARE_AUTH_REQUIRED' || err.message === 'SHARE_AUTH_REQUIRED')
}
```

`err.code` 那一支是给 `BizError` 形态与测试直接 reject 的裸对象留的(`index.spec.js:240` 就是这么造 `SHARE_UNAVAILABLE` 的),`err.message` 那一支覆盖真实信封。**注意 `isShareUnavailable:41` 会对 AUTH_REQUIRED 返回 false**(它只认那一个字符串),所以两者不会互相污染,`recoverFromUnavailable:548` 对一个漏网的 AUTH_REQUIRED 仍然是安全的死链兜底。

---

## 4. `Idempotency-Key`:不 import `mail-share.js` 怎么生成

### 4.1 后端契约(已就绪,零改动)

| 项 | 值 | 出处 |
|---|---|---|
| 传输 | `Idempotency-Key` 请求头 | `share-api.js:57` |
| 空白等于没有 | `String(raw).trim()` 为空 → 走普通计费路径 | `share-auth-service.js:448-453` |
| 缓存键 | `share:est:<lid>:<key>`(KV,服务端侧) | `:444-446` |
| TTL | `min(120s, token 剩余寿命)`,剩余 `<60s` 跳过写 | `:481-493` |
| 命中条件 | 缓存 token 的 `cv` == 当前行 `credentials_version` | `:463-476` |
| 客户端键 | `sessionStorage` 的 **`share:est-key:<lid>`** | design.md:400 / requirements.md AC-SESS-10 |

服务端只要求 key 是「非空、trim 后稳定的字符串」——**没有 UUID 格式要求**。

### 4.2 生成:`crypto.getRandomValues`,不要 `randomUUID`,更不要 import

`mail-share.js:3-17` 的 `newIdempotencyKey` 不能用,因为该文件 `:1` `import http from '@/axios/index.js'` —— 登录态图,`index.spec.js:520` 的 AC-VISIT-10 正则 `/@\/axios\/index/` 会直接红,`assert-share-chunk.js:13` 的 `location.reload` 规则也会在构建产物上命中。

落点选 **`session.js`**,理由三条:(a) 它是 sessionStorage 键的唯一归属地,est-key 的「生成 + 落盘 + 清除」是同一件事;(b) 它零 import(`:1` 就是一个 `export const`),加进去不改变任何依赖图;(c) T-26 本来就独占它。

```
export const SHARE_ESTABLISH_KEY_PREFIX = 'share:est-key:'

export function shareEstablishKey(lid) { return `${SHARE_ESTABLISH_KEY_PREFIX}${String(lid || '')}` }

// 发请求「前」就落盘:响应丢失后同一 lid 的下一次 establish 读回同一个 key(AC-SESS-10)。
export function ensureEstablishKey(lid) {
    if (!hasLid(lid)) { return '' }
    const storageKey = shareEstablishKey(lid)
    const existing = sessionStorage.getItem(storageKey)
    if (existing) { return existing }
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    sessionStorage.setItem(storageKey, key)
    return key
}

export function clearEstablishKey(lid) { if (hasLid(lid)) { sessionStorage.removeItem(shareEstablishKey(lid)) } }
```

为什么是 `getRandomValues` 而不是 `randomUUID`:

- `crypto.randomUUID()` **仅在 secure context 可用**;`crypto.getRandomValues()` 在非 secure context 也在。分享页在 http 内网地址上打开时,`randomUUID` 是 `undefined`,会掉进弱回退分支。
- 实测两者在本仓库的 jsdom(`vitest.config.js:35 environment: 'jsdom'`)里都存在,所以**不是**测试环境驱动的选择,是运行时驱动的选择。
- 128 bit 十六进制串足够:碰撞只在「同一 lid + 120s 窗口 + 两个访客同时」才有意义,`Math.random` 回退(`mail-share.js:11-13` 那种)在这个语义下是真的安全弱点——**不要抄那段回退**。

> ponytail(lite) 的更懒选项:直接 `crypto.randomUUID()` 一行。**不建议**,原因是上面第一条(非 secure context 直接炸),不是风格偏好。

### 4.3 生命周期(四个时刻,一个不能少)

| 时刻 | 动作 | 依据 |
|---|---|---|
| 发 `POST /share/session` **前** | `ensureEstablishKey(lid)`(有则复用) | design.md:400 / AC-SESS-10 |
| 拿到 token 成功后 | `clearEstablishKey(lid)` | design.md:400「成功拿到 token 后清除该 key」 |
| 收 `SHARE_UNAVAILABLE` | `clearEstablishKey(lid)`,落在 `clearMailboxView:490-500` 里(`showDeadShare`/`showTimedOut` 共用) | AC-SEC-07 |
| 离开路由 / 组件卸载 | `clearEstablishKey(lid)`,落在 `onUnmounted:738-741` | AC-SEC-07 + §7.1 |

**不清的时刻**:`SHARE_AUTH_REQUIRED` 之后(要复用)、429 之后(`:275-285` 基线明确「429 不清会话」,est-key 同理)。

---

## 5. `useSharePolling`:要 `toValue(intervalMs)`,不要 `autoStart`(证据,不是偏好)

### 5.1 `toValue` — **需要**,时序上不可回避

`:58` `const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS` 是 **setup 期一次性求值**。而 `refreshIntervalMs` 的到达时刻是:

```
index.vue:320-328  useSharePolling({...})        ← setup 期,同步执行
index.vue:329      polling.stop()
index.vue:736      watch(..., bootstrap, {immediate:true})
index.vue:708        await createShareSession(...)  ← 网络往返
index.vue:717        applyShareConfig(data)         ← refreshIntervalMs 第一次有值
```

`applyShareConfig` 严格晚于 `useSharePolling(...)` 一个 await。传 `refreshIntervalMs.value` 得到的是 3000 常量;传裸的 ref 会让 `setTimeout(fn, RefImpl)` 收到 `NaN` → 退化成 0ms → **紧密轮询**(比不生效更糟)。传 getter 同理。所以只有一条路:让 composable 求值。

最小改法(3 行净增,4 处消费点重命名):

```
:58   const readInterval = () => {
          const raw = toValue(options.intervalMs)
          return Number.isFinite(raw) && raw > 0 ? raw : POLL_INTERVAL_MS
      }
:163  schedule(readInterval())
:169  schedule(retryAfterMs(err, readInterval()))
:177  schedule(readInterval())
:202  schedule(readInterval())
```

`toValue` 在 `:1` **已经 import**,零新依赖。向后兼容:`toValue(3000) === 3000`,`useSharePolling.spec.js:24` 传的就是裸数字,7 条基线不受影响;`index.spec.js` 里 14 处 `advanceTimersByTimeAsync(POLL_INTERVAL_MS)`(`:429` `:471` `:750` `:772` `:792` `:808` `:833` `:845` `:887` `:948` `:955` `:987` `:1001` `:1041`)在 mock 不带 `config` 时 `clampInterval` 返回 3000,同样不受影响 —— **这是 §2.5 里 `clampInterval` 的下限必须恰好是 `POLL_INTERVAL_MS` 的硬理由**,改成别的数会一次性红掉 14 条。

`:169` 那处别漏:429 的 fallback 间隔也应当跟随下发值,否则「8s 间隔的分享撞上无 Retry-After 的 429」会退回 3s。

### 5.2 `autoStart` — **不需要**,现成的两个开关已经够

三条证据:

1. `:205` 的 setup 期 `start()` **已经被 `index.vue:329` 的 `polling.stop()` 抵消**。`stop()`(`:98-103`)置 `stopped=true` + `clearTimer()` + `detachVisibility()`,`:202` 排的那一发定时器当场被清,可见性监听也摘掉了。构造完成时轮询是净停止的。
2. `bootstrap` 的每一次进入都经过 `resetMailbox()`(`:687` → `:617 polling.stop()`),所以「切 lid」也回到净停止。
3. 全文件只有 `:653` 与 `:657` 两处 `polling.start()`,都在 `beginMailbox` 里。`autoRefresh=false` 只要门住这两处(§2.6),轮询就永不启动。

加 `autoStart` 参数的净收益是「省掉 `:329` 那一行」,代价是给一个通用组合式增加一个只有一个消费者的开关(ponytail 规则:no config for a value that never changes)。**不加。**

---

## 6. 刷新策略与倒计时

### 6.1 后端下发面(全部已在 HEAD,零改动)

`share-auth-service.js:392-412 buildSessionPayload`:

```
expiresAt: row.expiresAt,
config: { autoRefresh, refreshIntervalMs, otpExtractionEnabled, messageLimit }
```

`autoRefresh` 经 `toBoolean`;`refreshIntervalMs` 经 `clampRefreshInterval:384-390` 已在服务端钳到 `>=3000`(§2.5 的客户端钳制是纵深防御,不是重复)。

### 6.2 `expiresAt` 的时区陷阱(倒计时唯一的真 bug 风险)

- 列类型是 **text**(`entity/mail-share.js:15 text('expires_at')`)。
- 写入格式是 `dayjs(...).format('YYYY-MM-DD HH:mm:ss')`(`mail-share-service.js:1141`),Worker 运行时时区是 UTC,所以字符串**是 UTC 但不带任何时区标记**。
- 服务端自己也按裸字符串比较(`share-auth-service.js:51 row.expiresAt <= now`,`now` 来自同样的 `nowText():43-45`),所以「这个字符串就是 UTC」是定义性的,不是猜测。
- 浏览器把 `new Date('2026-08-24 12:00:00')` 解析为 **本地时间**。东八区访客的倒计时会凭空多出 8 小时。

所以倒计时必须:

```
const at = Date.parse(String(expiresAt.value).replace(' ', 'T') + 'Z')
```

前端现有的三处 `expiresAt` 渲染(`share-admin/index.vue`、`ShareDetailDrawer.vue`、`email/ShareDialog.vue`)都是**原样打印字符串、从不解析**,所以仓库里**没有**可复用的解析 helper,T-26 得自己写这一行(ponytail 第 2 阶已经查过,确认无现成件)。

驱动方式:`setInterval(() => { nowMs.value = Date.now() }, 1000)`,`onUnmounted` 清。**不要**用 `serverTime`(status 响应 `share-api.js:86` 确实带它)去做时钟对齐——那是给客户端时钟漂移用的,多一层状态换不来可感知的正确性,`expiresAt` 剩余时间是分钟级展示。

`expiresAt` 为空(§7.2 的复活路径)→ `expiresLabel` 为空 → 整个 `[data-share-expires]` 不渲染。**不要**渲染 `--:--` 占位。

### 6.3 请求账本(写断言用)

| 场景 | status | mails | 备注 |
|---|---|---|---|
| `autoRefresh=true`,每 tick | 1 | 1 | T25-ALWAYS-FETCH 不变 |
| `autoRefresh=true`,`refreshIntervalMs=8000` | 8000ms 一组 | 同 | 断言:`advanceTimersByTimeAsync(3000)` 后 **0 次**,再 `advanceTimersByTimeAsync(5000)` 后 1 组 |
| `autoRefresh=false`,静置 60s | **0** | **0** | 断言:`advanceTimersByTimeAsync(POLL_INTERVAL_MS * 20)` 后调用数不变 |
| `autoRefresh=false`,点一次刷新 | 1 | 1 | 与一个 tick 完全同形 |
| 建会话:首发成功 | — | — | `createShareSession` 1 次,`share:est-key:<lid>` 事后为 null |
| 建会话:首发无响应 | — | — | `createShareSession` **2 次**,两次的 `idempotencyKey` **相同** |
| 建会话:AuthKey 错 → 对 | — | — | `createShareSession` 2 次,`idempotencyKey` 相同,第二次 body 多一个 `authKey` |

---

## 7. 会话清理(AC-SEC-07)的准确归属

### 7.1 「离开路由」今天已经清了一半

`router/index.js:181-183` afterEach:

```
if (from && from.name === 'share' && to.name !== 'share') { clearShareSession(from.params.lid) }
```

`share:session:<lid>` 在真实路由离开时**已经被清**,而 router 是 T-26 的禁区。所以:

- `share:est-key:<lid>` 的离开清理只能落在 `index.vue:738-741 onUnmounted`。
- 建议 `onUnmounted` **两个键都清**(多 1 行):它让 AC-SEC-07 在组件级可测(`index.spec.js` 的 harness 从不真的导航离开,只 `wrapper.unmount()`),且与 router 的清理幂等叠加。
- **安全性检查**:这不会破坏 AC-SESS-03 的「同 tab 刷新复用 token」。浏览器刷新/关闭时 Vue 不执行 `onUnmounted`(它不挂在 `beforeunload` 上),`index.spec.js:172-180` 那条基线走的是「新 mount 读 sessionStorage」,与卸载无关。

### 7.2 「收到 SHARE_UNAVAILABLE」

`clearMailboxView:490-500` 已经 `clearShareSession(lid)`;`showDeadShare:502-509` 与 `showTimedOut:511-518` 都经过它。T-26 在 `:493` 那个 `if (lid)` 块里补一行 `clearEstablishKey(lid)` 即可,**一处覆盖三条路径**(死链 / 超时 / 轮询 UNAVAILABLE 经 `:326 onUnavailable`)。

`exitShare:600-614` 是访客主动「Leave」,不在 AC-SEC-07 字面里,但它已经清 session(`:606`);est-key 一并清才自洽(1 行)。

### 7.3 **不清** `share:status:<lid>`(这是 T-25 的红线,写进断言)

recon-t25 §3.3 / §10.1 已裁:水位是「已读进度」不是凭据,清掉只会丢失跨会话未读。T-26 的三个新清理点(`onUnmounted` / `clearMailboxView` / `exitShare`)**都不许**碰 `share:status:` 前缀,也**不许**把 `clearOtherShareSessions`(`session.js:34-46`,按 `share:session:` 前缀扫)改成泛 `share:` 前缀。

建议直接写成断言,防止后来者顺手改:

```
sessionStorage.setItem('share:status:lid-a', '{"0":7}')
// ...unmount / UNAVAILABLE...
expect(sessionStorage.getItem('share:session:lid-a')).toBeNull()
expect(sessionStorage.getItem('share:est-key:lid-a')).toBeNull()
expect(sessionStorage.getItem('share:status:lid-a')).toBe('{"0":7}')
```

顺带:`clearOtherShareSessions` 只清 `share:session:` 前缀,意味着**换 lid 时旧 lid 的 est-key 会残留**。`ensureEstablishKey` 按 lid 命名空间,残留键最多是一个 32 字符垃圾串,随标签页关闭消失,不是泄露(它不是凭据,是去重标签)。**不建议**为它扩 `clearOtherShareSessions` —— 那是改 T-25/共有语义换零收益。若主 AI 坚持,正确做法是在 `bootstrap` 里对 est-key 前缀做一次同形扫描,而不是改现有函数的行为。

---

## 8. UI 口径与 i18n

### 8.1 视觉:留在既有 GitHub-light toolbox token 里(与 T-24 / T-25 同一套)

现页面 token(`index.vue:749-876`):`system-ui` 字体栈 / `#1f2328` 正文 / `#4b5563` 次要 / `#d0d7de` 边框 / `#f6f8fa` 底 / `#0969da` 强调 / 6px 圆角 / `padding: 10px 12px`。**不引新字体、新主色、渐变、动效库**(frontend-design 的「bold aesthetic」在这里让位于 impeccable 的 Operate 模式:访客要的是拿到验证码,不是被设计打动)。

必须做到的几条(全部一行成本,来自 ui-ux-pro-max P1/P2/P8):

- **可见 label,不用 placeholder 当 label**(P8)。`<label for>` + `<input id>`。
- 输入框:`type="text"`(不是 `password` —— 这是从别处粘过来的一次性凭据,遮盖只会让访客校对不了)、`autocomplete="off"`、`autocapitalize="none"`、`spellcheck="false"`、`autocorrect="off"`。**`autocapitalize` 是功能性的**:AuthKey 是 base64url 定长 22 字符、大小写敏感,移动端自动首字母大写会稳定地毁掉第一次输入。
- 错误文案**贴在字段旁**(P8),`role="alert"` + `aria-describedby` 指向它;`aria-invalid="true"`。不用页面顶部横幅。
- 提交按钮 `type="submit"`,表单包 `@submit.prevent` → 回车可提交。空值时 disabled,提交中 disabled + 文案切「Checking…」(P2 loading feedback)。
- 触控目标 ≥44px:`padding: 10px 12px` 已达标(与 `.share-tab:797`、`.share-list button:842` 同值)。
- 焦点环 2px `#0969da`(复用 `.share-tab:focus-visible:819-822`)。
- 手动刷新按钮:文字按钮,不用纯图标(P1「Icon-only buttons without labels」);`disabled` 时给 `aria-busy="true"`。
- 倒计时**不加** `aria-live`;`<time :datetime>` 承载机器可读值。
- 375px:表单 `display:flex; flex-wrap:wrap; gap:8px`,输入框 `flex:1 1 12rem`。不做横向滚动。

### 8.2 i18n 新键(**只记录,不写 `zh.js` / `en.js`**,T-29 收口)

HEAD `en.js:369-385` 共 17 个 `shareVisit*` 键。落地前一律走 `tx('key', 'English fallback')`(`index.vue:209-211`),与全页一致。

| 键 | en fallback | 用途 |
|---|---|---|
| `shareVisitAuthTitle` | `This share needs an access key.` | `authRequired` 态 header 文案 |
| `shareVisitAuthLabel` | `Access key` | 输入框可见 label |
| `shareVisitAuthSubmit` | `Open` | 提交按钮 |
| `shareVisitAuthChecking` | `Checking...` | 提交中按钮文案 |
| `shareVisitAuthRetry` | `That key did not work. Check it and try again.` | 字段旁错误。**措辞不得出现次数/锁定/剩余尝试** |
| `shareVisitRefresh` | `Check for new mail` | `autoRefresh=false` 的手动刷新按钮 |
| `shareVisitRefreshing` | `Checking...` | 刷新中 |
| `shareVisitExpiresIn` | `Link expires in` | 倒计时前缀 |

**T-25 遗留未落盘的 2 个键一并交给 T-29**:`shareVisitMailboxes`(`index.vue:36`)、`shareVisitNewMail`(`:58`)。W5 总计 10 个新键。

---

## 9. 基线现实校正

### 9.1 逐项核对

| 项 | 文档写的 | HEAD `fe7b90f` 实测 |
|---|---|---|
| 状态机在 `index.vue:160` | tasks.md:581 / design.md:399 | **过期**。`state` ref 现在在 `:187`,模板分支在 `:8-13`。T-24/T-25 之后行号已漂 |
| `useSharePolling.js:58` 是 `intervalMs` 注入位 | tasks.md:581 / design.md:402 | ✓ 行号仍准,但**是快照不是响应式**,见 §5.1 |
| `request/share.js` 加 status 函数 | tasks.md:583 已改注「status 函数改由 T-25 落地」 | ✓ `getShareMailboxesStatus:166-171` 已在 |
| `POST /share/session` 收 `authKey` | design.md:335 `{lid, sec, authKey?}` | 后端 ✓(`share-api.js:60`);**前端 ✗**,`request/share.js:155` body 硬编码 `{lid, sec}` → Fog-1 |
| `Idempotency-Key` 头 | design.md:335 | 后端 ✓(`share-api.js:57`);前端 ✗,零调用点 |
| `config.autoRefresh` / `refreshIntervalMs` | design.md:335 | 后端 ✓(`share-auth-service.js:406-407`);前端 ✗,`applyShareConfig:467-471` 只读 `otpExtractionEnabled` |
| `expiresAt` | design.md:404「后端零改动」 | ✓(`:404`),但是**无时区标记的 UTC 字符串**,见 §6.2 |
| 「有效 token 时 bootstrap 不调 `/share/session`」 | tasks.md:581 | **已经是现状**(`:726-732` 只读 `readShareSession`),`index.spec.js:172-180` 已钉死。T-26 只需不回归 + 补一条「也不生成 est-key」 |
| 离开路由清 `share:session:<lid>` | AC-SEC-07 | **已经是现状**(`router/index.js:182`)。T-26 补 est-key,见 §7.1 |
| `views/share/index.spec.js` 基线 | tasks.md:560 写 35 | **35** ✓ |
| `session.spec.js` / `request/share.spec.js` / `useSharePolling.spec.js` | 未写 | **6 / 10 / 7** |

### 9.2 唯一允许改写的既有断言:`index.spec.js:164`

```
:163  expect(createShareSession).toHaveBeenCalledTimes(1)
:164  expect(createShareSession).toHaveBeenCalledWith('lid-a', 'sec-a')
```

`toHaveBeenCalledWith` 是**精确实参匹配**。§2.3 的 `createShareSession(lid, sec, { authKey, idempotencyKey })` 会让它红。改成:

```
expect(createShareSession).toHaveBeenCalledWith('lid-a', 'sec-a', expect.objectContaining({
    idempotencyKey: expect.any(String)
}))
```

这属「同一条测试的实参形状跟随签名」,与 T-25 允许的 4 行改动同性质(exec-t25-note §2.2 先例)。**除此之外 35 条正文一字不改**,尤其 `:172` `:238` `:250` `:275` `:442` 五条自愈/清理断言必须原样保留 —— 它们正是 §3.2 那条不改 `recoverFromUnavailable` 的理由。

`:514-525` 的 AC-VISIT-10 文件循环数组**不需要追加**(T-26 不新建文件),但循环里的 `/@\/axios\/index/` 正则会自动守住「不 import `mail-share.js`」。

### 9.3 新增断言规划(约 22 条)

| 文件 | 新增 | 覆盖 |
|---|---|---|
| `index.spec.js` +14 | AuthKey 3(塌缩点变 `authRequired` / 错 Key 只提示无锁定态无计数 / 对 Key 进 ready 且 `authKey` 与 `sec` 不落 storage 不进 console —— 复用 `:41-84 flattenLogged` 与 `:193` 的写法);幂等 3(发请求前 storage 已有键 / 无响应重试两次同 key / 成功后键被清);刷新 4(`autoRefresh=false` 静置零请求 + 出现 `[data-share-refresh]` / 点它恰 1 status + 1 mails / `refreshIntervalMs=8000` 时 3000ms 无动作 8000ms 有 / 手动刷新 429 → `[data-share-wait]` 且 token 仍在);清理 2(unmount 清两键留 status / UNAVAILABLE 清两键留 status);倒计时 2(UTC 解析正确 / `expiresAt` 缺失时不渲染) |
| `session.spec.js` +5 | 键形状 `share:est-key:lid-a` / 同 lid 二次调用返回同值 / 不同 lid 不同值 / `clearEstablishKey` 只清自己 / 三个前缀互不误伤 |
| `request/share.spec.js` +4 | 有 key → 头出现;无 key → 头缺席;`authKey` 只在 body(断言 `config.headers` 与 `config.url` 都不含它);`isShareAuthRequired` 真值表(含对 `SHARE_UNAVAILABLE` 返回 false) |
| `useSharePolling.spec.js` +1 | `intervalMs` 传 `ref(3000)`,首拍后改 8000 → 下一拍在 8000ms 处 |

预期全量:mail-vue 221 → 约 243;mail-worker 626 **不变**。

---

## 10. 迷雾清单(3 条,按风险降序)

### Fog-1 · `request/share.js` 的可写面比派单字面更宽,且会连带改一条既有断言

派单说「`request/share.js`(Idempotency-Key only)」。但 §0/§9.1 的证据显示,只加一个 header 做不出成功态:

| 需要的改动 | 为什么绕不开 | 建议 |
|---|---|---|
| (a) `authKey` 进 **body** | `share-api.js:60` 从 `body.authKey` 读;`createShareSession:155` 的 body 是硬编码字面量,第三参 `config` 是 axios config,`data` 会被第二参覆盖,塞不进去 | **必须做**。签名建议 `createShareSession(lid, sec, { authKey, idempotencyKey } = {})`,内部按需组装 body 与 header,空值不出现在 body 里(保持旧请求形状) |
| (b) `Idempotency-Key` 进 **header** | 派单已授权 | 做 |
| (c) `isShareAuthRequired` 判别式 | 与 `isShareUnavailable:39-44` / `isShareRateLimited:32-37` 同族,散到 index.vue 会造第三份口径 | 建议同文件 |

→ **建议裁决**:把派单那句读作「**新增的 header 只有 `Idempotency-Key`**」。这与 AC-SEC-09 / T-27.3「headers 断言无 `sec`/authKey/token 泄露」严格一致(authKey 走 body 正是被要求的),并连带批准 §9.2 的 `index.spec.js:164` 单行改写。
→ 若主 AI 判定 `request/share.js` 真的一个字节都不能加 body:唯一替代是在 `views/share/` 下另起一个 `shareHttp.post`,那会绕开 `:144-152` 的 429 拦截器,直接违反 AC-OTP-08,**不要选**。

### Fog-2 · 「响应丢失后同 key 重试」由谁触发,决定 T-27.2 能不能写

AC-SESS-10 与 T-27.2 都要求「注入响应丢失 → 同 key 重试拿同一 token、`used_sessions` 恒 1」。今天 `bootstrap:707-723` 的 catch **没有任何重试**,而重放的另一条天然路径(刷新页面)在这里走不通:fragment 在首次进入时就被 `replaceState` 清掉了(路由守卫侧 `captureShareSecret:81`,组件侧 `consumeShareSecret:98,:102`),刷新后无 `sec` 可发,直接落到 `:726` 的存 token 分支 → `unavailable`。所以**不写重试,T-27.2 就没有可驱动的入口**。

三个选项:

| 方案 | 代价 | 风险 |
|---|---|---|
| A(建议)· `postSession` 内对「无响应」原地重试 1 次 | §2.3 那 6 行 | 需要 `isLostResponse` 判得够严(非 429 + 无业务信封 + 无 `err.response`),否则会放大限流压力 |
| B · 死链态加一个「重试」按钮 | UI + 文案 + i18n 键 | 与「不可区分的 unavailable 态」(AC-VISIT-04,`index.spec.js:378`)打架:给死链配重试按钮是在暗示「可能还活着」 |
| C · 不做,只保证 key 稳定 | 0 | T-27.2 无法实现,`AC-SESS-10` 的前端半边只剩文档 |

→ **建议裁决 A**,并把「重试恰 2 次、两次同 key」写成 `index.spec.js` 断言。**不要**做指数退避、不要做 3 次以上——建会话不是轮询。

### Fog-3 · 存 token 复活路径拿不到 `config`,刷新后刷新策略与倒计时必然降级

`bootstrap:726-732` 的复活分支不调 `/share/session`(这正是 AC-SESS-03 要的:不消耗配额),因此刷新后 `autoRefresh` / `refreshIntervalMs` / `expiresAt` **全部无值**。exec-t25-note §5.2 已经记过同形问题(`mailboxes` 地址列降级成 `***`),并猜测「T-26 若给复活路径补一次 config 拉取,这条一并消失」。**但契约里没有只读 config 的端点**(`share-api.js` 五个路由:session/mails/mailboxes/status/mail/attachment),再调 `/share/session` 就是 +1 配额,直接违反 AC-SESS-03。

后果具体是:同 tab 刷新后,一个 `auto_refresh=false` 的分享**会开始自动轮询**,一个 `refreshIntervalMs=30000` 的分享**会退回 3000ms**,倒计时**不显示**。

→ **建议裁决:接受降级,不新增端点、不重调 session。** 理由:AC-SESS-03(不消耗配额)是安全/计费约束,AC-OTP-05(刷新策略)是体验约束,冲突时前者优先;且 `refreshIntervalMs` 服务端已钳 ≥3000,降级到 3000 是**下限而非放大**,不构成 DoS。倒计时不渲染优于渲染一个错的。
→ 若主 AI 判定这不可接受:正确解法是**给 status 响应捎带 config**(`share-api.js:86` 那个 `shareJson` 里多一个字段),那是 worker 改动 + 新 AC,**必须先扩派单**,不在 T-26 现有范围内。
→ 无论怎么裁,`index.spec.js` 都要有一条断言把当下行为钉住,免得它变成一个没人知道的隐式行为。

---

## 11. T-27 / T-29 / 其他任务不得从 T-26 偷走的东西

### T-26 独占,后续只能消费

1. **`share:est-key:<lid>` 键名、`SHARE_ESTABLISH_KEY_PREFIX` 常量、`ensureEstablishKey` / `clearEstablishKey` 的位置(`session.js`)与四时刻生命周期(§4.3)。** T-27 的 E2E 只许**读**这个键做断言,不许自己写/清;T-29 不许把它挪进别的模块。
2. **`postSession` 是 `POST /share/session` 的唯一出口**(§2.3)。任何后续任务要加建会话参数,扩这一个函数,不许第二个调用点。
3. **`state === 'authRequired'` 这个节点名**,与 `[data-share-auth]` / `[data-share-auth-input]` / `[data-share-auth-submit]` / `[data-share-auth-error]` 四个钩子。T-27.3 的 AuthKey E2E 直接选这四个,**钩子名冻结**。
4. **`[data-share-refresh]` / `[data-share-expires]` 两个钩子**,以及「手动刷新 = 调用同一个 `pollTick`」这条形态。
5. **`applyShareConfig` 仍然是 session 响应的唯一读取点**(T24-CONFIG 延续)。W6 若要再读一个字段,扩这个 helper。
6. **`useSharePolling.js` 的 `readInterval()` 形状**:composable 仍是通用轮询器,`listStatus` / `mode` / `autoStart` 三个参数永久禁止(§5.2)。

### T-26 不得抢的(留给下游)

- **T-27**:全部 `tests/e2e/**`。T-26 只写 vitest,**不碰** `tests/e2e/specs/` 与 `tests/e2e/harness/`(`control.js:104` 那个 `crypto.randomUUID()` 是 owner 侧 create 的键,与访客 est-key 无关,不许混用)。T-26 也**不许**为了「让 E2E 好写」在生产代码里加 `window.__share*` 之类的测试后门。
- **T-28**:全量回归与 `unverified` 标注。
- **T-29**:`i18n/zh.js` / `en.js` 的任何落盘(§8.2 的 8 个新键 + T-25 遗留 2 个,共 10 个,只记录);ADR / CHANGELOG / README / `shipped_commit` 回填;tech-debt 台账(Fog-3 的降级若被接受,应由 T-29 登记为已知限制)。
- **T-25 已落地物**:`status-watermark.js` 五条推进语义、`share:status:<lid>` 键(§7.3 **不清**)、`getShareMailboxesStatus` 签名、`pollTick` 的「status → 比较 → 拉 active binding」组合、`visibleMails` 过滤、`data-share-tab*` 三个钩子。T-26 只消费,不改语义。
- **T-24 已落地物**:`ShareOtpCard.vue` props 三件套、`featuredMail` 算法、`useCopyWithFallback`、四个 OTP 钩子、`mail-fields.js`。

### 三方共同禁区(与 recon-t25 §10 一致,原样继承)

`router/index.js` 的 share 路由/守卫/afterEach 清理、`init/init.js` 的 share 正则与提前 return、`/s/<lid>#<sec>` 路径形态、`session.js` 的 `share:session:` 前缀语义、`data-share-shell="cloud-mail-share-shell"`(`index.vue:4`)、`assert-share-chunk.js` 的 `FORBIDDEN` 四条、`SHARE_CAPABILITY_V2` 默认 false。
share chunk 的依赖禁令在 T-26 里同样不会被触发:新代码只依赖 `vue` + 同目录相对文件 + `@/request/share.js`,**零 `@/axios/index.js`、零 `element-plus`、零 Dexie、零 `websiteConfig`**。

### P1-4 HOLD 原样继承

外来 `bindingId` 仍是空页面,不是 `SHARE_UNAVAILABLE`。T-26 的 `authRequired` 分流(§2.4)发生在 `state !== 'ready'` 之前,与该 HOLD 无交集。

---

## 12. 主 AI 迷雾裁决(2026-08-24 · 实现前锁定,禁止重开)

| ID | 裁决 | 依据 |
|---|---|---|
| Fog-1 | **CHANGE**:「Idempotency-Key only」读作「新增的 **header** 只有 Idempotency-Key」。`createShareSession(lid, sec, { authKey, idempotencyKey } = {})`：空 `authKey` 不进 body(旧请求形状);`idempotencyKey` 走 header。`isShareAuthRequired` 与另两个判别式同文件。批准 `index.spec.js:164` 单行改写成 `objectContaining({ idempotencyKey })`。禁止在 `views/share/` 另起 axios。 |
| Fog-2 | **CHANGE A**:`postSession` 对「无响应」(非 429、非业务信封、无 `err.response`)原地重试 1 次,同 key。不写死链重试按钮(AC-VISIT-04)。指数退避仍归轮询。 |
| Fog-3 | **CHANGE**:接受存 token 复活路径的 config 降级(interval=`POLL_INTERVAL_MS`、`autoRefresh` 缺省 true、倒计时不渲染)。不新增 config 端点、不重调 `/share/session`(AC-SESS-03)。必须有断言钉住「复活路径零 `createShareSession`、不写 `share:est-key`、不渲染 `[data-share-expires]`」。T-29 把该降级登记为已知限制。 |
| T26-POLL | **CHANGE**:`useSharePolling` 用 `toValue` 读 `intervalMs`;**不加** `autoStart`/`listStatus`/`mode`。`clampInterval` 下限必须恰好 `POLL_INTERVAL_MS`。 |
| T26-KEYGEN | **CHANGE**:`ensureEstablishKey` 落 `session.js`,`crypto.getRandomValues` 16 字节 hex;不 import `mail-share.js`;不抄 `Math.random` 回退;不用 `randomUUID`。 |
| T26-STATUS | **HOLD**:三个清理点都不碰 `share:status:<lid>`。不扩 `clearOtherShareSessions` 去扫 est-key。 |

## Update Log

- 2026-08-24 · 主 AI:Fog-1/2/3 + T26-POLL/KEYGEN CHANGE,T26-STATUS HOLD。派 T-26 实现。
