# T-22b 独立代码审查

审查基线：`632a931`；范围：工作区 17 个已跟踪改动文件。按要求未读取 `exec-*.md`。

## Strengths

- `mail-worker/src/service/mail-share-service.js:993-1001`：续期上限明确以 `create_time` 为基准，并把 `expires_at` 与派生的 `delete_at` 放进同一条 `UPDATE` 的赋值集合；避免滚动续期绕过总上限，也没有先后写入的清理竞态。
- `mail-worker/src/service/mail-share-service.js:1074-1081,1322-1337`：续期复用仅允许 ACTIVE 且未过期行的统一更新入口；EXPIRED/REVOKED 无法原地复活。
- `mail-worker/src/service/share-auth-service.js:247-321`：会话续期依据 Worker 签名 token，并绑定 `shareId + lid + credentialsVersion`；匿名访客不能靠自报字段伪造续期。
- `mail-worker/src/service/share-auth-service.js:481-501,606-630`：续期只去掉配额余量谓词，仍保留 ACTIVE、未过期、credentials version、AuthKey 状态的原子 SQL 门；ACCESS_LIMIT_REACHED 下已占位访客可续期，而新访客仍被拒，符合“关门不清场”。
- `mail-worker/src/api/share-api.js:55-65`、`mail-vue/src/request/share.js:162-178`、`mail-vue/src/views/share/index.vue:692-714`：旧 token 从前端状态进入 Authorization header，再由后端读取并传给服务层，端到端字段与传输位置一致。
- 实跑验证：`pnpm vitest run test/mail-share-service.spec.js test/share-auth-service.spec.js test/share-api.spec.js` → EXIT=0，316 tests passed；`pnpm vitest run src/request/share.spec.js src/views/share/index.spec.js` → EXIT=0，72 tests passed；`git diff --check 632a931` → EXIT=0。

## Issues

### P0（必须修才能合入）

#### 1. 管理端没有“直接延长”入口，核心用户需求不可达

- 锚点：`mail-vue/src/views/share-admin/ShareDetailDrawer.vue:43-50,125-245,651-688`
- What：详情抽屉只展示 `expiresAt`，配置表单与 `buildPatch()` 均没有有效期输入，也不会生成 `patch.expiresAt`。全仓前端生产代码中 `expiresAt` 仅用于展示；本轮真正发送 `expiresAt` 的只有后端测试。
- Why：需求是“管理员看到分享快到期，能直接延长”。当前只有后端隐式支持手工调用 `PUT /mailShare/update`，正常管理员 UI 无法执行续期，因此功能对目标用户不存在。
- How：在现有详情抽屉的可写配置路径加入明确的续期控件，按当前分享创建时间与后端上限限制可选目标，并由 `buildPatch()` 发送 `expiresAt`；增加组件测试和真实 owner HTTP 路径验证。

#### 2. 续期与并发撤销/凭据轮换之间缺少快照守卫，可能覆盖安全状态变化

- 锚点：`mail-worker/src/service/mail-share-service.js:1074-1082,1025-1034,1322-1337`
- What：`loadMutableShare()` 预读行后，`prepareUpdate()` 的 WHERE 只重验 `share_id/user_id/status/expires_at`，未绑定预读的 `credentials_version` 或旧 `expires_at`。在预读后、UPDATE 前发生 `resetAuthKey/disable` 时，续期仍可成功；若发生并发续期，两次也都会以各自旧快照判上限并最后写覆盖。
- Why：这违反该模块其它敏感写入已经采用的“预读事实必须进入写入谓词”原则。业务后果是管理员收到“续期成功”，但期间凭据轮换/并发管理动作未被检测，最后到期时间由竞态顺序决定；安全状态变化与续期不能形成可解释的原子次序。
- How：把 `credentials_version` 与旧 `expires_at`（至少二者）纳入 `loadMutableShare()` 返回值和续期 UPDATE 的 CAS WHERE；零命中返回冲突/不存在语义并要求重读。增加“续期 vs reset/revoke/第二次续期”的并发回归测试。

### P1（应修）

#### 3. 会话 token 解析未约束 `exp/iat` 的基本时间关系

- 锚点：`mail-worker/src/service/share-auth-service.js:247-279,310-321`
- What：`parseToken()` 验签后只校验 `shareId/lid`；`isRenewal()` 只要求 `exp` 有限且仍在 grace 内，没有验证 `iat` 有限、`exp > iat`、token 生命周期不超过该部署签发上限。
- Why：正常访客不能伪造签名，因此不是直接绕过；但在签名密钥轮换错误、旧签发器缺陷或内部 token 生成异常时，畸形但有效签名 token 可能获得超出预期的续期资格，扩大密钥泄漏/错误签发的影响面。
- How：在 token 解析边界统一验证数值字段及时间不变量，并让 `verifyToken()` 与 `isRenewal()` 复用同一结构校验；补畸形有效签名 token 的拒绝测试。

### P2（可延后）

#### 4. `tests/e2e/specs/capability-v2-fence.spec.js` 属于无关错误码维护

- 锚点：`tests/e2e/specs/capability-v2-fence.spec.js:33-56`
- What：该文件只把既有栅栏错误码断言从 `SHARE_INVALID_CONFIG` 改为 `SHARE_CAPABILITY_NOT_ENABLED`，与本次有效期、续期、配额三项需求没有因果关系。
- Why：改动本身与当前生产契约一致，不会造成功能错误，但把另一项错误码工作混进本次未提交交付，扩大审查与回滚边界。
- How：若该错误码变更属于另一任务，单独提交；否则在本次提交说明其来源。`README*.md`、`.dev.vars.example`、`wrangler*.toml`、`share-api.js` 与 `test/share-api.spec.js` 都是本次行为或验证的必要连带。

## 7-Phase 结论

1. Spec Conformance：未通过；后端能力存在，但管理员 UI 无法直接续期。
2. Task-Ledger Evidence：not applicable；本次审查未以任务清单作为验收对象。
3. Code Quality：主体分层和单入口良好；续期写入缺 CAS。
4. Domain Model：not applicable；未发现 `docs/domain/*-model.md` 对本轮有强制同步要求。
5. Upstream Root Cause：配额修复位于会话签发的原子门，方向正确。
6. Whole Path：访客 token 续期链路完整；管理员续期链路在前端断开。
7. Business Reality：三项能力均对应明确用户场景；无新增平行 SSOT。

## 无法从代码判定

- 无法从代码判定 Cloudflare 生产 D1 在真实多 PoP 并发下的具体可见性延迟；本次只能验证单语句谓词与本地 D1 行为。该不确定性不影响上述“管理端未接线”和“UPDATE 缺 CAS”两项静态结论。

## VERDICT
status: NEEDS_CHANGES
critical_count: 2
important_count: 1
minor_count: 1
ready_to_merge: NO
one_line: 后端上限与匿名会话续期设计基本正确，但管理员续期未接入前端且续期写缺并发快照守卫，当前不能合入。
