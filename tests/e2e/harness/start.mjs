import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_HOST, E2E_PORT } from './constants.js'

const harnessDir = path.dirname(fileURLToPath(import.meta.url))
const e2eDir = path.resolve(harnessDir, '..')
const repoDir = path.resolve(e2eDir, '../..')
const workerDir = path.join(repoDir, 'mail-worker')
const configPath = path.join(e2eDir, 'wrangler-e2e.toml')
const persistPath = path.join(e2eDir, '.mf-state')

const child = spawn(
	'pnpm',
	[
		'exec',
		'wrangler',
		'dev',
		'--config',
		configPath,
		'--ip',
		E2E_HOST,
		'--port',
		String(E2E_PORT),
		'--persist-to',
		persistPath
	],
	{
		cwd: workerDir,
		stdio: 'inherit',
		shell: true,
		windowsHide: true
	}
)

function stop() {
	if (!child.killed) {
		child.kill()
	}
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('exit', stop)

child.on('exit', (code) => {
	process.exit(code == null ? 1 : code)
})
