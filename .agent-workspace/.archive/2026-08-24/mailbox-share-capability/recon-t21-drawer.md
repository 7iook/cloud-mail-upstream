# Recon · T-21 详情抽屉:Binding 管理 + 配置编辑 + AuthKey 区(W4 第二棒)

| 字段 | 值 |
|---|---|
| 范围 Scope | T-21 / T-21.1,`docs/specs/mailbox-share-capability/tasks.md:460-462` |
| 分支 Branch | `cursor/mailbox-share-capability-dcb6`,HEAD `dbfd3ef` |
| 侦察日期 | 2026-08-24 11:10 UTC |
| 依据 AC | AC-ADMIN-02(详情读)、AC-ADMIN-03(配置写)、AC-ADMIN-05(AuthKey);旁及 AC-ADMIN-04/06/07/09、AC-AUTH-07/08、AC-BIND-04/10/12、AC-CAP-13、AC-EDGE-14、AC-LIFE-11、AC-MAIL-08(掩码文案) |
| **T-20 实时状态** | **已落盘但未提交**(工作区脏):`views/share-admin/index.vue` · `status.js` · `index.spec.js` 三个新文件已存在,`request/mail-share.js` · `perm/perm.js` · `request/mail-share.spec.js` · `layout/aside/index.vue` 已改。**本侦察读的是这份实体,不是预测** |
| 基线 | **已实测**(含 T-20 未提交改动):`pnpm --dir mail-vue test` → **18 文件 / 113 用例 / EXIT=0**(2026-08-24 11:10)。T-20 之前是 17/95 |
| 快照校验 | `index.vue` `af823d25…` · `status.js` `576036cb…` · `index.spec.js` `7751a505…` · `request/mail-share.js` `4621ee26…`(T-20 仍可能被 review 改动,**执行前先 `md5sum` 比对,不一致就重读**) |
| 性质 | 只读侦察。未改任何生产/测试/spec 文件、未提交;本文件是唯一产物 |
| 已读技能 | frontend-design · impeccable · ui-ux-pro-max · ponytail(结论内化进 §5/§6/§7,不单列附录) |

---

## 0. 一句话结论

T-21 的技术难度**不在抽屉本身**,而在四条会静默打红、或静默把语义做错的细节上:

① **T-20 埋了一条会被 T-21 必然打红的基线断言。** `views/share-admin/index.spec.js:243-252` 那条用例叫「leaves every row action to T-21」,断言 `row.findAll('button')).toHaveLength(0)`。T-21 按 T20-ACTIONS 往行上放「详情/撤销/删除」的那一刻,这条**必红**。这不是 bug,是 T-20 故意留的交接闸门 —— T-21 的正确动作是**把这条用例翻面**(改成「行现在带三个动作且 `data-share-id` 仍在」),而不是删掉它、也不是绕开它把按钮挪到卡片外。**这是全 T-21 唯一一处允许改写既有断言的地方,必须在 exec note 里显式登记。**

② **配置编辑必须发「脏字段 diff」,不能发整表单。** 后端 `assertUpdatePatch`(`mail-share-service.js:963-971`)的栅栏判据是「**这个键出现在 patch 里且值非 null**」,不是「值变了」。所以在 `SHARE_CAPABILITY_V2=false` 下,一个 `messageLimit` 已经是有限值的分享,用户只改了个 `name`,只要整表单回传就会把 `messageLimit: 50` 一起送上去 → 命中 `MESSAGE_LIMIT` 栅栏 → 整单 `SHARE_INVALID_CONFIG`,用户看到「改个名字都报错」。`maxSessions` 同理。**patch 必须只装被用户改过的键**,而且要能区分三态:键不在=不改 / 键在且为 `null`=清空限制 / 键在且有值=设值(`hasKey` 语义,`:130-132`)。

③ **`PUT /mailShare/bindings` 的入参与响应都是不对称的,而且响应缺字段。** add 传 **accountId**、remove 传 **bindingId**(`:1189-1190`)—— 两个都是数字,传混了后端只会回 `SHARE_BINDING_FORBIDDEN` 或 `SHARE_ACCOUNT_FORBIDDEN`,不会告诉你传错了维度。更隐蔽的是**响应里的 `bindings[]` 没有 `mailbox` 字段**(`loadBindings:478-484` 只 SELECT `binding_id, account_id`),而 `get`/`list` 的 `bindings[]` **有** `mailbox`(`loadBindingSummaries:496-507`)。**同名字段两套形状** —— 直接把 bindings 响应灌回抽屉状态,邮箱地址会集体变空。正确姿势:bindings 写成功后**重取 `GET /mailShare/get`**。

④ **三个写端点全部要求 `status='ACTIVE' AND expires_at > now`**(`loadMutableShare:1025-1034`),失败一律 `SHARE_NOT_FOUND`。而 AC-ADMIN-09 要求 EXPIRED/REVOKED 行**仍然可读可审计** —— 所以抽屉是「读永远开、写按态开」。可写谓词恰好等价于 `effectiveStatus ∈ {ACTIVE, ACCESS_LIMIT_REACHED}`:**`ACCESS_LIMIT_REACHED` 是可写的**(它 status 仍是 ACTIVE,只是配额触顶),把它一起置灰是最容易犯的错 —— 那正是用户最需要进来调 `maxSessions` 的时刻。

---

## 1. 问题直答(用户点名的四问)

| # | 问题 | 结论 | 详见 |
|---|---|---|---|
| 1 | ShareDialog 的一次性密钥展示到底长什么样 | 任务书/design.md 写的 `ShareDialog.vue:161-189` **只是脚本的一半**(那是 `submitCreate`)。完整模式是四段:模板 `:25-39`、computed `:109-126`、关闭即清 `:152-159`、只在 create 响应赋值 `:161-189`。核心不变量是「明文只存在于**那一次响应**的局部 ref,任何后续 list/detail 都不再产出它」,由 `ShareDialog.spec.js:144-162` 正面钉住 | §5 |
| 2 | T-20 会加哪些 request 函数 | **已经加完了**,五个新函数 + 一个判据,签名见 §2.2。T-21 **request 层零改动** | §2.2 |
| 3 | 怎么防止 T-21 把列表页重写一遍 | 把 index.vue 的改动锁进一个 **≤10 行的锚点补丁**(4 处),其余全部落在 T-21 自己的两个新文件里。锚点清单与逐行形状见 §4.2 | §4 |
| 4 | 掩码开关文案 | 键 `shareShowFullAddress` = 「显示完整地址(展示选项)」,配一条 hint 明说「这只影响显示方式,不是保密能力」。禁用词表 + 一条 sleeper 断言见 §7 | §7 |

---

## 2. T-20 交给 T-21 的实体接口(已落盘,非预测)

### 2.1 列表页 DOM 钩子(`views/share-admin/index.vue:38-45`)

```html
<article v-for="row in rows" :key="row.shareId" class="share-card"
         data-test="share-row" :data-share-id="row.shareId" :data-status="row.effectiveStatus">
  <div class="card-head">
    <span class="card-name" data-test="share-name">…</span>
    <div class="card-tags"> el-tag×2(type / status) </div>
  </div>
  <dl class="card-fields"> 绑定摘要 / 配额 / 到期 / 最后访问 </dl>
</article>
```

- 取数入口叫 **`fetchList()`**(`:127-160`),`refresh()`(`:172-174`)是它的零参包装。T-21 的 `@changed` 直接绑 `fetchList` 即可,**不需要新增刷新函数**。
- `page` / `size`(常量 20)/ `total` / `rows` 都在 setup 顶层;`reqSeq`(`:120`)保证只有最新响应能写 `rows`。T-21 触发的刷新自动受这条保护。
- 卡片网格 `repeat(auto-fill, minmax(320px, 1fr))`,767 断点单列(`:216-220`)。行动作放进 `.card-head` 右侧还是卡片底部,是 T-21 的版式选择(§6.2)。

### 2.2 request 层(`request/mail-share.js`,现 91 行)—— **T-21 不改一个字**

| 函数 | 行 | 形状 | T-21 用途 |
|---|---|---|---|
| `getMailShare(shareId)` | `:54` | `GET /mailShare/get`,`{params:{shareId}}` | 抽屉打开取详情 · 每次写成功后重取 |
| `updateMailShare(body)` | `:60` | `PUT /mailShare/update`,**纯透传 body** | 配置编辑(body 必须是 diff,§6.3) |
| `updateMailShareBindings(body)` | `:64` | `PUT /mailShare/bindings`,纯透传 | Binding 增删 |
| `deleteMailShare(shareId)` | `:68` | `DELETE /mailShare/delete`,`{params:{shareId}}` | 行操作「删除」 |
| `resetMailShareAuthKey(body)` | `:74` | `POST /mailShare/resetAuthKey`,纯透传 | AuthKey 三迁移 |
| `revokeMailShare(shareId)` | `:78` | 既有 | 行操作「撤销」 |
| `isShareForbidden(err)` | `:86` | `err.code === 403 \|\| err.message === 'SHARE_FORBIDDEN'` | 抽屉里的 403 也走这条,**不要在组件里重写判据** |

**透传是 T-20 的裁决(recon-t20 §3.1),T-21 要继承它**:不要在组件与 request 之间再插一层「字段白名单/归一化」。后端 `UPDATE_FIELDS`(`:935-944`)是唯一真源,前端抄第二份必然漂移。

### 2.3 `status.js`(SSOT,`views/share-admin/status.js`)—— 复用,不 fork

| 导出 | 行 | 形状 |
|---|---|---|
| `SHARE_STATUSES` | `:10` | `['ACTIVE','EXPIRED','ACCESS_LIMIT_REACHED','REVOKED']` |
| `statusMeta(status)` | `:12` | `{ labelKey, tone }`,未知态回落 `{labelKey:'', tone:'info'}` |
| `shareTypeLabelKey(t)` | `:16` | `'shareTypeMulti' \| 'shareTypeSingle'` |
| `usedSessions(row)` | `:20` | `usedSessions ?? accessCount`,双键兼容 |
| `quotaText(row, unlimitedLabel)` | `:28` | `'2 / 5'` / `'3 / 不限'` |
| `bindingLabels(row)` / `bindingSummary(row, limit=2)` | `:33` / `:53` | 空 mailbox 回落 `#accountId`;全空回落 `row.mailbox`;超限折叠 `a, b +N` |

抽屉头部的四态徽标 **必须** 走 `statusMeta`,绑定清单的空地址回落 **必须** 走 `bindingLabels` —— 抽屉里另写一个 `binding.mailbox || '-'` 就是第二套回落口径,T-18 硬删窗口的 `mailbox: ''` 会在两个界面显示成两样。

**允许的唯一扩写**:往 `status.js` 追加一个纯函数

```js
// 三个写端点共用后端 loadMutableShare 的谓词;读永远开,写只在这两态开。
export function isMutableStatus(effectiveStatus) {
    return effectiveStatus === 'ACTIVE' || effectiveStatus === 'ACCESS_LIMIT_REACHED'
}
```

理由:这条判据 T-21(抽屉写控件)与 T-22(向导后立即编辑)都要用,写在组件里就是两份。**风险登记**:`status.js` 因此成为 T-21/T-22 的共享写点,W4 的「不同文件并行」在这一个文件上失效 —— 追加式改动冲突面很小,但 exec note 要标出来。

---

## 3. 后端契约(只读核实,T-21 一行不改)

### 3.1 `GET /mailShare/get`(AC-ADMIN-02)

- `mail-share-api.js:35` → `mailShareService.get:1267-1269` → `loadOwnerDetail:514-526`。
- 谓词只有 `share_id + user_id`,**不带 status/expires** —— EXPIRED/REVOKED/触顶行都读得到(AC-ADMIN-09)。
- 他人 shareId / 不存在 / 非法值(`toShareId` 把 `true`、`'abc'`、`-1` 一律折成 0)**共用 `SHARE_NOT_FOUND`**,存在性探针封闭。
- 返回 = `projectOwnerRow`(`:424-456`),**与 list 行同一套键名**,额外多的只有 `bindings[]` 明细。抽屉可用字段:
  `name` `remark` `status` `effectiveStatus` `shareType` `mailbox` `expiresAt` `createTime` `deleteAt` `revokedAt` `lastAccessAt` `accessCount`/`usedSessions` `maxSessions`(可 null) `messageLimit`(可 null) `onlyMessagesAfterCreated`(**只读,不在 UPDATE 白名单**) `otpExtractionEnabled` `autoRefresh` `refreshIntervalMs` `showFullAddress` `authKeyEnabled` `bindings[{bindingId, accountId, mailbox}]` `lid`。
- **凭据物料永不出现**:`OWNER_ROW_COLUMNS:371-378` 根本不 SELECT `sec_hmac` / `auth_key_hash` / `credentials_version`。所以**详情里永远没有 authKey**,一次性明文只能来自 resetAuthKey 那一次响应(§5)。

### 3.2 `PUT /mailShare/update`(AC-ADMIN-03 / AC-EDGE-14)

| 事实 | 出处 | 对 T-21 的约束 |
|---|---|---|
| 可写白名单恰 8 个:`name` `remark` `maxSessions` `messageLimit` `otpExtractionEnabled` `autoRefresh` `refreshIntervalMs` `showFullAddress` | `UPDATE_FIELDS:935-944` | 表单里**不要**放 `onlyMessagesAfterCreated`(刻意排除,`:933`)、不要放 `expiresAt`/`accountIds`/AuthKey |
| 在场判据是 `hasOwnProperty`,不是真值 | `normalizeUpdateBody:946-955` + `hasKey:130-132` | 「键不在=不改 / 键在且 null=清空 / 键在有值=设值」三态可区分,前端必须照这个语义构造 diff |
| 栅栏按「patch 里有该键且值非 null」触发 | `assertUpdatePatch:963-971` | **整表单回传 = 无谓触栅栏**(§0 ②)。V2=false 时 `maxSessions`/`messageLimit` 只要出现在 patch 且非 null 就 `SHARE_INVALID_CONFIG` |
| `refreshIntervalMs` 硬下界 3000ms,且**必须是安全整数** | `toPatchInterval:918-924`,`MIN_REFRESH_INTERVAL_MS:11` | 表单 `:min="3000"`;`el-input-number` 空值会给 `null` → `Number(null)=0` → 报错,空值时**不要把这个键放进 patch** |
| `maxSessions` / `messageLimit` 下界 1,`null`/`''` = 清空 | `toPatchCount:910-916` + `toNullableCount:158` | 「不限」选项要发**显式 `null`**,不是不发这个键 |
| 三个 flag 严格枚举,不接受 `2`/`'yes'`/`undefined` | `toPatchFlag:902-908`(注意:它**没有** `toFlag` 的空值回落) | `el-switch` 用 `:active-value="true"` 布尔,别传数字 |
| `resetUsedSessions` 缺省 = `true`,且只在「patch 含 maxSessions 且非 null」时才计算 | `:1281-1282` | 见 §6.4 |
| 真正的清零由 SQL `CASE WHEN max_sessions IS NULL` 兜底 | `prepareUpdate:976-986` | 即使前端判错「是不是首次设限」,后端也只会在旧值为 NULL 时清零 —— 前端的判断是**交互提示**,不是正确性防线 |
| **响应 = 完整 detail**(`loadOwnerDetail`) | `:1289` | 保存成功后直接消费响应刷新抽屉,**不用再打一次 get** |
| 并发被 revoke/过期 → `SHARE_NOT_FOUND` | `:1285-1287` | 抽屉要能从「保存时发现分享没了」优雅退出(关抽屉 + 刷列表) |

**实测证据**:`share-integration.spec.js:1298-1328` 完整跑通「首次设限默认清零 → usedSessions=0」与「`resetUsedSessions:false` 保留计数 → 立刻 `ACCESS_LIMIT_REACHED`」。

### 3.3 `PUT /mailShare/bindings`(AC-BIND-04/10/12、AC-CAP-13)

| 事实 | 出处 | 对 T-21 的约束 |
|---|---|---|
| body = `{shareId, add?: accountId[], remove?: bindingId[]}`,单值与数组同收 | `:1186-1191` + `toIdSet:172` | **add 用 accountId,remove 用 bindingId** |
| 同一单里「移除某邮箱又加回同一个 accountId」→ `SHARE_BINDING_DUPLICATE` | `assertBindingChange:1093-1098` | 别做「暂存 diff 一次提交」的编辑器;**每次动作单独提交** |
| 变更后投影数 > 50 → `SHARE_BINDING_LIMIT_EXCEEDED` | `:1099-1103`,`SHARE_BINDING_LIMIT:15` | 加邮箱按钮在 `bindings.length >= 50` 时禁用 + 提示 |
| 使现存数变大且 > 1 → V2 栅栏 → `SHARE_INVALID_CONFIG` | `:1104-1108` | 单邮箱 → 多邮箱在 V2=false 下不可用,**缩减与等量替换不受限** |
| 删空最后一个 Binding → **整个分享自动 REVOKED**,响应 `status:'REVOKED'` | `:1223-1226`, `:1258-1263` | 移除确认文案必须写明这一后果;成功后抽屉切只读 + 刷列表 |
| CAS 落空 → `SHARE_BINDING_CONFLICT`,**禁止原样重试** | `:1232-1237` 注释 | 收到就重取 detail,让用户在新集合上重做 |
| 响应 `bindings[]` = `{bindingId, accountId}`,**无 mailbox** | `loadBindings:478-484` | §0 ③:成功后必须重取 `get` |
| 他人 bindingId / 已删 → `SHARE_BINDING_FORBIDDEN`;非本人 accountId → `SHARE_ACCOUNT_FORBIDDEN` | `:1090-1091` / `:1240-1242` | 两个码都当「集合已变」处理:重取 detail |

**可加邮箱从哪来**:仓内只有 `request/account.js:3` 的 `accountList(accountId, size, lastSort)`。契约(`account-service.js:107-133`):游标分页(要同时传上一页最后一条的 `accountId` 与 `sort`)、**`size` 硬顶 30**、返回**裸数组**(不是 `{list,total}`)、只含本人 `is_del=NORMAL` 的账号、行里有 `email`/`accountId`/`sort`。**没有按邮箱搜索的端点**。翻页范式照 `layout/account/index.vue:400-415`。这是 T-21 唯一需要引入的新 request 依赖,**而且它不属于分享域**——从抽屉 import `@/request/account.js` 是合法的(同为登录态 axios),但不要反过来往 `mail-share.js` 里塞账号函数。

### 3.4 `POST /mailShare/resetAuthKey`(AC-ADMIN-05 / AC-AUTH-07 / AC-AUTH-08)

状态机(`AUTH_KEY_TRANSITIONS:1043-1047`):

| action | 前置 `authKeyEnabled` | 铸新 Key | `credentials_version` | V2 栅栏 | 对已建立会话 |
|---|---|---|---|---|---|
| `enable` | **false** | 是 | **不加** | **是**(V2=false 直接 `SHARE_INVALID_CONFIG`) | **不失效**(建立时本无 Key 要求) |
| `reset` | **true** | 是 | +1 | 否 | **全部立即失效** |
| `disable` | **true** | 否 | +1 | 否 | **全部立即失效** |

- action 严格枚举,不 trim 不小写(`toAuthKeyTransition:1052-1057`)。
- 前置态不匹配(双标签页竞态)→ `SHARE_INVALID_CONFIG`,与「V2 未开」**同码不可区分**(`:1329-1330` 明说语义只靠语句顺序保住)。所以失败提示必须同时给出两种可能 + 一个「刷新重试」出口,**不要断言是哪一种**。
- 响应:`{...detail, authKey}`,**只有 enable/reset 挂 `authKey` 键;disable 是「没有这个键」而不是空串**(`:1368-1369`)。Key 形状 `/^[A-Za-z0-9_-]{22}$/`(`share-integration.spec.js:1403,1433`)。
- **文案的诚实性约束(与掩码同源)**:`enable` 不会让已经打开的访客会话失效(`share-integration.spec.js:1436` 正面钉住),所以启用按钮的说明**不得**写成「启用后现有访问立即需要密钥」;`reset`/`disable` 反过来必须写明「会立刻踢掉所有已打开的访问」。

### 3.5 错误码不经 i18n —— 会原样弹出来

`shareResult.fail` 只回 `{code, message}`,`message` 就是 `SHARE_BINDING_CONFLICT` 这种裸串(全仓 grep:这些码不在 `mail-worker/src/i18n/**`)。登录态拦截器 `axios/index.js:59-68` 会把它当 `data.message` 直接 `ElMessage.error` 弹出。

**裁决**:T-21 **不做**「错误码 → 中文」的映射表。理由:那是 8 个码 × 2 语言 = 16 个新 i18n 键,而 i18n 是 T-28/T-29 单写者热区;而且这套裸码 toast 是全仓既有行为(`ShareDialog` 至今如此),T-21 不该在一个抽屉里单独立规矩。T-21 只对**会改变 UI 行为**的三个码分支:`SHARE_NOT_FOUND`(关抽屉+刷列表)、`SHARE_BINDING_CONFLICT`/`SHARE_*_FORBIDDEN`(重取 detail)、`SHARE_INVALID_CONFIG`(内联提示 + 保留用户输入)。其余交给全局 toast。

---

## 4. 怎么让 T-21 不重写列表页(用户点名的问题)

### 4.1 T-21 的文件清单:两个新文件 + 一个锚点补丁 + 一处 spec 翻面

| 文件 | 动作 | 规模 |
|---|---|---|
| `mail-vue/src/views/share-admin/ShareDetailDrawer.vue` | **新建**(抽屉容器 + 三个面板) | T-21 的主体 |
| `mail-vue/src/views/share-admin/ShareRowActions.vue` | **新建**(详情/撤销/删除三按钮 + 两次确认) | ~60 行 |
| `mail-vue/src/views/share-admin/ShareDetailDrawer.spec.js` | 新建 | §8 |
| `mail-vue/src/views/share-admin/ShareRowActions.spec.js` | 新建 | 3-4 条 |
| `mail-vue/src/views/share-admin/index.vue` | **锚点补丁,目标 ≤10 行**(§4.2) | 硬预算 |
| `mail-vue/src/views/share-admin/index.spec.js` | **翻面 1 条 + 新增 1 条**(§4.3) | 硬预算 |
| `mail-vue/src/views/share-admin/status.js` | 追加 `isMutableStatus`(§2.3) | +3 行 |

`ShareRowActions.vue` 单拆出来的理由不是「组件化」,是**预算**:三个按钮 + 两个 `ElMessageBox` 确认 + 错误分支如果直接写进 `index.vue`,那份文件就从 T-20 的「只读列表」变成读写页,§4.2 的 10 行预算立刻破产,而且 T-22 之后往同一个文件加「新建」按钮时会撞进一片刚改过的乱码区。**这是 ponytail 阶梯第 1 级的反面用法:拆分在这里是为了让别人的 diff 变小,不是为了抽象。**

### 4.2 锚点补丁:index.vue 恰好四处

```diff
  <script setup>
+ import ShareRowActions from './ShareRowActions.vue'
+ import ShareDetailDrawer from './ShareDetailDrawer.vue'
+ const activeShareId = ref(0)                                  // ← 2)
```
```diff
        <div class="card-tags">
          <el-tag type="info" data-test="share-type">…</el-tag>
          <el-tag :type="statusMeta(row.effectiveStatus).tone" data-test="share-status">…</el-tag>
+         <ShareRowActions :row="row" @open="activeShareId = row.shareId" @changed="fetchList"/>   <!-- 3) -->
        </div>
```
```diff
    </el-scrollbar>
+   <ShareDetailDrawer v-model:share-id="activeShareId" @changed="fetchList"/>                     <!-- 4) -->
```

四处:import(1 行 ×2)· `activeShareId` ref(1 行)· 行内组件(1 行)· 抽屉挂载(1 行)。**合计 5-6 行,预算 10 行留余量给 `ref` 的 import 调整。**

三条硬约束:
1. **`fetchList` 用现名直绑**,不新增 `reload()` 包装 —— 包装函数就是让 T-20 的 diff 变大的第一步。
2. **抽屉挂在 `.share-admin` 根节点下、`el-scrollbar` 之外**。挂进滚动容器里会让 el-drawer 的定位与滚动锁掉,而且行被筛选掉时抽屉会跟着卸载。
3. **不改 `.share-card` 的 DOM 结构、不动任何既有 `data-test`**;`data-share-id` 保留(T-20 的 `:243-252` 与 §8 都靠它)。

### 4.3 index.spec.js 的那条闸门用例(**必须处理,不能绕**)

现状 `index.spec.js:243-252`:

```js
it('leaves every row action to T-21: rows carry hooks, not buttons', async () => {
    …
    expect(row.findAll('button')).toHaveLength(0)          // ← T-21 一放按钮就红
    expect(row.findAll('[data-test="revoke-share"]')).toHaveLength(0)
})
```

**处置(裁决)**:翻面,不删除。改成

```js
it('hands row actions to the T-21 drawer without losing the list hooks', async () => {
    const row = wrapper.get('[data-test="share-row"]')
    expect(row.attributes('data-share-id')).toBe('7')                       // 钩子仍在
    expect(row.get('[data-test="row-open-detail"]').exists()).toBe(true)    // 三个动作各一
    expect(row.get('[data-test="row-revoke"]').exists()).toBe(true)
    expect(row.get('[data-test="row-delete"]').exists()).toBe(true)
})
```

外加**一条新的接线用例**:点「详情」→ 抽屉收到该 `shareId` 并调用 `getMailShare(7)`。

理由:这条用例的价值是「行钩子不能丢」,而不是「行里不能有 button」。删掉它,`data-share-id` 就再无守卫;保留 `toHaveLength(0)`,T-21 就必须把按钮放到卡片外面 —— 那是为了让测试变绿而扭曲版式,典型的测试驱动坏味道。**改写既有断言在本项目是需要登记的越界动作(「单邮箱旧断言只扩不改写」),所以 exec note 必须原文引用这一条、说明它是 T-20 为 T-21 预置的交接闸门,而不是回归。**

`index.spec.js` 的 `stubs` 表(`:36-55`)也要补 `el-button` / `el-drawer` 等 —— 这属于同一处翻面的连带改动。

### 4.4 并行冲突登记

`index.vue` / `index.spec.js` / `status.js` 三个文件同时是 **T-22(创建向导要加「新建」按钮)** 的落点。W4 「T-21/T-22/T-23 不同文件并行」的假设在这三个文件上**不成立**。建议:T-21 先落这三处锚点,T-22 起跑前 rebase;或由主 AI 把 T-22 的锚点一并纳入 T-21 的补丁(不推荐,那是替别人写代码)。**这是需要主 AI 排期时知道的事实,不是 T-21 能自己解决的。**

---

## 5. 一次性密钥:ShareDialog 的模式到底是什么

任务书与 design.md:392 都写「复用 `ShareDialog.vue:161-189`」。**核对结果:这个行号只指到脚本的一半。** 在 HEAD `dbfd3ef` 上,`:161-189` 是 `submitCreate`。完整模式由四段构成:

| 段 | 行 | 作用 |
|---|---|---|
| 模板展示块 | `:25-39` | `v-if="created"` 包裹;`data-test="secret-once"` 一次性告警;只读 `<input data-test="share-url" :value>`(**不是 `{{ }}` 文本**,便于降级手选);复制按钮 |
| 派生值 | `:109-126` | `createdShareUrl` 只从 `created.value` 派生,**从不从 list 行派生**;`replayWithoutSecret` 处理「重放无明文」 |
| 生命周期清除 | `:152-159` | `onOpenChange(false)` → `created.value = null`,关闭即蒸发 |
| 唯一赋值点 | `:161-189` | 只有 create 响应能写 `created.value`,写完 `await loadList()` 刷新列表 —— **列表刷新不会覆盖明文,因为明文不在列表状态里** |
| 复制 | `:210-215` | `useCopyWithFallback().copy()`,`copied===true` 才弹成功 toast;`selectableRef` 绑到那个只读 input,剪贴板不可用时降级为「已选中,请手动复制」 |

守护它的断言是 `ShareDialog.spec.js:144-162`:创建后既断言 URL 里有明文,又断言**列表行文本里没有明文**。

**T-21 的等价形状**(AuthKey 面板):

```
authKeyOnce = ref('')                    // 唯一写入点:resetMailShareAuthKey 响应的 data.authKey
detail      = ref(null)                  // 详情永远不含 authKey(§3.1),所以刷新 detail 不会复活它
关闭抽屉 / 切换 shareId / 用户点「我已保存」 → authKeyOnce.value = ''
```

- **复制走 `useCopyWithFallback`**(`composables/useCopyWithFallback.js`),`selectableRef` 绑到只读 input。这是仓内既有能力,不要用裸 `navigator.clipboard`。
- **不要把 `authKeyOnce` 写进 sessionStorage / pinia / URL**。它是一次性明文,持久化就是把 AC-CAP-05「明文只出现一次」直接作废。
- 等价的守护断言:enable 拿到明文 → 触发一次详情刷新(mock `getMailShare` 返回不含 `authKey` 的 detail)→ 断言明文**仍在一次性区块里**(用户还没确认)且**不出现在任何详情字段里**;点「我已保存」后明文从 DOM 消失。

**是否抽 `OneShotSecret.vue` 供 T-22 复用?** 见 §11 迷雾 F1 —— 默认**内联**(约 15 行模板),不预抽。

---

## 6. 抽屉设计(impeccable 判定:Operate 模式)

### 6.1 基调:继承 T-20,不另起炉灶

这是登录态管理台的二级面板。impeccable 的 Operate 定义直接适用:**可扫读性 / 一致性 / 原生预期 > 表达欲**。frontend-design 那套「大胆美学方向 / 特色字体 / 渐变网格」在这里是反指标 —— 抽屉与它正下方的卡片列表必须看起来是同一个产品。

四条继承自 T-20 的硬约束(逐条已在 `index.vue` 落地,照抄即可):
1. **颜色只走 CSS 变量**:`--el-bg-color` / `--el-border-color` / `--light-border` / `--secondary-text-color` / `--regular-text-color` / `--extra-light-fill`。零裸 hex(否则 `.dark` 下必坏)。注意 `ShareDialog.vue:228-290` 里有一批裸 hex(`#b88230` / `#fdf6ec` …)—— **那是历史包袱,不要连它一起抄**。
2. **`<style lang="scss" scoped>`**,与 `index.vue:179` 同款(不是 less)。
3. **配额/计数列 `font-variant-numeric: tabular-nums`**(`index.vue:284-286`)。
4. **`@media (max-width: 767px)`**,与全仓 12 处约定同值。

### 6.2 容器:`el-drawer`,且它是仓内第一个

全仓零 `el-drawer` 使用(既有全是 `el-dialog`)。但 `unplugin-vue-components` + `ElementPlusResolver` 对任意 `el-*` 自动解析(`vite.config.js:44-46`,vitest 复用同一份 plugins),**无需注册、无需新依赖**。design.md:392 与任务书都写「抽屉」,采用它。

- **宽度**:`el-drawer` 把 `size` 原样当 CSS 宽度写进内联样式,所以 `size="min(560px, 100vw)"` 一行搞定响应式,**不需要 `window.innerWidth` 也不需要 resize 监听**(T-20 recon T10 明确警告过 `window.onresize =` 覆盖式赋值的既有隐患,不要再加第三个)。执行时请在浏览器里目视确认一次这个 CSS `min()` 生效。
- `direction="rtl"`,`:destroy-on-close="true"`(保证切换 shareId 时一次性明文与表单脏态一起蒸发)。
- **`el-drawer` teleport 到 body,`scoped` 样式够不到内部** —— 需要样式时用 `class="share-detail-drawer"` + `:deep()`,或干脆把版式做在自己的根 div 上。

### 6.3 三个面板的信息架构

```
ShareDetailDrawer
├─ 头部:名称 + 四态徽标(statusMeta)+ 类型徽标 + 只读态提示条
│     └─ [!isMutableStatus] data-test="detail-readonly" 一条说明:已过期/已销毁,仅供查阅
├─ ① 绑定邮箱(AC-ADMIN-02 / AC-BIND-*)
│     ├─ v-for bindings:mailbox(空 → bindingLabels 的 #accountId 回落)+ 移除按钮
│     ├─ 添加:accountList 分页选择器(排除已绑 accountId),≥50 禁用
│     └─ 每个动作**独立提交**,成功后重取 get
├─ ② 配置(AC-ADMIN-03)
│     ├─ name / remark / maxSessions(含「不限」)/ messageLimit(含「不限」)
│     ├─ otpExtractionEnabled / autoRefresh / refreshIntervalMs(min 3000)
│     ├─ showFullAddress —— 文案见 §7
│     └─ 单个「保存」按钮,提交**脏字段 diff**;`resetUsedSessions` 交互见 §6.4
└─ ③ 访问密钥(AC-ADMIN-05 / AC-AUTH-07/08)
      ├─ 状态:已启用 / 未启用(authKeyEnabled)
      ├─ 未启用 → [启用](V2 可能拒)
      ├─ 已启用 → [重置] [关闭],两者都要确认 + 明写「会踢掉所有已打开的访问」
      └─ 一次性明文区(§5),仅 enable/reset 响应带 authKey 时渲染
```

**只读态**(`!isMutableStatus(effectiveStatus)`):三个面板的**全部写控件 `disabled`**,读内容照常渲染(AC-ADMIN-09)。`ACCESS_LIMIT_REACHED` **算可写**(§0 ④)。

**不要做的**:①「保存并关闭」+「保存」两个按钮;② 表单级的乐观更新(响应就是新 detail,直接换掉即可,乐观更新只会在 V2 栅栏拒绝时留下一个骗人的界面);③ 抽屉里再嵌一个创建入口(T-22);④ 抽屉里放「复制分享链接」—— **`sec` 明文全仓不再可得**(`OWNER_ROW_COLUMNS` 不 SELECT),能拼出来的只有 `/s/<lid>` 半截链接,放上去等于给用户一个打不开的链接。

### 6.4 `resetUsedSessions` 确认交互(AC-EDGE-14)

触发条件(**前端只用它决定要不要问,不承担正确性** —— SQL 的 `CASE WHEN max_sessions IS NULL` 才是真闸门):
`detail.maxSessions === null` **且** 本次 diff 里 `maxSessions` 是一个有限值。

三路选择,`ElMessageBox.confirm` + `distinguishCancelAndClose: true`(element-plus ^2.13,支持;它把 X/ESC 的 reject 值从 `'cancel'` 变成 `'close'`,`ShareDialog.vue:202-207` 已经在同时判这两个值了):

| 用户动作 | reject/resolve | 行为 |
|---|---|---|
| 确认按钮「清零并保存」 | resolve | patch **不带** `resetUsedSessions`(缺省即 true),或显式 `true` |
| 取消按钮「保留计数并保存」 | reject `'cancel'` | patch 带 `resetUsedSessions: false` |
| X / ESC | reject `'close'` | **不发请求**,回到表单 |

文案必须说清后果:保留计数**可能让分享立刻变成 `ACCESS_LIMIT_REACHED`**(`share-integration.spec.js:1322-1327` 实测)。

**更懒的替代**(留给执行者/用户裁决,§11 F2):表单里放一个只在该迁移时出现的复选框「重置已用会话计数(默认开)」,零弹窗、更好测。任务书字面写的是「确认交互」,所以默认取弹窗方案。

### 6.5 无障碍与交互底线(ui-ux-pro-max §1/§2/§8)

- 移除绑定、撤销、删除、重置/关闭 AuthKey **五个破坏性动作全部二次确认**(`confirmation-dialogs`);删除与撤销用 `type="danger"` 且与常规按钮**视觉分离**(`destructive-emphasis`)。
- 图标按钮必须带 `aria-label` / 文字(`aria-labels`);触控目标 ≥44px(`el-button` 默认 32px,移动端断点下用 `size="large"` 或加 padding)。
- 异步按钮 `:loading` + `:disabled`,防重复提交(`loading-buttons`);抽屉在有未保存改动时关闭要确认(`sheet-dismiss-confirm`)—— 这条**可以省**,理由:配置区是单个「保存」按钮的显式提交模型,脏态丢失的成本是重填几个字段,加一个确认弹窗换来的是每次关抽屉都被打断。**登记为有意省略。**
- 四态徽标颜色 + 文案并存,并写进 `data-status`(`color-not-only`),与列表页同款。

---

## 7. 掩码开关文案(AC-MAIL-08 / Decision 14)

design.md:409 原文:**「Owner 管理页对该开关的文案按『显示完整地址(展示选项)』呈现,不得暗示保密效果。」** 上位裁决是 Decision 14(`design.md:103`):掩码是**展示偏好**,不是安全/隐私边界 —— 邮件正文/主题里出现的地址**不会被改写**,发件人**默认不掩码**。

| 键 | zh | en |
|---|---|---|
| `shareShowFullAddress` | 显示完整地址(展示选项) | Show full address (display option) |
| `shareShowFullAddressHint` | 只影响分享页上邮箱地址的显示方式。关闭它不会隐藏邮件正文、主题或发件人里出现的地址。 | Only changes how the mailbox address is displayed on the share page. It does not remove addresses that appear in the mail body, subject, or sender. |

**禁用词表**(zh / en 两侧都禁):保密 · 隐藏 · 加密 · 安全 · 私密 · 脱敏(对 Owner 面)· 保护 · secret · hide · hidden · private · privacy · secure · protect · mask(作动词承诺时)。

**测试的现实困境与处置**:i18n 是 T-28/T-29 单写者,这两个键在 T-29 落盘前会渲染成键名本身,所以**任何针对文案的断言现在都是空转**。处置(裁决):
1. 组件里用 `data-test="mask-toggle-label"` 包住 `$t('shareShowFullAddress')`,spec 断言**用的是这个键**(`text()` 现在等于键名,落盘后等于文案)。
2. 再写一条 **sleeper 断言**:`expect(label).not.toMatch(/保密|隐藏|加密|安全|私密|secret|hide|private|protect/i)` —— 今天必绿(渲染的是键名),T-29 落盘后自动变成真闸门。**在 spec 里写一行注释说明它今天是空转的**,不要假装它现在就在守护。
3. exec note 原样带上这张表,并在 T-29 的清单里点名「这两个键的文案受 Decision 14 约束,改词前先读 design.md:409」。

**同一条诚实性纪律也适用于 AuthKey**(§3.4 末段)与移除绑定(会连带销毁整个分享)。

---

## 8. T-21.1 红灯清单

主文件 `views/share-admin/ShareDetailDrawer.spec.js`(新建)。测试基建照抄 `index.spec.js:1-96`(pinia + i18n + `vi.mock('@/request/mail-share.js', importOriginal)` 展开 + `vi.mock('@/router')`),stub 表在 `:36-55` 基础上补 `el-drawer` / `el-button` / `el-switch` / `el-input-number` / `el-input` / `el-checkbox`;`element-plus` 的 `ElMessage`/`ElMessageBox` 照 `ShareDialog.spec.js:34-41` mock。

| # | 用例 | 关键断言 | 覆盖 |
|---|---|---|---|
| **D1** | 打开抽屉取详情 | `getMailShare` 以 `shareId` 调用恰 1 次;绑定清单**全部** mailbox 可见;头部徽标 `data-status` = `effectiveStatus` 且文案走 `statusMeta` | AC-ADMIN-02 |
| **D2** | `SHARE_NOT_FOUND`(他人/已删) | 抽屉关闭 + emit `changed`;不渲染半截表单 | AC-ADMIN-02 |
| **D3** | 详情里没有 authKey | mock detail 不含该键 → AuthKey 区显示状态但**无一次性明文块** | AC-CAP-05 |
| **B1** | 加邮箱 | `updateMailShareBindings` 实参 `{shareId, add:[accountId]}` —— 断言是 **accountId** | AC-BIND-02 |
| **B2** | 移邮箱 | 实参 `{shareId, remove:[bindingId]}` —— 断言是 **bindingId** 且 ≠ 该行 accountId(两值在 fixture 里刻意取不同数) | AC-BIND-12 |
| **B3** | 移除要确认 | 取消 → 零请求;确认 → 一次请求 | ui-ux 破坏性动作 |
| **B4** | **响应无 mailbox → 必须重取** | bindings resolve `{bindings:[{bindingId,accountId}]}`(无 mailbox)→ 断言 `getMailShare` **再次被调用**,且 DOM 里不出现空邮箱项 | §0 ③ |
| **B5** | 删空最后一个 → 整体 REVOKED | 响应 `status:'REVOKED'` → 抽屉转只读 + emit `changed` | AC-BIND-04 |
| **B6** | `SHARE_BINDING_CONFLICT` | 重取 detail;**不以同一份 remove 原样重试**(断言 bindings 只被调 1 次) | `:1232-1237` |
| **B7** | 50 上限 | `bindings.length === 50` → 添加控件 disabled,零请求 | AC-CAP-13 |
| **C1** | ★**只发脏字段** | 只改 `name` → `updateMailShare` body **恰为** `{shareId, name}`;显式断言 `not.toHaveProperty('messageLimit')` 与 `('maxSessions')`(fixture 里这两个都是有限值) | §0 ② · AC-LIFE-11 |
| **C2** | 三态可分:清空 | 把 maxSessions 选成「不限」→ body **含** `maxSessions: null`(不是缺键、不是 `0`、不是 `''`) | `hasKey` 语义 |
| **C3** | 首次设限 → 确认 | `detail.maxSessions === null` + 设为 5 → 弹确认;「清零」→ 无 `resetUsedSessions` 或 `true`;「保留计数」→ `false`;**X 关闭 → 零请求** | AC-EDGE-14 |
| **C4** | 已有限值再改 → 不弹 | `detail.maxSessions === 5` → 改成 8 不弹确认,直接提交 | AC-EDGE-14 |
| **C5** | `refreshIntervalMs` 下界 | 输 2999 → 前端拦下,零请求(与后端 3000 同值) | `toPatchInterval` |
| **C6** | 保存成功消费响应 | update resolve 一个新 detail → 抽屉字段更新,且**不再打一次 `getMailShare`** | `:1289` |
| **K1** | enable 一次性明文 | `resetMailShareAuthKey({shareId, action:'enable'})`;响应 `authKey` → `[data-test="authkey-once"]` 内可见明文 | AC-ADMIN-05 |
| **K2** | ★明文不复活 | K1 之后触发一次详情刷新(detail 无 authKey)→ 明文仍在一次性块内、**不出现在任何详情字段**;点「我已保存」后明文从 DOM 完全消失 | AC-CAP-05(镜像 `ShareDialog.spec.js:144-162`) |
| **K3** | reset / disable 要确认且警示会话失效 | 取消 → 零请求;确认文案节点存在(用 `ElMessageBox.confirm` 的调用实参断言,不断言译文) | AC-AUTH-07/08 |
| **K4** | disable 无明文 | 响应无 `authKey` 键 → 一次性块不渲染;状态切「未启用」 | `:1368-1369` |
| **K5** | enable 被拒 | reject `SHARE_INVALID_CONFIG` → 内联提示存在,面板不清空,`authKeyEnabled` 仍为 false | V2 栅栏 |
| **S1** | ★只读态 | `effectiveStatus:'EXPIRED'`(与 `'REVOKED'`)→ 所有写控件 `disabled`,任何点击零请求;读内容仍渲染 | AC-ADMIN-09 |
| **S2** | ★触顶态**可写** | `effectiveStatus:'ACCESS_LIMIT_REACHED'` → 写控件**可用**(这是用户来调配额的时刻) | AC-ADMIN-04 |
| **M1** | 掩码文案 | 标签用 `shareShowFullAddress` 键;sleeper 禁用词断言(§7) | AC-MAIL-08 |
| **M2** | 掩码开关是普通配置项 | 它与其它 flag 一样走 diff patch,不单独发请求 | AC-ADMIN-03 |

`ShareRowActions.spec.js`(新建,3 条):撤销走 `revokeMailShare(shareId)` 且需确认 · 删除走 `deleteMailShare(shareId)` 且需确认且文案与撤销不同 · 非活跃行上撤销按钮不渲染而删除按钮仍在(REVOKED 行不能再撤销,但可以删除:`delete` 的谓词**不含** status,`:1295-1296`)。

`index.spec.js`:§4.3 的翻面 1 条 + 接线 1 条。

### 必须继续绿的既有断言

- `views/share-admin/index.spec.js` 除 `:243-252` 外**全部**(其中 `:275-281` 的源码文本断言会读 `index.vue`,锚点补丁不得引入 `window.onresize`)。
- `request/mail-share.spec.js`(T-20 已扩到 6 条)—— T-21 request 层零改动,天然全绿。
- `views/email/ShareDialog.spec.js` / `ShareIndicator.spec.js` —— T-21 不碰 `views/email/**`(那是 T-23)。
- `views/share/share-chunk.spec.js` —— 它跑**真实 vite build**,任何新组件的 import 写错(比如从抽屉 import 了访客域文件)会让它以「构建失败」的形态红。**注意:T-20 半成品期间它就红过一次**(perm.js 引了尚不存在的 index.vue)。抽屉**禁止** import `views/share/**` / `request/share.js` / `composables/useSharePolling.js`。
- `init/init.spec.js` · `router/index.spec.js` —— T-21 不碰这两个文件。

---

## 9. 文件白名单

### 9.1 允许写

`views/share-admin/ShareDetailDrawer.vue`(新)· `ShareRowActions.vue`(新)· `ShareDetailDrawer.spec.js`(新)· `ShareRowActions.spec.js`(新)· `index.vue`(**≤10 行锚点**,§4.2)· `index.spec.js`(**翻面 1 + 新增 1**,§4.3)· `status.js`(**+1 纯函数**,§2.3)。

### 9.2 明确不碰

| 文件 | 理由 |
|---|---|
| `i18n/zh.js` · `en.js` | T-28/T-29 单写者(tasks.md:27)。T-21 只在 §10 登记 |
| `router/index.js` | T-20 已实现 0 行改动;`beforeEach` 访客白名单属 W5 |
| `perm/perm.js` | T-20 刚落 `share:manage`,T-21 无理由再改 |
| `request/mail-share.js` · `.spec.js` | 五个函数 T-20 已备齐(§2.2) |
| `views/share/**` · `request/share.js` · `composables/useSharePolling.js` | 访客域 W5;两域网络层不共享(design.md:135)。**从抽屉 import 会打红 share-chunk 守护** |
| `views/email/ShareDialog.vue` · `ShareIndicator.vue` · `build-share-url.js` | T-23 |
| `axios/index.js` | 全局拦截器;403/401 分流是前提不是改造对象 |
| `layout/aside/index.vue` | T-20 已加入口 |
| `mail-worker/**` | 后端契约 W3 已封口 |
| `tests/e2e/**` | W6 |

---

## 10. i18n:只登记,不落盘(交 T-29)

### 10.1 可复用的既有/已登记键

已在 `zh.js`/`en.js`(逐个核对过):`shareManage` `shareMailbox` `shareExpiresAt` `shareCreatedAt` `shareLastAccess` `shareRevoke` `shareRevokeConfirm` `shareRevokeSuccess` `shareStatusActive/Expired/Revoked` `shareCopyLink`,以及通用键 `confirm`(`en.js:195`)`cancel`(`:196`)`delete`(`:27`)`save`(`:28`)`copy`(`:106`)。**通用键直接用,不要再造 `shareDelete`/`shareConfigSave`。**「详情」没有现成通用键,需新增。
T-20 已登记待落盘:`shareStatusLimitReached` `shareTypeSingle` `shareTypeMulti` `shareBoundMailboxes` `shareSessionQuota` `shareQuotaUnlimited` `shareFilterStatus` `shareFilterAll` `shareAdminForbidden`。

### 10.2 T-21 新增键(**40 个 × 2 语言**;「保存 / 删除 / 确认 / 取消 / 复制」复用 §10.1 通用键,不重复造)

| 键 | zh | en |
|---|---|---|
| `shareDetailTitle` | 分享详情 | Share details |
| `shareDetailLoadError` | 详情加载失败,请刷新重试。 | Could not load the details. Refresh and try again. |
| `shareDetailReadonly` | 这个分享已不可修改(已过期或已销毁),仅供查阅。 | This share can no longer be changed (expired or revoked). View only. |
| `shareDetailGone` | 这个分享已不存在,已为你刷新列表。 | This share no longer exists. The list has been refreshed. |
| `shareBindingAdd` | 添加邮箱 | Add mailbox |
| `shareBindingRemove` | 移除 | Remove |
| `shareBindingRemoveConfirm` | 移除后,这个邮箱的邮件会立刻从分享页消失。 | Once removed, mail from this mailbox disappears from the share page immediately. |
| `shareBindingRemoveLastConfirm` | 这是最后一个邮箱,移除它会同时销毁整个分享。 | This is the last mailbox. Removing it destroys the whole share. |
| `shareBindingLimitReached` | 一个分享最多绑定 50 个邮箱。 | A share can bind at most 50 mailboxes. |
| `shareBindingConflict` | 绑定关系刚被改动过,已为你刷新,请重新确认。 | The bindings just changed. They have been refreshed—please review and try again. |
| `shareBindingLoadMore` | 加载更多邮箱 | Load more mailboxes |
| `shareBindingNoneAvailable` | 没有可添加的邮箱了。 | No more mailboxes to add. |
| `shareConfigSaved` | 已保存 | Saved |
| `shareConfigNoChange` | 没有需要保存的改动。 | Nothing to save. |
| `shareMaxSessions` | 会话上限 | Session limit |
| `shareMessageLimit` | 邮件条数上限 | Message limit |
| `shareOtpExtraction` | 提取验证码 | Extract verification codes |
| `shareAutoRefresh` | 自动刷新 | Auto refresh |
| `shareRefreshInterval` | 刷新间隔(毫秒,最小 3000) | Refresh interval (ms, min 3000) |
| `shareResetUsedSessionsTitle` | 是否把已用会话数清零? | Reset the used-session count? |
| `shareResetUsedSessionsHint` | 这是这个分享第一次设置会话上限。清零后按新上限重新计数;保留计数可能让它立刻触顶。 | This is the first session limit for this share. Resetting starts the count over; keeping it may hit the limit immediately. |
| `shareResetUsedSessionsYes` | 清零并保存 | Reset and save |
| `shareResetUsedSessionsNo` | 保留计数并保存 | Keep the count and save |
| `shareShowFullAddress` | 显示完整地址(展示选项) | Show full address (display option) |
| `shareShowFullAddressHint` | 只影响分享页上邮箱地址的显示方式。关闭它不会隐藏邮件正文、主题或发件人里出现的地址。 | Only changes how the mailbox address is displayed on the share page. It does not remove addresses that appear in the mail body, subject, or sender. |
| `shareAuthKey` | 访问密钥 | Access key |
| `shareAuthKeyOn` | 已启用 | Enabled |
| `shareAuthKeyOff` | 未启用 | Not enabled |
| `shareAuthKeyEnable` | 启用 | Enable |
| `shareAuthKeyReset` | 重置 | Reset |
| `shareAuthKeyDisable` | 关闭 | Turn off |
| `shareAuthKeyEnableHint` | 启用后,新的访问需要这把密钥;已经打开的访问不受影响。 | New visits will need this key. Visits that are already open are not affected. |
| `shareAuthKeyKillConfirm` | 这会立刻让所有已打开的访问失效,访客需要用新密钥重新打开。 | This immediately ends every open visit. Visitors must reopen with the new key. |
| `shareAuthKeyDisableConfirm` | 关闭后不再需要密钥,同时立刻让所有已打开的访问失效。 | Turning it off stops asking for a key and immediately ends every open visit. |
| `shareAuthKeyOnce` | 新密钥只显示这一次,关闭后无法再查看。请立即复制并妥善保存。 | This is the only time the new key is shown. Copy it now; it cannot be retrieved later. |
| `shareAuthKeySaved` | 我已保存 | I saved it |
| `shareAuthKeyFailed` | 无法完成:可能是这项能力尚未开放,或分享状态刚刚变化。请刷新后重试。 | Could not complete this: the capability may not be available yet, or the share just changed. Refresh and try again. |
| `shareDeleteConfirm` | 彻底删除这个分享及其全部记录?此操作不可恢复,且与「销毁」不同——删除后列表里也不再保留审计记录。 | Permanently delete this share and all of its records? This cannot be undone, and unlike Destroy it also removes the audit row from the list. |
| `shareDeleteSuccess` | 已删除 | Deleted |
| `shareDetail` | 详情 | Details |

**W4 期间的既定后果**:落盘前页面渲染键名。spec **只断言 `data-test` / 请求实参 / 数值**,不断言这些文案(§7 的 sleeper 断言除外,且已标注它今天空转)。

---

## 11. 迷雾清单(需要用户裁决的,恰 3 条)

> 其余已由本侦察裁决:diff patch 而非整表单 · bindings 成功后重取 get · 每次一个绑定动作 · 只读态按 `isMutableStatus` 且触顶可写 · 不做错误码 i18n 映射 · el-drawer + `min(560px,100vw)` · 一次性明文不持久化 · 不放「复制分享链接」 · 抽屉关闭不做脏态确认。

**F1 · 一次性密钥展示要不要抽成 `OneShotSecret.vue`?**
T-22 的任务书明写「成功后一次性展示 `shareUrl`(+`authKey`)」,所以这是一个**已知的第二消费者**,不是臆测。抽出来 T-22 直接复用;不抽,W4 结束时同一个模式会有三份(ShareDialog 一份、T-21 一份、T-22 一份)。
**我的建议:不抽(内联)。** 理由:模板约 15 行 + 一个 ref,抽成组件要设计 props/emits 契约,而 T-21 与 T-22 并行 —— T-22 起跑时 T-21 可能还没合入,它照样会自己写一份,于是既有了组件又有了副本。T-22 起跑时若 T-21 已合入,把它抽出来是一次 3 行的移动。ponytail:later can scaffold for itself。
**需要用户点头的原因**:这是 W4 内跨任务的复用取舍,不是 T-21 一个任务能单方面决定的。

**F2 · `resetUsedSessions` 用弹窗还是内联复选框?**
任务书写「含 `resetUsedSessions` 确认交互」,字面指向弹窗;§6.4 已给出弹窗的三路方案。但内联复选框(仅在 NULL→有限值时出现、默认勾选)零弹窗、更好测、少一个 `distinguishCancelAndClose` 的行为依赖。
**我的建议:按字面走弹窗。** 这是一个会改变历史计数的动作,弹窗的打断成本换来一次明确的知情选择;而且它只在**每个分享一辈子的第一次**出现。
**需要用户点头的原因**:两者对 AC-EDGE-14 都成立,差别是交互口味 + 一条用例形状。

**F3 · `index.spec.js:243-252` 的翻面要不要单独立一条记录?**
§4.3 已裁决「翻面不删除」。但这是本项目「单邮箱旧断言只扩不改写」纪律下的**唯一一次改写既有断言**,而且改的是 T-20 刚合入的用例。
**我的建议:翻面,并在 exec note 与 review 里各留一条显式记录**(原文引用被改的断言 + T-20 recon §6.2 的交接说明作为依据)。
**需要用户点头的原因**:改写既有断言在本项目是需要上报的动作,不该由执行者静默完成。

---

## 12. 风险与陷阱

| # | 风险 | 处置 / 防线 |
|---|---|---|
| **T1** | ★整表单回传触 V2 栅栏,用户「改个名字都报错」 | §0 ② · 用例 **C1** |
| **T2** | ★add 传 bindingId / remove 传 accountId | §3.3 · 用例 **B1/B2**(fixture 里两值刻意不同) |
| **T3** | ★bindings 响应无 mailbox,灌回状态后地址集体变空 | §0 ③ · 用例 **B4** |
| **T4** | ★把 `ACCESS_LIMIT_REACHED` 也置灰 | §0 ④ · 用例 **S2** |
| **T5** | ★`index.spec.js:243-252` 静默变红或被删 | §4.3 · 用例翻面 + exec note 登记 |
| **T6** | 「不限」发成 `0` / `''` / 缺键 | `toPatchCount` 把 `0` 当非法(`<1` 抛错)、`''` 当 null、缺键当「不改」。三者语义全不同 · 用例 **C2** |
| **T7** | `el-input-number` 清空给 `null` → `refreshIntervalMs` 变 `Number(null)=0` → `SHARE_INVALID_CONFIG` | 空值时不把该键放进 patch · 用例 **C5** |
| **T8** | `SHARE_INVALID_CONFIG` 同码三义(值域/迁移非法/V2 未开)被当成单一原因写死文案 | §3.4 · 文案给两种可能 + 刷新出口 · 用例 **K5** |
| **T9** | 一次性明文被 detail 刷新冲掉,或反过来被持久化 | §5 · 用例 **K2** |
| **T10** | `reset`/`disable` 会踢会话而文案没说;或 `enable` 假称会踢 | §3.4 · 用例 **K3** |
| **T11** | 从抽屉 import 访客域文件 → `share-chunk.spec.js` 以构建失败形态红 | §8 末 · 禁 import 清单 |
| **T12** | `vi.mock('@/request/mail-share.js')` 不展开 `importOriginal` → `isShareForbidden` 变 undefined | 照 `index.spec.js:17-23` |
| **T13** | 抽屉里裸 hex(顺手抄了 `ShareDialog.vue:228-290`)→ 暗色主题坏 | §6.1 · 只走 CSS 变量 |
| **T14** | `el-drawer` teleport 到 body,scoped 样式够不到 | §6.2 · `:deep()` 或把版式做在自己的根 div |
| **T15** | 账号选择器只拉到前 30 个(`size` 硬顶 30),多邮箱用户找不到自己的邮箱 | §3.3 · 必须做「加载更多」游标翻页,不能一次拉完就算 |
| **T16** | 删除页内最后一行后停在空白页 | `fetchList()` 不回退 `page`。**接受**(与 reg-key 等既有页同款行为),或由 T-21 在锚点里加一行 —— 会突破 10 行预算,**建议不加,登记为已知瑕疵** |
| **T17** | 偷偷改 i18n 文件 | §9.2 |
| **T18** | 顺手把 T-22 的「新建」按钮做了 | §4.4 · W4 并行槽 |
| **T19** | 基于 T-20 的**记忆**而不是**当前文件**写代码 | T-20 尚未提交、仍可能被 review 改动。执行前 `md5sum` 比对本文件表头的四个哈希 |

---

## 13. 验证命令与基线

```bash
# 定点(红 → 绿)
pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareDetailDrawer.spec.js --no-cache
pnpm --dir mail-vue exec vitest run src/views/share-admin/ShareRowActions.spec.js --no-cache

# 邻接回归(受锚点补丁直接波及)
pnpm --dir mail-vue exec vitest run src/views/share-admin/index.spec.js \
    src/request/mail-share.spec.js src/views/email/ShareDialog.spec.js \
    src/views/email/ShareIndicator.spec.js src/views/share/share-chunk.spec.js

# 全量(基线 18 文件 / 113 用例,已实测 EXIT=0,含 T-20 未提交改动)
pnpm --dir mail-vue test
```

跨栈基线:worker 18 文件 / 619 用例 · vue **18 / 113** · E2E 13。T-21 是纯前端任务,worker 与 E2E **不跑**,exec note 里按惯例标 `unverified`,不假称绿。

---

## 14. 执行前自检清单

- [ ] 四个哈希与表头一致(T-20 未被 review 改动);不一致就重读 `index.vue` / `status.js` / `index.spec.js` / `request/mail-share.js`
- [ ] §11 三条迷雾已取得裁决(OneShotSecret 抽不抽 / 弹窗还是复选框 / 翻面登记方式)
- [ ] `index.vue` 改动 **≤10 行**,且只有 §4.2 的四处;`data-share-id` / 既有 `data-test` 一个没动
- [ ] `index.spec.js:243-252` **翻面而非删除**,exec note 原文引用被改断言
- [ ] `request/mail-share.js` 改动 **0 行**;抽屉只用 §2.2 的六个函数 + `isShareForbidden`
- [ ] 配置保存发的是 **diff**;C1 用例显式断言未变字段不在 body 里
- [ ] 「不限」发 **显式 `null`**;空 `refreshIntervalMs` **不进 patch**
- [ ] bindings:add=accountId / remove=bindingId;成功后**重取 `getMailShare`**
- [ ] 删空最后一个绑定 → 抽屉转只读 + 刷列表
- [ ] `isMutableStatus` 落 `status.js`(不在组件里),且 `ACCESS_LIMIT_REACHED` **可写**
- [ ] AuthKey 明文只存局部 ref;关抽屉/切 shareId/点「我已保存」即蒸发;不进 storage/pinia/URL
- [ ] `reset`/`disable` 确认文案写明「立刻踢掉所有已打开的访问」;`enable` **不**这么写
- [ ] 掩码标签用 `shareShowFullAddress`,禁用词表已核;sleeper 断言带注释说明今天空转
- [ ] 五个破坏性动作全部二次确认;删除与撤销文案不同
- [ ] 零裸 hex;`<style lang="scss" scoped>`;`@media (max-width: 767px)`;无 `window.onresize`
- [ ] 抽屉不 import `views/share/**` / `request/share.js` / `useSharePolling.js`
- [ ] `zh.js` / `en.js` 一字未改;§10.2 的键表原样进 exec note
- [ ] 定点红→绿;邻接 5 份全绿;`pnpm --dir mail-vue test` 与 18/113 比只增不减

---

## 15. 参考锚点索引

```
契约   docs/specs/mailbox-share-capability/requirements.md:156(AC-ADMIN-02)、:157(AC-ADMIN-03)
       :158(AC-ADMIN-04)、:159(AC-ADMIN-05)、:161(AC-ADMIN-07)、:163(AC-ADMIN-09)
       :67(AC-CAP-13)、:87(AC-BIND-12)、:112(AC-AUTH-07)、:113(AC-AUTH-08)、:222(AC-EDGE-14)
       design.md:303(update 契约行)、:311-329(AuthKey 状态机)、:388-393(管理模块 / 抽屉规格)
       :407-409(★掩码 = 展示偏好,Owner 文案约束)、:103(Decision 14)、:664-668(端点 ↔ 前端映射)
       tasks.md:27(i18n 单写者)、:460-462(T-21)、:522-523(W4 并行说明)
前端   mail-vue/src/views/share-admin/index.vue:38-45(行钩子)、:46-54(card-head)、:127-160(fetchList)
       :162-174(筛选/翻页/刷新)、:179-356(scss 令牌与 767 断点)
       mail-vue/src/views/share-admin/status.js:10-62(SSOT 六个导出)
       mail-vue/src/views/share-admin/index.spec.js:1-96(测试基建)、★:243-252(交接闸门用例)
       :255-273(路由 perm)、:275-281(源码文本断言)
       mail-vue/src/request/mail-share.js:49-91(list 分页 + 5 新端点 + isShareForbidden)
       mail-vue/src/views/email/ShareDialog.vue:25-39(★一次性展示模板)、:109-126(派生)
       :152-159(关闭即清)、:161-189(唯一赋值点)、:210-215(复制)
       mail-vue/src/views/email/ShareDialog.spec.js:34-41(ElMessageBox mock)、:144-162(★明文不复活)
       mail-vue/src/composables/useCopyWithFallback.js(copy / selectableRef / 手选降级)
       mail-vue/src/request/account.js:3(accountList,游标 + size 上限 30)
       mail-vue/src/layout/account/index.vue:400-415(游标翻页范式)
       mail-vue/src/axios/index.js:39-48(body-403)、:59-68(其它码原样 toast)
       mail-vue/vite.config.js:44-46(ElementPlusResolver → el-drawer 自动解析)
后端   mail-worker/src/api/mail-share-api.js:35(get)、:40(update)、:46(delete)、:53(resetAuthKey)、:59(bindings)
       mail-worker/src/service/mail-share-service.js:130-136(hasKey/hasValue 三态语义)
       :371-378(OWNER_ROW_COLUMNS,凭据不 SELECT)、:424-456(projectOwnerRow 字段真源)
       :478-484(★loadBindings 无 mailbox)、:491-509(loadBindingSummaries 有 mailbox)
       :514-526(loadOwnerDetail,读不带 status 谓词)、:902-928(toPatch* 值域)
       :935-944(★UPDATE_FIELDS 白名单)、:946-955(hasOwnProperty 在场判据)
       :963-971(★assertUpdatePatch 栅栏判据)、:976-986(prepareUpdate + 清零 CASE)
       :1025-1034(★loadMutableShare:写端点的 ACTIVE 谓词)、:1043-1057(AuthKey 状态机)
       :1083-1108(assertBindingChange:错误码顺序与 50 上限)、:1186-1264(updateBindings)
       :1267-1290(get / update)、:1292-1323(delete,谓词不含 status)、:1331-1370(resetAuthKey)
       :15(SHARE_BINDING_LIMIT=50)、:11(MIN_REFRESH_INTERVAL_MS=3000)、:31-37(SHARE_V2_INTENT)
       :67-82(★isCapabilityV2Enabled / assertCapabilityV2 —— 前端不可见)
       mail-worker/src/model/share-result.js(裸错误码,不过 i18n)
       mail-worker/src/service/account-service.js:107-133(account/list 游标契约)
测试   mail-worker/test/share-integration.spec.js:1087-1113(bindings 增删 HTTP 形状)
       :1117-1132(★删空即撤销)、:1298-1328(★resetUsedSessions 双态)
       :1389-1418(reset 踢会话)、:1420-1456(★enable 不踢 / disable 无明文)、:1458-1473(明文不外泄)
前锋   .agent-workspace/.archive/2026-08-24/mailbox-share-capability/recon-t20-share-admin.md
       §6.2(T-20↔T-21 边界)、§10(i18n 登记体例)、§12-T10(window.onresize 隐患)
```
