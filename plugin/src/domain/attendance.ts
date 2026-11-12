import { type Allocation, type Attendance, type Punch, type Worklog, requireThat, minuteOfDay, validDate } from './model.ts'

// Persisted projections must not reuse budgets calculated under older rules.
export const ATTENDANCE_RULE_VERSION = 'attendance-0800-window-first-last-v1'

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

export function resolveAttendance(attendance: Attendance): { start: string; end: string; endNextDay?: boolean; budget: number } {
  validDate(attendance.date)
  requireThat(attendance.punches.length === 2, 'attendance', '缺卡、多次打卡或异常记录不能自动折算，请先处理考勤异常。')
  for (const punch of attendance.punches) {
    attendancePunchMinute(punch, attendance.date)
    requireThat(punch.outFence === false, 'attendance', '外勤标志未知或异常，需先核实接口与考勤。')
    minuteOfDay(punch.time)
  }
  // Exactly two verified punches in one business window; multiple punches remain review-only.
  const [start, end] = [...attendance.punches].sort((a, b) => attendancePunchMinute(a, attendance.date) - attendancePunchMinute(b, attendance.date))
  const a = attendancePunchMinute(start!, attendance.date)
  const b = attendancePunchMinute(end!, attendance.date)
  requireThat(a < 1110 && b >= 1110, 'attendance', '此上下班时段不在已确认工时规则内，不能自动折算。')
  // Count only missed scheduled work: 09:00–12:30 and 14:00–18:30.
  // Lunch is not work and must not be deducted a second time.
  const missedMorning = Math.max(0, Math.min(a, 750) - 540)
  const missedAfternoon = Math.max(0, Math.min(a, 1110) - 840)
  const deduction = Math.floor((missedMorning + missedAfternoon) / 30) * 30
  const overtime = Math.floor(Math.max(0, b - 1140) / 30) * 30
  return { start: start!.time, end: end!.time, ...(b >= 1440 ? { endNextDay: true } : {}), budget: 480 - deduction + overtime }
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
