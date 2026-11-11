import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HoursView } from '../src/html/hours.ts'
import type { WorkbenchUI } from '../src/html/panel.ts'

const day = { date: '2026-02-01', existing: 0, budget: 480, remaining: 480, state: 'missing', reason: 'fixture' }
function viewFixture() {
  const app = { team: 'fixture-team', status: { identity: 'owner', ones: { connected: true }, coho: { connected: true } },
    invalidateDay() { view.clearDay() }, render() {} }
  const view = new HoursView(app as unknown as WorkbenchUI)
  const internal = view as unknown as { active: boolean; scan: typeof day[] | null; cached: boolean; loadError: string; calendarMonth: string; loading: boolean; loadMonth(month: string): Promise<void> }
  internal.active = true
  return { app, view, internal }
}
for (const failSecond of [false, true]) test('hours month transport: ' + (failSecond ? 'failed refresh retains cached snapshot' : 'cache first and JSON-safe continuation'), async () => {
  const previous = globalThis.orca
  const calls: Record<string, unknown>[] = []
  const { internal } = viewFixture()
  globalThis.orca = { host: { call: async (method: string, params: Record<string, unknown>) => {
    assert.equal(method, 'plugin.request')
    assert.deepEqual(structuredClone(params), JSON.parse(JSON.stringify(params)))
    if (params.name === 'hours.cache') return { output: { ok: true, value: { month: '2026-02', days: [{ ...day, existing: 60 }], savedAt: 1 } } }
    assert.equal(params.name, 'hours.scan')
    assert.equal(internal.scan?.[0]?.existing, 60)
    const input = params.input as Record<string, unknown>
    assert.equal(input.month, '2026-02')
    calls.push(input)
    if (calls.length === 1) assert.equal(Object.hasOwn(input, 'cursor'), false)
    else {
      assert.equal(input.cursor, 'next-fixture')
      if (failSecond) throw Error('fixture transport unavailable')
    }
    return { output: { ok: true, value: { days: [{ ...day, date: '2026-02-0' + calls.length }], total: 2, nextCursor: calls.length === 1 ? 'next-fixture' : null, savedAt: calls.length === 1 ? null : 2 } } }
  } } } as unknown as typeof globalThis.orca
  try {
    await internal.loadMonth('2026-02')
    assert.equal(calls.length, 2)
    if (failSecond) {
      assert.equal(internal.scan?.length, 1)
      assert.equal(internal.scan?.[0]?.existing, 60)
      assert.match(internal.loadError, /缓存/)
    } else {
      assert.equal(internal.loadError, '')
      assert.deepEqual(internal.scan?.map(d => d.date), ['2026-02-01', '2026-02-02'])
    }
    assert.equal(internal.loading, false)
  } finally { globalThis.orca = previous }
})

test('hours month transport: late prior month and leave cannot publish stale data', async () => {
  const previous = globalThis.orca
  const { internal, view } = viewFixture()
  let release!: (value: unknown) => void
  let reached!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  globalThis.orca = { host: { call: async (_: string, params: { name: string; input: { month: string } }) => {
    if (params.name === 'hours.cache') return { output: { ok: true, value: null } }
    if (params.input.month === '2026-01') { reached(); return await new Promise(resolve => { release = resolve }) }
    return { output: { ok: true, value: { days: [day], nextCursor: null, total: 1, savedAt: 1 } } }
  } } } as unknown as typeof globalThis.orca
  try {
    const old = internal.loadMonth('2026-01')
    await started
    await internal.loadMonth('2026-02')
    release({ output: { ok: true, value: { days: [{ ...day, date: '2026-01-01' }], nextCursor: null, total: 1, savedAt: 1 } } })
    await old
    assert.equal(internal.calendarMonth, '2026-02')
    assert.equal(internal.scan?.[0]?.date, day.date)
    view.leave()
    assert.equal(internal.active, false)
  } finally { globalThis.orca = previous }
})
