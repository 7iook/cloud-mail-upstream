# T1 Review Findings

## T1-F1 · storage 清理抛错会截断 gone 终态切换

- severity: P1
- anchor: `mail-vue/src/views/share/index.vue:792`
- symbols: `handleShareGone`, `clearMailboxView`, `clearShareSession`, `clearEstablishKey`, `markShareGone`
- rule_source: `docs/specs/mailbox-share-capability/requirements.md:178` AC-SEC-07 要求 gone 后先清除 `share:session:<lid>` 与 `share:est-key:<lid>` 再 reload/清空；同文件 `:210` AC-EDGE-03 要求随后 reload 一次并落到原生 404，且 `docs/specs/mail-share/requirements.md:86` AC-VISIT-04 禁止销毁态保留业务 HTML。
- identity_scope: `ShareView.handleShareGone` 的“已打开 SPA 收到 gone 后清凭据并离开业务文档”终态契约。
- failure_mode: `handleShareGone` 在调用带 try/catch 的 `markShareGone` 之前先调用 `clearMailboxView()`，而后者内部的两个 `sessionStorage.removeItem` 均未捕获 `SecurityError`，因此异常会直接跳过 reload 与 blank 两个终态出口。
- trigger: 已打开的分享页收到任一访客 API 的 HTTP 404，同时浏览器策略、存储权限变化或存储实现使 `sessionStorage.removeItem` 抛出 `SecurityError`。
- impact: 轮询虽然已停止，但内存中的 `sessionToken`、邮箱与邮件 DOM 尚未清空，当前 200 SPA 业务页面继续留在屏幕上，既未兑现原生 HTTP 404，也未兑现 gone 的先清凭据契约；`markShareGone` 声称的 storage 不可用降级分支实际不可达。
- required_fix: 将分享会话与 establish key 的存储删除收敛为不抛异常的清理边界，并用 `finally` 保证内存态擦除与 gone 终态导航必定执行；终态决策应显式接收清理/记账结果，不能依赖下游 `markShareGone` 单点 catch 掩盖更早的存储异常。
- verify: `cd /tmp/review-share-fullchain && node --input-type=module -e "globalThis.sessionStorage={removeItem(){throw new DOMException('blocked','SecurityError')},getItem(){throw new DOMException('blocked','SecurityError')},setItem(){throw new DOMException('blocked','SecurityError')}}; const s=await import('./mail-vue/src/views/share/session.js?review-storage-failure'); let terminal; try { s.clearShareSession('lid'); terminal=s.markShareGone('lid') } catch (err) { if (err.name !== 'SecurityError') process.exit(2) } if (terminal !== undefined) process.exit(3)"`；期望退出码 `0`（实测 `0`，证明前置清理抛错且终态分支未执行）。
- risk_spread: `none`

## 已查证且无额外 finding

1. 拦截面与 SPA 可达面：`mail-vue/src/router/index.js:69` 仅声明 `/s/:lid`；`mail-worker/src/security/share-document-gone.js:10` 接受同一单段路径及可选尾斜杠，query 不进入 `URL.pathname`、fragment 不发送到服务端；`mail-worker/src/index.js:28-33` 在 assets 前拦截，`mail-worker/wrangler.toml:50-54` 的 SPA fallback 不形成差集。风险预算 `文档拦截面 vs SPA 可达路径` 在两侧集合对齐后停止。
2. `SHARE_DESTROYED` 逃逸：`mail-worker/src/api/share-api.js:61,75,93,99,109` 的五个访客 handler 全部包在 `withShare` 内；产码点仅为 `share-auth-service.js:51-53` 的 `throwDestroyed`，调用均经这些 handler；因此不会落到 `mail-worker/src/hono/hono.js:9-29` 的全局 JSON `onError`。风险预算 `gone-码在错误信封里的逃逸路径` 在全部调用点闭合后停止。
3. Owner 面：`assertAllowed` 的全部调用仅位于 `share-auth-service.js:663,719` 的访客 establish/resolve 路径；Owner 服务只调用不抛错的 `effectiveStatus` 做 DTO 投影（`mail-share-service.js:490`），Owner API 使用独立业务 JSON 包装。风险预算 `Owner 面被裸 404 波及` 在调用方枚举完成后停止。
4. gone/sec 时序：不存在或 REVOKED 与活动行错 sec 已按 AC-AUTH-02 明确分成 HTTP 404 与 200 `SHARE_UNAVAILABLE` 两族；前者跳过 HMAC 没有提供比响应状态本身更廉价的存在性预言机，gone 族内的无行与 REVOKED 又走相同分支。
5. fail-open：`shareRequestId({ env })` 在 `mail-worker/src/service/share-event.js:31-34` 返回 `null`，不会在 catch 内二次抛错；每次 D1 异常均写一条 `event=share.system.error, reason=gone-check-failed, requestId=null, shareId=null` 后回落 assets，符合决策卡 P4 的显式 fail-open 与不记录 lid 约束。
6. 定点验证：Vue gone 链路四个 spec 共 `105/105` 通过（exit `0`）。Worker 定点命令未能复跑：当前工作树未安装 `mail-worker` 的 vitest，可执行文件缺失，命令 exit `254`；本报告未把仓内既有绿色数字当作机械闸门证据。
