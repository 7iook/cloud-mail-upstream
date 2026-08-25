# T-22b-1 有效期后端:兜底上限(I-2)+ 续期 · 执行记录

- 执行者:executor(sub)
- 日期:2026-08-25
- 起始 HEAD:`632a931`
- 状态:**已完成,未提交**(按派单要求不 commit、不 stash)

## 成功状态(原文抄录,不改写)

> ① 任何部署下都不可能创建出超过系统上限的分享 —— 包括运维忘了配环境变量的部署(那正是当前生产的状态)
> ② 管理员看到一条分享快到期,能直接把它延长,链接不变、已经拿着链接在看的访客不受影响,不必删掉重建再重新分发一次。
> 不该发生:反复续期把一条分享续成事实上的永久分享 · 已过期或已撤销的分享被"续"活。
> 来源:用户裁决(2026-08-25「续期纳入本轮」)+ 决策卡 §1.5 不变量 I-2 + §6 第 2 项

### 链路逐格核验

| 节点 | 派单给的锚点 | 实际 | 结论 |
|---|---|---|---|
| 上限 · 读配置 | `mail-share-service.js:269-275` | `:253-259`(`maxDurationSeconds`) | 行号漂移 6 行,函数与语义一致 |
| 上限 · 校验 | `:338-342` | `:322-326`(`assertCreateBody`) | 同上,已存在 |
| 续期 · 白名单 | `UPDATE_FIELDS:935-944` | `:919-928` | 同上,已存在 |
| 续期 · 路由 | `PUT /mailShare/update` | 已存在,`update()` 落在 `:1257` | 已用真实 HTTP 打通(见证据 §3) |
| 最终 sink | D1 `mail_share.expires_at` / `delete_at` | 一致 | 两列均已实测落库 |

行号漂移属 Tier 1 自纠(代码本身能定位),已按实际行号执行。

## 1. 红(feature missing)

命令:`pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js`

```
Tests  8 failed | 229 passed (237)
EXIT=1
```

8 条红全部因"能力不存在"而红,不是语法/导入错:

| 红用例 | 报错 |
|---|---|
| `falls back to the built-in 90-day ceiling when SHARE_MAX_DURATION_SECONDS is absent (I-2)` | `expected BizError`(缺配置时当前代码放行) |
| `extends expires_at and carries delete_at along...` | `expires_at` 未变(白名单不含该键) |
| `accepts the ISO form the API hands out and stores it canonically` | 同上 |
| `measures the renewal ceiling from create_time, not from now (I-2)` | `expected BizError` |
| `stops the second renewal once the ceiling from create_time is used up (I-2)` | `expected BizError` |
| `rejects a non-future or malformed expiresAt` | `expected BizError` |
| `allows shortening the window and pulls delete_at back with it` | 实得 `2026-09-24`(原值未动),期望 `2026-08-27` |
| `renews together with the other whitelisted fields in one statement` | `expires_at` 未变 |

另有 2 条新增用例开箱即绿,它们是**守卫**不是红→绿驱动,如实记录:
`lets an explicit SHARE_MAX_DURATION_SECONDS raise the ceiling above the fallback`(钉"兜底不得压掉显式配置")、
`refuses to resurrect an expired or revoked share by renewing it`(状态门本就由 `loadMutableShare` 把住,续期只是继承)。

## 2. 绿

```
pnpm --dir mail-worker test
Test Files  18 passed (18)
     Tests  654 passed (654)
EXIT=0
```

基线 636 → 654,只增不减。其中本包 **+12**(`mail-share-service.spec.js` 227 → 239);
余下 +6 来自并行执行者对 `share-auth-service.spec.js` 的配额计数改动,不在本包。

> 中途一次全量跑曾出现 `share-auth-service.spec.js (65 tests | 1 failed)`,随后两次全量跑均全绿。
> 该 spec 与本包零交集(本包未引用、未修改 `share-auth-service.*`,`SHARE_MAX_DURATION_SECONDS` 也不出现在该 spec 里),
> 判为并行执行者写盘途中被读到的瞬时态。`unverified: 未复现,未进一步归因`。

## 3. 交付契约要求的"真跑一次"姿势

契约原文:`不配 SHARE_MAX_DURATION_SECONDS 起 worker,创建 91 天分享应被拒;创建一条短期分享后调 update 延期,确认 lid/sec 未变、expires_at 前移、delete_at 同步顺延`。

拆成两条**真实 HTTP 面**的断言,都在 CI 里每次跑:

1. **`test/share-api.spec.js` · `rejects owner create above the built-in ceiling with nothing configured`**
   —— 该 worker 的 env 现在**真的没有** `SHARE_MAX_DURATION_SECONDS`(见 §5 夹具调整),
   `POST /mailShare/create` 送 91 天,实得 `SHARE_DURATION_EXCEEDED`。这就是"运维忘了配"的部署形态。
2. **`test/mail-share-service.spec.js` · `renews over the real HTTP route without dropping a live visitor (T-22b-1b)`**
   —— 建分享 → 访客 `POST /api/share/session` 拿到 sessionToken → 业主 `PUT /mailShare/update` 续到 60 天 →
   断言 `lid` 未变、`credentials_version` 仍为 0、`delete_at > expires_at`、**续期前发出的 sessionToken 续期后 `GET /api/share/mails` 仍返回 200**;
   同一条路由上续到 91 天被 `SHARE_DURATION_EXCEEDED` 拒,且 `expires_at` 保持在 60 天那个值。

`unverified: Playwright e2e(tests/e2e/run.mjs)未跑` —— 它要装 chromium + 重新 build mail-vue,
而本包被明令不得碰 `mail-vue/`,且 `tests/e2e/specs/capability-v2-fence.spec.js` 当前是并行执行者的在飞改动,
此刻跑它读到的不是干净基线。`wrangler-e2e.toml` 的姿势已按契约改成"不配"(§5),留给下一个能跑 e2e 的包验证。

## 4. 实现要点

### T-22b-1a 兜底上限

- 新增 `MAX_DURATION_FALLBACK_SECONDS = 7776000`(90 天),`maxDurationSeconds()` 缺失时返回它而不是 `null`。
- `assertCreateBody` 里的 `maxDuration != null &&` 短路随之删除 —— 留着就是一条永假分支,
  也是下一个人误以为"仍可能无上限"的来源。
- 非数字 / `0` / 负数与"没配"同义,走同一条兜底。**没有任何输入能把上限解除。**
- 错误码沿用 `SHARE_DURATION_EXCEEDED`,未新增码。

### T-22b-1b 续期

- `UPDATE_FIELDS` 末尾加 `{ key: 'expiresAt', column: 'expires_at', read: toPatchExpiresAt }`。
- `toPatchExpiresAt` 只管值域:形状锁死 `YYYY-MM-DD HH:mm:ss`(容许 `T` 分隔、结尾 `Z`),
  **拒带偏移量的写法**(`+08:00`)—— 本模块所有裸串恒按 UTC 解析,放行偏移量等于允许写入方按本地时区提交、
  读取方按 UTC 解释,一次静默的 8 小时错位;末尾做格式化往返比对,挡掉 `2026-13-45` 这类被 dayjs 悄悄滚成合法时刻的输入。
- 新增 `applyRenewal(c, patch, share)` 承担两条**需要行上下文**的判据 + 派生 `delete_at`:
  - 上限判据 = `新 expires_at - create_time ≤ maxDurationSeconds(c)`,**基准是 create_time**;
  - `expires_at` 必须仍在未来;
  - `delete_at = 新 expires_at + retentionSeconds(c)`,与 create 侧同式。
- `loadMutableShare` 的 SELECT 加 `create_time`(该 helper 同时服务 updateBindings / resetAuthKey,加列无副作用)。
- `update()` 顺序改为 值域(normalize)→ 上限(applyRenewal)→ 栅栏(assertUpdatePatch),与 `assertCreateBody` 同构。
- `lid` / `sec_hmac` / `credentials_version` 一列未动 —— 它们本就不在白名单里,续期没有给它们开任何口子。

### 逐条对照派单的 5 条硬约束

| # | 约束 | 落地 |
|---|---|---|
| 1 | 上限从创建时刻起算 | `applyRenewal` 用 `share.create_time` 做基准;两条用例钉死(单次超限 + 连续两次续期用尽额度) |
| 2 | `lid`/`sec`/`credentials_version` 不变 | 白名单不含,HTTP 用例实测 `cv=0`、旧 sessionToken 续期后仍可取信 |
| 3 | `delete_at` 同步顺延 | `applyRenewal` 派生,进同一条 UPDATE;用例断言 `delete_at - expires_at == 保留期`,并断言 SQL 里确有 `delete_at = ?` |
| 4 | 仅 ACTIVE 可续,EXPIRED/REVOKED 拒 | 复用 `loadMutableShare`(与 `resetAuthKey` 同一把门),共用 `SHARE_NOT_FOUND`;见下方偏差记录 |
| 5 | 缩短是否允许 | **允许**,理由见下 |

### 缩短有效期:允许(裁决 + 理由)

允许,但要求新时刻仍在未来。

- 缩短与 revoke 同向 —— 只收窄暴露面,不放大任何权限。禁止它只会把管理员推回"删掉重建再重新分发一次",
  恰是本轮要消灭的那个动作。
- 划在"必须仍在未来"上,是因为**落在过去是一次不可逆的自锁**:行立刻变 EXPIRED,
  而 EXPIRED 行连 `loadMutableShare` 都过不去,管理员再也改不回来。要立即失效应走 revoke,
  那条路径才会写 `revoked_at` 并递增 `credentials_version`(直接把到期时间改到过去则两者都不会发生,
  在飞会话反而不会被踢——语义完全错位)。
- 错误码分工:过去时刻 / 形状非法 → `SHARE_INVALID_CONFIG`(值域);超上限 → `SHARE_DURATION_EXCEEDED`(上限)。

## 5. 被改动的测试夹具:原测试意图 + 为什么这样调

**没有为了变绿删断言或放宽夹具。** 四处改动逐条说明:

### ① `test/mail-share-service.spec.js` · `leaves lid, sec, expiry, AuthKey, cv ... untouched (AC-AUTH-07)`

- 原意图:白名单之外的任何键都不得改写凭据列 / 生命周期列 —— 往 update 里塞一袋"劫持尝试"参数,断言 15 列纹丝不动。
- 调整:仅从那袋参数里**移除 `expiresAt` 这一个键**,其余 14 个键与全部 15 条列断言原样保留。
- 为什么:`expiresAt` 现在是白名单里的合法字段,继续留在"劫持袋"里就是在断言一个已被裁决推翻的契约
  (而且值 `2099-01-01` 会直接撞上限抛错,那更不是这条用例要测的东西)。
  **蛇形别名 `expires_at` 特意留在袋里** —— 白名单只认驼峰键,别名仍然必须是死路,
  否则等于给同一列开了第二个未经校验的入口。续期本身的行为由新增的 8 条用例独立覆盖。

### ② `mail-worker/wrangler-vitest.toml`:删除 `SHARE_MAX_DURATION_SECONDS = "86400"`

- 原意图:给测试 worker 一个有效期上限,好让 HTTP 层能断言"超长有效期被拒"。
- 调整:整行删除(留注释说明为何刻意不配)。
- 为什么:这个 worker 的 env 就是"生产实际长什么样",而**生产 `wrangler.toml` 从来没写过这一项**。
  配着 86400,HTTP 层永远跑不到兜底路径,I-2 在真实入口上就没有观测点。删掉之后:
  原断言"超长被拒"完整保留,只是从证明"配了才拒"升级为证明"没配也拒" —— 正是本任务的成功状态 ①。
  而"显式配置被尊重"这一面,由 `rejects duration above the configured max`(env 覆写 `'60'`)与
  `lets an explicit ... raise the ceiling above the fallback`(env 覆写 120 天)两条直调用例覆盖,没有丢。
- 连带:`test/share-api.spec.js` 那条 HTTP 断言的 `durationSeconds` 从 `999999`(≈11.6 天,原本靠 86400 才拒)
  改为 `91 * 24 * 3600`,并改名为 `rejects owner create above the built-in ceiling with nothing configured`。
  **这个文件不在派单的独占清单里** —— 见 §7 越界说明。

### ③ `tests/e2e/wrangler-e2e.toml`:删除 `SHARE_MAX_DURATION_SECONDS = "86400"`

- 原意图:同 ②,从 vitest toml 抄过来的一份"像样的 env"。
- 调整:整行删除。
- 为什么:e2e 的价值就在于跑真实部署形态,而真实部署没有这一项。全仓 e2e 只创建 3600 秒的分享
  (`harness/control.js:123`、`specs/capability-v2-fence.spec.js:20`),没有任何 e2e 断言依赖 86400,删除零影响。

### ④ 未改动:`test/account-delete-share.spec.js:38` 与 `test/mail-share-service.spec.js:38` 的 `'86400'`

- 原意图:两个 spec 的 `shareEnv()` 夹具给直调服务的用例一个确定的上限,让所有 `durationSeconds: 3600` 的
  常规用例跑在一个明确、稳定的配置下。
- 为什么不动:它们是**显式配置**的代表样本,而显式配置的语义本轮完全没变(配了就以配置为准)。
  改成不配只会让这批用例悄悄改跑兜底路径,削弱"显式配置这条路仍然有效"的覆盖。
  同理 `test/mail-share-service.spec.js:306` 覆写 `'60'` 的那条也原样保留 —— 它钉的正是这一面。
- 续期用例需要更宽的窗口来观测"上限从 create_time 起算",所以在 describe 内单独定义了
  `renewCtx()`(= `ctx({ SHARE_MAX_DURATION_SECONDS: undefined })`),而不是去动共享夹具。

## 6. `wrangler.toml` 的选择:**保持注释,不显式写出**

- 派单提示的 `:58-60` 既有警告经核实在 `:72`(`SHARE_CAPABILITY_V2` 那条):
  **`keep_vars` 拦不住 toml 里显式写的值,写进去会覆盖 Dashboard**。
- 选择:不取消注释。理由是这一项写进 toml 会把运维在 Dashboard 上调好的上限硬压回仓库里的字面量 ——
  "显式化"的收益此刻已经消失了:**兜底落地之后,"缺失"不再等于"不设防"**,
  §侦察表 #4 建议"显式写出"的那个前提(缺失 = 无上限)本身已被本包消灭。
- 但注释是**事实错误**必须改:原文写"不填即【分享有效期无上限】(代码返回 null 时跳过校验)",
  已改为"不填即走代码内置兜底上限【90 天】",并补上 keep_vars 那条与 `SHARE_CAPABILITY_V2` 同款的警告。
- 这个选择用**闸门**钉住,不靠注释自觉(§4.9 Layer 1):新增用例
  `keeps the production wrangler.toml from pinning the duration ceiling (keep_vars)`,
  与既有的 `keeps the production wrangler.toml from opening the fence` 同款 —— 生产 toml 里一旦出现
  未注释的 `SHARE_MAX_DURATION_SECONDS` 行即红。

## 7. Review Findings(偏差 / 越界 / 风险)

### 自纠(Tier 1:代码本身能定位,已改并继续)

1. **行号漂移**:派单给的 4 处锚点整体偏 6~16 行(见开头链路表),按实际行号执行。
2. **派单说"存量测试夹具会打红"** —— 实测**没有一条存量用例因兜底而红**:所有夹具都显式配了
   `SHARE_MAX_DURATION_SECONDS`,兜底只在缺失时接管,对它们零影响。唯一因本包而红的存量用例是
   `AC-AUTH-07` 那条(因为续期把 `expiresAt` 变成了合法字段),与兜底无关。
   如实记录,以免下一个人按"夹具应该红"的预期去反推自己哪里写错了。

### 越界(在派单独占清单之外动的文件,逐条说明)

| 文件 | 改了什么 | 为什么必须一起改 |
|---|---|---|
| `mail-worker/test/share-api.spec.js` | 1 条用例的 duration 值 + 名字 + 注释 | 它是 `wrangler-vitest.toml` 那条夹具在 HTTP 层的唯一消费者。删夹具不同步改它,要么这条断言变假绿(11.6 天 < 90 天上限,不再被拒),要么直接红。派单给独占清单时不掌握这个消费关系 |
| `README.md:173` / `README-en.md:167` | 一行表格描述 | 原文"**不配即分享有效期无上限**"在本包落地那一刻起变成谎言,而它正是运维读来决定要不要配这一项的那一行 |
| `mail-worker/.dev.vars.example:31-32` | 两行注释 | 同上,本地开发模板里的同一句话 |

以上三处都是本次行为变更的**直接语义连带**,不是顺手重构。未碰 `share-auth-service.*`、未碰 `mail-vue/`、
未 `git commit`、未 `git stash`。

### 与派单约束 4 的一处语义分歧(已按代码裁决,请复核)

派单写"仅 `effectiveStatus=ACTIVE` 可续期",同时又写"与 `resetAuthKey` 的状态门同构"。二者在
`ACCESS_LIMIT_REACHED` 上不一致:`loadMutableShare`(即 resetAuthKey 与既有 update 共用的那把门)判的是
`status='ACTIVE' AND expires_at > now`,**放行** `ACCESS_LIMIT_REACHED` 的行。

取"同构"这一侧,理由:①  该状态是**可恢复**的(管理员在同一次 patch 里调大 `maxSessions` 即可复活),
与 EXPIRED / REVOKED 的不可逆性质不同;② 为单个字段引一把更严的门,会让 update 这个入口出现两套状态语义,
是比"多放行一个可恢复状态"更贵的代价。派单显式点名禁止的 EXPIRED / REVOKED 已严格拒绝,有用例。
若产品口径确实要连 `ACCESS_LIMIT_REACHED` 一起拒,这是一行判据的事,但那应当是整个 update 入口一起改。

### 遗留风险

1. **前端镜像常量**:`mail-vue/src/views/share-admin/presets.js:77` 的 `MAX_DURATION_DAYS = 90` 现在与后端
   `MAX_DURATION_FALLBACK_SECONDS` 数值一致,但**没有任何机制保证它们一起改**。后端已在常量注释里声明自己是权威。
   若部署方在 Dashboard 把 `SHARE_MAX_DURATION_SECONDS` 配成小于 90 天的值,前端仍会放行到 90 天、由后端拒
   —— 这是 `exec-we1-duration.md:72` 已记录的既有缺口,本包未改变它。
2. **续期 UI 未落地**:后端能力已通,管理台详情抽屉还没有"延期"入口(后续包)。在那之前,成功状态 ② 对
   最终用户仍不可达 —— 本包交付的是链路的后半段。
3. `tests/e2e` 未实跑(理由见 §3)。

## Update Log

- 2026-08-25 · executor(T-22b-1a + T-22b-1b):红 8 failed/229 passed(`EXIT=1`)→ 绿 18 files/654 passed(`EXIT=0`)。
  改动 9 文件:`src/service/mail-share-service.js`、`test/mail-share-service.spec.js`、`test/share-api.spec.js`、
  `wrangler.toml`、`wrangler-vitest.toml`、`tests/e2e/wrangler-e2e.toml`、`README.md`、`README-en.md`、`.dev.vars.example`。
  未提交。踩到的坑:①「上限从 create_time 起算」这条判据拿不到行上下文,不能塞进 `UPDATE_FIELDS.read`,
  单开 `applyRenewal` 承担;② dayjs 会把 `2026-13-45` 静默滚成合法时刻,只有格式化往返比对认得出来;
  ③ 删 `wrangler-vitest.toml` 的夹具会连带打红 `share-api.spec.js` 里那条靠 86400 才成立的 HTTP 断言,
  两者必须同一包内一起改。
