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
// `.dev.vars` outranks a wrangler config's [vars], and the pool loads it the same way
// `wrangler dev` does. That makes the suite depend on a developer's local secrets file
// happening not to define a given key: set SHARE_CAPABILITY_V2=true in .dev.vars to click
// through the feature locally and ten fence assertions turn red, with nothing in the failure
// output pointing at the file. Bindings sit above both layers, so pin here the variables whose
// *value* an assertion depends on. Everything else (pepper, signing key, KEK material) stays in
// wrangler-vitest.toml -- tests only need those to exist, not to hold a particular value.
const assertedEnv = {
	// The release fence. Its whole test surface is "what happens while it is off".
	SHARE_CAPABILITY_V2: 'false',
	// Empty means unconfigured here: maxDurationSeconds() treats non-numeric, zero and negative
	// the same as absent ("not a back door for lifting the ceiling", per its comment), and the
	// duration tests cover exactly that fallback -- which is what production looks like today.
	// A binding cannot delete an inherited key, so pinning an equivalent value is the way to stop
	// a local .dev.vars from silently configuring one.
	SHARE_MAX_DURATION_SECONDS: '',
};

export default defineWorkersConfig({
	cacheDir,
	test: {
		fileParallelism: false,
		setupFiles: ['./test/setup.js'],
		poolOptions: {
			workers: {
				singleWorker: true,
				wrangler: { configPath: './wrangler-vitest.toml' },
				miniflare: { bindings: assertedEnv },
			},
		},
	},
});
