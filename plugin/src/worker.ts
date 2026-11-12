import { HoursAcceptance } from './hours-acceptance.ts'
import { HoursCache } from './hours-cache.ts'
import { privateDataRoot } from './private-files.ts'
import { join } from 'node:path'
import { RepairActions } from './repair-actions.ts'
import { StatusWorkflow } from './status-update.ts'
import { FocusedProject } from './adapters/focused-project.ts'
import type { OrcaWorkerApi } from 'orca/worker'
import { RepairWorkflow } from './repair.ts'
import { Workbench } from './service.ts'
import { safeFailure } from './domain/model.ts'
import type { Answer } from './protocol.ts'

export default function activate(orca: OrcaWorkerApi): void {
  const service = new Workbench({
    hoursCache: new HoursCache(join(privateDataRoot(), 'hours-cache')),
    store: { get: key => orca.storage.get(key), set: (key, value) => orca.storage.set(key, value as never), delete: key => orca.storage.delete(key) },
    vault: orca.secrets,
    protection: async () => (await orca.host.call('secrets.protection')).status === 'os-keyring',
    // 2026-11-12: macOS single live write/readback + targeted batch/UI evidence.
    // Each write still requires a fresh confirmed preview and durable recovery ledger.
    writesVerified: process.platform === 'darwin',
    descriptionWritesVerified: false,
    consumeHoursAcceptance: grant => new HoursAcceptance(join(privateDataRoot(), 'hours-acceptance')).consume(grant)
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
  // 2026-11-10 正式 Worker 两步状态流转及独立回读已验证；仅开放 Adapter 支持的步骤；与工时新增/描述权限独立。
  const transitions = new StatusWorkflow(detailId => service.transitionContext(detailId), undefined, true, async detailId => (await repair.result(detailId))?.report)
  const repairActions = new RepairActions(repair,transitions)
  orca.panels.handle('bugs.businessOptions', input => answer(() => transitions.businessOptions(input.detailId,'已修复')))
  orca.panels.handle('bugs.businessPreview', input => answer(() => transitions.businessPreview({...input,goal:'已修复'})))
  orca.panels.handle('bugs.businessSubmit', input => answer(() => transitions.businessSubmit(input.previewId,input.confirmed)))
  orca.panels.handle('repair.result', input => answer(() => repair.result(input.detailId)))
  orca.panels.handle('repair.previewStart', input => answer(() => repairActions.preview(input)))
  orca.panels.handle('bugs.transitionReconcile', input => answer(() => transitions.reconcile(input.detailId, input.operationId)))
  const focusedProject = new FocusedProject({
    context: () => orca.host.call('workspace.readContext'),
    list: () => orca.host.call('workspace.list')
  })
  orca.panels.handle('bugs.projectFilter', input => answer(async () =>
    service.projectFilter(input.team, await focusedProject.current(), input.projects)))
  orca.panels.handle('repair.cache', (input, context) => answer(async () => repair.cached(await service.repairCacheContext(input.team, context.signal))))
  orca.panels.handle('repair.sync', (input, context) => answer(async () => repair.sync(await service.repairCacheContext(input.team, context.signal), () => service.repairListContext(input.team))))
  orca.panels.handle('repair.inspectRestart', input => answer(() => repair.inspectRestart(input.detailId)))
  orca.panels.handle('repair.restart', input => answer(() => repairActions.restart(input)))
  orca.panels.handle('repair.history', input => answer(() => repair.history(input.detailId)))
  orca.panels.handle('repair.read', input => answer(() => repair.read(input.detailId)))
  orca.panels.handle('repair.prepare', input => answer(() => repairActions.prepare(input.detailId)))
  orca.panels.handle('repair.start', input => answer(() => repairActions.start(input.previewId,input.confirmed)))
  orca.panels.handle('status', () => answer(() => service.status()))
  orca.panels.handle('auth.login', (input, context) => answer(() => service.login(input, context.signal)))
  orca.panels.handle('auth.forget', input => answer(() => service.forgetLogin(input.site)))
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
  orca.panels.handle('hours.yearCache', input => answer(() => service.cachedHoursYear(input.team)))
  orca.panels.handle('hours.tasksCache', input => answer(() => service.cachedHoursTasks(input.team)))
  orca.panels.handle('hours.tasksSync', (input, context) => answer(() => service.syncHoursTasks(input.team, context.signal)))
  orca.panels.handle('hours.batchPreview', (input, context) => answer(() => service.previewHoursBatch(input.team, input.rows, context.signal)))
  orca.panels.handle('hours.batchSubmit', input => answer(() => service.submitHoursBatch(input.previewId, input.confirmed, input.team)))
  orca.panels.handle('hours.batchResult', input => answer(() => service.hoursBatchResult(input.team)))
  orca.panels.handle('hours.cache', input => answer(() => service.cachedHours(input.team, input.month)))
  orca.panels.handle('hours.scan', (input, context) => answer(() => service.scanHours(input, context.signal)))
  orca.panels.handle('day.read', (input, context) => answer(() => service.readDay(input, context.signal)))
  orca.panels.handle('hours.preview', (input, context) => answer(() => service.makePreview(input, context.signal)))
  orca.panels.handle('hours.acceptanceSubmit', input => answer(() => service.submitAcceptance(input.previewId, input.confirmed)))
  orca.panels.handle('hours.submit', input => answer(() => service.submit(input.previewId, input.confirmed)))
  orca.panels.handle('hours.list', (input, context) => answer(() => service.worklogs(input.team, input.date, context.signal)))
  orca.panels.handle('recovery.list', input => answer(() => service.pending(input.team)))
  orca.panels.handle('recovery.preview', (input, context) => answer(() => service.previewRecovery(input.team, input.receiptId, context.signal)))
  orca.panels.handle('recovery.confirm', input => answer(() => service.confirmRecovery(input.previewId, input.confirmed)))
  orca.panels.handle('hours.describe', input => answer(() => service.describe(input)))
  orca.panels.handle('draft.save', input => answer(() => service.saveDraft(input)))
  orca.panels.handle('draft.load', () => answer(() => service.loadDraft()))
}
