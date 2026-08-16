import { defineConfig, devices } from '@playwright/test'
import { E2E_ORIGIN } from './harness/constants.js'

export default defineConfig({
	testDir: './specs',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	reporter: [['list']],
	use: {
		baseURL: E2E_ORIGIN,
		trace: 'on-first-retry',
		serviceWorkers: 'block'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	],
	webServer: {
		command: 'node harness/start.mjs',
		url: `${E2E_ORIGIN}/__e2e__/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	}
})
