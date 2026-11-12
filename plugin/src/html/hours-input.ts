import { UIError } from './dom.ts'

/// UI uses decimal hours; the established service contract keeps exact integer minutes.
export function hoursToMinutes(value: string): number {
  const source = value.trim()
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(source))
    throw new UIError('请输入有效的小时数，例如 0.5、1、1.5。')
  const [whole = '0', fraction = ''] = source.split('.')
  const hundredths = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(hundredths) || hundredths <= 0 || hundredths % 5 !== 0)
    throw new UIError('工时须大于 0，并使用 0.05 小时的倍数，例如 0.5、1、1.5。')
  const minutes = hundredths / 5 * 3
  if (!Number.isSafeInteger(minutes)) throw new UIError('工时时长超出有效范围。')
  return minutes
}

export function minutesToHoursInput(minutes: number): string {
  return String(Number((minutes / 60).toFixed(2)))
}
