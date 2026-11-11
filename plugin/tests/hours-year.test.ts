import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recentHoursMonths, alignedHoursMonth, hoursTotals } from '../src/domain/hours-year.ts'
import { monthDates } from '../src/domain/missing-hours.ts'
import type { HoursMonth } from '../src/hours-cache.ts'

test('hours year: twelve calendar months and strict historical reconciliation', () => {
  const now = new Date('2026-01-15T00:00:00Z')
  const months = recentHoursMonths(now)
  assert.equal(months.length, 12)
  assert.equal(months[0], '2026-01')
  assert.equal(months.at(-1), '2025-02')
  assert.throws(() => monthDates('0000-01', now))
  assert.throws(() => monthDates(['2025-02'] as unknown as string, now))
  const value: HoursMonth = { month: '2025-02', savedAt: 1, days: monthDates('2025-02', now).map(date => ({ date, existing: 0, budget: 0, remaining: 0, state: 'not_required', reason: 'fixture' })) }
  assert.equal(alignedHoursMonth(value, now), true)
  assert.equal(alignedHoursMonth({ ...value, days: value.days.slice(1) }, now), false)
  for (const changed of [{ state: 'review' as const }, { state: 'pending' as const }, { existing: 480 }, { budget: null }])
    assert.equal(alignedHoursMonth({ ...value, days: [{ ...value.days[0]!, ...changed }, ...value.days.slice(1)] }, now), false)
  assert.equal(alignedHoursMonth({ ...value, month: '2026-01' }, now), false)
  assert.deepEqual(hoursTotals([{ ...value.days[0]!, state: 'missing', remaining: 480 }, { ...value.days[1]!, state: 'partial', remaining: 120 }, { ...value.days[2]!, state: 'review' }]), { count: 2, minutes: 600, review: 1 })
})
