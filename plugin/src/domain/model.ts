export type Site = 'ones' | 'coho'
export type Connection = { connected: boolean; label: string; savedLogin?: { account: string; paused: boolean; retryAfter: number } }
export type Option = { id: string; name: string }
export type Task = { id: string; number: number; name: string; project: Option; issueType: Option; status: Option }
export type TaskPage = { items: Task[]; nextCursor: string | null }
export type Punch = { date: string; realDate: string; time: string; isNext: boolean; outFence: boolean | null }
export type Attendance = { date: string; punches: Punch[]; leave?: { start: number; end: number }[]; approved?: { start: number; end: number; minutes: number; kind: 'business' | 'overtime' }[]; fetchedAt: number }
export type Worklog = { key: string; task: string; owner: string; hours: number; startTime: number; description: string; type: string }
export type Allocation = { taskId: string; start: string; minutes: number; description: string }
export type Preview = { id: string; date: string; budget: number; existing: number; proposed: number; remaining: number; rows: (Allocation & { taskName: string })[]; expiresAt: number }
export type Status = { identity?: string; ones: Connection; coho: Connection; teams: Option[]; writeEnabled: boolean; descriptionWriteEnabled?: boolean; blockers: string[] }
export class AppError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'AppError' }
}
export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(code, message)
}
export function record(x: unknown): Record<string, unknown> {
  requireThat(x !== null && typeof x === 'object' && !Array.isArray(x), 'schema', '接口结构不匹配，已停止操作。')
  return x as Record<string, unknown>
}
export function text(x: unknown, max = 500): string {
  requireThat(typeof x === 'string' && x.length > 0 && x.length <= max, 'schema', '必填字段缺失或格式不匹配。')
  return x
}
export function id(x: unknown): string {
  const value = text(x, 100)
  requireThat(/^[A-Za-z0-9_-]+$/.test(value), 'input', '标识格式无效。')
  return value
}
export function validDate(value: unknown): string {
  const date = text(value, 10)
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date, 'input', '日期格式应为 YYYY-MM-DD。')
  return date
}
export function minuteOfDay(value: unknown): number {
  const time = text(value, 5)
  requireThat(/^([01]\d|2[0-3]):[0-5]\d$/.test(time), 'input', '时间格式应为 HH:mm。')
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}
export function safeFailure(error: unknown): { code: string; message: string } {
  // Never reflect response bodies, input values, URLs or upstream exception messages.
  return error instanceof AppError ? { code: error.code, message: error.message } : { code: 'unavailable', message: '操作未完成，请检查连接后重试；写入结果需先核实。' }
}
