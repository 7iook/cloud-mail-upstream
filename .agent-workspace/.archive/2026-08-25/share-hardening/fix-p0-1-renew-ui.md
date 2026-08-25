# fix-p0-1 · 管理台续期入口接线

修的是 `review-t22b.gpt.md` 的 **P0-1「管理端没有『直接延长』入口，核心用户需求不可达」**。
后端 `PUT /mailShare/update` 已接受 `expiresAt`，缺的只有管理台这一段。

- 基线 HEAD：`632a931`（工作区有其他执行者的在飞改动，未 commit、未 stash）
- 前端测试：**283 → 291**（23 files，只增不减）
- 独占范围内改了 4 个文件：`ShareDetailDrawer.vue` / `ShareDetailDrawer.spec.js` / `i18n/zh.js` / `i18n/en.js`。
  `presets.js` **未改**（只 import，见下），`mail-worker/` / `ShareCreateWizard.vue` / `email/ShareDialog.vue` / `views/share/` 一律未碰。

## 成功状态（逐字抄自交付契约）

> NOT「详情抽屉多了个输入框」, BUT 管理员在管理台看到一条分享还有两天到期，能当场把它延长，链接不变、已经拿着链接在看的访客不掉线 —— 不必删掉重建再挨个重新通知拿到过链接的人。
> 不该发生: 界面允许他延长到超过系统上限，提交后才被后端拒绝（能在浏览器里挡住的就别让它往返一趟）。

链路逐格核实（`git grep` / 直接读码）：

| 节点 | 生产者 | 消费者 | 核实结论 |
|---|---|---|---|
| 输入 | 抽屉配置区（本轮建） | `buildPatch()` | 已建：`ShareDetailDrawer.vue` 的 `renew-choice` / `renew-exact` 控件 |
| patch | `buildPatch()`（本轮改） | `submitSave()` | 已改：`isRenewDirty()` 为真时产出 `patch.expiresAt` |
| 请求 | `submitSave()` | `updateMailShare()` | 既存：`@/request/mail-share.js`，未改 |
| 后端 | `PUT /mailShare/update` | `UPDATE_FIELDS` | 既存：`mail-share-service.js:960` 白名单含 `expiresAt`；`applyRenewal():984-1002` 判上限并顺延 `delete_at` |
| sink | — | D1 `mail_share.expires_at` | 既存：同上，列映射 `expires_at` |

`lid` / `sec_hmac` / `credentials_version` 都不在 `UPDATE_FIELDS` 里，续期这条路径**不可能**改动它们 —— 「链接不变、在看的访客不掉线」由后端白名单本身保证，前端没有额外动作。

## `create_time` 是否可得 —— 核实结论：**可得，无需假设、无需改后端**

- `mail-worker/src/service/mail-share-service.js:428`：`projectOwnerRow()` 输出 `createTime: row.createTime`，列表行与详情共用这套投影。
- `ShareDetailDrawer.vue` 本来就在渲染它（`detail-created` 字段，`tzText(detail.createTime)`）。

所以上限余量可以在浏览器里精确算出来，不必退化成「按当前时刻估」。

## 控件形态：档位 + 精确时刻，二选一切换

后端 `toPatchExpiresAt()` 只收**绝对时刻**（`YYYY-MM-DD HH:mm:ss` UTC 裸串，注释明说拒绝「再加 N 秒」，因为往返延迟会让台上看到的和落库的漂移）。所以无论界面长什么样，发出去的都得是一个绝对时刻。在这个前提下：

- **档位（`延长 1 小时 / 6 小时 / 24 小时 / 7 天`）**：贴合「续期」心智，一次点击完事，基准是**已保存的到期时刻**（不是上一次点击的结果，所以连点两次 24h 仍落在 +24h，不会偷偷叠成 48h）。
- **`指定失效时间`（`el-date-picker`）**：档位覆盖不到的两件事只能靠它 —— ① 缩短（后端允许，档位全是正数表达不了）；② 任意目标时刻。

只上档位会让「允许缩短」这条后端语义在管理台不可达，也让「缩短到过去 → 拦下」这条必测项无从触发；只上时间选择器则把「延长两天」变成一次手工算日期。所以两个都留，用同一个 `select` 的 `keep / 档位 / custom` 三态切换，与创建向导 `durationModel` 的 `DURATION_CUSTOM` 哨兵形状一致。

「最多还能延到什么时候」不靠试错：`renew-ceiling` 常驻显示 `create_time + 90 天` 的本机时刻，`renew-target` 显示「保存后失效于 X」。

## 复用与新增的边界（P-03）

- **复用 `presets.js`**：`SHARE_DURATION_PRESETS`（档位，连 i18n key 一起）、`DURATION_CUSTOM`（哨兵）、`MAX_DURATION_SECONDS` / `MAX_DURATION_DAYS`（上限镜像）。档位与上限**没有**在抽屉里出现第三份字面量。
- **未复用 `DURATION_UNITS` / `customDurationSeconds`**：它们表达「数量 + 单位」的相对时长，而这里的自定义是一个**绝对时刻**（否则表达不了缩短）。硬套会把一个绝对时刻拆成「相对谁」的二义。
- **未复用 `durationError()`**：它的判据是 `seconds > MAX_DURATION_SECONDS`，基准隐含「从现在起」；续期的判据是 `新时刻 − create_time ≤ MAX`，基准是创建时刻。套用它会得到一个比后端**宽**的前端闸门（一条已经跑了 80 天的分享，前端放行 +7 天，后端拒），正是契约里点名不该发生的那种往返。
- **`presets.js` 未新增导出**：新判据 `renewErrorKey()` 目前只有抽屉一个消费者，提到共享文件里是投机抽象；等第二个消费者出现再提。P-03 的教训针对的是「同一份档位/上限被抄了两遍」，这一条已经通过 import 规避。

## 前端闸门（与后端逐条对齐）

`submitSave()` 里在 `buildPatch()` 之前拦截，与既有的 `refreshIntervalMs` 下限检查同一姿势，错误走既有出口 `configError` + 模板 `data-test="config-error"`：

| 判据 | 前端 | 后端对应 |
|---|---|---|
| 新时刻必须在未来 | `shareRenewPast` | `applyRenewal():990` → `SHARE_INVALID_CONFIG` |
| `新时刻 − create_time ≤ 上限` | `shareRenewTooLong`（文案带 90 天与最晚时刻） | `applyRenewal():994` → `SHARE_DURATION_EXCEEDED` |
| 值本身解析不出来 | `shareRenewInvalid` | `toPatchExpiresAt():931` → `SHARE_INVALID_CONFIG` |
| 仅可变状态可写 | 控件 `:disabled="!writable"`（复用既有计算属性） | `loadMutableShare()` 拒 EXPIRED / REVOKED |

服务端仍可能拒（部署把 `SHARE_MAX_DURATION_SECONDS` 配得比前端镜像 90 天更低）：`submitSave()` 的 catch 新增 `SHARE_DURATION_EXCEEDED` → 既有文案 `shareDurationServerRejected`。刻意不复用 `shareRenewTooLong`：那句话里写着我们自己的 90 天，服务端按别的数字拒时拿它糊弄管理员比不说更糟（沿用 `presets.js:116-118` 已有的同一条理由）。

## 时区口径

抽屉里 `form.expiresAtLocal` 全程是**本机墙上时钟**，与上方三个只读时刻（`tzText`）同一口径；`buildPatch()` 是唯一的转换点，`toUtc(...).format('YYYY-MM-DD HH:mm:ss')` 出 UTC 裸串。后端裸串一律用 `tzDayjs()` 读回（`create_time` / `expires_at`），本机输入一律用 `toUtc()` 送出 —— 这正是 `utils/day.js` 既有的分工，没有新造转换函数。R1/R7 的断言直接钉 UTC 裸串，本机为 UTC+8，少一次转换就会差 8 小时并立刻打红。

## 红绿证据

### 红（实现前，只有 spec）

```
pnpm vitest run src/views/share-admin/ShareDetailDrawer.spec.js
 ❯ src/views/share-admin/ShareDetailDrawer.spec.js (48 tests | 10 failed)
 FAIL  ... renewal (review-t22b P0-1) > extends by a preset rung and sends the new instant as a UTC bare string (R1)
 FAIL  ... renewal (review-t22b P0-1) > drops the renewal again when the owner picks a rung and then goes back to keep (R3)
 FAIL  ... renewal (review-t22b P0-1) > shows how far the share can still be extended, so the owner does not guess (R4)
 FAIL  ... renewal (review-t22b P0-1) > stops a renewal past the ceiling in the browser instead of posting it (R5)
 FAIL  ... renewal (review-t22b P0-1) > stops a shortening that lands in the past: EXPIRED rows cannot be edited back (R6)
 FAIL  ... renewal (review-t22b P0-1) > allows shortening to a still-future instant (R7)
 FAIL  ... renewal (review-t22b P0-1) > puts a server-side duration refusal on screen (R8)
 FAIL  ... write predicate > keeps EXPIRED readable but never writable (S1)
 FAIL  ... write predicate > keeps REVOKED readable but never writable (S1)
 FAIL  ... write predicate > leaves ACCESS_LIMIT_REACHED fully writable (S2)
 Tests  10 failed | 38 passed (48)
```

红的原因是控件不存在（`[data-test="renew-choice"]` / `renew-exact` / `renew-ceiling` 找不到），不是语法错。
R2（「没改就不发」）此时**空绿** —— 那时 `buildPatch()` 本来就不产 `expiresAt`。它守的是反方向，由下面第二次变异证伪。

### 绿

```
pnpm vitest run src/views/share-admin/ShareDetailDrawer.spec.js
 Test Files  1 passed (1)
      Tests  48 passed (48)

pnpm --dir mail-vue test
 Test Files  23 passed (23)
      Tests  291 passed (291)
```

### 变异验证（两次，均已还原）

**变异 1 —— 去掉 `buildPatch()` 里新加的 `expiresAt` 分支**（模拟「控件建了但没接线」，也就是 P0-1 原病灶）：

```
 Tests  3 failed | 45 passed (48)
 FAIL  ... (R1) extends by a preset rung and sends the new instant as a UTC bare string
 FAIL  ... (R7) allows shortening to a still-future instant
 FAIL  ... (R8) puts a server-side duration refusal on screen
```

**变异 2 —— `isRenewDirty()` 恒 `true`**（模拟「脏检查写漏、全量回发」）：

```
 Tests  11 failed | 37 passed (48)
 FAIL  ... (R2) keeps expiresAt out of the patch when the owner never touched it
 FAIL  ... (R3) drops the renewal again when the owner picks a rung and then goes back to keep
 FAIL  ... config patch (C1/C2/C3/C4/T7/C6)、access key (K2)、write predicate (S2)、mask toggle (M2)
```

第二次变异把既有的 6 条 config-patch 基线也打红，说明脏检查纪律在这一层是被真守着的，不是我新写的两条自说自话。

**还原后复跑（当前仓库状态）**：

```
Select-String -Path mail-vue\src\views\share-admin\ShareDetailDrawer.vue -Pattern "MUTATION PROBE"
（无输出 —— 无变异残留）

pnpm --dir mail-vue test
 Test Files  23 passed (23)
      Tests  291 passed (291)
```

`ReadLints` 对四个改动文件：无告警。

## 新增用例（8 条，覆盖必测项）

| 用例 | 覆盖的必测项 |
|---|---|
| R1 改了有效期 → 产出 `expiresAt`（且是正确的 UTC 裸串） | ✅ |
| R2 没改 → 不产出 | ✅（最容易写漏那条） |
| R3 选了档位又切回「保持不变」→ 整个请求都不发 | 附加，守 watch 的回退 |
| R4 界面显示「最多可延长到 X」 | 契约「别让他试错」 |
| R5 超过上限 → 就地拦下，不发请求 | ✅ |
| R6 缩短到过去 → 拦下 | ✅ |
| R7 缩短到仍在未来 → 放行 | 附加，防「一刀切禁止缩短」 |
| R8 后端 `SHARE_DURATION_EXCEEDED` → `configError` 上屏 | ✅（不静默） |
| S1/S2（既有用例，`WRITE_HOOKS` 加入 `renew-choice`） | ✅ 只读状态控件不可用 |

## Review Findings

- **无方向偏差**，派发的判据与代码一致：`applyRenewal()` 的基准确实是 `create_time`、确实要求新时刻在未来、`expiresAt` 确实不过 `assertUpdatePatch` 的能力栅栏。派发里说的锚点行号（`:654` `buildPatch` / `:420` `configError` / `:702` `submitSave` / `:237-239` 模板出口）逐条对上，未做修正。
- **`create_time` 可得性**：派发要求「先确认，不要凭空假设」。已确认可得（`projectOwnerRow:428`，且抽屉本来就在渲染），所以走了精确上限，没有降级方案，也没有改后端接口。
- **改了 spec 里的共享 stub**：`el-select` 原本 `Number($event.target.value)`，会把 `keep` / `custom` 两个哨兵变成 `NaN`。改成传原值。既有的 `binding-add-select` 用例不受影响 —— `submitAdd()` 自己就做 `Number(addAccountId.value)`，全套用例复跑通过可证。
- **`tf()` 签名扩了一个 `params`**：新文案要插值（`{days}` / `{time}` / `{duration}`）。与 `ShareCreateWizard.vue:445` 的 `tf` 完全同形，不是新发明。既有调用一个没改（`params` 可选）。
- **新增测试钉住了系统时间**（`vi.useFakeTimers({toFake:['Date']})` + `2026-08-17T12:00:00Z`）。`sampleDetail()` 的 `createTime` / `expiresAt` 写死在 2026-08 中旬，真实时间已过 2026-08-18，样本分享恒在过去，「新时刻必须在未来」会把每条用例判红。只 fake `Date`、不 fake 定时器，`flushPromises` / `nextTick` 走微任务不受影响。**这是既有 fixture 的时间脆弱性**，本轮只在新 describe 里就地钉住，没有去动其他 describe 的样本（超出本包边界，且会牵动其他执行者在飞的文件）。
- **隐藏风险（未处理，登记）**：`MAX_DURATION_SECONDS` 是后端**兜底值**的镜像，`presets.js:73-80` 已把这条记为债 —— 部署配了更低的 `SHARE_MAX_DURATION_SECONDS` 时，前端会放行一个后端拒绝的续期。本轮的处理是「让它以 `shareDurationServerRejected` 上屏而不是静默」，没有去让 `websiteConfig` 携带真实上限（那要改 Worker，超出本包边界）。
- **P0-2（续期缺 CAS 快照守卫）不在本包**：`mail-worker/` 由其他执行者持有，未碰。前端这一侧的续期是「读详情 → 改 → 提交」，若期间被并发改动，后端 CAS 补上后会以业务错误返回，`configError` 的出口已经在了。

## Update Log

- 2026-08-25 · executor · 管理台详情抽屉接入续期（档位 + 精确时刻、create_time 基准的上限闸门、`SHARE_DURATION_EXCEEDED` 上屏），新增 8 条组件用例。红绿 + 两次变异证据见上；变异已还原并复跑 291 passed。commit: pending（按派发要求未 commit）。
