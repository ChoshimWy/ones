import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { AppError, record, requireThat, text, type Option } from '../domain/model.ts'

export type LocalTarget = { projectId: string; name: string; path: string; selector: string }
export type CliRunner = (args: string[], cwd?: string) => Promise<Record<string, unknown>>
// Pinned to the executable verified on this installation; never search PATH or invoke a shell.
export const ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
export const runCli: CliRunner = (args, cwd) => new Promise((resolve, reject) => {
  execFile(ORCA_CLI, [...args, '--json'], { cwd, timeout: 90000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
    try {
      requireThat((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT', 'cli-unavailable', '未找到已配置的 Orca CLI；请安装匹配版本，未启动会话。')
      // Do not reflect stderr/argv: they may contain Bug text.
      const envelope = record(JSON.parse(stdout))
      requireThat(!error && envelope.ok === true, 'cli', 'Orca CLI 未完成操作；若已开始启动，请先核实会话，勿重新发送。')
      resolve(record(envelope.result))
    } catch (failure) {
      reject(failure instanceof AppError ? failure : new AppError('cli', 'Orca CLI 返回不可用；若已开始启动，请到项目核实，勿重复发送。'))
    }
  })
})
export class OrcaCli {
  constructor(private run: CliRunner = runCli) {}
  async projects(): Promise<Option[]> {
    const result = await this.run(['project', 'list'])
    requireThat(Array.isArray(result.projects) && !result.truncated, 'partial', 'Orca 项目列表不完整。')
    return result.projects.map(value => {
      const p = record(value)
      return { id: text(p.id, 1000), name: text(p.displayName, 500) }
    })
  }
  async projectForWorkspace(workspaceId: string): Promise<Option | null> {
    // Host workspace.list supplies an identity selector or an exact legacy/folder id.
    const selector = workspaceId.startsWith('identity:') ? workspaceId : `id:${workspaceId}`
    const shown = await this.run(['worktree', 'show', '--worktree', selector])
    const workspace = record(shown.worktree)
    if (typeof workspace.projectId !== 'string') return null
    return (await this.projects()).find(p => p.id === workspace.projectId) ?? null
  }
  async projectForTerminals(ids: string[]): Promise<Option | null> {
    if (!ids.length) return null
    // No --worktree means inventory, not the caller cwd. Discard output previews immediately.
    const result = await this.run(['terminal', 'list', '--limit', '10000'])
    if (!Array.isArray(result.terminals) || result.truncated !== false) return null
    const rows = result.terminals.map(record).filter(t => ids.includes(String(t.handle)))
    if (rows.length !== ids.length || new Set(rows.map(t => t.handle)).size !== ids.length) return null
    if (rows.some(t => t.executionHostId !== 'local' || typeof t.worktreeId !== 'string')) return null
    const owners = new Set(rows.map(t => String(t.worktreeId)))
    return owners.size === 1 ? this.projectForWorkspace([...owners][0]!) : null
  }
  async target(project: Option): Promise<LocalTarget> {
    const result = await this.run(['project', 'setups', '--project', project.id, '--host', 'local'])
    requireThat(Array.isArray(result.setups) && !result.truncated, 'partial', 'Orca 项目目录信息不完整。')
    const candidates = result.setups.map(record).filter(s => s.projectId === project.id && s.hostId === 'local' && s.setupState === 'ready')
    requireThat(candidates.length === 1, 'target', '该项目没有唯一就绪的本地目录；请先在 Orca 中配置项目。')
    const setup = candidates[0]!, path = text(setup.path, 4096), repoId = text(setup.repoId, 1000)
    requireThat(isAbsolute(path), 'target', '项目目录必须是绝对路径。')
    if (setup.kind === 'folder') {
      // Native folder selectors are accepted by agent launch; no folder is created here.
      return { projectId: project.id, name: project.name, path, selector: `folder:${repoId}` }
    }
    requireThat(setup.kind === 'git', 'target', '暂不支持此项目类型。')
    const listing = await this.run(['worktree', 'list', '--repo', `id:${repoId}`, '--limit', '10000'])
    requireThat(Array.isArray(listing.worktrees) && listing.truncated === false, 'partial', '已有工作区列表不完整。')
    const workspaces = listing.worktrees.map(record).filter(w => w.projectId === project.id && w.repoId === repoId && w.hostId === 'local' && w.path === path && w.isMainWorktree === true && w.isArchived !== true)
    requireThat(workspaces.length === 1, 'target', '未找到唯一的已有项目主目录；不会创建工作区或选择其它任务分支。')
    return { projectId: project.id, name: project.name, path, selector: `id:${text(workspaces[0]!.id, 6000)}` }
  }
  launch(target: LocalTarget, agent: string, prompt: string): Promise<Record<string, unknown>> {
    requireThat(agent === 'codex' || agent === 'claude', 'input', '请选择支持的聊天 Agent。')
    return this.run(['agent', 'launch', '--agent', agent, '--worktree', target.selector, '--surface', 'chat', '--prompt', prompt, '--focus'], target.path)
  }
}
export type LaunchReceipt = { state: 'sent' | 'unknown' | 'terminal'; sessionId?: string; handle?: string }
export function launchReceipt(result: Record<string, unknown>): LaunchReceipt {
  // agent launch returns AgentLaunchResult directly (worktree create nests it in launch).
  const launch = result.launch ? record(result.launch) : result
  const outcome = record(launch.outcome)
  const handle = typeof outcome.handle === 'string' ? outcome.handle : undefined
  if (outcome.kind === 'terminal') return { state: 'terminal', ...(handle ? { handle } : {}) }
  requireThat(outcome.kind === 'structured', 'cli', '未取得聊天创建回执。')
  const sessionId = text(outcome.sessionId, 1000)
  const prompt = launch.prompt ? record(launch.prompt) : {}
  return { state: prompt.outcome === 'journaled' && typeof prompt.messageId === 'string' && !launch.warning ? 'sent' : 'unknown', sessionId, ...(handle ? { handle } : {}) }
}
