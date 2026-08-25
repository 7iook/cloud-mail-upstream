# T-20b1 · `sec` 密文原语模块(执行记录)

- 日期:2026-08-25 · 执行者:executor SUB
- 范围:**只交付原语与其测试,不接线**。`mail-share-service.js` / `share-auth-service.js` / `mail-share-api.js` / `security.js` / entity 一字未动。
- 新增文件(两个,均为本包独占):
  - `mail-worker/src/security/share-sec-cipher.js`
  - `mail-worker/test/share-sec-cipher.spec.js`

## 成功状态(照抄交付契约,未改写)

> NOT「写了个加解密函数」, BUT 一个独立、可被单测穷尽验证的加密封装:给它明文和 shareId 能拿回密文信封,给它信封能拿回明文;密钥轮换期新旧两把都能解;而当密钥缺失、kid 认不出、或密文被人动过时,它给出的是四种**可区分**的结果,而不是笼统一句"失败"——因为上层要据此决定是提示管理员重新生成、还是告警一次部署事故。
>
> 不该发生: nonce 复用 · 密文能被整列搬到另一行仍解得开 · 认证失败被当成普通"解不开"吞掉。
>
> 来源: ADR-share-credential-recoverability「密文持久化协议」+ 决策卡 §1.4

**逐项核实**:三条「不该发生」各有一条专门测试钉住,其中两条做了变异验证(见下)。四类失败另有一条「四个 reason 互不相同」的聚合断言,防止后人把其中两类折叠。

## 模块 API 与理由(下一包照此接线)

```js
import {
  ENVELOPE_VERSION, HKDF_INFO, NONCE_BYTES, SEC_CIPHER_FAILURE,
  kekRing, probeKek, encryptShareSec, decryptShareSec
} from '../security/share-sec-cipher.js';
```

| 导出 | 签名 | 用途 |
|---|---|---|
| `kekRing(env)` | → `[{kid, value}]` | current+prev 双键环,顺序即 current 优先 |
| `probeKek(env)` | → `{available, currentKid, kids}` | **创建阶段 fail-closed 的判据**:写库前先问它,`available===false` 就直接拒绝,不要等 `encryptShareSec` 返回再回滚 |
| `encryptShareSec(env, {shareId, plaintext})` | → `{ok:true, envelope, kekKid}` \| `{ok:false, reason:'kek_missing'}` | 恒用环首(current)kid 加密;`kekKid` 就是要写进 `kek_kid` 列的值 |
| `decryptShareSec(env, {shareId, envelope})` | → `{ok:true, plaintext, kekKid}` \| `{ok:false, reason, kekKid?}` | 五种 reason,见下表 |

**为什么是 `env` 而不是 `c`**:模块不碰 D1、不写日志、不产 HTTP,只依赖四个环境变量。传 `env` 让它在单测里是纯函数(spec 全程零 fixture、零数据库),这正是「可被独立测试」的前提。调用方传 `c.env` 即可。

**为什么返回值而不是抛异常**:四类失败要被上层分别翻译成不同文案 + 是否告警。用异常表达就得靠 `err.code` 字符串比对,和「不得折叠成同一个异常」的约束背道而驰。**唯一抛异常的是编程错误**:`shareId` 为空 → `TypeError`(空 AAD 等于没绑行,必须当场炸而不是静默产出可搬运的密文);`plaintext` 为 `null/undefined` 同理。

### 四类失败的返回形态(下一包的接线依据)

| # | 情形 | 返回 | 对管理员 | 告警 |
|---|---|---|---|---|
| ① | 密文列 NULL / 空串 / 全空白 | `{ok:false, reason:'absent'}` | 「创建于功能上线前,不可恢复,可重新生成」 | 否 |
| ② | 环里一把键都没有 | `{ok:false, reason:'kek_missing'}` | 「服务配置异常」 | **是** |
| ③ | 行上 kid 不在环内 | `{ok:false, reason:'unknown_kid', kekKid}` | 「密钥已轮换退环,可重新生成」 | 记事件 |
| ④ | GCM tag 校验不过(篡改 / 损坏 / 搬错行) | `{ok:false, reason:'auth_failed', kekKid}` | 「凭据数据异常」 | **是** |
| ⑤ | envelope 解析不了 | `{ok:false, reason:'malformed'}` | 同④「凭据数据异常」 | **是**(与④同级) |

`SEC_CIPHER_FAILURE` 常量已导出,**接线时请用常量而不是字符串字面量**。

⚠️ **⑤ 是我在四类之外增设的第五类,不是把四类改成五类**。理由:任务书要求「envelope 格式错乱 → 明确失败,不抛未捕获异常」,而格式错乱与 tag 失败虽然对管理员是同一句文案,成因完全不同(前者多半是写入侧或迁移把列写坏了,后者是密文本身被动过)。合并会让排障时分不清该查写入代码还是查数据完整性。**若下一包认为多一类反而增加接线负担,把 ⑤ 与 ④ 归到同一分支即可,无需改本模块。**

**检查顺序是有意的**:`absent` → `kek_missing` → `malformed` → `unknown_kid` → `auth_failed`。KEK 缺失排在解析之前,因为它恒为部署事故,不能因为那一行的密文恰好也有问题就被报成别的。

### 协议落点(逐条对齐 ADR 表)

| ADR 契约 | 实现位置 |
|---|---|
| AES-256-GCM + HKDF-SHA256 · `info` 固定 · `salt` 用 kid | `deriveKey()`,`HKDF_INFO = 'share-sec-kek'` |
| `v1:<kek_kid>:<b64url(nonce)>:<b64url(ct‖tag)>` | `encryptShareSec()` 末行;`parseEnvelope()` 反向 |
| 96-bit CSPRNG nonce,禁止派生 | `crypto.getRandomValues(new Uint8Array(12))` |
| AAD 绑 shareId | `additionalData()` = `v1:<shareId>`,版本一并绑进去,换版本时旧密文不会被新版当自己人 |
| kid 真源 = 数据行 | 解密只按 envelope 里的 kid 查环;环的顺序**只**决定写入用哪把,从不参与读取选键 |
| 双键 current+prev | `kekRing()` 与 `collectKeyedSecrets` 同形,含 `'v1'`/`'v0'` 同款默认 kid |

## 红绿与变异证据

**红**(实现留空、仅导出桩):

```
pnpm --dir mail-worker test -- share-sec-cipher
Tests  17 failed (17)   EXIT=1
```

**绿**(实现补齐):

```
pnpm --dir mail-worker test -- share-sec-cipher
✓ test/share-sec-cipher.spec.js (17 tests) 272ms
Tests  17 passed (17)   EXIT=0
```

**变异 1 · nonce 唯一性** —— 把 `getRandomValues` 换成 `SHA-256(shareId)` 前 12 字节(即任务书点名禁止的「由 shareId 派生」):

```
× nonce uniqueness > never reuses a nonce: the same plaintext encrypted twice differs in both nonce and ciphertext
Tests  1 failed | 16 passed (17)
```

**变异 2 · AAD 绑定** —— 让 `additionalData()` 忽略 `shareId`:

```
× AAD binds the row > refuses an envelope lifted onto another share row
× four failure classes > the four classes are four distinct reasons, never folded into one
Tests  2 failed | 15 passed (17)
```

**还原后复跑**(两处变异均已还原,`git diff` 对新文件不适用,以复跑为准):

```
pnpm --dir mail-worker test -- share-sec-cipher
Tests  17 passed (17)   EXIT=0
```

**变异 1 暴露了一条我自己写歪的测试,已修**:原「不由 shareId 派生」那条断言的是「两个不同 shareId 的 nonce 不同」——而 shareId 派生的 nonce **恰好也满足**它,变异下它绿着。已改为断言「同一个 shareId 连加密两次 nonce 仍不同」,这才是真正证伪派生的那句;跨 share 的断言保留但降为附带。**没有这次变异验证,这条测试会以「看起来覆盖了」的形态长期留在仓库里。**

## 全量测试与基线

```
pnpm --dir mail-worker test
Test Files  1 failed | 18 passed (19)
Tests  3 failed | 701 passed (704)
```

**3 条失败全部不是本包造成的,是另一执行者正在改的 T-20a regenerate**:

- 失败项全在 `mail-share-service.spec.js > mailShareService.regenerate (T-20a)`(CAS / 并发三条)。
- 对照实验:把我的 spec 临时移出 `test/` 后跑全量 → **18 files / 687 passed / 全绿**;移回 → 704(= 687 + 我的 17),失败项不变地留在他们那个文件里。
- 直接证据:`mail-share-service.js` 的 `LastWriteTime` 是 **09:54:37**,落在我那次全量跑(09:52 起、132 秒)的**中间**——该文件正在被实时改写,同一命令两次跑分别报 13 失败与 3 失败。
- 结构证据:`git grep share-sec-cipher` 除我自己两个文件外**零命中**,本模块无任何消费者,不可能影响他们的用例。

**基线口径**:任务书给的 664 是本包开工时的快照;另一执行者已把它推到 687。本包净增 **+17 passed**,零减少。

## Workers `crypto.subtle` 平台限制(实测)

- **HKDF 可用,但 `importKey` 的用法与 HMAC 那 6 处不同**:算法参数必须传裸字符串 `'HKDF'`(不是对象),`extractable` 必须 `false`,usages 只能是 `['deriveKey']` / `['deriveBits']`。照抄 `jwt-utils.js:35-41` 的 `{name:'HMAC', hash:'SHA-256'}` 写法会被拒。
- **AES-256-GCM `encrypt`/`decrypt` 无任何限制**,tag 默认 128-bit 且自动附在密文尾部(不需要手工切分),`additionalData` 正常生效。全仓首次使用,未遇平台缺口。
- **认证失败只以 `DOMException` 抛出,不返回错误码**,且不区分「tag 不对」与「AAD 不对」——两者都是 `auth_failed`,这在密码学上本就是同一件事,不影响四类可区分性。
- `unverified`:仅在 `@cloudflare/vitest-pool-workers`(workerd)下验证,**未在真实 Cloudflare 预览环境跑过**。ADR 的实现期停止条件(KEK 能否与 D1 真正分离)属部署面,本包无法验证。

## Review Findings

1. **一处偏离,已按 Tier 1 自行订正**:任务书与 ADR 都说「复用 `collectKeyedSecrets`」,但该函数在 `share-auth-service.js:124` 是**模块私有、未导出**(`git grep` 确认全文件只有 `export default shareAuthService`),而该文件本包禁止修改。故在 `kekRing()` 内以完全相同的形状(含 `'v1'`/`'v0'` 默认 kid、`seen` 去重、空值跳过)重述一遍,并在源码注释里写明这是临时重复。**留给下一包的债**:等 `share-auth-service.js` 交还后,把三个环收敛到一个导出的 `collectKeyedSecrets`,消除这处第二真源。这是本包唯一的 SSOT 妥协,不改会让 KEK 环与 pepper 环日后各自漂移。
2. **KEK 材料不做 base64 解码,直接以 UTF-8 字节做 HKDF 的 IKM**。决策卡 §5 规定材料格式是「base64url 的 32 字节」,但没说要先解码。选不解码的理由:HKDF 本就接受任意长度 IKM,32 字节的 base64 文本携带完整 256 bit 熵;而一旦解码,就多出一个「两个环境对同一串秘密解出不同字节」的分歧点(`openssl rand -base64 32` 出的是标准 base64 带 `+/=`,与 base64url 不同字母表),那正是「跨环境导数据全部解不开」的经典成因。已在模块头注释显著标注。**若下一包或运维认为必须解码,这是个需要在上线前统一的决定,改动很小但必须在有生产数据之前做。**
3. **envelope 从右往左解析**,因此 kid 里含 `:` 也不会破坏格式(nonce/ct 是 base64url,天然无冒号)。省掉了一条「kid 不许含冒号」的校验和它对应的错误分支。
4. **未接线,符合约定**:`probeKek` 是给创建路径 fail-closed 用的,但本包不调用它。**下一包必须记得在写库之前调**——只在 `encryptShareSec` 返回 `kek_missing` 时才回滚,等于先写了行再撤,与 ADR「绝不允许创建成功但没加密」的意图擦边。
5. 未碰 `mail-vue/`,未 `git commit`,未 `git stash`。
