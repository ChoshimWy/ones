import { type Allocation, type Attendance, type Worklog, requireThat, minuteOfDay, validDate } from './model.ts'

export function resolveAttendance(attendance: Attendance): { start: string; end: string; budget: number } {
  validDate(attendance.date)
  requireThat(attendance.punches.length === 2, 'attendance', '缺卡、多次打卡或异常记录不能自动折算，请先处理考勤异常。')
  for (const punch of attendance.punches) {
    requireThat(punch.date === attendance.date && punch.realDate === attendance.date && punch.isNext === false, 'attendance', '跨日或日期不明的打卡不能自动折算。')
    requireThat(punch.outFence === false, 'attendance', '外勤标志未知或异常，需先核实接口与考勤。')
    minuteOfDay(punch.time)
  }
  // Exactly two verified same-day punches: ordering is deterministic, never pick
  // extrema from an ambiguous multi-punch day or trust a caller confirmation flag.
  const [start, end] = [...attendance.punches].sort((a, b) => a.time.localeCompare(b.time))
  const a = minuteOfDay(start!.time)
  const b = minuteOfDay(end!.time)
  requireThat((a <= 540 || (a === 555 && b === 1260)) && b >= 1110, 'attendance', '此上下班时段不在已确认工时规则内，不能自动折算。')
  return { start: start!.time, end: end!.time, budget: 480 + Math.floor(Math.max(0, b - 1140) / 30) * 30 }
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
