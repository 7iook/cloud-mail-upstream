# T-11 执行记录 · 投影层(掩码/OTP 裁剪/Binding 标识) + 详情/附件可见集复查

分支 `cursor/mailbox-share-capability-dcb6` · 基线 HEAD `81ad852` · 未提交（按派发要求不 add/commit/push）。

## 成功状态复核

访客只看到白名单邮件字段 + Binding 身份（`bindingId`）+ 掩码邮箱地址（`mailboxAddress`）；`code` 键存在当且仅当 `otp_extraction_enabled=true`；被 N 滚出 / 窗口外 / 属于他分享的邮件与附件一律 `SHARE_UNAVAILABLE`。负向：投影里没有 `user_id`/`account_id` 原值，没有 `/oss/` 直链，发件人/主题/正文不掩码，`mail-worker/src/email/email.js` 零改动。

## 红 → 绿

| 阶段 | 命令 | 结果 |
|---|---|---|
| 红 | `pnpm --dir mail-worker exec vitest run test/share-mail-service.spec.js test/share-attachment-service.spec.js --no-cache` | EXIT=1 · **19 failed / 26 passed / 45**（mail 23 中 15 红 · att 22 中 4 红） |
| 绿 | 同上 | EXIT=0 · **45 passed / 45** |

红灯成因是功能缺失而非断言写错，四类：

1. `default.maskAddress is not a function`（helper 不存在）。
2. 键集缺 `bindingId` / `mailboxAddress`（`expected undefined to be 8001`）。
3. `code` 无条件存在（`otpExtractionEnabled=false` 时仍带 `'847291'`）。
4. 附件侧：`shareContext.accountId` 垫片假设导致非主 Binding 被拒（`BizError: SHARE_UNAVAILABLE`），以及先查 `attachments` 后过可见集导致越界 mailId 仍被探针（`expected "spy" to not be called at all, but actually been called 1 times`）。

红灯为**回退实现源码、保留测试**后重跑取得（`git checkout -- src/service/share-mail-service.js src/service/share-attachment-service.js` → 跑 → 还原），退出码真实捕获。

旁证（跑，只在契约破坏处改断言）：

- `pnpm --dir mail-worker exec vitest run test/share-api.spec.js test/share-integration.spec.js --no-cache` → 首跑 EXIT=1，唯一失败是 `share-integration.spec.js` 的 `VISITOR_MAIL_KEYS` 黄金键集少了新增两键；改完 EXIT=0 · **25 passed / 25**。`share-api.spec.js` 零改动即绿。
- 全量 `pnpm --dir mail-worker test --no-cache` → EXIT=0 · **18 文件 / 410 用例**（含并行 T-14 在同工作树落的 `test/share-status.spec.js` 9 条）。

## 落地文件

- `mail-worker/src/service/share-mail-service.js`
  - `:7-22` 新增 `maskAddress(address, showFullAddress)`
  - `:64-71` `resolveBindingId(ctx, accountId)`：Binding 身份从 `ctx.bindings` 反查，不回显行上的 `account_id`
  - `:78-102` `project(emailRow, attachmentRows, ctx, mailboxes)` 扩展
  - `:131-150` `defaultFindAccountEmails` + `loadMailboxes`（`deps.findAccountEmails` 可注入）
  - `:152-182` `maskAddress` 挂到 service；`list` / `getById` 补 ctx 与 mailbox map
- `mail-worker/src/service/share-attachment-service.js`
  - `:108-118` `assertActiveShareContext` 去掉 `accountId > 0` 垫片判据，只留分享态
  - `:133-172` `download` 顺序改为 scoped repo `getById` 先行 → 用命中行的 `accountId` 定位附件
- `mail-worker/test/share-mail-service.spec.js`（整文件改写，23 用例）
- `mail-worker/test/share-attachment-service.spec.js`（22 用例，原 15 条保留 + 新增 7 条）
- `mail-worker/test/share-integration.spec.js`：**只改 `VISITOR_MAIL_KEYS` 常量块**（`:13-27`），未动任何用例逻辑，也未碰 `GET /share/mailboxes/status` describe

未改：`share-auth-service.js` / `share-api.js` / `security.js` / `mail-share-service.js` / `share-scoped-email-repository.js` / `init.js` / `email.js` / i18n / `docs/specs/**` / `tasks.md` / `mail-vue`。无新依赖。

## 关键实现口径

### `maskAddress(address, showFullAddress)`

```js
const text = typeof address === 'string' ? address : '';
const at = text.indexOf('@');
if (at <= 0 || at === text.length - 1) return '***';
return showFullAddress === true ? text : `${text[0]}***${text.slice(at)}`;
```

- 合法 = 字符串 + `@` 不在首位 + 域非空。其余（`''` / 纯空白 / 无 `@` / `@x.com` / `a@` / `null` / 数字 / 对象 / 数组）**一律 `***`，不抛**，且与 `showFullAddress` 无关 —— 一条脏 account 行不该把详情打成 500，也不该在「显示完整地址」下把脏值原样吐出去。
- 幂等：`a***@x.com` 再掩码仍是 `a***@x.com`（首字符 `a` + `***` + `@x.com`）；`***` 无 `@` → `***`。双态各自幂等，用例与 property 都钉了。
- 只有一处 mask helper 归 T-11。`share-auth-service.js:375` 那四行是 session payload 的（T-08 owner，注释里已写明分工），本任务未合并、未改。

### 投影键集

`mailId · bindingId · mailboxAddress · senderName · senderAddress · subject · text · content · receivedAt · attachments`，`code` 条件加挂。

- 字段名取 `bindingId` / `mailboxAddress`：session payload 用的是 `mailboxes[].address`，邮件 DTO 里已有 `senderAddress`，再叫 `address` 会在同一条 JSON 里指两个不同的地址。
- `bindingId` 从 `ctx.bindings` 按 `accountId` 反查。反查不到（行的 account 不在绑定集内）→ `null`，不回显 `account_id`。`bindingId=0`（前 Binding 时代的单邮箱形状）是合法值，用 `!= null` 判而不是真值判。
- `code` 用条件展开 `...(ctx.otpExtractionEnabled === true ? { code } : {})`：**严格 `=== true`**，`1` / `'true'` / `undefined` 一律当关。值恒等 `email.code` 原值（含空串），关时整键消失而不是 `null` —— 一个 `null` 占位仍然在告诉访客页「这里有个 OTP 槽」。

### 邮箱地址从哪来

Binding 不带邮箱地址，ShareContext 已冻结不得加键。`share-mail-service.js` 自己按可见行的 `accountId` 批量查 `account.email`（一次 `inArray`，`list` 与 `getById` 各一次），`deps.findAccountEmails` 可注入给单测。行为零的时候（空列表）不发这条查询。

### 详情/附件唯一强制点

- `shareMailService.getById` 仍只经 `shareScopedEmailRepository.getById`（T-10 的 window ∩ 最新 N SSOT），repo 返 null → service 返 null → `share-api.js` 已映射 `SHARE_UNAVAILABLE`。**没有第二套范围判断**。
- `share-attachment-service.download` 顺序改成：分享态 → 参数形状 → `scopedRepo.getById(c, ctx, mailId)` → 用命中行的 `accountId` 查 `attachments`（`attId + accountId + emailId` 三重）→ 取对象。
  - 先过可见集再碰附件表，是因为「越界 mailId 仍然去查一次 attachments」本身就是存在性探针；用例用 spy 钉了 `findAttachment` 在这种情况下**一次都不被调用**。
  - `accountId` 取自邮件行而不是 `shareContext.accountId`，多 Binding 的 `bindings[1]` 因此能下载（旧代码在这里必拒）。垫片在附件链路已完全不参与鉴权。
  - `assertActiveShareContext` 不再看 `accountId > 0`：空 bindings / `accountId=0` 的 ctx 会在 repo 那步拿到 null，结果同样是 `SHARE_UNAVAILABLE`，没有可区分错误。

## 用例覆盖

`share-mail-service.spec.js`（23）

- `maskAddress` 四条：双态原样/掩码、非法 `***` 不抛、双态幂等。
- **P-MASK-01**（fast-check，60 runs）：`show_full_address` 双态下 `mailboxAddress` 形状与幂等；同一封信里 `senderAddress` / `subject` / `text` / `content` 命中绑定地址时**逐字节原样**；掩码后的 local part 恒为 `首字符***`，不含原 local。另加 per-binding 身份（两个 Binding 各自地址）与「行的 account 不在集合内 → `bindingId=null` / `***`，JSON 里查不到 account 原值」。
- **P-OTP-04**（fast-check，40 runs）：`otpExtractionEnabled ∈ {true,false,undefined,null,1,0,'true',''}` × `code ∈ {'','847291','0000','not-a-code'}`，断言键存在性 === `=== true`，键集整体也跟着切换；另加 otp 关时 JSON 里查不到验证码、空 code 不从主题/正文推断、空 code 仍出主题正文。
- P-PROJ-01 白名单：键集精确相等 + `userId`/`user_id`/`accountId`/`account_id`/`isDel`/`status`/`emailId`/`sendEmail` 全不在；附件键集 + `/share/attachment` 链接 + 无 `/oss/` 无 storage key。
- **真 scoped repo + 真 D1** 五条：窗口内详情带自己的 Binding 身份与掩码地址（`show_full_address=true` 时为完整地址）；各 Binding 独立下界（`belowWindowB` 在 A 的下界之上仍被拒）；`messageLimit=1` 单封 + 新邮件到达后原最新滚出（列表与详情同时失效）；他分享 mailId / 反向 ctx / 「bindingId 好看但 account 是别人」三种篡改一律 null；`list` 逐行白名单 + 多 Binding 各自身份 + JSON 无 `/oss/` 无 `account_id`。
- 注入依赖三条：list/getById 走 mock repo；空结果集不查邮箱地址。

`share-attachment-service.spec.js`（22）

- 原 15 条全部保留（normalize / readObjectNormalized / 分享态 / 客户端 key 不作授权 / no-store / NoSuchKey→`SHARE_UNAVAILABLE`）。
- 新增：`findAttachment` 收到的 `accountId` 来自邮件行而非垫片（断言调用实参）；**真 D1** 下 `bindings[1]` 的附件可下载；响应头/体无 `/oss/` 无 storage key；窗口外邮件附件被拒**且 `findAttachment` 零调用**；`messageLimit=1` 滚出后原本可下的附件失效；mailId/attachmentId/bindingId 五种篡改组合全拒；空 bindings / `accountId=0` 的 ctx 全拒。

## 遗留风险

1. **访客页 otp 关时的表现未验**：`code` 键消失后 `mail-vue/src/views/share/index.vue:170` 的 `hasShareCode(undefined)` 返回 false，OTP 高亮区自然不渲染（符合 AC-OTP-02），但本任务不含前端用例，W5（T-24/T-25/T-26）需把「otp 关 → 无高亮区」补成前端断言。
2. **`bindingId` / `mailboxAddress` 尚无消费方**：`share-api.js` 属禁改区，`GET /share/mails` 的 `bindingId` 入参过滤（design.md `:337`）不在 T-11 范围，目前投影只是把身份**带出去**，多邮箱 Tab 的服务端筛选留给 T-14/W5 接线。
3. **每次 list/getById 多一次 `account` 查询**：批量 `inArray`，单 scope 时一行。可见集行数上限 50，未做请求内缓存；真成为热点再考虑挂 ctx 级 memo（不要写回 ShareContext，它是 frozen）。
4. **软删账号的地址**：`defaultFindAccountEmails` 不过滤 `is_del`。当前不构成泄露——`loadLiveBindings` 已把死账号踢出 `bindings`，repo 也就不会返回它的行，查不到时退化成 `***`。若将来有人绕过 bindings 直接喂 accountId，这里需要补 `is_del` 谓词。
5. **同工作树并行**：T-14 执行者同时在改 `share-api.js` / `security.js` / `share-scoped-email-repository.js` / `security-share.spec.js` / `share-scoped-email-repository.spec.js` 并新建 `test/share-status.spec.js`。本任务的全量 410 绿是**含**这些在飞改动跑出来的；主 AI 复跑时若 T-14 仍在动，数字会变。我对 `share-integration.spec.js` 只改了顶部常量块，与 T-14 在该文件尾部新增的 status describe 无重叠。
6. `share-auth-service.js:375` 的 `maskAddress` 与本任务的实现在「非法输入」上口径不同（前者返回 `a***` / `''`，后者统一 `***`）。两处服务不同响应（session payload vs 邮件投影），按 Decision 14 各自归属，本任务未合并；若后续要统一，应由 ShareContext/session 的 owner 发起。
