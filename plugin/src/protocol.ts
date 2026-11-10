import type { RepairPreparation, RepairRecord } from './repair.ts'
import type { BugDetail, Discussion, Attachment, DetailPage } from './adapters/bug-details.ts'
import type { MediaChunk } from './adapters/bug-media.ts'
import type { Allocation, Attendance, Option, Preview, Site, Status, Task, TaskPage, Worklog } from './domain/model.ts'
export type Answer<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export type LoginInput = { site: Site; account: string; password: string; httpAcknowledged: boolean }
export type DayInput = { team: string; date: string; mappingConfirmed: boolean }
export type Day = { id: string; date: string; attendance: Attendance; existing: number; worklogs: Worklog[] }
export type PreviewInput = { dayId: string; selection: { start: number; end: number; confirmed: boolean }; allocations: Allocation[] }
export type Draft = { date: string; allocations: Allocation[] }
export type PendingWrite = { id: string; kind: 'add' | 'describe'; date: string; minutes: number; state: 'submitting' | 'unknown'; hasKey: boolean }
export type RecoveryPreview = { id: string | null; receiptId: string; matchCount: number; candidate: Worklog | null; message: string }
export type ImplementationBrief = { task: Task; text: string; blockedReason: string }
declare module 'orca' {
  interface PluginRequests {
    'bugs.projectFilter': { input: { team: string; projects: Option[] }; output: Answer<{ localProject: Option | null; project: Option | null }> }
    'repair.read': { input: { detailId: string }; output: Answer<RepairRecord | null> }
    'repair.prepare': { input: { detailId: string }; output: Answer<RepairPreparation> }
    'repair.start': { input: { preparationId: string; projectId: string; agent: string; confirmed: boolean }; output: Answer<RepairRecord> }
    'status': { output: Answer<Status> }
    'auth.login': { input: LoginInput; output: Answer<Status> }
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
    'day.read': { input: DayInput; output: Answer<Day> }
    'hours.preview': { input: PreviewInput; output: Answer<Preview> }
    'hours.submit': { input: { previewId: string; confirmed: boolean }; output: Answer<{ count: number }> }
    'hours.list': { input: { team: string; date: string }; output: Answer<Worklog[]> }
    'recovery.list': { input: { team: string }; output: Answer<PendingWrite[]> }
    'recovery.preview': { input: { team: string; receiptId: string }; output: Answer<RecoveryPreview> }
    'recovery.confirm': { input: { previewId: string; confirmed: boolean }; output: Answer<{ verified: true }> }
    'hours.describe': { input: { team: string; date: string; key: string; description: string; confirmed: boolean }; output: Answer<{ key: string }> }
    'draft.save': { input: Draft; output: Answer<{ saved: true }> }
    'draft.load': { output: Answer<Draft | null> }
  }
}
