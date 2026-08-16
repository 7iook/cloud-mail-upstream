import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const e2eDir = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(e2eDir, '../..')
const vueDir = path.join(repoDir, 'mail-vue')
const distHtml = path.join(repoDir, 'mail-worker', 'dist', 'index.html')
const extraArgs = process.argv.slice(2)

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			shell: true,
			windowsHide: true
		})
		child.on('exit', (code) => {
			if (code === 0) {
				resolve()
				return
			}
			reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
		})
	})
}

if (!existsSync(path.join(e2eDir, 'node_modules', '@playwright', 'test'))) {
	await run('pnpm', ['install'], e2eDir)
}

await run('pnpm', ['exec', 'playwright', 'install', 'chromium'], e2eDir)

if (!existsSync(distHtml) || process.env.SHARE_E2E_REBUILD === '1') {
	await run('pnpm', ['run', 'build'], vueDir)
}

await run('pnpm', ['exec', 'playwright', 'test', ...extraArgs], e2eDir)
