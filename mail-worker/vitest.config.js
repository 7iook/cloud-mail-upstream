import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// isolatedStorage (default true) otherwise starts one workerd per test file.
// On Windows that storms the Miniflare module-fallback loopback (ConnectEx
// #1225/#52) and surfaces as updateStackedStorage "internal error".
// singleWorker keeps per-test stacked storage on one runtime per vitest process.
const cacheDir = join(tmpdir(), `mail-worker-vitest-${process.pid}`);

// singleWorker means every spec file shares one workerd isolate, so file-level
// parallelism buys nothing here (measured: 81.8s serial vs 85.4s parallel) while
// exposing globals to cross-file races. Fixtures that patch shared runtime state
// -- withLocalTimezoneShift swaps Date.prototype's local getters -- leak into
// whatever else happens to be mid-assertion. Serial keeps that state private.
export default defineWorkersConfig({
	cacheDir,
	test: {
		fileParallelism: false,
		setupFiles: ['./test/setup.js'],
		poolOptions: {
			workers: {
				singleWorker: true,
				wrangler: { configPath: './wrangler-vitest.toml' },
			},
		},
	},
});
