# P1-3 修复 · 会话 token 的 exp/iat 时间不变量

来源:`review-t22b.gpt.md` P1-3(GPT-5.6 Sol 独立审查)。基线 HEAD `632a931`,工作区未提交态,后端测试基线 18 files / 654 passed。

**独占文件**:`mail-worker/src/service/share-auth-service.js`、`mail-worker/test/share-auth-service.spec.js`。未触碰 `mail-share-service.js`(另一执行者的 CAS 守卫)及其 spec、未触碰 `mail-vue/`。未 commit、未 stash。

## 1. 成功状态(逐字抄录自交付契约)

> NOT「多加几个 if」, BUT 一个结构上不合法的 token —— 即使它带着有效签名(签名密钥轮换出错、旧签发器有缺陷、内部签发异常都可能产出这种东西)—— 也拿不到超出部署预期的会话续期资格。
> 不该发生: 为此把正常访客的会话续期误伤成失败。
> 来源: review-t22b.gpt.md P1-3

链路逐格核实:

| 节点 | 契约给的锚点 | 核实结果 |
|---|---|---|
| 解析 | `parseToken()` 约 `:247-279` | ✅ 属实。验签后仅校验 `shareId != null` 与 `lid` 真值,`iat`/`exp` 完全未校验 |
| 消费 · 读路径 | `verifyToken()` 约 `:310-321` | ✅ 属实(实际在 `:286-292`,`:310-321` 是 `isRenewal`)。只做 `payload.exp <= now` |
| 消费 · 续期路径 | `isRenewal()` 约 `:310-321` | ✅ 属实。只做 `Number.isFinite(exp) && exp + RENEWAL_GRACE > now` |
| 最终 sink | 续期资格 → `mail_share.access_count` 是否递增 | ✅ 属实。`consumeSessionQuota(… , renewal)` 的 `renewal` 唯一来源就是 `isRenewal()` |

**修复前额外发现(审查未点名,同一根因)**:`verifyToken()` 用 `payload.exp <= now` 判过期,而 `undefined <= number` 恒为 `false`,所以**一个根本没有 `exp` 字段的有效签名 token 会被读路径当成永不过期而放行**。这比审查描述的续期放大更严重(读路径 = `resolveSession`,直接给邮件),同属「解析边界不校验数值字段」这一根因,本轮一并修掉,已由「iat 缺失」用例的 `resolveSession` 断言覆盖。

## 2. 改法:结构校验下沉到解析边界,两个消费者复用

新增一个纯函数,由 `parseToken()` 在验签、校验 `shareId`/`lid` 之后调用;`verifyToken()` 与 `isRenewal()` 都只经 `parseToken()` 拿 payload,因此**天然复用同一套结构校验,不可能再各看各的**。

```js
function hasSaneLifetime(c, payload) {
	if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= payload.iat) {
		return false;
	}
	return payload.exp - payload.iat <= maxTokenLifetime(c);
}
```

配套改动:

- 抽出 `sessionTtl(c)` —— 原本内联在 `issueToken()` 里的 `Number(c.env.SHARE_SESSION_TTL)` fallback 逻辑,现在是签发侧与校验侧共用的**唯一 TTL 解析入口**(SSOT)。`issueToken()` 改为 `const ttl = sessionTtl(c)`,行为完全不变。
- `isRenewal()` 删掉已被上游保证的 `Number.isFinite(payload.exp) &&`,只剩 grace 窗口判断。
- 校验失败打一行 `console.error('share-auth token time invariants failed')` —— **只有固定原因、无任何标识符**,与同文件既有的 `share-auth token payload failed` 同构,受 AC-LEAK-05 栅栏约束(既有的 lid/sec/token 不入日志断言仍绿)。有效签名却结构非法本身就是「签名密钥泄漏或签发器故障」的告警信号,静默丢弃等于把唯一的观测点也扔了。

## 3. 上限判据为何与签发侧自洽(本报告核心)

签发侧的事实(`issueToken()`,已实读):

```
iat = floor(Date.now()/1000)
ttl = Number.isFinite(SHARE_SESSION_TTL) && >0 ? SHARE_SESSION_TTL : DEFAULT_SESSION_TTL(900)
exp = min(toUtc(row.expiresAt).unix(), iat + ttl)   且 exp <= iat 时直接 throwUnavailable()
```

由此,**签发侧产出的 token 恒满足 `0 < exp - iat <= ttl`**。所以判据取 `exp - iat <= 上限` 是与签发同构的,不是另立一套。

上限取 `maxTokenLifetime(c) = max(sessionTtl(c), DEFAULT_SESSION_TTL)`,而**不是**直接取 `sessionTtl(c)`。理由是签发侧自己的 fallback 分支:

- `SHARE_SESSION_TTL` 未设置、为空串、或不可解析时,`issueToken()` 会**回落到 `DEFAULT_SESSION_TTL` = 900** 去签。这是生产上真实会发生的窗口(变量漏配、一次误改、e2e harness 的 `envWithOverrides` 复位到 `null`)。
- 若上限严格取当前 `sessionTtl(c)`,那么「变量曾经缺失时签出的 900s token」在变量被补成 300 之后会**立刻被判死** —— 这正是契约里点名不该发生的误伤。
- 取 `max(…, 900)` 后,任何 ≤900s 的 token 永远合法,因为它**确实是这套代码在某个配置状态下能签出来的**。上限只在 `SHARE_SESSION_TTL > 900` 时随之抬高,始终 ≥ 签发能力,**不可能比签发严**。

**关键点:这个比较不涉及时钟。** `iat` 与 `exp` 都在 token 内部,比的是两者之差,不与本地 `Date.now()` 相减,所以跨 PoP 时钟偏移、进程时区(`toUtc` 那一类坑)都进不来,不需要任何容差 slack。

**诚实标注的残留缺口(unverified 之外的已知边界)**:若某部署把 `SHARE_SESSION_TTL` 配成 >900(例如 1800)后**再调低**,则调低前签出的 1800s token 会被拒(落回计费路径 / 读路径 refuse)。影响面被自然收敛:最长只持续 old-ttl 秒,且是运维显式动作。本轮不为此在 token 里加「签发时 ttl」声明字段 —— 那要动 payload 契约,超出这条 P1 防御纵深的范围,属于过度设计。

判据一致性反向验证:既有测试 `bounds the default session to 15 minutes …` 断言 `exp - iat === 900`、`consumes exactly one slot … absolute exp bound` 断言 `exp - iat <= 61`(被 share expiry 截短),两者都在新上限之内且保持绿。

## 4. 红绿与变异证据(全部实跑,命令与输出原样)

### 4.1 红(先写测试,未改生产代码)

`pnpm vitest run test/share-auth-service.spec.js` → **EXIT=1**

```
 × refuses a validly signed token whose exp is not after its iat (P1-3) 27ms
 × refuses a validly signed token whose iat is missing or not a finite number (P1-3) 25ms
 × refuses a validly signed token claiming more life than any issue path grants (P1-3) 26ms
 ✓ keeps a normally issued token resolving and renewing after SHARE_SESSION_TTL is lowered (P1-3)
 Test Files  1 failed (1)
      Tests  3 failed | 66 passed (69)
```

红的原因是功能缺失而非语法错:三条都断在 `catchFail` 的 `throw new Error('expected SHARE_UNAVAILABLE')` —— 畸形 token **被当作合法续期接受了**,在一个 `max_sessions=1` 且槽位已用尽的分享上换到了会话。防误伤那条从一开始就是绿的(它必须绿,红了说明判据把正常 token 判死)。

### 4.2 绿(实现之后)

`pnpm vitest run test/share-auth-service.spec.js` → **EXIT=0**,`Tests 69 passed (69)`。
stderr 出现预期的 `share-auth token time invariants failed`(拒绝路径的告警行,无标识符)。

### 4.3 变异验证

把 `parseToken()` 里的 `if (!hasSaneLifetime(c, payload))` 临时改成 `if (false && !hasSaneLifetime(c, payload))`(等价于移除校验),重跑:

**EXIT=1**

```
 × refuses a validly signed token whose exp is not after its iat (P1-3) 19ms
 × refuses a validly signed token whose iat is missing or not a finite number (P1-3) 25ms
 × refuses a validly signed token claiming more life than any issue path grants (P1-3) 22ms
 ✓ keeps a normally issued token resolving and renewing after SHARE_SESSION_TTL is lowered (P1-3)
 Test Files  1 failed (1)
      Tests  3 failed | 66 passed (69)
```

三条畸形用例确实随校验一起红,证明它们是承重的、不是自动通过的摆设;防误伤那条不随之变化,证明它锁的是另一件事。

### 4.4 还原后复跑(⚠️ 变异态已还原)

还原方式:`false && ` 删除,恢复为 `if (!hasSaneLifetime(c, payload)) {`。
还原核实:`grep -n "false &&|hasSaneLifetime" src/service/share-auth-service.js` → 仅 2 处命中(`:265` 定义、`:309` 调用),**无任何 `false &&` 残留**。

还原后全量复跑 `pnpm --dir mail-worker test` → **EXIT=0**

```
 Test Files  18 passed (18)
      Tests  658 passed (658)
```

**658 = 基线 654 + 本轮新增 4**,零减少。

## 5. 测试覆盖对照(任务要求 vs 实际)

| 要求 | 落点 | 说明 |
|---|---|---|
| 签名有效但 `exp <= iat` → 拒绝续期 | `refuses a validly signed token whose exp is not after its iat` | 覆盖 `exp === iat` 与 `exp === iat-1`,两者都落在 RENEWAL_GRACE 内(故 grace 本身拦不住,只有新校验能拦);同时断言 `resolveSession` 也拒;`access_count` 保持 1 |
| 签名有效但 `iat` 缺失/非有限数 → 拒绝 | `refuses a validly signed token whose iat is missing or not a finite number` | 覆盖字段缺失 / `null` / 字符串三种。`Infinity`、`NaN` 被 `JSON.stringify` 折叠成 `null`,已被 null 行覆盖,不重复堆用例 |
| 生命周期远超部署上限 → 拒绝 | `refuses a validly signed token claiming more life than any issue path grants` | 覆盖 exp 在一年后、以及紧贴边界外的 `iat+901`;并正向断言 `iat+900`(恰为 TTL=900 的签发值)必须放行,把判据边界钉死在「不比签发严」 |
| **正常签发 token 一路畅通(防误伤)** | `keeps a normally issued token resolving and renewing after SHARE_SESSION_TTL is lowered` | 最关键的一条。在 `SHARE_SESSION_TTL=''`(走 fallback,签出 900s)下建会话,再用 `SHARE_SESSION_TTL='300'` 的上下文 resolve + 续期,断言都通过且不吃槽位;另覆盖被 share expiry 截短成 ~60s 的合法短命 token |
| 既有续期行为不变(cv bump 失效 / shareId-lid 绑定) | **既有测试,未新增** | `refuses a renewal once the share is revoked, expired or its cv moved (T-22B2, AC-AUTH-04)` 与 `meters every renewal claim a visitor can author for themselves (T-22B2)` 已精确覆盖这两点(后者含跨 share 的真 token、lid 掉包、伪签名共 6 种)。它们在本轮全程保持绿,即为回归护栏。**复制一份同义测试属于填充,不写** |

## 6. Review Findings

- **锚点偏移(Tier 1,自纠后继续)**:契约把 `verifyToken()` 与 `isRenewal()` 一起标为 `:310-321`。实际 `verifyToken()` 在 `:286-292`,`:310-321` 是 `isRenewal()`。两者的行为描述都属实,只是行号并列写错。已按真实位置施工。
- **审查未点名的同根因缺陷(本轮一并修)**:`verifyToken()` 的 `payload.exp <= now` 在 `exp === undefined` 时恒为 `false`,即**无 `exp` 字段的有效签名 token 会被读路径放行为「永不过期」**。审查只讲了续期资格放大,这一条影响更大(直接过 `resolveSession`)。同属「解析边界不校验数值字段」根因,不另开任务,已由现有用例覆盖。
- **跨文件影响已扫**:全仓 `mintToken` / 手工构造 token 的调用点只在 `share-auth-service.spec.js`(9 处),全部带 `iat` 且生命周期 900,不受新校验影响;`mail-share-service.spec.js`、`share-api.spec.js`、`share-attachment-service.spec.js` 均不自造 token(后者只传字符串 `'dead'`,走验签失败路径)。e2e harness `worker-entry.js` 的 `SHARE_SESSION_TTL` 覆写只向**下**调(`visitor-session-ttl.spec.js` 用极短 TTL),`max(ttl, 900)` 的上限对它是放宽而非收紧,不会误伤。
- **未越界**:`mail-share-service.js` / 其 spec / `mail-vue/` 的 working-tree 改动均为他人在途工作,`git status` 核实我未产生任何写入。
- **隐藏风险(已在 §3 展开)**:`SHARE_SESSION_TTL` 从 >900 调低时,调低前签出的长命 token 会被拒。已判定为可接受的有界代价,未加 payload 字段去规避。

## Update Log

- 2026-08-25 executor:落地 P1-3。`share-auth-service.js` 新增 `sessionTtl()` / `maxTokenLifetime()` / `hasSaneLifetime()`,校验下沉至 `parseToken()`,`verifyToken()` 与 `isRenewal()` 经由 `parseToken()` 复用同一套结构校验;`issueToken()` 改用 `sessionTtl()` 保持签发/校验同源。spec 新增 4 例。红(3 failed/69)→ 绿(69 passed)→ 变异(3 failed/69)→ 还原复跑全量 18 files / 658 passed(基线 654,+4)。踩到的坑:契约中 `verifyToken` 行号与 `isRenewal` 并列写反;另发现 `verifyToken` 对缺失 `exp` 恒判未过期的同根因缺陷,一并修复。未 commit。
