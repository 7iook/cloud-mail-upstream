# T-16 独立代码审查

VERDICT APPROVED

- review target: `3bb1d554801ee89232d2e6a26338a4938ca05320`
- p0: 0
- p1: 0
- CHANGE: none
- HOLD:
  - T15-PERM / T17-BOTH：`security.js` 的 `premKey['share:manage']` 与 `requirePermsExact` 必须由 T-17 同改，不计入本轮缺陷。
  - 后续 `3488bf0` 只含 Evidence / T-17 侦察；三份审查文件及列出的对照文件相对 `3bb1d55` 均无差异，本轮未把它计入缺陷。

## Findings

无 P0/P1 finding。

## 逐项结论

1. **提交范围符合白名单。** `git show 3bb1d55 --stat` 仅列出 `mail-share-service.js`、`mail-share-api.js`、`mail-share-service.spec.js` 与事实锚 `exec-t16-note.md`。`security.js`、`init.js`、`share-auth-service.js`、`share-api.js`、`wrangler.toml`、`wrangler-vitest.toml` 均无差异；测试文件为 +514/-0，既有用例未改写。
2. **三条迁移表成立。** `AUTH_KEY_TRANSITIONS` 精确编码 `enable: 0→1 / mint / cv+0 / gated`、`reset: 1→1 / mint / cv+1`、`disable: 1→0 / no mint / cv+1`；enable 没有误 bump cv，disable 不生成明文。
3. **迁移守卫成立。** `loadMutableShare` 预读 `auth_key_enabled` 并在服务层按 `fromEnabled` 拒绝非法迁移；同一 `fromEnabled` 又绑定进条件 UPDATE 的 `WHERE auth_key_enabled = ?`。reset 落在 disabled 行上于 V2=false、V2=true 两态均返回 `SHARE_INVALID_CONFIG`，不能绕过 V2 变成 enable。
4. **V2 栅栏成立。** 只有 `move.gated` 为真的 enable 调用 `assertCapabilityV2(c, SHARE_V2_INTENT.AUTH_KEY_ENABLE)`；reset 与 disable 在 V2=false 仍执行。HTTP enable 用例通过 `worker.fetch(request, env, {})` 喂入临时 env，并在 `finally` 还原；没有修改 toml。
5. **原子列迁移与不变量成立。** `auth_key_enabled`、`auth_key_hash`、`auth_key_kid` 与 `credentials_version` 位于同一条 UPDATE 的同一 SET；disable 绑定 NULL 清空 hash+kid。三条迁移后分别执行独立全表 SQL，断言 `(enabled=1) IFF (hash 与 kid 均非空)` 的违规数为 0；另有非法存量组合经 disable 恢复为合法态的覆盖。
6. **明文边界成立。** enable/reset 只把本次生成的 22 字符 Key 条件挂到响应，disable 无 `authKey` 键；数据库只写 HMAC 与 kid。`OWNER_ROW_COLUMNS` 不 SELECT hash/kid/cv，后续 get/list 与行值均取不回明文；新增代码没有把明文传入日志或事件，也没有新增 `SHARE_EVENT` 名。
7. **旧 Key / Session 生命周期成立。** 真实 Worker 闭环证明 enable 后旧 Session 继续读、新 Session 开始要求新 Key；reset 后旧 Session 为 `SHARE_UNAVAILABLE`、旧 Key 为 `SHARE_AUTH_REQUIRED`、新 Key 可建 Session；disable 后旧 Session 为 `SHARE_UNAVAILABLE`，hash/kid 已清空且新 Session 不再要求 Key。disable 请求携带旧 Key 仍成功是“多余字段被忽略”，旧 Key 已不再提供任何授权能力。
8. **错误码与零变更成立。** 他人/不存在/畸形 shareId、已撤销、已过期均为 `SHARE_NOT_FOUND`；闭集外 action 与三类非法迁移均为 `SHARE_INVALID_CONFIG`，且四列不变。条件 UPDATE 的 `meta.changes === 0` 明确转为 `SHARE_NOT_FOUND`；并发 disable 覆盖只有一条迁移成功、cv 只加一次。
9. **单入口与冻结面成立。** Owner API 只新增 `POST /mailShare/resetAuthKey`，沿用 `withShare`、`shareJson(no-store)` 与当前用户上下文。`UPDATE_FIELDS`、`OWNER_ROW_COLUMNS`、`SHARE_EVENT` 均未改；没有静默打开 `SHARE_CAPABILITY_V2`，没有修改 `security.js`。

## 测试与静态证据

- 指定测试：1 file / 219 tests，全部通过，EXIT=0。
- Visitor 闭环实际产生预期的 `share.session.denied_auth` / `share.session.denied_cv`，结构化输出只含固定 reason、event、requestId、shareId、ts，不含 AuthKey 明文。
- 测试输出有初始化阶段既有的 `auto_refresh_time` 缺列警告；匿名鉴权负例会打印既有 `verifyToken` TypeError 栈与登录过期提示，但断言通过，且该路径归 T-17 的 `security.js` 收口，不构成 T-16 缺陷。
- `git diff --check 3bb1d55^..3bb1d55`：通过。
- 提交 churn：执行笔记 +172；API +8；service +95/-1；spec +514/-0。
- HEAD `3488bf0` 相对 `3bb1d55` 在三份审查文件和全部列出的对照文件上无差异。

## 实际运行命令

```sh
git status --short --branch
git show --stat --oneline --decorate --no-renames 3bb1d55
git show --format= --name-only --no-renames 3bb1d55

git diff --name-status 3bb1d55^ 3bb1d55 -- mail-worker/src/security/security.js mail-worker/src/init/init.js mail-worker/src/service/share-auth-service.js mail-worker/src/api/share-api.js mail-worker/wrangler.toml mail-worker/wrangler-vitest.toml
git diff --unified=3 3bb1d55^ 3bb1d55 -- mail-worker/src/api/mail-share-api.js mail-worker/src/service/mail-share-service.js
git diff --check 3bb1d55^..3bb1d55
git diff --numstat 3bb1d55^..3bb1d55

git rev-parse HEAD
git log --oneline --decorate 3bb1d55..HEAD
git diff --quiet 3bb1d55..HEAD -- mail-worker/src/service/mail-share-service.js mail-worker/src/api/mail-share-api.js mail-worker/test/mail-share-service.spec.js mail-worker/src/security/security.js mail-worker/src/init/init.js mail-worker/src/service/share-auth-service.js mail-worker/src/api/share-api.js mail-worker/wrangler.toml mail-worker/wrangler-vitest.toml

pnpm --dir mail-worker exec vitest run test/mail-share-service.spec.js --no-cache
```
