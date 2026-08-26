# RCA · 分享链接过期后前端状态不刷新

Mode A · Cloud Agent 自主执行。Charter 闸门未触发（mailbox-share-capability 已 shipped，本轮是整改）。

### 🔴 1. Phenomenon & Context

- Observed：分享链接过期后，Owner 前端状态不会自动更新；即使用户以为「刷新了页面」，列表/徽章仍显示 ACTIVE；只有重新登录后才变成 EXPIRED。
- **Success state**: NOT「组件再调一次 list」，BUT Owner 刷新浏览器或回到收件箱/分享管理页即可看到最新过期状态，且停在页上直到过期时刻徽章也会翻成过期；不该再依赖重新登录。来源：用户原话。
- **Phenomenon lock-down**: 同一条 `expires_at` 已过的分享，Owner 不重新登录时，收件箱徽章与分享管理列表仍展示 ACTIVE；重新登录后展示 EXPIRED。

### 🔍 1.5 Hypothesis Ledger

| ID | Hypothesis | Status | Falsify/Confirm evidence | Updated |
|----|------|------|------|------|
| A | 后端 list 把过期行仍标 ACTIVE（过期比较写错时区或未算 effectiveStatus） | 🔴falsified | `mail-share-service.js` list 用 `nowText()` UTC 裸串 + `OWNER_STATUS_CASE`；Owner API `Cache-Control: no-store` | 2026-08-26 |
| B | HTTP/CDN 缓存了 list 响应 | 🔴falsified | `mail-share-api.js` list 已 `no-store`；浏览器硬刷新仍旧 → 不是缓存层 | 2026-08-26 |
| C | 前端 keep-alive + 只在 onMounted 拉数，且客户端从不按 expiresAt 覆盖 | 🟢confirmed | `layout/main/index.vue` include `'email'`；`ShareIndicator.vue` 只 `onMounted`/`watch accountId`；展示用 `row.effectiveStatus` 原样；重登拆 Vue 树才再挂载 | 2026-08-26 |

### 🔍 2. Root-Cause Analysis

- Why it must fail：收件箱页 `defineOptions({ name: 'email' })` 在 keep-alive 内。侧栏再点收件箱或邮件列表内部刷新不会走 `onMounted`。`ShareIndicator` 把 API 的 `effectiveStatus` 当死值，没有 `onActivated` / visibility / 本地 `expiresAt` 降级 / 秒级 tick。
- First Broken Point: `mail-vue/src/views/email/ShareIndicator.vue` activeCount 过滤与生命周期。
- Bug class: Cache/State Pollution（前端状态生命周期，不是 HTTP 缓存）

### 🕵️ 3. Variant Scan

- Internal: `ShareDialog.vue` 只在打开时 `loadList`；`share-admin/index.vue` 不在 keep-alive 但停页不 tick；`ShareDetailDrawer.vue` / `ShareRowActions.vue` 同样信 `effectiveStatus`。
- External: Immich PR「reactively update shared link expiration」；过期比较必须把 `YYYY-MM-DD HH:mm:ss` 当 UTC。
- Fingerprint: 「只信一次 API 快照、不按 expiresAt 本地覆盖」——四处展示面同一修。

### 👥 4. Real-World Scenario Simulation

1. keep-alive 再进收件箱 → `onActivated` 回源 list。
2. 停在页上跨过 expiresAt → 1s tick + `liveEffectiveStatus`。
3. 真浏览器刷新 → 重新挂载 + 回源；客户端覆盖兜底时钟偏差。
- 已知不处理：后台 tab 被冻结时 interval 可能暂停，靠 visibility/focus 回源。

### 📚 5. Industry Reference

- tool: tavily/exa recon（会话内）· query: `vue keep-alive onActivated stale status expiresAt` · 结论：keep-alive 必须 `onActivated` 再取数；过期是时间谓词，客户端可在权威 `expiresAt` 上覆盖。

### 🛠️ 6. Surgical Fix

- SSOT：`status.js` 增加 `expiresAtUtcMs` + `liveEffectiveStatus`（REVOKED > 本地过期 EXPIRED > API effectiveStatus）
- 接线：ShareIndicator / ShareDialog / share-admin / ShareDetailDrawer / ShareRowActions
- 刷新：`onActivated`、`visibilitychange`、`focus`；email 页 `onActivated` 调 `shareIndicator.refresh()`
- 不改后端 list 算法。

### ⚠️ 7. Blast Radius

- 展示面徽章/标签/可写判定；revoke 按钮在 EXPIRED 仍可用（持久化仍是 ACTIVE）
- 回归：`status.spec.js`、`ShareIndicator.spec.js`
- 最终 sink：收件箱徽章 + 分享管理卡片 `data-status` + 详情徽章
- e2e 姿势：造短 TTL 分享，刷新 Owner 页看 EXPIRED（本轮用 vitest 冻结时钟证明）

### 🧩 8. Boundary Reinforcement

客户端过期覆盖成为 Owner 展示 SSOT；服务端仍是写入/鉴权权威。

## 任务清单

- [ ] P1 liveEffectiveStatus + 刷新触发
  - — PENDING: 实现须等决策卡 spec-cross-review 过筛后由 executor 按审过正文收口；工作区半成品不是完成证据
- [ ] P3 删除关闭确认（权威清单在决策卡）
- [ ] P2 emails 创建（权威清单在决策卡）
- [ ] P4 原生 404（权威清单在决策卡）
- [ ] P5 访客 UI（权威清单在决策卡）

## Update Log

- 2026-08-26 · 落盘 RCA；根因锁定为前端 keep-alive/无本地过期覆盖。
