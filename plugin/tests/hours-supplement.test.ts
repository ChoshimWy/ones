import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HoursView } from '../src/html/hours.ts'
import type { WorkbenchUI } from '../src/html/panel.ts'

test('hours supplement: reuse exact description, fill only deficit, require choice and discard late date', async () => {
  const previous = globalThis.orca
  let resolveDay: ((value: unknown) => void) | undefined
  let delayed = false
  let descriptions = ['原任务描述']
  const date = '2026-04-17'
  let pending: Promise<void> = Promise.resolve()
  const app = { team: 'team', status: { identity: 'owner' }, render() {}, invalidate() {},
    invalidateDay() { view.clearDay() },
    run(action: (signal: AbortSignal) => Promise<unknown>, accept: (value: unknown) => void) {
      pending = action(new AbortController().signal).then(accept)
      return pending
    } }
  const view = new HoursView(app as unknown as WorkbenchUI)
  const state = view as unknown as {
    loadDay(prefill: boolean): void; durationHours: string; selected: string; description: string;
    supplementOptions: unknown[]; applySupplement(value: string): void; day: unknown
  }
  globalThis.orca = { host: { call: async (_: string, params: { name: string }) => {
    if (params.name === 'tasks.brief') return { output: { ok: true, value: { task: { id: 'task', name: '普通任务', issueType: { name: '任务' } } } } }
    assert.equal(params.name, 'day.read')
    const day = { id: 'day', date, existing: 960, attendance: { date, fetchedAt: 1,
      punches: [{ date, realDate: date, time: '08:49', isNext: false, outFence: false },
        { date, realDate: '2026-04-18', time: '03:34', isNext: true, outFence: false }] },
      worklogs: descriptions.map(description => ({ task: 'task', description, startTime: Date.parse(date + 'T09:00:00+08:00') / 1000 })) }
    const result = { output: { ok: true, value: day } }
    if (delayed) return await new Promise(resolve => { resolveDay = () => resolve(result) })
    return result
  } } } as unknown as typeof globalThis.orca
  try {
    view.date = date
    state.loadDay(true)
    await pending
    assert.equal(state.durationHours, '0.5')
    assert.equal(state.selected, 'task')
    assert.equal(state.description, '原任务描述')
    descriptions = ['原任务描述', '另一项工作']
    state.loadDay(true)
    await pending
    assert.equal(state.selected, '')
    assert.equal(state.description, '')
    assert.equal(state.supplementOptions.length, 2)
    state.applySupplement('1')
    assert.equal(state.description, '另一项工作')
    delayed = true
    state.loadDay(true)
    view.changeDate('2026-04-18')
    resolveDay!(undefined)
    await pending
    assert.equal(state.day, null)
    assert.equal(state.description, '')
  } finally { globalThis.orca = previous }
})

for (const scenario of ['success', 'validation-failure', 'unknown-submit', 'date-change', 'mismatched-preview']) {
  test('hours supplement direct: ' + scenario + ' freezes click and never duplicates submission', async () => {
    const previous = globalThis.orca
    const calls: { name: string; input: Record<string, unknown> }[] = []
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    let pending: Promise<void> = Promise.resolve()
    const app = {
      team: 'team', status: { identity: 'owner', writeEnabled: true }, busy: false, error: '', info: '',
      render() {}, invalidate() {},
      run(action: (signal: AbortSignal) => Promise<unknown>, accept: (value: unknown) => void) {
        this.busy = true
        pending = action(new AbortController().signal).then(accept).catch(error => { this.error = error.message }).finally(() => { this.busy = false })
        return pending
      },
      invalidateDay() { view.clearDay() }
    }
    const view = new HoursView(app as unknown as WorkbenchUI)
    const internal = view as unknown as {
      day: unknown; selected: string; durationHours: string; start: string; description: string;
      supplement(): void; submitting: boolean
    }
    const date = '2026-04-17'
    view.date = date
    internal.day = { id: 'day', date, existing: 450, worklogs: [], attendance: { date, fetchedAt: 1,
      punches: ['08:50', '18:30'].map(time => ({ date, realDate: date, time, isNext: false, outFence: false })) } }
    internal.selected = 'task'
    internal.start = '09:00'
    internal.durationHours = '0.5'
    internal.description = '点击时的描述'
    globalThis.orca = { host: { call: async (_: string, params: { name: string; input: Record<string, unknown> }) => {
      calls.push(structuredClone(params))
      if (params.name === 'hours.preview') {
        await hold
        if (scenario === 'validation-failure') return { output: { ok: false, error: { code: 'budget', message: '额度变化' } } }
        return { output: { ok: true, value: { id: 'preview', date, rows: [{ taskId: 'task',
          start: '09:00', minutes: scenario === 'mismatched-preview' ? 60 : 30, description: '点击时的描述' }] } } }
      }
      assert.equal(params.name, 'hours.submit')
      assert.deepEqual(params.input, { previewId: 'preview', confirmed: true })
      if (scenario === 'unknown-submit') throw Error('lost reply')
      return { output: { ok: true, value: { count: 1 } } }
    } } } as unknown as typeof globalThis.orca
    try {
      internal.supplement()
      internal.supplement() // rapid repeated click while validation is running
      assert.equal(calls.length, 1)
      internal.description = '请求中修改的描述'
      if (scenario === 'date-change') view.changeDate('2026-04-18')
      release()
      await pending
      await new Promise(resolve => setImmediate(resolve))
      const sends = calls.filter(call => call.name === 'hours.submit')
      assert.equal(sends.length, ['success', 'unknown-submit'].includes(scenario) ? 1 : 0)
      assert.deepEqual(calls[0]!.input, { dayId: 'day', allocations: [{ taskId: 'task', start: '09:00', minutes: 30, description: '点击时的描述' }] })
      assert.equal(internal.submitting, false)
      if (scenario === 'success') assert.match(app.info, /已补充工时并回读确认 1 笔/)
      if (scenario === 'unknown-submit' || scenario === 'success') {
        assert.equal(internal.day, null)
        internal.supplement()
        assert.equal(calls.length, 2) // no replay after consumed/unknown confirmation
      }
      if (scenario === 'validation-failure') assert.ok(internal.day) // editable, no write attempted
    } finally { release(); globalThis.orca = previous }
  })
}

test('hours supplement direct: empty description and excess minutes never reach the server', async () => {
  const app = { team: 'team', status: { writeEnabled: true }, busy: false, error: '', render() {},
    run() { throw Error('must not call server') } }
  const view = new HoursView(app as unknown as WorkbenchUI)
  const internal = view as unknown as { day: unknown; selected: string; durationHours: string; start: string; description: string; supplement(): void }
  const date = '2026-04-17'
  internal.day = { id: 'day', date, existing: 450, attendance: { date, fetchedAt: 1,
    punches: ['08:50','18:30'].map(time => ({ date, realDate: date, time, isNext: false, outFence: false })) } }
  internal.selected = 'task'
  internal.start = '09:00'
  internal.durationHours = '0.5'
  internal.description = ''
  internal.supplement()
  assert.match(app.error, /描述/)
  internal.description = '虚构补充'
  internal.durationHours = '1'
  internal.supplement()
  assert.match(app.error, /超过考勤剩余额度/)
})
