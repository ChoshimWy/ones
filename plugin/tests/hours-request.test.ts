import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HoursView } from '../src/html/hours.ts'
import type { WorkbenchUI } from '../src/html/panel.ts'
import { recentHoursMonths } from '../src/domain/hours-year.ts'
import { monthDates } from '../src/domain/missing-hours.ts'
import type { HoursMonth } from '../src/hours-cache.ts'

/// 只替换 host transport，真实 HoursView 负责队列、代次与缓存选择。
function fixture() {
  const app = { team: 'team', status: { identity: 'owner', ones: { connected: true }, coho: { connected: true } }, busy: false,
    invalidateDay() { view.clearDay() }, render() {} }
  const view = new HoursView(app as unknown as WorkbenchUI)
  const internal = view as unknown as { active: boolean; scan: HoursMonth['days'] | null; loadError: string; calendarMonth: string; loading: boolean; pumping: boolean; queue: string[]; scanningMonth: string; months: Map<string, HoursMonth>; loadMonth(month: string, force?: boolean): Promise<void> }
  return { app, view, internal }
}
const months = recentHoursMonths()
const snapshot = (month: string, covered = false): HoursMonth => ({ month, savedAt: 1, days: monthDates(month).map(date => ({ date, existing: covered ? 480 : 0, budget: 480, remaining: covered ? 0 : 480, state: covered ? 'covered' : 'missing', reason: 'fixture' })) })
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(predicate(), 'async state settled')
}
const answer = (value: unknown) => ({ output: { ok: true, value } })

test('hours year transport: twelve-month bootstrap skips balanced history and keeps task queries separate', async () => {
  const previous = globalThis.orca
  const f = fixture()
  const scans: string[] = []
  globalThis.orca = { host: { call: async (_: string, params: { name: string; input: { month: string } }) => {
    assert.deepEqual(structuredClone(params), JSON.parse(JSON.stringify(params)))
    if (params.name === 'hours.yearCache') return answer([snapshot(months[1]!, true)])
    if (params.name === 'hours.tasksCache' || params.name === 'hours.batchResult') return answer(null)
    if (params.name === 'hours.tasksSync') return answer({ typeId: 'ordinary', items: [], savedAt: 1 })
    if (params.name === 'hours.scan') {
      scans.push(params.input.month)
      const value = snapshot(params.input.month)
      return answer({ days: value.days, nextCursor: null, total: value.days.length, savedAt: 2 })
    }
    throw Error('unexpected request')
  } } } as unknown as typeof globalThis.orca
  try {
    f.view.enter()
    await wait(() => f.internal.months.size === 12 && !f.internal.pumping)
    assert.equal(scans.length, 11)
    assert.equal(scans[0], months[0])
    assert.ok(!scans.includes(months[1]!))
    assert.equal(f.app.busy, false)
    await f.internal.loadMonth(months[1]!)
    assert.equal(scans.length, 11)
    await f.internal.loadMonth(months[1]!, true)
    await wait(() => !f.internal.pumping)
    assert.equal(scans.at(-1), months[1])
  } finally { f.view.leave(); globalThis.orca = previous }
})

test('hours year transport: month switch uses cache during scan; failed background result never replaces it', async () => {
  const previous = globalThis.orca
  const f = fixture()
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const scans: string[] = []
  globalThis.orca = { host: { call: async (_: string, params: { name: string; input: { month: string } }) => {
    if (params.name === 'hours.yearCache') return answer(months.map(month => snapshot(month)))
    if (params.name === 'hours.tasksCache' || params.name === 'hours.batchResult') return answer(null)
    if (params.name === 'hours.tasksSync') return answer({ typeId: 'ordinary', items: [], savedAt: 1 })
    if (params.name === 'hours.scan') {
      scans.push(params.input.month)
      if (scans.length === 1) await hold
      if (params.input.month === months[1]) throw Error('offline')
      const value = snapshot(params.input.month, true)
      return answer({ days: value.days, nextCursor: null, total: value.days.length, savedAt: 2 })
    }
    throw Error('unexpected request')
  } } } as unknown as typeof globalThis.orca
  try {
    f.view.enter()
    await wait(() => scans.length === 1)
    await f.internal.loadMonth(months[1]!)
    assert.equal(f.internal.calendarMonth, months[1])
    assert.equal(f.internal.scan?.[0]?.existing, 0)
    assert.equal(f.app.busy, false)
    release()
    await wait(() => !f.internal.pumping)
    assert.equal(scans[1], months[1])
    assert.equal(f.internal.calendarMonth, months[1])
    assert.equal(f.internal.scan?.[0]?.existing, 0)
    assert.match(f.internal.loadError, /保留本地/)
  } finally { release(); f.view.leave(); globalThis.orca = previous }
})

test('hours year transport: leaving cancels lifetime and late response cannot publish another identity', async () => {
  const previous = globalThis.orca
  const f = fixture()
  let release!: (value: unknown) => void
  let reached = false
  globalThis.orca = { host: { call: async (_: string, params: { name: string }) => {
    if (params.name === 'hours.yearCache') return answer([])
    if (params.name === 'hours.tasksCache' || params.name === 'hours.batchResult') return answer(null)
    if (params.name === 'hours.tasksSync') return answer({ typeId: 'ordinary', items: [], savedAt: 1 })
    reached = true
    return await new Promise(resolve => { release = resolve })
  } } } as unknown as typeof globalThis.orca
  try {
    f.view.enter()
    await wait(() => reached)
    f.view.leave()
    f.app.status.identity = 'different-owner'
    release(answer({ days: snapshot(months[0]!).days, nextCursor: null, total: 1, savedAt: 2 }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.internal.months.size, 0)
    assert.equal(f.internal.active, false)
    assert.equal(f.internal.loading, false)
  } finally { f.view.leave(); globalThis.orca = previous }
})

test('hours year transport: forced write refresh queues after the same active scan fails', async () => {
  const previous = globalThis.orca
  const f = fixture()
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let scans = 0
  globalThis.orca = { host: { call: async (_: string, params: { name: string; input: { month: string; force?: boolean } }) => {
    if (params.name === 'hours.yearCache') return answer(months.map(month => snapshot(month, month !== months[0])))
    if (params.name === 'hours.tasksCache' || params.name === 'hours.batchResult') return answer(null)
    if (params.name === 'hours.tasksSync') return answer({ typeId: 'ordinary', items: [], savedAt: 1 })
    if (params.name === 'hours.scan') {
      scans++
      if (scans === 1) { await hold; throw Error('old scan invalidated by write') }
      assert.equal(params.input.force, true)
      const value = snapshot(params.input.month, true)
      return answer({ days: value.days, nextCursor: null, total: value.days.length, savedAt: 2 })
    }
    throw Error('unexpected request')
  } } } as unknown as typeof globalThis.orca
  try {
    f.view.enter()
    await wait(() => scans === 1)
    await f.internal.loadMonth(months[0]!, true)
    release()
    await wait(() => !f.internal.pumping)
    assert.equal(scans, 2)
    assert.equal(f.internal.scan?.[0]?.existing, 480)
    assert.equal(f.internal.loadError, '')
  } finally { release(); f.view.leave(); globalThis.orca = previous }
})
