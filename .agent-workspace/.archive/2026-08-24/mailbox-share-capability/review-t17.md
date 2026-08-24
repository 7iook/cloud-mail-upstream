# T-17 独立代码审查

VERDICT APPROVED

- review target: `d18f027aa6356ac3d6282d5f5e964e4282ba4346`
- p0: 0
- p1: 0
- CHANGE: none
- HOLD:
  - T17-ADMIN：`c.env.admin` 后门的正向契约用例按既定裁决本轮不补，不计入缺陷。
  - 后续 `33ad281` 只含 `review-t16.md`、`session-ledger.md` 与 `tasks.md` 的 Evidence / 审查记录；本轮列出的生产、路由和测试文件相对 `d18f027` 均无差异，未把它计入缺陷。

## Findings

无 P0/P1 finding。

## 逐项结论

1. **提交范围符合白名单。** `git show d18f027 --stat` 仅列出事实锚 `exec-t17-note.md`（+149）、`security.js`（+19/-2）与 `security-share.spec.js`（+168/-21）。生产代码只改 `requirePermsExact` 与 `premKey['share:manage']` 两处数组；`mail-share-service.js`、`mail-share-api.js`、`share-api.js` 在该提交中均无差异。
2. **两张权限表各有 8 条且路径集合一致。** `requirePermsExact` 为 `POST create / GET list / GET get / PUT update / DELETE delete / PUT bindings / DELETE revoke / POST resetAuthKey`；`premKey['share:manage']` 含同序 8 个路径，均无重复。机械集合比较同时确认前者的 method+path 集合与 `mail-share-api.js` 声明的 8 条 Owner 路由完全一致。
3. **冻结安全表未被改动。** 对 `d18f027^` 与 `d18f027` 分段比较，`excludePrefixes`、`excludeExact`、`requirePerms` 三段逐字相同；`excludeExact` 仍精确包含 `{ method: 'GET', path: '/share/mailboxes/status' }`，`requirePerms` 未加入 `/mailShare` 前缀。中间件、`matchesExact` 与 `permKeyToPaths` 逻辑也无改动。
4. **无权 JWT 的 8 路拒绝契约完整。** A2 表驱动组逐条使用非 admin 的 role 99 JWT，断言 `code === 403` 且 `message === 'SHARE_FORBIDDEN'`；指定测试 148/148 通过。消息断言能排除前缀权限分支同为 403 的通用 `Unauthorized`，直接证明命中了 Owner 精确权限分支。
5. **持权 JWT 的 8 路正向契约完整。** A3 表驱动组逐条使用绑定 `share:manage` 的 role 98 JWT，断言 HTTP 200 且业务码非 401/403；POST/PUT 均发送可解析 JSON，避免异常路径假绿。另有路由集合闭包断言，404 空路由不能伪装成正向通过。
6. **Visitor token 打 Owner 的结果正确钉为 401。** 用例经真实 create + session 握手铸造 `s1.*` 四段 share token，并先断言 token 形状；随后对 8 条 Owner 路由逐条断言 401 与 `Authentication has expired. Please sign in again`，没有错误要求 `SHARE_FORBIDDEN`。
7. **“只改一张表”会被现有用例抓住。** 若只保留 `requirePermsExact` 的新增项，持权 JWT 因 `premKey` 缺路径而收到 403，A3 的 8 路正向组失败；若只保留 `premKey` 的新增项，请求不进入精确权限分支，无权 JWT 会落到 handler 的业务响应，A2 的 403 + `SHARE_FORBIDDEN` 组失败。两组覆盖相反失效模式，无需实际改动代码即可确认 T17-BOTH 的回归保护。
8. **Visitor 隔离与零写面覆盖成立。** Owner JWT 打四条 Visitor 读路由得到 `SHARE_UNAVAILABLE`，`/share/session` 带不带 Owner JWT 的响应完全一致；静态断言禁止 `share-api.js` 引入登录态设施，并确认其唯一非 GET 路由仅为 session 握手。仓库级路由扫描也确认全部 `/share*` 声明只位于 `share-api.js`。
9. **精确匹配封闭性成立。** 8 条 Owner 路由各派生尾缀、下级和截断三类近似路径：无 JWT 均为 401，带无权 JWT 均为 404 而非 403；大小写与尾斜杠变体也为 404。既有 `/share-evil` 与 `/share/mailboxes/statusX` 等基线保留，证明既未改 `excludeExact` 语义，也未把 `/mailShare` 塞入 `requirePerms` 前缀表。

## 测试与静态证据

- 指定测试：`pnpm --dir mail-worker exec vitest run test/security-share.spec.js --no-cache` → 1 file / 148 tests 全部通过，EXIT=0。
- 测试输出含初始化阶段既有的 `auto_refresh_time` 缺列提示，以及无 JWT 负例触发的既有 `verifyToken` TypeError 日志；断言全部通过，这些路径不是 `d18f027` 新增的生产逻辑，不构成 T-17 缺陷。
- `git diff --check d18f027^..d18f027 -- mail-worker/src/security/security.js mail-worker/test/security-share.spec.js`：通过。
- 整提交 `git diff --check d18f027^..d18f027` 仅在 `exec-t17-note.md` 的 diff 示例两行报告 “space before tab in indent”；不涉及生产代码或测试语义，不列 P0/P1。
- 提交 churn：执行笔记 +149；security +19/-2；spec +168/-21。
- HEAD `33ad281` 相对 `d18f027` 在 `security.js`、`security-share.spec.js`、`mail-share-service.js`、`mail-share-api.js`、`share-api.js` 上均无差异。

## 实际运行命令

```sh
git status --short --branch
git show --stat --oneline --no-renames d18f027
git show --format=fuller --no-ext-diff --no-renames d18f027 -- mail-worker/src/security/security.js mail-worker/test/security-share.spec.js

git diff --name-status d18f027^ d18f027
git diff --numstat d18f027^ d18f027
git diff --name-status d18f027^ d18f027 -- mail-worker/src/service/mail-share-service.js mail-worker/src/api/mail-share-api.js mail-worker/src/api/share-api.js
git diff --check d18f027^..d18f027 -- mail-worker/src/security/security.js mail-worker/test/security-share.spec.js

git rev-parse HEAD
git log --oneline --decorate d18f027..HEAD
git diff --name-status d18f027 HEAD -- mail-worker/src/security/security.js mail-worker/test/security-share.spec.js mail-worker/src/service/mail-share-service.js mail-worker/src/api/mail-share-api.js mail-worker/src/api/share-api.js

pnpm --dir mail-worker exec vitest run test/security-share.spec.js --no-cache
```
