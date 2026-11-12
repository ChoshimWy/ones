import { AppError, type Attendance, type Allocation, type Task, requireThat, validDate } from './model.ts'
import { resolveAttendance, checkAllocations, attendancePunchMinute } from './attendance.ts'

export type MissingDay = {
  date: string
  existing: number
  budget: number | null
  remaining: number | null
  state: 'missing' | 'partial' | 'covered' | 'review' | 'not_required' | 'pending'
  attendanceTime?: { start: string; end: string; startNextDay?: boolean; endNextDay?: boolean }
  reason: string
}
export function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
export function monthDates(month: string, now = new Date()): string[] {
  requireThat(typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) && month >= '1970-01', 'input', '月份格式无效或早于支持范围。')
  validDate(month + '-01')
  const today = businessDate(now)
  requireThat(month <= today.slice(0, 7), 'input', '不能查询未来月份。')
  const first = new Date(month + '-01T00:00:00Z')
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
  const end = last < today ? last : today
  const dates: string[] = []
  for (let t = first.getTime(); t <= Date.parse(end + 'T00:00:00Z'); t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10))
  return dates
}
export function adjacentMonth(month: string, delta: number): string {
  validDate(month + '-01')
  const date = new Date(month + '-01T00:00:00Z')
  date.setUTCMonth(date.getUTCMonth() + delta)
  return date.toISOString().slice(0, 7)
}

// Display-only projection: endpoints never make an ambiguous day allocatable.
export function attendanceEndpoints(attendance: Attendance): MissingDay['attendanceTime'] {
  if (!attendance.punches.length) return undefined
  try {
    const ordered = attendance.punches.map(punch => ({ time: punch.time, minute: attendancePunchMinute(punch, attendance.date) })).sort((a, b) => a.minute - b.minute)
    return { start: ordered[0]!.time, end: ordered.at(-1)!.time, ...(ordered[0]!.minute >= 1440 ? { startNextDay: true } : {}), ...(ordered.at(-1)!.minute >= 1440 ? { endNextDay: true } : {}) }
  } catch {
    return undefined
  }
}

export function classifyDay(attendance: Attendance, existing: number): MissingDay {
  requireThat(Number.isFinite(existing) && existing >= 0, 'schema', '已有工时无效。')
  const endpoints = attendanceEndpoints(attendance)
  const base = { date: attendance.date, existing, ...(endpoints ? { attendanceTime: endpoints } : {}) }
  validDate(attendance.date)
  if (attendance.punches.length === 0 && !attendance.approved?.length) return { ...base, budget: 0, remaining: 0, state: 'not_required', reason: '该日无考勤，无需填写工时。' }
  try {
    const { start, end, endNextDay, budget } = resolveAttendance(attendance)
    return { ...base, ...(attendance.approved?.length ? {} : { attendanceTime: { start, end, ...(endNextDay ? { endNextDay } : {}) } }), budget, remaining: Math.max(0, budget - existing),
      state: existing === 0 ? 'missing' : existing < budget ? 'partial' : 'covered',
      reason: existing > budget ? '已有工时超过考勤额度，请核对；不自动修改。' : '考勤额度仅为上限，不代表实际任务投入。' }
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'attendance') throw error
    return { ...base, budget: null, remaining: null, state: 'review',
      reason: error.message }
  }
}

export function taskDraft(task: Task, start: string, minutes: number, description: string,
  budget: number, existing: number, allocations: Allocation[]): Allocation {
  const row = { taskId: task.id, start, minutes, description: description.trim() || '处理任务 #' + task.number + '：' + task.name }
  requireThat(!allocations.some(item => item.taskId === task.id), 'input', '草稿已包含此任务，请先核对或移除原项。')
  checkAllocations([...allocations, row], budget, existing)
  return row
}
