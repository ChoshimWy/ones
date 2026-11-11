import { AppError, type Attendance, type Allocation, type Task, requireThat, validDate } from './model.ts'
import { attendanceBudget, checkAllocations } from './attendance.ts'

export type MissingDay = {
  date: string
  existing: number
  budget: number | null
  remaining: number | null
  state: 'missing' | 'partial' | 'covered' | 'review' | 'not_required'
  attendanceTime?: { start: string; end: string }
  reason: string
}
export const scanMonths = [1, 2, 3, 6, 12] as const

// Calendar months, clamped at month-end; today is excluded in the business timezone.
export function scanDates(months: number, now = new Date()): string[] {
  requireThat(scanMonths.some(value => value === months), 'input', '仅支持近一个月、两个月、三个月、半年或一年。')
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  validDate(today)
  const end = new Date(today + 'T00:00:00Z')
  const start = new Date(end)
  start.setUTCDate(1)
  start.setUTCMonth(start.getUTCMonth() - months)
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
  start.setUTCDate(Math.min(end.getUTCDate(), last))
  const dates: string[] = []
  for (let t = start.getTime(); t < end.getTime(); t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10))
  return dates
}

export function classifyDay(attendance: Attendance, existing: number): MissingDay {
  requireThat(Number.isFinite(existing) && existing >= 0, 'schema', '已有工时无效。')
  const base = { date: attendance.date, existing }
  validDate(attendance.date)
  if (attendance.punches.length === 0) return { ...base, budget: 0, remaining: 0, state: 'not_required', reason: '该日无考勤，无需填写工时。' }
  try {
    // Pairing here is a read-only estimate, never a human confirmation for submission.
    const sorted = attendance.punches.map((p, i) => ({ time: p.time, i })).sort((a, b) => a.time.localeCompare(b.time))
    const budget = attendanceBudget(attendance, { start: sorted[0]?.i ?? -1, end: sorted[1]?.i ?? -1, confirmed: true })
    return { ...base, attendanceTime: { start: sorted[0]!.time, end: sorted[1]!.time }, budget, remaining: Math.max(0, budget - existing),
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
