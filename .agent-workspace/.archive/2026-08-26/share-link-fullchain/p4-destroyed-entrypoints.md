# P4 销毁链接调用点清单

约定：`gone` = 无 `mail_share` 行 **或** `status = 'REVOKED'`。EXPIRED 不是 gone。

| # | 入口 | 文件 | 改造 | 销毁后期望 |
|---|---|---|---|---|
| 1 | 文档 GET `/s/:lid` | `mail-worker/src/index.js` + `security/share-document-gone.js` | assets 之前拦截 | HTTP 404 空 body |
| 2 | 文档 HEAD `/s/:lid` | 同上 | 同 GET | HTTP 404 |
| 3 | POST `/api/share/session` | `share-api.js` + `share-auth-service.establishSession` | `throwDestroyed` → 真 404 | HTTP 404 |
| 4 | GET `/api/share/mails` | `share-api.js` `resolveSession` | 同上 | HTTP 404 |
| 5 | GET `/api/share/mailboxes/status` | 同上 | 同上 | HTTP 404 |
| 6 | GET `/api/share/mail` | 同上 | 同上 | HTTP 404 |
| 7 | GET `/api/share/attachment` | 同上 | 同上 | HTTP 404 |
| 8 | SPA 已打开后轮询 | `mail-vue/src/request/share.js` + `views/share/index.vue` | HTTP 404 → `ShareGoneError`；`sessionStorage['share:gone:'+lid]` 只 reload 一次；reload 后仍是 SPA 则清空 `documentElement` | 生产 reload 打到 #1；vite 直出则空白 |
| 9 | 前端路由 `name:'share'` | `mail-vue/src/router/index.js` | 不改路由表；完整导航走 #1 | — |
| 10 | 内部 `env.assets.fetch` | `index.js` 旧路径 | gone 不再落到 SPA | — |

不在范围：Owner `/mailShare/*`（管理自己的行，仍返回业务 JSON）。

DB 抖动：文档拦截 fail-open 到 assets，避免把活链接打成 404。

## Update Log

- 2026-08-26 · 全入口清单；实现按此表勾销。
