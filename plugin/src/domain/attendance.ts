import { type Allocation, type Attendance, type Punch, type Worklog, requireThat, minuteOfDay, validDate } from './model.ts'

// Persisted projections must not reuse budgets calculated under older rules.
export const ATTENDANCE_RULE_VERSION = 'attendance-approved-work-total-floor-v4'

export function nextAttendanceDate(date: string): string {
  validDate(date)
  return new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
}

export function attendanceDayEnded(date: string, now = Date.now()): boolean {
  return now >= Date.parse(nextAttendanceDate(date) + 'T08:00:00+08:00')
}

// Use the actual date and time, never lexical HH:mm order across midnight.
export function attendancePunchMinute(punch: Punch, date: string): number {
  const next = nextAttendanceDate(date)
  requireThat((punch.date === date || punch.date === next) && typeof punch.isNext === 'boolean', 'attendance', '打卡日期或跨日标志不明确。')
  requireThat((punch.realDate === punch.date && !punch.isNext) || (punch.realDate === nextAttendanceDate(punch.date) && punch.isNext), 'attendance', '打卡实际日期与跨日标志不一致。')
  const minute = minuteOfDay(punch.time)
  const offset = punch.realDate === date ? minute : punch.realDate === next ? minute + 1440 : -1
  requireThat(offset >= 480 && offset < 1920, 'attendance', '打卡不在当天 08:00 至次日 08:00 的考勤窗口内。')
  return offset
}

export function resolveAttendance(attendance: Attendance): { start: string; end: string; endNextDay?: boolean; budget: number; basis: 'punch' | 'approval' | 'mixed' } {
  validDate(attendance.date)
  const approved = [...(attendance.approved ?? [])].sort((a, b) => a.start - b.start)
  for (const [index, span] of approved.entries()) {
    requireThat(Number.isFinite(span.start) && Number.isFinite(span.end) && Number.isFinite(span.minutes) &&
      span.start >= 480 && span.end <= 1860 && span.start < span.end && span.minutes > 0 && span.minutes <= span.end - span.start &&
      (index === 0 || approved[index - 1]!.end <= span.start), 'attendance', '工作审批重叠或时长不明确，需先核实，不能重复累计。')
  }
  requireThat(attendance.punches.length === 2 || (approved.length > 0 && attendance.punches.length <= 1), 'attendance', '缺卡、多次打卡或异常记录不能自动折算，请先处理考勤异常。')
  for (const punch of attendance.punches) {
    attendancePunchMinute(punch, attendance.date)
    requireThat(punch.outFence === false, 'attendance', '外勤标志未知或异常，需先核实接口与考勤。')
    minuteOfDay(punch.time)
  }
  // Exactly two verified punches in one business window; multiple punches remain review-only.
  const [start, end] = [...attendance.punches].sort((a, b) => attendancePunchMinute(a, attendance.date) - attendancePunchMinute(b, attendance.date))
  const a = start ? attendancePunchMinute(start, attendance.date) : approved[0]!.start
  const b = end ? attendancePunchMinute(end, attendance.date) : approved.at(-1)!.end
  if (attendance.punches.length === 2) requireThat(a < b, 'attendance', '上下班时间顺序无效，不能自动折算。')
  if (attendance.punches.length === 1) requireThat(approved.some(span => a >= span.start && a <= span.end),
    'attendance', '单条打卡未被工作审批覆盖，不能推断出勤区间。')
  const effectiveStart = a < 555 ? 540 : a
  const leave = [...(attendance.leave ?? [])].sort((x, y) => x.start - y.start)
  for (const span of leave) {
    requireThat(Number.isFinite(span.start) && Number.isFinite(span.end) && span.start < span.end,
      'attendance', '请假起止时间无效，不能自动折算。')
  }
  // Merge leave intervals before subtracting so duplicate/overlapping approvals count once.
  const merged: { start: number; end: number }[] = []
  for (const span of leave) {
    const last = merged.at(-1)
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
  const windows = [{ start: 540, end: 750 }, { start: 840, end: 1110 }, { start: 1140, end: 1860 }]
  let minutes = 0
  for (const span of approved) {
    const scheduled = windows.reduce((sum, window) => sum + overlap(span, window), 0)
    const deduction = windows.reduce((sum, window) => sum + merged.reduce((amount, leave) =>
      amount + overlap({ start: Math.max(span.start, window.start), end: Math.min(span.end, window.end) }, leave), 0), 0)
    requireThat(deduction === 0 || scheduled === span.minutes, 'attendance', '审批时长与工作区间不一致且存在请假，需核实扣除方式。')
    minutes += Math.max(0, span.minutes - deduction)
  }
  if (attendance.punches.length === 2) {
    // Approval owns its full interval; only uncovered punch time is additional.
    const exclusions = [...merged, ...approved].sort((a, b) => a.start - b.start)
    for (const window of windows) {
      let cursor = Math.max(effectiveStart, window.start)
      const upper = Math.min(b, window.end)
      for (const span of exclusions) {
        if (span.end <= cursor || span.start >= upper) continue
        minutes += Math.max(0, Math.min(span.start, upper) - cursor)
        cursor = Math.max(cursor, span.end)
      }
      minutes += Math.max(0, upper - cursor)
    }
  }
  const budget = Math.floor(minutes / 30) * 30
  const clock = (minute: number) => String(Math.floor(minute % 1440 / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0')
  const from = approved.length ? Math.min(a, approved[0]!.start) : a
  const to = approved.length ? Math.max(b, approved.at(-1)!.end) : b
  return { start: clock(from), end: clock(to), ...(to >= 1440 ? { endNextDay: true } : {}), budget,
    basis: approved.length ? (attendance.punches.length ? 'mixed' : 'approval') : 'punch' }
}

export function attendanceBudget(attendance: Attendance): number {
  return resolveAttendance(attendance).budget
}

export function apiHours(minutes: number): number {
  requireThat(Number.isSafeInteger(minutes) && minutes > 0, 'input', '工时必须为正整数分钟。')
  const scaled = minutes * 100000
  requireThat(Number.isSafeInteger(scaled) && scaled % 60 === 0, 'input', '此分钟数不能精确编码；请使用 3 分钟的整数倍。')
  return scaled / 60
}
export function startSeconds(date: string, time: string): number {
  validDate(date); minuteOfDay(time)
  return Date.parse(`${date}T${time}:00+08:00`) / 1000
}
export function existingMinutes(rows: Worklog[], date: string, owner: string): number {
  const from = startSeconds(date, '00:00')
  let units = 0
  for (const row of rows) {
    requireThat(row.owner === owner && row.type === 'recorded' && row.startTime >= from && row.startTime < from + 86400, 'schema', '已有工时日期或归属不匹配，不能计算剩余额度。')
    requireThat(Number.isSafeInteger(row.hours) && row.hours >= 0, 'schema', '已有工时单位无效。')
    units += row.hours
  }
  requireThat(Number.isSafeInteger(units), 'schema', '已有工时超出数值范围。')
  return units * 60 / 100000
}
export function validateDescription(description: unknown): asserts description is string {
  requireThat(typeof description === 'string' && description.trim().length > 0 && description.length <= 2000, 'description', '每笔工时必须有经确认的非空描述。')
  requireThat(!/(?:Bearer\s+\S+|-----BEGIN .*KEY|eyJ[\w-]+\.[\w-]+\.)/i.test(description), 'description', '描述疑似含认证材料，请移除。')
}
export function checkAllocations(rows: Allocation[], budget: number, existing: number): number {
  requireThat(rows.length > 0 && rows.length <= 20, 'input', '请分配 1～20 笔工时。')
  let total = 0
  for (const row of rows) {
    apiHours(row.minutes)
    minuteOfDay(row.start)
    validateDescription(row.description)
    requireThat(minuteOfDay(row.start) + row.minutes <= 1440, 'input', '跨日工时尚未支持。')
    total += row.minutes
  }
  requireThat(Number.isFinite(budget) && Number.isFinite(existing) && budget >= 0 && existing >= 0 && total <= budget - existing, 'budget', '本次分配超过考勤剩余额度。')
  return total
}
