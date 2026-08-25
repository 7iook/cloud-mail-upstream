# T-20a · 管理台「重新生成分享链接」前端入口 · 执行记录

作者：executor SUB · 2026-08-25 · 基线 HEAD `3a3346a`

## 交付契约（逐字抄录，未改写）

> 成功状态: NOT「抽屉里多了个按钮」, BUT 管理员发现分享链接可能外泄、或者自己弄丢了，能在管理台当场换一条新链接继续用 —— 有效期、可见邮件范围、各项配置全部原样保留，不必删掉重建再重新配一遍；而且他在点下去之前就清楚知道：旧链接会立刻作废，正在看的人会当场断开。
> 不该发生: 没有二次确认就踢掉在途访客 · 新链接一闪而过没给机会复制。
> 来源: 决策卡 §1.4 轨二 · ADR-share-credential-recoverability

### 链路逐格核实

| 节点 | 契约声明 | 核实结果 |
|---|---|---|
| 入口 | `ShareDetailDrawer.vue`（待建） | 已建：`link-regenerate` 按钮 + `link-once` 一次性明文块（`ShareDetailDrawer.vue` 「分享链接」panel） |
| 请求层 | `regenerateMailShare()`（待建） | 已建：`mail-vue/src/request/mail-share.js`，`POST /mailShare/regenerate` + `Idempotency-Key` 头 |
| 端点 | `POST /mailShare/regenerate` 后端已就绪 | 核实通过：`mail-worker/src/api/mail-share-api.js:62`，服务实现 `mail-share-service.js:1534` |
| 响应 | 含新 `lid`/`sec`/`shareUrl` | 核实通过：`firstCreateResponse()`（`mail-share-service.js:522-537`）返回 `{shareId, lid, sec, expiresAt, shareUrl, shareType, bindings}` |
| 最终 sink | 管理台详情抽屉里管理员手里的新链接 | 一个只读 input（`link-url`）+ 复制按钮（复用 `useCopyWithFallback`）+「我已保存」确认 |

## 我核实到的后端契约（与转述的出入）

转述基本准确，两点需要写清楚：

1. **`Idempotency-Key` 不只是「可选」，它决定重试语义**。`regenerate` 的幂等指纹只含 `shareId`（`mail-share-service.js:1541`），不带 Key 时每次调用都真的换一次链接。所以前端在调用方没给 Key 时自己铸一个（`newIdempotencyKey()`），且**两次点击必须是两把不同的 Key** —— 同 Key 会被判成重放，第二次轮换会被静默跳过。已写成用例 `mints its own Idempotency-Key when the caller supplies none`。
2. **响应是 create 形状，不是 detail 形状**。它没有 `name` / `effectiveStatus` / `authKeyEnabled`，所以**不能**像 AuthKey 那样喂给 `applyDetail()` —— 那会把抽屉表头清空。实现改为「拿走 `shareUrl` → `emit('changed')` → 重读 `getMailShare()`」，与 bindings 写入后重读同一条理由（响应形状不足以还原详情）。用例 L4 钉住这条。

状态门（仅 ACTIVE 可调，EXPIRED/REVOKED 拒）与「`expires_at` 不变」在后端确认无误；前端复用抽屉已有的 `writable` 让入口在这两个状态下直接不可用，不依赖后端兜底。

## 二次确认文案的措辞理由

采用（zh）：

> 旧链接会立刻作废，正在查看的访客会当场断开，需要你把新链接发给他们。有效期与可见邮件范围保持不变。

三点考量：

- **说出管理员事后无法自行发现的两件事**：旧链接死亡 + 在途访客断线。只问「确定要重新生成吗」等于让他在不知道会断线的情况下按下去，正是契约「不该发生」的第一条。
- **说出「不会变的东西」**：管理员犹豫的真实原因往往是「会不会连有效期和配置一起丢」。挑明「有效期与可见邮件范围保持不变」，才让他敢按，而不是退回删掉重建。
- **给出他接下来必须做的动作**（「需要你把新链接发给他们」），而不是只描述后果 —— 断线之后的补救责任在他手上。

英文版含 "old link" 与 "disconnected"，用例 L2 用正则钉住这两个语义点，防止后续被改写成空洞的 "Are you sure?"。

## 红 → 绿

**基线**（改动前）：

```
Test Files  23 passed (23)
     Tests  293 passed (293)
```

**红**（先写测试、实现为空）：

```
Test Files  2 failed | 21 passed (23)
     Tests  15 failed | 290 passed (305)
```

失败原因均为「入口/导出不存在」（`link-regenerate` 找不到、`regenerateMailShare` 未导出），即功能缺失，非语法错误。

**绿**（实现后）：

```
Test Files  23 passed (23)
     Tests  305 passed (305)
```

新增 12 条：请求层 2 条 + 抽屉 10 条（L1–L10）。原有 293 条一条未减。

### 用例覆盖对照

| 要求 | 用例 |
|---|---|
| ACTIVE：点击 → 确认 → 调用 → 新链接展示且可复制 | L1、L6 |
| 取消确认 → 不发请求 | L3 |
| EXPIRED/REVOKED → 入口不可用 | 写谓词组 S1（`link-regenerate` 已加入 `WRITE_HOOKS`，并断言 `regenerateMailShare` 未被调用） |
| 业务错误上屏（含未识别码兜底） | L7（`SHARE_CAPABILITY_NOT_ENABLED`）、L8（未知码兜底，对应 R10 思路）、L9（`SHARE_NOT_FOUND` → 关抽屉刷列表） |
| 新明文不落 storage / pinia / URL | L5（只存在于一个只读 input；断言 localStorage/sessionStorage/`location.href` 均不含 sec；「我已保存」后彻底消失） |
| 额外：过期时间不被改动、响应形状不污染详情 | L4 |
| 额外：切换分享后迟到的轮换响应不串号 | L10 |

## 变异验证

| 变异 | 结果 |
|---|---|
| 去掉二次确认（`askRegenerate` 直接调 `submitRegenerate`） | 红 3 条：L1 / L2 / L3（`Tests  3 failed \| 57 passed (60)`） |
| 去掉错误兜底（末支只 `console.error`，仅保留 capability 分支） | 红 1 条：L8（`Tests  1 failed \| 59 passed (60)`） |

**还原后复跑（全量）**：

```
Test Files  23 passed (23)
     Tests  305 passed (305)
```

## Review Findings

- **无方向性偏差，按派发任务执行**。契约转述与真实代码一致，两处需要补充精度的地方已在上文「我核实到的后端契约」列出（幂等 Key 的重试语义、响应是 create 形状而非 detail 形状），均属 Tier 1 自行修正：证据来自代码本身，不需要谁做决定。
- **越界检查**：只改了独占的 4 个文件 + 2 个 spec（`ShareDetailDrawer.vue` / `.spec.js`、`request/mail-share.js` / `.spec.js`、`i18n/zh.js`、`i18n/en.js`）。`mail-worker/` 全程只读，未改动一个字节。
- **`useCopyWithFallback` 实例化了第二份**（`copyLinkText` / `linkSelectableRef`）。不是新写复制逻辑，是同一个 SSOT composable 的第二个实例：AuthKey 与新链接两个一次性明文块可能同时在屏，一个 `selectableRef` 无法同时指向两个 input。
- **`ShareDetailDrawer.vue` 里的 `PENDING_COPY` 兜底表已经过时**（T-28/T-29 的 i18n key 早已落地，`te()` 全部命中真翻译）。本包新增的 6 个 key 直接进 zh/en，未再往 `PENDING_COPY` 里加。这张表现在是纯死码，建议后续包整体删除 —— 本轮不动它，因为删除会改到与本包无关的所有既有 key 的取值路径，超出独占范围。
- **未做**：「查看已有分享的完整链接」入口（依赖尚未落地的解密端点，按约定属后续包）。
- 未提交、未 stash。

## Update Log

- 2026-08-25 · executor · 落地管理台「重新生成分享链接」入口（抽屉 UI + 请求层 + zh/en 文案），红 15 → 绿 305，两项变异验证均真红并已还原复跑。证据见上文。commit: pending。
