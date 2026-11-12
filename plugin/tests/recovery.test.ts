import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Workbench } from '../src/service.ts'
import { Submission, createReceipt, parseReceipts, type WriteIntent } from '../src/domain/submission.ts'
import { startSeconds } from '../src/domain/attendance.ts'

test('records removal: UI, protocol and worker expose no record reconciliation or description updates', async () => {
  for (const file of ['worker.ts', 'protocol.ts', 'html/panel.ts']) {
    const source = await readFile(new URL('../src/' + file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /recovery\.(list|preview|confirm)|hours\.(describe|list)|RecordsView|记录核对/)
  }
  for (const name of ['pending', 'previewRecovery', 'confirmRecovery', 'describe', 'worklogs']) {
    assert.equal(name in Workbench.prototype, false)
  }
  assert.doesNotMatch(await readFile(new URL('../src/adapters/ones.ts', import.meta.url), 'utf8'), /updateManhour|PluginDescribe/)
})

test('records removal: existing uncertain receipts still fence writes across restart without deletion', async () => {
  const intent: WriteIntent = { scope: 'account', date: '2026-01-05', task: 'task', owner: 'owner', hours: 50000, startTime: startSeconds('2026-01-05', '09:00'), description: '合成工时' }
  for (const kind of ['add', 'describe'] as const) {
    const receipt = createReceipt(intent, 'old', [])
    // 已有持久账本不迁移、不删除；历史描述操作也必须继续阻断未知结果。
    if (kind === 'describe') Object.assign(receipt, { kind, key: 'original', protectedDayHash: 'a'.repeat(64) })
    receipt.state = 'unknown'
    const saved = structuredClone([receipt])
    let writes = 0
    const ledger = { load: async () => parseReceipts(structuredClone(saved)), save: async () => { throw Error('Must not alter unresolved receipts') } }
    const writer = { add: async () => { writes++; return 'new' }, get: async () => { throw Error('No readback expected') } }
    for (let restart = 0; restart < 2; restart++) {
      await assert.rejects(new Submission(ledger, writer).add(intent, 'new-attempt', []), { code: 'unknown' })
    }
    assert.equal(writes, 0)
    assert.deepEqual(saved, [receipt])
  }
})
