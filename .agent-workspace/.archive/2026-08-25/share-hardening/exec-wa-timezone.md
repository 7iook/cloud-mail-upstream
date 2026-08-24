# 执行记录 · W-A 分享时间统一按 UTC(share-hardening)

- 日期:2026-08-25 · 仓库 `F:\Email\cloud-mail-upstream`
- 交付:`b717d4f`(主体)+ `9f7af98`(补 import 修正)
- **作者说明**:本报告由主 AI 补写。原执行代理在收尾阶段因模型配额耗尽中断,未能自己落盘;代码改动完整保留在工作区,验证与归档由主 AI 接手完成。凡由代理完成、主 AI 未能复现证据的部分,已逐条标注。

---

## 1. 根因与修复

**归因与表象相反,这是本轮最关键的一点。** 用户观测到的是「访客页倒计时多 8 小时」,直觉指向访客页解析错误;实际相反:

- 访客页 `mail-vue/src/views/share/index.vue:560-566` 用 `Date.parse(raw + 'Z')` 按 UTC 解析**是正确的**,它在执行全仓既有约定 —— 真源是 `mail-vue/src/utils/day.js:83-85` 的 `tzDayjs(t) = dayjs.utc(t).tz(local)`,物理基础是 SQLite `CURRENT_TIMESTAMP` 恒 UTC。**未改动。**
- 真正的缺陷在写入侧:分享模块是全仓唯一一个「裸串是否 UTC 取决于运行进程时区」的写入方。
- 管理台三处则完全没有解析逻辑、字符串直出,靠「后端写本地时间」与「前端不转换」两个错误相抵才在本地显示正确;部署到 Cloudflare(workerd 恒 UTC)后会对东八区管理员**少显示 8 小时**。

| 层 | 文件:行 | 改动 |
|---|---|---|
| 后端写入 | `mail-share-service.js:53,289,1142` | `dayjs()` → `toUtc()`(复用既有 `utils/date-uitil.js`) |
| 后端写入 | `share-auth-service.js:46` | 同上 |
| 后端读回 | `share-auth-service.js:218` | `dayjs(row.expiresAt)` → `toUtc(row.expiresAt)`,否则非 UTC 进程把 token 绝对上界算偏一个时区 |
| 后端清理 | `mail-share-cleanup-service.js:37-38` | 同上,比较基准必须与库里裸串同口径 |
| 前端管理台 | `share-admin/index.vue:73` · `ShareDetailDrawer.vue:49` · `email/ShareDialog.vue:57` | 接既有 `tzDayjs()`,未新写转换函数 |

`toUtc(time) = dayjs.utc(time || dayjs())`(`date-uitil.js:11-13`)—— 无参时是「当前时刻的 UTC 表示」,传裸串时是「按 UTC 解析」,两种语义都正是本场景所需。

## 2. 存量数据画像门禁(T-10.0)

**代理产出的审计工具比决策卡原定判据更准确,已据此修正决策卡。**

决策卡 §3.1 原写的判据是「`create_time` 与 `expires_at` 差值不等于任何合法 `durationSeconds` 档位」。**该判据不成立**:两者来自同一次 `dayjs()` 调用,时区偏移在相减时互相抵消,差值恒等于 `durationSeconds`,与时区无关。

正确指纹(`tests/tools/share-timezone-audit.mjs:4-8`):`mail_share.create_time` 由 JS 提供,而同一个 `db.batch()` 里插入的 `mail_share_binding.create_time` 落到 SQLite `CURRENT_TIMESTAMP`(恒 UTC),**两者之差即写入进程的 UTC 偏移**,正确行应约为 0。

实跑结果(本地开发库):

```
node tests/tools/share-timezone-audit.mjs "mail-worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/e1097a1a....sqlite"
→ mail_share rows with at least one binding: 1
  offset beyond +-600s (local-timezone write): 0
    of which still live (status=ACTIVE and expires_at > utc now): 0
  read-only: nothing to correct
EXIT=0
```

**裁定:本地库无受影响行,不订正存量。** 工具默认只读,带 `--fix` 才写,且内置守恒对账(行数不变 / 无 NULL / `expires_at > create_time` / 偏移已归零)。

⚠️ `unverified`:**生产库未跑**。该判定只覆盖本地开发库。生产环境需由运维用同一命令对生产 D1 跑一次只读审计再决定是否 `--fix`。

## 3. 测试基础设施:两个被顺带治好的问题

改动本身很小,但让全量测试从 7 败变全绿的是下面两处。**两者都不是业务代码缺陷。**

### 3.1 `Date.prototype` 补丁跨文件泄漏(本轮引入)

代理新建了 `withLocalTimezoneShift`(`mail-worker/test/setup.js`),通过替换 `Date.prototype` 的本地时间 getter 在 workerd 内模拟 UTC+8 进程。**这个思路是对的且必要的** —— Windows 上 `TZ` 环境变量对 workerd 无效(ICU 的 `detectHostTimeZone()` 走 `GetDynamicTimeZoneInformation()`,见 nodejs/node#4230),这是唯一能做时区对照实验的手段。

但 `Date.prototype` 是全局可变状态,而本仓 `vitest.config.js` 设了 `singleWorker: true`(2026-08-17 那次 RCA 为规避 Windows 多 workerd 的 ConnectEx 故障而定),**所有 spec 文件共用一个 isolate**。补丁生效的那几十毫秒里,并发执行的其它 spec 会读到被改过的 `Date`。

**修复**:`vitest.config.js` 关掉 `fileParallelism`。受控对照:

| 跑法 | 结果 | 耗时 |
|---|---|---|
| 并行(默认) | 7 failed / 622 passed | 85.4s |
| 串行 `--fileParallelism=false` | **1 failed** / 628 passed | 81.8s |

串行**反而更快** —— 单 isolate 下文件级并发本就没有收益,关掉是纯收益。

### 3.2 CRLF 让源码文本断言恒假(既有缺陷,与本轮无关)

串行后仅剩的那 1 个失败:`keeps resolveSession structurally write-free (AC-SESS-02, P-SESS-02)`。

它用 `functionSource()` 做源码文本分析,靠 `source.indexOf('\n}\n')` 定位函数体结束。而 `core.autocrlf=true`(git 在 Windows 的默认值,本仓无 `.gitattributes`)让 checkout 出来的文件是 CRLF,`?raw` 原样加载后该匹配**恒为 `-1`**。

**证明它与本轮改动无关**(受控对照,复刻 autocrlf 行为):

```
改动前(HEAD 经 autocrlf checkout)  start=21564  end=-1  → 断言失败
改动后(当前工作区)                start=21770  end=-1  → 断言失败
```

**修复**:`functionSource` 入口先 `rawSource.replace(/\r\n/g, '\n')`。这是环境相关的既有缺陷,任何 Windows 默认配置的机器上都会命中。

## 4. 变体扫描(T-10.2)

检索 `dayjs()` / `.format('YYYY` / `new Date().toISO` 在 `mail-worker/src/**` 的全部命中。

**分享子系统内:已完全收口。** 三个 service 全部走 `toUtc`;`share-api.js:86` 的 `serverTime` 与 `mail-share-service.js:97` 的日志 `ts` 用的是 `new Date().toISOString()`(带 `Z`),本来就正确,无需改动。

**分享子系统外:6 处同根因,登记为债,本轮不修。**

| 文件:行 | 用法 | 落库? |
|---|---|---|
| `verify-record-service.js:59,76` | `dayjs().format('YYYY-MM-DD HH:mm:ss')` | 是 |
| `user-service.js:235` | `activeTime` | 是 |
| `public-service.js:122` | `activeTime` | 是 |
| `email-service.js:364` | `dayjs().format('YYYY-MM-DD')` | 用于 KV key |
| `security.js:191,194` | `dayjs().startOf('day')` / `toISOString()` | 部分 |
| `analysis-service.js:51-53,82,109` | 多处日期运算与 KV key | 是 |

它们与本轮修的是同一个病(写入 D1 的裸串跟随进程时区),但属于用户、验证码、统计三个不同子系统,各自需要独立的测试与回归面。按决策卡界定的 bounded key(分享子系统)不在本轮范围。**在生产 Cloudflare 上这些同样恒 UTC 因而不出错,风险只在非 UTC 的自托管或本地环境**。

## 5. 独立复核:过期判定不变量

侦察报告结论是「过期判定不受影响」。主 AI 独立复核该结论在改动后仍成立:

判定两侧同源 —— 服务端比较用的 `now` 与库里的裸串,改动后**同为 UTC**(`nowText()` 与写入侧共用 `toUtc()`),定长字符串字典序与时间序一致这一不变量未被破坏(`mail-share-service.js:381-382` 已声明)。改动只是把「两侧同为进程本地时区」换成「两侧同为 UTC」,同源性不变。

`share-auth-service.js:218` 的 `issueToken` 是唯一需要跨口径读回的点(拿库里裸串算 token 绝对上界),已一并改为 `toUtc()` 按 UTC 解析。

## 6. 验证证据

| 项 | 命令 | 结果 |
|---|---|---|
| 后端全量 | `pnpm --dir mail-worker test` | 18 files / **629 passed** / EXIT=0 |
| 前端全量 | `pnpm --dir mail-vue test` | 22 files / **190 passed** / EXIT=0 |
| 画像门禁 | `node tests/tools/share-timezone-audit.mjs <本地 d1>` | 0 受影响行 / EXIT=0 |

⚠️ `unverified: 红证据缺失`。TDD 的「红」由原执行代理在中断前完成,过程输出未留存。它当时为取证把 `.utc()` 临时改回 `dayjs()`,尚未改回即中断 —— 这个半成品状态被主 AI 误提交进 `b717d4f`(`toUtc` 调用在、import 不在,运行时会 `ReferenceError`),由 `9f7af98` 修正。**本报告只能证明绿,不能证明红。** 新增的 `withLocalTimezoneShift` 对照测试(`mail-share-cleanup.spec.js` 的 WA-TZ 用例)是这条链路后续的回归守卫。

⚠️ `unverified: e2e 未跑`。决策卡约定的「本地 `wrangler dev` 起 worker、浏览器实操比对管理台与访客页」这一真跑姿势本轮未执行。单测绿不等于端到端已接通。

## 7. 后续动作

1. 生产库跑一次只读画像审计,再决定是否 `--fix`(§2)。
2. 补 e2e 真跑(§6)。
3. 分享模块外 6 处同根因是否单独立项(§4)。

## Update Log

- 2026-08-25 · 主 AI 补写。修正了决策卡 §3.1 的画像判据(原判据因偏移相消而不成立);记录两处测试基础设施修复的受控对照数据;如实标注红证据缺失与 e2e 未跑;登记分享模块外 6 处同根因债。
