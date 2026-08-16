/** @vitest-environment node */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertShareChunkIsolation } from './assert-share-chunk.js'

const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const routerFile = path.join(root, 'src/router/index.js')

describe('share async chunk isolation', () => {
    it('declares a top-level share route whose built chunk stays off the logged-in graph', async () => {
        const routerSrc = await readFile(routerFile, 'utf8')
        expect(routerSrc).toMatch(/path:\s*['"]\/s\/:lid['"]/)
        expect(routerSrc).toMatch(/name:\s*['"]share['"]/)
        expect(routerSrc).toMatch(/import\(['"]@\/views\/share\/index\.vue['"]\)/)

        const result = await assertShareChunkIsolation()
        expect(result.markerHits.length).toBeGreaterThan(0)
        expect(result.violations).toEqual([])
    }, 180000)
})

