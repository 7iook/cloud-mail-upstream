# T2 · mailbox-provision 独立审查

## F-T2-01

- severity: P1
- anchor: `mail-worker/src/service/mailbox-provision.js:52`
- symbols: `configuredDomains`, `loginService.register`, `userService.add`, `publicService.addUser`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:35-41` 将“域名必须属于 `configuredDomains(c)` 的精确集合、禁止对 JSON 字符串做 `String.includes`”列为不变量；同文件 `:96-100` 又要求 account 建号不变量只有一个真源。
- identity_scope: 全局 `c.env.domain` 配置的 account 建号准入集合
- failure_mode: 新解析器只覆盖分享与设置页入口，而公开注册、后台建用户、公共批量建用户仍分别在 `login-service.js:64`、`user-service.js:309`、`public-service.js:107` 对原始 `c.env.domain` 做子串 `.includes`，随后绕过 provision 直接写 account。
- trigger: Dashboard 把域名配置为 JSON 字符串 `["example.com"]` 时，公开 `/register` 提交 `user@xample.co`；`'["example.com"]'.includes('xample.co')` 为真，后续 `login-service.js:131-133` 创建 user 与 account。
- impact: 未配置域名可以通过公开注册入口取得用户与 account，精确域名准入不变量没有成为建号单一真源。
- required_fix: 让所有会创建 account 的入口在写入前消费同一个 `configuredDomains` 精确集合；若初始用户邮箱被有意排除在 mailbox provision 的配额语义之外，也必须复用同一域名解析器，而不是保留原始字符串 `.includes`。
- verify: `rg -n "c\\.env\\.domain\\.includes" "mail-worker/src/service/login-service.js" "mail-worker/src/service/user-service.js" "mail-worker/src/service/public-service.js" && node -e "const d='[\"example.com\"]'; process.exit(d.includes('xample.co') ? 0 : 1)"`；期望退出码 `0`。
- risk_spread: `c.env.domain 形态假设`；origin=`mailbox-provision.js:configuredDomains`；hops=1；surfaces=`wrangler.toml` 与全仓其余 `env.domain` 读取点；实际命中 `login-service.js:64`、`user-service.js:309`、`public-service.js:107` 三个旧口径，已在发现差集后停止，未越预算。

## F-T2-02

- severity: P1
- anchor: `mail-worker/src/service/mailbox-provision.js:147`
- symbols: `planMailboxProvision`, `roleService.selectById`, `roleRow`
- rule_source: 决策卡 `share-fullchain-decision-card.md:96-100` 把角色域名权限与配额列为共享建号不变量；改前 `account-service.add` 对非管理员无条件读取 `roleRow.accountCount` 并调用 `hasAvailDomainPerm(roleRow.availDomain, email)`，缺失角色会终止请求而不会写入。
- identity_scope: 非管理员 mailbox provision 的角色配额与域名授权
- failure_mode: `selectById` 返回空值时，新增的两个 `roleRow` truthy guard 同时跳过配额和角色域名权限检查，之后仍返回 `missing` 并允许 INSERT。
- trigger: 非管理员 user 的 `type` 找不到对应 role 行时请求添加一个尚不存在、但属于全局配置域名的邮箱。
- impact: 角色配置缺失从改前的 fail-closed 变为 fail-open，该用户可在没有任何角色配额或域名授权的情况下建号。
- required_fix: 对非管理员显式拒绝缺失的 `roleRow`，仅在确认角色存在后执行配额与域名权限判定；不得用条件包裹把授权检查整体省略。
- verify: `git show fabe6e841109dfb84b8b4da651c7caa03a5d7db4^:"mail-worker/src/service/account-service.js" | rg -n "roleRow\\.accountCount|hasAvailDomainPerm\\(roleRow\\.availDomain" && rg -n "if \\(roleRow && roleRow\\.accountCount > 0\\)|if \\(roleRow\\)" "mail-worker/src/service/mailbox-provision.js"`；期望退出码 `0`。
- risk_spread: `设置页建号行为等价性`；origin=`account-service.js:add`；hops=`add → planMailboxProvision → roleService.selectById`；surfaces=`mailbox-provision.js`、`role-service.js`；在确认缺失角色的新旧分支差异后停止，未越预算。

## F-T2-03

- severity: P2
- anchor: `mail-worker/src/service/mailbox-provision.js:102`
- symbols: `planMailboxProvision`, `emailPrefixFilter`, `PROVISION_DENIED.PREFIX_FORBIDDEN`
- rule_source: T2 的无直接 AC 判据是设置页改前行为；`fabe6e8^:mail-worker/src/service/account-service.js` 使用 `getName(email).includes(content)`，大小写敏感。决策卡只显式批准 `configuredDomains` 的精确匹配，没有批准前缀黑名单改为大小写不敏感。
- identity_scope: 设置页 `accountService.add` 的前缀黑名单拒绝集合
- failure_mode: 搬迁时同时对 prefix 与 token 做 `toLowerCase()`，把原先可通过的混合大小写 local-part 纳入拒绝集合。
- trigger: `emailPrefixFilter=['spam']` 时通过设置页添加 `SPAMbox@example.com`；旧谓词为 false，新谓词为 true。
- impact: 既有设置页请求在没有契约变更的情况下被新增拒绝；现有测试只覆盖小写 token 命中小写 prefix，未固定该边界。
- required_fix: 在 provision 真源中保留设置页原有的大小写敏感匹配；若产品要收严，须先把大小写归一化记为明确契约变更，并补充混合大小写的正反回归用例。
- verify: `git diff --unified=3 fabe6e841109dfb84b8b4da651c7caa03a5d7db4^ fabe6e841109dfb84b8b4da651c7caa03a5d7db4 -- "mail-worker/src/service/account-service.js" "mail-worker/src/service/mailbox-provision.js" | rg -n "includes\\(content\\)|prefix\\.toLowerCase\\(\\).*String\\(token\\)\\.toLowerCase"`；期望退出码 `0`。
- risk_spread: none

## F-T2-04

- severity: P2
- anchor: `mail-worker/src/service/mailbox-provision.js:6`
- symbols: `mailbox-provision`, `userService`, `accountService`, `PROVISION_TO_ADD_ERROR`
- rule_source: 决策卡 `share-fullchain-decision-card.md:96` 要求新模块“无依赖 mail-share / account-service，打破循环”；模块自身 `mailbox-provision.js:14-15` 也禁止反向依赖。
- identity_scope: `mailbox-provision` 作为 account/mail-share 下层模块的依赖方向
- failure_mode: 实际图为 `mailbox-provision → user-service → account-service → mailbox-provision`，新模块进入循环强连通分量，并未建立声明的下层边界。
- trigger: Worker 冷启动加载 account 或 mail-share API 模块时评估该静态 import 图。
- impact: provision 没有获得声明的无环传递依赖边界；`account-service` 又在同一循环中于模块顶层读取 `PROVISION_DENIED` 构造映射，使模块评估顺序与该强连通分量绑定。
- required_fix: 把 provision 所需的 user/role 查询下沉到不依赖 `account-service`/`mail-share-service` 的 repository，或通过无环的依赖注入提供读取器，并增加静态循环闸门。
- verify: `rg -n "from './(mailbox-provision|user-service|account-service|mail-share-service)'" "mail-worker/src/service/mailbox-provision.js" "mail-worker/src/service/user-service.js" "mail-worker/src/service/account-service.js"`；期望退出码 `0`。
- risk_spread: `provision 模块的依赖方向`；origin=`mailbox-provision.js` import 段；hops=2（`mailbox-provision → user-service → account-service`，随后命中 account 对 origin 的反向 import 即停止）；surfaces=`user-service.js` 及其一层依赖 `account-service.js`；已定位成环，未越预算。

## 验证说明

定向测试命令 `pnpm -C mail-worker test -- mail-share-emails.spec.js` 在用例启动前退出 `1`：被审工作树没有 `node_modules`，报错为 `vitest: not found`。遵守 read-only 约束，未在工作树安装依赖；以上四条的 `verify` 命令均已实际执行并返回 `0`。
