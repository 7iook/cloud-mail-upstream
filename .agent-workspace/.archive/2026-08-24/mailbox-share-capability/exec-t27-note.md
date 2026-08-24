# T-27 执行记录 · E2E 新访客场景（W6 第一根横杠）

- 执行时间：2026-08-24
- 分支：`cursor/mailbox-share-capability-dcb6`，起始 HEAD `58767d3`
- ponytail 强度：**lite**
- 未 commit / push / stash / 切分支（派单硬约束）。

---

## 0. 一句话结论

三条迷雾裁决**全部按 §13 原样执行且全部成立**：Fog-2 的 `route.fetch()` + `route.abort('failed')` 在 playwright-core 1.55.0 上**没有**抛 "already handled"；Fog-1 的单 Proxy + `/__e2e__/capability-v2` 让 V2 两态在同一次 `run.mjs` 内共存，且**默认态确实是 off**（已用反证跑实测，见 §3）；Fog-3 的薄栅栏 spec 四路全绿。

E2E：**19 passed / 0 skipped**（既有 13 条一条未动 + 新增 6 条）。生产文件、`wrangler-e2e.toml`、`run.mjs`、`playwright.config.js`、既有 12 个 spec 文件**零 diff**。

发现一条**新的生产缺陷**（`[data-share-expires]` 在浏览中撤销后残留），不在 T-27 文件白名单内，见 §5 L1。

---

## 1. Fog-2 注入的真实行为（派单点名要回答的那条）

**结论：`route.fetch()` 之后 `route.abort('failed')` 合法，一次通过，无任何降级。**

TDD 顺序如派单：先落 `visitor-session-replay.spec.js`（红 —— `SyntaxError: The requested module '../fixtures/share.js' does not provide an export named 'dropFirstResponse'`），再落 helper 转绿。

实测行为逐条：

| 观测 | 结果 |
|---|---|
| `route.fetch()` 后 `route.abort('failed')` | **不抛异常**。route 在 `fetch()` 之后仍是未处置态，与 `types.d.ts:20978` 的 "without fulfilling it" 一致 |
| `route.fetch()` 是否额外触发 `page.on('request')` | **不触发**。`state.requests.length` 恰为 **2**（第一发 + 重试），不是 3 或 4。所以「浏览器可见 POST 计数」与「route 命中计数」在本例中同为 2，但计数仍取前者 |
| 第一发是否真到 worker | 是。`firstBody.data.sessionToken` 有值，且该 token 正是最终落进 `sessionStorage['share:session:<lid>']` 的那一枚 |
| `Idempotency-Key` 是否同 key | 是。两次 `req.headerValue('idempotency-key')` 相等且非空（`ensureEstablishKey` 在请求发出前写 sessionStorage，重试读回同一枚） |
| 配额 | `GET /mailShare/get` → `usedSessions === 1`，`maxSessions: 1` 下重试走的是 KV 重放缓存，不是第二次签发 |

**R1 退路（`fulfill({status:599})`）未被触发，不需要回主 AI 重裁。** `isLostResponse` 一个字节未改。

---

## 2. 测试计数

| 套件 | 命令 | 结果 |
|---|---|---|
| E2E 基线（改动前实跑） | `node tests/e2e/run.mjs` | **13 passed / 0 skipped** |
| E2E 终态 | `node tests/e2e/run.mjs` | **19 passed / 0 skipped**（13 + 6） |
| mail-vue | `pnpm --dir mail-vue test -- --no-cache` | **22 files / 250 passed**（与派单基线一致） |
| mail-worker | `pnpm --dir mail-worker test -- --no-cache` | **18 files / 626 passed**（与派单基线一致） |

> **T-28 基线口径修正**：`visitor-headers.spec.js` 在本机 **没有 skip**，实测是 passed。侦察 §1 写的「13 passed + 1 skipped」在当前环境不成立；T-28 应把新基线写成 **`19 passed / 0 skipped`**，不要预期任何 skip。

新增 6 条 `test()`（每文件恰 1 条）：

| 文件 | AC |
|---|---|
| `visitor-multi-mailbox.spec.js` | AC-OTP-04 · AC-CAP-02 · AC-SEC-01 |
| `visitor-session-quota.spec.js` | AC-SESS-04 · AC-SESS-07 |
| `visitor-session-replay.spec.js` | AC-SESS-10 |
| `visitor-revoke-live.spec.js` | AC-EDGE-03 |
| `visitor-authkey.spec.js` | AC-AUTH-01 · AC-SEC-09 |
| `capability-v2-fence.spec.js` | AC-LIFE-11 + AC-LIFE-10 路径④（薄） |

---

## 3. 环境事故（会污染任何人的复跑，必须交接）

复跑时端口 8788 上**挂着一个 T-26 留下的 wrangler 进程**，其命令行是：

```
wrangler dev --config .../wrangler-e2e.toml ... --var SHARE_CAPABILITY_V2:1
```

`playwright.config.js:27` `reuseExistingServer: !CI` 会**复用**它。也就是说，在我发现之前的每一次 e2e（含 13 条基线复跑）都跑在 **V2 恒为 true** 的 worker 上——`setCapabilityV2(true)` 是否生效根本无从判断。

处置：按 PID `kill 821177 820936`，并把 `.mf-state` 移走（备份在 `/tmp/mf-state-backup-*`），让 `harness/start.mjs` 用真配置冷启 + 全新 D1 重跑。**冷启后仍 19 passed**，schema init 与第二个 account 的幂等建都走通了首次创建路径。

随后做了一次**反证**以确认「默认 off」不是幻觉：把 `visitor-multi-mailbox.spec.js` 的 `setCapabilityV2(true)` 临时注掉重跑 →

```
Error: create share failed: {"code":501,"message":"SHARE_INVALID_CONFIG"}
```

即 `wrangler-e2e.toml` 缺省下 V2 确实关闭，`capabilityV2Override` 是 load-bearing 的。临时改动已还原（`grep TEMP-PROOF` 零命中）。

> **给 T-28 的一条硬提示**：复跑前先 `ps` 查 8788，任何带 `--var` 的残留进程都要先按 PID 杀掉，否则拿到的是假绿。

---

## 4. 实现与派单/侦察的偏差（三处，均已在代码注释里自述）

| # | 偏差 | 原因 |
|---|---|---|
| D1 | `dropFirstResponse(page)` 没有 `urlGlob` 形参 | `postSession` 是 `POST /share/session` 的唯一出口（侦察 §11），一个可配 glob 的形参没有第二个调用点，且会让「浏览器可见 POST 计数」的过滤谓词与 glob 分叉成两份口径。ponytail：删掉 |
| D2 | 多邮箱 spec 的 URL 断言改成 `new URL(...).pathname === '/s/<lid>'` 等式，**没有**写 `not.toContain(accountId)` | 侦察 §8.1 那条写法是错的：`accountId2 = 2`，而 URL 里恒含 `127.0.0.1` —— `'…127.0.0.1…'.includes('2')` 为真，断言必然假红。等式比子串搜索更强：路径恰为 lid，本身就证明了「无 account id / 无地址 / 无 sec」 |
| D3 | AC-SEC-09 的请求头审计**放行 `Authorization`** 携带 sessionToken | AC-SEC-09 原文（requirements.md:180）限定的是「服务端日志、URL 查询串、`Referer` 可见位置」，Bearer 头正是 token 的既定载体。侦察 §8.5 的「任何请求头不含三者」若照字面写会与 `share-api.js:41-45` 的契约直接矛盾。落地断言：`sec` / authKey 在**任何**头里都不得出现；sessionToken 只允许出现在 `authorization`；`referer` 三者皆不得含；URL（含 query）三者皆不得含 |

另有一条**侦察未预见的时序硬约束**（不是偏差，是新事实）：

- 角标断言的前置不是 `ready`，而是**第一帧 status 已落地**。`reconcile`（`status-watermark.js:70-86`）是在**首次看见某 Binding 的那一帧**把水位播种到当前队头，而首帧 `pollTick` 发生在 `ready` 之后一个轮询间隔（3s）。侦察 §8.1 写的「先 ready 再投递」不够——实测在 ready 之后立刻投递，邮件被卷进基线，`share:status:` 直接落成 `{"502":0,"503":441}`，角标恒不出现（已复现并定位）。
- 落地闸门：`page.waitForFunction(lid => sessionStorage.getItem('share:status:'+lid) !== null)`，即「首帧 status 已写盘」，然后才投递。`visitor-revoke-live.spec.js` 也用同一道闸门，好让「`share:status:` 仍在」断言的是**存活**而不是**从未写过**。

---

## 5. 遗留风险 / 开项

| # | 级别 | 内容 | 处置建议 |
|---|---|---|---|
| **L1** | **P2 · 生产缺陷（新发现）** | **浏览中撤销后，倒计时残留**：`showDeadShare` → `clearMailboxView`（`index.vue:660-671`）清了 session / est-key / mails，但**没清 `expiresAt`**，于是 `expiresLabel` 继续渲染 `[data-share-expires]`。结果：撤销中途的页面显示「Link expires in 1h 0m」，而随机 lid 的不可用页没有这一行 —— 两个外壳**不字节相同**，撤销态因此可与「lid 从不存在」区分开（AC-EDGE-03 / AC-VISIT-04 的外壳一致性有缺口）。`visitor-unavailable.spec.js` 照不到这个洞：它每次都是**重新导航**进不可用页，`bootstrap` 会把 `expiresAt` 重置成 `''` | 修法是 `clearMailboxView()` 里加一行 `expiresAt.value = ''`（`mail-vue/src/views/share/index.vue`）。**T-27 文件白名单禁改 mail-vue，故未修。** `visitor-revoke-live.spec.js` 因此断言的是「消息行 + body + 活体元素计数」三元组相等，而**不**把倒计时残留 pin 成期望值 —— 将来修好了这条 spec 不会转红。建议开一条 T-29 前置或独立 P2 |
| L2 | 已知限制 | `capabilityV2Override` 是 worker 进程内的模块级全局态 | `playwright.config.js` `fullyParallel:false` + `workers:1` 保证无并发；已在 `tests/e2e/README.md` 写明「workers 必须保持 1」 |
| L3 | 已知限制 | AC-SEC-09 的「服务端日志无 sec/authKey/token」半句 e2e 覆盖不到 | `start.mjs:31` 的 wrangler 子进程是 `stdio:'inherit'`，playwright 拿不到 stdout。由 `mail-worker/test/mail-share-service.spec.js` 的 `logShareEvent` 字段白名单单测承担；`visitor-authkey.spec.js` 文末注释已指过去 |
| L4 | 已知限制 | AC-LIFE-10 路径④的「随机路由新旧 Worker」未在 e2e 造 | 依 Fog-3 裁决：命题是写入侧全称否定，已被 `share-integration.spec.js:1148` / `mail-share-service.spec.js:3096` 钉死；仓库只有一个 worker 入口。`capability-v2-fence.spec.js` 文件头注释已写明这一点与第五条 `message_limit` 的归属 |
| L5 | 环境 | `.mf-state` 已被移走重建（旧的在 `/tmp/mf-state-backup-*`） | 第二个 account（`MAILBOX_2`）与第一个同为「先 SELECT 再 INSERT」的幂等形状，跨 run 与首建两条路径都实跑过 |
| L6 | 交接 | 新 spec **零文案字面量断言** | 文本比较只有两类：页面文本 vs 页面文本（`visitor-revoke-live`）、数据来源值（`OTP_CODE_2` / 邮箱地址）。T-29 落 10 个 i18n 键后不应打红；落键后仍须复跑 e2e |

---

## 6. 改动清单（严格在白名单内）

```
 tests/e2e/README.md               |  2 ++
 tests/e2e/fixtures/share.js       | 49 +++++++++++++
 tests/e2e/harness/constants.js    |  3 +++
 tests/e2e/harness/control.js      | 27 +++++++++
 tests/e2e/harness/worker-entry.js | 45 +++++++++++----
 + 6 个新 spec 文件
```

门禁实测（均为空）：

```
git diff --stat mail-vue mail-worker/src mail-worker/wrangler.toml tests/e2e/wrangler-e2e.toml     → 空
git diff --stat -- specs/visitor-otp-copy.spec.js specs/visitor-session.spec.js specs/visitor-unavailable.spec.js → 空
```

`run.mjs` / `playwright.config.js` / 既有 12 个 spec 文件均未出现在 `git status` 中。

新增的 harness 面（既有导出与方法行为零改）：

- `worker-entry.js`：`capabilityV2Override` + `envWithSessionTtl` → `envWithOverrides`（**同一个** Proxy，两 override 皆 `null` 才透传）+ `POST /__e2e__/capability-v2` + `/seed` 复位 + seedOwner 的第二个幂等 account（返回值只增 `accountId2` / `mailbox2`）
- `control.js`：导出 `api`、新增 `setCapabilityV2(on)`（写 `'true'` / `'false'`，不用 `null` 表示关）、`getShare(seed, shareId)`
- `constants.js`：`MAILBOX_2` / `OTP_CODE_2`
- `fixtures/share.js`：`newVisitor(browser)` / `dropFirstResponse(page)` / `recordApiRequests(page)`；七个既有导出一字未动

## Update Log

- 2026-08-24 · T-27 落地。Fog-2 注入一次通过（`fetch()` + `abort()` 未被拒）；Fog-1 默认 off 已反证；Fog-3 薄栅栏四路全绿。E2E 13 → 19。发现 L1 撤销后倒计时残留（生产缺陷，未修，超出白名单）。
