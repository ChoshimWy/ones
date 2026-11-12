import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CohoClient } from '../src/adapters/coho.ts'
import { COHO, Transport } from '../src/adapters/http.ts'
import { attendanceBudget, attendanceDayEnded, nextAttendanceDate, resolveAttendance } from '../src/domain/attendance.ts'
import { classifyDay } from '../src/domain/missing-hours.ts'
import { alignedHoursMonth } from '../src/domain/hours-year.ts'
import type { Attendance, Punch } from '../src/domain/model.ts'

const punch = (date: string, time: string): Punch => ({ date, realDate: date, time, isNext: false, outFence: false })
test('attendance window: overnight overtime, display endpoints, cutoff and chronological order', () => {
  const date = '2026-11-06'
  const day: Attendance = { date, fetchedAt: 1, punches: [punch('2026-11-07', '05:00'), punch(date, '09:00')] }
  assert.deepEqual(resolveAttendance(day), { start: '09:00', end: '05:00', endNextDay: true, budget: 1080 })
  assert.deepEqual(classifyDay(day, 0).attendanceTime, { start: '09:00', end: '05:00', endNextDay: true })
  for (const [time, budget] of [['00:00', 780], ['04:59', 1050], ['05:00', 1080], ['07:59', 1230]] as const) {
    assert.equal(attendanceBudget({ ...day, punches: [punch(date, '09:30'), punch('2026-11-07', time)] }), budget - 30)
  }
  assert.throws(() => attendanceBudget({ ...day, punches: [punch(date, '09:00'), punch('2026-11-07', '08:00')] }))
  assert.throws(() => attendanceBudget({ ...day, punches: [punch(date, '07:59'), punch(date, '18:30')] }))
  assert.equal(attendanceBudget({ ...day, punches: [punch(date, '08:00'), punch(date, '18:30')] }), 480)
  assert.equal(attendanceBudget({ ...day, punches: [punch(date, '09:00'), { ...punch(date, '05:00'), realDate: '2026-11-07', isNext: true }] }), 1080)
  assert.equal(classifyDay({ ...day, punches: [...day.punches, punch(date, '12:30')] }, 0).state, 'review')
})

test('attendance window: business day closes at next 08:00 Shanghai across month/year/leap boundaries', () => {
  for (const [date, next] of [['2026-11-30','2026-12-01'], ['2026-12-31','2027-01-01'], ['2024-02-29','2024-03-01']]) {
    assert.equal(nextAttendanceDate(date!), next)
    assert.equal(attendanceDayEnded(date!, Date.parse(next + 'T07:59:59+08:00')), false)
    assert.equal(attendanceDayEnded(date!, Date.parse(next + 'T08:00:00+08:00')), true)
  }
  const days = Array.from({length: 30}, (_, i) => ({ date: '2026-11-' + String(i+1).padStart(2,'0'), budget:480, existing:480, remaining:0, state:'covered' as const, reason:'' }))
  assert.equal(alignedHoursMonth({month:'2026-11', days, savedAt:1}, new Date('2026-12-01T07:59:59+08:00')), false)
  assert.equal(alignedHoursMonth({month:'2026-11', days, savedAt:1}, new Date('2026-12-01T08:00:00+08:00')), true)
})

test('attendance window: adapter reads both periods, excludes next 08:00 and refreshes authoritative single day', async () => {
  const requests: string[] = []
  let requested = ''
  const client = new CohoClient(new Transport(COHO, async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('getCurrentUser')) return Response.json({code:200,data:{globalId:'owner',tenantCode:'ATS'}})
    const {data} = JSON.parse(String(init?.body))
    if (path.endsWith('getInfoByDateAndUser')) {
      requested=data.curDate
      requests.push(requested)
      return Response.json({code:200,data:{kqqs:requested.slice(0,7)}})
    }
    assert.ok(path.endsWith('attCalendar'))
    const dates = data.kqqs === '2026-11' ? ['2026-11-30'] : ['2026-12-01','2026-12-02']
    const punches = data.kqqs === '2026-11' ? [punch('2026-11-30','07:59'),punch('2026-11-30','09:00')] : [punch('2026-12-01','05:00'),punch('2026-12-01','08:00'),punch('2026-12-01','18:30')]
    return Response.json({code:200,data:{dateList:dates.map(date=>({date})),dkList:punches}})
  }), {token:'fake',principal:'owner',label:'fixture',expiresAt:null})
  const reader = client.attendanceReader()
  const first = await reader('2026-11-30')
  assert.deepEqual(first.punches.map(p=>p.time), ['09:00','05:00'])
  assert.equal(attendanceBudget(first),1080)
  const next = await reader('2026-12-01')
  assert.deepEqual(next.punches.map(p=>p.time),['08:00','18:30'])
  assert.deepEqual(requests,['2026-11-30','2026-12-01'])
  await client.attendance('2026-11-30')
  assert.equal(requests.length,4)
})

test('attendance window: absent next-day coverage is not treated as a complete day', async () => {
  const client = new CohoClient(new Transport(COHO, async (url) => {
    const path = new URL(String(url)).pathname
    const data = path.endsWith('getCurrentUser') ? {globalId:'owner',tenantCode:'ATS'} : path.endsWith('getInfoByDateAndUser') ? {kqqs:'period'} : {dateList:[{date:'2026-11-06'}],dkList:[punch('2026-11-06','09:00'),punch('2026-11-06','18:30')]}
    return Response.json({code:200,data})
  }), {token:'fake',principal:'owner',label:'fixture',expiresAt:null})
  await assert.rejects(client.attendance('2026-11-06'), {code:'attendance'})
})
