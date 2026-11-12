import { adjacentMonth, businessDate, monthDates, type MissingDay } from './missing-hours.ts'
import { attendanceDayEnded } from './attendance.ts'
import type { HoursMonth } from '../hours-cache.ts'

/// 近一年按当月及前 11 个自然月排列，当前月优先同步。
export function recentHoursMonths(now = new Date()): string[] {
  const current = businessDate(now).slice(0, 7)
  return Array.from({ length: 12 }, (_, index) => adjacentMonth(current, -index))
}

/// 日期必须完整覆盖当前应查询范围，旧的当月前缀不能算年度已完成月份。
export function completeHoursMonth(value: HoursMonth | null | undefined, now = new Date()): boolean {
  if (!value) return false
  const dates = monthDates(value.month, now)
  return value.days.length === dates.length && value.days.every((day, index) => day.date === dates[index])
}

/// 仅已结束、日期完整且额度逐日完全一致的月份可跳过自动云端刷新。
export function alignedHoursMonth(value: HoursMonth | null | undefined, now = new Date()): boolean {
  if (!value || value.month >= businessDate(now).slice(0, 7)) return false
  return completeHoursMonth(value, now) && attendanceDayEnded(value.days.at(-1)!.date, now.getTime()) && value.days.every(day => (day.state === 'covered' || day.state === 'not_required') &&
    day.budget !== null && day.existing === day.budget && day.remaining === 0)
}

/// 缺报只统计有明确考勤且额度尚未登记完整的日期；未知与进行中另列。
export function hoursTotals(days: MissingDay[]) {
  const missing = days.filter(day => day.state === 'missing' || day.state === 'partial')
  return { count: missing.length, minutes: missing.reduce((total, day) => total + (day.remaining ?? 0), 0),
    review: days.filter(day => day.state === 'review').length }
}
