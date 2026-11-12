import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HoursView } from '../src/html/hours.ts'
import type { WorkbenchUI } from '../src/html/panel.ts'

for (const scenario of ['success', 'partial', 'validation-failure', 'unknown-submit', 'changed-form', 'identity-change', 'mismatched-preview']) {
  test('hours batch direct: ' + scenario + ' uses clicked hours and never blindly replays', async () => {
    const previous = globalThis.orca
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    let pending = Promise.resolve()
    const calls: { name: string; input: any }[] = []
    const app = { team: 'team', status: { identity: 'owner', writeEnabled: true }, busy: false, error: '',
      render() {}, invalidate() {},
      run(action: (signal: AbortSignal) => Promise<any>, accept: (value: any) => void) {
        this.busy = true
        pending = action(new AbortController().signal).then(accept).catch(error => { this.error = error.message }).finally(() => { this.busy = false })
        return pending
      } }
    const view = new HoursView(app as unknown as WorkbenchUI)
    const state = view as unknown as {
      batchRows: Map<string, { hours: string; start: string }>; batchTask: string; batchDescription: string;
      submitBatch(): void; invalidateBatch(): void; submitting: boolean; batchResult: any
    }
    state.batchRows.set('2026-04-17', { hours: '0.5', start: '09:00' })
    state.batchRows.set('2026-04-18', { hours: '1.5', start: '09:00' })
    state.batchTask = 'task'
    state.batchDescription = '点击时描述'
    globalThis.orca = { host: { call: async (_: string, params: { name: string; input: any }) => {
      calls.push(structuredClone(params))
      if (params.name === 'hours.batchPreview') {
        await hold
        if (scenario === 'validation-failure') return { output: { ok: false, error: { code: 'budget', message: '额度变化' } } }
        const rows = structuredClone(params.input.rows)
        if (scenario === 'mismatched-preview') rows[0].minutes = 60
        return { output: { ok: true, value: { id: 'preview', rows } } }
      }
      assert.equal(params.name, 'hours.batchSubmit')
      assert.deepEqual(params.input, { team: 'team', previewId: 'preview', confirmed: true })
      if (scenario === 'unknown-submit') throw Error('lost reply')
      return { output: { ok: true, value: { rows: ['2026-04-17','2026-04-18'].map((date, index) =>
        ({ date, state: scenario === 'partial' && index === 1 ? 'not_attempted' : 'verified', message: '' })) } } }
    } } } as unknown as typeof globalThis.orca
    try {
      state.submitBatch()
      state.submitBatch()
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].input.rows.map((row: any) => row.minutes), [30,90])
      if (scenario === 'changed-form') { state.batchDescription = '新描述'; state.invalidateBatch() }
      if (scenario === 'identity-change') app.status.identity = 'other'
      release()
      await pending
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(calls.filter(call => call.name === 'hours.batchSubmit').length, ['success','partial','unknown-submit'].includes(scenario) ? 1 : 0)
      assert.equal(state.submitting, false)
      if (scenario === 'partial') {
        assert.deepEqual([...state.batchRows.keys()], ['2026-04-18'])
        assert.equal(state.batchResult.rows[1].state, 'not_attempted')
      } else if (scenario === 'success' || scenario === 'unknown-submit') {
        assert.equal(state.batchRows.size, 0)
        state.submitBatch()
        assert.equal(calls.length, 2)
      } else assert.equal(state.batchRows.size, 2)
    } finally { release(); globalThis.orca = previous }
  })
}
