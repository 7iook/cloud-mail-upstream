# T-11 P1-1 修复复审

VERDICT: APPROVED

复审对象：提交 `e63998e`（`fix(worker): reject illegal mailbox strings in maskAddress`）。

## P0

无。

## P1-1 关闭结论

CLOSED。

- `isMailboxAddress` 在 `maskAddress` 返回原地址或生成掩码前统一校验输入：拒绝非字符串、任意 `\s` 空白、缺失/首尾 `@` 以及第二个 `@`。
- 因此多 `@` 与含空白输入在 `showFullAddress` 为 `true`、`false` 时都返回 `***`，该路径不抛异常。
- 合法 `local@domain` 保持原契约：开关开启时原样返回，关闭时生成 `首字符 + *** + @domain`。
- 已掩码的合法形态（如 `a***@example.com`）仍通过校验；两种开关状态下的幂等测试继续成立。
- 修复仅涉及邮箱形态校验及其测试反例，未发现新增 P0。

## 测试与证据

```sh
git show e63998e --stat
pnpm --dir mail-worker exec vitest run test/share-mail-service.spec.js --no-cache
```

结果：目标提交改动 2 个文件（实现与测试）；Vitest 退出码为 0，`1` 个测试文件、`23/23` 个测试通过。

补充核对：当前 `HEAD` 包含 `e63998e`，且 `e63998e..HEAD` 在 `share-mail-service.js` 与 `share-mail-service.spec.js` 上无差异。
