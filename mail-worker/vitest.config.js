import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// isolatedStorage (default true) otherwise starts one workerd per test file.
// On Windows that storms the Miniflare module-fallback loopback (ConnectEx
// #1225/#52) and surfaces as updateStackedStorage "internal error".
// singleWorker keeps per-test stacked storage on one runtime per vitest process.
const cacheDir = join(tmpdir(), `mail-worker-vitest-${process.pid}`);

export default defineWorkersConfig({
	cacheDir,
	test: {
		setupFiles: ['./test/setup.js'],
		poolOptions: {
			workers: {
				singleWorker: true,
				wrangler: { configPath: './wrangler-vitest.toml' },
			},
		},
	},
});
