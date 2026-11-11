import type { MissingDay } from '../domain/missing-hours.ts'
import { validDate } from '../domain/model.ts'
import { button, el, hours, row, text } from './dom.ts'

export function calendarMonths(days: MissingDay[]): string[] {
  return [...new Set(days.map(day => validDate(day.date).slice(0, 7)))].sort()
}

export function calendarDates(month: string): (string | null)[][] {
  validDate(month + '-01')
  const first = new Date(month + '-01T00:00:00Z')
  const offset = (first.getUTCDay() + 6) % 7
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  const cells: (string | null)[] = Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, i) => {
    const day = i - offset + 1
    return day >= 1 && day <= count ? month + '-' + String(day).padStart(2, '0') : null
  })
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
}

export function calendarLabels(day?: MissingDay): { attendance: string; registration: string } {
  if (!day) return { attendance: '未查询', registration: '' }
  if (day.state === 'not_required') return { attendance: '无考勤', registration: '无需工时' }
  const attendance = day.budget === null ? '考勤待核实' : '考勤 ' + hours(day.budget)
  const registration = day.existing === 0 ? '未登记' :
    day.state === 'partial' ? '部分登记 ' + hours(day.existing) : '已登记 ' + hours(day.existing)
  return { attendance, registration }
}

export function hoursCalendar(options: {
  days: MissingDay[]; month: string; selected: string | null; busy: boolean
  changeMonth(month: string): void; chooseDate(date: string): void
}): HTMLElement {
  const months = calendarMonths(options.days)
  if (!months.length) return text('查询范围内没有日期。', true)
  const month = months.includes(options.month) ? options.month : months[months.length - 1]!
  const index = months.indexOf(month)
  const byDate = new Map(options.days.map(day => [day.date, day]))
  const title = month.replace('-', '年') + '月'
  const caption = el('caption', '', title)
  const table = el('table', 'hours-calendar-table', caption)
  const header = el('tr')
  for (const name of ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) {
    const cell = el('th', '', name)
    cell.scope = 'col'
    header.append(cell)
  }
  table.append(el('thead', '', header))
  const body = el('tbody')
  for (const week of calendarDates(month)) {
    const tr = el('tr')
    for (const date of week) {
      const td = el('td')
      if (!date) { td.className = 'calendar-empty'; tr.append(td); continue }
      const day = byDate.get(date)
      const labels = calendarLabels(day)
      const content = [
        el('span', 'calendar-date', String(Number(date.slice(-2)))),
        el('span', 'calendar-attendance', labels.attendance),
        el('span', 'calendar-registration', labels.registration)
      ]
      const selectable = day && day.state !== 'not_required'
      const cell = selectable ? button('', () => options.chooseDate(date), options.busy, 'calendar-day') : el('div', 'calendar-day')
      cell.append(...content)
      cell.setAttribute('aria-label', `${date}，${labels.attendance}，${labels.registration}`)
      cell.classList.add('calendar-' + (day?.state ?? 'unqueried'))
      if (date === options.selected && selectable) {
        cell.classList.add('calendar-selected')
        cell.setAttribute('aria-pressed', 'true')
      } else if (selectable) cell.setAttribute('aria-pressed', 'false')
      if (day) cell.title = [date, day.attendanceTime ? `${day.attendanceTime.start}—${day.attendanceTime.end}` : '', day.reason].filter(Boolean).join(' · ')
      td.append(cell)
      tr.append(td)
    }
    body.append(tr)
  }
  table.append(body)
  const position = text(`${index + 1} / ${months.length} 月`, true)
  position.setAttribute('aria-live', 'polite')
  return el('section', 'hours-calendar',
    row(button('上一月', () => options.changeMonth(months[index - 1]!), options.busy || index === 0),
      position, button('下一月', () => options.changeMonth(months[index + 1]!), options.busy || index === months.length - 1)),
    table,
    text('仅有考勤的日期需要工时；点击日期核对。', true))
}
