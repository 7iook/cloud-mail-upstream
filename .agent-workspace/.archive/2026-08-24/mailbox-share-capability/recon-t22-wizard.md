# Recon · T-22 创建向导:四预设 + 幂等恢复 + V2 降级(W4 第三棒)

| 字段 | 值 |
|---|---|
| 范围 Scope | T-22 / T-22.1,`docs/specs/mailbox-share-capability/tasks.md:488-490` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`,HEAD `ee50647`(T-20 代码在 `672da73`) |
| 侦察日期 | 2026-08-24 11:30 UTC |
| 依据 AC | AC-CAP-12(预设仅前端)、AC-CAP-14(响应丢失恢复)、AC-LIFE-11(V2 全能力栅栏);旁及 AC-CAP-01/05/06/09/10/13、AC-ADMIN-08、AC-EDGE-14 |
| **T-21 实时状态** | **未落盘**。`views/share-admin/` 下只有 `index.vue` / `status.js` / `index.spec.js` 三个文件,无 `ShareDetailDrawer.vue` / `ShareRowActions.vue`。T-22 起跑时列表页仍是 T-20 的只读形态 |
| 基线 | **已实测** `pnpm --dir mail-vue test` → **18 文件 / 113 用例 / EXIT=0**(2026-08-24 11:28) |
| 快照校验 | `index.vue` `3fad53e1…`(**与 recon-t21 记的 `af823d25…` 不同,T-20 提交前被改过**)· `status.js` `576036cb…` · `index.spec.js` `7751a505…` · `request/mail-share.js` `4621ee26…` · `ShareDialog.vue` `a60da935…` · `build-share-url.js` `c294167b…`。执行前 `md5sum` 比对,不一致就重读 |
| 性质 | 只读侦察。未改任何生产/测试/spec 文件、未提交;本文件是唯一产物 |
| 已读技能 | frontend-design · impeccable · ui-ux-pro-max · ponytail(lite:结论内化进 §7/§8,并在每处逐条点名更懒的替代) |

---

## 0. 一句话结论 · 五个会静默做错的点

**① 任务书的前提「T-20 已加端点」对 create 不成立。** `request/mail-share.js:19-31` 的 `createMailShare` **写死了四个字段**(`accountId` / `durationSeconds` / `name` / `remark`),`accountIds` 与全部 8 个新配置字段**一个都传不出去**。更硬的是 `request/mail-share.spec.js:51-56` 用 `toEqual` 把这四个键钉成了**恰好集合**。所以 T-22 要么改这个函数(条件展开,不传的键不出现,既有断言仍绿),要么新加一个函数。**这是 T-22 的第一块砖,不是可选项**(迷雾 F2)。

**② 前端对 `SHARE_CAPABILITY_V2` 零可见性 —— 全仓检索确认,不是我没找到。** 见 §4:这个变量只活在 Worker 的 `c.env`,`websiteConfig` / `settingQuery` / 任何 `/mailShare/*` 响应都不带它,`mail-vue/src/**` 零命中。「V2=false 置灰」在**不改 mail-worker** 的前提下只能靠**先撞后降级**。这是迷雾 F1。

**③ V2 栅栏是四条,不是任务书写的三条。** `assertCreateBody:355-366` 逐条门控 `accountIds.length>1` / `authKeyEnabled` / `maxSessions != null` / **`messageLimit != null`**。任务书的「多邮箱/AuthKey/配额」把 `messageLimit` 漏了 —— 向导只灰三组,用户在 V2=false 下填个「最多看 20 封」就吃 `SHARE_INVALID_CONFIG`,而且此时界面还告诉他这三项才是被禁的。

**④ 「结果未知不换 key」与 ShareDialog 的换 key 反射直接冲突。** `ShareDialog.vue:217-219` 是 `watch(表单) → rotateIdempotencyKey()`。向导照抄这条,用户在超时后随手改一个字,同 key 重试就永远做不到了(AC-CAP-14 的 SHALL NOT 被静默违反)。反过来若干脆不换 key,用户改完表单重提 → 指纹变 → `replayOrConflict:585-587` 抛 `SHARE_IDEMPOTENCY_CONFLICT`。**唯一自洽解:结果未知时锁表单**(§5.3)。

**⑤ index.vue / index.spec.js / status.js 三文件与 T-21 相撞,而 T-21 还没落盘。** recon-t21 §4.4 已经登记过这条,现在它成了现实:两棒都要往 `index.vue` 的 `header-actions` 里插按钮、都要动 `index.spec.js` 的 stubs 表。迷雾 F3。

---

## 1. 问题直答(用户点名的六问)

| # | 问题 | 结论 | 详见 |
|---|---|---|---|
| 1 | 可执行文件清单 | 3 新 + 3 锚点补丁(`index.vue` ≤6 行 / `mail-share.js` 1 函数 / `mail-share.spec.js` +1 条) | §2 |
| 2 | 请求体形状 vs 后端 CREATE/UPDATE | create 归一化 **12 字段**,与 update 白名单**只交 8 个**;create 独有 4、update 独有 1;两边的三态语义**相反**,别互抄 | §3 |
| 3 | 前端怎么探 V2 | **探不到。零通道。**只能「撞了再降级」,且降级前必须先做完本地值域校验,否则会把值域错误误报成「能力未激活」 | §4 |
| 4 | Idempotency-Key 复用路径 | `newIdempotencyKey()` → `createMailShare(body, key)` → header → `replayOrConflict`;四出口状态机 + 「结果未知锁表单」 | §5 |
| 5 | 一次性密钥模式抄哪 | ShareDialog 的**四段**(模板 `:25-39` / 派生 `:109-126` / 关闭即清 `:152-159` / 唯一赋值点 `:161-189` / 复制 `:210-215`);T-22 要同时承载 `shareUrl` 与 `authKey` 两个一次性值 | §6 |
| 6 | 迷雾 | 恰 3 条:V2 探测策略 / 能否改 `createMailShare` / T-21 排期 | §11 |

---

## 2. 文件清单

### 2.1 允许写(3 新 + 3 补丁)

| 文件 | 动作 | 规模 |
|---|---|---|
| `mail-vue/src/views/share-admin/ShareCreateWizard.vue` | **新建**(主体:预设选择 + 表单 + 结果区) | T-22 的主体 |
| `mail-vue/src/views/share-admin/presets.js` | **新建**(四预设纯数据 + 一个 `applyPreset`) | ~40 行 |
| `mail-vue/src/views/share-admin/ShareCreateWizard.spec.js` | 新建 | §9 |
| `mail-vue/src/views/share-admin/index.vue` | **锚点补丁 ≤6 行**(§2.3) | 硬预算 |
| `mail-vue/src/request/mail-share.js` | **只改 `createMailShare` 一个函数**(§3.3) | ~12 行 |
| `mail-vue/src/request/mail-share.spec.js` | **只追加 1 条**(新字段透传),既有 6 条一字不改 | +1 |

`presets.js` 单拆的理由不是组件化,是**让 AC-CAP-12 可断言**:spec 要证明「预设只影响表单,不进请求体」,最干净的写法是把预设键集合与实际请求体键集合做差集断言。写在 `<script setup>` 里就导不出来。
> ponytail(lite)更懒的替代:不建 `presets.js`,四预设当组件内 `const`,spec 只通过点 UI + 断言请求体白名单来覆盖。少一个文件、少一次 import,代价是断言从「差集」退化为「白名单等值」。**我按可断言性选前者,用户可以要求换。**

### 2.2 明确不碰

| 文件 | 理由 |
|---|---|
| `mail-vue/src/i18n/zh.js` · `en.js` | T-28/T-29 单写者(`tasks.md:27`)。T-22 只在 §10 登记键表 |
| `mail-vue/src/router/index.js` | T-20 已实现 0 行改动;访客白名单/守卫属 W5 |
| `mail-vue/src/axios/index.js` | 全局拦截器是前提不是改造对象(含「不加 `noMsg`」的裁决,§3.5) |
| `mail-vue/src/views/email/ShareDialog.vue` · `ShareIndicator.vue` · `build-share-url.js` | T-23。`build-share-url.js` 只 **import 复用**,不改一个字 |
| `mail-vue/src/views/share-admin/status.js` | 本任务用不上(向导不渲染 effectiveStatus)。**recon-t21 打算往这里加 `isMutableStatus` —— T-22 不要抢这个写点** |
| `mail-vue/src/views/share-admin/index.spec.js` | §2.3 的锚点不打红任何既有断言(`:243-252` 的零 button 闸门是**行内**作用域,header 按钮不受影响);**若确实需要改,先回主 AI** |
| `mail-vue/src/perm/perm.js` | T-20 刚落 `share:manage` 路由,向导是页内对话框不需要新路由 |
| `mail-vue/src/views/share/**` · `request/share.js` · `composables/useSharePolling.js` | 访客域 W5。从向导 import 会以「构建失败」形态打红 `share-chunk.spec.js` |
| `mail-vue/src/layout/**` | T-20 已加入口 |
| `mail-worker/**` | 后端契约 W3 已封口。**含「不加能力探测端点」——那是迷雾 F1 的越界选项** |
| `tests/e2e/**` | W6 |

### 2.3 index.vue 锚点补丁(恰三处,≤6 行)

```diff
       <button class="icon-button" type="button" :aria-label="tf('shareRefresh')" …>
         <Icon icon="ion:reload" width="18" height="18"/>
       </button>
+      <ShareCreateWizard @created="refresh"/>        <!-- 3) 自带触发按钮,不在 index.vue 管开关 -->
     </div>
```
```diff
   import {isShareForbidden, listMailShares} from "@/request/mail-share.js"
+  import ShareCreateWizard from './ShareCreateWizard.vue'      <!-- 1) -->
```

三条硬约束:
1. **触发按钮与 dialog 都封在 `ShareCreateWizard.vue` 内部**,`index.vue` 不持 `createVisible` ref。这样 T-21 往同一段 `header-actions` 加东西时,两边的 diff 不重叠。
2. **`refresh` 用现名直绑**(`index.vue:196-198`),不新增包装。`fetchList` 的 `reqSeq` 竞态保护(`:144`)自动覆盖向导触发的刷新。
3. **不改 `.share-card` 的任何 DOM 与 `data-test`**;`index.spec.js:243-252` 断言的是 `row.findAll('button')`,**行内**作用域 —— header 里加按钮**不会**打红它。这是 T-22 与 T-21 的关键差别:T-21 必须翻面那条用例,T-22 不必。

---

## 3. 请求体形状 vs 后端字段(只读核实)

### 3.1 CREATE 归一化的 12 个字段(`normalizeCreateBody:195-212` + `assertCreateBody:334-367`)

| 键 | 归一化 | 默认 | 拒绝条件(错误码) | V2 栅栏 |
|---|---|---|---|---|
| `accountIds`(或旧 `accountId` 单值) | `toIdSet:172` 去重 + **升序** | — | 空集/含非 `>0` 安全整数 → `SHARE_ACCOUNT_FORBIDDEN`;`>50` → `SHARE_BINDING_LIMIT_EXCEEDED`;非本人/已删 → `SHARE_ACCOUNT_FORBIDDEN` | `length > 1` ★ |
| `durationSeconds` | `Number()` | — | `<=0` / 非有限 / `> SHARE_MAX_DURATION_SECONDS` → `SHARE_DURATION_EXCEEDED` | — |
| `name` / `remark` | `null → ''`,`String()` | `''` | 无长度校验(前端自己 `maxlength`) | — |
| `maxSessions` | `toNullableCount:158`(`null`/`''` → null) | `null` | 非安全整数 → `SHARE_INVALID_CONFIG`;`<1` → `SHARE_INVALID_CONFIG` | `!= null` ★ |
| `messageLimit` | 同上 | `null` | 同上 | `!= null` ★ **任务书漏列** |
| `onlyMessagesAfterCreated` | `toFlag:146` 严格枚举 | `1` | 枚举外(`2`/`'yes'`/`{}`)→ `SHARE_INVALID_CONFIG` | — |
| `otpExtractionEnabled` | `toFlag` | `1` | 同上 | — |
| `autoRefresh` | `toFlag` | `1` | 同上 | — |
| `refreshIntervalMs` | `Number()`,缺省 3000 | `3000` | **`<3000` 直接拒**(`:346`),**不钳**;非安全整数同拒 → `SHARE_INVALID_CONFIG` | — |
| `showFullAddress` | `toFlag` | `0` | 枚举外 → `SHARE_INVALID_CONFIG` | — |
| `authKeyEnabled` | `toFlag` | `0` | 枚举外 → `SHARE_INVALID_CONFIG` | truthy ★ |

`toFlag` 的**空值回落**:`null` 与 `''` 都当「没传」回落默认值(`:147-149`),这与 update 的 `toPatchFlag`(无回落)相反。所以 create 侧**整表单回传是安全的**——缺键、`null`、`''` 三者同义。

**顺序即语义**(`:332-333` 原注):域校验 → 上限 → 栅栏。51 个 accountId 在 V2=false 下仍返回 `SHARE_BINDING_LIMIT_EXCEEDED`(永久领域错误优先于暂时的发布态)。前端做 V2 降级判据时必须尊重这个顺序,见 §4.3。

### 3.2 CREATE vs UPDATE 的字段差集(**T-22 与 T-21 最容易互抄错的地方**)

| | 字段 |
|---|---|
| **仅 create** | `accountIds` · `durationSeconds` · `onlyMessagesAfterCreated`(**创建是唯一设置机会**,刻意不在 `UPDATE_FIELDS:935-944`)· `authKeyEnabled`(创建后只能走 `resetAuthKey`) |
| **仅 update** | `resetUsedSessions`(AC-EDGE-14) |
| **共有 8** | `name` `remark` `maxSessions` `messageLimit` `otpExtractionEnabled` `autoRefresh` `refreshIntervalMs` `showFullAddress` |
| **两边都没有** | `expiresAt` / `lid` / `sec` / `shareType`(派生,`shareTypeOf:474`) |

**语义相反,禁止互抄**:
- create:**缺键 = 用默认值**,整表回传安全,`toFlag` 有空值回落。
- update:**缺键 = 不改**(`hasOwnProperty` 判据 `:946-955`),整表回传会无谓触栅栏(recon-t21 §0 ②),`toPatchFlag` 无回落。

### 3.3 前端 request 层现状与最小改法

现状(`request/mail-share.js:19-31`):
```js
export function createMailShare(body, idempotencyKey) {
    const key = idempotencyKey || newIdempotencyKey()
    return http.post('/mailShare/create', {
        accountId: Number(body && body.accountId),
        durationSeconds: Number(body && body.durationSeconds),
        name: body && body.name == null ? '' : String(body.name),
        remark: body && body.remark == null ? '' : String(body.remark)
    }, { headers: { 'Idempotency-Key': key } })
}
```
新配置字段与 `accountIds` **无路可走**。而 `mail-share.spec.js:51-56`:
```js
expect(body).toEqual({ accountId: 11, durationSeconds: 3600, name: 'desk', remark: 'otp' })
```
`toEqual` 是恰好集合 —— 任何**无条件**新增键都会打红它。

**建议改法(条件展开,既有断言天然绿)**:四个旧键保持无条件;`accountIds` 与 8 个新键**只在调用方显式给了才出现**。ShareDialog 只传旧四键 → 请求体逐字不变 → `ShareDialog.spec.js` 与 `mail-share.spec.js` 全绿。

三条硬要求:
- **不要在 request 层做值域归一化**(不要把 `refreshIntervalMs` 钳到 3000、不要把 `false` 转 `0`)。后端 `normalizeCreateBody` 是唯一真源,前端抄第二份必然漂移 —— 这是 T-20 已定的透传裁决(recon-t20 §3.1,T-21 继承)。四个旧键的 `Number()`/`String()` 是既有行为,保留但不扩散。
- **`accountIds` 与 `accountId` 不要同时发**。后端 `toAccountIdSet:188` 是 `accountIds` 优先、缺失才回落 —— 同时发不会报错,但会让请求体多一个死字段,也让指纹与 ShareDialog 的形状分叉。
- **`newIdempotencyKey()` 的降级分支已经写好**(`:3-17`,`crypto.randomUUID` → `getRandomValues` → `Math.random`),向导直接用,不要自己拼 UUID。

### 3.4 CREATE 的两种响应形状(`firstCreateResponse:528-543` / `replayFromIdempotency:553-578`)

| | 首次成功 | 幂等重放 |
|---|---|---|
| `shareId` `lid` `expiresAt` `shareType` `bindings[]` | ✅ | ✅ |
| `sec` | ✅ 明文,**恰此一次** | ❌ **键不存在** |
| `shareUrl` | ✅ `${origin}/s/${lid}#${sec}` | ❌ **键不存在** |
| `authKey` | 仅 `authKeyEnabled=true` 时挂键 | ❌ |
| `idempotentReplay` | ❌ 无此键 | ✅ `true` |

两种响应都**不回显** `name` / `maxSessions` / 任何配置,也**没有** `mailbox`。所以创建成功后想展示详情只能刷列表或 `getMailShare` —— 向导不做这件事,`@created` 让列表页自己 `refresh()`。

`shareUrl` 的 origin 取 `SHARE_PUBLIC_ORIGIN` 或请求 URL 的 origin(`publicOrigin:104-117`),**服务端拼好的优先**;`build-share-url.js` 只是 origin 缺失时的前端回落(与 ShareDialog `:114-120` 同款)。`bindings[]` 只有 `{bindingId, accountId}`,**无 mailbox**(`loadBindings:478-484`)—— 结果区不要试图显示邮箱地址。

### 3.5 错误如何到达向导

`BizError` → `shareResult.fail(message, code = 500)`(`share-result.js:5`)→ HTTP **200** + body `{code:500, message:'SHARE_INVALID_CONFIG'}` → `axios/index.js:59-68` 弹一个**裸错误码红 toast** 并 `reject(data)`。

**裁决:不加 `noMsg`。** 理由:(a) 加 `noMsg` 要改 request 层的 config,而那是 ShareDialog 共用的函数;(b) 裸码 toast 是全仓既有行为,T-21 已裁决不做码 → 中文映射表,T-22 不该在一个对话框里单独立规矩;(c) i18n 是 T-29 单写者热区。向导只在栅栏码上**追加内联说明**(「能力未激活」),不试图消掉那个 toast。
> 更懒的替代:什么都不做,连内联说明也不加。但那样 AC-LIFE-11 的「以能力未激活提示降级」就落空了,不取。

---

## 4. 前端怎么探 `SHARE_CAPABILITY_V2` —— 检索结论:**没有通道**

### 4.1 检索过程与证据

| 检索 | 结果 |
|---|---|
| `rg SHARE_CAPABILITY_V2 mail-vue/` | **0 命中** |
| 全仓 `SHARE_CAPABILITY_V2` | 只在 `mail-worker/src/service/mail-share-service.js`、`wrangler.toml` / `wrangler-vitest.toml`、worker 测试、`.agent-workspace/*.txt` |
| `isCapabilityV2Enabled(c)`(`:67-73`) | 读 `c.env`,**不进任何响应体** |
| `firstCreateResponse` / `projectOwnerRow:424-456` / `loadOwnerDetail:514-526` | 无任何能力位字段 |
| `settingService.websiteConfig:200-225` | 全部字段来自 **DB `setting` 表**,不含任何 `c.env` 变量 |
| `mail-share-api.js` 全部 8 条路由 | 无 `/mailShare/capabilities` 之类只读探测端点 |
| `mail-vue` 的 `import.meta.env` 用法 | 仅 3 处(`VITE_BASE_URL` ×2、`BASE_URL`/`MODE`)。`.env.dev/.env.release/.env.remote` 里**无分享相关变量** |

**结论:在不改 mail-worker 的约束下,前端在提交之前无法知道 V2 状态。** 这是设计事实,不是遗漏 —— design.md 把栅栏定义成部署侧开关,requirements 里也只要求「前端以能力未激活降级」,没要求「前端预先知道」。

### 4.2 推荐机制:先撞后降级(tri-state,页内记忆)

```
capabilityV2: 'unknown'(初始) → 'inactive'(被栅栏拒过一次)
```
- **`unknown`**:四组受栅栏控件**保持可用**,但每组带一条静态 hint(「该能力需平台已激活,未激活时提交会被拒」)。
  **绝不能在 unknown 时预先置灰** —— 那会在 V2=true 的正常部署里把多邮箱能力藏起来,是比误提交更严重的假降级。
- **`inactive`**:四组控件 `disabled` + `data-test="capability-inactive"` + 「能力未激活」文案;同时把它们**复位到非受限默认值**(`accountIds` 截到 1、`authKeyEnabled=false`、`maxSessions=null`、`messageLimit=null`),让用户能立刻重提。
- **记忆范围**:模块级 `ref`(`presets.js` 或向导模块顶层),**活到页面刷新为止**。不写 localStorage / sessionStorage —— 环境变量会随部署翻转,持久化会把「今天灰了」变成「永远灰着」。

### 4.3 降级判据必须收紧(否则会误报)

`SHARE_INVALID_CONFIG` 是**多义码**:值域非法(`refreshIntervalMs<3000` / `maxSessions<1` / `messageLimit<1` / flag 枚举外)与 V2 栅栏**共用同一个码**,前端不可区分。

所以只有同时满足三条,才允许把 `capabilityV2` 置 `inactive`:
1. 本次请求体**确实包含 ≥1 条受栅栏意图**(`accountIds.length>1` ‖ `authKeyEnabled` ‖ `maxSessions!=null` ‖ `messageLimit!=null`);
2. 提交前**本地值域校验已全部通过**(§9 用例 W12 —— 这条用例不是锦上添花,它是降级判据正确性的**前提**);
3. 错误是业务码 `SHARE_INVALID_CONFIG`(不是 `SHARE_DURATION_EXCEEDED` / `SHARE_ACCOUNT_FORBIDDEN` / `SHARE_BINDING_LIMIT_EXCEEDED` —— 后三者与栅栏无关,且 `assertCreateBody` 的顺序保证上限错误优先于栅栏)。

**还是有一个不可消除的误报窗口**:请求体同时含受栅栏意图 + 一个前端没拦住的值域错误(比如 `refreshIntervalMs` 被 `el-input-number` 清空成 `null` → `Number(null)=0`)。缓解:本地校验覆盖全部五个值域点,并且在 disabled 提示旁保留一个「重新检测(取消置灰)」的小入口,让用户能一键回 `unknown`。

### 4.4 一条可用但只能单向的旁证

列表行与详情**共用** `projectOwnerRow`(`:421` 原注),行里已经带 `shareType` / `maxSessions` / `messageLimit` / `authKeyEnabled`。所以:

> 列表里存在任一行满足 `shareType==='multi' || authKeyEnabled || maxSessions!=null || messageLimit!=null` ⇒ **V2 曾经开过**。

这是**正向单边证据**:命中可以直接把 `capabilityV2` 判为 active(跳过第一次撞墙);未命中**什么都不能推**(全新部署、V2 开着但没人用过)。可以拿来做「乐观不灰」,**不能**拿来做「置灰」。
> ponytail(lite)更懒的替代:连这条都不做,只留 §4.2 的撞后降级。少一次列表依赖、少一条用例。**我倾向做**,因为它零成本地消掉了「V2 已开的老用户第一次仍要撞一次墙」的体验,而且数据已经在手上。

---

## 5. Idempotency-Key 复用路径

### 5.1 链路(逐跳核实)

```
newIdempotencyKey()                       mail-vue/src/request/mail-share.js:3-17
  ↓ createMailShare(body, key)            :19-31  → headers['Idempotency-Key']
  ↓ HTTP POST /mailShare/create
mail-share-api.js:25                      c.req.header('Idempotency-Key') || ''
  ↓ { ...body, idempotencyKey }
mail-share-service.create:1127-1137       非空才进幂等分支
  ↓ createFingerprints(body):251-259      兼容载荷存旧 hash,accepted 同收新旧两个
  ↓ replayOrConflict:580-589
      ├─ 无行 / created_at < cutoff(IDEMPOTENCY_TTL_HOURS 之前) → null,**真的再建一个**
      ├─ 有行 + 指纹 ∈ accepted            → replayFromIdempotency(无明文)
      └─ 有行 + 指纹 ∉ accepted            → SHARE_IDEMPOTENCY_CONFLICT
```

### 5.2 四个出口的前端动作

| 出口 | 判据 | 换 key? | UI |
|---|---|---|---|
| **首次成功** | `data && !data.idempotentReplay` | ✅ 换 | 一次性展示 `shareUrl`(+`authKey`),`emit('created')` |
| **幂等重放** | `data.idempotentReplay === true` | ❌ **不换** | replay 态:显示 `shareId`/`lid`,明说「明文不会再发放」,引导 **revoke/delete 后重建**;重建按钮才换 key |
| **结果未知** | 传输层失败(见 §5.3 判据) | ❌ **不换** | **锁表单** + 「用同一把钥匙重试」按钮 |
| **业务拒绝** | 明确的业务码 | 保持;**用户改表单时才换** | 回表单,保留输入 |

### 5.3 「结果未知」怎么判(axios 两种 reject 形状)

`axios/index.js` 有两条 reject 路径,形状不同:
- **业务码**:`reject(data)`(`:26/38/47/58/67`)→ `{code: <number>, message: <string>}`,**服务端明确处理过,没建成**。
- **传输失败**:`reject(error)`(`:82/116`)→ AxiosError,`code` 是**字符串**(`'ECONNABORTED'` / `'ERR_NETWORK'`)或 `undefined`,带 `isAxiosError`。**结果未知**。

可用判据(与 `isShareForbidden:86-91` 同一风格,写在向导里即可,不必进 request 层):
```
业务码 = Number.isInteger(err?.code) && typeof err?.message === 'string'
结果未知 = 其余一切(含 err == null)
```
两个坑:
- `axios/index.js:74-77` 对**传输层** 403 直接 `location.reload()` 并 `return`(不 reject)—— 这条路径下向导整个被卸载,谈不上重试。别为它写用例。
- `error.response`(5xx 有响应体但不是我们的信封)也走 `reject(error)` → 判为结果未知 → 同 key 重试。这是**正确**的保守选择:5xx 之下 D1 batch 可能已提交。

### 5.4 换 key 的时机(与 ShareDialog 的关键差异)

ShareDialog `:217-219` 是 `watch([name, remark, durationSeconds, accountId]) → rotate`。向导**必须**保留这条(否则改完表单重提 → 指纹变 → `SHARE_IDEMPOTENCY_CONFLICT`),但要加一道闸:

```
watch(整个表单) → if (state !== 'unknown-result') rotateIdempotencyKey()
```
配合「结果未知时表单全部 `disabled`」,两条约束就自洽了:**能改表单的时候一定不是未知态,处于未知态的时候一定改不了表单。**

**不持久化 key。** 刷新页面即丢,此时引导用户「先去列表看看是否已经建好」。理由:owner 侧没有对应 AC(`share:est-key:<lid>` 的 sessionStorage 是 Visitor 侧 AC-SESS-10 的要求,别张冠李戴);持久化一把一次性 key 还要处理 TTL 与跨标签页,是纯负债。
> 更懒的替代:也不做「去列表看看」的引导文案,直接靠列表本身。取中间:一句静态提示,零逻辑。

---

## 6. 一次性密钥:从 ShareDialog 抄什么

四段构成(HEAD `ee50647` 实测行号,`ShareDialog.vue` md5 `a60da935…`):

| 段 | 行 | 作用 |
|---|---|---|
| 模板展示块 | `:25-39` | `v-if="created"` 包裹;`data-test="secret-once"` 一次性告警;`data-test="share-replay"` 重放提示;只读 `<input data-test="share-url" :value>`(**不是 `{{ }}` 文本**,便于手选降级)+ 复制按钮 |
| 派生值 | `:109-126` | `createdShareUrl` **只从 `created.value` 派生**,`data.shareUrl` 优先、否则 `buildShareUrl(window.location.origin, lid, sec)`;`replayWithoutSecret = idempotentReplay && !sec && !shareUrl` |
| 关闭即清 | `:152-159` | `onOpenChange(false) → created.value = null` |
| 唯一赋值点 | `:161-189` | 只有 create 响应能写 `created.value`;写完 `await loadList()` —— **列表刷新不会覆盖明文,因为明文根本不在列表状态里** |
| 复制 | `:210-215` | `useCopyWithFallback().copy()`,`result.copied === true` 才弹成功 toast;`selectableRef` 绑那个只读 input,剪贴板不可用时降级为「已选中,请手动复制」(`useCopyWithFallback.js:140-163`) |

守护它的断言:`ShareDialog.spec.js:144-162` —— 创建后既断言 URL 含明文,**又断言列表行文本不含明文**。

**T-22 的差异:两个一次性值。**
```
created = ref(null)                 // 唯一写入点:createMailShare 的成功响应
createdShareUrl = computed(...)     // 照抄 ShareDialog:109-121
createdAuthKey  = computed(() => created.value?.authKey || '')   // 仅 authKeyEnabled 时存在
关闭对话框 / 点「我已保存」 / 开始下一次创建 → created.value = null
```
- **两个值各自一个只读 input + 各自一个复制按钮**,各自绑一个 `selectableRef`。`useCopyWithFallback()` 调用**两次**(它是 composable,每次返回独立的 `selectableRef`),不要用一个 ref 绑两个 input。
- **不写 sessionStorage / pinia / URL**。持久化一次性明文 = 直接作废 AC-CAP-05。
- **不做「创建完自动打开详情抽屉」**(T-21 的抽屉里没有明文,跳过去等于把明文冲掉)。

---

## 7. 四预设的具体预填值(AC-CAP-12)

**硬约束:预设是纯前端表单预填,请求体里不得出现任何预设标识。** 后端 `normalizeCreateBody` 的 12 键就是白名单,多一个 `preset`/`presetId` 键不会报错(会被忽略),但会**混进幂等指纹**吗?——不会,指纹算的是归一化后的 body(`requestFingerprint(body):219-221`,`body` 是 `normalizeCreateBody` 的输出)。所以多余键只是脏,不是 bug。**但 AC-CAP-12 明确禁止**,spec 必须钉。

| | 单邮箱验证码 | 临时邮箱 | 多邮箱验证码池 | 自定义 |
|---|---|---|---|---|
| `accountIds` | 1 个(默认取 `useAccountStore().currentAccountId`) | 1 个 | **N 个**(选择器) | 用户自选 |
| `durationSeconds` | 3600 | 86400 | 21600 | 3600 |
| `onlyMessagesAfterCreated` | true | true | true | true |
| `otpExtractionEnabled` | true | true | true | true |
| `showFullAddress` | **false** | **true** | false | false |
| `autoRefresh` | true | true | true | true |
| `refreshIntervalMs` | 3000 | 3000 | 3000 | 3000 |
| `maxSessions` | null | null | null | null |
| `messageLimit` | null | null | null | null |
| `authKeyEnabled` | false | false | false | false |
| 高级项默认折叠 | ✅ | ✅ | ✅ | ❌ 展开 |
| 受 V2 栅栏 | 否 | 否 | **是**(multi) | 视用户填写 |

三条设计依据:
- **「临时邮箱」是唯一开 `showFullAddress` 的预设**:这个场景里访客要拿这个地址去别处注册,看不到完整地址功能就残了。掩码是展示偏好不是安全边界(Decision 14,`design.md:103`/`:409`),所以这里开它不违反任何安全约束 —— 但**文案不得**写成「关闭掩码有风险」之类,禁用词表照 recon-t21 §7。
- **只有「多邮箱验证码池」默认踩栅栏**。另外三个预设在 V2=false 下**全部可用**,这正是 AC-LIFE-11 要的「行为等同旧单邮箱语义」。
- **「单邮箱验证码」预设的归一化 body 与 `legacyCompatibleBody:228-246` 完全吻合**(单 accountId + 全部新字段停在 DDL 默认)→ 落**旧指纹**,滚动发布窗口里新旧 Worker 能互相重放。这是白捡的兼容性,不要为了「显式更清楚」而去改任何一个默认值(比如把 `refreshIntervalMs` 写成 5000 就会把它踢出兼容集)。

**显式传默认值是否安全?** 安全。指纹算的是归一化后的 body,`otpExtractionEnabled: true` 与不传都归一化成 `1`,同一个指纹。所以向导可以放心整表回传。

---

## 8. 向导设计(impeccable 判定:Operate 模式)

### 8.1 基调:继承 T-20,不另起炉灶

登录态管理台的创建入口。impeccable 的 **Operate** 定义直接适用:可扫读性 / 一致性 / 原生预期 > 表达欲。frontend-design 那套「大胆美学方向 / 特色字体 / 渐变网格」在这里是反指标 —— 向导必须看起来是 share-admin 列表页的同一个产品。

四条继承自 T-20 的硬约束(逐条已在 `index.vue` 落地,照抄即可):
1. **颜色只走 CSS 变量**(`--el-bg-color` / `--el-border-color` / `--light-border` / `--secondary-text-color` / `--regular-text-color` / `--extra-light-fill`),零裸 hex。**注意 `ShareDialog.vue:228-290` 里有一批裸 hex(`#b88230` / `#fdf6ec` / `#dcdfe6` …)—— 那是历史包袱,抄它的 JS 模式,不要抄它的样式。**
2. `<style lang="scss" scoped>`(不是 less)。
3. 数值列 `font-variant-numeric: tabular-nums`(`index.vue:317-319`)。
4. `@media (max-width: 767px)`,全仓同值。

### 8.2 容器:`el-dialog`,不是 drawer,不是新路由

- 仓内既有创建/编辑面板全是 `el-dialog`;T-21 才引入第一个 `el-drawer`。**列表页同时冒出一个 drawer(详情)和一个 dialog(创建)是对的** —— 两种容器承载两种语义(编辑既有 vs 新建),不是不一致。
- 宽度 `680px`(与 `ShareDialog.vue:5` 同款),移动端由 element-plus 自身的 `max-width` 兜。
- `unplugin-vue-components` + `ElementPlusResolver`(`vite.config.js:44-46`,vitest 复用同一份 plugins)自动解析 `el-*`,**无需注册、无需新依赖**。
- **不做真正的多步 stepper,不引 `el-steps`。** 「向导」在 tasks.md 里的定义就是「四预设 + 幂等恢复 + V2 降级」,没有分步要求。三态单页(预设选择 → 表单 → 结果)已经完全覆盖,加 stepper 只是多两个「下一步」点击。
  > ponytail(lite)更懒的替代:连预设卡片都不做,预设当 `el-radio-group`。我选卡片,因为四预设要各带一句「适合什么场景」的说明,radio 塞不下 —— 但如果用户嫌重,radio + 一行 hint 是等价可接受的。

### 8.3 信息架构

```
ShareCreateWizard(自带触发按钮 + el-dialog)
├─ ① 预设选择(四张卡片,含一句场景说明;选中态用边框+底色,不只靠颜色)
├─ ② 表单
│    ├─ 基础:邮箱选择(单选/多选随预设)· 名称 · 备注 · 有效期
│    ├─ 高级(el-collapse,默认折叠;「自定义」预设默认展开)
│    │    ├─ otpExtractionEnabled / autoRefresh / refreshIntervalMs(min 3000)
│    │    ├─ onlyMessagesAfterCreated(★创建后不可改,标注出来)
│    │    ├─ showFullAddress(文案照 recon-t21 §7,禁用词表)
│    │    └─ ★受栅栏四组:多邮箱 / authKeyEnabled / maxSessions / messageLimit
│    └─ 提交(单个主按钮,:loading + :disabled)
├─ ③ 结果区(三选一互斥)
│    ├─ success:shareUrl 一次性 + authKey 一次性(若有)+ 复制 + 「我已保存」
│    ├─ replay:shareId/lid + 「明文不再发放」+ revoke/delete 引导 + 重建按钮
│    └─ unknown:表单锁定 + 「用同一把钥匙重试」
```

**每屏一个主 CTA**(`primary-action`);「取消」次级;重放态里的「撤销并重建」用 `type="danger"` 且与主按钮**视觉分离**(`destructive-emphasis`)。

### 8.4 无障碍与交互底线(ui-ux-pro-max §1/§2/§8)

- 预设卡片是**可聚焦的原生 `<button>` 或带 `role="radio"` 的元素**,不是 `<div @click>`;选中态同时用边框 + 图标,不只靠颜色(`color-not-only`)。
- 每个输入有**可见 label**(`input-labels`),复杂项配 hint(`input-helper-text`);错误显示在**对应字段下方**(`error-placement`)。
- 提交按钮 `:loading` + `:disabled` 防重复提交(`loading-buttons`)—— 这条在幂等场景里格外重要:双击提交会打出两个同 key 请求,第二个撞上重放,用户看到的是「怎么没给我明文」。
- 「能力未激活」置灰用 `disabled` 语义属性 + 降低不透明度 + 同处一条**说明文字**(`disabled-states`;禁止只灰不说)。
- 一次性明文区带 `aria-live="polite"`,让读屏用户知道值出现了。
- 触控目标 ≥44px;预设卡片间距 ≥8px。
- **关闭对话框时若有未保存的一次性明文 → 二次确认**(`sheet-dismiss-confirm`)。这一条**不省**:明文丢了就永久没了,和 T-21 那个「丢几个表单字段」的成本完全不同。
- **表单脏态关闭不确认**(与 T-21 同款裁决,登记为有意省略)。

---

## 9. T-22.1 红灯清单

主文件 `views/share-admin/ShareCreateWizard.spec.js`(新建)。测试基建照抄 `index.spec.js:1-96`(pinia + `createI18n({legacy:false, messages:{en}})` + `vi.mock('@/request/mail-share.js', importOriginal)` **展开** + `vi.mock('@/router')`),`element-plus` 的 `ElMessage`/`ElMessageBox` 照 `ShareDialog.spec.js:34-41` mock;stubs 在 `index.spec.js:36-55` 基础上补 `el-dialog` / `el-button` / `el-switch` / `el-input` / `el-input-number` / `el-collapse` / `el-collapse-item`。

| # | 用例 | 关键断言 | 覆盖 |
|---|---|---|---|
| **W1** | ★预设只预填,不进请求体 | 依次选四个预设 → 表单值随之变;提交后 `createMailShare` 第一参的键集合 ⊆ §3.1 的 12 键白名单,且 `not.toHaveProperty('preset')` / `('presetId')` / `('presetKey')` | **AC-CAP-12** |
| **W2** | 单邮箱验证码预设 = 旧兼容形状 | body 只含 `accountIds:[11]` + `durationSeconds` + `name` + `remark`(或显式默认值),不含受栅栏四键的非 null 值 | AC-CAP-10 · `legacyCompatibleBody` |
| **W3** | 提交带 Idempotency-Key | `createMailShare` 第二参为长度 >8 的字符串 | AC-CAP-09 |
| **W4** | ★结果未知 → 同 key 重试 | 首次 reject 一个 AxiosError(`{isAxiosError:true, code:'ECONNABORTED'}`)→ 表单控件 `disabled`、出现重试按钮;点重试 → 第二次调用的 key **`toBe` 第一次的 key** | **AC-CAP-14** |
| **W5** | 未知态锁表单,业务码不锁 | reject `{code:500,message:'SHARE_DURATION_EXCEEDED'}` → 表单**可编辑**;改一个字段后再提交 → key **`not.toBe`** 上一次 | §5.4 |
| **W6** | ★重放识别 | resolve `{shareId:7, lid:'lid-1', shareType:'single', bindings:[…], idempotentReplay:true}`(**无 sec / 无 shareUrl / 无 authKey**)→ `[data-test="share-url"]` **不存在**;`[data-test="replay-guidance"]` 存在;`[data-test="secret-once"]` 不渲染明文;此后**不自动发第三次请求**(`createMailShare` 恰 2 次) | **AC-CAP-14** |
| **W7** | 重放引导的是 revoke/delete,不是换 key 盲建 | 重放态里存在指向撤销/删除的引导节点;**不存在**「换个 key 再试」按钮;若有「重建」按钮,点它才轮换 key 且需二次确认 | **AC-CAP-14** |
| **W8** | ★V2 降级四组齐全 | 提交含 `authKeyEnabled:true` → reject `{code:500,message:'SHARE_INVALID_CONFIG'}` → **四组**控件(多邮箱 / AuthKey / maxSessions / **messageLimit**)全部 `disabled` 且带 `data-test="capability-inactive"` | **AC-LIFE-11** · §0 ③ |
| **W9** | unknown 态**不**预先置灰 | 组件刚挂载(未提交过)→ 四组控件**可用**,`capability-inactive` 节点不存在 | §4.2 |
| **W10** | 降级后可立即重提 | W8 之后表单里的受栅栏值被复位(`authKeyEnabled` 为 false、`maxSessions`/`messageLimit` 为 null)→ 再次提交的 body 不含受栅栏意图 | §4.2 |
| **W11** | ★本地值域前置,零请求 | `refreshIntervalMs=2999` / `maxSessions=0` / `messageLimit=0` / `durationSeconds=0` / `accountIds=[]` 逐个提交 → `createMailShare` **零调用**;且不因此把 `capabilityV2` 判成 inactive | §4.3(**降级判据的前提**) |
| **W12** | 51 个邮箱前端拦下 | 多邮箱选择器选到 51 → 提交按钮 disabled 或提示,零请求 | AC-CAP-13 |
| **W13** | 成功一次性展示 | resolve 带 `sec` + `shareUrl` → `[data-test="share-url"]` 的 `element.value` 含 `#<sec>`;`[data-test="secret-once"]` 存在 | AC-CAP-05 |
| **W14** | authKey 也一次性 | 响应带 `authKey` → `[data-test="authkey-once"]` 可见该值;响应无该键 → 该节点不渲染 | AC-CAP-05 |
| **W15** | ★明文不复活 | 成功后触发一次列表刷新(`@created` → 父组件 mock)→ 明文仍只在一次性块内;点「我已保存」/ 关闭对话框后明文从 DOM **完全消失** | 镜像 `ShareDialog.spec.js:144-162` |
| **W16** | shareUrl 回落 | 响应只有 `lid`+`sec`、无 `shareUrl` → 用 `buildShareUrl(window.location.origin, lid, sec)` 拼出 `/s/<lid>#<sec>` | 复用 `build-share-url.js` |
| **W17** | 复制走既有 composable | 点复制 → `copied===true` 才弹成功 toast;剪贴板不可用时不弹「失败」而是手选降级 | `useCopyWithFallback` |
| **W18** | 双击提交只发一次 | 连点两次提交 → `createMailShare` 恰 1 次 | `loading-buttons` |

`request/mail-share.spec.js` 追加 1 条:`createMailShare({accountIds:[11,12], durationSeconds:3600, maxSessions:5, authKeyEnabled:true, …}, key)` → body **恰好**含这些键 + header 带 key;**同一文件内既有的 `:40-58` 那条(四键 `toEqual`)必须仍绿**,这就是「条件展开」改法的验收点。

### 必须继续绿的既有断言

- `views/share-admin/index.spec.js` **全部 14 条**,**包括 `:243-252` 的行内零 button 闸门**(header 按钮不在行作用域,天然不冲突)与 `:275-281` 的源码文本断言(锚点补丁不得引入 `window.onresize`)。
- `request/mail-share.spec.js` 既有 6 条 —— 尤其 `:51-56` 的四键 `toEqual`。
- `views/email/ShareDialog.spec.js` / `ShareIndicator.spec.js` —— T-22 不碰 `views/email/**`(那是 T-23),但**改了 ShareDialog 依赖的 `createMailShare`**,所以这两份是本任务的**直接回归面**,不是旁观者。
- `views/share/share-chunk.spec.js` —— 跑**真实 vite build**,新组件 import 写错(比如从向导 import 了访客域文件)会以「构建失败」形态红。**T-20 半成品期间它就红过一次。**
- `init/init.spec.js` · `router/index.spec.js` —— 不碰。

---

## 10. i18n:只登记,不落盘(交 T-29)

### 10.1 可复用的既有键(逐个核对过 `en.js:340-385`)

`shareManage` `shareCreate` `shareCopyLink` `shareSecretOnce` `shareReplayNoSecret` `shareCreateWarning` `shareNamePlaceholder` `shareRemarkPlaceholder` `shareDuration1h/6h/1d/7d` `shareDurationRequired` `shareAccountRequired` `shareMailbox` `shareExpiresAt`,以及通用键 `confirm` `cancel` `copy` `save`。
**`shareSecretOnce` 与 `shareReplayNoSecret` 直接复用,不要为向导再造一对同义键。**
T-20 已登记待落盘的九个(`shareStatusLimitReached` `shareTypeSingle` `shareTypeMulti` `shareBoundMailboxes` `shareSessionQuota` `shareQuotaUnlimited` `shareFilterStatus` `shareFilterAll` `shareAdminForbidden`)。
recon-t21 登记的 40 个里,`shareShowFullAddress` / `shareShowFullAddressHint` / `shareMaxSessions` / `shareMessageLimit` / `shareOtpExtraction` / `shareAutoRefresh` / `shareRefreshInterval` / `shareAuthKey` **T-22 也要用 —— 共享,不重复造**(交 T-29 时按并集去重)。

### 10.2 T-22 新增键(**24 个 × 2 语言**)

| 键 | zh | en |
|---|---|---|
| `shareWizardOpen` | 新建分享 | New share |
| `shareWizardTitle` | 新建分享 | Create a share |
| `shareWizardPresetStep` | 选一个用途 | Pick what it is for |
| `sharePresetSingleOtp` | 单邮箱验证码 | Single-mailbox codes |
| `sharePresetSingleOtpHint` | 把一个邮箱的验证码分给同事,1 小时后自动失效。 | Share one mailbox's verification codes with a teammate; expires in an hour. |
| `sharePresetTempMailbox` | 临时邮箱 | Temporary mailbox |
| `sharePresetTempMailboxHint` | 对方需要看到完整地址去别处注册,有效期 24 小时。 | The visitor sees the full address to sign up elsewhere; valid for 24 hours. |
| `sharePresetMultiOtp` | 多邮箱验证码池 | Multi-mailbox code pool |
| `sharePresetMultiOtpHint` | 一个链接汇总多个邮箱的验证码,需平台已激活该能力。 | One link covering several mailboxes; needs the capability to be active. |
| `sharePresetCustom` | 自定义 | Custom |
| `sharePresetCustomHint` | 全部选项展开,自己配。 | Every option, configured by you. |
| `shareWizardAdvanced` | 高级选项 | Advanced options |
| `shareWizardMailboxes` | 分享的邮箱 | Mailboxes to share |
| `shareWizardDuration` | 有效期 | Valid for |
| `shareOnlyAfterCreated` | 只显示创建之后收到的邮件 | Only show mail received after creation |
| `shareOnlyAfterCreatedHint` | 创建后无法更改这一项。 | This cannot be changed after the share is created. |
| `shareCapabilityInactive` | 能力未激活 | Capability not active |
| `shareCapabilityInactiveHint` | 平台尚未开放多邮箱、访问密钥与用量上限。已为你关掉这几项,其余设置可以照常提交。 | Multi-mailbox, access keys, and usage limits are not enabled on this platform yet. They have been turned off; everything else still works. |
| `shareCapabilityUnknownHint` | 若平台尚未开放该能力,带这几项的提交会被拒绝。 | If the platform has not enabled this yet, a submission using these will be rejected. |
| `shareCapabilityRecheck` | 重新检测 | Check again |
| `shareCreateUnknownTitle` | 没收到服务器的回应 | No response from the server |
| `shareCreateUnknownHint` | 分享**可能**已经建好了。请用同一把钥匙重试 —— 换一把会建出第二个分享。表单已锁定以保证重试安全。 | The share **may** already exist. Retry with the same key—changing it would create a second share. The form is locked to keep the retry safe. |
| `shareCreateRetrySameKey` | 用同一把钥匙重试 | Retry with the same key |
| `shareReplayGuidance` | 这次提交命中了之前的同一请求,链接明文不会再发放。请撤销或删除这个分享,然后重新创建一个新链接。 | This request matched an earlier one; the link secret is not issued again. Destroy or delete this share, then create a new one. |
| `shareWizardCloseConfirm` | 关闭后将无法再看到这个链接(和密钥)。确认已经保存好了吗? | Once closed, the link (and key) cannot be shown again. Have you saved them? |
| `shareCreatedSaved` | 我已保存 | I saved it |

**W4 期间的既定后果**:落盘前页面渲染键名。spec **只断言 `data-test` / 请求实参 / 数值**,不断言这些文案。`showFullAddress` 相关文案沿用 recon-t21 §7 的禁用词表(保密 · 隐藏 · 加密 · 安全 · 私密 · 保护 · secret · hide · private · protect)。

---

## 11. 迷雾清单(需要主 AI 裁决,恰 3 条)

> 其余已由本侦察裁决:`el-dialog` 不是 drawer · 不引 `el-steps` · 三态单页 · 不加 `noMsg` · 不做错误码 i18n 映射 · key 不持久化 · 未知态锁表单 · unknown 不预置灰 · 两个一次性值各绑一个 `selectableRef` · 预设默认值(§7 全表)· `presets.js` 单拆。

**F1 · V2 探测策略三选一(最重要的一条)**
`SHARE_CAPABILITY_V2` 对前端零可见(§4.1 有完整检索证据)。三条路:
(a) **撞后降级 + 列表正向旁证**(§4.2/§4.4)—— 零越界,但首次提交必然吃一次裸码 toast,且存在「值域错误被误判成能力未激活」的窄窗口;
(b) **后端加一个只读能力位**(把 `SHARE_CAPABILITY_V2` 挂进 `websiteConfig` 或 `/mailShare/list` 响应)—— 语义最干净、置灰在第一屏就准确,但**要改 mail-worker,越过 T-22 的文件边界**,而且 W3 契约已封口;
(c) **前端 `VITE_SHARE_CAPABILITY_V2` 常量** —— 零后端改动,但它与 Worker 的 `c.env` 是**两个真源**,部署时必然漂移,是 SSOT 反模式。
**我的建议:(a)。** 理由:唯一不越界且不引入第二真源的路;误报窗口由 W11 用例把死;体验损失只有「第一次撞一下」,而 §4.4 的列表旁证连这一下都常常省掉。
**需要裁决的原因**:(b) 是跨波次的契约变更 + 越界写 mail-worker,执行者不能自己决定;而任务书的「V2=false 时置灰」字面读起来像是假设前端已经知道 —— 这个前提在代码里不成立,必须由主 AI 确认按 (a) 的「事后置灰」交付。

**F2 · 允不允许 T-22 改 `request/mail-share.js` 的 `createMailShare`?**
任务书写「T-20 已加端点」,但 create 只送四个字段(§3.3),不改就交不出任何一个预设。三种改法:
(i) 就地条件展开(既有 `toEqual` 断言天然绿,ShareDialog 请求体逐字不变);
(ii) 新增 `createMailShareV2(body, key)`,旧函数冻结(两个函数、两条 header 逻辑,ShareDialog 与向导以后各走各的);
(iii) 让向导绕过 request 层直接 `http.post`(**明确不推荐**,破坏 T-20 的分层)。
**我的建议:(i)。** 一个函数、一份 header 逻辑,新键只在调用方给了才出现。
**需要裁决的原因**:这是**改 T-20 刚合入的文件**,而且该文件的 spec 用 `toEqual` 钉死了请求体形状 —— 在本项目「旧断言只扩不改写」的纪律下,碰它需要登记;另外这条改动同时落在 ShareDialog(T-23 的地盘)的调用链上。

**F3 · T-21 与 T-22 的三文件相撞 + 排期**
`index.vue`(两棒都要往 `header-actions` / 卡片区加东西)、`index.spec.js`(两棒都要补 stubs;T-21 还要翻面 `:243-252`)、`status.js`(T-21 计划加 `isMutableStatus`)。**T-21 目前尚未落盘**,所以 T-22 若先跑,T-21 起跑时要 rebase;反之亦然。
**我的建议:T-22 先落(它的锚点更小:3 处 ≤6 行,且不需要翻面任何既有断言),T-21 随后 rebase。** 并且 T-22 **一行都不碰 `status.js`**,把那个文件完整留给 T-21。
**需要裁决的原因**:这是波次排期,不是任一执行者能单方面决定的;而且 W4 的「T-21/T-22/T-23 不同文件并行」假设在这三个文件上不成立(recon-t21 §4.4 已预告,现在需要主 AI 拍板顺序)。

---

## 12. 风险与陷阱

| # | 风险 | 处置 / 防线 |
|---|---|---|
| **T1** | ★以为 request 层已就绪,写完组件才发现新字段送不出去 | §3.3 · **第一件事就是改 `createMailShare`** |
| **T2** | ★无条件往 `createMailShare` 加键 → `mail-share.spec.js:51-56` 的 `toEqual` 打红 | §3.3 条件展开 · 追加用例而非改写 |
| **T3** | ★V2 只灰三组,漏了 `messageLimit` | §0 ③ · `:364-366` · 用例 **W8** |
| **T4** | ★把值域错误误判成「能力未激活」 | §4.3 三条件收紧 · 用例 **W11** 是前提 |
| **T5** | ★unknown 态就预先置灰 → V2=true 的部署里能力被藏起来 | §4.2 · 用例 **W9** |
| **T6** | ★照抄 ShareDialog 的 `watch → rotate`,未知态下用户一改表单就换了 key | §5.4 · 锁表单 · 用例 **W4/W5** |
| **T7** | 反过来完全不换 key → 改完表单重提吃 `SHARE_IDEMPOTENCY_CONFLICT` | `replayOrConflict:585-587` · 用例 **W5** |
| **T8** | 重放态自动重发或提供「换 key 再试」 | AC-CAP-14 SHALL NOT · 用例 **W6/W7** |
| **T9** | `refreshIntervalMs` 被后端**拒绝**而不是钳制 | `:346` 明确 `<3000` 抛错。tasks.md T-12.2 写的「钳 ≥3000」是措辞不准,以代码为准 · 用例 **W11** |
| **T10** | `el-input-number` 清空给 `null` → `Number(null)=0` → `SHARE_INVALID_CONFIG` | 空值时用默认值 3000,或提交前拦下 · 用例 **W11** |
| **T11** | 「不限」发成 `0` | `toNullableCount` 收 `null`/`''` 为不限,`0` 会在 `<1` 处被拒。UI 的「不限」必须映射成 `null`/不传 |
| **T12** | `accountIds` 与 `accountId` 同时发 | §3.3 · `toAccountIdSet:188` 优先 `accountIds`,同发只是脏字段,但会让指纹形状与 ShareDialog 分叉 |
| **T13** | 请求体夹带 `preset` 键 | AC-CAP-12 · 用例 **W1**(键集合差集断言) |
| **T14** | 双击提交打出两个同 key 请求,第二个撞重放 → 用户以为没拿到明文 | `:loading` + `:disabled` · 用例 **W18** |
| **T15** | 一次性明文被列表刷新冲掉,或被写进 storage | §6 · 用例 **W15** |
| **T16** | 关闭对话框把没保存的明文吞了 | §8.4 关闭二次确认(**这一条不省**) |
| **T17** | 结果区试图显示邮箱地址 | create 响应的 `bindings[]` **无 mailbox**(`loadBindings:478-484`) |
| **T18** | 从向导 import 访客域文件 → `share-chunk.spec.js` 以构建失败形态红 | §2.2 禁 import 清单 |
| **T19** | `vi.mock('@/request/mail-share.js')` 不展开 `importOriginal` → `newIdempotencyKey` / `isShareForbidden` 变 undefined | 照 `index.spec.js:17-23` |
| **T20** | 顺手改 `status.js` / `index.spec.js` | §2.2 · 那是 T-21 的写点(F3) |
| **T21** | 抄了 `ShareDialog.vue:228-290` 的裸 hex → 暗色主题坏 | §8.1 · 只走 CSS 变量 |
| **T22** | 偷偷改 `i18n/zh.js` / `en.js` | §2.2 · §10 只登记 |
| **T23** | 多邮箱选择器只拉到前 30 个 | `accountList(accountId, size, lastSort)`(`request/account.js:3`)游标分页,`size` 硬顶 30,返回**裸数组**不是 `{list,total}`,**无按邮箱搜索端点**。翻页范式照 `layout/account/index.vue:400-415`。单邮箱预设默认取 `useAccountStore().currentAccountId`(`views/email/index.vue:22` 同款) |
| **T24** | 基于 recon-t21 的**记忆**而不是当前文件写代码 | `index.vue` 的 md5 已从 `af823d25…` 变成 `3fad53e1…`;T-21 **尚未落盘**,不要 import 不存在的 `ShareDetailDrawer.vue` |

---

## 13. 验证命令与基线

```bash
# 定点(红 → 绿)
pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareCreateWizard.spec.js --no-cache

# 邻接回归(request 层改动的直接波及面 —— 这一组不是可选的)
pnpm --dir mail-vue exec vitest run src/request/mail-share.spec.js \
    src/views/email/ShareDialog.spec.js src/views/email/ShareIndicator.spec.js \
    src/views/share-admin/index.spec.js src/views/share/share-chunk.spec.js

# 全量(基线 18 文件 / 113 用例,2026-08-24 11:28 实测 EXIT=0)
pnpm --dir mail-vue test

# 构建(T-20 做过,新组件引入后再做一次)
pnpm --dir mail-vue build
```

跨栈基线:worker 18 文件 / 619 用例 · vue **18 / 113**(实测)· E2E 13。T-22 是纯前端任务,worker 与 E2E **不跑**,exec note 里按惯例标 `unverified`,不假称绿。

---

## 14. 执行前自检清单

- [ ] 六个 md5 与表头一致;`views/share-admin/` 下确认 T-21 是否已落盘(若已落盘,重读 `index.vue` 与 `index.spec.js`)
- [ ] §11 三条迷雾已取得裁决(V2 探测策略 / 能否改 `createMailShare` / T-21 排期)
- [ ] `createMailShare` 用**条件展开**;`mail-share.spec.js:40-58` 的四键 `toEqual` 仍绿
- [ ] request 层**不做值域归一化**(不钳 3000、不转 flag),透传裁决继承 T-20
- [ ] `accountIds` 与 `accountId` **不同时发**
- [ ] 请求体键集合 ⊆ §3.1 的 12 键;**无 `preset*`**
- [ ] V2 置灰覆盖**四组**(多邮箱 / AuthKey / `maxSessions` / **`messageLimit`**)
- [ ] `unknown` 态**不**预置灰;置灰前置条件三条齐备(§4.3)
- [ ] 本地值域校验覆盖五个点(`refreshIntervalMs<3000` / `maxSessions<1` / `messageLimit<1` / `durationSeconds<=0` / `accountIds` 空或 >50)
- [ ] 结果未知 → **锁表单** + 同 key 重试;业务码 → 可编辑 + 改表单才换 key
- [ ] 重放态:无明文、有 revoke/delete 引导、**无换 key 盲建路径**
- [ ] 两个一次性值各自 `useCopyWithFallback()` + 各自 `selectableRef`;不进 storage/pinia/URL
- [ ] `shareUrl` 缺失时回落 `buildShareUrl(window.location.origin, lid, sec)`;`build-share-url.js` **零改动**
- [ ] 关闭对话框时若明文未确认保存 → 二次确认
- [ ] `index.vue` 改动 **≤6 行**、恰三处;`data-share-id` 与全部既有 `data-test` 一个没动
- [ ] `status.js` / `index.spec.js` / `i18n/*.js` / `router/index.js` / `axios/index.js` / `views/email/**` / `mail-worker/**` **一字未改**
- [ ] 零裸 hex;`<style lang="scss" scoped>`;`@media (max-width: 767px)`;无 `window.onresize`
- [ ] 向导不 import `views/share/**` / `request/share.js` / `useSharePolling.js`
- [ ] §10.2 的键表原样进 exec note
- [ ] 定点红→绿;邻接 5 份全绿;`pnpm --dir mail-vue test` 与 18/113 比只增不减;`build` EXIT=0

---

## 15. 参考锚点索引

```
契约   docs/specs/mailbox-share-capability/requirements.md:66(AC-CAP-12)、:68(AC-CAP-14)
       :63(AC-CAP-09)、:64(AC-CAP-10)、:67(AC-CAP-13)、:162(AC-ADMIN-08)、:200(★AC-LIFE-11 四条受限写入)
       design.md:300(★create 契约行)、:303(update 契约行)、:388-394(管理模块 / ★创建向导规格)
       :103(Decision 14 掩码=展示偏好)、:409(Owner 文案约束)
       tasks.md:27(i18n 单写者)、:488-490(T-22)、:546-547(W4 并行说明)
前端   mail-vue/src/request/mail-share.js:3-17(newIdempotencyKey 含降级)、★:19-31(createMailShare 只送四键)
       :49-52(list 分页)、:86-91(isShareForbidden)
       mail-vue/src/request/mail-share.spec.js:★40-58(四键 toEqual 硬约束)、:90-105(五端点)
       mail-vue/src/views/share-admin/index.vue:3-18(header-actions 锚点)、:196-198(refresh)
       :144(reqSeq 竞态保护)、:203-389(scss 令牌与 767 断点)
       mail-vue/src/views/share-admin/index.spec.js:1-96(测试基建)、:243-252(行内零 button 闸门,T-22 不受影响)
       :275-281(源码文本断言)
       mail-vue/src/views/share-admin/status.js:1-62(★T-21 的写点,T-22 不碰)
       mail-vue/src/views/email/ShareDialog.vue:★25-39(一次性展示模板)、:92-97(durationOptions)
       :103(idempotencyKey ref)、:109-126(派生 + replayWithoutSecret)、:152-159(关闭即清)
       :161-189(唯一赋值点)、:210-215(复制)、★:217-219(watch → rotate,本任务要加闸)
       mail-vue/src/views/email/ShareDialog.spec.js:★144-162(明文不复活)、:164-187(同 key 重试)
       mail-vue/src/views/email/build-share-url.js:1-9(仅 import 复用)
       mail-vue/src/composables/useCopyWithFallback.js:120-191(copy / selectableRef / 手选降级)
       mail-vue/src/axios/index.js:26/38/47/58/67(业务码 reject 形状)、:74-77(传输 403 → reload)
       :82/116(传输失败 reject AxiosError)
       mail-vue/src/request/account.js:3(accountList,游标 + size 上限 30 + 裸数组)
       mail-vue/src/layout/account/index.vue:400-415(游标翻页范式)
       mail-vue/src/perm/perm.js:62-72(share-admin 路由,不需新增)
       mail-vue/src/i18n/en.js:340-385(既有 share 键段)
       mail-vue/vite.config.js:44-46(ElementPlusResolver → el-dialog 自动解析)
后端   mail-worker/src/api/mail-share-api.js:23-28(★create 端点 + Idempotency-Key header)
       mail-worker/src/service/mail-share-service.js:★195-212(normalizeCreateBody 12 字段与默认值)
       :141-155(toFlag 严格枚举 + 空值回落)、:158-167(toNullableCount)、:172-190(toIdSet / toAccountIdSet)
       :★228-246(legacyCompatibleBody 兼容集)、:251-259(createFingerprints 双 hash)
       :★334-367(assertCreateBody:顺序 = 域 → 上限 → 栅栏,★四条 V2 门控)
       :421-456(projectOwnerRow —— list 与 get 共用,带 shareType/maxSessions/messageLimit/authKeyEnabled)
       :474-476(shareTypeOf 派生)、:478-484(loadBindings 无 mailbox)
       :★528-543(firstCreateResponse)、:★553-578(replayFromIdempotency 无明文)
       :580-589(replayOrConflict:cutoff / CONFLICT)、:1112-1183(create 主流程)
       :67-82(★isCapabilityV2Enabled / assertCapabilityV2 —— 只读 c.env,前端不可见)
       :31-37(SHARE_V2_INTENT)、:11(MIN_REFRESH_INTERVAL_MS=3000)、:15(SHARE_BINDING_LIMIT=50)
       :935-944(UPDATE_FIELDS 白名单,与 create 的差集见 §3.2)
       mail-worker/src/model/share-result.js:5(fail 默认 code=500,裸错误码)
       mail-worker/src/service/setting-service.js:200-225(websiteConfig 字段全来自 DB,无 env)
       mail-worker/wrangler.toml:58-60 · wrangler-vitest.toml:40-41(SHARE_CAPABILITY_V2 声明处)
前锋   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-t21-drawer.md
       §2.2(request 层清单)、§4.4(★三文件并行冲突预告)、§5(一次性密钥四段)、§7(掩码文案禁用词表)
       §11-F1(OneShotSecret 抽不抽 —— T-22 是那条迷雾里点名的「第二消费者」)
       recon-t20-share-admin.md §3.1(透传裁决)、§10(i18n 登记体例)
```
