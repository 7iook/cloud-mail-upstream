import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertShareEntryBootstrap } from '../src/init/assert-share-entry.js'
import { assertShareChunkIsolation } from '../src/views/share/assert-share-chunk.js'

const initSrc = await readFile(
    path.resolve(fileURLToPath(new URL('../src/init/init.js', import.meta.url))),
    'utf8'
)
const entry = assertShareEntryBootstrap(initSrc)
if (!entry.ok) {
    console.error(entry)
    process.exit(1)
}

const result = await assertShareChunkIsolation()
if (!result.markerHits.length || result.violations.length) {
    console.error(result)
    process.exit(1)
}
console.log(JSON.stringify(result))
