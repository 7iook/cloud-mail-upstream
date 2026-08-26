# T6 · Owner 侧首次具备浏览器级验收 · 独立审查

verdict: NEEDS_CHANGES  
commit: `37062220afc2be6dd4002a74c0dc8f20f03578f6`  
findings: P0=0 · P1=1 · P2=3 · suggestion=1

## Findings

### 1 · P1 · P5 的视觉成功态没有可复现的浏览器验收

severity: P1  
anchor: `tests/e2e/specs/owner-share-lifecycle.spec.js:3`  
symbols: `owner-share-lifecycle`, `ShareOtpCard`, `[data-share-code]`  
rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md` 的 P5「必做验收」明确要求桌面 1280 与移动 390 对照设计卡，并要求截图或 GUI 验收，不得只靠钩子测试收尾（当前树第 205–206、263–267 行）；同卡 VERIFY 要求五条成功状态各有真实入口→sink 验收。  
identity_scope: `share-fullchain VERIFY / P5 访客视觉浏览器验收`  
evidence: 本提交新增的 lifecycle spec 在第 3–4 行只声明并覆盖 P1/P2/P3；对 `tests/e2e/**` 检索 `setViewportSize|viewport|toHaveCSS|screenshot|toHaveScreenshot|390|1280` 为零命中，仓库与当前 `/opt/cursor/artifacts` 也没有图片/录像。现有 visitor spec 会在 Chromium 打开页面和复制 OTP，但没有观测字号、移动端全宽、token 色或 44px 触控目标。后续决策卡仅写「截图 desktop 1280 / mobile 390」，没有路径、文件名或哈希，无法复查。  
failure_mode: 23 条 E2E 全绿只能证明访客功能钩子仍可用，不能证明 P5 的新视觉在两个规定视口满足设计卡，却被用来关闭“五条 sink” VERIFY。  
trigger: OTP DOM 与 `data-share-*` 保持不变、但 CSS 布局或响应式规则回退时，全部现有浏览器测试仍通过。  
impact: P5 可在视觉上未完成或发生回归而整轮仍被标记为五项浏览器验收完成，VERIFY 证据失真。  
required_fix: 在浏览器验收层补桌面 1280 / 移动 390 的 P5 场景，持久化并在 Evidence 中引用截图，或增加可复现的 Playwright screenshot/关键 computed-style 断言；完成后再关闭 VERIFY。  
verify: `SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs visitor-visual.spec.js` → 期望 EXIT=0，且 Evidence 能定位两个视口的产物。  
risk_spread: `none`（review_focus #6 已显式授权枚举 `tests/e2e/specs/**`；已在全部 E2E spec 命中 stop_when）。

### 2 · P2 · P1 用例没有钉住“停页翻转、不重新加载”

severity: P2  
anchor: `tests/e2e/specs/owner-share-lifecycle.spec.js:64`  
symbols: `row`, `bootAsOwner`, `liveEffectiveStatus`, `page.reload`  
rule_source: `docs/specs/mail-share/requirements.md` AC-LIFE-08 明确要求页面停留跨过过期时刻即翻转、无需重新登录或重新拉取；决策卡 P1 最终 sink 同样要求短 TTL 停页翻转（当前树第 162–163 行）。  
identity_scope: `owner-share-lifecycle / P1 on-page expiry transition`  
evidence: 用例在先看到 `ACTIVE` 后只等待同一 locator 最终出现 `EXPIRED`，直到第 67 行才主动调用 `page.reload()`；等待期间没有统计 document request、`framenavigated` 或 reload。若生产代码在到期时执行 `location.reload()`，重载后的服务端快照同样会让第 64 行通过。  
failure_mode: 用例标题声称验证 “without reload”，实际后置条件只验证“30 秒内最终出现 EXPIRED”。  
trigger: 前端把共享时钟翻转回归成到期时整页 reload，或其它逻辑在等待窗口内重新导航到同一 URL。  
impact: AC-LIFE-08 的核心用户结果“停页实时翻转”退化为刷新后更新时，唯一 Owner 浏览器证据仍会绿。  
required_fix: 在首次 `ACTIVE` 后记录 document 导航请求数，并在 `EXPIRED` 断言完成前证明没有新增 document 请求；第 67 行的显式手动刷新再单独验证刷新路径。  
verify: `SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs owner-share-lifecycle.spec.js --grep "short-TTL"` → 期望 EXIT=0，且用例包含翻转前后 document 请求数不变的断言。  
risk_spread: `none`。

### 3 · P2 · “两地址两条链接”允许两份完全相同的 URL 通过

severity: P2  
anchor: `tests/e2e/specs/owner-share-lifecycle.spec.js:31`  
symbols: `urls`, `[data-test="share-url"]`, `createFromEmails`  
rule_source: `docs/specs/mailbox-share-capability/design.md` 的 `POST /mailShare/create` 契约要求 V2=false 时 N 个地址产生 N 条单分享；决策卡 P2 契约进一步写明“各 lid/sec”（当前树第 93–95 行）。  
identity_scope: `owner-share-lifecycle / P2 V2=false batch split result cardinality`  
evidence: 当前断言只检查 locator 数量为 2，并逐个匹配 `/s/<lid>#` 的形状，没有检查值互异。静态反证探针把两个元素都设为 `http://e2e.local/s/same#same`，得到 `{"currentAssertionsPass":true,"distinct":1}`；后面的两行列表断言只证明后端建了两行，不能证明结果面板没有把第一条 URL 渲染两次。  
failure_mode: 结果面板重复第一条 share URL 两次时，P2 浏览器验收仍通过。  
trigger: 批量响应映射、`v-for` 数据整形或字段绑定回归为复用同一个 `shareUrl`。  
impact: Owner 为两个地址只拿到一个实际 capability，另一条分享无法从创建结果复制，而 E2E 给出假绿。  
required_fix: 在采集 URL 后断言 `new Set(urls).size === 2`，并从 URL 提取并核对两个不同的 lid；断言应留在结果面板这一上游 sink。  
verify: `SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs owner-share-lifecycle.spec.js --grep "two pasted full addresses"` → 期望 EXIT=0，且重复 URL 的反例会失败。  
risk_spread: `none`。

### 4 · P2 · 20 秒 TTL 在浏览器启动前已经开始计时

severity: P2  
anchor: `tests/e2e/specs/owner-share-lifecycle.spec.js:51`  
symbols: `world.api.createShare`, `bootAsOwner`, `gotoShareAdmin`, `durationSeconds`  
rule_source: `owner-share-lifecycle` 的 P1 测试后置条件要求先观察 `ACTIVE`，再观察停页翻为 `EXPIRED`；`tests/e2e/playwright.config.js:10-11` 允许单测运行 60 秒、普通 expect 15 秒，说明仓库没有把 20 秒启动上界设为前置条件。  
identity_scope: `owner-share-lifecycle / P1 short-TTL test determinism`  
evidence: 分享在第 49–53 行以 20 秒 TTL 创建，随后才执行登录页启动、`/my/loginUserInfo`、收件箱渲染、菜单点击和管理列表请求；第 61 行才要求仍为 `ACTIVE`。`workers: 1` 排除了并行竞争，但没有给首次浏览器启动建立小于 20 秒的保证。  
failure_mode: 测试把环境启动/页面加载耗时算进业务观察窗口，慢机上会在第一条 ACTIVE 断言前自然过期。  
trigger: `createShare` 完成后到管理行首次渲染耗时达到 20 秒，例如冷启动、资源加载或 Owner 初始化请求变慢。  
impact: 产品行为正确时浏览器验收仍会间歇失败；该 spec 又是 P1/P2/P3 的唯一 Owner sink 证据，会同时削弱整轮 VERIFY 的可信度。  
required_fix: 把到期时刻的布置移到 Owner 页面与目标行 ready 之后：由 harness 提供“设为当前时间后短暂到期”的控制能力，刷新一次取得该时间，再从已观测的 ACTIVE 开始计时；不要单纯继续放大固定 TTL。  
verify: `SHARE_E2E_REBUILD=1 node tests/e2e/run.mjs owner-share-lifecycle.spec.js --grep "short-TTL"` → 期望 EXIT=0，并证明 expiry 安排发生在页面 ready 之后。  
risk_spread: `none`。

### 5 · suggestion · 新 E2E 没有自动闸门

severity: suggestion  
anchor: `.github/workflows/deploy-cloudflare.yml:12`  
symbols: `Deploy-cloud-mail`, `tests/e2e/run.mjs`  
rule_source: 无仓库条款要求 PR/部署前自动执行测试；`scope.md` 反而明确记录该 workflow 只部署、不覆盖单测或 E2E，因此按契约降为 suggestion。  
identity_scope: `repository CI / E2E merge gate ownership`  
evidence: workflow 的触发路径只有 `mail-worker/**`、`mail-vue/**`，纯 `tests/e2e/**` 提交不会触发；job 仅安装 `mail-worker` 并部署，整份文件没有 worker test、Vue test 或 `tests/e2e/run.mjs`。  
failure_mode: Owner E2E 只形成可人工执行的测试资产，不会自动阻止回归进入 main 或部署。  
trigger: 合入者没有按决策卡 Evidence 的人工纪律复跑三套测试。  
impact: 后续 P1/P2/P3 回归可在没有任何红灯的情况下部署。  
required_fix: 若维护者希望这些验收承担持续回归闸门，应新增 PR/push 测试 workflow，至少运行定点 Owner E2E；部署 job 是否依赖它需由仓库策略明确裁决。  
verify: `git grep -n "tests/e2e/run.mjs" -- .github/workflows` → 增加自动闸门后期望 EXIT=0。  
risk_spread: `none`（review_focus #5 明确点名该 workflow）。

## review_focus 逐项查证

1. seed 顺序：未形成 finding。`seedOwner` 返回实际 `accountId/accountId2/ownerAccountId`；`tests/e2e` 的消费者均使用这些返回值，没有数字常量、首行账号或 account_id 排序假设。旧持久库与新库的自增顺序不同也不改变消费者语义。
2. 跨 run：未发现 `SHARE_ACTIVE_LIMIT` 撞线。`wrangler-e2e.toml` 未配置该变量，`activeLimit()` 回退 `UNBOUNDED_ACTIVE_LIMIT = 1_000_000_000`；harness 确实没有 reset，数据会累积，但本轮没有仓库契约给出本地状态体积阈值，未据此另开 finding。
3. 时间敏感：见 finding 4。Playwright 明确 `workers: 1`，所以并行不是当前触发源；冷启动计入 20 秒 TTL 才是可复现缺口。
4. P3 反向断言：未形成 finding。旧实现同步调用 `ElMessageBox.confirm`，500ms 浏览器窗口足以抓到该回归；更强的组件测试 W15 直接 spy `confirm` 并断言未调用。
5. 闸门归属：见 suggestion 5。没有条款要求自动 gate，不能提升为 P0/P1/P2。
6. 覆盖 vs 承诺：P4 的 missing/revoked 真实 `page.goto`、已打开页撤销后 document 404 均有浏览器 sink；P1/P2/P3 有本提交 Owner sink，但存在 findings 2–4；P5 只有功能钩子跑进浏览器，没有可复现的视觉验收，见 finding 1。

## 静态验证

- `git diff --check 3706222^ 3706222` → EXIT=0。
- 目标提交仅改 `tests/e2e/harness/worker-entry.js` 与 `tests/e2e/specs/owner-share-lifecycle.spec.js`。
- 未运行 E2E：`run.mjs` 会写 `tests/e2e/.mf-state`，与本次 read-only / 不改文件约束冲突。
