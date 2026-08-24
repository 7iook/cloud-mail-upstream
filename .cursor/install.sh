#!/usr/bin/env bash
# Cloud Agent install: idempotent bootstrap for Cloud Mail.
# Runs after the repository is checked out. Must terminate successfully.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "==> Installing mail-worker (Cloudflare Worker) dependencies"
pnpm --dir mail-worker install --frozen-lockfile

echo "==> Installing mail-vue (Vue 3 SPA) dependencies"
pnpm --dir mail-vue install --frozen-lockfile

echo "==> Building the SPA into mail-worker/dist (release mode)"
# The worker serves this build via its [assets] binding; vitest-pool-workers
# also needs mail-worker/dist to exist.
pnpm --dir mail-vue run build

echo "==> Installing Playwright e2e harness dependencies"
pnpm --dir tests/e2e install --frozen-lockfile

echo "==> Installing Playwright Chromium (with OS deps when possible)"
# --with-deps needs sudo/root to apt-get system libraries. Fall back to a
# browser-only install so the environment still bootstraps if that is missing;
# the browser download itself does not require elevated privileges.
if ! pnpm --dir tests/e2e exec playwright install --with-deps chromium; then
	echo "   playwright --with-deps failed (no sudo?); installing browser only"
	pnpm --dir tests/e2e exec playwright install chromium
fi

echo "==> Disabling Wrangler telemetry (non-interactive dev servers)"
pnpm --dir mail-worker exec wrangler telemetry disable || true

echo "==> Install complete"
