import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanDates, classifyDay, taskDraft } from '../src/domain/missing-hours.ts'
import { Workbench, type Vault } from '../src/service.ts'
import { startSeconds } from '../src/domain/attendance.ts'
import type { Attendance, Task } from '../src/domain/model.ts'

const day = '2026-02-10'
const attendance: Attendance = { date: day, fetchedAt: Date.now(), punches: ['18:30', '09:00'].map(time => ({ date: day, realDate: day, time, isNext: false, outFence: false })) }
const task: Task = { id: 'task', number: 1, name: '虚构任务', project: { id: 'p', name: 'P' }, issueType: { id: 't', name: '任务' }, status: { id: 's', name: '处理中' } }

test('missing hours: calendar months, leap day and Shanghai midnight', () => {
  for (const months of [1,2,3,6,12]) {
    const dates = scanDates(months, new Date('2026-03-30T16:00:00Z'))
    assert.equal(dates.at(-1), '2026-03-30')
    assert.equal(new Set(dates).size, dates.length)
  }
  assert.equal(scanDates(1, new Date('2026-03-31T00:00:00Z'))[0], '2026-02-28')
  assert.equal(scanDates(12, new Date('2024-02-29T00:00:00Z'))[0], '2023-02-28')
  assert.equal(scanDates(1, new Date('2026-03-30T15:59:59Z')).at(-1), '2026-03-29')
  assert.throws(() => scanDates(4))
})
test('missing hours: absent, partial, covered and ambiguous attendance remain distinct', () => {
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
test('missing hours: draft uses chosen duration, rejects duplicates and budget overflow', () => {
  const draft = taskDraft(task, '09:00', 120, '', 480, 120, [])
  assert.equal(draft.minutes, 120)
  assert.match(draft.description, /虚构任务/)
  assert.throws(() => taskDraft(task, '09:00', 480, '', 480, 120, []))
  assert.throws(() => taskDraft(task, '09:00', 120, '', 480, 0, [draft]))
  assert.throws(() => taskDraft(task, '23:00', 120, '', 480, 0, []))
  assert.throws(() => taskDraft(task, '09:00', 121, '', 480, 0, []))
})

function fixture() {
  const data = new Map<string, string>([
    ['session.ones', JSON.stringify({ token: 'fixture', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt: Date.now() + 172800000 })],
    ['session.coho', JSON.stringify({ token: 'fixture', principal: 'owner', label: 'Fixture', expiresAt: null })]
  ])
  const vault: Vault = { get: async key => data.get(key) ?? null, set: async (key,value) => { data.set(key,value) }, delete: async key => { data.delete(key) } }
  const calls: string[] = []
  let requested = '', fail = false
  const service = new Workbench({ store: vault, vault, protection: async () => true, fetcher: async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const json = (value: unknown) => Response.json(value)
    if (path.endsWith('/users/me')) return json({ uuid: 'owner' })
    if (path.endsWith('/info')) return json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
    if (path.endsWith('/items/graphql')) {
      assert.ok(!JSON.stringify(body).includes('mutation'))
      return json({ data: { buckets: [{ manhours: [], pageInfo: { hasNextPage: false, endCursor: '', unstable: false } }] } })
    }
    if (path.endsWith('/getCurrentUser')) return json({ code: 200, data: { tenantCode: 'ATS', globalId: 'owner' } })
    if (path.endsWith('/getInfoByDateAndUser')) {
      requested = body.data.curDate
      return json({ code: 200, data: { kqqs: 'period' } })
    }
    if (path.endsWith('/attCalendar')) {
      if (fail) return new Response('', { status: 503 })
      return json({ code: 200, data: { dateList: requested.endsWith('02') ? [] : [{ date: requested }], dkList: requested.endsWith('01') ? [] : ['09:00', '18:30'].map(time => ({ date: requested, realDate: requested, time, isNext: false, outFence: false })) } })
    }
    throw new Error('unexpected endpoint')
  } })
  return { service, calls, fail: () => { fail = true } }
}
const input = { team: 'team', months: 1, mappingConfirmed: true }
test('missing hours: service batches all dates, reads worklogs first and re-reads selected day', async () => {
  const f = fixture()
  let result = await f.service.scanHours(input)
  const scanned = [...result.days]
  const dates = result.days.map(d => d.date)
  assert.equal(result.days.length, 7)
  assert.ok(f.calls.findIndex(p => p.endsWith('/items/graphql')) < f.calls.findIndex(p => p.endsWith('/attCalendar')))
  while (result.nextCursor) {
    result = await f.service.scanHours({ ...input, cursor: result.nextCursor })
    dates.push(...result.days.map(d => d.date))
    scanned.push(...result.days)
  }
  assert.deepEqual(dates, scanDates(1))
  const absent = scanned.filter(d => d.date.endsWith('01'))
  assert.ok(absent.length > 0)
  assert.ok(absent.every(d => d.state === 'not_required' && d.remaining === 0))
  await assert.rejects(f.service.readDay({ team: 'team', date: absent[0]!.date, mappingConfirmed: true }), { code: 'no_attendance' })
  assert.ok(scanned.filter(d => d.date.endsWith('02')).every(d => d.state === 'review'))
  const selected = dates.find(d => !d.endsWith('01') && !d.endsWith('02'))!
  const data = await f.service.readDay({ team: 'team', date: selected, mappingConfirmed: true })
  assert.equal(data.date, selected)
  assert.equal(data.existing, 0)
  assert.equal(startSeconds(selected, '00:00') > 0, true)
})
test('missing hours: stale cursor, wrong range, cancelled and failed reads never publish partial results', async () => {
  const f = fixture()
  const first = await f.service.scanHours(input)
  await assert.rejects(f.service.scanHours({ ...input, months: 2, cursor: first.nextCursor! }))
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
