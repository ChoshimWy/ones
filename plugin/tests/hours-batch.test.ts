import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Workbench, type Dependencies } from '../src/service.ts'
import type { HoursMonth, HoursTasks } from '../src/hours-cache.ts'
import { monthDates } from '../src/domain/missing-hours.ts'
import { startSeconds } from '../src/domain/attendance.ts'
import type { Worklog } from '../src/domain/model.ts'
import type { HoursBatchRow } from '../src/hours-batch.ts'

/// 合成网络与内存缓存，只测试公开 Workbench 链路，不触达真实账户。
function fixture(writesVerified = true) {
  const data = new Map<string, unknown>([
    ['session.ones', JSON.stringify({ token: 'fake', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt: Date.now() + 86400000 })],
    ['session.coho', JSON.stringify({ token: 'fake', principal: 'owner', label: 'Fixture', expiresAt: null })]
  ])
  const store = { get: async (key: string) => structuredClone(data.get(key) ?? null), set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)) }, delete: async (key: string) => { data.delete(key) } }
  const cache = new Map<string, HoursMonth>()
  const tasks = new Map<string, HoursTasks>()
  const removed: string[] = []
  const logs: Worklog[] = []
  const calls: string[] = []
  const state = { beforeTask: undefined as (() => Promise<void>) | undefined, failAt: 0, loseReplyAfterCommitAt: 0, existingKey: '', writes: 0, ordinary: true, end: '21:02', requested: '2026-02-01', duplicatePage: false, taskPage: 0 }
  const task = () => ({ uuid: 'task', number: 1, name: '虚构普通任务', project: { uuid: 'project', name: '项目' }, issueType: { uuid: state.ordinary ? 'ordinary' : 'bug', name: state.ordinary ? '任务' : '缺陷' }, status: { uuid: 'status', name: '处理中' } })
  const deps: Dependencies = { store, vault: store as Dependencies['vault'], writesVerified, protection: async () => true, hoursCache: {
    read: async (scope, month) => structuredClone(cache.get(scope + month) ?? null),
    publish: async (scope, value, check) => { check(); cache.set(scope + value.month, structuredClone(value)) },
    invalidate: async (scope, month) => { removed.push(month); cache.delete(scope + month) },
    readTasks: async scope => structuredClone(tasks.get(scope) ?? null),
    publishTasks: async (scope, value, check) => { check(); tasks.set(scope, structuredClone(value)) }
  }, fetcher: async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const json = (value: unknown) => Response.json(value)
    if (path.endsWith('/users/me')) return json({ uuid: 'owner' })
    if (path.endsWith('/info')) return json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
    if (path.endsWith('/issue_types')) return json({ issue_types: [{ uuid: 'ordinary', name: '任务' }, { uuid: 'bug', name: '缺陷' }] })
    if (path.endsWith('/getCurrentUser')) return json({ code: 200, data: { tenantCode: 'ATS', globalId: 'owner' } })
    if (path.endsWith('/getInfoByDateAndUser')) { state.requested = body.data.curDate; return json({ code: 200, data: { kqqs: state.requested.slice(0, 7) } }) }
    if (path.endsWith('/attCalendar')) {
      const dates = monthDates(body.data.kqqs)
      return json({ code: 200, data: { dateList: dates.map(date => ({ date })), dkList: dates.flatMap(date => ['08:53', state.end].map(time => ({ date, realDate: date, time, isNext: false, outFence: false }))) } })
    }
    const query = body.query ?? ''
    const vars = body.variables ?? {}
    const raw = (row: Worklog) => ({ ...row, owner: { uuid: row.owner }, task: { uuid: row.task } })
    if (query.includes('PluginTaskPage')) {
      assert.deepEqual(vars.filter.issueType_in, ['ordinary'])
      state.taskPage++
      return json({ data: { buckets: [{ tasks: [task()], pageInfo: { hasNextPage: state.duplicatePage && state.taskPage === 1, endCursor: 'next', unstable: false } }] } })
    }
    if (query.includes('PluginTask')) {
      await state.beforeTask?.()
      return json({ data: { tasks: [task()] } })
    }
    if (query.includes('PluginAdd')) {
      state.writes++
      if (state.writes === state.failAt) throw Error('simulated uncertain response')
      if (state.existingKey) return json({ data: { addManhour: { key: state.existingKey } } })
      const key = 'log-' + state.writes
      logs.push({ key, owner: vars.owner, task: vars.task, type: vars.type, startTime: vars.start_time, hours: vars.hours, description: vars.description })
      if (state.writes === state.loseReplyAfterCommitAt) throw Error('simulated response lost after commit')
      return json({ data: { addManhour: { key } } })
    }
    if (query.includes('PluginReadback')) return json({ data: { manhours: logs.filter(row => row.key === vars.filter.key_equal).map(raw) } })
    if (query.includes('PluginPage')) {
      const range = vars.filter.startTime_range
      return json({ data: { buckets: [{ manhours: logs.filter(row => row.startTime >= startSeconds(range.from, '00:00') && row.startTime < startSeconds(range.to, '00:00') + 86400).map(raw), pageInfo: { hasNextPage: false, endCursor: '', unstable: false } }] } })
    }
    throw Error('unexpected fixture request')
  } }
  return { service: new Workbench(deps), deps, data, cache, tasks, removed, logs, calls, state }
}
const rows: HoursBatchRow[] = ['2026-02-03', '2026-02-04'].map(date => ({ date, taskId: 'task', start: '09:00', minutes: 600, description: '虚构实际任务记录' }))

test('hours batch: immutable confirmation writes and verifies each date, invalidates cache and refuses replay', async () => {
  const f = fixture()
  const input = structuredClone(rows)
  const preview = await f.service.previewHoursBatch('team', input)
  input[0]!.minutes = 30
  const result = await f.service.submitHoursBatch(preview.id, true, 'team')
  assert.deepEqual(result.rows.map(row => row.state), ['verified', 'verified'])
  assert.equal(f.logs[0]!.hours, 1000000)
  assert.equal(f.logs[1]!.startTime, startSeconds(rows[1]!.date, '09:00'))
  assert.deepEqual(f.removed, ['2026-02'])
  assert.deepEqual(await new Workbench(f.deps).hoursBatchResult('team'), result)
  await assert.rejects(f.service.submitHoursBatch(preview.id, true, 'team'))
  assert.equal(f.state.writes, 2)
})

test('hours batch: production gate, confirmation, duplicate dates and task type reject before mutation', async () => {
  const disabled = fixture(false)
  const preview = await disabled.service.previewHoursBatch('team', rows)
  await assert.rejects(disabled.service.submitHoursBatch(preview.id, true, 'team'), { code: 'not_verified' })
  assert.equal(disabled.state.writes, 0)
  const f = fixture()
  await assert.rejects(f.service.previewHoursBatch('team', [rows[0]!, rows[0]!]))
  const value = await f.service.previewHoursBatch('team', rows)
  await assert.rejects(f.service.submitHoursBatch(value.id, false, 'team'))
  f.state.ordinary = false
  await assert.rejects(f.service.previewHoursBatch('team', rows), { code: 'scope' })
  assert.equal(f.state.writes, 0)
})

test('hours batch: changed worklogs or task type stop untouched dates', async () => {
  for (const changed of ['worklogs', 'type', 'attendance'] as const) {
    const f = fixture()
    const preview = await f.service.previewHoursBatch('team', rows)
    if (changed === 'type') f.state.ordinary = false
    else if (changed === 'attendance') f.state.end = '20:00'
    else f.logs.push({ key: 'external', owner: 'owner', task: 'task', startTime: startSeconds(rows[0]!.date, '09:00'), hours: 50000, description: '外部新增', type: 'recorded' })
    const result = await f.service.submitHoursBatch(preview.id, true, 'team')
    assert.deepEqual(result.rows.map(row => row.state), ['not_attempted', 'not_attempted'])
    assert.equal(f.state.writes, 0)
  }
})

test('hours batch: unknown second write preserves first and fences retries after worker restart', async () => {
  const f = fixture()
  f.state.failAt = 2
  const preview = await f.service.previewHoursBatch('team', [...rows, { ...rows[0]!, date: '2026-02-05' }])
  const result = await f.service.submitHoursBatch(preview.id, true, 'team')
  assert.deepEqual(result.rows.map(row => row.state), ['verified', 'unknown', 'not_attempted'])
  const restarted = new Workbench(f.deps)
  assert.equal((await restarted.pending('team')).length, 1)
  const retry = await restarted.previewHoursBatch('team', [rows[1]!])
  await assert.rejects(restarted.submitHoursBatch(retry.id, true, 'team'), { code: 'unknown' })
  assert.equal(f.state.writes, 2)
})

test('hours year: background scan preserves day and batch previews and reuses covered calendar', async () => {
  const f = fixture()
  const day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  const before = f.calls.filter(path => path.endsWith('/attCalendar')).length
  let scan = await f.service.scanHours({ team: 'team', month: '2026-02' })
  const preview = await f.service.makePreview({ dayId: day.id, allocations: [rows[0]!] })
  const batch = await f.service.previewHoursBatch('team', rows)
  while (scan.nextCursor) scan = await f.service.scanHours({ team: 'team', month: '2026-02', cursor: scan.nextCursor })
  assert.equal(preview.budget, 600)
  assert.equal(f.calls.filter(path => path.endsWith('/attCalendar')).length - before, 3) // one scan period + two fresh preview days
  assert.deepEqual((await f.service.submitHoursBatch(batch.id, true, 'team')).rows.map(row => row.state), ['verified', 'verified'])
})

test('hours tasks: only ordinary task pages publish, failed complete sync preserves cached directory', async () => {
  const f = fixture()
  const result = await f.service.syncHoursTasks('team')
  assert.equal(result.items[0]!.issueType.name, '任务')
  const calls = f.calls.length
  assert.deepEqual(await new Workbench(f.deps).cachedHoursTasks('team'), result)
  assert.equal(f.calls.length, calls)
  f.state.taskPage = 0
  f.state.duplicatePage = true
  await assert.rejects(f.service.syncHoursTasks('team'), { code: 'partial' })
  assert.deepEqual(await f.service.cachedHoursTasks('team'), result)
  f.state.ordinary = false
  await assert.rejects(f.service.syncHoursTasks('team'), { code: 'scope' })
})

test('hours year: only complete balanced past month skips cloud; force refresh remains available', async () => {
  const f = fixture()
  let scan = await f.service.scanHours({ team: 'team', month: '2026-02' })
  while (scan.nextCursor) scan = await f.service.scanHours({ team: 'team', month: '2026-02', cursor: scan.nextCursor })
  const [key, cached] = [...f.cache][0]!
  f.cache.set(key, { ...cached, days: cached.days.map(day => ({ ...day, existing: 600, remaining: 0, state: 'covered' })) })
  const before = f.calls.length
  const reused = await f.service.scanHours({ team: 'team', month: '2026-02' })
  assert.equal(reused.days.length, 28)
  assert.equal(f.calls.length, before)
  await f.service.scanHours({ team: 'team', month: '2026-02', force: true })
  assert.ok(f.calls.length > before)
})

test('hours batch: preview team cannot be substituted and malformed persisted results fail closed', async () => {
  const f = fixture()
  const session = JSON.parse(String(f.data.get('session.ones')))
  session.teams.push({ id: 'other', name: 'Other' })
  f.data.set('session.ones', JSON.stringify(session))
  const preview = await f.service.previewHoursBatch('team', rows)
  await assert.rejects(f.service.submitHoursBatch(preview.id, true, 'other'), { code: 'stale' })
  assert.equal(f.state.writes, 0)
  await f.service.submitHoursBatch(preview.id, true, 'team')
  const key = [...f.data.keys()].find(key => key.startsWith('hours.batch.result.'))!
  f.data.set(key, { rows: [{ date: 'bad-date', state: 'verified', message: 'fixture' }] })
  await assert.rejects(f.service.hoursBatchResult('team'))
})

test('hours year: scan awaiting cache cannot restart after write invalidates its generation', async () => {
  const f = fixture()
  const preview = await f.service.previewHoursBatch('team', rows)
  let cacheEntered!: () => void
  const cacheStarted = new Promise<void>(resolve => { cacheEntered = resolve })
  let cacheRelease!: () => void
  const cacheWait = new Promise<void>(resolve => { cacheRelease = resolve })
  f.deps.hoursCache!.read = async () => { cacheEntered(); await cacheWait; return null }
  let writeEntered!: () => void
  const writeStarted = new Promise<void>(resolve => { writeEntered = resolve })
  let writeRelease!: () => void
  const writeWait = new Promise<void>(resolve => { writeRelease = resolve })
  f.deps.hoursCache!.invalidate = async () => { writeEntered(); await writeWait }
  const scanning = f.service.scanHours({ team: 'team', month: '2026-02' })
  const rejected = assert.rejects(scanning, { code: 'stale' })
  await cacheStarted
  const writing = f.service.submitHoursBatch(preview.id, true, 'team')
  await writeStarted
  cacheRelease()
  await rejected
  writeRelease()
  assert.deepEqual((await writing).rows.map(row => row.state), ['verified', 'verified'])
  assert.equal(f.cache.size, 0)
})

test('hours year: write invalidation prevents a completed old scan from publishing over new worklogs', async () => {
  const f = fixture()
  const preview = await f.service.previewHoursBatch('team', rows)
  let publishEntered!: () => void
  const publishStarted = new Promise<void>(resolve => { publishEntered = resolve })
  let publishRelease!: () => void
  const publishWait = new Promise<void>(resolve => { publishRelease = resolve })
  const publish = f.deps.hoursCache!.publish
  f.deps.hoursCache!.publish = async (...args) => { publishEntered(); await publishWait; return publish(...args) }
  const scan = (async () => {
    let value = await f.service.scanHours({ team: 'team', month: '2026-02' })
    while (value.nextCursor) value = await f.service.scanHours({ team: 'team', month: '2026-02', cursor: value.nextCursor })
    return value
  })()
  const rejected = assert.rejects(scan, { code: 'stale' })
  await publishStarted
  await f.service.submitHoursBatch(preview.id, true, 'team')
  publishRelease()
  await rejected
  assert.equal(f.cache.size, 0)
})

test('hours batch: auth switch during preview or persisted result read discards old identity', async () => {
  const f = fixture()
  const preview = await f.service.previewHoursBatch('team', rows)
  await f.service.submitHoursBatch(preview.id, true, 'team')
  const original = f.deps.store.get
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  f.deps.store.get = async key => {
    const value = await original(key)
    if (key.startsWith('hours.batch.result.')) { entered(); await wait }
    return value
  }
  const result = f.service.hoursBatchResult('team')
  const rejected = assert.rejects(result, { code: 'stale' })
  await started
  await f.service.logout('coho')
  release()
  await rejected
  await assert.rejects(f.service.submitHoursBatch(preview.id, true, 'team'))
  assert.equal(f.state.writes, 2)
})


test('hours batch acceptance: existing key cannot verify a new write or resume remaining dates', async () => {
  const f = fixture()
  const row = { ...rows[0]!, minutes: 30 }
  f.logs.push({ key: 'already-present', owner: 'owner', task: row.taskId, hours: 50000, startTime: startSeconds(row.date, row.start), description: row.description, type: 'recorded' })
  f.state.existingKey = 'already-present'
  const preview = await f.service.previewHoursBatch('team', [row, rows[1]!])
  const result = await f.service.submitHoursBatch(preview.id, true, 'team')
  assert.deepEqual(result.rows.map(item => item.state), ['unknown', 'not_attempted'])
  assert.equal(f.logs.length, 1)
  const restarted = new Workbench(f.deps)
  assert.deepEqual(await restarted.hoursBatchResult('team'), result)
  assert.equal((await restarted.pending('team')).length, 1)
  const retry = await restarted.previewHoursBatch('team', [row])
  await assert.rejects(restarted.submitHoursBatch(retry.id, true, 'team'), { code: 'unknown' })
  assert.equal(f.state.writes, 1)
})

test('hours batch acceptance: committed write with lost reply is never resent after restart', async () => {
  const f = fixture()
  f.state.loseReplyAfterCommitAt = 1
  const preview = await f.service.previewHoursBatch('team', rows)
  const result = await f.service.submitHoursBatch(preview.id, true, 'team')
  assert.deepEqual(result.rows.map(item => item.state), ['unknown', 'not_attempted'])
  assert.equal(f.logs.length, 1)
  assert.equal(f.logs[0]!.startTime, startSeconds(rows[0]!.date, rows[0]!.start))
  const restarted = new Workbench(f.deps)
  assert.equal((await restarted.pending('team')).length, 1)
  // A different date still cannot bypass an unresolved account-scoped operation.
  const retry = await restarted.previewHoursBatch('team', [rows[1]!])
  await assert.rejects(restarted.submitHoursBatch(retry.id, true, 'team'), { code: 'unknown' })
  assert.equal(f.state.writes, 1)
  assert.equal(f.logs.length, 1)
})

// Single-day and batch submissions share the same public Workbench and fake API.
function pauseTaskRead(f: ReturnType<typeof fixture>) {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  let paused = false
  f.state.beforeTask = async () => {
    if (!paused) {
      paused = true
      entered()
      await waiting
    }
  }
  return { started, release: () => release() }
}

test('single-day confirmation: failed replacement revokes the previous token', async () => {
  const f = fixture()
  const day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  const preview = await f.service.makePreview({ dayId: day.id, allocations: [rows[0]!] })
  await assert.rejects(f.service.makePreview({ dayId: day.id, allocations: [{ ...rows[0]!, description: '' }] }))
  await assert.rejects(f.service.submit(preview.id, true), { code: 'stale' })
  assert.equal(f.state.writes, 0)
})

test('single-day confirmation: caller mutations cannot change the previewed write', async () => {
  const f = fixture()
  const day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  const input = { dayId: day.id, allocations: [{ ...rows[0]!, minutes: 30 }] }
  const pending = f.service.makePreview(input)
  input.allocations[0]!.description = 'changed while awaiting authentication'
  const preview = await pending
  assert.equal(preview.rows[0]!.description, rows[0]!.description)
  assert.deepEqual(await f.service.submit(preview.id, true), { count: 1 })
  assert.equal(f.logs[0]!.description, rows[0]!.description)
  const refreshed = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  // Returned display data must not mutate the server-held confirmation.
  const value = await f.service.makePreview({ dayId: refreshed.id, allocations: [{ ...rows[0]!, minutes: 30 }] })
  const token = value.id
  value.rows[0]!.description = 'changed returned view'
  value.id = 'forged'
  value.expiresAt = 0
  assert.deepEqual(await f.service.submit(token, true), { count: 1 })
  assert.equal(f.logs[0]!.description, rows[0]!.description)
  assert.equal(f.logs[1]!.description, rows[0]!.description)
  assert.equal(f.logs[1]!.hours, 50000)
  await assert.rejects(f.service.submit(token, true), { code: 'stale' })
  assert.equal(f.state.writes, 2)
})

test('single-day confirmation: late preview cannot replace a newer intent', async () => {
  const f = fixture()
  const day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  const pause = pauseTaskRead(f)
  const first = f.service.makePreview({ dayId: day.id, allocations: [{ ...rows[0]!, minutes: 30 }] })
  const rejected = assert.rejects(first, { code: 'stale' })
  await pause.started
  const second = await f.service.makePreview({ dayId: day.id, allocations: [{ ...rows[0]!, minutes: 60 }] })
  pause.release()
  await rejected
  assert.deepEqual(await f.service.submit(second.id, true), { count: 1 })
  assert.equal(f.logs[0]!.hours, 100000)
})

test('single-day confirmation: cancellation after task read never publishes authority', async () => {
  const f = fixture()
  const day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  const pause = pauseTaskRead(f)
  const controller = new AbortController()
  const pending = f.service.makePreview({ dayId: day.id, allocations: [rows[0]!] }, controller.signal)
  const rejected = assert.rejects(pending)
  await pause.started
  controller.abort()
  pause.release()
  await rejected
  assert.equal(f.state.writes, 0)
})

test('acceptance: private one-shot permit enables only its immutable single-day preview', async () => {
  const { HoursAcceptance } = await import('../src/hours-acceptance.ts')
  const { mkdtemp, writeFile, rm, chmod } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'ones-acceptance-'))
  await chmod(directory, 0o700)
  try {
    const f = fixture(false)
    const acceptance = new HoursAcceptance(directory)
    f.deps.consumeHoursAcceptance = grant => acceptance.consume(grant)
    const preview = async () => {
      const day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
      return f.service.makePreview({ dayId: day.id, allocations: [{ ...rows[0]!, minutes: 30 }] })
    }
    const first = await preview()
    await assert.rejects(f.service.submit(first.id, true), { code: 'not_verified' })
    const batch = await f.service.previewHoursBatch('team', rows)
    await assert.rejects(f.service.submitHoursBatch(batch.id, true, 'team'), { code: 'not_verified' })
    await assert.rejects(f.service.submitAcceptance(first.id, true)) // missing permit
    assert.equal(f.state.writes, 0)
    const value = await preview()
    const grant = { previewId: value.id, identity: (await f.service.status()).identity!, expiresAt: value.expiresAt }
    await writeFile(join(directory, 'permit.json'), JSON.stringify(grant), { mode: 0o600 })
    assert.deepEqual(await f.service.submitAcceptance(value.id, true), { count: 1 })
    assert.equal(f.logs[0]!.description, rows[0]!.description)
    assert.equal(f.logs[0]!.hours, 50000)
    assert.equal((await f.service.status()).writeEnabled, false)
    await assert.rejects(acceptance.consume(grant)) // persisted claim, even in another instance
    await assert.rejects(new HoursAcceptance(directory).consume(grant))
    const next = await preview()
    await assert.rejects(f.service.submitAcceptance(next.id, true)) // old permit cannot authorize new preview
    assert.equal(f.state.writes, 1)
  } finally { await rm(directory, { recursive: true }) }
})

test('acceptance: scope, expiry, permissions, symlink and concurrent claim fail closed', async () => {
  const { HoursAcceptance } = await import('../src/hours-acceptance.ts')
  const { mkdtemp, writeFile, rm, chmod, symlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'ones-acceptance-'))
  await chmod(directory, 0o700)
  const path = join(directory, 'permit.json')
  const grant = { previewId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', identity: 'a'.repeat(64), expiresAt: Date.now() + 60000 }
  const acceptance = new HoursAcceptance(directory)
  try {
    for (const change of [{ previewId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, { identity: 'b'.repeat(64) }, { expiresAt: 0 }, { extra: true }]) {
      await writeFile(path, JSON.stringify({ ...grant, ...change }), { mode: 0o600 })
      await assert.rejects(acceptance.consume(grant))
    }
    await writeFile(path, JSON.stringify(grant))
    await chmod(path, 0o644)
    await assert.rejects(acceptance.consume(grant))
    await rm(path)
    await writeFile(join(directory, 'target'), JSON.stringify(grant), { mode: 0o600 })
    await symlink(join(directory, 'target'), path)
    await assert.rejects(acceptance.consume(grant))
    await rm(path)
    await writeFile(path, JSON.stringify(grant), { mode: 0o600 })
    const results = await Promise.allSettled([acceptance.consume(grant), new HoursAcceptance(directory).consume(grant)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  } finally { await rm(directory, { recursive: true }) }
})

test('acceptance: multiple rows, stale data and unknown writes never widen authority', async () => {
  const f = fixture(false)
  let claims = 0
  f.deps.consumeHoursAcceptance = async () => { claims++ }
  let day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  const multi = await f.service.makePreview({ dayId: day.id, allocations: [{ ...rows[0]!, minutes: 30 }, { ...rows[0]!, minutes: 30 }] })
  await assert.rejects(f.service.submitAcceptance(multi.id, true), { code: 'acceptance' })
  assert.equal(claims, 0)
  const stale = await f.service.makePreview({ dayId: day.id, allocations: [rows[0]!] })
  f.state.end = '20:00'
  await assert.rejects(f.service.submitAcceptance(stale.id, true), { code: 'stale' })
  assert.equal(claims, 0)
  f.state.end = '21:02'
  day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  const value = await f.service.makePreview({ dayId: day.id, allocations: [{ ...rows[0]!, minutes: 30 }] })
  f.state.loseReplyAfterCommitAt = 1
  await assert.rejects(f.service.submitAcceptance(value.id, true))
  assert.equal(claims, 1)
  assert.equal(f.logs.length, 1)
  const restarted = new Workbench(f.deps)
  day = await restarted.readDay({ team: 'team', date: rows[0]!.date })
  const retry = await restarted.makePreview({ dayId: day.id, allocations: [{ ...rows[0]!, minutes: 30 }] })
  await assert.rejects(restarted.submitAcceptance(retry.id, true), { code: 'unknown' })
  assert.equal(claims, 1)
  assert.equal(f.state.writes, 1)
})

test('acceptance: identity change after permit consumption blocks the request', async () => {
  const f = fixture(false)
  f.deps.consumeHoursAcceptance = async () => { await f.service.logout('coho') }
  const day = await f.service.readDay({ team: 'team', date: rows[0]!.date })
  const value = await f.service.makePreview({ dayId: day.id, allocations: [rows[0]!] })
  await assert.rejects(f.service.submitAcceptance(value.id, true), { code: 'stale' })
  assert.equal(f.state.writes, 0)
})

test('enabled hours: adding hours never enables description updates', async () => {
  const f = fixture(true)
  assert.equal((await f.service.status()).writeEnabled, true)
  assert.equal((await f.service.status()).descriptionWriteEnabled, false)
  assert.ok(!(await f.service.status()).blockers.some(value => value.includes('当前仅开放预览')))
  await assert.rejects(f.service.describe({ team: 'team', date: rows[0]!.date, key: 'existing', description: '不可连带开放', confirmed: true }), { code: 'not_verified' })
  assert.equal(f.state.writes, 0)
})

test('enabled hours: lost batch result persistence still prevents replay of successful writes', async () => {
  const f = fixture()
  const original = f.deps.store.set
  f.deps.store.set = async (key, value) => {
    if (key.startsWith('hours.batch.result.')) throw Error('fixture result persistence failure')
    await original(key, value)
  }
  const preview = await f.service.previewHoursBatch('team', rows)
  await assert.rejects(f.service.submitHoursBatch(preview.id, true, 'team'))
  assert.equal(f.state.writes, 2)
  await assert.rejects(f.service.submitHoursBatch(preview.id, true, 'team'), { code: 'stale' })
  const restarted = new Workbench(f.deps)
  assert.equal((await restarted.readDay({ team: 'team', date: rows[0]!.date })).existing, 600)
  await assert.rejects(restarted.previewHoursBatch('team', rows), { code: 'budget' })
  assert.equal(f.state.writes, 2)
})
