import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FocusedProject, focusKey, type WorkspaceContext } from '../src/adapters/focused-project.ts'
import { OrcaCli } from '../src/adapters/orca-cli.ts'
import { filterProject, projectMappingKey } from '../src/domain/project-mapping.ts'
const local = { id: 'local', name: 'SidusLinkPro' }
const source = { id: 'ones', name: 'Sidus Link Pro 【IPOT】' }
const context: WorkspaceContext = { displayName: 'Custom task label', branch: 'feature/fix', terminals: [] }
const listing = { truncated: false, workspaces: [{ id: 'identity:fixture', name: context.displayName, branch: context.branch }] }
class FakeCli extends OrcaCli {
  calls: string[] = []
  async projectForWorkspace(id: string) { this.calls.push(id); return local }
}
test('project follow: focused worktree resolves owning project, not workspace label or plugin cwd', async () => {
  const cli = new FakeCli()
  const reader = new FocusedProject({ context: async () => context, list: async () => listing }, cli)
  assert.deepEqual(await reader.current(), local)
  assert.deepEqual(cli.calls, ['identity:fixture'])
})
test('project follow: absent, ambiguous, truncated or unavailable context returns all', async () => {
  const cli = new FakeCli()
  for (const list of [{ ...listing, truncated: true }, { ...listing, workspaces: [...listing.workspaces, ...listing.workspaces] }, { ...listing, workspaces: [] }])
    assert.equal(await new FocusedProject({ context: async () => context, list: async () => list }, cli).current(), null)
  assert.equal(await new FocusedProject({ context: async () => null, list: async () => listing }, cli).current(), null)
  assert.equal(await new FocusedProject({ context: async () => { throw Error('permission denied') }, list: async () => listing }, cli).current(), null)
  assert.deepEqual(cli.calls, [])
})
test('project follow: changed focus during lookup rejects old result; terminal identity changes are detected but titles are ignored', async () => {
  let calls = 0
  const reader = new FocusedProject({ context: async () => ++calls === 1 ? context : { ...context, displayName: 'Other' }, list: async () => listing }, new FakeCli())
  assert.equal(await reader.current(), null)
  assert.notEqual(focusKey(context), focusKey({ ...context, terminals: [{ id: 'new-terminal' }] }))
  assert.equal(focusKey({ ...context, terminals: [{ id: 't', title: 'old' }] }), focusKey({ ...context, terminals: [{ id: 't', title: 'new' }] }))
})
test('project follow: CLI resolves project by returned stable id and forwards exact selector', async () => {
  const calls: string[][] = []
  const cli = new OrcaCli(async args => { calls.push(args); return args[0] === 'worktree' ? { worktree: { projectId: local.id } } : { projects: [{ id: local.id, displayName: local.name }] } })
  assert.deepEqual(await cli.projectForWorkspace('identity:fixture'), local)
  assert.deepEqual(calls[0], ['worktree', 'show', '--worktree', 'identity:fixture'])
})
test('project follow: name fallback, no match and ambiguous names', () => {
  assert.deepEqual(filterProject(local, [source], []), source)
  assert.equal(filterProject(null, [source], []), null)
  assert.equal(filterProject({ ...local, name: 'Other' }, [source], []), null)
  assert.equal(filterProject(local, [source, { ...source, id: 'duplicate' }], []), null)
})
test('project follow: saved bindings beat names; foreign binding never silently remaps', () => {
  const renamed = { id: 'renamed', name: 'New Name' }
  assert.deepEqual(filterProject(local, [source, renamed], [{ sourceProjectId: renamed.id, targetProjectId: local.id }]), renamed)
  assert.equal(filterProject(local, [source], [{ sourceProjectId: source.id, targetProjectId: 'another-local' }]), null)
  assert.equal(filterProject(local, [source, renamed], [source, renamed].map(p => ({ sourceProjectId: p.id, targetProjectId: local.id }))), null)
  assert.notEqual(projectMappingKey('user-team-A', source.id), projectMappingKey('user-team-B', source.id))
})

test('project follow: terminal ownership disambiguates identical main workspaces', async () => {
  const cli = new OrcaCli(async args => {
    if (args[0] === 'terminal') return { terminals: [{ handle: 'term-focused', executionHostId: 'local', worktreeId: 'repo::/main' }], truncated: false }
    if (args[0] === 'worktree') { assert.equal(args[3], 'id:repo::/main'); return { worktree: { projectId: local.id } } }
    return { projects: [{ id: local.id, displayName: local.name }] }
  })
  const same = { displayName: 'main', branch: 'main', terminals: [{ id: 'term-focused' }] }
  const reader = new FocusedProject({ context: async () => same, list: async () => ({ truncated: false, workspaces: ['a', 'b'].map(id => ({ id, name: 'main', branch: 'main' })) }) }, cli)
  assert.deepEqual(await reader.current(), local)
  assert.equal(await cli.projectForTerminals(['missing']), null)
  const truncated = new OrcaCli(async () => ({ terminals: [], truncated: true }))
  assert.equal(await truncated.projectForTerminals(['term-focused']), null)
  for (const terminals of [
    [{ handle: 'term-focused', executionHostId: 'ssh:remote', worktreeId: 'repo::/main' }],
    [{ handle: 'term-focused', executionHostId: 'local' }],
    [{ handle: 'term-focused', executionHostId: 'local', worktreeId: 'a' }, { handle: 'other', executionHostId: 'local', worktreeId: 'b' }]
  ]) {
    const invalid = new OrcaCli(async args => { assert.equal(args[0], 'terminal'); return { terminals, truncated: false } })
    assert.equal(await invalid.projectForTerminals(terminals.map(t => t.handle)), null)
  }
})
