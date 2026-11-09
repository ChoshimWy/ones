import type { OrcaWorkerApi } from 'orca/worker'
import { FocusedProject } from '../../src/adapters/focused-project.ts'
import { filterProject } from '../../src/domain/project-mapping.ts'
import type { Option } from '../../src/domain/model.ts'
// Loaded only as main in an isolated fixture by the test driver. No credentials or launch API.
export default function activate(orca: OrcaWorkerApi) {
  const focused = new FocusedProject({ context: () => orca.host.call('workspace.readContext'), list: () => orca.host.call('workspace.list') })
  orca.panels.handle('fixture.follow-debug', async () => {
    const read = async (method: 'workspace.readContext' | 'workspace.list') => { try { return await orca.host.call(method) } catch (error) { return { error: String(error) } } }
    return { ok: true, value: { context: await read('workspace.readContext'), list: await read('workspace.list') } }
  })
  const projects = [{ id: 'ones-sidus', name: 'Sidus Link Pro 【IPOT】' }, { id: 'ones-other', name: 'OtherProject' }]
  let hold = false, requests = 0, completed = 0
  const releases: (() => void)[] = []
  orca.panels.handle('status', () => ({ ok: true as const, value: { ones: { connected: true, label: '虚构用户' }, coho: { connected: false, label: '未登录' }, teams: [{ id: 'team', name: '虚构团队' }], writeEnabled: false, blockers: [] } }))
  orca.panels.handle('bugs.list', () => ({ ok: true as const, value: { items: projects.map((project, i) => ({ id: `bug-${i}`, number: i + 1, name: `虚构 ${project.name} 缺陷`, project, issueType: { id: 'bug', name: '缺陷' }, status: { id: 'pending', name: '待处理' } })), nextCursor: null } }))
  orca.panels.handle('bugs.projectFilter', async input => {
    requests++
    const localProject = await focused.current()
    const value = { ok: true as const, value: { localProject, project: filterProject(localProject, input.projects as Option[], []) } }
    if (hold) {
      hold = false
      return new Promise<typeof value>(resolve => releases.push(() => { completed++; resolve(value) }))
    }
    completed++
    return value
  })
  orca.panels.handle('fixture.follow-hold', () => { hold = true; return { ok: true as const, value: true } })
  orca.panels.handle('fixture.follow-release', () => { releases.splice(0).forEach(release => release()); return { ok: true as const, value: true } })
  orca.panels.handle('fixture.follow-stats', () => ({ ok: true as const, value: { requests, completed, pending: releases.length } }))
}
