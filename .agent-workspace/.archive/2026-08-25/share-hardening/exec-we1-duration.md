# W-E1 自定义有效期(纯前端) · 执行记录

- 执行者: executor SUB
- 日期: 2026-08-25
- 起始 HEAD: `2fca55e`(派发文档写的 `0733b6b` 已过时,并行执行者又推进了若干提交)

## 成功状态(逐字抄录派发契约)

> 成功状态: NOT「下拉框里多了几个档位」, BUT 管理员能给一条分享设定任意他需要的有效期(例如 30 天、90 天),不再被 7 天这个上限卡住;同时他不可能误建出一条超过系统安全上限的分享。
> 不该发生: 放开输入后能建出十年期分享 · 两个创建入口的档位不一致导致同一个功能在不同页面表现不同。
> 来源: 用户原话「当前有效期最大仅支持 7 天,需要支持自定义有效期」

### 链路逐格核实

| 节点 | 契约声明 | 实际核实结果 |
|---|---|---|
| 输入 · wizard | `ShareCreateWizard.vue:413-418` + `:141-154` | ✅ 命中(`DURATION_OPTIONS` 在 :413,`el-select` 在 :141)。已改为消费共享常量 |
| 输入 · 邮件页 | `email/ShareDialog.vue:124-129` | ✅ 命中(局部 `durationOptions` 在 :125-130)。已改为消费同一常量 |
| 校验 · 后端 | `mail-share-service.js:338-342` 拒绝超上限 | ✅ 命中(实际在 `:342-343`):`!Number.isFinite || <= 0 || (maxDuration != null && > maxDuration)`。**本包未改**,只读核实 |
| 最终 sink | 创建表单 → 库里 `expires_at` | ✅ `mail-share-service.js:1144` 用 `body.durationSeconds` 算 `expiresAt` |

**无断链**:两个入口都是既存的生产者,后端消费点既存。本包只改生产者侧。

## T-22a 前端自定义有效期

### 交互形态

保留原有四档预设(1h / 6h / 24h / 7d),在下拉框末尾追加「自定义」哨兵项。选中后就地展开 `el-input-number`(数值)+ `el-select`(单位:小时 / 天),因此「30 天」直接填 30 选「天」,**不需要心算 2592000**。

关键实现约束:哨兵值是字符串 `'custom'`,与任何档位的秒数不可能相撞;`form.durationSeconds` 始终只持有已解析出的数字,哨兵**永远不会进入请求体**。这一点专门用测试钉住 —— 若哨兵漏进 body,后端 `normalizeCreateBody` 会静默丢弃该键,分享会以后端默认值落库,而屏幕上显示的是用户选的自定义值(静默错值,比报错更难发现)。

### 共享常量的落点

按派发要求先查了 `share-admin/presets.js`:它已经在承担同类角色(`CREATE_BODY_KEYS` / `capabilityV2` / `SHARE_PRESETS`),是合适的既有落点,**未新建重复模块**。新增导出:

- `SHARE_DURATION_PRESETS` — 四个档位(原先在两个 `.vue` 里各写一份)
- `DURATION_CUSTOM` — 哨兵
- `DURATION_UNITS` — 小时 / 天
- `MAX_DURATION_DAYS` / `MAX_DURATION_SECONDS` — 上限单一真源
- `customDurationSeconds(amount, unitId)` — 数值+单位 → 秒
- `durationError(seconds)` — 返回 i18n key 或 `''`

`email/ShareDialog.vue` 跨目录 import `@/views/share-admin/presets.js`。**这是有意的取舍**:两个入口是同一个功能,一份定义两个消费者优于两份定义。代价是 `email/` 依赖了 `share-admin/`。若后续要拆,建议整体上移到 `@/share/` 而不是复制回去。

**P-03 防复发**:`presets.spec.js` 里加了源码级断言 —— 两个 `.vue` 都不允许再出现 `labelKey: 'shareDuration1h'` 字面量,且都必须出现 `SHARE_DURATION_PRESETS`。下次有人在某一个入口里重新写死档位,测试会红。

### i18n

`zh.js` / `en.js` 各新增 6 键:`shareDurationCustom` · `shareDurationUnitHours` · `shareDurationUnitDays` · `shareDurationCustomAmount` · `shareDurationCustomUnit` · `shareDurationTooLong`。

`shareDurationTooLong` 用插值 `{days}`,天数由 `MAX_DURATION_DAYS` 传入 —— 上限数字**不在文案里写死**,否则改上限要同步改 4 处文案(中英 × 提示/报错)。为此把 wizard 的 `tf(key)` 扩成 `tf(key, params)`(纯增量,既有调用点不变)。

## T-22b 上限的显式化 · 决策与理由

### 先查:websiteConfig 能不能带出上限?

查了。**当前不能**,证据:

- `mail-worker/src/service/setting-service.js:200-242` 的 `websiteConfig(c)` 返回的每一项都来自 `settingRow`(即 `setting` 数据表),没有任何一项读 `c.env`。
- 上限住在 Worker 环境变量 `SHARE_MAX_DURATION_SECONDS` 里(`mail-share-service.js:269-275` 读取),**不在 setting 表里**。

所以走配置下发需要改 `websiteConfig()` 让它读 `c.env` 并新增一个字段 —— 那是 `mail-worker/` 下的改动,是本包的禁区,且 `mail-share-service.js` 正被另一个执行者握着。

### 本轮选择:前端常量镜像 + 登记为债

`presets.js` 里 `MAX_DURATION_DAYS = 90`,与决策卡裁定的后端兜底值一致。

这不是新开一种做法,而是**沿用本文件既有的成文约定**:`ShareCreateWizard.vue:407-411` 原本就写着「Mirrors of backend constants the browser has to enforce before the request leaves」,`BINDING_LIMIT = 50` / `MIN_REFRESH_INTERVAL_MS = 3000` 都是同样的镜像。前端这一份是**体验闸门**(就地报错,不让用户白等一个来回),真正的安全边界仍在后端 `:342-343`。

### 登记的债(明确的残留风险)

**部署者若把 `SHARE_MAX_DURATION_SECONDS` 配成低于 90 天的值,前端不知道。** 后果:用户在前端填 60 天能过前端校验,提交后被后端拒。

而**这个拒绝当前在 UI 上是静默的** —— `ShareCreateWizard.vue` 的 catch 分支对业务错误只做 `console.error`,不写 `formError`(除了栅栏降级那一支)。所以用户会看到「点了创建、什么都没发生」。

⚠️ **这一段错误处理分支正是另一个执行者在改的地方(栅栏错误码),按边界约束我没有动它。** 建议主 AI 把「业务错误码要落到 `formError`」并入那个包,或作为独立的后续项。彻底的修法是把上限下发到前端(改 `websiteConfig` 读 `c.env`),消掉第二真源。

## TDD 红→绿证据

### 红(实跑,留退出码)

```
pnpm --dir mail-vue test -- --run src/views/share-admin/presets.spec.js
  Test Files  1 failed (1)
       Tests  9 failed (9)
  EXIT=1
```

失败原因是待建能力缺失(`customDurationSeconds` / `durationError` / `SHARE_DURATION_PRESETS` 尚不存在,源码断言里两个 `.vue` 仍各持一份字面量),不是语法或 import 错误。

实现共享常量 + 改造 wizard 后,第二次红只剩 ShareDialog 那一格未改造:

```
pnpm --dir mail-vue test -- --run src/views/share-admin/presets.spec.js src/views/share-admin/ShareCreateWizard.spec.js
  Test Files  1 failed | 1 passed (2)
       Tests  1 failed | 36 passed (37)
  EXIT=1
```

### 绿(全量)

```
pnpm --dir mail-vue test
  Test Files  23 passed (23)
       Tests  273 passed (273)
  EXIT=0
```

基线是 **22 files / 255 passed**(派发文档写的「190 passed」已过时 —— 并行执行者又加了测试)。本包净增 1 个文件 + 18 个测试,无既有测试回归。

### 构建

```
pnpm --dir mail-vue build   →  ✓ built in 6.70s   EXIT=0
```

跑构建是因为单测把 `el-input-number` / `el-select` 全桩掉了,只有真构建能证明模板和真实组件能编译。产物落在 `mail-worker/dist/`,已由 `.gitignore:12` 的 `dist` 忽略,`git status` 无污染(已核实)。

### 新增测试覆盖的行为

`presets.spec.js`(9):档位清单 · 数值+单位换算 · 空值返回 0 · 超上限拒绝 · 零/负/小数/非数字拒绝 · 每个档位都可通过 · 秒与天自洽 · 单位与哨兵不相撞 · **两个入口都不许再私藏档位副本(P-03 源码断言)**

`ShareCreateWizard.spec.js`(5):自定义 30 天以秒进 body 且哨兵不进 body · 十年期在请求发出前被拒且报错含上限数字 · 上限从单一常量流到提示与报错(且插值真的被替换) · 切回预设时自定义字段收起不残留 · 清空数值不会发出 0 秒

`ShareDialog.spec.js`(4):档位与 wizard 完全一致(逐项比对) · 自定义 30 天以秒发出 · 十年期只告警不提交且告警含上限 · 切回档位不残留

## Review Findings

### 对派发文档的修正(Tier 1 · 代码可自证,已自行纠正并继续)

1. **起始 HEAD 过时**:文档说上一轮提交是 `0733b6b`,实际 HEAD 已是 `2fca55e`。不影响本包。
2. **测试基线过时**:文档说「基线 22 files / 190 passed」,实测是 **22 files / 255 passed**。按实测基线对账。
3. **后端校验行号偏移**:文档说 `mail-share-service.js:338-342`,实际在 `:342-343`。逻辑与文档描述一致。
4. **`ShareDialog.vue` 行号偏移**:文档说 `:124-129`,实际 `durationOptions` 在 `:125-130`。
5. **并行冲突预警未命中**:文档提醒 `ShareCreateWizard.vue` 可能已被另一执行者改过,动手前 `git status` / `git diff --stat` 实测该文件**当时无未提交改动**。收尾复查:全工作区里非我的改动只有 `mail-worker/test/mail-share-service.spec.js` 与 `v3-2-db.spec.js`(另一执行者的在飞工作),我未触碰。我的 diff 全部落在有效期相关的 hunk 上,未整块重写或格式化整个文件(已逐 hunk 核对)。

### 跨域触碰

无。改动全在派发给我的独占清单内:`presets.js`(+新建 `presets.spec.js`)· `ShareCreateWizard.vue/.spec.js` · `email/ShareDialog.vue/.spec.js` · `i18n/zh.js` · `i18n/en.js`。未碰 `mail-worker/` 下任何文件(只读核实过 `setting-service.js` 与 `mail-share-service.js`)。

### 隐藏风险

1. **上述第二真源之债**(见 T-22b)—— 最要紧的一条。
2. **业务错误在 wizard 里不上屏** —— 既存缺陷,不是本包引入,但会让「后端上限低于前端上限」这个场景表现为「点了没反应」。归属另一执行者的错误处理包。
3. **前端比后端更严**:前端用 `Number.isSafeInteger` 拒绝小数,后端 `:342` 用 `Number.isFinite` 接受小数。方向是安全的(前端更严不会放过后端会拒的值),且 `el-input-number` 的 `min=1 step=1` 已引导整数输入。手打 `1.0001 小时` 会得到「请选择有效期」这个略不精确的提示 —— 属可接受的边角。
4. **`.custom-duration` 的移动端触达**:wizard 的样式块里已有 767px 断点把按钮撑到 44px,新增的两个控件用 `flex-wrap` 在窄屏会换行,未单独加断点。jsdom 无法验证媒体查询,视觉未实测。

## 未验证项(honest gaps)

- **`unverified: 契约里的 wrangler dev e2e 未跑。** 原因有两条,都不是省事:①`mail-share-service.js` 及其测试正被另一个执行者改动中(`git status` 可见 `mail-worker/test/*.spec.js` 为 M),此刻起 `wrangler dev` 打到的是一个中间态后端,结果不可采信;② 契约要验的「不可能建出超上限分享」这一半,后端 90 天兜底**还没落地**(仍是「未配置即无上限」),服务端此刻根本没有上限可验。
  - 已做的替代核实:静态读 `mail-share-service.js:342-343` 确认 `durationSeconds=2592000` 在当前配置(`maxDuration=null`)与未来兜底(7776000)下**都会被接受**;单测钉住了离开浏览器的确切数值 `2592000`;真构建通过。
  - 后端那一半落地后,建议跑一次完整 e2e:自定义 30 天创建 → 确认 `expires_at` 为创建时间 +30 天;再填 100 天 → 确认前端就地拒绝(不发请求)。
- **`unverified: 视觉/移动端未实测**(jsdom 不评估媒体查询,也未开浏览器截图)。

## 交付清单

| 文件 | 改动 |
|---|---|
| `mail-vue/src/views/share-admin/presets.js` | +56,新增档位/单位/上限/两个纯函数 |
| `mail-vue/src/views/share-admin/presets.spec.js` | 新建,9 个测试 |
| `mail-vue/src/views/share-admin/ShareCreateWizard.vue` | 删本地 `DURATION_OPTIONS`,改消费共享常量;加自定义输入行与 `durationModel`;`tf` 支持插值 |
| `mail-vue/src/views/share-admin/ShareCreateWizard.spec.js` | +5 个测试,+3 个 import |
| `mail-vue/src/views/email/ShareDialog.vue` | 删本地 `durationOptions`,同款自定义输入;校验改走 `durationError` |
| `mail-vue/src/views/email/ShareDialog.spec.js` | +4 个测试;`el-select` 桩不再把值一律 `Number()`;补 `el-input-number` 桩 |
| `mail-vue/src/i18n/zh.js` · `en.js` | 各 +6 键 |

未 `git commit`(按约束,由主 AI 统一提交)。未 `git stash`。

## Update Log

- 2026-08-25 07:35 · executor · W-E1 落地完成。共享常量入 `presets.js`(未新建模块);两个入口档位与自定义能力已统一并由源码断言钉住;上限本轮走前端常量镜像并登记为债(`websiteConfig` 走的是 setting 表、拿不到 Worker env,改它属禁区)。红:presets 9/9 fail EXIT=1;绿:23 files / 273 passed EXIT=0;构建 EXIT=0。wrangler dev e2e 标 unverified(后端兜底未落地 + 后端文件在飞)。
