import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadMedia } from '../src/html/media.ts'
import type { MediaChunk } from '../src/adapters/bug-media.ts'
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII='
const chunk: MediaChunk = {
  mime: 'image/png',
  total: Buffer.from(png, 'base64').length,
  offset: 0,
  data: png,
  next: null
}
test('HTML media: valid bytes become a revocable blob, no resource URL from the worker is followed', async () => {
  const media = await loadMedia(async () => chunk, 'image', new AbortController().signal)
  assert.ok(media.url.startsWith('blob:'))
  assert.deepEqual(
    new Uint8Array(await (await fetch(media.url)).arrayBuffer()),
    new Uint8Array(Buffer.from(png, 'base64'))
  )
  media.dispose()
  media.dispose()
  await assert.rejects(() => fetch(media.url), /fetch failed/)
})
test('HTML media: malformed chunks, forbidden MIME and excessive decoded dimensions fail closed', async () => {
  const large = Buffer.from(png, 'base64')
  large.writeUInt32BE(8192, 16)
  for (const invalid of [
    { ...chunk, mime: 'image/svg+xml' },
    { ...chunk, total: 33554433 },
    { ...chunk, next: 1 },
    { ...chunk, offset: 4 },
    { ...chunk, total: 1 },
    { ...chunk, data: 'http://external.invalid/' },
    { ...chunk, data: large.toString('base64') }
  ]) {
    await assert.rejects(
      () => loadMedia(async () => invalid, 'image', new AbortController().signal),
      /媒体不可用/
    )
  }
})
test('HTML media: cancelled late reads do not publish and valid subsequent reads still work', async () => {
  const controller = new AbortController()
  await assert.rejects(
    () =>
      loadMedia(
        async () => {
          controller.abort()
          return chunk
        },
        'image',
        controller.signal
      ),
    /aborted/
  )
  const media = await loadMedia(async () => chunk, 'image', new AbortController().signal)
  assert.equal((await fetch(media.url)).status, 200)
  media.dispose()
})
