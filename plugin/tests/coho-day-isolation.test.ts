import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workbench, type Dependencies } from '../src/service.ts'
import { HoursCache } from '../src/hours-cache.ts'
import { monthDates } from '../src/domain/missing-hours.ts'
import { alignedHoursMonth } from '../src/domain/hours-year.ts'

/// 真实 adapter/service/SQLite 的合成边界，不使用账号或真实网络。
async function fixture(change: (calendar: Record<string, unknown>) => void = () => {}, failure = '') {
  const root = await mkdtemp(join(tmpdir(), 'ones-day-isolation-'))
  const cache = new HoursCache(join(root, 'db'))
  const data = new Map<string, unknown>([
    ['session.ones', JSON.stringify({ token: 'fake', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt: Date.now() + 86400000 })],
    ['session.coho', JSON.stringify({ token: 'fake', principal: 'owner', label: 'Fixture', expiresAt: null })]
  ])
  const store = { get: async (key: string) => structuredClone(data.get(key) ?? null), set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)) }, delete: async (key: string) => { data.delete(key) } }
  let calendarCalls = 0
  let publications = 0
  const publish = cache.publish.bind(cache)
  cache.publish = async (...args) => { publications++; await publish(...args) }
  const deps: Dependencies = { store, vault: store as Dependencies['vault'], writesVerified: false, protection: async () => true, hoursCache: cache,
    fetcher: async (url, init) => {
      const path = new URL(String(url)).pathname
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (path.endsWith('/users/me')) return Response.json({ uuid: 'owner' })
      if (path.endsWith('/info')) return Response.json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
      if (path.endsWith('/issue_types')) return Response.json({ issue_types: [{ uuid: 'ordinary', name: '任务' }] })
      if (path.endsWith('/getCurrentUser')) return Response.json({ code: 200, data: { tenantCode: 'ATS', globalId: failure === 'identity' ? 'other' : 'owner' } })
      if (path.endsWith('/getInfoByDateAndUser')) return Response.json({ code: 200, data: failure === 'period' ? {} : { kqqs: 'april' } })
      if (path.endsWith('/attCalendar')) {
        calendarCalls++
        if (failure === 'network') throw Error('fixture offline')
        if (failure === 'http') return new Response('', { status: 503 })
        if (failure === 'auth') return Response.json({ code: 401, data: {} })
        const dates = [...monthDates('2026-04'), '2026-05-01']
        const calendar = { dateList: dates.map(date => ({ date })), workList: [], dkList: dates.filter(date => date !== '2026-04-12').flatMap(date => ['08:50', '18:31'].map(time => ({ date, realDate: date, time, isNext: false, outFence: false }))) }
        change(calendar)
        return Response.json({ code: 200, data: calendar })
      }
      const query = body.query ?? ''
      if (query.includes('PluginTask')) return Response.json({ data: { tasks: [{ uuid: 'task', number: 1, name: '虚构普通任务', project: { uuid: 'project', name: '项目' }, issueType: { uuid: 'ordinary', name: '任务' }, status: { uuid: 'status', name: '处理中' } }] } })
      if (query.includes('PluginPage')) return Response.json({ data: { buckets: [{ manhours: [], pageInfo: { hasNextPage: failure === 'pagination', endCursor: '', unstable: false } }] } })
      throw Error('unexpected fixture request; mutations forbidden')
    }
  }
  const service = new Workbench(deps)
  return { service, cache, deps, calendarCalls: () => calendarCalls, publications: () => publications, close: async () => { cache.close(); await rm(root, { recursive: true, force: true }) } }
}

/// 完整月份只在最后一个游标成功后发布。
async function scan(service: Workbench) {
  let result = await service.scanHours({ team: 'team', month: '2026-04', force: true })
  while (result.nextCursor) result = await service.scanHours({ team: 'team', month: '2026-04', cursor: result.nextCursor })
  return result
}

for (const [field, value] of [['realDate', null], ['realDate', '2026-04-31'], ['time', '18:31:00-private'], ['time', 1831], ['time', '25:00'], ['isNext', null]] as const) {
  test(`Coho day isolation: ${field} ${String(value)} preserves complete month and rejects only bad day`, async () => {
    const f = await fixture(calendar => {
      const punches = calendar.dkList as Record<string, unknown>[]
      punches.find(row => row.date === '2026-04-11')![field] = value
    })
    try {
      await scan(f.service)
      assert.equal(f.calendarCalls(), 1)
      const saved = await f.service.cachedHours('team', '2026-04')
      assert.equal(saved?.days.length, 30)
      const bad = saved!.days[10]!
      assert.equal(bad.state, 'review')
      assert.equal(bad.budget, null)
      assert.equal(bad.remaining, null)
      assert.match(bad.reason, new RegExp(`2026-04-11.*${field}`))
      assert.ok(!bad.reason.includes('private'))
      assert.equal(saved!.days[11]!.state, 'not_required')
      assert.equal(saved!.days[12]!.state, 'missing')
      assert.equal(alignedHoursMonth({ ...saved!, days: saved!.days.map(day => day.state === 'review' ? day : { ...day, existing: day.budget!, remaining: 0, state: day.state === 'not_required' ? 'not_required' : 'covered' }) }), false)
      f.cache.close()
      assert.deepEqual(await new Workbench(f.deps).cachedHours('team', '2026-04'), saved)
      await assert.rejects(f.service.readDay({ team: 'team', date: bad.date }), { code: 'attendance', message: bad.reason })
      const row = { date: bad.date, taskId: 'task', start: '09:00', minutes: 480, description: '虚构任务工作' }
      await assert.rejects(f.service.previewHoursBatch('team', [row]), { code: 'attendance', message: bad.reason })
      const good = await f.service.readDay({ team: 'team', date: '2026-04-13' })
      assert.equal((await f.service.makePreview({ dayId: good.id, allocations: [row] })).budget, 480)
    } finally { await f.close() }
  })
}

test('Coho day isolation: missing outFence remains review, explicitly empty punches remain not required', async () => {
  const f = await fixture(calendar => {
    for (const row of calendar.dkList as Record<string, unknown>[]) if (row.date === '2026-04-11') delete row.outFence
  })
  try {
    await scan(f.service)
    const saved = (await f.service.cachedHours('team', '2026-04'))!
    assert.equal(saved.days[10]!.state, 'review')
    assert.equal(saved.days[10]!.budget, null)
    assert.equal(saved.days[11]!.state, 'not_required')
    assert.equal(saved.days[11]!.budget, 0)
  } finally { await f.close() }
})

for (const broken of ['dateList', 'dkList', 'dateList.date', 'dkList.date', 'row']) {
  test(`Coho day isolation: global ${broken} fails closed without publishing`, async () => {
    const f = await fixture(calendar => {
      if (broken === 'dateList' || broken === 'dkList') calendar[broken] = null
      else if (broken === 'dateList.date') (calendar.dateList as Record<string, unknown>[])[0]!.date = null
      else if (broken === 'dkList.date') (calendar.dkList as Record<string, unknown>[])[20]!.date = null
      else (calendar.dkList as unknown[])[20] = null
    })
    try {
      await assert.rejects(scan(f.service), { code: 'schema' })
      assert.equal(await f.service.cachedHours('team', '2026-04'), null)
    } finally { await f.close() }
  })
}

for (const failure of ['period', 'network', 'auth', 'http', 'identity', 'pagination']) {
  test(`Coho day isolation: ${failure} is not downgraded to review`, async () => {
    const f = await fixture(undefined, failure)
    try {
      await assert.rejects(scan(f.service), (error: unknown) => {
        const value = error as { code: string; message: string }
        assert.notEqual(value.code, 'attendance')
        assert.notEqual(value.code, 'no_attendance')
        if (failure === 'period') assert.match(value.message, /Coho 考勤期间查询（2026-04-01）.*kqqs/)
        return true
      })
      assert.equal(f.publications(), 0)
      if (failure === 'auth') await assert.rejects(f.service.cachedHours('team', '2026-04'), { code: 'auth' })
      else assert.equal(await f.service.cachedHours('team', '2026-04'), null)
    } finally { await f.close() }
  })
}


test('Coho day isolation: missing requested coverage is review; attributable other-date fields do not poison valid dates', async () => {
  const f = await fixture(calendar => {
    calendar.dateList = (calendar.dateList as Record<string, unknown>[]).filter(row => row.date !== '2026-04-11')
    const punches = calendar.dkList as Record<string, unknown>[]
    punches.push({ date: '2026-03-31', realDate: null, time: null, isNext: null })
  })
  try {
    await scan(f.service)
    const saved = (await f.service.cachedHours('team', '2026-04'))!
    assert.equal(saved.days.length, 30)
    assert.equal(saved.days[10]!.state, 'review')
    assert.match(saved.days[10]!.reason, /2026-04-11.*dateList.*覆盖未知/)
    assert.equal(saved.days[10]!.budget, null)
    assert.equal(saved.days[11]!.state, 'not_required')
    assert.equal(saved.days[12]!.state, 'missing')
    await assert.rejects(f.service.readDay({ team: 'team', date: '2026-04-11' }), { code: 'attendance' })
    assert.equal((await f.service.readDay({ team: 'team', date: '2026-04-13' })).attendance.punches.length, 2)
  } finally { await f.close() }
})

test('Coho day isolation: failed forced structural refresh preserves existing complete SQLite snapshot', async () => {
  let corrupt = false
  const f = await fixture(calendar => { if (corrupt) calendar.dkList = null })
  try {
    await scan(f.service)
    const saved = await f.service.cachedHours('team', '2026-04')
    corrupt = true
    await assert.rejects(scan(f.service), { code: 'schema' })
    assert.equal(f.publications(), 1)
    f.cache.close()
    assert.deepEqual(await new Workbench(f.deps).cachedHours('team', '2026-04'), saved)
  } finally { await f.close() }
})


test('Coho day isolation: empty but well-formed dateList never implies no attendance', async () => {
  const f = await fixture(calendar => { calendar.dateList = []; calendar.dkList = [] })
  try {
    await scan(f.service)
    const saved = (await f.service.cachedHours('team', '2026-04'))!
    assert.equal(saved.days.length, 30)
    assert.ok(saved.days.every(day => day.state === 'review' && day.budget === null))
  } finally { await f.close() }
})

test('Coho day isolation: previous month stays pending until the next 08:00 and refreshes after closing', async t => {
  let now = Date.parse('2026-05-01T07:59:59+08:00')
  t.mock.method(Date, 'now', () => now)
  const f = await fixture()
  try {
    await scan(f.service)
    let saved = (await f.service.cachedHours('team', '2026-04'))!
    assert.equal(saved.days.at(-1)!.state, 'pending')
    assert.equal(saved.days.at(-1)!.remaining, null)
    now = Date.parse('2026-05-01T08:00:00+08:00')
    await scan(f.service)
    saved = (await f.service.cachedHours('team', '2026-04'))!
    assert.equal(saved.days.at(-1)!.state, 'missing')
    assert.equal(saved.days.at(-1)!.remaining, 480)
  } finally { await f.close() }
})

test('Coho next-day label: scan, SQLite and fresh preview normalize without poisoning adjacent dates', async () => {
  const f = await fixture(calendar => {
    const rows = calendar.dkList as Record<string, unknown>[]
    Object.assign(rows.find(row => row.date === '2026-04-11' && row.time === '18:31')!, { time: '次日00:30', isNext: true })
  })
  try {
    await scan(f.service)
    const saved = (await f.service.cachedHours('team', '2026-04'))!
    assert.equal(saved.days[9]!.budget, 480)
    assert.equal(saved.days[10]!.budget, 810)
    assert.deepEqual(saved.days[10]!.attendanceTime, { start: '08:50', end: '00:30', endNextDay: true })
    assert.equal(saved.days[11]!.state, 'not_required')
    f.cache.close()
    assert.deepEqual(await new Workbench(f.deps).cachedHours('team', '2026-04'), saved)
    const day = await f.service.readDay({ team: 'team', date: '2026-04-11' })
    assert.equal(day.attendance.punches[1]!.realDate, '2026-04-12')
    const preview = await f.service.makePreview({ dayId: day.id, allocations: [{ taskId: 'task', start: '09:00', minutes: 810, description: '虚构任务工作' }] })
    assert.equal(preview.budget, 810)
  } finally { await f.close() }
})

for (const change of [
  { time: '次日00:30', isNext: false },
  { time: '次日00:30', isNext: true, realDate: '2026-04-12' },
  { time: '次日24:30', isNext: true },
  { time: '次日00:30-private', isNext: true },
  { time: '次日00:30', isNext: true, outFence: true }
]) {
  test('Coho next-day label: contradictory or malformed fields remain blocked ' + JSON.stringify(change), async () => {
    const f = await fixture(calendar => {
      const rows = calendar.dkList as Record<string, unknown>[]
      Object.assign(rows.find(row => row.date === '2026-04-11' && row.time === '18:31')!, change)
    })
    try {
      await scan(f.service)
      const bad = (await f.service.cachedHours('team', '2026-04'))!.days[10]!
      assert.equal(bad.state, 'review')
      assert.equal(bad.budget, null)
      const row = { date: bad.date, taskId: 'task', start: '09:00', minutes: 480, description: '虚构工作' }
      await assert.rejects(f.service.previewHoursBatch('team', [row]), { code: 'attendance' })
    } finally { await f.close() }
  })
}

test('Coho leave: approved intervals affect scan and fresh preview without double deduction', async () => {
  let minutes = 20
  const f = await fixture(calendar => {
    calendar.workList = [{ date: '2026-04-11', code: 'leave', statusCode: 10, status: '审批通过',
      time: '2026-04-11 10:00:00~2026-04-11 10:' + String(minutes).padStart(2, '0') + ':00' }]
  })
  try {
    await scan(f.service)
    assert.equal((await f.service.cachedHours('team', '2026-04'))!.days[10]!.budget, 450)
    const day = await f.service.readDay({ team: 'team', date: '2026-04-11' })
    const row = { date: day.date, taskId: 'task', start: '09:00', minutes: 450, description: '虚构工作' }
    assert.equal((await f.service.makePreview({ dayId: day.id, allocations: [row] })).budget, 450)
    minutes = 40
    await assert.rejects(f.service.previewHoursBatch('team', [row]), { code: 'budget' })
  } finally { await f.close() }
})

for (const change of [{ statusCode: 0 }, { time: 'bad-private' }, { time: '2026-04-11 11:00:00~2026-04-11 10:00:00' }]) {
  test('Coho leave: uncertain approval or malformed interval stays review ' + JSON.stringify(change), async () => {
    const f = await fixture(calendar => {
      calendar.workList = [{ date: '2026-04-11', code: 'leave', statusCode: 10, status: '审批通过',
        time: '2026-04-11 10:00:00~2026-04-11 10:20:00', ...change }]
    })
    try {
      await scan(f.service)
      const day = (await f.service.cachedHours('team', '2026-04'))!.days[10]!
      assert.equal(day.state, 'review')
      assert.equal(day.budget, null)
      assert.ok(!day.reason.includes('private'))
      await assert.rejects(f.service.readDay({ team: 'team', date: day.date }), { code: 'attendance' })
    } finally { await f.close() }
  })
}

test('Coho leave: approval changes invalidate single and batch confirmations even within same rounded budget', async () => {
  let end = '20'
  const f = await fixture(calendar => {
    calendar.workList = [{ date: '2026-04-11', code: 'leave', statusCode: 10, status: '审批通过',
      time: '2026-04-11 10:00:00~2026-04-11 10:' + end + ':00' }]
  })
  f.deps.writesVerified = true
  const service = new Workbench(f.deps)
  try {
    const day = await service.readDay({ team: 'team', date: '2026-04-11' })
    const row = { date: day.date, taskId: 'task', start: '09:00', minutes: 450, description: '虚构工作' }
    const preview = await service.makePreview({ dayId: day.id, allocations: [row] })
    const batch = await service.previewHoursBatch('team', [row])
    end = '25'
    await assert.rejects(service.submit(preview.id, true), { code: 'stale' })
    const result = await service.submitHoursBatch(batch.id, true, 'team')
    assert.equal(result.rows[0]!.state, 'not_attempted')
    assert.match(result.rows[0]!.message, /考勤或已登记工时变化/)
  } finally { await f.close() }
})

test('Coho leave: missing authoritative workList fails closed without publishing', async () => {
  const f = await fixture(calendar => { delete calendar.workList })
  try {
    await assert.rejects(scan(f.service), { code: 'schema' })
    assert.equal(f.publications(), 0)
  } finally { await f.close() }
})

test('Coho approved work: no-punch business plus overtime supports scan and preview, changed approval revokes submit', async () => {
  let duration = 13.5
  const f = await fixture(calendar => {
    calendar.dkList = (calendar.dkList as Record<string, unknown>[]).filter(row => row.date !== '2026-04-11')
    const overtime = { date: '2026-04-11', code: 'overtime', statusCode: 10, status: '审批通过',
      time: '2026-04-11 09:00:00~2026-04-12 00:00:00', value: duration }
    calendar.workList = [overtime, { ...overtime }]
  })
  f.deps.writesVerified = true
  const service = new Workbench(f.deps)
  try {
    await scan(service)
    const saved = (await service.cachedHours('team', '2026-04'))!.days[10]!
    assert.equal(saved.budget, 810)
    assert.equal(saved.attendanceTime, undefined)
    const day = await service.readDay({ team: 'team', date: saved.date })
    assert.equal(day.attendance.approved!.length, 1)
    const preview = await service.makePreview({ dayId: day.id, allocations: [{ taskId: 'task', start: '09:00', minutes: 30, description: '虚构补充' }] })
    duration = 13
    await assert.rejects(service.submit(preview.id, true), { code: 'stale' })
  } finally { await f.close() }
})

test('Coho approved work: overnight business travel counts dated eight hours plus separate overtime', async () => {
  const f = await fixture(calendar => {
    calendar.dkList = (calendar.dkList as Record<string, unknown>[]).filter(row => row.date !== '2026-04-11')
    calendar.workList = [
      { date: '2026-04-11', code: 'business', statusCode: 10, status: '审批通过', time: '2026-04-11 09:00:00~2026-04-12 09:00:00', value: 8 },
      { date: '2026-04-11', code: 'overtime', statusCode: 10, status: '审批通过', time: '2026-04-11 22:00:00~2026-04-11 23:30:00', value: 1.5 }
    ]
  })
  try {
    await scan(f.service)
    assert.equal((await f.service.cachedHours('team', '2026-04'))!.days[10]!.budget, 570)
  } finally { await f.close() }
})
