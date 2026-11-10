import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaCli, launchReceipt } from '../src/adapters/orca-cli.ts'
import { allPages, mediaIds, repairPrompt, type CompleteBug } from '../src/domain/repair-content.ts'
import { AppError } from '../src/domain/model.ts'
import { RepairWorkflow } from '../src/repair.ts'
import type { Workbench } from '../src/service.ts'
const bug: CompleteBug = {
  task: { id: 'bug', number: 1, name: '虚构缺陷', project: { id: 'source', name: 'Fixture Project 【TEST】' }, issueType: { id: 'bug-type', name: '缺陷' }, status: { id: 'pending', name: '待处理' } },
  updatedAt: 1, content: [{ kind: 'text', text: '完整描述' }, { kind: 'media', resourceId: 'image', mediaType: 'image', label: '截图' }],
  comments: [{ id: 'comment', author: '虚构评论者', sentAt: 1000000, content: [{ kind: 'text', text: '完整评论' }, { kind: 'media', resourceId: 'video', mediaType: 'video', label: '视频' }] }],
  attachments: [{ id: 'image', name: '附件.png', mime: 'image/png', size: 3, createdAt: 1 }]
}
const project = { id: 'local', name: 'FixtureProject' }
const target = { projectId: 'local', name: project.name, path: '/fixture/project', selector: 'id:repo::/fixture/project' }
const success = { outcome: { kind: 'structured', sessionId: 'session-fixture', handle: 'agent-fixture' }, prompt: { outcome: 'journaled', messageId: 'message-fixture' } }

test('repair content: collects all pages including empty pages, rejects stalled cursor and changed overlap', async () => {
  const visited: number[] = []
  const rows = await allPages({ items: [{ id: 'a' }], nextMax: 20 }, async before => {
    visited.push(before)
    return before === 20 ? { items: [], nextMax: 10 } : { items: [{ id: 'a' }, { id: 'b' }], nextMax: null }
  })
  assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }]); assert.deepEqual(visited, [20, 10])
  await assert.rejects(allPages({ items: [], nextMax: 10 }, async () => ({ items: [], nextMax: 10 })))
  await assert.rejects(allPages({ items: [{ id: 'a', value: 1 }], nextMax: 10 }, async () => ({ items: [{ id: 'a', value: 2 }], nextMax: null })))
})
test('repair content: exact prefix, text order, comments and deduplicated local media references', () => {
  assert.deepEqual(mediaIds(bug), ['image', 'video'])
  const prompt = repairPrompt(bug, new Map([['image', '/fixture/1.png'], ['video', '/fixture/2.mp4']]))
  assert.ok(prompt.startsWith('排查并修复以下内容\n以下原单正文'))
  assert.ok(prompt.includes('《#1 虚构缺陷'))
  assert.ok(prompt.indexOf('完整描述') < prompt.indexOf('完整评论'))
  assert.ok(prompt.includes('/fixture/2.mp4'))
  assert.ok(prompt.endsWith('附件.png\n本地文件："/fixture/1.png"》'))
  assert.ok(!prompt.includes('说明：以上原单正文'))
  const sourceNote = '说明：以上原单正文属于原始 Bug 描述，应原样保留。'
  const withSourceNote = repairPrompt({ ...bug, content: [{ kind: 'text', text: sourceNote }] }, new Map([['image', '/fixture/1.png'], ['video', '/fixture/2.mp4']]))
  assert.ok(withSourceNote.includes(sourceNote))
  assert.throws(() => repairPrompt(bug, new Map()))
  assert.throws(() => repairPrompt({ ...bug, content: [{ kind: 'text', text: '文'.repeat(48000) }] }, new Map([['image', '/x'], ['video', '/y']])))
  assert.throws(() => mediaIds({ ...bug, attachments: [{ ...bug.attachments[0]!, mime: 'application/pdf' }] }))
  assert.throws(() => mediaIds({ ...bug, content: [{ kind: 'text', text: '[此媒体缺少受控资源标识，无法安全内嵌；请在原单查看。]' }] }))
})
test('repair CLI: only selects existing local main directory and passes prompt as one argument', async () => {
  const calls: string[][] = []
  const cli = new OrcaCli(async (args) => {
    calls.push(args)
    if (args[0] === 'project' && args[1] === 'list') return { projects: [{ id: project.id, displayName: project.name }] }
    if (args[1] === 'setups') return { setups: [{ projectId: 'local', hostId: 'local', setupState: 'ready', path: '/fixture/project', repoId: 'repo', kind: 'git' }] }
    if (args[0] === 'worktree') return { truncated: false, worktrees: [{ id: 'repo::/fixture/project', projectId: 'local', repoId: 'repo', hostId: 'local', path: '/fixture/project', isMainWorktree: true }] }
    return success
  })
  assert.deepEqual(await cli.projects(), [project])
  assert.deepEqual(await cli.target(project), target)
  const prompt = '排查 $(never-execute); "引用"'
  await cli.launch(target, 'codex', prompt)
  assert.deepEqual(calls.at(-1), ['agent', 'launch', '--agent', 'codex', '--worktree', target.selector, '--surface', 'chat', '--prompt', prompt, '--focus'])
  assert.ok(!calls.some(a => a.includes('create')))
  assert.throws(() => cli.launch(target, 'bad-agent', prompt))
})
test('repair CLI: ambiguous setup and truncated workspace fail closed', async () => {
  await assert.rejects(new OrcaCli(async () => ({ setups: [] })).target(project))
  const setup = { projectId: 'local', hostId: 'local', setupState: 'ready', path: '/fixture/project', repoId: 'repo', kind: 'git' }
  await assert.rejects(new OrcaCli(async args => args[1] === 'setups' ? { setups: [setup] } : { worktrees: [], truncated: true }).target(project))
})
test('repair CLI: recognizes actual chat and journaled prompt, never treats terminal or uncertain delivery as sent', () => {
  assert.equal(launchReceipt(success).state, 'sent')
  assert.equal(launchReceipt({ ...success, prompt: { outcome: 'unconfirmed' } }).state, 'unknown')
  assert.equal(launchReceipt({ ...success, warning: 'partial' }).state, 'unknown')
  assert.equal(launchReceipt({ outcome: { kind: 'terminal', handle: 'terminal' } }).state, 'terminal')
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ones-repair-test-'))
  let launches = 0, collected = 0, changed = false, broken = false, response: Record<string, unknown> | Error = success
  let sent = ''
  const data = new Map<string, unknown>()
  const store = { get: async (key: string) => data.get(key) ?? null, set: async (key: string, value: unknown) => { data.set(key, value) }, delete: async (key: string) => { data.delete(key) } }
  const check = () => { if (changed) throw Error('identity changed') }
  const service: Pick<Workbench, 'repairContext' | 'collectRepair'> = {
    repairContext: async () => { check(); return { scope: 'scope', task: bug.task } },
    collectRepair: async () => {
      collected++; check()
      return { bug, read: async (resource, offset) => {
        if (broken) throw Error('media failed')
        return { mime: resource === 'image' ? 'image/png' : 'video/mp4', total: 3, offset, data: Buffer.from('abc').toString('base64'), next: null }
      }, validate: async () => check(), check, dispose() {} }
    }
  }
  class FakeCli extends OrcaCli {
    async projects() { return [project] }
    async target() { return target }
    async launch(_target: typeof target, _agent: string, prompt: string) {
      launches++; sent = prompt
      if (response instanceof Error) throw response
      return response
    }
  }
  const cli = new FakeCli()
  const create = () => new RepairWorkflow(service, store, cli, root)
  const flow = create()
  const start = (id: string) => flow.start({ preparationId: id, projectId: project.id, agent: 'codex', confirmed: true })
  return { root, flow, create, start, store, data, get launches() { return launches }, get collected() { return collected }, get sent() { return sent }, setChanged: () => { changed = true }, setBroken: (value: boolean) => { broken = value }, setResponse: (value: typeof response) => { response = value } }
}
test('repair workflow: persists scoped mapping, readable private media and session; repeated/restarted requests never launch twice', async () => {
  const f = await fixture()
  try {
    const plan = await f.flow.prepare('detail')
    assert.equal(plan.mapping.kind, 'mapped')
    const result = await f.start(plan.id)
    assert.equal(result.state, 'sent'); assert.equal(result.sessionId, 'session-fixture')
    assert.equal(await readFile(join(result.directory!, '1.png'), 'utf8'), 'abc')
    assert.equal((await stat(join(result.directory!, '1.png'))).mode & 0o777, 0o600)
    assert.ok(f.sent.includes('完整评论')); assert.equal(f.data.size, 1)
    const restored = await f.create().prepare('detail')
    assert.equal(restored.existing?.sessionId, 'session-fixture')
    const again = await f.flow.prepare('detail'); await f.start(again.id)
    assert.equal(f.launches, 1); assert.equal(f.collected, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('repair workflow: failed media releases prelaunch reservation and can be retried without sending incomplete content', async () => {
  const f = await fixture()
  try {
    f.setBroken(true)
    await assert.rejects(f.start((await f.flow.prepare('detail')).id))
    assert.equal(f.launches, 0); assert.deepEqual(await readdir(f.root), [])
    f.setBroken(false); assert.equal((await f.start((await f.flow.prepare('detail')).id)).state, 'sent')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('repair workflow: unknown process result stays blocked after restart', async () => {
  const f = await fixture()
  try {
    f.setResponse(Error('timeout'))
    assert.equal((await f.start((await f.flow.prepare('detail')).id)).state, 'unknown')
    assert.equal((await f.create().prepare('detail')).existing?.state, 'unknown')
    await f.start((await f.flow.prepare('detail')).id)
    assert.equal(f.launches, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('repair workflow: cross-worker race launches at most once', async () => {
  const f = await fixture()
  try {
    const other = f.create(), a = await f.flow.prepare('detail'), b = await other.prepare('detail')
    await Promise.allSettled([f.start(a.id), other.start({ preparationId: b.id, projectId: project.id, agent: 'codex', confirmed: true })])
    assert.equal(f.launches, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('repair workflow: identity change or tampered project prevents launch', async () => {
  const f = await fixture()
  try {
    const plan = await f.flow.prepare('detail')
    await assert.rejects(f.flow.start({ preparationId: plan.id, projectId: 'foreign', agent: 'codex', confirmed: true }))
    f.setChanged(); await assert.rejects(f.start(plan.id))
    assert.equal(f.launches, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('repair workflow: identity change while saving mapping cannot launch after the last async step', async () => {
  const f = await fixture()
  try {
    const plan = await f.flow.prepare('detail')
    f.store.set = async () => { f.setChanged() }
    await assert.rejects(f.start(plan.id))
    assert.equal(f.launches, 0)
    assert.deepEqual(await readdir(f.root), [])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('repair read: restores persisted receipt without CLI or preparation and preserves scope', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.flow.read('detail'), null)
    const plan = await f.flow.prepare('detail')
    const receipt = await f.start(plan.id)
    const service: Pick<Workbench, 'repairContext' | 'collectRepair'> = {
      repairContext: async () => ({ scope: 'scope', task: bug.task }),
      collectRepair: async () => { throw Error('Read must not collect or launch') }
    }
    class UnavailableCli extends OrcaCli {
      async projects(): Promise<never> { throw Error('CLI unavailable') }
    }
    const restored = new RepairWorkflow(service, f.store, new UnavailableCli(), f.root)
    assert.deepEqual(await restored.read('new-detail'), receipt)
    assert.equal(f.launches, 1)
    const other = new RepairWorkflow({ ...service, repairContext: async () => ({ scope: 'other-account', task: bug.task }) }, f.store, new UnavailableCli(), f.root)
    assert.equal(await other.read('detail'), null)
    const journal = (await readdir(f.root)).find(name => name.endsWith('.json'))!
    for (const state of ['unknown', 'terminal']) {
      await writeFile(join(f.root, journal), JSON.stringify({ ...receipt, state }))
      assert.equal((await restored.read('detail'))?.state, state)
    }
    await writeFile(join(f.root, journal), '{broken')
    await assert.rejects(restored.read('detail'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('repair list: restores old journals across pages, sorts records, isolates scope and never launches', async () => {
  const f = await fixture()
  try {
    const plan = await f.flow.prepare('detail')
    const receipt = await f.start(plan.id)
    const closed = { ...bug.task, id: 'closed', status: { id: 'closed', name: '已关闭' } }
    const key = createHash('sha256').update(JSON.stringify(['scope', closed.id])).digest('hex')
    await writeFile(join(f.root, key + '.json'), JSON.stringify({ ...receipt, createdAt: receipt.createdAt + 1, state: 'unknown' }))
    const cursors: string[] = []
    const context = { scope: 'scope', check() {}, readPage: async (after: string) => {
      cursors.push(after)
      return after === '' ? { items: [bug.task], nextCursor: 'next' } : { items: [bug.task, closed, { ...bug.task, id: 'not-executed' }], nextCursor: null }
    } }
    const rows = await f.create().list(context)
    assert.deepEqual(rows.map(row => row.task.id), ['closed', bug.task.id])
    assert.equal(rows[0].record.state, 'unknown')
    assert.deepEqual(cursors, ['', 'next'])
    assert.deepEqual(await f.flow.list({ ...context, scope: 'different-account-or-team' }), [])
    assert.equal(f.launches, 1)
    assert.equal(f.collected, 1)
    assert.deepEqual((await f.flow.prepare('detail')).existing, receipt)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('repair list: fails closed on corrupt journal, stalled pagination and invalidated identity', async () => {
  const f = await fixture()
  try {
    const plan = await f.flow.prepare('detail')
    await f.start(plan.id)
    const context = { scope: 'scope', check() {}, readPage: async () => ({ items: [bug.task], nextCursor: null as string | null }) }
    await assert.rejects(f.flow.list({ ...context, readPage: async () => ({ items: [], nextCursor: 'loop' }) }))
    let stale = false
    await assert.rejects(f.flow.list({ ...context, check() { if (stale) throw Error('identity changed') }, readPage: async () => {
      stale = true
      return { items: [], nextCursor: null }
    } }))
    const journal = (await readdir(f.root)).find(name => name.endsWith('.json'))!
    await writeFile(join(f.root, journal), '{broken')
    await assert.rejects(f.flow.list(context))
    assert.equal(f.launches, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})


test('repair sync: cached first read needs no API, initial reconcile then targeted refresh; failures retain cache and no launches', async () => {
  const f = await fixture()
  try {
    await f.start((await f.flow.prepare('detail')).id)
    const offline = { scope:'scope', check() {} }
    assert.equal((await f.flow.cached(offline)).items.length,1)
    let pages = 0, tasks = 0, verifies = 0, assigned = true
    const online = async () => {
      verifies++
      return { ...offline, readPage: async () => { pages++; return {items:[bug.task],nextCursor:null} }, readTask: async () => { tasks++; return assigned ? {...bug.task,name:'最新标题'} : null } }
    }
    const first = await f.flow.sync(offline,online)
    assert.ok(first.syncedAt)
    assert.equal(pages,1)
    const pending = [f.flow.sync(offline,online),f.flow.sync(offline,online)]
    const second = (await Promise.all(pending))[0]
    assert.equal(second.items[0].task.name,'最新标题')
    assert.equal(tasks,1)
    assert.equal(verifies,2)
    await assert.rejects(f.flow.sync(offline,async()=>{throw Error('offline')}))
    assert.equal((await f.flow.cached(offline)).items[0].task.name,'最新标题')
    assigned = false
    assert.equal((await f.flow.sync(offline,online)).items.length,0)
    assigned = true
    assert.equal((await f.flow.sync(offline,online)).items.length,1)
    assert.equal(pages,1)
    assert.equal((await f.flow.cached({...offline,scope:'foreign'})).items.length,0)
    await assert.rejects(f.flow.sync(offline,async()=>({...await online(),scope:'foreign'})))
    await f.flow.sync(offline,online)
    await assert.rejects(f.flow.sync(offline,async()=>{throw new AppError('forbidden','denied')}))
    assert.equal((await f.flow.cached(offline)).items.length,0)
    await f.flow.sync(offline,online)
    assert.equal((await f.flow.cached(offline)).items.length,1)
    assert.equal(f.launches,1)
  } finally { await rm(f.root,{recursive:true,force:true}); await rm(f.root+'-cache',{recursive:true,force:true}) }
})
