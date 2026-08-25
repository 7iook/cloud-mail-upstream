# W-C 可观测与错误码 · 执行记录

执行者:executor SUB · 2026-08-25

## 交付契约(逐字抄录,未改写)

> 成功状态: NOT「日志多了个字段、多了个错误码常量」, BUT ① 运维在 Cloudflare 侧能按 requestId 把一次分享请求产生的多条事件串成一条时间线 ② 管理员点「启用访问密钥」被拒时,能从提示分辨这是「能力尚未开放」还是「自己配置写错了」,不必翻日志或找开发。
> 不该发生: 改完后 share.migrate.invalid_row 仍游离在统一出口之外,导致按字段过滤的告警规则整类漏掉它。
> 来源: 决策卡 §1.6 第 4 项前置的两条代码缺口 + §1.2 E 项交付契约

### 链路逐格核对

| 节点 | 生产者 | 消费者 | 核对结果 |
|---|---|---|---|
| 事件产出 | 8 个 `logShareEvent` 调用点(待改) | Cloudflare 告警规则(仓库外) | ✅ grep 实得 8 个:`share-auth-service.js:421,477,495,529,596` / `mail-share-cleanup-service.js:107,112` / `mail-share-service.js:1449`。全部已带 `c` |
| 事件产出 | `init.js:127` 手写 console.log(待改) | 同上 | ✅ 现为 `init.js:131` `logShareEvent(c, SHARE_EVENT.MIGRATE_INVALID_ROW, …)`,信封与其余五个事件同形 |
| 错误码 | `assertCapabilityV2` 栅栏路径(待改) | 前端 `fenceIntent` 分支(已存在) | ✅ `mail-share-service.js:79` 抛 `SHARE_CAPABILITY_NOT_ENABLED`;消费端 `ShareCreateWizard.vue:765` / `ShareDetailDrawer.vue:751,792` 精确匹配 |

最终 sink:Cloudflare 告警规则 · 管理台错误提示文案。仓库外的告警规则本轮无法触达,故最终 sink 的验证止于「日志行的字段形状可被按字段过滤」——见下方 T-03 绿证据里的真实日志行。

真跑一次的 e2e 姿势(`wrangler dev` + 点「启用访问密钥」):`unverified: 未启动本地 wrangler dev`。理由:该姿势需要一个带 D1/KV 绑定的本地运行环境与浏览器交互,超出本轮独占文件范围;替代证据是 `share-integration.spec.js` 里走真实 `ownerApi` HTTP 的三条栅栏断言(见 T-03b),它们经的是同一条 `assertCapabilityV2` → BizError → HTTP body 链路。

---

## T-03 告警可用性

### 先查:requestId 从哪来

按「先查再改」查了三处后确认**项目里此前没有任何请求标识机制**:

- `logShareEvent` 原实现 `:87` 解构 `requestId = null` 作默认值,而 8 个调用点**没有一个传过它** —— 线上恒为 null,与 `design.md:451` 不符。注释「恒带 requestId」描述的是意图,不是实现。
- hono context 上没有现成的 request id;中间件链(`hono/webs.js` / `security.js` / `i18n.js`)也没有生成过。

结论:不自造一套新机制,取边缘已经发过的 `CF-Ray`。这样运维拿日志里的值能直接回到 Cloudflare 侧对齐同一次请求;本地 `wrangler dev` 不经边缘、没有该 header 时才退化为 `crypto.randomUUID()`,并 memoize 在 context 上,保证一次请求内的多条事件同值。

### 关键设计决定:`c` 改成必参,requestId 由出口自己填

`logShareEvent(c, event, fields)` —— 不是让调用方传 `requestId`。**「八个调用点没一个记得传」正是本轮要修的根因**,把同一个契约再交回调用方等于把根因留在原地。信封字段(`event` / `requestId` / `shareId` / `ts`)由出口填,调用方只能传诊断字段。

### 结构调整:抽出 `share-event.js`

任务要求 `init.js` 用 `logShareEvent`,但既有测试**禁止 `init.js` import `mail-share-service.js`**(迁移不该依赖 share 服务;且 `mail-share-service` ↔ `share-auth-service` 已有反向 import,会成回环)。

自行更正为:把 `SHARE_EVENT` 与 `logShareEvent` 抽到新建的无依赖模块 `mail-worker/src/service/share-event.js`,四个消费方(`mail-share-service` / `share-auth-service` / `mail-share-cleanup-service` / `init.js`)都从它 import。既守住架构边界,又达成 SSOT。

### 红证据

`requestId` 关联(4 条单测,断言真实 hono context 之外的信封形状):

```
$ npx vitest run test/mail-share-service.spec.js -t "requestId"
× stamps every event of one request with the same requestId
  → expected null to be 'test-req-1'
Tests  4 failed | 223 skipped (227)
EXIT=1
```

真实 hono context 两条(临时把 `shareRequestId` 退回「不读 header、不 memoize」形态取红,跑完立即恢复,已 `Read` 逐行核对与原实现字节一致):

```
$ npx vitest run test/mail-share-service.spec.js -t "real hono context"
× reads the platform id off a real hono context (R2-F2 · design.md:451)
  → expected '4f72321a-441e-435e-aede-8ccf3487766e' to be '9a1b2c3d4e5f6071-SJC'
Tests  1 failed | 226 skipped (227)
EXIT=1

$ npx vitest run test/mail-share-service.spec.js -t "per real request"
× mints and reuses one id per real request when cf-ray is absent
  → expected 'dbbd16be-510f-4a20-bad9-305af8a590e0' to be '00a53d66-9c79-48ac-b010-ad620259cece'
Tests  1 failed | 226 skipped (227)
EXIT=1
```

`init.js` 收归 SSOT:

```
× routes the migration event through the shared emitter, not its own literal
  → init.js 仍含手写 console.log 字面量
```

### 绿证据(真实日志行)

全量跑出的 `init.js` 迁移事件,信封与其余五个事件同形、`requestId` 键在值为 null:

```json
{"migration":"v3_2DB","accountId":930017,"reason":"account_gate_failed","event":"share.migrate.invalid_row","requestId":null,"shareId":2,"ts":"2026-08-25T00:07:44.231Z"}
```

`share-auth-service` 的系统错误事件同形:

```json
{"reason":"replay_cache_write_failed","event":"share.system.error","requestId":null,"shareId":1,"ts":"2026-08-25T00:06:37.000Z"}
```

> 上面两行 `requestId` 为 null 是**正确的**:迁移与定时清理传的是 `{ env }`,没有请求可关联。契约要的是「形状一致比有值更重要」,键在值为 null 正是按字段过滤的告警规则不漏这一类的前提。真实请求路径的 `requestId` 由 `reads the platform id off a real hono context` 一条用真 `Hono` 实例 + `CF-Ray` header 证明取到 `9a1b2c3d4e5f6071-SJC`。

### 一处自我更正

先写的是一条走 `SELF.fetch` 的 HTTP 级日志断言,`vi.spyOn(console,'log')` 抓不到任何输出(`total: 0`)。`vitest-pool-workers` 把 worker 跑在独立 isolate,console 不回流到测试的 spy;换 `worker.fetch` 也一样。**放弃这条测不了的姿势**,改为用真实 `Hono` 实例直接验 `shareRequestId` —— 它依赖 `c.req.header` / `c.get` / `c.set` 三个真实 API,手搓替身把它们实现成什么样都能自证,换真 context 才是有效证据。

---

## T-03b 栅栏错误码可辨识

### 后端

`SHARE_INVALID_CONFIG` 原承载三种语义,只把第三种(发布栅栏未开)拆出:

- `assertCapabilityV2`(`mail-share-service.js:75-80`)是栅栏的**唯一咽喉** —— 9 个调用点全经它,改这一处即全覆盖,前两种语义的 `throw new BizError('SHARE_INVALID_CONFIG')` 一行未动。
- 补了一条守卫测试 `leaves the two permanent domain errors on SHARE_INVALID_CONFIG`,防止后续有人图省事把领域错误也一起换码。

### 前端

- `ShareCreateWizard.vue:765`:`err.message === 'SHARE_INVALID_CONFIG'` → `'SHARE_CAPABILITY_NOT_ENABLED'`。**只改这一行 + 上方注释**,该文件其余改动全是并行执行者的有效期下拉工作(见下)。
- `ShareDetailDrawer.vue:751-754`:配置保存失败改为先判栅栏码给 `shareCapabilityNotEnabled`,否则 `shareConfigRejected`。
- `ShareDetailDrawer.vue:792-794`:访问密钥失败同样先判栅栏码,其余保留不声称知道原因的兜底 `shareAuthKeyFailed`。
- i18n 中英各新增 `shareCapabilityNotEnabled`(「该能力尚未开放,请联系管理员开启。」/ "This capability is not open on this platform yet. Ask an administrator to turn it on.")。
- **顺带收窄了两条既有文案**:`shareConfigRejected` 与 `shareAuthKeyFailed` 原文都写着「可能…或这项能力尚未开放」——那句「或」正是共用一个码逼出来的。栅栏有了自己的码,这两句不该再替栅栏兜话,否则管理员看到的仍是二选一。

### 全仓 grep `SHARE_INVALID_CONFIG` 逐个判定

| 位置 | 判定 | 处理 |
|---|---|---|
| `mail-share-service.js` 栅栏(`assertCapabilityV2`) | 栅栏 | 换新码 |
| `mail-share-service.js` 其余 13 处(状态不匹配 / 配置越域 / `assertCreateBody` / `assertUpdatePatch` / `toAuthKeyTransition`) | 领域错误 | **不动** |
| `mail-share-service.spec.js` 栅栏断言(`GATED_INTENTS` it.each 等) | 栅栏 | 换新码 |
| `mail-share-service.spec.js` 领域错误断言 | 领域错误 | **不动**,另加一条守卫测试 |
| `share-integration.spec.js` 3 处(multi create / bindings expand / resetAuthKey enable,均在 V2 未开启下) | 栅栏 | 换新码 |
| `tests/e2e/specs/capability-v2-fence.spec.js` 6 处 | 栅栏(整个文件就是栅栏 e2e) | 换新码 |
| `account-delete-share.spec.js:50` | 栅栏(**注释**,非断言) | 改注释 |
| `presets.js:42` | 栅栏(**注释**,并行执行者新写) | 改注释一词 |
| `presets.js:98` | 领域错误(小数/非数字有效期) | **不动** |
| `ShareCreateWizard.vue:660` / `:676` | 说明「共用一个码」的**注释**,已因拆码失真 | 重写注释,不改逻辑 |
| `ShareDetailDrawer.vue:653` | 领域错误(`assertUpdatePatch` 改名场景) | **不动** |
| `mail-share-service.js:1313-1314` | 自承「三者共用一个码,语义只能靠语句顺序保住」的**注释**,已失真 | 重写为「前三条共用,栅栏已拆出」 |
| `docs/specs/**` · `.agent-workspace/.archive/**` | 历史文档与既往归档 | **不动**(不改他人已归档记录) |

---

## 收尾测试

```
$ pnpm --dir mail-worker test
Test Files  18 passed (18)
Tests  636 passed (636)
WORKER_EXIT=0

$ pnpm --dir mail-vue test
Test Files  23 passed (23)
Tests  276 passed (276)
VUE_EXIT=0
```

**通过数与交付契约给的基线不符,原因是并行执行者的改动也在同一工作树里**,不是我漏算:

- 后端 629 → 636(+7),7 条全部是我这轮新增(`requestId` 关联 4 条 + 真实 hono context 2 条 + 领域错误守卫 1 条;`init.js` SSOT 那条是改写既有测试,不计增量)。
- 前端 190 → 276(+86)。其中**我只加了 3 条**(`does not grey the gated groups when the server refused a value, not the capability` / `names the capability as the reason when the fence refuses enable` / `does not blame the capability when the refusal is a state change`);其余 +83 来自并行执行者的 W-E1 有效期工作(`presets.spec.js` 新文件 + `ShareDialog.spec.js` + `ShareCreateWizard.spec.js` 的 5 条 W-E1 测试)。

---

## Review Findings

### 对任务书的更正(Tier 1 · 代码本身能定夺,已自行更正并继续)

1. **`init.js` 不能 import `mail-share-service.js`** —— 既有测试明令禁止,且会与 `share-auth-service` 的反向 import 成回环。任务书直接说「收归 `logShareEvent`」但没说走哪条路。自行抽出无依赖模块 `share-event.js`,四方共用。
2. **`requestId` 不该由调用方传** —— 任务书写「8 个调用点补 requestId」。若照字面把 `requestId` 作为参数交回 8 个调用点,等于把「没人记得传」这个根因原地保留。改为 `c` 必参、信封由出口填。行为达成契约,形式与字面不同。
3. **`design.md:451` 说的是「取既有请求上下文标识」** —— 所以取 `CF-Ray` 而不是自造 uuid,只在本地无该 header 时兜底。这条是任务书「别发明一个与项目其它部分不一致的机制」的落点。
4. **`:1329-1330` 行号已漂** —— 任务书引的那条自承注释实际在 `:1313-1314`。按内容定位而非行号。
5. **前端 i18n 键不是嵌套的** —— 先按 `en.share.shareCapabilityNotEnabled` 写测试失败,查 `en.js` 与 `useI18n` 用法后改为 `en.shareCapabilityNotEnabled`。

### 跨域触碰的文件(任务书未点名)

- `mail-worker/src/service/share-event.js`(新建)· `mail-worker/src/service/share-auth-service.js` · `mail-worker/src/service/mail-share-cleanup-service.js` —— 8 个调用点分布在这两个服务里,任务书只点了 `mail-share-service.js`。
- `mail-worker/test/v3-2-db.spec.js` · `mail-worker/test/share-integration.spec.js` · `mail-worker/test/account-delete-share.spec.js` · `tests/e2e/specs/capability-v2-fence.spec.js` —— 契约变更打红的存量断言与失真注释。
- `mail-vue/src/views/share-admin/presets.js` —— 只改了一个词的注释(并行执行者新写的注释因我的拆码而失真)。

### 与并行执行者的边界核对

动手前后都 `git diff` 核过 `ShareCreateWizard.vue`:我的改动是**单个 hunk、2 行逻辑 + 3 行注释**,全在 `submit()` 的 catch 分支;有效期下拉相关的 10 个 hunk 全是对方的,未重写、未格式化。i18n 两个文件我加的 `shareCapabilityNotEnabled` 与对方加的 `shareDuration*` 键分处两个块,无交叠。

### 隐藏风险

1. **`assertCapabilityV2(c, intent)` 的 `intent` 参数仍未被使用** —— 既有注释说明是有意保留给调用点自述与排障。本轮换码没改这点。若哪天要按 intent 分别告警,这个参数目前拿不到。
2. **最终 sink 仍在仓库外** —— Cloudflare 侧的告警规则需要按 `event` + `requestId` 字段配置才能吃到本轮的成果。代码侧的形状已统一,但规则本身没人改就等于没接上。这是 §0.15B 意义上的一个**未闭合的下游 hop**,建议在开栅栏前确认规则已按新字段配置。
3. **`SHARE_CAPABILITY_NOT_ENABLED` 是对外契约变更** —— 若有仓库外的调用方(脚本 / 监控 / 第三方)在断言 `SHARE_INVALID_CONFIG` 来判定栅栏,它们会静默失配。仓库内已全量 grep 处理完。
4. **HTTP 级日志断言在本项目不可测** —— `vitest-pool-workers` 不把 worker 的 console 回流到测试 spy。后续若有人想加「一次真实请求的多条事件同 requestId」的集成断言,会撞上同一堵墙;当前的替代是真实 `Hono` 实例单测。

## Update Log

- 2026-08-25 · executor · W-C 交付:8 个 `logShareEvent` 调用点 + `init.js` 迁移事件统一走新建的 `share-event.js`,`requestId` 由出口从 `CF-Ray` 取(本地兜底 uuid、context 内 memoize);栅栏码从 `SHARE_INVALID_CONFIG` 拆出 `SHARE_CAPABILITY_NOT_ENABLED`,前端两个组件精确匹配 + 中英 i18n。后端 636 绿 / 前端 276 绿,均 EXIT=0。未 commit、未 stash。e2e 的 `wrangler dev` 手动姿势 `unverified`(理由见上)。
