# T-20b2c · 详情抽屉「查看链接」前端落地

## 成功状态（逐字抄自交付契约）

> NOT「详情页多了个按钮」, BUT 管理员点开任意一条分享的详情，都能知道「这条链接现在还能不能拿回来」——能就当场拿回并复制，不能就看到一句说清原因、并告诉他下一步该干什么的话：上线前建的可以重新生成，服务配置异常要找管理员，这是两件不同的事。
>
> 不该发生：把后端刚分开的四种情况在前端 catch 成一句「获取失败」· 取回的明文进 storage / pinia / URL。
>
> 来源：ADR-share-credential-recoverability 轨一 · 用户原话「点击查看详情，可以看到这个邮箱当初创建的分享链接是哪个」

## 我核实到的后端契约（读代码，不信转述）

| 项 | 证据 |
|---|---|
| 端点 | `mail-worker/src/api/mail-share-api.js:111` — `app.post('/mailShare/revealSec', ownerRevealRateLimit(), ...)`，入参走 body |
| 成功返回 | `mail-share-service.js:1737` — `{ shareId, lid, shareUrl }`。**没有裸 `sec` 字段**（注释明说「多一个字段就多一处会被日志顺手带走的明文」），也没有 `authKey` |
| 链接拼装 | `shareUrlOf()`（`:528`）是 create / regenerate / reveal 的唯一拼装点 → 前端只能原样透传，不得自己拼 |
| 四个错误码 | `REVEAL_FAILURE`（`:1278-1284`）+ `REVEAL_UNKNOWN_FAILURE`（`:1288`） |
| 无状态门 | `revealSec` 走 `loadOwnerDetail`（归属谓词）而非 `loadMutableShare`（ACTIVE 谓词），`:1694-1700` 有整段说明 |
| 鉴权 | `security.js:82` / `:124` — 已挂 `share:manage` 白名单 |

**与任务表的出入：一处，且不改变前端行为。** 后端实际是**五种**解密失败成因收敛成**四个**对外码——`AUTH_FAILED` 与 `MALFORMED` 共用 `SHARE_SEC_CORRUPTED`（`:1275-1277`：对管理员是同一个自助动作，差别只在排障，留在事件 `outcome` 里）。任务表列的四个码本身完全正确。

另外后端给这条路加了 **Owner 侧限流**（`ownerRevealRateLimit`，按 `userId` 而非 IP，超限回 HTTP 429 + `Retry-After`）。429 是传输层错误、不是 body 里的业务码，会落到前端兜底分支上屏，不会静默——契约层面无需前端额外分支。

## 交付契约链路核验

| 节点 | 生产者 | 消费者 | 核验 |
|---|---|---|---|
| 入口 | `ShareDetailDrawer.vue` `data-test="link-reveal"` | 管理员点击 | 已建，不受 `writable` 约束 |
| 请求 | `revealMailShareSec()` `request/mail-share.js:127` | 抽屉 `submitReveal()` | 已建，POST + body |
| 端点 | `mail-share-api.js:111` | — | 已就绪（只读核实，未改 `mail-worker/`） |
| 最终 sink | `data-test="link-reveal-url"` 只读输入框 / `data-test="link-reveal-error"` 说明 | 管理员屏幕 | 已建 |

## 改动

- `mail-vue/src/request/mail-share.js` — 新增 `revealMailShareSec(shareId)`。POST 而非 GET（凭据暴露不该进浏览器历史 / 代理日志 / referer），**不带 Idempotency-Key**（不铸任何东西，重试无害，加了反而暗示它是写）。
- `mail-vue/src/views/share-admin/ShareDetailDrawer.vue` — 「查看链接」入口 + `REVEAL_ERROR_KEYS` 四码映射 + 兜底 + 第三个 `useCopyWithFallback` 实例。
- `mail-vue/src/i18n/zh.js` · `en.js` — 9 个新键；并改掉了 `shareLinkHint`（见下）。

### 顺手修掉的一条：`shareLinkHint` 变成了假话

原文案：「已有链接无法再次查看——它的密钥部分从未被保存。」这是轨一落地**之前**的事实，落地后它是错的，而且是管理员在点任何按钮之前读到的**唯一**说明——留着它，他压根不会去点「查看链接」，整条轨一等于没上。改为指向「查看链接」并保留「外泄/丢失 → 重新生成」。测试 V13 钉住它（断言不再出现「无法再次查看 / never stored」）。属交付范围内文件，未越界。

### 两个入口共存的交互处理

后端语义决定了这两条不是并列关系：**取回的永远是「当前有效的那条」，刚铸的那条一落地就取代了它。** 所以两块链接同屏没有正确读法——管理员看不出哪条现在能用。处理是**互斥，且让位方向固定**：

- reveal 成功 → 清 `linkOnce`（「只显示这一次」的那块让位：两块同屏时它已经不是仅有的一次了）；
- regenerate 成功 → 清 `revealedLink`（这次轮换刚把它作废，继续挂着就是一条会被复制出去的死链接）；
- 每一侧成功时同时清对侧的错误行，避免「链接在上、上一次的报错在下」这种自相矛盾的画面。

两个方向各有一条测试（V8 / V9）。

### 状态门：刻意不看 `writable`

`writable` 表达的是「可编辑」。EXPIRED / REVOKED 的行恰恰是管理员要排查「当初发出去的是哪条」的地方，后端为此明确没给 `revealSec` 加活跃谓词。V7 逐条钉住：这两个状态下 `link-reveal` 可用且真的发出请求，同一屏的 `link-regenerate` 仍禁用。

### 明文纪律

`revealedLink` 只是组件内 ref，不进 storage / pinia / URL。V6 断言：全抽屉只有一个 input 含该明文、不出现在渲染文本里、`localStorage`+`sessionStorage` 序列化后不含它、`window.location.href` 不含它，收起后 0 个。

## 红绿证据

**红**（写完测试、实现之前）：

```
 FAIL  src/request/mail-share.spec.js > reveals over POST with the shareId in the body, never in the URL
TypeError: revealMailShareSec is not a function
 FAIL  src/views/share-admin/ShareDetailDrawer.spec.js
Caused by: ReferenceError: revealMailShareSec is not defined
 Test Files  2 failed | 21 passed (23)
      Tests  1 failed | 245 passed (246)
```

**绿**（实现后）：

```
 Test Files  23 passed (23)
      Tests  323 passed (323)
```

基线 305 → 323（+18，只增不减）。

## 变异验证

**变异 1 · 把四个码折叠成一句**（`const key = 'shareLinkRevealFailed'`）：

```
 ❯ src/views/share-admin/ShareDetailDrawer.spec.js (77 tests | 6 failed)
     × says what SHARE_SEC_ABSENT means and what to do next (V3)
     × says what SHARE_SEC_UNAVAILABLE means and what to do next (V3)
     × says what SHARE_SEC_KEY_RETIRED means and what to do next (V3)
     × says what SHARE_SEC_CORRUPTED means and what to do next (V3)
     × gives the four codes four different answers, not one "failed" (V4)
      Tests  6 failed | 317 passed (323)
```

**变异 2 · 去掉兜底**（未识别码 → 空串）：

```
 ❯ src/views/share-admin/ShareDetailDrawer.spec.js (77 tests | 1 failed)
     × never leaves a business refusal off the screen, whatever the code (V5)
      Tests  1 failed | 322 passed (323)
```

**还原后复跑**：

```
$ vitest run
 Test Files  23 passed (23)
      Tests  323 passed (323)
   Start at  10:52:17
```

Lint：`ShareDetailDrawer.vue` / `mail-share.js` 均无告警。

## 弱断言复盘

V3 逐条断言四个码各自的文案，但**四条文案若被改成相同内容，V3 照样全绿**——逐条精确断言只钉住「码 → 键」的映射，钉不住「四个键的值真的不一样」。补了 V4：`new Set(texts).size === 4`，外加「前两个码含『重新生成』、后两个含『管理员/运维』」的语义分组断言，把「自助 vs 找人」这条业务判断本身也钉住。变异 1 同时打红 V3 与 V4，两层都真实生效。

## Review Findings

- **任务文档与代码的出入：一处，Tier 1 自行核实后按代码为准。** 任务表说「四个可区分的错误码」，代码是**五种失败成因 → 四个对外码**（`AUTH_FAILED` / `MALFORMED` 共用 `SHARE_SEC_CORRUPTED`）。四个码本身与表一致，前端行为不受影响，未上报打断。
- **任务未提及的后端事实：Owner 侧限流。** `ownerRevealRateLimit()` 按 `userId` 计，超限回 429 + `Retry-After`。传输层错误落兜底分支上屏，不静默；未为它单开分支（后端刻意没给它 body 业务码）。
- **越界范围外的顺手修复：`shareLinkHint`。** 见上文——不是文案润色，是轨一落地后这句话变成了错误信息，且会直接抵消本包的价值。文件在独占范围内。
- **隐患（未处理，留给后续判断）**：`shareLinkRegenerateConfirm` 说「旧链接会立刻作废」，措辞在有了「查看链接」之后仍然成立，未动。但 `shareLinkOnce`（「新链接只显示这一次，关闭后无法再查看」）现在**严格来说也已经不准**——新铸的这条同样能被 reveal 回来。本轮没改：它承担的是「现在就复制，别指望等会儿」的行为引导，改成「你随时能再看一次」会削弱这个引导，属产品口径决策而非事实修正，应由主 AI 裁决。
- 未碰 `mail-worker/` 任何文件（只读）。未 `git commit`，未 `git stash`。
