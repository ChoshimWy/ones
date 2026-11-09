import { OrcaCli } from './orca-cli.ts'
import type { Option } from '../domain/model.ts'
export type WorkspaceContext = { displayName: string; branch: string; terminals: { id: string; title?: string }[] } | null
export type WorkspaceListing = { workspaces: { id: string; name: string; branch: string | null }[]; truncated: boolean }
export type FocusHost = { context(): Promise<WorkspaceContext>; list(): Promise<WorkspaceListing> }
export function focusKey(context: WorkspaceContext): string {
  return JSON.stringify(context ? [context.displayName, context.branch, context.terminals.map(t => t.id).sort()] : null)
}
/** Public context deliberately omits workspace ids. Resolve only an unambiguous listed row. */
export class FocusedProject {
  constructor(private host: FocusHost, private cli = new OrcaCli()) {}
  async current(): Promise<Option | null> {
    try {
      const before = await this.host.context()
      if (!before) return null
      const listing = await this.host.list()
      if (listing.truncated) return null
      const matches = listing.workspaces.filter(w => w.name === before.displayName && (w.branch ?? '') === before.branch)
      const project = before.terminals.length
        ? await this.cli.projectForTerminals(before.terminals.map(t => t.id))
        : matches.length === 1 ? await this.cli.projectForWorkspace(matches[0]!.id) : null
      return focusKey(before) === focusKey(await this.host.context()) ? project : null
    } catch {
      // Missing permission, unavailable host/CLI or ambiguous identity means "all", never cwd.
      return null
    }
  }
}
