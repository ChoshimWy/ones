import { FocusedProject } from './adapters/focused-project.ts'
import type { OrcaWorkerApi } from 'orca/worker'
import { RepairWorkflow } from './repair.ts'
import { Workbench } from './service.ts'
import { safeFailure } from './domain/model.ts'
import type { Answer } from './protocol.ts'

export default function activate(orca: OrcaWorkerApi): void {
  const service = new Workbench({
    store: { get: key => orca.storage.get(key), set: (key, value) => orca.storage.set(key, value as never), delete: key => orca.storage.delete(key) },
    vault: orca.secrets,
    protection: async () => (await orca.host.call('secrets.protection')).status === 'os-keyring',
    // Not a setting or a panel parameter. Requires verified end-to-end evidence to change.
    writesVerified: false
  })
  const answer = async <T>(action: () => Promise<T>): Promise<Answer<T>> => {
    try { return { ok: true, value: await action() } }
    catch (error) { return { ok: false, error: safeFailure(error) } }
  }
  const repair = new RepairWorkflow(service, {
    get: key => orca.storage.get(key),
    set: (key, value) => orca.storage.set(key, value as never),
    delete: key => orca.storage.delete(key)
  })
  const focusedProject = new FocusedProject({
    context: () => orca.host.call('workspace.readContext'),
    list: () => orca.host.call('workspace.list')
  })
  orca.panels.handle('bugs.projectFilter', input => answer(async () =>
    service.projectFilter(input.team, await focusedProject.current(), input.projects)))
  orca.panels.handle('repair.read', input => answer(() => repair.read(input.detailId)))
  orca.panels.handle('repair.prepare', input => answer(() => repair.prepare(input.detailId)))
  orca.panels.handle('repair.start', input => answer(() => repair.start(input)))
  orca.panels.handle('status', () => answer(() => service.status()))
  orca.panels.handle('auth.login', (input, context) => answer(() => service.login(input, context.signal)))
  orca.panels.handle('auth.logout', input => answer(() => service.logout(input.site)))
  orca.panels.handle('bugs.statuses', (input, context) => answer(() => service.bugStatuses(input.team, context.signal)))
  orca.panels.handle('bugs.list', (input, context) => answer(() => service.bugs(input.team, input.after, context.signal)))
  orca.panels.handle('bugs.detail', (input, context) => answer(() => service.bugDetail(input.team, input.taskId, context.signal, input.requestId)))
  orca.panels.handle('bugs.comments', (input, context) => answer(() => service.detailComments(input.detailId, input.before, context.signal)))
  orca.panels.handle('bugs.attachments', (input, context) => answer(() => service.detailAttachments(input.detailId, input.before, context.signal)))
  orca.panels.handle('bugs.media', (input, context) => answer(() => service.detailMedia(input.detailId, input.resourceId, input.offset, context.signal)))
  orca.panels.handle('bugs.close', input => answer(async () => { service.closeDetail(input.detailId); return {closed:true as const} }))
  orca.panels.handle('tasks.list', (input, context) => answer(() => service.tasks(input.team, input.after, context.signal)))
  orca.panels.handle('tasks.brief', (input, context) => answer(() => service.brief(input.team, input.taskId, context.signal)))
  orca.panels.handle('day.read', (input, context) => answer(() => service.readDay(input, context.signal)))
  orca.panels.handle('hours.preview', (input, context) => answer(() => service.makePreview(input, context.signal)))
  orca.panels.handle('hours.submit', input => answer(() => service.submit(input.previewId, input.confirmed)))
  orca.panels.handle('hours.list', (input, context) => answer(() => service.worklogs(input.team, input.date, context.signal)))
  orca.panels.handle('recovery.list', input => answer(() => service.pending(input.team)))
  orca.panels.handle('recovery.preview', (input, context) => answer(() => service.previewRecovery(input.team, input.receiptId, context.signal)))
  orca.panels.handle('recovery.confirm', input => answer(() => service.confirmRecovery(input.previewId, input.confirmed)))
  orca.panels.handle('hours.describe', input => answer(() => service.describe(input)))
  orca.panels.handle('draft.save', input => answer(() => service.saveDraft(input)))
  orca.panels.handle('draft.load', () => answer(() => service.loadDraft()))
}
