# Mail Share browser harness

One command from the repository root:

```
node tests/e2e/run.mjs
```

That installs this package (not `mail-vue`), installs Chromium, builds the SPA into `mail-worker/dist` when needed, starts a local worker, and runs Playwright.

Force a fresh frontend build with `SHARE_E2E_REBUILD=1`.

Playwright lives only in `tests/e2e/`. It does not change `mail-vue` or `mail-worker` lockfiles.

Inbound SMTP is not available locally. New mail is injected by calling the worker `email()` handler with a constructed MIME message (parse, SAVING write, attachment store, `completeReceive`). Workers AI is stubbed so `extractCode` still runs and returns a known code. Rows are not inserted into D1 as a substitute for receive.
