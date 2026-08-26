# T2 · high-risk 独立审查

## 1. verdict

`NEEDS_CHANGES`：2 条 P2 功能/授权回归，1 条 P2 架构契约违例。

## 2. findings

### T2-F1 · 角色行缺失时建号授权从 fail-closed 变成 fail-open

- severity: P2
- anchor: `mail-worker/src/service/mailbox-provision.js:147`
- symbols: `planMailboxProvision`, `roleService.selectById`, `countOwnedMailboxes`, `roleService.hasAvailDomainPerm`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:96-99` 把「角色域名权限、配额」列为两个入口共同且不可裁剪的建号不变量；同文件 `:102` 要求全量预校验。`mail-worker/src/entity/user.js:6` 与 `mail-worker/src/init/init.js:801-811` 又证明 `user.type` 没有到 `role` 的外键，缺失角色是可表示状态。
- identity_scope: `MailboxProvision/RolePolicyFailClosed`
- failure_mode: `roleService.selectById` 返回空值后，两个 `if (roleRow)` 分支同时跳过配额和域名白名单，随后地址被列入 `missing` 并可写入。
- trigger: 普通用户的 `user.type` 指向不存在的角色后，从设置页或 `emails[]` 分享入口创建尚不存在的邮箱；该状态可由无事务的角色变更交错产生，且数据库没有外键阻止。
- impact: 该用户可绕过 `accountCount` 与 `availDomain` 两道角色策略创建 account；旧 `accountService.add` 会在读取 `roleRow.accountCount` 时终止，至少不会写入。
- required_fix: 在 `mailbox-provision` 的共享不变量层对非管理员强制要求角色存在，角色缺失必须以稳定拒绝结果 fail-closed；设置页与分享入口共同复用该判定，并补缺失角色的零写入回归。
- verify: `git -C /tmp/review-share-fullchain show 12cec61a0d4a1e7c99d1316b9ef9b75715c893b3:mail-worker/src/service/account-service.js | rg 'roleRow\\.accountCount|hasAvailDomainPerm' && rg -n 'if \\(roleRow' /tmp/review-share-fullchain/mail-worker/src/service/mailbox-provision.js`，期望退出码 `0`（复现旧 fail-closed 与新跳过分支的差异）。
- risk_spread: `设置页建号行为等价性`；origin=`account-service.add`；hop1=`mailbox-provision.planMailboxProvision`；surface=`role-service.selectById/hasAvailDomainPerm`；stop=`已定位 roleRow 为空时的新链路放行分支`。

### T2-F2 · 前缀黑名单在搬迁时未经契约授权改成大小写不敏感

- severity: P2
- anchor: `mail-worker/src/service/mailbox-provision.js:102`
- symbols: `planMailboxProvision`, `emailUtils.getName`
- rule_source: T2 的判据明确包含设置页改前行为；基线 `accountService.add` 使用 `getName(email).includes(content)`。决策卡 `:96-100` 只授权下沉同一组不变量，`mailbox-provision.js:17-19` 也声明两个入口的差异只在包装层，没有授权扩大前缀黑名单拒绝集。
- identity_scope: `SettingsAddMailbox/PrefixFilterRejectionSet`
- failure_mode: 新实现同时 lowercase 前缀和 token，使旧设置页允许的、仅大小写不同的地址现在被 `PREFIX_FORBIDDEN` 拒绝。
- trigger: 例如 `emailPrefixFilter=['admin']` 且提交 `Admin@example.com`；基线大小写敏感比较不命中，新链路命中。
- impact: 与分享需求无关的既有设置页会拒绝此前可创建的合法地址，且现有测试只查文案类别，没有固定这条兼容行为。
- required_fix: 在共享 provision 真源中恢复设置页既有的大小写语义；若确需收严，先把大小写归一化写成明确契约并以两个入口共用的拒绝矩阵固定，不能在调用方另加补丁分叉。
- verify: `git -C /tmp/review-share-fullchain show 12cec61a0d4a1e7c99d1316b9ef9b75715c893b3:mail-worker/src/service/account-service.js | rg 'getName\\(email\\)\\.includes\\(content\\)' && rg -n 'prefix\\.toLowerCase\\(\\)\\.includes' /tmp/review-share-fullchain/mail-worker/src/service/mailbox-provision.js`，期望退出码 `0`。
- risk_spread: `设置页建号行为等价性`；origin=`account-service.add`；hop1=`mailbox-provision.planMailboxProvision`；surface=`email-utils.getName`；stop=`旧 add 的前缀拒绝分支已对上，差异判定为未获授权的收严`。

### T2-F3 · provision 模块经 user-service 间接回到 account-service，禁环依赖未成立

- severity: P2
- anchor: `mail-worker/src/service/mailbox-provision.js:6`
- symbols: `mailbox-provision` module, `user-service` module, `account-service` module, `mail-share-service` module
- rule_source: `mailbox-provision.js:14-15` 明文禁止回到 `mail-share-service` / `account-service`；决策卡 `:96` 要求新模块无这两项依赖以打破循环。
- identity_scope: `MailboxProvision/ServiceImportDAG`
- failure_mode: 新模块 import `user-service`，而 `user-service.js:2` import `account-service`，后者 `account-service.js:13` 又 import `mailbox-provision`，形成 `mailbox-provision → user-service → account-service → mailbox-provision`；同时 `account-service.js:12 → mail-share-service.js:7 → mailbox-provision` 构成更大的 SCC。
- trigger: Worker 冷启动或测试隔离加载 account/share/provision 任一模块时进入该强连通分量；当前函数内延迟读取没有立刻触发 TDZ，但模块初始化正确性已依赖求值顺序。
- impact: 设计卡承诺的无环下层没有落地；后续任一模块增加顶层导出读取就会把该结构性违例转成冷启动未初始化错误，且无法独立 mock/probe provision 层。
- required_fix: 把 provision 所需的用户/角色读取下沉到不依赖 account/share 的叶子 repository/policy 模块（或显式注入），使 import 图本身无环；不得只调整 import 顺序掩盖 SCC。
- verify: `rg -n "^import userService from './user-service'" /tmp/review-share-fullchain/mail-worker/src/service/mailbox-provision.js && rg -n "^import accountService from './account-service'" /tmp/review-share-fullchain/mail-worker/src/service/user-service.js && rg -n "^import .*mailbox-provision" /tmp/review-share-fullchain/mail-worker/src/service/account-service.js`，期望退出码 `0`。
- risk_spread: `provision 模块的依赖方向`；origin=`mailbox-provision import 段`；hop1=`user-service → account-service`；hop2=`account-service → mailbox-provision`（并经 `mail-share-service → mailbox-provision` 回环）；surfaces=`user-service.js, account-service.js, mail-share-service.js`；stop=`已定位回到 account-service/mail-share-service 的实际环`。

## 3. 设置页等价性对账

- 等价：`addEmail/manyEmail`、空值、邮箱格式、最短前缀、已删账号、已注册/他人账号、Turnstile 与验证计数包装；正常存在的角色下，单地址 `count >= limit` 与 `owned + 1 > limit` 等价，计数谓词均为 `user_id + is_del=NORMAL`。
- 有意差异、非 finding：域名改为 JSON 字符串/数组统一解析、域名小写后精确匹配，符合决策卡 `:36-38` 的禁止字符串子串匹配不变量。
- 回归：缺失角色 fail-open（T2-F1）；前缀黑名单大小写收严（T2-F2）。
- 改善、非 finding：缺失用户改为稳定 401；UNIQUE 竞态重读并映射既有设置页文案；返回 DTO 字段与 `account` entity 对齐。

## 4. `env.domain` risk spread

- `configuredDomains`：`mailbox-provision.js:52-65`，JSON 字符串/数组、小写精确匹配。
- 同口径解析：`setting-service.js:48-62` 解析 JSON 字符串，但不 lowercase。
- 仍用旧 `.includes`：`user-service.js:309`、`login-service.js:64`、`public-service.js:107`。
- 配置形态：`wrangler-{dev,test,vitest}.toml` 为数组；`wrangler-action.toml:52` 为字符串插值；生产 `wrangler.toml:69` 只给数组示例，Dashboard 可提供 JSON 字符串。
- 判定：全仓口径不一致已确认，命中 stop_when；这些旧调用点未被 T2 diff 改动，且决策卡 `:276`、`:354` 明确列为本轮不处理，故不另报跨主题 finding。

## 5. provision 依赖 risk spread

- `mailbox-provision → user-service → account-service → mailbox-provision`：2 hops 内闭环。
- `mailbox-provision → role-service → user-service → account-service → mailbox-provision`：经 role 分支同样回环。
- `account-service → mail-share-service → mailbox-provision` 把分享服务也纳入同一 SCC。
- 已命中 stop_when，见 T2-F3；未继续扩图。

## 6. verification

- 静态证据：已读 reviewed HEAD `9b6eb8072fe73c93518e872037702a2e8e54056b`、基线 `12cec61...` 的 `accountService.add`、T2 三个预算允许面及相关判据。
- 尝试命令：`pnpm test -- mail-share-emails.spec.js`。
- 结果：退出码 `1`，review worktree 无 `node_modules`（`vitest: not found`）；复用 `/workspace/mail-worker/node_modules` 再试，退出码 `1`，Vite 无法从 review root 解析 `@cloudflare/vitest-pool-workers`，未执行任何测试。
- 工作树复核：`git status --short` 空；未改业务文件。

## 7. stop_when

- `设置页建号行为等价性`：旧 add 的全部拒绝分支已逐条找到对应项并完成“等价 / 有意差异 / 回归”分类。
- `c.env.domain 形态假设`：已列出统一解析与仍使用旧口径的全部命中点。
- `provision 模块的依赖方向`：已在允许 2 hops 内定位实际回环。
- 三项均命中 stop_when，审查在 T2 边界停止。
