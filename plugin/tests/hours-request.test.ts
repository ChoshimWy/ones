import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HoursView } from '../src/html/hours.ts'
import type { WorkbenchUI } from '../src/html/panel.ts'

// Exercise the real view -> request -> host boundary, not just the service method.
// Structured-clone transport preserves undefined object values, unlike JSON.stringify.
for (const failSecond of [false, true]) test('hours scan transport: ' + (failSecond ? 'failed continuation cannot publish partial results' : 'initial and continuation payloads are plain JSON'), async () => {
  const previous = globalThis.orca
  const calls: Record<string, unknown>[] = []
  let pending: Promise<void> | undefined
  const app = {
    team: 'fixture-team', info: '', error: '',
    invalidateDay() { view.clearDay() },
    render() {},
    run(action: (signal: AbortSignal) => Promise<unknown>, accept: (result: unknown) => void) {
      pending = action(new AbortController().signal).then(accept).catch(error => { app.error = error.message })
      return pending
    }
  }
  const view = new HoursView(app as unknown as WorkbenchUI)
  const internal = view as unknown as { mapping: boolean; scan: unknown; scanMissing(): void }
  internal.mapping = true
  globalThis.orca = { host: { call: async (method: string, params: Record<string, unknown>) => {
    assert.equal(method, 'plugin.request')
    assert.equal(params.name, 'hours.scan')
    // Every own property must survive a JSON round trip; rejects cursor: undefined.
    assert.deepEqual(structuredClone(params), JSON.parse(JSON.stringify(params)))
    const input = params.input as Record<string, unknown>
    calls.push(input)
    if (calls.length === 1) assert.equal(Object.hasOwn(input, 'cursor'), false)
    else {
      assert.equal(input.cursor, 'next-fixture')
      if (failSecond) throw Error('fixture transport unavailable')
    }
    return { output: { ok: true, value: {
      days: [{ date: calls.length === 1 ? '2026-11-09' : '2026-11-10', existing: 0, budget: 480, remaining: 480, state: 'missing', reason: 'fixture' }],
      total: 2, nextCursor: calls.length === 1 ? 'next-fixture' : null
    } } }
  } } } as unknown as typeof globalThis.orca
  try {
    internal.scanMissing()
    await pending
    assert.equal(calls.length, 2)
    if (failSecond) {
      assert.equal(internal.scan, null)
      assert.ok(app.error)
      assert.ok(!app.info.includes('扫描完成'))
    } else {
      assert.equal(app.error, '')
      assert.deepEqual((internal.scan as { date: string }[]).map(d => d.date), ['2026-11-10', '2026-11-09'])
    }
  } finally { globalThis.orca = previous }
})
