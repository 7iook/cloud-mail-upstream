# T6 · 访客收码页视觉

## Finding 1

- severity: P2
- anchor: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:402`
- symbols: `P5 task Evidence`, `.share-card`, `.share-otp-row`
- rule_source: `.agent-workspace/.archive/2026-08-26/share-link-fullchain/share-fullchain-decision-card.md:206,267` 明确要求桌面 1280 与移动 390 的真实截图或 GUI 验收，且禁止只靠钩子测试宣称 P5 完成。
- identity_scope: P5 访客视觉的浏览器验收证据契约
- failure_mode: 完成记录只写“截图 desktop 1280 / mobile 390”，没有给出可读取的产物路径，仓库与 `/opt/cursor/artifacts/` 也均无图片或录像。
- trigger: 复核 P5 完成声明并尝试从当前被审工作树或规定的 artifact 目录读取两档视口证据时触发。
- impact: 现有 jsdom/依赖图测试不能证明媒体查询后的 390px 全宽复制按钮、44px 触控区及 1280px 卡片布局真实成立，因此视觉主题缺少决策卡规定的完成证据。
- required_fix: 以真实浏览器分别在 1280 与 390 视口渲染有效分享页，将截图保存到稳定且可追溯的 artifact 路径，并在 Evidence 中逐项关联 OTP 字号、复制按钮宽度、触控高度和 token 色核对结果。
- verify: `cd /tmp/review-share-fullchain && test "$(rg --files . /opt/cursor/artifacts -g '*.png' -g '*.jpg' -g '*.jpeg' -g '*.webp' -g '*.mp4' | wc -l)" -gt 0`；当前期望退出码 `1`，补齐可追溯证据后期望退出码 `0`。
- risk_spread: none

## 已查证

- `e309ad4` 的两个模板中 `data-share-*` 属性序列与父提交一致；允许预算内检查的 visitor e2e 与 `index.spec.js` 选择器均未依赖 `[data-share-shell]` 的直接子层级。
- 新增视觉代码未加入 `@font-face`、CDN URL、Element Plus/图标库 import；动画仅出现在 `prefers-reduced-motion: no-preference` 内。
- 设计卡的 token、桌面 `max-width: 640px`、OTP `clamp(30px, 8vw, 40px)`、移动复制按钮全宽/`min-height: 44px`、Tab 横向滚动均能在 diff 中逐项命中。
- `.share-otp-select.is-visible` 保留静态定位、全宽、`clip: auto` 与可见 overflow；相关手动降级规格通过。
- `pnpm -C mail-vue exec vitest run src/views/share/index.spec.js src/views/share/ShareOtpCard.spec.js src/views/share/share-chunk.spec.js`：3 files / 79 tests passed，退出码 0。
