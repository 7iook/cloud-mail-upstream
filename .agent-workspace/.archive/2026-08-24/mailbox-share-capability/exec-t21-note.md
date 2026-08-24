# Exec note · T-21 详情抽屉 + 行操作(W4 第二棒)

| 字段 | 值 |
|---|---|
| 范围 | T-21 / T-21.1,`docs/specs/mailbox-share-capability/tasks.md:460-462` |
| 分支 | `cursor/mailbox-share-capability-dcb6`,起点 HEAD `c5d6bbd`(T-20 APPROVED 在 `672da73`) |
| 执行日期 | 2026-08-24 |
| 依据 | `recon-t21-drawer.md`(权威)+ `prompt.t21.exec.txt` |
| 提交状态 | **未提交**。本任务不 commit / push / stash / 切分支 |
| 已读技能 | frontend-design · impeccable · ui-ux-pro-max · ponytail(lite) |

---

## 0. 快照校验(执行前自检第 1 项)

recon 表头四个哈希里 **`index.vue` 对不上**:recon 记 `af823d25…`,实体是 `3fad53e14a4ab0a6172eb8cd5d99353f`。
原因是 T-20 在 review 阶段又改过一轮(`PENDING_COPY` 从 9 个键扩到 10 个,多了 `shareRefresh`;`.header-actions` 里多了一个原生 `.icon-button` 刷新键)。
**处置**:按 recon §12-T19 的要求重读了 `index.vue` 全文再动手,没有基于 recon 的行号记忆写代码。其余三个哈希(`status.js` `576036cb…` · `index.spec.js` `7751a505…` · `request/mail-share.js` `4621ee26…`)与 recon 一致。

---

## 1. 文件清单

### 新建

| 文件 | 行数 | 说明 |
|---|---|---|
| `mail-vue/src/views/share-admin/ShareDetailDrawer.vue` | 1041 | 抽屉主体:头部审计字段 + 绑定面板 + 配置面板 + AuthKey 面板 |
| `mail-vue/src/views/share-admin/ShareRowActions.vue` | 133 | 行三动作(详情 / 销毁 / 删除)+ 两次确认 |
| `mail-vue/src/views/share-admin/ShareDetailDrawer.spec.js` | 789 | 33 例 |
| `mail-vue/src/views/share-admin/ShareRowActions.spec.js` | 138 | 6 例 |

### 补丁

| 文件 | 改动 | 预算 |
|---|---|---|
| `mail-vue/src/views/share-admin/index.vue` | **+7 / -0** | ≤10 ✓ |
| `mail-vue/src/views/share-admin/index.spec.js` | 翻面 1 + 新增 1 + stub 表扩充 | ✓ |
| `mail-vue/src/views/share-admin/status.js` | **+8**(`isMutableStatus` 一个纯函数 + 注释) | ✓ |

### 0 行改动(核实)

`request/mail-share.js` · `request/mail-share.spec.js` · `perm/perm.js` · `router/index.js` · `i18n/zh.js` · `i18n/en.js` · `axios/index.js` · `layout/aside/index.vue` · `views/share/**` · `views/email/**` · `mail-worker/**` · `tests/e2e/**`。
`git status` 只有三个 M(上表)+ 四个新文件;**没有任何 FORBIDDEN 文件出现在 diff 里**。

---

## 2. ★被翻面的既有断言(F3 · 必须登记)

这是全 T-21 唯一一处改写既有断言的动作,依据是 recon §4.3 与 T-20 recon §6.2(T-20 为 T-21 预置的交接闸门,不是回归)。**翻面,不删除。**

**改之前**(`views/share-admin/index.spec.js:243-252`,原文引用):

```js
it('leaves every row action to T-21: rows carry hooks, not buttons', async () => {
    listMailShares.mockResolvedValue({ list: [sampleShare()], total: 1 })
    const wrapper = mountPage()
    await flushPromises()

    const row = wrapper.get('[data-test="share-row"]')
    expect(row.attributes('data-share-id')).toBe('7')
    expect(row.findAll('button')).toHaveLength(0)
    expect(row.findAll('[data-test="revoke-share"]')).toHaveLength(0)
})
```

**改之后**(用例名与断言都换,`data-share-id` 守卫保留并加强):

```js
it('hands row actions to the T-21 drawer without losing the list hooks', async () => {
    const row = wrapper.get('[data-test="share-row"]')
    expect(row.attributes('data-share-id')).toBe('7')
    expect(row.attributes('data-status')).toBe('ACTIVE')
    expect(row.find('[data-test="row-open-detail"]').exists()).toBe(true)
    expect(row.find('[data-test="row-revoke"]').exists()).toBe(true)
    expect(row.find('[data-test="row-delete"]').exists()).toBe(true)
    expect(row.get('[data-test="share-name"]').text()).toBe('front desk')
})
```

被删掉的只有 `toHaveLength(0)` 那两条(它们的语义就是「T-21 还没来」),`data-share-id` 守卫**变强了**(顺带钉住 `data-status` 与卡片标题)。
另加一条接线用例:`opens the detail drawer for the clicked row and nothing else` —— 点「详情」→ `getMailShare(7)` 恰一次,且列表初次渲染时 `getMailShare` **零调用**。

---

## 3. 红 → 绿

### 红(实现文件尚不存在)

```
pnpm --dir mail-vue exec vitest run \
  src/views/share-admin/ShareDetailDrawer.spec.js \
  src/views/share-admin/ShareRowActions.spec.js \
  src/views/share-admin/index.spec.js --no-cache
→ Test Files 3 failed (3) · Tests 2 failed | 13 passed (15)
```

- `ShareDetailDrawer.spec.js` / `ShareRowActions.spec.js`:collect 阶段整份红(`Failed to resolve import './ShareDetailDrawer.vue'` / `'./ShareRowActions.vue'`)。
- `index.spec.js`:翻面那条 + 新接线那条各红一次(`Unable to get [data-test="row-open-detail"]`)。

### 绿

```
定点四份:  Test Files 4 passed (4) · Tests 60 passed (60)
全量:      Test Files 20 passed (20) · Tests 153 passed (153)
share-chunk(真实 vite build): Test Files 1 passed (1) · Tests 1 passed (1)
```

| 基线 | T-20 交接时 | T-21 后 | 增量 |
|---|---|---|---|
| mail-vue 文件 | 18 | **20** | +2 |
| mail-vue 用例 | 113 | **153** | **+40** |

+40 = 抽屉 33 + 行操作 6 + `index.spec.js` 新增 1(翻面那条是改写不是新增)。
既有 112 条**一条没减**:`ShareDialog.spec.js` / `ShareIndicator.spec.js` / `mail-share.spec.js`(6) / `share-chunk.spec.js` / `init.spec.js` / `router/index.spec.js` 全绿。

日志留档:`/opt/cursor/artifacts/t21_green_vue_suites.log`。

### 变异验证(证明断言真的会咬)

逐条把实现改坏、跑抽屉 spec、再还原(还原后 md5 比对通过):

| 变异 | 期望打红的用例 | 实测 |
|---|---|---|
| `buildPatch` 改成整表单回传 `maxSessions` | C1 · M2 · 「无脏字段不发请求」 | ✓ 3 红 |
| `remove: [item.accountId]`(维度传混) | B2 | ✓ 红 |
| bindings 成功后不重取 `getMailShare` | B4 · B5 · B6 | ✓ 3 红 |
| `writable` 判据缩成只有 `'ACTIVE'` | S2 | ✓ 红 |
| 读只读态也放开写控件 | S1(EXPIRED / REVOKED)· B5 | ✓ 3 红 |
| 首次设限不弹 `resetUsedSessions` 确认 | C3 | ✓ 红 |
| 详情刷新顺手清掉一次性明文 | K2 | ✓ 红 |
| enable 也走破坏性确认 | K3 honesty | ✓ 红 |

**共 8 组变异全部按预期打红,无一漏网。**

---

## 4. 实现要点(逐条对齐 prompt 的 12 条硬规则)

| # | 规则 | 落点 |
|---|---|---|
| 1 | 配置保存 = 脏字段 diff | `buildPatch()`;C1 显式断言 `not.toHaveProperty('maxSessions'/'messageLimit'/'remark'/'refreshIntervalMs')` |
| 2 | 「不限」发显式 `null`;空 `refreshIntervalMs` 不进 patch | `pickCount()` 三态:`undefined`=不改 / `null`=清空 / 数字=设值;C2 + T7 用例 |
| 3 | add=accountId / remove=bindingId,一次一个动作,成功后重取 get | `runBindingChange()` 末尾无条件 `await load()`;B1/B2/B4 |
| 4 | 删空最后一个 → 自动 REVOKE,确认文案写明 | `shareBindingRemoveLastConfirm`;B5 两条(文案不同 + 转只读) |
| 5 | `isMutableStatus` = ACTIVE \| ACCESS_LIMIT_REACHED,落 `status.js` | S1 / S2 |
| 6 | AuthKey 一次性:模板 + 本地 ref + 关闭即清 + 只有 enable/reset 写明文 | `authKeyOnce`;响应用 `const {authKey, ...rest}` 解构,**明文不进 `detail`**;K1/K2/K4 |
| 7 | enable 不得声称踢会话;reset/disable 必须写明 | enable 走 `submitAuthKey` 无确认 + `shareAuthKeyEnableHint`;reset/disable 走 `askAuthKey` + kill 文案;K3 两条 |
| 8 | `SHARE_INVALID_CONFIG` 给两种可能 + 刷新出口,不断言是哪种 | `shareAuthKeyFailed`;K5 |
| 9 | accountList 游标分页,size 硬顶 30,加载更多,50 上限禁用 | `loadAccounts()`;B7 + T15(断言 `accountList(0, 30, null)` 与 `(49, 30, 129)`) |
| 10 | 零裸 hex,CSS 变量;767 断点;无 `window.onresize` | source-contract 用例读 `<style>` 段做 `#[0-9a-fA-F]{3,8}` 反向断言 |
| 11 | `vi.mock` mail-share 必须展开 `importOriginal` | 三份 spec 全部照做,`isShareForbidden` 保持真实 |
| 12 | 不 import `views/share/**` / `request/share.js` / `useSharePolling.js` | source-contract 用例三条反向断言 + `share-chunk.spec.js` 真实构建仍绿 |

### 三条迷雾的落地

- **F1(OneShotSecret 抽不抽)**:按已决 **T21-INLINE** 内联(模板 15 行 + 一个 ref),没有抽组件。T-22 若先落地会自己写一份;T-21 已合入后再抽是一次 3 行移动。
- **F2(弹窗还是复选框)**:按已决 **T21-RESET-BOX** 用 `ElMessageBox.confirm` + `distinguishCancelAndClose: true`,三路(确认=清零 / 取消=`resetUsedSessions:false` / X·ESC=零请求)。C3 三支全测。
- **F3(翻面登记)**:见 §2。

---

## 5. ★偏离 recon 的两处(需要 review 知道)

### 5.1 行操作的位置:从 `.card-head` 挪到卡片底部

recon §4.2 的锚点 diff 把 `<ShareRowActions>` 放进 `.card-tags`。**实际落在 `</dl>` 之后、`</article>` 之前。**

理由不是口味,是浏览器实测出来的:卡片网格是 `minmax(320px, 1fr)`,`.card-head` 里已经有名称 + 两个 `el-tag`,再塞三个按钮后**分享名被挤成 `前..` 两个字符**(名称是 `min-width: 0` + ellipsis,`.card-tags` 是 `flex: none`,被压缩的只能是名称)。
recon §6.2 原文已把这一处留给执行者:「行动作放进 `.card-head` 右侧还是卡片底部,是 T-21 的版式选择」。
`ShareRowActions.vue` 自己的 scoped 样式承担这一行的版式(`justify-content: flex-end` + 上边框),`index.vue` 仍然只多 1 行。翻面用例断言的是「三个 hook 在 `[data-test="share-row"]` 里」,`<article>` 就是那个 row,所以位置变化不影响契约。

**证据**:`/opt/cursor/artifacts/t21_01_list_row_actions.png`(改后,标题完整)。改之前的挤压形态在实现过程中确认过,未留档。

### 5.2 多登记 5 个 i18n 键

recon §10.2 是 40 个。实际 **45 个**,多出来的 5 个都是 recon 没覆盖到的界面文本:

| 键 | 为什么 recon 没有 |
|---|---|
| `shareConfigTitle` | §6.3 的信息架构画了「② 配置」这个面板,但没给面板标题的键 |
| `shareName` / `shareRemark` | §10.1 核过 `name` / `remark` 通用键**不存在**,`shareNamePlaceholder` 只是 placeholder 不是 label |
| `shareConfigRejected` | §3.5 裁决「`SHARE_INVALID_CONFIG` → 内联提示 + 保留用户输入」,但没给这条内联提示的键 |
| `shareRefreshIntervalTooSmall` | C5 要求前端在 3000ms 下界拦下,拦下就要说为什么 |

---

## 6. i18n 登记表(**只登记,不落盘** —— `zh.js` / `en.js` 一字未改,交 T-29)

### 6.1 直接复用的既有键(已在 `zh.js`/`en.js`,逐个核过)

`confirm` `cancel` `delete` `save` `copy` `copySuccessMsg` `shareRevoke`(=「销毁」)`shareRevokeConfirm` `shareRevokeSuccess` `shareCreatedAt` `shareExpiresAt` `shareLastAccess` `shareNamePlaceholder` `shareRemarkPlaceholder` `shareStatusActive` `shareStatusExpired` `shareStatusRevoked`。
**没有再造 `shareDelete` / `shareSave` / `shareConfirm`。**

### 6.2 T-20 已登记、T-21 继续消费(不重复登记)

`shareStatusLimitReached` `shareTypeSingle` `shareTypeMulti` `shareBoundMailboxes` `shareSessionQuota` `shareQuotaUnlimited`

### 6.3 T-21 新增 45 个 × 2 语言

zh 一列已作为 `PENDING_COPY` 落进组件(T-20 的 `tf()` 模式:`te(key) ? t(key) : PENDING_COPY[key]`),T-29 落盘后自动切走。

| 键 | zh | en |
|---|---|---|
| `shareDetail` | 详情 | Details |
| `shareDetailTitle` | 分享详情 | Share details |
| `shareDetailLoadError` | 详情加载失败，请刷新重试。 | Could not load the details. Refresh and try again. |
| `shareDetailReadonly` | 这个分享已不可修改（已过期或已销毁），仅供查阅。 | This share can no longer be changed (expired or revoked). View only. |
| `shareDetailGone` | 这个分享已不存在，已为你刷新列表。 | This share no longer exists. The list has been refreshed. |
| `shareBindingAdd` | 添加邮箱 | Add mailbox |
| `shareBindingRemove` | 移除 | Remove |
| `shareBindingRemoveConfirm` | 移除后，这个邮箱的邮件会立刻从分享页消失。 | Once removed, mail from this mailbox disappears from the share page immediately. |
| `shareBindingRemoveLastConfirm` | 这是最后一个邮箱，移除它会同时销毁整个分享。 | This is the last mailbox. Removing it destroys the whole share. |
| `shareBindingLimitReached` | 一个分享最多绑定 50 个邮箱。 | A share can bind at most 50 mailboxes. |
| `shareBindingConflict` | 绑定关系刚被改动过，已为你刷新，请重新确认。 | The bindings just changed. They have been refreshed—please review and try again. |
| `shareBindingLoadMore` | 加载更多邮箱 | Load more mailboxes |
| `shareBindingNoneAvailable` | 没有可添加的邮箱了。 | No more mailboxes to add. |
| `shareConfigTitle` ★ | 配置 | Configuration |
| `shareConfigSaved` | 已保存 | Saved |
| `shareConfigNoChange` | 没有需要保存的改动。 | Nothing to save. |
| `shareConfigRejected` ★ | 这项配置未被接受：可能超出了当前允许的取值，或这项能力尚未开放。请调整后重试。 | This setting was not accepted: it may be outside the allowed range, or the capability may not be available yet. Adjust it and try again. |
| `shareName` ★ | 名称 | Name |
| `shareRemark` ★ | 备注 | Note |
| `shareMaxSessions` | 会话上限 | Session limit |
| `shareMessageLimit` | 邮件条数上限 | Message limit |
| `shareOtpExtraction` | 提取验证码 | Extract verification codes |
| `shareAutoRefresh` | 自动刷新 | Auto refresh |
| `shareRefreshInterval` | 刷新间隔（毫秒，最小 3000） | Refresh interval (ms, min 3000) |
| `shareRefreshIntervalTooSmall` ★ | 刷新间隔不能小于 3000 毫秒。 | The refresh interval cannot be shorter than 3000 ms. |
| `shareResetUsedSessionsTitle` | 是否把已用会话数清零？ | Reset the used-session count? |
| `shareResetUsedSessionsHint` | 这是这个分享第一次设置会话上限。清零后按新上限重新计数；保留计数可能让它立刻触顶。 | This is the first session limit for this share. Resetting starts the count over; keeping it may hit the limit immediately. |
| `shareResetUsedSessionsYes` | 清零并保存 | Reset and save |
| `shareResetUsedSessionsNo` | 保留计数并保存 | Keep the count and save |
| `shareShowFullAddress` ⚠ | 显示完整地址（展示选项） | Show full address (display option) |
| `shareShowFullAddressHint` ⚠ | 只影响分享页上邮箱地址的显示方式。关闭它不会隐藏邮件正文、主题或发件人里出现的地址。 | Only changes how the mailbox address is displayed on the share page. It does not remove addresses that appear in the mail body, subject, or sender. |
| `shareAuthKey` | 访问密钥 | Access key |
| `shareAuthKeyOn` | 已启用 | Enabled |
| `shareAuthKeyOff` | 未启用 | Not enabled |
| `shareAuthKeyEnable` | 启用 | Enable |
| `shareAuthKeyReset` | 重置 | Reset |
| `shareAuthKeyDisable` | 关闭 | Turn off |
| `shareAuthKeyEnableHint` ⚠ | 启用后，新的访问需要这把密钥；已经打开的访问不受影响。 | New visits will need this key. Visits that are already open are not affected. |
| `shareAuthKeyKillConfirm` ⚠ | 这会立刻让所有已打开的访问失效，访客需要用新密钥重新打开。 | This immediately ends every open visit. Visitors must reopen with the new key. |
| `shareAuthKeyDisableConfirm` ⚠ | 关闭后不再需要密钥，同时立刻让所有已打开的访问失效。 | Turning it off stops asking for a key and immediately ends every open visit. |
| `shareAuthKeyOnce` | 新密钥只显示这一次，关闭后无法再查看。请立即复制并妥善保存。 | This is the only time the new key is shown. Copy it now; it cannot be retrieved later. |
| `shareAuthKeySaved` | 我已保存 | I saved it |
| `shareAuthKeyFailed` | 无法完成：可能是这项能力尚未开放，或分享状态刚刚变化。请刷新后重试。 | Could not complete this: the capability may not be available yet, or the share just changed. Refresh and try again. |
| `shareDeleteConfirm` | 彻底删除这个分享及其全部记录？此操作不可恢复，且与「销毁」不同——删除后列表里也不再保留审计记录。 | Permanently delete this share and all of its records? This cannot be undone, and unlike Destroy it also removes the audit row from the list. |
| `shareDeleteSuccess` | 已删除 | Deleted |

★ = recon §10.2 之外由 T-21 追加(§5.2)。
⚠ = **改词前必读**:这 5 个键的措辞受诚实性约束,不是文案偏好。

### 6.4 给 T-29 的硬约束(改词前先读)

1. **`shareShowFullAddress` / `shareShowFullAddressHint`** —— `design.md:409` + Decision 14(`design.md:103`):掩码是**展示偏好**,不是保密/隐私边界。禁用词(zh/en 双侧):保密 · 加密 · 安全 · 私密 · 保护 · secret · hidden · hide · private · privacy · secure · protect。
2. **`shareAuthKeyEnableHint` 不得写成「启用后现有访问立即需要密钥」** —— `share-integration.spec.js:1436` 正面钉住 enable **不会**让已建立的会话失效。
3. **`shareAuthKeyKillConfirm` / `shareAuthKeyDisableConfirm` 必须写明会踢掉所有已打开的访问** —— reset/disable 都 `credentials_version + 1`。
4. **`shareDeleteConfirm` 必须与 `shareRevokeConfirm` 语义可区分** —— 「销毁」保留审计行,「删除」连审计行一起物理删。

**sleeper 断言的现实状态(诚实登记)**:M1 用例断言的是**组件自己的 `PENDING_COPY` 回退文案**(今天 `te()` 为 false,渲染的就是上表 zh 列),禁用词表覆盖 zh + en 两侧,所以 T-29 落盘后它**仍然有效**,不是空转。但它只守 `shareShowFullAddress` / `shareShowFullAddressHint` 两个键;上面第 2/3/4 条**没有自动闸门**,只有「reset 与 disable 的确认文案彼此不同」+「enable 不走确认」这两条结构性断言在守。

---

## 5.5 有意省略 / 已知瑕疵(登记)

| # | 内容 | 依据 |
|---|---|---|
| 1 | 抽屉在有未保存改动时关闭**不做二次确认**(`sheet-dismiss-confirm` 主动放弃) | recon §6.5:配置区是单个「保存」的显式提交模型,脏态丢失成本 = 重填几个字段,换来每次关抽屉都被打断不划算 |
| 2 | 抽屉里**不放**「复制分享链接」 | recon §6.3:`sec` 明文全仓不再可得(`OWNER_ROW_COLUMNS` 不 SELECT),只能拼出打不开的半截链接 |
| 3 | **不做**错误码 → 中文映射表 | recon §3.5:8 码 × 2 语言且 i18n 是 T-28/T-29 热区;只对三个会改变 UI 行为的码分支 |
| 4 | 删掉页内最后一行后停在空白页(`fetchList()` 不回退 `page`) | recon §12-T16:与 reg-key 等既有页同款行为,修它会突破 10 行预算。**已知瑕疵,不修** |
| 5 | `onlyMessagesAfterCreated` 不进表单 | 后端 `UPDATE_FIELDS` 刻意排除(`mail-share-service.js:933`) |

---

## 7. 浏览器实测(harness 已删除)

用一次性 vite harness(`.t21-harness/` + `t21-harness.html` + `vite.harness.config.js`,把 `@/request/mail-share.js` 与 `@/request/account.js` alias 到假模块)在真实 Chromium 里跑了一遍,**截图取完后三个文件已全部删除**(`git status` 已核:工作区只剩本任务白名单内的 7 个文件)。

浏览器侧实测输出:

```
after open:      [{"endpoint":"get"}]                       ← 打开只打一次 get
update body:     {"shareId":7,"name":"前台核验（改名）"}      ← 只改名字 → PUT 里没有 maxSessions/messageLimit
authkey value:   Ab3dEf0123456789_-xyQ                      ← 一次性明文可见
one-shot blocks after ack: 0                                ← 点「我已保存」后区块消失
plaintext left in DOM:     false                            ← 整页 DOM 里再无明文
expired: save disabled = true / remove disabled = true / enable disabled = true
expired: bindings still shown = 2                           ← 只读但仍可审计
limit reached: readonly banner = 0 / save disabled = false  ← 触顶态仍可写
```

截图:
`t21_01_list_row_actions.png`(行三动作)· `t21_02_drawer_open.png`(抽屉打开)· `t21_03_dirty_field_save.png`(脏字段保存)· `t21_04_authkey_shown_once.png`(一次性密钥)· `t21_05_drawer_mobile.png`(390px 断点)· `t21_06_expired_readonly.png`(EXPIRED 只读)· `t21_07_limit_reached_writable.png`(触顶可写)。

`min(560px, 100vw)` 的 CSS `min()` 在 390px 视口下实测生效(抽屉铺满全宽),**不需要 `window.innerWidth`,也没有加第三个 `window.onresize`**(recon §6.2 / §12-T10)。

---

## 8. 未验证(不假称绿)

| 栈 | 状态 |
|---|---|
| `mail-worker` 619 用例 | **unverified** —— T-21 是纯前端任务,worker 一行未改 |
| E2E 13 用例 | **unverified** —— W6 范围,按 prompt 要求不跑 |
| 暗色主题目视 | **unverified** —— 只做了静态保证(零裸 hex,全部走 `--el-*` / `--light-border` / `--extra-light-fill` / `--secondary-text-color` / `--regular-text-color`),没有在 `.dark` 下截图 |
| 真实后端联调 | **unverified** —— harness 用的是假 request 模块,没有跑 wrangler + D1 |

---

## 9. 交给下一棒的东西

### T-22(创建向导)

1. **并行冲突已发生**:`index.vue` / `index.spec.js` / `status.js` 三个文件 T-21 都动过。T-22 起跑前**先 rebase**,不要基于 T-21 之前的快照写锚点。
2. `index.vue` 现在有 `activeShareId` ref。T-22 的「新建」按钮成功后可以直接 `activeShareId.value = created.shareId` 把新分享的抽屉拉起来,不需要新增状态。
3. `isMutableStatus` 已在 `status.js`,T-22 的「向导后立即编辑」直接 import,不要再写一份。
4. **一次性明文的四段模式**(模板 / 派生 / 关闭即清 / 唯一赋值点)在 `ShareDetailDrawer.vue` 的 AuthKey 面板里已经有第二份实现(ShareDialog 是第一份)。T-22 会是第三份 —— 到那时抽 `OneShotSecret.vue` 才划算(F1 的判断没变,只是消费者数量到了)。
5. `.card-head` 现在仍然只有名称 + 两个 tag(行动作在卡片底部,§5.1),T-22 若要往头部加东西,注意 320px 卡片的挤压。

### T-23(ShareDialog 改造)

`views/email/ShareDialog.vue:228-290` 那批裸 hex(`#b88230` / `#fdf6ec` / `#dcdfe6` / `#909399` / `#ebeef5` / `#606266`)在 `.dark` 下是坏的。T-21 **没有**抄它们,抽屉全走 CSS 变量;T-23 顺手把 ShareDialog 也换掉的话,可以照抄 `ShareDetailDrawer.vue` 的 `<style>` 段口径。

### T-28 / T-29(i18n)

- §6.3 的 45 个键 × 2 语言待落盘。
- §6.4 的四条硬约束是**语义约束不是文案偏好**,改词前请读 `design.md:409` / `:103` 与 `share-integration.spec.js:1420-1456`。
- 落盘后建议顺手把三个组件里的 `PENDING_COPY` 删掉(`tf()` 会自动切到 `t()`,删除是纯减法);`index.vue` 的那份也是 T-20 留下的同类债。

### 给 review 的三个点名

1. §2 的翻面(唯一一次改写既有断言)。
2. §5.1 的版式偏离(行动作位置与 recon §4.2 的锚点不同)。
3. §5.2 的 5 个额外 i18n 键。
