import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calendarDates, calendarLabels, calendarMonths } from '../src/html/hours-calendar.ts'
import type { MissingDay } from '../src/domain/missing-hours.ts'
const day: MissingDay = { date: '2026-11-02', existing: 0, budget: 480, remaining: 480, state: 'missing', reason: 'fixture' }
test('hours calendar: Monday first, complete months, leap year and no invented adjacent dates', () => {
  const weeks = calendarDates('2026-11')
  assert.deepEqual(weeks[0], [null, null, null, null, null, null, '2026-11-01'])
  assert.equal(weeks[1]![0], '2026-11-02')
  assert.equal(weeks.flat().filter(Boolean).length, 30)
  assert.equal(calendarDates('2024-02').flat().filter(Boolean).length, 29)
  assert.equal(calendarDates('2026-02').flat().filter(Boolean).length, 28)
  assert.throws(() => calendarDates('2026-13'))
})
test('hours calendar: ordered queried months and truthful attendance/registration states', () => {
  assert.deepEqual(calendarMonths([day, { ...day, date: '2026-10-31' }, day]), ['2026-10', '2026-11'])
  assert.deepEqual(calendarLabels(day), { attendance: '考勤 8 小时', registration: '未登记' })
  assert.match(calendarLabels({ ...day, state: 'covered', existing: 480 }).registration, /已登记 8 小时/)
  assert.match(calendarLabels({ ...day, state: 'partial', existing: 120 }).registration, /部分登记 2 小时/)
  assert.equal(calendarLabels({ ...day, state: 'not_required', budget: 0 }).registration, '无需工时')
  assert.equal(calendarLabels({ ...day, state: 'review', budget: null }).attendance, '考勤待核实')
  assert.equal(calendarLabels().attendance, '未查询')
})
