# exec-wb-config · 分享功能配置与文档落地(执行记录)

执行者:executor SUB · 日期:2026-08-25 · 包范围:`.gitignore` / `wrangler*.toml` / `README*.md` / `.dev.vars.example`

## 0. 交付契约核验(逐格)

成功状态(原文照抄,未改写):

> NOT「wrangler.toml 里加了几行注释」, BUT 一个从未部署过本项目的人,照着 README 走一遍就能把分享功能配起来并成功创建第一条分享,不会在创建第一步撞上不明所以的 500;而且他在本地填的密钥不会因为一次 git add 就被提交进仓库。
> 不该发生: 密钥示例值被当成真实值直接复制到生产 · 文档写了但与代码实际读取的变量名不一致。

| 链路节点 | producer | consumer | 核验结果 |
|---|---|---|---|
| 忽略规则 | `.gitignore:33-35`(本轮新增) | `git check-ignore` / `git add` 流程 | ✅ EXIT=0 命中 `.gitignore:33:.dev.vars` |
| 配置说明 | `mail-worker/wrangler.toml:59-72` + `README.md:144-193` + `README-en.md` + `.dev.vars.example`(本轮新增) | 部署者(人) | ✅ 已实跑一遍(见 §5) |

最终 sink:部署者按文档操作的结果 + git 仓库不含密钥 —— 两项均实测通过。

## 1. 改动清单

```
 M .gitignore                |  8 ++++++++
 M README-en.md              | 51 +++++++++++++++++++++++++++++++++++++++++++++++
 M README.md                 | 51 +++++++++++++++++++++++++++++++++++++++++++++++
 M mail-worker/wrangler.toml | 12 +++++++++++
?? mail-worker/.dev.vars.example        (新建)
 4 files changed, 122 insertions(+)
```

`.js` / `.vue` 一个未碰(边界遵守)。未执行 `git commit`。

## 2. T-00 · `.gitignore` 位置选择

### 2.1 选了根 `.gitignore`,理由

规则实际内容(`git diff` 中属于本轮的 6 行):

```
# wrangler 本地密钥文件:任何 worker 目录下的 .dev.vars / .dev.vars.<env> 都不入库。
# 前端的 mail-vue/.env.dev|.env.release|.env.remote 是有意纳管的构建配置,不在此列,
# 所以这里只圈 .dev.vars 家族,不写通配的 .env*(本地私有覆盖已由上面的 *.local 兜住)。
.dev.vars
.dev.vars.*
!.dev.vars.example
```

1. **这是仓库级的密钥卫生策略,不是 `mail-worker` 的局部工具产物。** 仓库里有 6 个 wrangler 配置(`mail-worker/wrangler{,-dev,-test,-action,-vitest}.toml` + `tests/e2e/wrangler-e2e.toml`),`tests/e2e/` 将来长出自己的 `.dev.vars` 是完全可能的。放根一次覆盖所有深度(已实测 `tests/e2e/.dev.vars` → EXIT=0)。
2. **根 `.gitignore` 已经是同类规则的所在地**(`node_modules` / `.wrangler` / `*.local` / `dist`),密钥规则放这里维持单一入口,一次 `git grep` 能查全,不用翻各级目录。
3. `mail-worker/.gitignore` 里只有一行工具产物 `.ace-tool/`,性质是「本目录的工具垃圾」,与「仓库禁止入库密钥」不是一类,不该混放。

### 2.2 验证(真跑,含退出码)

```
$ git check-ignore -v mail-worker/.dev.vars
.gitignore:33:.dev.vars	mail-worker/.dev.vars
EXIT=0

$ git check-ignore -v mail-worker/.dev.vars.production
.gitignore:34:.dev.vars.*	mail-worker/.dev.vars.production
EXIT=0

$ git check-ignore -v tests/e2e/.dev.vars
.gitignore:33:.dev.vars	tests/e2e/.dev.vars
EXIT=0

$ git check-ignore mail-worker/.dev.vars.example
EXIT=1        # 期望值:1 = 未被忽略 = 模板文件能正常入库(否例外规则失效)

$ git status --porcelain --ignored=matching -- mail-worker/.dev.vars
!! mail-worker/.dev.vars        # 修复前是 ??
```

## 3. T-00b · `.dev.vars` 历史提交核查

**结论:从未进入过版本历史。无需用户决策,不涉及历史改写。**

```
$ git log --all --oneline -- mail-worker/.dev.vars
(无输出)   EXIT=0

$ git log --all --oneline --diff-filter=A -- "*.dev.vars"
(无输出)   EXIT=0

# 最强证据:遍历全部 commit 的树,搜任何路径含 dev.vars 的 blob
$ git rev-list --all | ForEach-Object { git ls-tree -r --name-only $_ } | Sort-Object -Unique | Select-String "dev\.vars"
(无输出)   EXIT=0
```

第三条命令绕过了 pathspec 与重命名跟踪的盲区(前两条只按路径过滤,历史中若曾用别的路径名会漏),因此可以断言:这个文件的内容从未被任何一次提交记录过。本轮新增的 ignore 规则是**完全有效的保护**,不存在「规则来晚了」的残留风险。

## 4. T-00c · 同类密钥文件变体扫描

### 4.1 扫描结果

```
$ git ls-files --others --exclude-standard | Select-String "\.dev\.vars|\.env|secret|credential|\.pem$|\.key$|\.p12$|\.pfx$|\.vars$"
.agent-workspace/.archive/2026-08-25/share-hardening/recon-credential-recoverable.md
docs/architecture/ADR-share-credential-recoverability.md
mail-worker/.dev.vars.example
```

三个命中都是**文件名里带 credential/vars 字样的文档**,不含任何密钥值 —— 无需处理。

```
$ git ls-files | Select-String "\.env|\.dev\.vars|\.vars$|secret|\.pem$|\.key$"
mail-vue/.env.dev
mail-vue/.env.release
mail-vue/.env.remote

$ git status --porcelain --ignored=matching | Select-String "\.dev\.vars|\.env|\.local"
?? mail-worker/.dev.vars.example
!! mail-vue/.env.dev.local        # 已被 .gitignore:11 的 *.local 覆盖
!! mail-worker/.dev.vars          # 本轮修复
```

### 4.2 为什么**没有**写通配的 `.env*`(这是本轮一个刻意的收窄决定)

已入库的三个 `mail-vue/.env.*` 逐个读过,内容全部是 Vite 构建配置,**不含密钥**:

```
mail-vue/.env.dev      → NODE_ENV / VITE_APP_TITLE / VITE_BASE_URL / VITE_PWA_NAME
mail-vue/.env.release  → 同上 + VITE_OUT_DIR = ../mail-worker/dist
mail-vue/.env.remote   → 同上,VITE_BASE_URL = https://skymail.ink/api
```

这三个是**有意纳管**的构建产物配置。若写 `.env*`:虽然 gitignore 不影响已跟踪文件、不会真的把它们踢出版本控制,但会让后续贡献者以为「本仓库的 .env 都不该入库」,产生误导性的规则冲突。而本地私有覆盖(`.env.local` / `.env.*.local`)已由既有的 `*.local` 覆盖(实测 `mail-vue/.env.dev.local` → `!!`)。所以本轮只圈 `.dev.vars` 家族,并把这个判断写成注释留在规则旁边。

### 4.3 关于三个子目录 `.gitignore` —— 更正:**不是我建的**

主 AI 的接续说明里把 `mail-worker/.gitignore` · `mail-vue/.gitignore` · `mail-vue/src/.gitignore` 记成本轮新建,与事实不符。证据:

```
mail-worker/.gitignore     LastWrite=2026-08-16 21:06:33   内容: .ace-tool/
mail-vue/.gitignore        LastWrite=2026-08-16 21:08:43   内容: .ace-tool/
mail-vue/src/.gitignore    LastWrite=2026-08-16 21:07:24   内容: .ace-tool/
```

三个文件的修改时间都是 **8 月 16 日**,比本次会话早 9 天;内容只有 `.ace-tool/`(ace-tool MCP 的产物目录),与本包主题无关。它们在会话起始的 `git status` 里就已经是 `??`。**本轮我只改了根 `.gitignore` 一个文件。**

同理需要提醒主 AI 提交时注意:根 `.gitignore` 在我动手前**就已经是 `M` 状态** —— HEAD 版 32 行、不含 `.ace-tool/`,工作区 40 行。8 行增量里 `.ace-tool/` + 空行这 2 行不是本轮产物(先前未提交的改动),属于本轮的是后 6 行密钥规则。

```
$ git show HEAD:.gitignore  →  32 行,含 ace-tool 的行数 = 0,含 dev.vars 的行数 = 0
```

### 4.4 对「是否合并到上层」的建议(结论:建议删掉三个,但不由我动手)

`mail-vue/src/.gitignore` 这个位置确实不常见。技术判断:

```
# 根规则本身就跨层级生效(取没有子 .gitignore 的目录验证)
$ git check-ignore -v docs/.ace-tool/x
.gitignore:28:.ace-tool/	docs/.ace-tool/x        EXIT=0
$ git check-ignore -v tests/e2e/.ace-tool/x
.gitignore:28:.ace-tool/	tests/e2e/.ace-tool/x   EXIT=0

# 但在有子文件的目录,匹配由最深的那个 .gitignore 命中(git 就近优先)
$ git check-ignore -v mail-vue/src/.ace-tool/x
mail-vue/src/.gitignore:1:.ace-tool/	mail-vue/src/.ace-tool/x  EXIT=0
```

根 `.gitignore:28` 的 `.ace-tool/` 无前导斜杠,按 gitignore 语义匹配任意深度的同名目录,已实测覆盖 `docs/` 与 `tests/e2e/`。因此**三个子文件在功能上完全冗余**,删掉后行为不变,ignore 规则也能收回单一入口。

不由我执行的原因:① 它们不在本包独占范围内,且非本轮产物;② 删除未跟踪文件是不可逆动作;③ 前提是根 `.gitignore` 的 `.ace-tool/` 那行要被一起提交(它现在也还没入库),否则删了会导致 `.ace-tool/` 反而暴露。**建议主 AI 连同根 `.gitignore` 一起决策。**

## 5. T-11 · 配置说明落地

### 5.1 `wrangler.toml`(+12 行,`:59-72`)

风格对齐文件内既有中文注释(`#变量 = 值   #说明` + tab 缩进的续行),没另起一套。5 项变量各写清了:变量名 / 必需还是可选 / 缺失后果 / 该在哪配。两把必需密钥只写变量名不写 `= 值`,并明确「只能用 `wrangler secret put`,不要写进本段 `[vars]`」。`SHARE_CAPABILITY_V2` 保留了原有的 `keep_vars` 覆盖警告,并补上取值大小写陷阱。

### 5.2 README(中英各 +51 行)

插在「目录结构 / Project Structure」与「赞助 / Sponsor」之间 —— README 是项目介绍型文档(详细部署另有站点 `doc.skymail.ink`),这个位置是「读者已了解项目结构、准备动手」的自然衔接点,且不打断前面的介绍序列。中英两版同步。

内容覆盖:生成两把密钥的命令 → `wrangler secret put` 完整命令 → 变量表(必需性 + 缺失后果)→ 本地 `.dev.vars` 写法 → `SHARE_CAPABILITY_V2` 两个坑。

### 5.3 `.dev.vars.example`(新建,63 行)

占位值一眼可辨:`replace-me-with-32-byte-random` / `replace-me-with-another-32-byte-random`,不存在被误当真串复制的可能。除 5 项主变量外,把代码里实际读取的其余可选项连同默认值一并列出(注释状态),含轮换过渡期的 4 个 `*_PREV` / `*_KID_PREV`。

### 5.4 未同步的其他 wrangler 配置及理由

| 文件 | 处理 | 理由 |
|---|---|---|
| `wrangler.toml` | ✅ 补注释 | 生产部署入口,就是部署者会打开的那个文件 |
| `wrangler-dev.toml` | 不动 | 本地开发用,密钥走同目录 `.dev.vars`(已实测生效,见 §5.5);在此写注释反而会诱导把密钥写进 toml |
| `wrangler-vitest.toml` | **不动** | 测试基线。已在 `[vars]` 里显式固定了 `SHARE_SEC_PEPPER` 等测试值并注明「测试基线跑在栅栏关闭态」,动它等于改测试前提 |
| `wrangler-test.toml` | 不动 | 测试环境部署,同 `wrangler.toml` 的说明已足够 |
| `wrangler-action.toml` | 不动 | CI 模板,`[vars]` 全部由 `${...}` 占位注入;把密钥加进去等于让密钥走明文 vars 通道,与本包「密钥只走 secret put」的结论相反 |
| `tests/e2e/wrangler-e2e.toml` | 不动 | e2e 基线,同 vitest |

## 6. T-11.1 · 一致性核验(真跑 · 双向)

### 6.1 正向:文档里写的每个名字,回代码 grep

文档(`README.md` / `README-en.md` / `wrangler.toml` / `.dev.vars.example`)中出现的 `SHARE_*` 标识共 18 个,逐个 `git grep -n "env\.<名字>" -- mail-worker/src`,15 个环境变量全部 EXIT=0 命中:

```
[EXIT=0] SHARE_SEC_PEPPER               mail-worker/src/service/mail-share-service.js:1124: const pepper = c.env.SHARE_SEC_PEPPER;
[EXIT=0] SHARE_SESSION_SIGNING_KEY      mail-worker/src/service/share-auth-service.js:160:  c.env.SHARE_SESSION_SIGNING_KEY,
[EXIT=0] SHARE_SEC_PEPPER_KID           mail-worker/src/service/mail-share-service.js:1150: const pepperKid = c.env.SHARE_SEC_PEPPER_KID || 'v1';
[EXIT=0] SHARE_MAX_DURATION_SECONDS     mail-worker/src/service/mail-share-service.js:273:  const max = Number(c.env && c.env.SHARE_MAX_DURATION_SECONDS);
[EXIT=0] SHARE_CAPABILITY_V2            mail-worker/src/service/mail-share-service.js:71:   const flag = c.env && c.env.SHARE_CAPABILITY_V2;
[EXIT=0] SHARE_SESSION_SIGNING_KID      mail-worker/src/service/share-auth-service.js:159:  c.env.SHARE_SESSION_SIGNING_KID,
[EXIT=0] SHARE_ENABLED                  mail-worker/src/service/mail-share-service.js:57:   const flag = c.env && c.env.SHARE_ENABLED;
[EXIT=0] SHARE_PUBLIC_ORIGIN            mail-worker/src/service/mail-share-service.js:108:  const fromEnv = c.env && c.env.SHARE_PUBLIC_ORIGIN;
[EXIT=0] SHARE_SESSION_TTL              mail-worker/src/service/share-auth-service.js:214:  const ttlRaw = Number(c.env.SHARE_SESSION_TTL);
[EXIT=0] SHARE_ACTIVE_LIMIT             mail-worker/src/service/mail-share-service.js:265:  const limit = Number(c.env && c.env.SHARE_ACTIVE_LIMIT);
[EXIT=0] SHARE_RETENTION_SECONDS        mail-worker/src/service/mail-share-service.js:281:  const retention = Number(c.env && c.env.SHARE_RETENTION_SECONDS);
[EXIT=0] SHARE_SEC_PEPPER_PREV          mail-worker/src/service/share-auth-service.js:153:  c.env.SHARE_SEC_PEPPER_PREV
[EXIT=0] SHARE_SEC_PEPPER_PREV_KID      mail-worker/src/service/share-auth-service.js:152:  c.env.SHARE_SEC_PEPPER_PREV_KID,
[EXIT=0] SHARE_SESSION_SIGNING_KEY_PREV mail-worker/src/service/share-auth-service.js:162:  c.env.SHARE_SESSION_SIGNING_KEY_PREV
[EXIT=0] SHARE_SESSION_SIGNING_KID_PREV mail-worker/src/service/share-auth-service.js:161:  c.env.SHARE_SESSION_SIGNING_KID_PREV,
```

余下 3 个 EXIT=1(不是环境变量,已单独定性,不是拼写错误):

```
SHARE_SESSION_RATE_LIMITER  → mail-worker/src/security/share-rate-limit.js:31  binding 名常量(wrangler.toml [[ratelimits]] 既有项,非本轮新增)
SHARE_READ_RATE_LIMITER     → mail-worker/src/security/share-rate-limit.js:32  同上
SHARE_UNAVAILABLE           → mail-worker/src/service/share-auth-service.js:15 业务错误码常量(文档里作为「缺失后果」引用)
```

### 6.2 反向:代码里读的每个 env,文档是否覆盖

```
$ git grep -hon "env\.SHARE_[A-Za-z0-9_]*" -- mail-worker/src   → 去重 15 个
15/15 全部 [DOCUMENTED],无 MISSING-IN-DOC
```

双向闭合:**文档没有幻觉变量,代码没有未文档化的分享配置项。**

### 6.3 一个方法论坑(留给后来者)

上一轮我这条核验第一次跑出了「15 个全 MISS」的假结果,原因是命令写成 `git grep ... | Select-Object -First 1` 后再读 `$LASTEXITCODE` —— PowerShell 里管道之后 `$LASTEXITCODE` 已不是 `git grep` 的退出码。**在 PowerShell 里用退出码做判据时,原生命令的输出必须先落到变量再判 `$LASTEXITCODE`,不能带管道。** 本轮已改成先 `$out = git grep ...; $code = $LASTEXITCODE` 再判断。

## 7. §5 实测:README 步骤自己走过一遍(**verified**,非 unverified)

按交付契约要求的 e2e 姿势真跑过。步骤与输出:

```
# 备份真实密钥文件
Copy-Item mail-worker/.dev.vars mail-worker/.dev.vars.bak-exec

# README 第 1 步:生成两把密钥
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   → 43 字符 ×2

# README 第 3 步:从模板重建 .dev.vars 并替换占位值
Copy-Item mail-worker/.dev.vars.example mail-worker/.dev.vars
（替换 replace-me-* 占位值）
→ 产出的活动键恰好 = 原 .dev.vars 的 4 个键:
  SHARE_SEC_PEPPER / SHARE_SESSION_SIGNING_KEY / SHARE_SEC_PEPPER_KID / SHARE_SESSION_SIGNING_KID

# 启动 worker,确认 wrangler 真的加载了这个文件
$ npx wrangler dev --config wrangler-dev.toml --port 8803
Using secrets defined in .dev.vars
env.SHARE_SEC_PEPPER ("(hidden)")            Environment Variable   local
env.SHARE_SESSION_SIGNING_KEY ("(hidden)")   Environment Variable   local
env.SHARE_SEC_PEPPER_KID ("(hidden)")        Environment Variable   local
env.SHARE_SESSION_SIGNING_KID ("(hidden)")   Environment Variable   local
[wrangler:info] Ready on http://127.0.0.1:8803
```

**A · 创建第一条分享(契约的核心成功状态)**

```
POST /api/mailShare/create      HTTP_STATUS=200
{"code":200,"message":"success","data":{"shareId":6,"lid":"nr_Vadj37qfAwJ475XCwGA",
 "expiresAt":"2026-08-24 23:44:15","shareType":"single","bindings":[{"bindingId":6,"accountId":1}]}}
```

**B · 访客用该链接换会话(证明第二把密钥也真的生效)**

```
POST /api/share/session         HTTP_STATUS=200   code=200 message=success
```

鉴权方式:读本地 KV 既有的 `auth-uid:1` 会话取 token,用 `wrangler-dev.toml` 里公开的 dev `jwt_secret` 自签 JWT(未修改任何应用状态)。

收尾:已 `Copy-Item .dev.vars.bak-exec .dev.vars` 还原原始密钥文件、删除备份与临时脚本、清理本地 D1 里 4 条探针分享(`DELETE ... WHERE share_id IN (3,4,5,6)`,剩余 1 条为原有数据)、终止所有本仓库 workerd 进程(复核剩余 0 个)。

## 8. 反向对照实验:两把密钥各自缺失的真实后果(**修正了任务简报的事实 #3**)

用单变量受控对照跑了两轮(每轮只注释掉一个变量、重启 worker、复核 binding 列表确认该变量确实缺失):

| 缺失变量 | 端点 | HTTP 状态 | 响应体 | Worker 日志 |
|---|---|---|---|---|
| `SHARE_SEC_PEPPER` | `POST /api/mailShare/create` | **200** | `{"code":500,"message":"share create pepper missing"}` | `share create sec pepper missing` |
| `SHARE_SESSION_SIGNING_KEY` | `POST /api/share/session` | **200** | `{"code":501,"message":"SHARE_UNAVAILABLE"}` | `share-auth session signing key missing` |

**与简报事实 #3 的两处不符(以实测为准,Tier 1 自纠):**

1. 简报说 pepper 缺失 → 「HTTP 500」。实测 **HTTP 状态码是 200**。根因:`mail-worker/src/hono/hono.js:9-29` 的全局 `onError` 统一走 `c.json(result.fail(err.message, err.code))`,hono 的 `c.json` 默认状态码 200,错误只体现在响应体的 `code` 字段(`result.fail` 默认 code=500,见 `mail-worker/src/model/result.js:5`)。
2. 简报说错误文本「只进 Worker 日志,不出现在接口响应体里」。实测 **裸 `Error` 的 message 会被 `onError` 直接回写进响应体**(`"share create pepper missing"` 就在 body 里)。

据此把三处文档从「HTTP 500 / 文本不出现在响应体」改成实测口径,并在 README 增了一句提示:「排查时别只看 HTTP 状态码,真正的错误在响应体 code 字段里」。这条恰好正面命中契约的成功状态 ——「不会在创建第一步撞上不明所以的 500」:实际情况比简报描述的更好排查(body 里有明确文本),但前提是文档得告诉部署者去看 body 而不是状态码。

顺带确认的一个次要事实:signing key 缺失时**分享仍能正常创建**,失败点在访客换会话那一步。所以文档里这两条的后果分开描述,而不是笼统写「分享功能不可用」。

## 9. Review Findings

**Tier 1 自纠(代码可裁决,已自行修正并继续):**

1. **简报事实 #3 的 HTTP 状态码与响应体口径错误** —— 见 §8,已按实测改写 3 个文件的对应文案。
2. **简报只列了 5 项变量,代码实际读 15 项** —— `SHARE_ENABLED` / `SHARE_PUBLIC_ORIGIN` / `SHARE_SESSION_TTL` / `SHARE_ACTIVE_LIMIT` / `SHARE_RETENTION_SECONDS` 及 4 个轮换用 `*_PREV`,还有简报未提的 `SHARE_SESSION_SIGNING_KID`(与 `SHARE_SEC_PEPPER_KID` 对称,但命名不对称:pepper 的旧版号叫 `SHARE_SEC_PEPPER_PREV_KID`,signing 的叫 `SHARE_SESSION_SIGNING_KID_PREV`,顺序相反 —— 这正是「文档写错变量名不报错」最容易踩的地方)。`wrangler.toml` 保持简报要求的 5 项聚焦,其余在 `.dev.vars.example` 里完整列出。
3. **主 AI 接续说明把三个子 `.gitignore` 记成本轮新建** —— 见 §4.3,实为 8 月 16 日既有文件,本轮只改根 `.gitignore` 一个。已给出时间戳证据,以免提交时把无关文件算进本包。
4. **根 `.gitignore` 的 `.ace-tool/` 那行不是本轮产物** —— 8 行增量里只有 6 行属于本包,提交时需注意(§4.3)。

**跨域只读、未修改:** `mail-share-service.js` / `share-auth-service.js` / `hono.js` / `result.js` / `jwt-utils.js` / `security.js` / `login-service.js` / `share-api.js` / `mail-share-api.js` —— 全部仅为核实事实而读。

**隐藏风险 / 留给主 AI 的事项:**

1. **`SHARE_MAX_DURATION_SECONDS` 生产未配 = 分享有效期无上限**(`mail-share-service.js:273-278` 无配置时返回 null,`:341-345` 只在非 null 时校验)。本轮只是把这件事写进文档,**没有改变现状**。是否要给生产设一个上限,是产品决策,不在本包范围。
2. **并行执行者的改动与本包的交叠已复核**:执行期间 `mail-share-service.js` / `share-auth-service.js` 被另一执行者修改(行号从 1121 位移到 1124 等)。已 `git diff` 过滤确认其改动**不涉及** pepper 守卫、signing key 守卫、`isCapabilityV2Enabled` 的取值匹配,两处守卫字符串仍在原位,`flag === '1' || flag === 1 || flag === true || flag === 'true'`(`:70-73`)未变 —— **§8 的实测结论与本轮文档口径仍然成立**。但若后续再改这三处,文档需同步。
3. **TDD 红绿已跳过,原因:本包为配置与文档,无业务逻辑**(符合任务约定)。替代验证是 §7 的真实 e2e + §8 的单变量受控对照,均留了退出码与响应体原文。

## Update Log

- 2026-08-25 · executor · T-00 根 `.gitignore` 补 `.dev.vars` 家族(+否例外保住模板)· T-11 `wrangler.toml` 注释 + 中英 README 部署节 + 新建 `.dev.vars.example` · T-11.1 双向一致性核验 15/15 双向闭合。证据:`git check-ignore` EXIT=0、全历史树扫描确认 `.dev.vars` 从未入库、e2e 实跑创建分享 shareId=6 + 访客换会话 code=200。修正简报事实 #3(缺 pepper 是 HTTP 200 + body 带 message,不是 HTTP 500 + 文本不外露)。未提交,交主 AI 统一提交。
