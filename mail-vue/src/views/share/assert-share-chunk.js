import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const MARKER = 'cloud-mail-share-shell'

const FORBIDDEN = [
    { id: 'dexie', re: /new Dexie\b|from["']dexie["']/ },
    { id: 'layout-perm', re: /account:query/ },
    { id: 'axios-index-reload', re: /location\.reload\s*\(/ },
    { id: 'websiteConfig', re: /websiteConfig/ }
]

function collectImports(source) {
    const found = []
    const re = /(?:import\s*\(\s*["']([^"']+)["']\s*\)|from\s+["']([^"']+)["']|import\s+["']([^"']+)["'])/g
    let match
    while ((match = re.exec(source))) {
        found.push(match[1] || match[2] || match[3])
    }
    return found
}

async function walkJs(dir) {
    const out = []
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            out.push(...await walkJs(full))
        } else if (/\.m?js$/.test(entry.name)) {
            out.push(full)
        }
    }
    return out
}

export async function assertShareChunkIsolation() {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'cloud-mail-share-chunk-'))
    try {
        await build({
            configFile: path.join(root, 'vite.config.js'),
            root,
            mode: 'dev',
            logLevel: 'error',
            build: {
                outDir,
                emptyOutDir: true,
                sourcemap: false
            }
        })

        const files = await walkJs(outDir)
        const contents = new Map()
        for (const file of files) {
            contents.set(file, await readFile(file, 'utf8'))
        }

        const markerHits = [...contents.entries()].filter(([, src]) => src.includes(MARKER))
        const graph = new Set(markerHits.map(([file]) => file))
        const queue = [...graph]
        while (queue.length) {
            const file = queue.pop()
            const src = contents.get(file) || ''
            for (const spec of collectImports(src)) {
                if (!spec.startsWith('.')) {
                    continue
                }
                const resolvedFile = path.normalize(path.join(path.dirname(file), spec))
                const match = files.find((candidate) => (
                    candidate === resolvedFile ||
                    candidate === `${resolvedFile}.js` ||
                    candidate === `${resolvedFile}.mjs`
                ))
                if (match && !graph.has(match)) {
                    graph.add(match)
                    queue.push(match)
                }
            }
        }

        const violations = []
        for (const file of graph) {
            const src = contents.get(file) || ''
            for (const rule of FORBIDDEN) {
                if (rule.re.test(src)) {
                    violations.push({ file: path.relative(outDir, file), rule: rule.id })
                }
            }
        }

        return {
            markerHits: markerHits.map(([file]) => path.relative(outDir, file)),
            violations,
            graphSize: graph.size
        }
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
}
