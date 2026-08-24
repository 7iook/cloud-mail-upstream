# Mail Share browser harness

One command from the repository root:

```
node tests/e2e/run.mjs
```

That installs this package (not `mail-vue`), installs Chromium, builds the SPA into `mail-worker/dist` when needed, starts a local worker, and runs Playwright.

Force a fresh frontend build with `SHARE_E2E_REBUILD=1`.

Playwright lives only in `tests/e2e/`. It does not change `mail-vue` or `mail-worker` lockfiles.

`POST /__e2e__/capability-v2 {"on":true|false}` overrides `SHARE_CAPABILITY_V2` for the running worker; `/__e2e__/seed` resets it, so every test starts at the production default (off). The override is a module-level variable inside the worker process, so `workers` must stay `1` — turning on parallelism makes it the first thing to break.

Inbound SMTP is not available locally. New mail is injected by calling the worker `email()` handler with a constructed MIME message (parse, SAVING write, attachment store, `completeReceive`). Workers AI is stubbed so `extractCode` still runs and returns a known code. Rows are not inserted into D1 as a substitute for receive.
