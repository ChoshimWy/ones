import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Workbench, type Store, type Vault } from '../src/service.ts'
import { createReceipt, type Receipt, type WriteIntent } from '../src/domain/submission.ts'
import { startSeconds } from '../src/domain/attendance.ts'
import { ONES, type Fetcher } from '../src/adapters/http.ts'
import type { Worklog } from '../src/domain/model.ts'

const date = '2026-01-05'
const team = 'team-fixture'
const owner = 'owner-fixture'
const scope = createHash('sha256').update(JSON.stringify([ONES, team, owner])).digest('hex')
const row = (key = 'record-fixture', description = ''): Worklog => ({ key, task: 'task-fixture', owner, type: 'recorded', startTime: startSeconds(date, '09:00'), hours: 800000, description })
const intent: WriteIntent = { scope, date, task: 'task-fixture', owner, hours: 800000, startTime: startSeconds(date, '09:00'), description: '虚构工作说明' }
const asGraph = (item: Worklog) => ({ ...item, owner: { uuid: item.owner }, task: { uuid: item.task } })
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
function fixture() {
  const data = new Map<string, unknown>()
  data.set('session.ones', JSON.stringify({ token: 'fixture-access', userId: owner, label: '虚构用户', teams: [{ id: team, name: '虚构团队' }], expiresAt: Date.now() + 600000 }))
  let rows: Worklog[] = [row()]
  let mutationCount = 0
  let loseReply = false
  let alterProtected = false
  let onRead: (() => Promise<void>) | undefined
  let failSave = false
  const store: Store = {
    get: async key => structuredClone(data.get(key) ?? null),
    set: async (key, value) => { if (failSave && key === 'receipts') throw Error('fixture disk failure'); data.set(key, structuredClone(value)) },
    delete: async key => { data.delete(key) }
  }
  const fetcher: Fetcher = async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/users/me')) return json({ uuid: owner })
    if (path.endsWith('/info')) return json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
    const { query, variables } = JSON.parse(String(init.body))
    if (query.includes('PluginDescribe')) {
      mutationCount++
      assert.deepEqual(Object.keys(variables).sort(), ['description', 'key', 'mode'])
      const actual = rows.find(item => item.key === variables.key)!
      actual.description = variables.description
      if (alterProtected) actual.hours += 50000
      if (loseReply) throw Error('fixture response lost after remote success')
      return json({ data: { updateManhour: { key: actual.key } } })
    }
    assert.ok(!query.includes('mutation'), 'No add or delete is allowed in reconciliation')
    if (query.includes('PluginReadback')) return json({ data: { manhours: rows.filter(item => item.key === variables.filter.key_equal).map(asGraph) } })
    if (onRead) { const action = onRead; onRead = undefined; await action() }
    return json({ data: { buckets: [{ manhours: rows.map(asGraph), pageInfo: { hasNextPage: false, endCursor: '', unstable: false } }] } })
  }
  const service = (writesVerified = true) => new Workbench({ store, vault: store as Vault, protection: async () => true, fetcher, writesVerified })
  return {
    data, service, store, get rows() { return rows }, set rows(value) { rows = structuredClone(value) },
    get writes() { return mutationCount }, set lost(value: boolean) { loseReply = value }, set corrupted(value: boolean) { alterProtected = value },
    set nextRead(action: () => Promise<void>) { onRead = action }, set diskFails(value: boolean) { failSave = value }
  }
}
function unresolved(before: Worklog[] = []): Receipt {
  const receipt = createReceipt(intent, 'fingerprint-fixture', before)
  receipt.state = 'unknown'
  return receipt
}
const describe = (service: Workbench, key = 'record-fixture') => service.describe({ team, date, key, description: '补充的虚构说明', confirmed: true })

test('TC-PLUGIN-004-recovery: restart excludes prior matches and unlocks only after reread', async () => {
  const env = fixture()
  const previous = row('old-record', intent.description)
  const written = row('new-record', intent.description)
  const blank = row('blank-record')
  const receipt = unresolved([previous, blank])
  env.rows = [previous, blank, written]
  env.data.set('receipts', [receipt])
  assert.ok(!JSON.stringify(receipt).includes(intent.description), 'Raw description is not stored in receipts')
  const service = env.service()
  assert.equal((await service.pending(team)).length, 1)
  await assert.rejects(() => describe(service, blank.key))
  assert.equal(env.writes, 0)
  const preview = await service.previewRecovery(team, receipt.id)
  assert.equal(preview.matchCount, 1)
  assert.equal(preview.candidate?.key, written.key)
  await assert.rejects(() => service.confirmRecovery(preview.id!, false))
  assert.equal(env.writes, 0)
  await service.confirmRecovery(preview.id!, true)
  assert.equal(env.writes, 0)
  assert.equal((await service.pending(team)).length, 0)
  await assert.rejects(() => service.confirmRecovery(preview.id!, true))
  await describe(service, blank.key)
  assert.equal(env.writes, 1)
  assert.deepEqual(env.rows.find(item => item.key === written.key), written)
  assert.equal(env.rows.find(item => item.key === blank.key)?.description, '补充的虚构说明')
})

test('TC-PLUGIN-004-recovery: zero, ambiguous and changed candidates remain fenced', async () => {
  const env = fixture()
  const receipt = unresolved()
  env.data.set('receipts', [receipt])
  const service = env.service()
  const zero = await service.previewRecovery(team, receipt.id)
  assert.equal(zero.id, null)
  env.rows = [row('match-1', intent.description), row('match-2', intent.description)]
  const ambiguous = await service.previewRecovery(team, receipt.id)
  assert.equal(ambiguous.matchCount, 2)
  assert.equal(ambiguous.id, null)
  env.rows = [row('match-1', intent.description)]
  const unique = await service.previewRecovery(team, receipt.id)
  env.rows = [row('match-1', '另一个客户端修改的说明')]
  await assert.rejects(() => service.confirmRecovery(unique.id!, true))
  assert.equal((await service.pending(team)).length, 1)
  await assert.rejects(() => describe(service, 'match-1'))
  assert.equal(env.writes, 0)
})

test('TC-PLUGIN-004-recovery: changed identity and malformed ledger cannot release a fence', async () => {
  const env = fixture()
  const receipt = unresolved()
  env.rows = [row('match-1', intent.description)]
  env.data.set('receipts', [receipt])
  const service = env.service()
  await assert.rejects(() => service.previewRecovery('another-team', receipt.id))
  env.nextRead = () => service.logout('ones').then(() => {})
  await assert.rejects(() => service.previewRecovery(team, receipt.id))
  assert.equal((env.data.get('receipts') as Receipt[])[0].state, 'unknown')
  assert.equal(env.writes, 0)
  const other = fixture()
  other.data.set('receipts', [{ ...receipt, intent: undefined }])
  await assert.rejects(() => other.service().pending(team))
})

test('TC-PLUGIN-004-description: lost reply recovers original record with zero additional mutations', async () => {
  const env = fixture()
  const original = structuredClone(env.rows[0])
  env.lost = true
  const service = env.service()
  await assert.rejects(() => describe(service))
  assert.equal(env.writes, 1)
  await assert.rejects(() => describe(service))
  assert.equal(env.writes, 1)
  const restarted = env.service()
  const pending = await restarted.pending(team)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, 'describe')
  const preview = await restarted.previewRecovery(team, pending[0].id)
  assert.equal(preview.matchCount, 1)
  await restarted.confirmRecovery(preview.id!, true)
  assert.equal(env.writes, 1)
  assert.deepEqual({ ...env.rows[0], description: original.description }, original)
  assert.equal((await restarted.pending(team)).length, 0)
})

test('TC-PLUGIN-004-description: protected field drift and persistence failure are fail closed', async () => {
  const changed = fixture()
  changed.corrupted = true
  const service = changed.service()
  await assert.rejects(() => describe(service))
  const pending = await service.pending(team)
  assert.equal(pending.length, 1)
  assert.equal((await service.previewRecovery(team, pending[0].id)).id, null)
  await assert.rejects(() => describe(service))
  assert.equal(changed.writes, 1)
  const disk = fixture()
  disk.diskFails = true
  await assert.rejects(() => describe(disk.service()))
  assert.equal(disk.writes, 0)
  const readonly = fixture()
  await assert.rejects(() => describe(readonly.service(false)))
  assert.equal(readonly.writes, 0)
})
