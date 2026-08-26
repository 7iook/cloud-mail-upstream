# T8 · Cloud Agent 开发环境配置 leftover 独立审查

- 被审提交：`6985f0ef09421798c6cac2495bc2f501dcf7c7e7`
- 审查范围：仅 `.cursor/environment.json`、`.cursor/install.sh`
- 审查方式：read-only；未修改被审代码，未重复 `deploy-cloudflare.yml` 机械闸门
- 结论：**无新 unique delta；无 finding**

## 决定性证据：review_focus #1

`origin/main` 已通过 PR #1 的 squash 提交纳入同一补丁，而 leftover 原提交本身不是 `origin/main` 的祖先：

```text
$ git log --format='%H %P %s' --follow origin/main -- .cursor/environment.json
130043b503d5a76bc5f00b51e38247b6f0962165 7d7fdf15168b8c4da32c4b90f776887aec8a8e65 chore: add Cloud Agent development environment config (#1)

$ git merge-base --is-ancestor 6985f0ef09421798c6cac2495bc2f501dcf7c7e7 origin/main
exit 1
```

对目标两文件做树间比较，无输出且退出码为 0：

```text
$ git diff --no-ext-diff --exit-code origin/main 6985f0ef09421798c6cac2495bc2f501dcf7c7e7 -- .cursor/environment.json .cursor/install.sh
exit 0

$ git diff --no-ext-diff --raw origin/main 6985f0ef09421798c6cac2495bc2f501dcf7c7e7 -- .cursor/environment.json .cursor/install.sh
(no output)

$ git diff --no-ext-diff --numstat origin/main 6985f0ef09421798c6cac2495bc2f501dcf7c7e7 -- .cursor/environment.json .cursor/install.sh
(no output)
```

两棵树中的 mode 与 blob OID 也逐文件相同，这是 byte-identical 的直接 Git 锚点：

```text
$ git ls-tree origin/main -- .cursor/environment.json .cursor/install.sh
100644 blob 53d2455e72b0c0d030a63b8e68786562a45ee4f8	.cursor/environment.json
100755 blob 0425ae5e7363d9a50c8878caf3dad64203306a66	.cursor/install.sh

$ git ls-tree 6985f0ef09421798c6cac2495bc2f501dcf7c7e7 -- .cursor/environment.json .cursor/install.sh
100644 blob 53d2455e72b0c0d030a63b8e68786562a45ee4f8	.cursor/environment.json
100755 blob 0425ae5e7363d9a50c8878caf3dad64203306a66	.cursor/install.sh
```

两次引入的 stable patch-id 亦相同：

```text
6985f0e patch-id: 0efad22e3d6d7cb95302fa263c4f3c1a9b5fca88
130043b patch-id: 0efad22e3d6d7cb95302fa263c4f3c1a9b5fca88
```

因此 `6985f0e` 相对 `origin/main` 在本主题上没有可审的独有差异；不能把已合入 main 的相同内容再次登记为本轮新增 finding。

## review_focus #2–#4 取证

### #2 `--frozen-lockfile` 的三个前提

三组 manifest/lockfile 均由 `origin/main` 跟踪：

```text
mail-worker/package.json
mail-worker/pnpm-lock.yaml
mail-vue/package.json
mail-vue/pnpm-lock.yaml
tests/e2e/package.json
tests/e2e/pnpm-lock.yaml
```

静态逐项核对的锚点：

- `mail-worker/package.json:12-29` 与 `mail-worker/pnpm-lock.yaml:10-56`：dependencies/devDependencies 的包名与 specifier 一致。
- `mail-vue/package.json:14-45` 与 `mail-vue/pnpm-lock.yaml:10-98`：dependencies/devDependencies 的包名与 specifier 一致。
- `tests/e2e/package.json:12-14` 与 `tests/e2e/pnpm-lock.yaml:10-13`：`@playwright/test: 1.55.0` 一致。

这证明当前 main 上三个 frozen install 的 lockfile 前提齐备；同时这些文件不是 leftover 的 unique delta。

### #3 构建产物与忽略规则

`.cursor/install.sh:15-18` 的构建目标为 `mail-worker/dist`；根 `.gitignore:12` 的 `dist` 规则覆盖该目录：

```text
$ git check-ignore -v mail-worker/dist mail-worker/dist/index.html
.gitignore:12:dist	mail-worker/dist
.gitignore:12:dist	mail-worker/dist/index.html
```

### #4 失败语义

- `.cursor/install.sh:4` 使用 `set -euo pipefail`。
- `.cursor/install.sh:27-30`：`playwright install --with-deps chromium` 失败会输出原命令错误并打印显式 fallback 提示；browser-only fallback 自身若失败，仍会在 `set -e` 下令脚本失败。
- browser-only 安装成功并不验证宿主机共享库是否齐备，所以单凭该 fallback 不能对任意宿主机推出“E2E 一定可运行”。这是已合入 main 的同字节基线行为，不是 `6985f0e` 相对 main 的 unique delta，本主题不重复登记 finding。
- `.cursor/install.sh:33` 仅对 Wrangler telemetry disable 使用 `|| true`；失败输出未被重定向，不影响依赖安装、SPA 构建或 Chromium 安装。
- 只读语法探针：`git show origin/main:.cursor/environment.json | python3 -m json.tool` 与 `git show origin/main:.cursor/install.sh | bash -n` 均退出 0。

## Findings

**无 finding。**

理由不是“未发现依据”，而是可复现 Git 证据证明被审两文件相对 `origin/main` 为 byte-identical，故本 leftover 没有新的审查增量。七项 finding 字段无条目可填，不制造空壳 finding。

