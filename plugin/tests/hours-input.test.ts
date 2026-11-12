import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hoursToMinutes, minutesToHoursInput } from '../src/html/hours-input.ts'

test('hours input: decimal hours convert exactly without changing calculation or API units', () => {
  for (const [hours, minutes] of [['0.5',30], ['1',60], ['1.5',90], ['.5',30], ['1.10',66], ['0.25',15], ['0.05',3], ['16.5',990]] as const)
    assert.equal(hoursToMinutes(hours), minutes)
  for (const invalid of ['', '0', '-1', 'NaN', 'Infinity', '1e3', '1.001', '0.01', '1,5'])
    assert.throws(() => hoursToMinutes(invalid))
  assert.equal(minutesToHoursInput(30), '0.5')
  assert.equal(minutesToHoursInput(480), '8')
  assert.equal(minutesToHoursInput(990), '16.5')
})
