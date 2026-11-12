import { DatabaseSync } from 'node:sqlite'
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

test('hours cache: ordinary tasks survive restart with scope isolation; wrong types never replace them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ones-hours-tasks-'))
  const cache = new HoursCache(join(root, 'db'))
  const task = { id: 'task', number: 1, name: '虚构任务', project: { id: 'project', name: '项目' }, issueType: { id: 'ordinary', name: '任务' }, status: { id: 'status', name: '进行中' } }
  const value = { typeId: 'ordinary', savedAt: 1, items: [task] }
  try {
    await cache.publishTasks('team-owner', value, () => {})
    cache.close()
    assert.deepEqual(await cache.readTasks('team-owner'), value)
    assert.equal(await cache.readTasks('other-owner'), null)
    await assert.rejects(cache.publishTasks('team-owner', { ...value, savedAt: 2, items: [{ ...task, issueType: { id: 'bug', name: '缺陷' } }] }, () => {}))
    assert.deepEqual(await cache.readTasks('team-owner'), value)
    await cache.publish('team-owner', { month: '2026-02', days: [{ date: '2026-02-01', existing: 0, budget: 0, remaining: 0, state: 'not_required', reason: 'fixture' }], savedAt: 1 }, () => {})
    await cache.invalidate('team-owner', '2026-02')
    assert.equal(await cache.read('team-owner', '2026-02'), null)
  } finally { cache.close(); await rm(root, { recursive: true, force: true }) }
})

test('hours cache: obsolete rule projections are ignored and refreshed, without invalidating tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ones-hours-rules-'))
  const directory = join(root, 'db')
  const cache = new HoursCache(directory)
  try {
    await cache.publish('owner', value, () => {})
    const tasks = { typeId: 'ordinary', savedAt: 1, items: [] }
    await cache.publishTasks('owner', tasks, () => {})
    cache.close()
    const db = new DatabaseSync(join(directory, 'hours.sqlite'))
    try {
      for (const old of [value, { ...value, attendanceRuleVersion: 'obsolete' }]) {
        db.prepare('UPDATE months SET data=? WHERE scope=?').run(JSON.stringify(old), 'owner')
        assert.equal(await cache.read('owner', value.month), null)
        cache.close()
      }
    } finally { db.close() }
    assert.deepEqual(await cache.readTasks('owner'), tasks)
    const refreshed = { ...value, savedAt: 2, days: [{ ...value.days[0]!, budget: 450, remaining: 450, attendanceTime: {start:'09:00',end:'05:00',endNextDay:true} }] }
    await cache.publish('owner', refreshed, () => {})
    cache.close()
    assert.deepEqual(await cache.read('owner', value.month), refreshed)
  } finally { cache.close(); await rm(root, { recursive: true, force: true }) }
})
