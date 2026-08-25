# T-20b2a · sec 密文持久化接线（执行记录）

> 交付契约成功状态（逐字抄自派发指令，不改写）：
>
> NOT「表里多了两列」, BUT 从这次部署之后新建或重新生成的每一条分享，它的完整链接都能在日后被取回；
> 而如果加密密钥没配好，系统当场拒绝创建并告警，绝不产出一条「看起来正常、几天后管理员点开详情
> 才发现取不回来」的分享。
> 不该发生：明文 sec 落库 · 密钥缺失时静默创建出不可恢复的分享 · AuthKey 被顺带变成可恢复。
> 来源：ADR-share-credential-recoverability 轨一 · 决策卡 §1.4

基线 HEAD `3a3346a`，后端 704 passed。**收尾 716 passed / 19 files，只增不减。**

---

## 1. 链路逐格核实

| 节点 | 生产者 | 消费者 | 核实 |
|---|---|---|---|
| 铸造 | `mintShareCredentials()` `mail-share-service.js:1246` | `encryptShareSec()` `share-sec-cipher.js:185` | ✅ 明文 `sec` 与信封同一次产出 |
| 写入 · create | `prepareShareInsert()` 的**同一条 INSERT** `mail-share-service.js:593` | D1 `mail_share.sec_cipher/kek_kid` | ✅ 无第二条语句（SQL 探针断言） |
| 写入 · regenerate | `prepareRegenerateUpdate()` 的**同一个 SET** `mail-share-service.js:1219` | 同上 | ✅ |
| 迁移 | `dbInit.v3_3DB()` `init.js:44`（expand-only） | 新列 | ✅ 幂等，重复跑不重复建列 |
| 最终 sink | D1 密文列 | `decryptShareSec()`（解密端点是下一个包） | ✅ e2e 已真跑：建→查库→解回逐字相等 |

## 2. 列名与迁移选择

**列名 `sec_cipher` / `kek_kid`**。对照 `sec_hmac` / `pepper_kid`：同一个 `sec` 的两种保存形态，各自带自己的 kid。
`kek_kid` 与 `pepper_kid` 刻意不共用一列——KEK 环与 pepper 环是两套独立轮换的密钥，
共用一列会让「换了 pepper 忘了换 KEK」变成一条静默的解密失败。两列可空且无 DEFAULT：
本次部署前的存量行本就没有密文（读取侧 `ABSENT`），NOT NULL 会让 ALTER 在有数据的表上直接失败。

**迁移走新的 `v3_3DB`**，不塞进 `v3_2DB`：后者是已发布的版本段，往里加语句会让「跑过 v3_2 的库」
与「刚跑 v3_2 的库」走出不同历史。形态逐字沿用 `v3_2DB` 的 expand-only 幂等模式
（逐条 ALTER + `catch` 吞 `duplicate column name`），零 RENAME 零 DROP。

## 3. AAD 绑 `lid` 而不是 `share_id`（本包唯一的协议侧判断，请复核）

`share-sec-cipher.js` 的文档把 AAD 描述为 shareId。但 create 的 `share_id` 由 AUTOINCREMENT 产生，
**要等 INSERT 返回才存在**——绑它就只能拆成「先插行、再补密文」两次写入，正是本包硬约束要消灭的中间态。

改绑 `lid`，理由三条：
1. `idx_mail_share_lid` 是 UNIQUE，「密文被搬到另一行」照样验签失败，原属性不丢；
2. `lid` 与 `sec` 恒由同一次铸造产生、同一条语句落库（create/regenerate 是仅有的两个写入口），
   所以它对这份密文是稳定标识；
3. 额外收益：轮换后若残留旧密文，解密会**失败**而不是悄悄交回一个已经失效的 sec。

**下一个包（解密端点）的契约**：解密时传行上的 `lid`，不是 `share_id`。
`share-sec-cipher.js` 的**协议本体（envelope / nonce / HKDF / 失败分类）一字未改**。

## 4. SSOT 收敛与对既有两个环的影响核实

新增 `src/security/keyed-secret-ring.js`，导出 `collectKeyedSecrets(currentKid, currentValue, prevKid, prevValue)`，
三个环共用：

- `share-auth-service.js` 的 `pepperRing` / `signingRing`：删除本地同名私有函数，改 import。**函数体逐字相同**（空值不入环、重复 kid 保留 current、kid 缺省 `v1`/`v0`、current-then-prev 顺序），调用点签名未变，行为零变化。
- `share-sec-cipher.js` 的 `kekRing`：函数体改为委托，**导出签名与返回形状不变**。

> ⚠️ 偏差申报：派发指令同时写了「⛔ 不要改 `share-sec-cipher.js`」与「现在两个文件都归你可动范围，
> 把 `kekRing` 收敛掉」。冻结的申明理由是「协议已定死」，而 `kekRing` 不属于协议。取窄解：
> 只做行为等价的委托改写，协议与 17 项穷尽单测原样。**`share-sec-cipher.spec.js` 未改动、全绿**——
> 这就是「既有行为未变」的证据。若判断有误，回滚点是单函数级的。

对既有两个环的核实证据：`share-auth-service.spec.js`（96KB，pepper 环 / 签名环 / kid 轮换 /
fail-closed 全套）与 `share-integration.spec.js` 均未改一行且全绿。

## 5. AuthKey 不可恢复（负向约束）

`auth_key_hash` / `auth_key_kid` 未动，`AC-CAP-05`「明文恰一次」一字未改，
`resetAuthKey` 未接密文。schema 用例正向钉死「不存在 `auth_key_cipher` / `auth_key_encrypted` 列」，
服务用例正向钉死「全库扫描不出现 AuthKey 明文，且 `sec_cipher` 解出来的不是它」。

## 6. 红绿证据

**红**（实现前，仅新增用例失败）：

```
 Test Files  3 failed | 16 passed (19)
      Tests  12 failed | 703 passed (715)
```

代表性失败：`expected undefined to be truthy`（`cols.sec_cipher`）、
`TypeError: dbInit.v3_3DB is not a function`、`D1_ERROR: no such column: sec_cipher`。

**绿**（实现后 · 收尾全量）：

```
 Test Files  19 passed (19)
      Tests  716 passed (716)
```

新增 12 条用例（704 → 716）：create 密文/kid/全库扫描/解回、regenerate 换密文/解回新 sec、
KEK 缺失 create 零行落库、KEK 缺失 regenerate 整行不动、**KEK 缺失时幂等重放也被拒（顺序断言）**、
AuthKey 仍不可恢复、Owner 投影不带凭据列、密文与主行同语句、v3_3DB DDL 形状 / 幂等 / 存量密文不被覆写。

## 7. 变异验证（含还原后复跑）

| # | 变异 | 结果 | 被哪些用例抓住 |
|---|---|---|---|
| M1 | 删掉 create / regenerate 的 `assertKekConfigured()` 前置探测 | 🔴 2 failed / 263 passed | 「零行落库」+「幂等重放也被拒」 |
| M2 | 从 regenerate 的 `UPDATE ... SET` 里漏掉 `sec_cipher = ?, kek_kid = ?` | 🔴 14 failed / 251 passed | T-20b2a 的 3 条 + T-20a 既有 11 条 |
| M3 | create 的 INSERT 保持列在、但绑定值改成 `null`（合法 SQL，纯语义破坏） | 🔴 3 failed / 262 passed | create 密文、AuthKey 不可恢复、Owner 投影 |

**M1 抓出了一条本来会假绿的弱断言。** 最初只写了「KEK 缺失 → create 被拒且零行落库」，
变异后它**依然绿**——因为铸造点 `mintShareCredentials` 自己在加密失败时也会抛，
零行落库照样成立。前置探测被删掉这件事，它根本测不到。

补的那条才是能把两者分开的缝：`probeKek` 排在幂等重放**之前**，所以 KEK 缺失时整条写入面
（含重放）一起拒；把探测挪进铸造点，重放就会绕过它，把一次部署事故藏进一条看着正常的 200 响应。
补完之后 M1 才真红。

**还原后复跑（全量，非单文件）：**

```
 Test Files  19 passed (19)
      Tests  716 passed (716)
```

`git diff | grep MUTANT` 零命中，三处变异全部还原，无残留。

## 8. 运维部署顺序说明（**先配 KEK，再跑迁移**）

本项目迁移**不随部署自动跑**，由人工访问 `GET /api/init/{jwt_secret}` 触发。正确顺序：

1. **先配 KEK**：在 Cloudflare Dashboard 配 `SHARE_SEC_KEK`（建议 base64url 编码的 32 随机字节）
   与 `SHARE_SEC_KEK_KID`。**刻意不写进 `wrangler.toml`**——仓内既有用例（`keep_vars` 那条教训）
   已经钉死：toml 里显式写出的值会覆盖 Dashboard 的值。轮换时再配 `SHARE_SEC_KEK_PREV` / `_PREV_KID`。
2. **再部署 Worker**。
3. **最后人工访问 `GET /api/init/{jwt_secret}`** 跑 `v3_3DB`，加两列。

**顺序反了会怎样**（两种都不产生坏数据，但停机窗口不同）：

- 先跑迁移、后配 KEK：列在了但 KEK 没有 → create / regenerate 全部 fail-closed 抛 500 并
  `console.error('share create sec kek missing')`。**这正是设计意图**：宁可整条写入面停摆，
  也不产出一条取不回来的分享。配上 KEK 即刻恢复，无需重跑迁移。
- 先配 KEK、后部署/迁移：新 Worker 在列不存在时 INSERT 会报错 → 同样是 fail-closed 的 500。

**既有存量行不回填**：本次部署之前建出来的分享没有密文，读取侧按 `ABSENT` 处置（正常态，非故障）。
它们的链接依旧取不回来——那是 ADR 已经接受的历史成本，Owner 需要换链接才能获得可恢复性。

**告警建议**：把 `share create sec kek missing` / `share regenerate sec kek missing` /
`share * sec cipher failed` 三条 `console.error` 接进告警。它们只在部署配置出问题时出现，零噪声。

---

## Review Findings

1. **Tier 1 · 派发文档说 `mintShareCredentials()` 是「明文 sec 的唯一铸造点」，实际不是。**
   `create` 在 `:1287` 自己 `randomToken(32)` + `digestShareSecret` 内联铸造，从不调用它；
   该函数当时只有 `regenerate` 用。若照字面只在 `mintShareCredentials` 里接密文，
   **create 路径会完全漏掉**——而 create 才是绝大多数分享的产生方式。
   已把 create 改为调用同一个铸造点（`mintShareCredentials(c, lid, 'create')`），
   使派发文档描述的前提**事后成立**。这是双写入口最典型的漏法，M3 变异也是冲它去的。

2. **Tier 1 · AAD 标识改绑 `lid`**（详见 §3）。派发契约没有指定 AAD 用哪个标识，
   而「同一条 SQL」是显式硬约束，两者只能二选一时以硬约束为准。已给下一个包留下明确契约。

3. **偏差申报 · 改了被标为「已定稿」的 `share-sec-cipher.js`**（详见 §4）。
   两条指令直接冲突，取窄解做行为等价委托，其 17 项 spec 未改且全绿。请复核这个取舍。

4. **越界改动申报**（均为强制连带，非自选）：
   - `test/mail-share.schema.spec.js`：entity 新增两列后，那两个 `toEqual` 是穷尽比较，必红。
   - `test/v3-2-db.spec.js`：`v3_3DB` 的对应 spec。
   - `wrangler-vitest.toml`：新增 `SHARE_SEC_KEK` / `SHARE_SEC_KEK_KID`。**不加就整条写入面全红**
     （fail-closed 对测试 env 一视同仁）。kid 取 `k1` 而非 `v1`——与 pepper 环 kid 撞名会让
     「写错了环」这类缺陷假绿。生产 `wrangler.toml` **未动**（见 §8 的 keep_vars 理由）。
   - `src/security/keyed-secret-ring.js`：新文件，SSOT 收敛的载体。

5. **未做（不在本包）**：解密端点、既有行回填、Owner 面「重看链接」入口、
   `mail-vue/` 前端（另一执行者在做）。

6. **隐藏风险 · 留给下一个包**：`sec_cipher` 是**可逆**的，一旦跟着 Owner 列表投影漏出去，
   「明文恰一次」就退化成「每次列表都发一遍链接」。当前靠 `OWNER_ROW_COLUMNS` 白名单
   （取不到就漏不掉）+ 一条投影用例挡住。解密端点必须走独立授权，不能顺手把列加进白名单。

## Update Log

- 2026-08-25 · executor · T-20b2a 落地：新增 `sec_cipher` / `kek_kid` 两列 + `v3_3DB` expand-only 迁移；
  create/regenerate 同语句写密文 + `probeKek` 前置 fail-closed；三环 SSOT 收敛到 `keyed-secret-ring.js`。
  红 703/715 → 绿 716/716。三处变异全红后还原复跑 716 绿。commit: pending（按指令未提交）。
  踩到的坑：首版 fail-closed 断言在变异下假绿，靠幂等重放顺序断言才钉住（见 §7）。
