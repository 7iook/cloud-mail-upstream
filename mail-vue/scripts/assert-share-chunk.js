import { assertShareChunkIsolation } from '../src/views/share/assert-share-chunk.js'

const result = await assertShareChunkIsolation()
if (!result.markerHits.length || result.violations.length) {
    console.error(result)
    process.exit(1)
}
console.log(JSON.stringify(result))
