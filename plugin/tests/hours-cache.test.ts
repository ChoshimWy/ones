import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HoursCache, parseHoursMonth } from '../src/hours-cache.ts'
const value = { month: '2026-02', savedAt: 1, days: [{ date: '2026-02-01', state: 'missing' as const, existing: 0, budget: 480, remaining: 480, reason: 'fixture' }] }
test('hours cache: SQLite survives reopen, isolates scope/month and prevents stale publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ones-hours-cache-'))
  const cache = new HoursCache(join(root, 'db'))
  try {
    await cache.publish('owner-team', value, () => {})
    cache.close()
    assert.deepEqual(await cache.read('owner-team', value.month), value)
    assert.equal(await cache.read('other-team', value.month), null)
    assert.equal(await cache.read('owner-team', '2026-01'), null)
    const next = { ...value, savedAt: 3, days: [{ ...value.days[0]!, existing: 120, remaining: 360 }] }
    await cache.publish('owner-team', next, () => {})
    await cache.publish('owner-team', value, () => {})
    assert.equal((await cache.read('owner-team', value.month))?.savedAt, 3)
    await assert.rejects(cache.publish('owner-team', { ...next, savedAt: 4 }, () => { throw Error('cancelled') }))
    assert.equal((await cache.read('owner-team', value.month))?.savedAt, 3)
    assert.throws(() => parseHoursMonth({ ...value, days: [{ ...value.days[0], date: '2026-02-02' }] }, value.month))
    assert.throws(() => parseHoursMonth({ ...value, days: [value.days[0], value.days[0]] }, value.month))
  } finally { cache.close(); await rm(root, { recursive: true, force: true }) }
})
test('hours cache: symlink directory is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ones-hours-cache-'))
  const link = join(root, 'link')
  await symlink(root, link)
  const cache = new HoursCache(link)
  try { await assert.rejects(cache.read('owner', '2026-02')) }
  finally { cache.close(); await rm(root, { recursive: true, force: true }) }
})
