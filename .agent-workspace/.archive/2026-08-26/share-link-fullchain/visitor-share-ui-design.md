# 访客分享页 UI 设计卡

来源：ui-designer SUB（Fable 5）· 实现必须按本卡，禁止改 `data-share-*` 钩子。

## 页面角色

一次性、无登录的收码页。访客目标：尽快看到验证码并复制。

## 信息优先级

- P0：OTP 大字 + 复制 + 空收件箱等待
- P1：邮件列表、过期倒计时、离开
- P2：多邮箱 Tab、验证链接、附件

## Token（挂在 `.share-shell`）

- `--sh-bg: #f4f5f7`
- `--sh-surface: #ffffff`
- `--sh-accent: #3b5bdb`
- `--sh-accent-soft: #edf2ff`
- `--sh-text: #1b1f3b`
- `--sh-muted: #5c5f77`
- `--sh-warn: #f08c00`
- `--sh-danger: #c92a2a`
- `--sh-radius: 16px`
- OTP：`clamp(30px, 8vw, 40px)`，等宽数字

## 布局

- 桌面：居中白卡片，`max-width: 640px`，页面背景 `--sh-bg`
- 移动：去浮层阴影，复制按钮全宽，Tab 横向滚动，触控目标 ≥ 44px

## 状态

- loading：卡片内 spinner，保留文案
- authRequired：窄卡，输入 + 提交
- ready + 有码：OTP 放 `--sh-accent-soft` 区
- ready + 空收件箱：一等等待卡（不是冰冷 empty）
- unavailable / timedout / exited：居中终态卡（销毁走原生 404，本页不设计 gone 插画）
- limited：警告横幅

## 硬约束

- 禁止改所有 `data-share-*`
- 禁止 Element Plus / 主 layout / db.js / 登录 axios
- 倒计时无 `aria-live`
- `prefers-reduced-motion` 包动画
- 只改 template 包裹 class + scoped CSS + ShareOtpCard 视觉；轮询/会话逻辑零改（gone 守卫除外，属 P4）

## Update Log

- 2026-08-26 · UI SUB 设计卡落盘，P5 按此实现。
