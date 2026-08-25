# 分享凭据可恢复性 · 工作区独立审查

审查基线：`3a3346a`  
审查范围：工作区 26 个已跟踪改动文件（`+2147/-54`）及本轮 4 个未跟踪生产/测试文件；未读取任何 `exec-*.md`。  
设计契约：`docs/architecture/ADR-share-credential-recoverability.md`。

## Strengths

- 加密协议集中在 `mail-worker/src/security/share-sec-cipher.js:48-50,128-150,183-204,218-249`：版本号、HKDF-SHA256、96-bit CSPRNG nonce、AES-256-GCM、AAD 和按 envelope kid 取键都有单一实现。
- create/regenerate 共用凭据铸造点，并将 `lid/sec_hmac/sec_cipher/kek_kid` 放进同一条 INSERT/UPDATE：`mail-worker/src/service/mail-share-service.js:1238-1266,1339-1380,1608-1688`。
- `revealSec` 的归属检查、故障分类、审计和明文最小返回面清楚分层：`mail-worker/src/service/mail-share-service.js:1269-1296,1691-1737`；路由级限流为真实 HTTP 集成测试覆盖：`mail-worker/test/mail-share-service.spec.js:4539-4633`。
- 密文泄漏守卫不是“解不开即通过”：它先用正确 KEK 正向证明扫描器确实发现 `mail_share.sec_cipher`，再验证无 KEK/错 KEK和无密钥编码都不能还原：`mail-worker/test/share-credential-guards.spec.js:97-182,325-363`。

## A–F 独立判定

### A · 加密协议：通过

- envelope 与算法：`mail-worker/src/security/share-sec-cipher.js:48-50,132-150,183-204` 实现 `v1:<kid>:<nonce>:<ciphertext+tag>`、HKDF-SHA256（salt=kid、info=`share-sec-kek`）和 AES-256-GCM。
- nonce：`mail-worker/src/security/share-sec-cipher.js:194` 直接调用 `crypto.getRandomValues(new Uint8Array(12))`，不依赖 lid/计数器/时钟；同一 AAD 连续 32 次 nonce 全异的用例在 `mail-worker/test/share-sec-cipher.spec.js:109-133`。
- AAD 改绑 `lid` 保住了“搬行即解不开”：加解密均构造 `v1:<lid>` AAD（`mail-worker/src/security/share-sec-cipher.js:128-130,195-198,235-242`），`lid` 由唯一索引保证跨行唯一（`mail-worker/src/init/init.js:200-205`），搬行测试在 `mail-worker/test/share-sec-cipher.spec.js:136-145`。create/regenerate 的 lid 与密文同语句落库（`mail-worker/src/service/mail-share-service.js:1200-1220,1240-1245,1375-1380`），没有先插空密文再补写的中间态。
- 轮换：新写入使用环首 current kid，旧 envelope 按 envelope 中的 kid 找 key；prev 在环内仍可解，退环后为 `UNKNOWN_KID`（`mail-worker/src/security/share-sec-cipher.js:188-203,227-235`；测试 `mail-worker/test/share-sec-cipher.spec.js:156-180`）。regenerate 同时换 lid 和 envelope，残留旧密文即使仍有旧 KEK，也因 AAD 不同而无法通过 tag。
- kid 真源存在一个命名层面的偏差：ADR 写“数据行 `kek_kid` 列”，实现解密实际从 `sec_cipher` envelope 解析 kid（`mail-worker/src/security/share-sec-cipher.js:227-235`），行列只在写入与测试中持久化（`mail-worker/src/service/mail-share-service.js:1200-1215`），`revealSec` 未读取 `kek_kid`（`:1293-1296`）。但 envelope 与列由同一 `sealed.kekKid` 原子生成，且 envelope 必须自描述才能选择解密键；当前没有由环顺序猜键或跨环境错误解密的风险。建议后续将 ADR 的“数据行”明确为“行内 envelope kid（`kek_kid` 为可查询镜像）”，避免运维误解；不定为合并阻断。

### B · 创建 fail-closed：通过

- create 在首次幂等读取或任何写语句之前执行 `assertKekConfigured`：`mail-worker/src/service/mail-share-service.js:1330-1355`；regenerate 更早于幂等重放执行：`:1617-1637`。
- 测试不只断言“零行”：`mail-worker/test/share-credential-guards.spec.js:247-267` 还钉死异常必须是非 `BizError`，能抓住把部署事故降级为可吸收业务码的变异；`mail-worker/test/mail-share-service.spec.js:4200-4226` 覆盖已有成功幂等记录时，缺 KEK 仍须在 replay 前拒绝。静态顺序也直接证明检测前置，不依赖下游 `encryptShareSec` 抛错。

### C · 解密端点：通过

- Owner 授权与存在性封闭：`revealSec` 复用 `loadOwnerDetail(shareId,userId)`，他人/不存在同为 `SHARE_NOT_FOUND`（`mail-worker/src/service/mail-share-service.js:1703-1724`；测试 `mail-worker/test/mail-share-service.spec.js:4343-4356,4573-4584`）。
- 五类内部失败保持可区分；其中 `AUTH_FAILED`/`MALFORMED` 对 Owner 合并为同一个可行动的“数据损坏”码，但审计 `outcome` 保留成因。这符合 ADR 四类外部语义而不是错误折叠（`mail-worker/src/service/mail-share-service.js:1269-1288,1727-1734`）。
- 审计不含明文/密文，只记 `shareId/userId/outcome/alert/kekKid`（`mail-worker/src/service/mail-share-service.js:1705,1729-1734`）；回归扫描在 `mail-worker/test/mail-share-service.spec.js:4464-4479`。
- 限流真实接线：路由中间件 `mail-worker/src/api/mail-share-api.js:23-42,111-115`，生产 binding `mail-worker/wrangler.toml:22-29`，真实 Worker HTTP 429/allow 分支测试 `mail-worker/test/mail-share-service.spec.js:4586-4627`。
- 过期/撤销链接不可重新获得访问能力：访客建立会话在匹配 sec 后仍执行 `assertAllowed`，只接受 ACTIVE；已有 token 每次 resolve 先核 `lid/cv`，再核 ACTIVE/ACCESS_LIMIT_REACHED（`mail-worker/src/service/share-auth-service.js:587-648,673-697`）。regenerate 和续期均拒绝非 ACTIVE/已过期行（`mail-worker/src/service/mail-share-service.js:1131-1151,1617-1644`）。相关认证回归 `mail-worker/test/share-auth-service.spec.js:2020-2046` 本次实跑通过。

### D · regenerate 运行时语义：通过；规格传播存在 P1

- 仅 ACTIVE、保持期限与窗口、cv+1、CAS：`mail-worker/src/service/mail-share-service.js:1131-1151,1200-1220,1640-1688`。
- 旧链接和在途 session 失效，新链接可用：`mail-worker/test/mail-share-service.spec.js:3874-3889`。
- EXPIRED/REVOKED 拒绝且零变更：`mail-worker/test/mail-share-service.spec.js:3891-3903`。
- AC-SHARE-13 幂等：相同 owner/key/shareId 返回相同 lid 且不再返回 sec/shareUrl；跨 shareId 冲突；create/regenerate operation 隔离（`mail-worker/test/mail-share-service.spec.js:3974-4022`）。
- 运行时符合 `requirements.md:70,112-113`，但 `design.md` 的其他段落仍宣称 deprecated/本期不做，见 P1-1。

### E · AuthKey 仍不可恢复：通过

- schema 只有 `auth_key_hash/auth_key_kid`，新增可逆列仅服务 sec：`mail-worker/src/entity/mail-share.js:28-43`、`mail-worker/src/init/init.js:46-60`。
- entity 与真实 D1 活表均按正向白名单限制 AuthKey 列；全库正确 KEK 扫描也不能解出 AuthKey，同时正对照能解出 sec（`mail-worker/test/share-credential-guards.spec.js:286-322`）。
- 全仓生产代码未发现 `auth_key_cipher/authKeyCipher` 等可逆字段。

### F · 前端失败语义与明文驻留：通过

- 四个后端码映射四个不同、可行动文案，未知码有可见兜底：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1128-1169`、`mail-vue/src/i18n/zh.js:504-508`。
- 明文只存在组件内 `ref`，切换、关闭与重载时清空（`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:555-565,719-724,1077-1080,1153-1157,1202-1208`）；该组件未使用 local/sessionStorage、Pinia 或路由/URL 写入。
- 请求用 POST body 传 shareId，不把取回动作放 URL：`mail-vue/src/request/mail-share.js:123-126`；请求与组件回归本次 131/131 通过。

## 7-Phase 结果

1. **Spec Conformance**：运行时 A–F 满足；文档矩阵传播不完整（P1-1）。
2. **Task-Ledger Evidence Gate**：不通过。决策卡中的 T-20a/T-20b2/T-20c 仍未勾选，缺本轮 Evidence/Update Log（P1-2）。既有 `[x]` 项未发现无 Evidence 的本轮相关项；`commit pending` 对未提交工作可接受。
3. **Code Quality**：通过。加密、URL 拼装和密钥环均为 SSOT；未发现吞错、平行实现或死生产符号。共享环与基线原语义一致，既有 `share-auth-service` 70/70 回归通过。
4. **Domain Model Consistency**：not applicable：仓库不存在 `docs/domain/*-model.md`。
5. **Upstream Root Cause**：通过。可恢复性在凭据铸造/持久化根层解决，未在 UI 尾端缓存明文或伪造链接。
6. **Whole-Path Completeness**：通过（codegraph 不可用：`CodeGraph not initialized`，按规则回退源码 grep + 真实 HTTP/构建）。生产调用证据：
   - `encryptShareSec` → `mail-worker/src/service/mail-share-service.js:1253`
   - `decryptShareSec` → `mail-worker/src/service/mail-share-service.js:1727`
   - `probeKek` → `mail-worker/src/service/mail-share-service.js:1232`
   - `collectKeyedSecrets` → pepper/signing/KEK 三环：`mail-worker/src/service/share-auth-service.js:142,151`、`mail-worker/src/security/share-sec-cipher.js:94`
   - `regenerateMailShare`/`revealMailShareSec` → `mail-vue/src/views/share-admin/ShareDetailDrawer.vue:1073,1149`
   - 真实 HTTP：`mail-worker/test/mail-share-service.spec.js:4043-4092,4539-4627`
7. **Business Reality**：通过。Owner 关闭创建框后永久失去链接，以及存量行无法回填，是 ADR `:26-37` 的具体业务损失；双轨没有重复既有能力。

## Issues

### P0 · Critical

无。

### P1 · Important

1. **`docs/specs/mail-share/design.md:170,402,426,432,603-607,771`**
   - **What**：虽然 `requirements.md:70,112-113` 已激活 AC，且 `design.md:295-305` 已写“已实现”，同一设计文档的 Owner API 范围、验证矩阵、属性与 Decision Record 仍把 regenerate 标为“本期不做/deprecated/已废弃”。
   - **Why**：后续验收、测试覆盖矩阵和维护者会得到互相冲突的权威答案，可能删除已上线端点或跳过 AC-SHARE-13/AC-LIFE-05/11 回归。
   - **How**：完整传播本轮裁决：更新 Owner API 清单、取消三条 AC 与 P-LIFE-02 的 deprecated/删除线，并在历史 Decision Record 后追加“2026-08-25 重新激活”的新记录而非改写历史。

2. **`.agent-workspace/.archive/2026-08-25/share-hardening/share-hardening-decision-card.md:398-407`**
   - **What**：T-20a、T-20b2、T-20c 仍为 `[ ]`，没有本轮 `Evidence` 四项与 Update Log，尽管代码、测试和 UI 已全部落在工作区。
   - **Why**：任务台账继续把已实现工作标成未完成，无法追溯验证命令、文件范围与 AC，违反该卡自身 `:374` 的完成契约；本审查不能据此判整个交付已闭环。
   - **How**：提交前按实际结果逐项勾选并补 `commit pending`、本次 verify/EXIT、精确 files、AC 与 Update Log；不要引用实现者自述代替实跑证据。

### P2 · Minor

1. **`docs/architecture/ADR-share-credential-recoverability.md:60` 与 `mail-worker/src/security/share-sec-cipher.js:227-235`**
   - **What**：ADR 将 `kek_kid` 列描述为解密 kid 的真源，代码实际从同行 `sec_cipher` envelope 解析 kid；`revealSec` 的 SELECT 未读取 `kek_kid`。
   - **Why**：当前安全性不受影响（两者由同一 `sealed.kekKid` 原子生成），但运维按列查询与实际解密行为存在概念偏差。
   - **How**：将 ADR 明确为“envelope kid 是密码学真源，`kek_kid` 列是可查询镜像”，或让读取侧显式校验列与 envelope 一致并定义不一致错误。

## 验证证据

- `pnpm exec vitest run test/share-sec-cipher.spec.js test/share-credential-guards.spec.js test/mail-share-service.spec.js test/security-share.spec.js test/v3-2-db.spec.js test/mail-share.schema.spec.js --reporter=dot` → EXIT=0，6 files / 501 tests passed。
- `pnpm exec vitest run test/share-auth-service.spec.js` → EXIT=0，1 file / 70 tests passed。
- `pnpm exec vitest run src/request/mail-share.spec.js src/views/share-admin/ShareDetailDrawer.spec.js src/views/share-admin/ShareCreateWizard.spec.js src/views/email/ShareDialog.spec.js` → EXIT=0，4 files / 131 tests passed。
- `pnpm run build`（mail-vue）→ EXIT=0，2327 modules transformed；仅既有 Vite chunk-size 警告。
- `git diff --check 3a3346a` → EXIT=0；仅 CRLF 提示。
- `codegraph sync ...` → EXIT=1，`CodeGraph not initialized`；已回退 `rg` 生产 caller 与真实 HTTP 测试。

## VERDICT
status: NEEDS_CHANGES
critical_count: 0
important_count: 2
minor_count: 1
ready_to_merge: WITH_FIXES
one_line: A–F 运行时实现与回归均成立，但 design.md 契约仍自相矛盾且任务台账尚未回写，需在合并前闭环。
