import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatusWorkflow, StatusJournal } from '../src/status-update.ts'
import { OnesTransitions, commentHTML, transitionIntent } from '../src/adapters/ones-transitions.ts'
import { Transport, ONES } from '../src/adapters/http.ts'
import { Workbench } from '../src/service.ts'

/// 虚构实例数据只描述已核实的线格式，不含真实业务标识或凭证。
async function fixture(t: { after(fn: () => Promise<void>): void }, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'ones-status-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const task = { id: 'bug', number: 1, name: '虚构缺陷', project: { id: 'project', name: '项目' }, issueType: { id: 'bug-type', name: '缺陷' }, status: { id: 'pending', name: '待处理' } }
  const session = { userId: 'owner', token: 'fictional-token', label: '虚构用户', teams: [{ id: 'team', name: '团队' }], expiresAt: Date.now() + 600000 }
  const state = { version: 1, status: 'pending', fields: [{ field_uuid: 'cause', type: 1, value: '' }, { field_uuid: 'version', type: 2, value: '' }], messages: [] as Record<string, unknown>[], denied: false, commentOnly: false, unknownField: false, failWrite: '', failRead: false, stale: false, storeFails: false, permission: true, updatePermission: true, writes: [] as Record<string, unknown>[], hold: undefined as (() => Promise<void>) | undefined }
  const fields = [{ field_uuid: 'cause', type: 1, required: true, default_value: null }, { field_uuid: 'version', type: 2, required: false, default_value: null }, { field_uuid: 'tf-comment', type: -1, required: false, default_value: '<p>模板</p>' }]
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fictional-token')
    if (path.endsWith('/new_transit')) {
      const body = JSON.parse(String(init?.body)); state.writes.push(body)
      assert.deepEqual(body.manhours, []); assert.deepEqual(body.resource_uuids, [])
      await state.hold?.()
      if (state.failWrite === '500') return Response.json({}, { status: 500 })
      if (state.failWrite === '403') return Response.json({}, { status: 403 })
      state.status = 'done'; state.version++; state.fields = state.fields.map(field => body.field_values.find((update: { field_uuid: string }) => update.field_uuid === field.field_uuid) ?? field)
      state.messages.push({ ...body.discussion, from: 'owner', type: 'discussion', ref_id: 'bug', ref_type: 'task', send_time: 100, rich_text: '' })
      if (state.failWrite === 'lost') throw Error('Lost response')
      return Response.json({ async_token: 'async' })
    }
    if (path.endsWith('/transition_async_status')) return Response.json({ status: 'none' })
    if (path.endsWith('/info')) {
      if (state.failRead && state.writes.length) return Response.json({}, { status: 500 })
      return Response.json({ uuid: 'bug', project_uuid: 'project', issue_type_uuid: 'bug-type', issue_type_scope_uuid: 'scope', status_uuid: state.status, server_update_stamp: state.version, summary: task.name, desc_rich: '<p>原始描述</p>', desc: '原始描述', field_values: state.fields })
    }
    if (path.endsWith('/messages')) return Response.json({ messages: state.messages, has_next: false })
    if (path.endsWith('/transitions')) return Response.json({ transitions: state.denied ? [] : [{ uuid: 'fix', name: '修复' }] })
    if (path.endsWith('/stamps/data')) return Response.json({ transition: { transitions: [{ uuid: 'fix', name: '修复', project_uuid: 'project', issue_type_uuid: 'bug-type', issue_type_scope_uuid: 'scope', start_status_uuid: state.status, end_status_uuid: 'done', fields: [...(state.commentOnly ? [] : fields), ...(state.unknownField ? [{ field_uuid: 'hours', type: 9, required: true }] : [])], condition: null, trigger: null, post_function: [] }] } })
    if (path.endsWith('/fields')) return Response.json({ fields: [{ uuid: 'cause', name: '根因', type: 1, fixed: false, options: [{ uuid: 'logic', value: '逻辑问题' }] }, { uuid: 'version', name: '解决版本', type: 2, fixed: false, options: null }] })
    if (path.endsWith('/field_configs')) return Response.json({ field_configs: fields.slice(0, 2).map(f => ({ ...f, project_uuid: 'project', issue_type_uuid: 'bug-type', issue_type_scope_uuid: 'scope', option_configs: null })) })
    if (path.endsWith('/task_statuses')) return Response.json({ task_statuses: [{ uuid: 'pending', name: '待处理' }, { uuid: 'done', name: '已修复' }] })
    if (path.endsWith('/evaluated_permissions')) return Response.json({ tasks: { bug: { view_tasks: true, transit_tasks: state.permission, update_tasks: state.updatePermission } } })
    if (path.endsWith('/users/me')) return Response.json({ uuid: 'owner' })
    if (path.endsWith('/attachments')) return Response.json({ attachments: [], has_next: false })
    if (path.endsWith('/issue_types')) return Response.json({ issue_types: [{ uuid: 'bug-type', name: '缺陷', built_in: true, type: 0, detail_type: 3, default_configs: { default_task_status_configs: [{ status_uuid: 'pending' }] } }] })
    if (path.endsWith('/items/graphql')) {
      const row = { uuid: task.id, number: task.number, name: task.name, project: { uuid: task.project.id, name: task.project.name }, issueType: { uuid: task.issueType.id, name: task.issueType.name }, status: { uuid: state.status, name: state.status === 'done' ? '已修复' : '待处理' } }
      return Response.json({ data: String(init?.body).includes('PluginTaskPage') ? { buckets: [{ tasks: [row], pageInfo: { unstable: false, hasNextPage: false } }] } : { tasks: [row] } })
    }
    throw Error('Unexpected fixture route')
  }
  const adapter = new OnesTransitions(new Transport(ONES, fetcher), session, 'team')
  class Journal extends StatusJournal { async save(value: Parameters<StatusJournal['save']>[0]) { if (state.storeFails) throw Error('Disk failed'); await super.save(value) } }
  const journal = new Journal(root)
  const context = async () => ({ scope: 'scope', task, adapter, check: () => { if (state.stale) throw Error('Context invalidated') } })
  const workflow = new StatusWorkflow(context, journal, enabled)
  const input = { detailId: 'detail', stepId: 'fix', fields: { cause: 'logic', version: 'v-next' }, comment: '根因：逻辑\n验证：Mock 通过，实体设备未测\n未提交、未合并 <script> & "' }
  return { root, task, session, state, adapter, journal, context, workflow, input, fetcher }
}
test('status schema: permission, unknown constraints, required values, enum and escaping', async t => {
  const f = await fixture(t), snapshot = await f.adapter.snapshot(f.task)
  assert.equal(snapshot.steps[0]!.fields[0]!.required, true)
  const intent = transitionIntent(snapshot, f.input, 'comment')
  assert.ok(intent.html !== null)
  assert.equal(intent.html.includes('<script>'), false)
  assert.ok(intent.html.includes('&lt;script&gt;'))
  assert.equal(commentHTML('a\nb'), '<p>a<br>b</p>')
  for (const fields of [{ cause: '', version: '' }, { cause: 'invented', version: '' }, { ...f.input.fields, unauthorized: 'bad' }]) assert.throws(() => transitionIntent(snapshot, { ...f.input, fields }, 'comment'))
  f.state.unknownField = true
  assert.ok((await f.adapter.snapshot(f.task)).steps[0]!.blockers.length)
  await assert.rejects(f.workflow.preview(f.input))
  f.state.unknownField = false
  f.state.updatePermission = false
  assert.ok((await f.adapter.snapshot(f.task)).steps[0]!.blockers.length)
  f.state.permission = false
  await assert.rejects(f.adapter.snapshot(f.task), /权限/)
  assert.equal(f.state.writes.length, 0)
})
test('status success: one write, independent none evidence and immutable Bug description', async t => {
  const f = await fixture(t), preview = await f.workflow.preview(f.input)
  const results = await Promise.allSettled([f.workflow.submit(preview.id, true), f.workflow.submit(preview.id, true)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const operation = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<StatusWorkflow['submit']>>>).value
  assert.equal(operation.state, 'verified'); assert.equal(operation.evidence?.asyncStatus, 'none'); assert.equal(f.state.writes.length, 1)
  assert.match((await f.journal.read('scope', 'bug'))!.intent.commentId!, /^[A-Za-z0-9]{8}$/)
  assert.equal('asyncToken' in operation, false)
  assert.equal('intent' in operation, false)
  assert.deepEqual(Object.keys(f.state.writes[0]!).sort(), ['discussion', 'field_values', 'manhours', 'resource_uuids', 'transition_uuid'])
  assert.equal((await f.journal.read('scope', 'bug'))?.state, 'verified')
})
test('status protections: disk failure, version drift, expired context and capability gate cause zero writes', async t => {
  for (const failure of ['disk', 'version', 'context', 'gate']) {
    const f = await fixture(t, failure !== 'gate'), preview = await f.workflow.preview(f.input)
    if (failure === 'disk') f.state.storeFails = true
    if (failure === 'version') f.state.version++
    if (failure === 'context') f.state.stale = true
    await assert.rejects(f.workflow.submit(preview.id, true)); assert.equal(f.state.writes.length, 0)
  }
})
test('status unknown: 5xx, 403, lost response and 200/readback failure never resend after restart', async t => {
  for (const failure of ['500', '403', 'lost', 'readback']) {
    const f = await fixture(t), preview = await f.workflow.preview(f.input)
    if (failure === 'readback') f.state.failRead = true
    else f.state.failWrite = failure
    const result = await f.workflow.submit(preview.id, true)
    assert.equal(result.state, 'unknown')
    const restored = new StatusWorkflow(f.context, f.journal, true)
    await assert.rejects(restored.preview(f.input), /核实/)
    f.state.failRead = false
    const reconciled = await restored.reconcile('detail', result.id)
    assert.equal(reconciled.state, failure === 'lost' || failure === 'readback' ? 'verified' : 'unknown')
    assert.equal(f.state.writes.length, 1)
  }
})
test('status readback: matching target without own UUID/author/comment/fields remains unknown', async t => {
  const f = await fixture(t), preview = await f.workflow.preview(f.input), result = await f.workflow.submit(preview.id, true)
  for (const property of ['uuid', 'from', 'text', 'ref_id']) {
    const original = f.state.messages[0]![property]; f.state.messages[0]![property] = 'foreign'
    assert.equal((await f.workflow.reconcile('detail', result.id)).state, 'unknown')
    f.state.messages[0]![property] = original
  }
  f.state.messages[0]!.rich_text = (await f.journal.read('scope', 'bug'))!.intent.html
  f.state.messages[0]!.text = 'rendering fallback'
  assert.equal((await f.workflow.reconcile('detail', result.id)).state, 'verified')
  f.state.fields[0]!.value = 'changed'
  assert.equal((await f.workflow.reconcile('detail', result.id)).state, 'unknown')
  assert.equal(f.state.writes.length, 1)
})
test('status cross-worker: active lock blocks second write; closing detail retains first result', async t => {
  const f = await fixture(t), second = new StatusWorkflow(f.context, f.journal, true)
  const p1 = await f.workflow.preview(f.input), p2 = await second.preview(f.input)
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  f.state.hold = async () => { started(); await new Promise<void>(resolve => { release = resolve }) }
  const first = f.workflow.submit(p1.id, true)
  await entered
  await assert.rejects(second.submit(p2.id, true), /状态锁/)
  f.state.stale = true; release()
  await assert.rejects(first)
  assert.equal((await f.journal.read('scope', 'bug'))?.state, 'verified')
  assert.equal(f.state.writes.length, 1)
})
test('status stale crash lock: read-only reconciliation allowed, no automatic unlock or resend', async t => {
  const f = await fixture(t), preview = await f.workflow.preview(f.input), result = await f.workflow.submit(preview.id, true)
  const unlock = await f.journal.lock('scope', 'bug')
  assert.equal((await f.workflow.reconcile('detail', result.id)).state, 'verified')
  assert.equal((await readdir(f.root)).filter(name => name.endsWith('.lock')).length, 1)
  await unlock()
  assert.equal(f.state.writes.length, 1)
})
test('status real Workbench chain: refresh obtains new detail/comments/list, repair context refreshed and hours still gated', async t => {
  const f = await fixture(t), data = new Map<string, unknown>()
  const store = { get: async (k: string) => data.get(k), set: async (k: string, v: unknown) => { data.set(k, v) }, delete: async (k: string) => { data.delete(k) } }
  const service = new Workbench({ store, vault: { get: async () => JSON.stringify(f.session), set: async () => {}, delete: async () => {} }, protection: async () => true, fetcher: f.fetcher })
  const detail = await service.bugDetail('team', 'bug')
  const workflow = new StatusWorkflow(id => service.transitionContext(id), f.journal, true)
  const p = await workflow.preview({ ...f.input, detailId: detail.detailId })
  const result = await workflow.submit(p.id, true)
  assert.equal(result.state, 'verified')
  const fresh = await service.bugDetail('team', 'bug')
  assert.equal(fresh.task.status.id, 'done'); assert.deepEqual(fresh.content, detail.content)
  assert.equal(fresh.comments.items[0]!.id, (await f.journal.read((await service.transitionContext(fresh.detailId)).scope, 'bug'))!.intent.commentId)
  assert.equal((await service.repairContext(fresh.detailId)).task.status.id, 'done')
  assert.equal((await service.bugs('team')).items[0]!.status.id, 'done')
  assert.equal((await service.status()).writeEnabled, false)
  await assert.rejects(workflow.preview({ ...f.input, detailId: detail.detailId }))
})

test('status journal: completed operations archived; unfinished operation cannot be replaced', async t => {
  const f = await fixture(t), preview = await f.workflow.preview(f.input), first = await f.workflow.submit(preview.id, true)
  const unlock = await f.journal.lock('scope', 'bug')
  try { await f.journal.save({ ...(await f.journal.read('scope', 'bug'))!, id: 'second-operation', state: 'unknown' }) } finally { await unlock() }
  const history = (await readdir(f.root)).find(name => name.endsWith('.history.json'))!
  assert.equal(JSON.parse(await readFile(join(f.root, history), 'utf8')).id, first.id)
  const second = new StatusWorkflow(f.context, f.journal, true)
  await assert.rejects(second.preview(f.input))
  assert.equal(f.state.writes.length, 1)
})

test('status comment-only step: empty fields preserve existing values and verify own comment', async t => {
  const f = await fixture(t)
  f.state.commentOnly = true
  const existingFields = structuredClone(f.state.fields)
  const preview = await f.workflow.preview({ ...f.input, fields: {} })
  assert.equal(preview.changes.length, 0)
  const result = await f.workflow.submit(preview.id, true)
  assert.equal(result.state, 'verified')
  assert.deepEqual(f.state.writes[0]!.field_values, [])
  assert.deepEqual(f.state.fields, existingFields)
  assert.equal(f.state.writes.length, 1)
})
