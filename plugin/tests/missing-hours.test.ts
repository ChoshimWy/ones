import { nextAttendanceDate } from '../src/domain/attendance.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthDates, businessDate, classifyDay, taskDraft, attendanceEndpoints } from '../src/domain/missing-hours.ts'
import { Workbench, type Vault, type Dependencies } from '../src/service.ts'
import { startSeconds } from '../src/domain/attendance.ts'
import type { Attendance, Task } from '../src/domain/model.ts'

const day = '2026-02-10'
const attendance: Attendance = { date: day, fetchedAt: Date.now(), punches: ['18:30', '09:00'].map(time => ({ date: day, realDate: day, time, isNext: false, outFence: false })) }
const task: Task = { id: 'task', number: 1, name: '虚构任务', project: { id: 'p', name: 'P' }, issueType: { id: 't', name: '任务' }, status: { id: 's', name: '处理中' } }

test('missing hours: calendar-month bounds and current day are explicit', () => {
  const now = new Date('2026-03-30T16:00:00Z')
  assert.equal(businessDate(now), '2026-03-31')
  assert.equal(monthDates('2026-02', now).length, 28)
  assert.equal(monthDates('2024-02', now).length, 29)
  assert.equal(monthDates('2026-03', now).at(-1), '2026-03-31')
  assert.equal(monthDates('2026-03', new Date('2026-03-30T15:59:59Z')).at(-1), '2026-03-30')
  assert.throws(() => monthDates('2026-04', now))
})
test('missing hours: absent, partial, covered and ambiguous attendance remain distinct', () => {
  const overtime = { ...attendance, punches: attendance.punches.map((p, i) => ({ ...p, time: i === 0 ? '21:02' : '08:53' })) }
  assert.equal(classifyDay(overtime, 0).budget, 600)
  assert.equal(classifyDay(overtime, 0).state, 'missing')
  assert.equal(classifyDay(overtime, 480).remaining, 120)
  assert.equal(classifyDay(overtime, 600).state, 'covered')
  assert.equal(classifyDay(attendance, 0).state, 'missing')
  assert.equal(classifyDay(attendance, 120).remaining, 360)
  assert.deepEqual(classifyDay(attendance, 120).attendanceTime, { start: '09:00', end: '18:30' })
  assert.equal(classifyDay({ ...attendance, punches: [] }, 120).remaining, 0)
  assert.equal(classifyDay({ ...attendance, punches: attendance.punches.slice(0, 1) }, 0).state, 'review')
  assert.equal(classifyDay(attendance, 120).state, 'partial')
  assert.equal(classifyDay(attendance, 480).state, 'covered')
  assert.equal(classifyDay(attendance, 600).remaining, 0)
  assert.equal(classifyDay({ ...attendance, punches: [] }, 0).state, 'not_required')
  assert.equal(classifyDay({ ...attendance, punches: attendance.punches.map(p => ({ ...p, outFence: null })) }, 0).state, 'review')
})
test('missing hours: late punches reduce subsequent draft capacity without rewriting punch times or worklogs', () => {
  const late = { ...attendance, punches: attendance.punches.map(p => ({ ...p, time: p.time === '09:00' ? '09:30' : p.time })) }
  const result = classifyDay(late, 420)
  assert.equal(result.budget, 450)
  assert.equal(result.remaining, 30)
  assert.equal(result.state, 'partial')
  assert.deepEqual(result.attendanceTime, { start: '09:30', end: '18:30' })
  assert.equal(taskDraft(task, '09:30', 30, 'fixture', result.budget!, result.existing, []).minutes, 30)
  assert.throws(() => taskDraft(task, '09:30', 60, 'fixture', result.budget!, result.existing, []))
  const over = classifyDay(late, 480)
  assert.equal(over.existing, 480)
  assert.equal(over.remaining, 0)
  assert.match(over.reason, /超过/)
  assert.equal(classifyDay(late, 450).state, 'covered')
})

test('missing hours: draft uses chosen duration, rejects duplicates and budget overflow', () => {
  const draft = taskDraft(task, '09:00', 120, '', 480, 120, [])
  assert.equal(draft.minutes, 120)
  assert.match(draft.description, /虚构任务/)
  assert.throws(() => taskDraft(task, '09:00', 480, '', 480, 120, []))
  assert.throws(() => taskDraft(task, '09:00', 120, '', 480, 0, [draft]))
  assert.throws(() => taskDraft(task, '23:00', 120, '', 480, 0, []))
  assert.throws(() => taskDraft(task, '09:00', 121, '', 480, 0, []))
})

function fixture(start = '09:00') {
  const data = new Map<string, string>([
    ['session.ones', JSON.stringify({ token: 'fixture', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt: Date.now() + 172800000 })],
    ['session.coho', JSON.stringify({ token: 'fixture', principal: 'owner', label: 'Fixture', expiresAt: null })]
  ])
  const vault: Vault = { get: async key => data.get(key) ?? null, set: async (key,value) => { data.set(key,value) }, delete: async key => { data.delete(key) } }
  const calls: string[] = []
  let requested = '', fail = false
  let hold: (() => Promise<void>) | undefined
  const cache = new Map<string, import('../src/hours-cache.ts').HoursMonth>()
  const deps: Dependencies = { hoursCache: {
    read: async (scope, month) => structuredClone(cache.get(scope + month) ?? null),
    publish: async (scope, value, check) => { check(); cache.set(scope + value.month, structuredClone(value)) }
  }, store: vault, vault, protection: async () => true, fetcher: async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const json = (value: unknown) => Response.json(value)
    if (path.endsWith('/users/me')) return json({ uuid: 'owner' })
    if (path.endsWith('/info')) return json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
    if (path.endsWith('/items/graphql')) {
      const wait = hold; hold = undefined; if (wait) await wait()
      assert.ok(!JSON.stringify(body).includes('mutation'))
      return json({ data: { buckets: [{ manhours: [], pageInfo: { hasNextPage: false, endCursor: '', unstable: false } }] } })
    }
    if (path.endsWith('/getCurrentUser')) return json({ code: 200, data: { tenantCode: 'ATS', globalId: 'owner' } })
    if (path.endsWith('/getInfoByDateAndUser')) {
      requested = body.data.curDate
      return json({ code: 200, data: { kqqs: requested } })
    }
    if (path.endsWith('/attCalendar')) {
      if (fail) return new Response('', { status: 503 })
      return json({ code: 200, data: { dateList: [{ date: requested }, { date: nextAttendanceDate(requested) }], workList: [], dkList: [requested, nextAttendanceDate(requested)].filter(date => !date.endsWith('01')).flatMap(date => [start, '18:30'].map(time => ({ date, realDate: date, time, isNext: false, outFence: date.endsWith('02') ? null : false }))) } })
    }
    throw new Error('unexpected endpoint')
  } }
  const service = new Workbench(deps)
  return { service, deps, cache, calls, holdNext: (value: () => Promise<void>) => { hold = value }, fail: () => { fail = true } }
}
const input = { team: 'team', month: '2026-02' }
test('missing hours: service batches all dates, reads worklogs first and re-reads selected day', async () => {
  const f = fixture()
  let result = await f.service.scanHours(input)
  const scanned = [...result.days]
  const dates = result.days.map(d => d.date)
  assert.equal(result.days.length, 7)
  assert.equal(f.cache.size, 0)
  assert.ok(f.calls.findIndex(p => p.endsWith('/items/graphql')) < f.calls.findIndex(p => p.endsWith('/attCalendar')))
  while (result.nextCursor) {
    result = await f.service.scanHours({ ...input, cursor: result.nextCursor })
    dates.push(...result.days.map(d => d.date))
    scanned.push(...result.days)
  }
  assert.deepEqual(dates, monthDates(input.month))
  assert.equal(f.cache.size, 1)
  const callCount = f.calls.length
  assert.equal((await new Workbench(f.deps).cachedHours(input.team, input.month))?.days.length, dates.length)
  assert.equal(f.calls.length, callCount)
  const absent = scanned.filter(d => d.date.endsWith('01'))
  assert.ok(absent.length > 0)
  assert.ok(absent.every(d => d.state === 'not_required' && d.remaining === 0))
  await assert.rejects(f.service.readDay({ team: 'team', date: absent[0]!.date }), { code: 'no_attendance' })
  assert.ok(scanned.filter(d => d.date.endsWith('02')).every(d => d.state === 'review'))
  const selected = dates.find(d => !d.endsWith('01') && !d.endsWith('02'))!
  const data = await f.service.readDay({ team: 'team', date: selected })
  assert.equal(data.date, selected)
  assert.equal(data.existing, 0)
  assert.equal(startSeconds(selected, '00:00') > 0, true)
})
test('missing hours: stale cursor, wrong range, cancelled and failed reads never publish partial results', async () => {
  const f = fixture()
  const first = await f.service.scanHours(input)
  await assert.rejects(f.service.scanHours({ ...input, month: '2026-01', cursor: first.nextCursor! }))
  const second = await f.service.scanHours({ ...input, cursor: first.nextCursor! })
  await assert.rejects(f.service.scanHours({ ...input, cursor: first.nextCursor! }))
  f.fail()
  await assert.rejects(f.service.scanHours({ ...input, cursor: second.nextCursor! }))
  await assert.rejects(f.service.scanHours({ ...input, cursor: second.nextCursor! }))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.service.scanHours(input, controller.signal))
})

test('missing hours: range adapter follows pages and rejects duplicate lists', async () => {
  const { OnesClient } = await import('../src/adapters/ones.ts')
  const { Transport, ONES } = await import('../src/adapters/http.ts')
  const session = { token: 'fixture', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt: Date.now() + 172800000 }
  let count = 0, duplicate = false
  const client = new OnesClient(new Transport(ONES, async (_, init) => {
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.variables.filter.startTime_range, { from: '2026-02-01', to: '2026-02-28' })
    assert.deepEqual(body.variables.filter.owner_in, ['owner'])
    const page = count++ % 2
    return Response.json({ data: { buckets: [{
      manhours: [{ key: duplicate ? 'same' : 'key-' + page, owner: { uuid: 'owner' }, task: { uuid: 'task' }, type: 'recorded', hours: 200000, startTime: startSeconds(day, '09:00'), description: '虚构工时' }],
      pageInfo: { hasNextPage: page === 0, endCursor: 'cursor', unstable: false }
    }] } })
  }), session, 'team')
  assert.equal((await client.worklogsRange('2026-02-01', '2026-02-28')).length, 2)
  duplicate = true
  await assert.rejects(client.worklogsRange('2026-02-01', '2026-02-28'))
})


test('missing hours: cached month is isolated by principal; failed refresh preserves full snapshot; today is pending', async () => {
  const f = fixture()
  const request = { team: 'team', month: businessDate().slice(0, 7) }
  let result = await f.service.scanHours(request)
  while (result.nextCursor) result = await f.service.scanHours({ ...request, cursor: result.nextCursor })
  const cached = await f.service.cachedHours(request.team, request.month)
  assert.equal(cached?.days.at(-1)?.date, businessDate())
  assert.equal(cached?.days.at(-1)?.state, 'pending')
  const other = new Workbench({ ...f.deps, vault: { ...f.deps.vault, get: async key => {
    const value = await f.deps.vault.get(key)
    return key === 'session.coho' ? JSON.stringify({ ...JSON.parse(value!), principal: 'other-owner' }) : value
  } } })
  assert.equal(await other.cachedHours(request.team, request.month), null)
  f.fail()
  await assert.rejects(f.service.scanHours(request))
  assert.deepEqual(await f.service.cachedHours(request.team, request.month), cached)
})


test('missing hours: late initial month request cannot replace a newer scan cursor', async () => {
  const f = fixture()
  let release!: () => void
  let started!: () => void
  const reached = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.holdNext(async () => { started(); await gate })
  const old = assert.rejects(f.service.scanHours({ team: 'team', month: '2026-01' }), { code: 'stale' })
  await reached
  const fresh = await f.service.scanHours(input)
  release()
  await old
  assert.ok(fresh.nextCursor)
  const next = await f.service.scanHours({ ...input, cursor: fresh.nextCursor! })
  assert.equal(next.days[0]?.date, '2026-02-08')
})

test('missing hours: service scan and selected-day preview share the late budget', async () => {
  const f = fixture('09:30')
  const result = await f.service.scanHours(input)
  const scanned = result.days.find(day => day.date === '2026-02-03')!
  assert.equal(scanned.budget, 450)
  assert.equal(scanned.remaining, 450)
  const selected = await f.service.readDay({ team: 'team', date: scanned.date })
  await assert.rejects(f.service.makePreview({
    dayId: selected.id,
    allocations: [{ taskId: task.id, start: '09:30', minutes: 480, description: 'fixture' }]
  }), { code: 'budget' })
})

test('missing hours: first and last punches are display-only for multi-punch and incomplete days', () => {
  const punches = ['18:40', '12:30', '08:57', '14:00'].map(time => ({ ...attendance.punches[0]!, time }))
  const multiple = { ...attendance, punches }
  assert.deepEqual(attendanceEndpoints(multiple), { start: '08:57', end: '18:40' })
  const result = classifyDay(multiple, 0)
  assert.deepEqual(result.attendanceTime, { start: '08:57', end: '18:40' })
  assert.equal(result.state, 'review')
  assert.equal(result.budget, null)
  assert.equal(result.remaining, null)
  assert.deepEqual(attendanceEndpoints({ ...attendance, punches: [punches[0]!] }), { start: '18:40', end: '18:40' })
  assert.equal(classifyDay({ ...attendance, punches: [punches[0]!] }, 0).state, 'review')
  assert.equal(attendanceEndpoints({ ...attendance, punches: [] }), undefined)
  for (const changed of [{ isNext: true }, { realDate: '2026-02-11' }, { time: 'invalid' }]) {
    assert.equal(attendanceEndpoints({ ...attendance, punches: [{ ...punches[0]!, ...changed }] }), undefined)
  }
  assert.deepEqual(multiple.punches.map(p => p.time), ['18:40', '12:30', '08:57', '14:00'])
})
