# exec-w0-p0-seed-log — W0 复审 P0-3 / P1-2 修复

- 日期：2026-08-24
- 分支：`cursor/mailbox-share-capability-dcb6`
- 来源：`review-w0-t02-t04.md` 已接受的两条 finding
- 状态：红 → 绿，未 commit（按指令）

---

## 1. 受理的两条 finding

### P0-3 — 种子工厂 ID 闸门用 `value > 0`，形状检查失效

`mail-worker/test/setup.js` 里 `seedShareRow` / `seedBindingRow` 的入参校验写成
`!(row.userId > 0) || !(row.accountId > 0)`。JS 的 `>` 会先做数值强转，所以下面四种
**不是行 ID** 的形状全部被放行：

| 形状 | 表达式 | `> 0` 结果 |
| --- | --- | --- |
| 指数记法字符串 | `'1e3' > 0` | `true` |
| 小数字符串 | `'1.5' > 0` | `true` |
| 布尔真 | `true > 0` | `true` |
| 无穷大 | `Infinity > 0` | `true` |

放行之后实测（见 §2 红阶段）分两种下场：`'1e3'` / `'1.5'` / `true` 被 D1 绑定层
静默接收并成功落库，种子行的主键语义和用例断言就此脱钩；`Infinity` 则被转成 NULL，
撞上 `NOT NULL` 约束才报错 —— 等于拿数据库约束当形状校验，报错既晚又指不到调用点。

**修法**：抽出 `isRowId(value) => Number.isSafeInteger(value) && value > 0`，
两个工厂的 `userId` / `accountId` / `shareId` 一律走它。原有的 `accountId: 0` 抛错
（AC-LIFE-10 禁止 0 主 `account_id`）保持不变 —— `0` 本来就过不了 `value > 0`，
换成 `isRowId` 后仍然过不了，错误文案一字未动。

### P1-2 — `logShareEvent` 的诊断字段能改写规范事件名

`mail-worker/src/service/mail-share-service.js` 的 `logShareEvent(event, fields)`
原本把 `...rest` 铺在 `event` **之后**，所以调用方传 `fields.event = 'overridden'`
就能顶掉第一参数给定的规范事件名；同理 `fields.ts` 能顶掉时间戳。观测事件名是
design.md 固定清单里的枚举值，被调用点改写等于观测口径失真。

**修法**：把展开顺序反过来 —— 诊断字段先铺，`event` / `requestId` / `shareId` / `ts`
四个规范字段最后写。`requestId` / `shareId` 本来就被解构出去了不会冲突，
这次顺序调整额外把 `event` 和 `ts` 也纳入保护。

---

## 2. 红 / 绿记录

### 红（先落用例，未改实现）

```
pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/mail-share.schema.spec.js
```

```
 Test Files  1 failed | 1 passed (2)
      Tests  17 failed | 55 passed (72)
```

EXIT=1

17 条红分解：

- **12 条 = `'1e3'` / `'1.5'` / `true` × 4 个入参位**（`seedShareRow.userId`、
  `seedShareRow.accountId`、`seedBindingRow.shareId`、`seedBindingRow.accountId`）。
  失败样貌是 `AssertionError: promise resolved ... instead of rejecting`：
  闸门放行后 INSERT 一路成功，`seedShareRow` 返回完整的 27 字段行、
  `seedBindingRow` 返回 `binding_id: 1`。也就是说这三种形状**静默落库**，
  连数据库都没拦住 —— 这正是 P0 的严重之处。
- **4 条 = `Infinity` × 同样 4 个入参位**。`Infinity` 同样通过了闸门，但绑定到 D1 时
  被转成 NULL，由数据库兜底报
  `D1_ERROR: NOT NULL constraint failed: ...: SQLITE_CONSTRAINT`，
  与断言的 `/positive/i` 对不上。拿 NOT NULL 约束当形状校验用，
  报错既晚又指不到真正的调用点。
- **1 条 = `logShareEvent` 信封断言**：
  `expected 'overridden' to be 'share.session.denied_auth'`。

「整数下限 1 仍然被接受」那条用例在红阶段即为绿，说明新增闸门收紧的是形状而不是取值范围。

### 绿（实现落地后）

```
pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js test/mail-share.schema.spec.js
```

```
 Test Files  2 passed (2)
      Tests  72 passed (72)
```

EXIT=0

```
pnpm --dir mail-worker test
```

```
 Test Files  17 passed (17)
      Tests  213 passed (213)
```

EXIT=0

基线守恒：worker 历史地板 16 文件 / 138 用例，本次 17 文件 / 213 用例，只增不减。
本次改动净增 17 条（`mail-share-service.spec.js` 46 → 63），与红阶段的 17 条新用例数一致，
无既有用例被改写或删除。

并发说明：本任务与 T-06 共用同一工作树。跑全量的中途撞上过 T-06 处于 TDD 红阶段的
`share-auth-service.spec.js`（一度 7 红），待其实现落地后复跑即全绿。已单独确认
`test/share-auth-service.spec.js` 在本次改动下 26 用例全过 —— 本任务对 `test/setup.js`
的闸门收紧没有波及 T-06 的种子调用（它们传的都是安全整数）。

---

## 3. 改动落点（file:lines）

### `mail-worker/test/setup.js`

- `60:66` — 新增 `isRowId(value)` 辅助函数与说明注释：
  `return Number.isSafeInteger(value) && value > 0;`（第 63 行）
- `105` — `seedShareRow` 闸门：`if (!isRowId(row.userId) || !isRowId(row.accountId)) {`
- `106` — 抛错文案原样保留（`AC-LIFE-10 forbids a 0 primary account_id`）
- `123` — `seedBindingRow` 闸门：`if (!isRowId(shareId) || !isRowId(accountId)) {`

### `mail-worker/src/service/mail-share-service.js`

- `73:83` — `logShareEvent` 字段顺序反转
- `75` — 新增顺序约束注释
- `77:81` — `...rest` 上移到 `event` / `requestId` / `shareId` / `ts` 之前

### `mail-worker/test/mail-share-service.spec.js`

- `556:580` — P0-3 反例矩阵：`describe.each` 四种形状 × 四个入参位，共 16 条
- `582:594` — `still seeds normally at the integer floor of 1`，
  用 `userId: 1 / accountId: 1` 守住整数下限仍可播种，用例内自行清理这两行
  （文件级 `afterEach` 只清 `USER_A` / `USER_B`）
- `712:730` — P1-2 信封用例
  `never lets a diagnostic field overwrite the canonical envelope`：
  传 `event: 'overridden'` 与 `ts: 'overridden'`，断言实际输出仍是第一参数的
  `share.session.denied_auth`、`ts` 未被顶掉，且 `shareId` / `reason` 等诊断字段照常透传

### `mail-worker/test/mail-share.schema.spec.js`

未改动（本次两条 finding 都不涉及 drizzle schema 断言）。

---

## 4. 边界声明

- 未触碰 `share-auth-service.js`（T-06 持有）、`init.js`、`security.js`、`share-api.js`、
  `tasks.md`、`package.json`。
- 未执行 `git commit`。工作树保留改动待复审。
