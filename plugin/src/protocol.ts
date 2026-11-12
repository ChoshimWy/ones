import type { RepairActions } from './repair-actions.ts'
import type { RepairListItem } from './repair.ts'
import type { CachedRepairs } from './repair-cache.ts'
import type { StatusWorkflow, StatusPreview, StatusResult, BusinessInput, BusinessPreview, BusinessResult } from './status-update.ts'
import type { TransitionInput } from './adapters/ones-transitions.ts'
import type { RepairPreparation, RepairRecord } from './repair.ts'
import type { BugDetail, Discussion, Attachment, DetailPage } from './adapters/bug-details.ts'
import type { MediaChunk } from './adapters/bug-media.ts'
import type { Allocation, Attendance, Option, Preview, Site, Status, Task, TaskPage, Worklog } from './domain/model.ts'
export type Answer<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export type LoginInput = { site: Site; account: string; password: string; httpAcknowledged: boolean; remember?: boolean }
export type DayInput = { team: string; date: string }
export type Day = { id: string; date: string; attendance: Attendance; existing: number; worklogs: Worklog[] }
export type PreviewInput = { dayId: string; allocations: Allocation[] }
export type Draft = { date: string; allocations: Allocation[] }
export type ImplementationBrief = { task: Task; text: string; blockedReason: string }
declare module 'orca' {
  interface PluginRequests {
    'bugs.transitionReconcile': { input: { detailId: string; operationId: string }; output: Answer<StatusResult> }

    'bugs.projectFilter': { input: { team: string; projects: Option[] }; output: Answer<{ localProject: Option | null; project: Option | null }> }
    'repair.cache': { input: { team: string }; output: Answer<CachedRepairs> }
    'repair.sync': { input: { team: string }; output: Answer<CachedRepairs> }
    'repair.inspectRestart': { input: { detailId: string }; output: Answer<Awaited<ReturnType<import('./repair.ts').RepairWorkflow['inspectRestart']>>> }
    'repair.restart': { input: Parameters<import('./repair.ts').RepairWorkflow['restart']>[0]; output: Answer<RepairRecord> }
    'repair.history': { input: { detailId: string }; output: Answer<Awaited<ReturnType<import('./repair.ts').RepairWorkflow['history']>>> }
    'repair.read': { input: { detailId: string }; output: Answer<RepairRecord | null> }
    'repair.prepare': { input: { detailId: string }; output: Answer<Awaited<ReturnType<RepairActions['prepare']>>> }
    'repair.start': { input: { previewId: string; confirmed: boolean }; output: Answer<RepairRecord> }
    'repair.previewStart': { input: Parameters<RepairActions['preview']>[0]; output: Answer<Awaited<ReturnType<RepairActions['preview']>>> }
    'repair.result': { input: { detailId: string }; output: Answer<RepairListItem | null> }
    'bugs.businessOptions': { input: { detailId: string }; output: Answer<Awaited<ReturnType<StatusWorkflow['businessOptions']>>> }
    'bugs.businessPreview': { input: Omit<BusinessInput,'goal'>; output: Answer<BusinessPreview> }
    'bugs.businessSubmit': { input: { previewId:string;confirmed:boolean }; output: Answer<BusinessResult> }
    'status': { output: Answer<Status> }
    'auth.login': { input: LoginInput; output: Answer<Status> }
    'auth.forget': { input: { site: Site }; output: Answer<Status> }
    'auth.logout': { input: { site: Site }; output: Answer<Status> }
    'bugs.statuses': { input: { team: string }; output: Answer<Option[]> }
    'bugs.detail': { input: { team: string; taskId: string; requestId?: string }; output: Answer<BugDetail & {detailId:string}> }
    'bugs.comments': { input: { detailId: string; before?: number }; output: Answer<DetailPage<Discussion>> }
    'bugs.attachments': { input: { detailId: string; before?: number }; output: Answer<DetailPage<Attachment>> }
    'bugs.media': { input: { detailId: string; resourceId: string; offset: number }; output: Answer<MediaChunk> }
    'bugs.close': { input: { detailId: string }; output: Answer<{closed:true}> }
    'bugs.list': { input: { team: string; after?: string }; output: Answer<TaskPage> }
    'tasks.list': { input: { team: string; after?: string }; output: Answer<TaskPage> }
    'tasks.brief': { input: { team: string; taskId: string }; output: Answer<ImplementationBrief> }
    'hours.yearCache': { input: { team: string }; output: Answer<import('./hours-cache.ts').HoursMonth[]> }
    'hours.tasksCache': { input: { team: string }; output: Answer<import('./hours-cache.ts').HoursTasks | null> }
    'hours.tasksSync': { input: { team: string }; output: Answer<import('./hours-cache.ts').HoursTasks> }
    'hours.batchPreview': { input: { team: string; rows: import('./hours-batch.ts').HoursBatchRow[] }; output: Answer<import('./hours-batch.ts').HoursBatchPreview> }
    'hours.batchSubmit': { input: { team: string; previewId: string; confirmed: boolean }; output: Answer<import('./hours-batch.ts').HoursBatchResult> }
    'hours.batchResult': { input: { team: string }; output: Answer<import('./hours-batch.ts').HoursBatchResult | null> }
    'hours.cache': { input: { team: string; month: string }; output: Answer<import('./hours-cache.ts').HoursMonth | null> }
    'hours.scan': { input: { team: string; month: string; cursor?: string; force?: boolean }; output: Answer<{ days: import('./domain/missing-hours.ts').MissingDay[]; nextCursor: string | null; total: number; savedAt: number | null }> }
    'day.read': { input: DayInput; output: Answer<Day> }
    'hours.preview': { input: PreviewInput; output: Answer<Preview> }
    'hours.acceptanceSubmit': { input: { previewId: string; confirmed: boolean }; output: Answer<{ count: number }> }
    'hours.submit': { input: { previewId: string; confirmed: boolean }; output: Answer<{ count: number }> }
    'draft.save': { input: Draft; output: Answer<{ saved: true }> }
    'draft.load': { output: Answer<Draft | null> }
  }
}
