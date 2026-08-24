# T-26 实施记录 · 访客 authRequired + 建会话幂等 + 刷新策略 + 会话清理

| 字段 | 值 |
|---|---|
| 任务 | T-26 / T-26.1 / T-26.2 |
| 分支 | `cursor/mailbox-share-capability-dcb6` |
| 起点 HEAD | `5f3b10f` |
| 依据 | `prompt.t26.exec.txt` + `recon-t26-session.md` §12(Fog 已裁,未重开) |
| worker | **零改动**。`git diff --stat mail-worker` 与 `git status --short mail-worker` 均为空 |

---

## 1. 成功状态逐条兑现

| 交付契约(逐字) | 落点 | 证据 |
|---|---|---|
| 未登录访客在需要 AuthKey 的分享上能输入密钥进入 | `index.vue` `state==='authRequired'` 分流 + `[data-share-auth*]` 表单 + `submitAuthKey` | 真浏览器走通(§4);`index.spec.js` 4 条 |
| 同 tab 刷新凭 sessionStorage token 恢复且不消耗配额 | `bootstrap` 复活分支原样保留,不写 est-key | 「revives a stored token without spending a session, an establish key or a countdown」 |
| POST /share/session 响应丢失后以同一 Idempotency-Key 重试 | `postSession` + `ensureEstablishKey`(发请求**前**落盘) | 「replays a lost response once under the same key」+「stores the idempotency key before the request leaves」 |
| autoRefresh=false 时只提供手动刷新且复用 pollTick | `beginMailbox` 两处 `polling.start()` 加门 + `manualRefresh` 调 `pollTick` | 静置 9s 零请求、一次点击恰 1 status + 1 mails(单测 + 真浏览器网络日志) |
| 离开路由或 SHARE_UNAVAILABLE 清 `share:session:` 与 `share:est-key:`,**不得**清 `share:status:` | `onUnmounted` / `clearMailboxView` / `exitShare` 三点,均只碰两个前缀 | 3 条清理断言 + `session.spec.js` 两条前缀隔离断言 |

## 2. 测试计数

| 套件 | 基线 | 现在 | 增量 |
|---|---|---|---|
| `views/share/session.spec.js` | 6 | **12** | +6(键形状 / `ensure` 幂等 / 跨 lid / `clear` / 三前缀互不误伤 / `clearOtherShareSessions` 不外溢) |
| `request/share.spec.js` | 10 | **14** | +4(头出现 / 旧请求形状 / authKey 只在 body / `isShareAuthRequired` 真值表) |
| `composables/useSharePolling.spec.js` | 7 | **8** | +1(`intervalMs` 传 ref,setup 之后到达仍生效) |
| `views/share/index.spec.js` | 35 | **53** | +18(AuthKey 4 / 幂等 4 / 刷新 5 / 倒计时与清理 5) |
| 定点五套件(含 `share-chunk`) | 59 | **88** | 全绿 |
| `pnpm --dir mail-vue test --no-cache` | 22 files / 221 | **22 files / 250** | +29,零新建测试文件 |
| `pnpm --dir mail-worker test --no-cache` | 18 files / 626 | **18 files / 626** | **不变** |
| `node tests/e2e/run.mjs` | 13 passed | **13 passed** | 未改 `tests/e2e/**`,仅运行 |

TDD 顺序按派单执行:每一步都先看到红(`session.spec.js` 6 红 / `request/share.spec.js` 3 红 / `useSharePolling.spec.js` 1 红 / `index.spec.js` 16 红),再写实现。
`useSharePolling` 那条红特别有信息量:失败值是 **3001 次调用**,坐实了「传裸 ref 会让 `setTimeout` 收到 `RefImpl` → 退化成 0ms 紧密轮询」这个比不生效更糟的形态(recon §5.1 预判正确)。

## 3. 与派单的三处偏离(全部为「不这么做就做不出成功状态」)

### 3.1 `index.spec.js` 改了 3 行,不是 1 行 —— 派单字面不可执行

派单:「ONLY `:164` may change among the 35」。实测 `toHaveBeenCalledWith` 是**精确实参匹配**,`createShareSession` 多一个第三参会同时红掉 **3 条**断言,不是 1 条:

| 行 | 原断言 | 归属测试 |
|---|---|---|
| `:164` | `toHaveBeenCalledWith('lid-a','sec-a')` | exchanges the fragment once(派单已批准) |
| `:423` | `toHaveBeenCalledWith('lid-a','sec-keep')` | re-establishes from the in-memory secret |
| `:436` | `toHaveBeenLastCalledWith('lid-a','sec-keep')` | 同上,断的是 `reestablishSession` 那一发 |

`:423`/`:436` 与 `:164` **同一性质**(实参形状跟随签名),recon §9.2 只是没数到它们。三行的改法完全一致:追加 `expect.objectContaining({ idempotencyKey: expect.any(String) })`。两条测试的**语义与其余断言一字未动**,`:172` `:238` `:250` `:275` `:442` 五条自愈/清理基线原样保留并绿。

> 若后续要把这条收回到「只改 1 行」,唯一办法是让 `reestablishSession` 绕开 `postSession` 直接调 `createShareSession(lid, sec)` —— 那会造出第二个 POST 出口,直接违反派单「Single POST exit」。不建议。

### 3.2 新增第 8 个 ref `authSubmitting`

recon §2.2 列 6 个 ref、§2.7 补 `refreshing` 到 7 个,但派单同时要求「Submitting: disabled + `shareVisitAuthChecking`」——那需要一个提交中标志。`refreshing` 与 `authSubmitting` 分属 `ready` / `authRequired` 两个互斥态,合并成一个 `busy` 能省一个 ref,但读起来更绕,取显式两个。
**ponytail(lite) 更懒选项**:合并为单个 `busy` ref(-1 ref,-0 行为)。没采纳,理由是可读性,不是必要性。

### 3.3 `onUnmounted` 用捕获的 `ownedLid`,不是 `currentLid()`

按派单原样写 `const lid = currentLid()` 时,`onUnmounted` 里 `route.params.lid` 实测为空(本仓库 vue-router 版本下 `useRoute()` 在 teardown 阶段不再作答),两个键**一个都清不掉**——测试当场红。改为在 `bootstrap` 里记下 `ownedLid`。
这个改动同时更正确:真实「离开路由」时组件卸载已晚于路由切换,`currentLid()` 读到的会是**下一个** lid,原写法在生产里是错的目标。

## 4. 真浏览器证据(未改 `tests/e2e/**`,只运行)

harness 用 `--var SHARE_CAPABILITY_V2:1` 起(命令行覆盖,`wrangler-e2e.toml` 未改),真 worker + 真 Chromium:

| 断言 | 实测 |
|---|---|
| `auth_key_enabled` 分享落到 authRequired | `STATE 1 authRequired`(不是 unavailable) |
| 错 Key 停在原态并给字段旁提示 | `STATE 2 authRequired` / `That key did not work. Check it and try again.` |
| authRequired 期间 est-key 保留 | `EST KEY while authRequired = 4e0cfaeb…` |
| 对 Key 进 ready | `STATE 3 ready` |
| 倒计时按 UTC 解析 | `Link expires in 1h 0m`,`datetime=2026-08-24T15:45:02.000Z`(`durationSeconds:3600` 对得上) |
| ready 后 sessionStorage 只剩 session + status | 无 `share:est-key:`、无 authKey、无 sec;URL 无 fragment |
| `autoRefresh=false` 静置 | 9s 内 `/api/share/*` 请求 **0 条**,期间投递的新邮件不出现 |
| 一次手动刷新 | 恰 `GET /share/mailboxes/status` + `GET /share/mails?limit=50&bindingId=440`,新邮件「Arrived while auto refresh is off」随即出现 |
| 375px | 表单换行,`scrollWidth > innerWidth` 为 `false` |

产物:`t26_visitor_authkey_flow.mp4`、`t26_manual_refresh_pulled_new_mail.png`、`t26_auth_form_375px.png`、`t26_final_verification.log`、`t26_browser_evidence.log`。

## 5. 遗留风险 / 交接项

| # | 风险 | 归属 | 说明 |
|---|---|---|---|
| R1 | **存 token 复活路径的 config 降级**(Fog-3 已裁接受) | T-29 登记为已知限制 | 同 tab 刷新后:`auto_refresh=false` 的分享**会开始自动轮询**、`refreshIntervalMs=30000` 退回 3000、倒计时不渲染。已被「revives a stored token…」一条钉住,不会静默漂移。真解需 status 响应捎带 config = worker 改动 + 新 AC,超出 T-26 派单 |
| R2 | **8 个新 i18n 键未落盘** | T-29 | `shareVisitAuthTitle` / `AuthLabel` / `AuthSubmit` / `AuthChecking` / `AuthRetry` / `Refresh` / `Refreshing` / `ExpiresIn`,现在全走 `tx(key, English fallback)`。加上 T-25 遗留的 `shareVisitMailboxes` / `shareVisitNewMail`,W5 共 **10 个** |
| R3 | 换 lid 时旧 lid 的 `share:est-key:` 会残留 | 无人 / 可不修 | `clearOtherShareSessions` 只扫 `share:session:`(T26-STATUS HOLD 明令不许扩)。残留物是 32 字符去重标签、非凭据,随标签页关闭消失 |
| R4 | 倒计时是分钟级 + 客户端时钟 | 无 | 不做 `serverTime` 对齐(recon §6.2 已裁)。客户端时钟偏差数分钟时展示会偏,不影响任何鉴权判定 |
| R5 | `isLostResponse` 的「业务信封」判据 | T-27.2 写 E2E 时复核 | 判据 = 非 Error 且自带 `code` 自有属性。真实 axios 传输失败(`ERR_NETWORK`,是 Error 且无 `response`)判为丢响应;`{code:401}`、`{code:501,message:'SHARE_*'}`、429 一律不重放。单测正反两侧都钉了,但真实「响应丢失」注入要等 T-27.2 |
| R6 | 手动刷新按钮无「刚刚刷新过/无新邮件」反馈 | 可选打磨 | 点了之后若无新邮件,页面无可见变化(仅按钮短暂进 Checking…)。派单未要求,未加 —— 加就需要第 9 个 ref 与第 9 个 i18n 键 |

## 6. T-26 独占物(后续只能消费,不得改语义)

1. `share:est-key:<lid>` 键名、`SHARE_ESTABLISH_KEY_PREFIX`、`ensureEstablishKey` / `clearEstablishKey` 的位置(`session.js`)与四时刻生命周期。
2. `postSession` 是 `POST /share/session` 的**唯一出口**;`enterReady` 是「拿到 token 之后」的唯一收口。
3. `state === 'authRequired'` 节点名 + `[data-share-auth]` / `[data-share-auth-input]` / `[data-share-auth-submit]` / `[data-share-auth-error]` 四个钩子(T-27.3 直接选它们,**冻结**)。
4. `[data-share-refresh]` / `[data-share-expires]` 两个钩子,以及「手动刷新 = 同一个 `pollTick`」这条形态。
5. `applyShareConfig` 仍是 session 响应的唯一读取点;`clampInterval` 下限**必须**恰好 `POLL_INTERVAL_MS`(改成别的数会一次性红掉 index.spec.js 里 14 处 `advanceTimersByTimeAsync(POLL_INTERVAL_MS)`)。
6. `useSharePolling.readInterval()` 形状;`autoStart` / `listStatus` / `mode` 三个参数**永久禁止**。

## Update Log

- 2026-08-24 · T-26 实施完成。vue 22 files / 250 tests,worker 18 / 626 不变,e2e 13 passed,`git diff --stat mail-worker` 为空。
