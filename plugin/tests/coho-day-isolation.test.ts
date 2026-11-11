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
        const dates = monthDates('2026-04')
        const calendar = { dateList: dates.map(date => ({ date })), dkList: dates.filter(date => date !== '2026-04-12').flatMap(date => ['08:50', '18:31'].map(time => ({ date, realDate: date, time, isNext: false, outFence: false }))) }
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
