import { createHash, randomBytes } from 'node:crypto'
import { AppError, id, record, requireThat, text, validDate, minuteOfDay, type Attendance, type Punch } from '../domain/model.ts'
import { nextAttendanceDate } from '../domain/attendance.ts'
import { COHO, Transport, jsonBody } from './http.ts'
export type CohoSession = { token: string; principal: string; label: string; expiresAt: number | null }
const TENANT = 'ATS'
function headers(token?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json;charset=UTF-8',
    Cookie: `sso_tenant_code=${TENANT}`,
    'COHO-language': 'zh-CN',
    Origin: COHO,
    Referer: `${COHO}/user/login?tenantCode=${TENANT}&sso_tenant_code=${TENANT}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}
function dataOf(result: Record<string, unknown>): Record<string, unknown> {
  // The official ATS client treats JSON code 401 as revoked authentication,
  // even when HTTP itself succeeded. Never treat ordinary business errors as logout.
  if (result.code === 401 || result.code === '401') throw new AppError('auth', 'Coho 认证已失效，请重新登录。')
  requireThat(result.code === 200, 'coho', 'Coho 认证或业务校验未通过，请重新核对账号和租户。')
  return record(result.data)
}
export async function loginCoho(transport: Transport, account: string, password: string, signal?: AbortSignal): Promise<CohoSession> {
  requireThat(account.length > 0 && account.length <= 128 && password.length > 0 && password.length <= 256, 'input', '请输入 Coho 账号和密码。')
  // Instance-specific ATS encoding, not a default for other tenants.
  const credential = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()
  const init = jsonBody({ sign: '', timeStamp: '', data: { tenantCode: TENANT, identifier: account, credential } })
  const requestedAt = Date.now()
  const result = dataOf(await transport.json('/gateway/auth/account/requestToken', { ...init, headers: headers(), signal }))
  const token = text(result.token, 16000)
  // Verified official login client: Date.now() + expTime * 1000.
  // Older/missing expiry stays unknown; never manufacture a refresh token or TTL.
  let expiresAt: number | null = null
  if (result.expTime !== undefined && result.expTime !== null) {
    const seconds = typeof result.expTime === 'string' && /^\d+$/.test(result.expTime)
      ? Number(result.expTime) : result.expTime
    requireThat(typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && Number.isSafeInteger(requestedAt + seconds * 1000), 'auth_contract', 'Coho 令牌有效期格式无效，未保存会话。')
    expiresAt = requestedAt + seconds * 1000
  }
  const user = dataOf(await transport.json('/gateway/auth/user/getCurrentUser', { headers: headers(token), signal }))
  requireThat(user.tenantCode === TENANT, 'identity', 'Coho 租户与配置不一致。')
  // ATS WorkbenchCalendar uses this authenticated USER_INFO.globalId as its employee key.
  // Verified from the instance frontend; not a rule for other tenants.
  const principal = id(user.globalId)
  // Every attendance read still checks server identity; no verified renewal API exists.
  return { token, principal, label: `Coho · ${TENANT}`, expiresAt }
}
function signed(data: Record<string, unknown>, token: string) {
  const timeStamp = Math.round(Date.now() / 1000)
  const md5 = (value: string) => createHash('md5').update(value).digest('hex')
  const key = md5(`${token}&${timeStamp}`)
  return { encodeData: randomBytes(6).toString('hex'), timeStamp, data, key, sign: md5(`${key}&${timeStamp}&${JSON.stringify(data)}`) }
}
/// 已验证整期覆盖与打卡归属；仅日期可归属的字段异常允许日级隔离。
type Calendar = { dates: Set<string>; punches: Record<string, unknown>[] }

/// 整体结构或归属不明时停止扫描，不能将未知记录当作无考勤。
function parseCalendar(value: Record<string, unknown>): Calendar {
  requireThat(Array.isArray(value.dateList) && Array.isArray(value.dkList), 'schema', 'Coho 考勤日历：dateList 或 dkList 结构无效，已停止整月更新。')
  try {
    const dates = new Set(value.dateList.map(day => validDate(record(day).date)))
    const punches = value.dkList.map(record)
    for (const punch of punches) {
      validDate(punch.date)
    }
    return { dates, punches }
  } catch {
    throw new AppError('schema', 'Coho 考勤日历：dateList.date 或 dkList.date 无法确定打卡归属，已停止整月更新。')
  }
}

/// 仅解析明确属于请求日期的字段；错误不含原始值，也不制造默认时间。
function parsePunch(value: Record<string, unknown>, date: string): Punch {
  let realDate: string
  try { realDate = validDate(value.realDate) }
  catch { throw new AppError('attendance', `${date}：打卡 realDate 缺失或格式无效，不能计算考勤时间。`) }
  try { minuteOfDay(value.time) }
  catch { throw new AppError('attendance', `${date}：打卡 time 缺失或格式无效，不能计算考勤时间。`) }
  requireThat(typeof value.isNext === 'boolean', 'attendance', `${date}：打卡 isNext 缺失或格式无效，不能计算考勤时间。`)
  return { date, realDate, time: value.time as string, isNext: value.isNext, outFence: typeof value.outFence === 'boolean' ? value.outFence : null }
}

export class CohoClient {
  constructor(private transport: Transport, readonly session: CohoSession) {}
  async assertIdentity(signal?: AbortSignal): Promise<void> {
    const user = dataOf(await this.transport.json('/gateway/auth/user/getCurrentUser', { headers: headers(this.session.token), signal }))
    requireThat(user.globalId === this.session.principal && user.tenantCode === TENANT, 'identity', 'Coho 登录身份已变化。')
  }
  /// 单日业务读取始终使用新会话，不复用扫描中的原始考勤快照。
  async attendance(date: string, signal?: AbortSignal): Promise<Attendance> {
    return this.attendanceReader()(date, signal)
  }
  /// 单次只读同步内复用已明确覆盖日期的整期响应，避免重复下载同一期。
  attendanceReader(): (date: string, signal?: AbortSignal) => Promise<Attendance> {
    const calendars = new Map<string, Calendar>()
    let verified = false
    return async (date, signal) => {
      validDate(date)
      if (!verified) {
        await this.assertIdentity(signal)
        verified = true
      }
      const request = async (path: string, data: Record<string, unknown>) => dataOf(await this.transport.json(path, { ...jsonBody(signed(data, this.session.token)), headers: headers(this.session.token), signal }))
      const readCalendar = async (day: string): Promise<Calendar> => {
        let calendar = [...calendars.values()].find(value => value.dates.has(day))
        if (!calendar) {
          const period = await request('/gateway/wtspro-attendance/attQishu/getInfoByDateAndUser', { curDate: day, empId: this.session.principal })
          requireThat(typeof period.kqqs === 'string' && period.kqqs.length > 0 && period.kqqs.length <= 100, 'schema', `Coho 考勤期间查询（${day}）：kqqs 缺失或格式无效，已停止整月更新。`)
          const kqqs = period.kqqs
          calendar = calendars.get(kqqs)
          if (!calendar) {
            calendar = parseCalendar(await request('/gateway/wtspro-attendance/attSummaryComfirm/attCalendar', { userId: this.session.principal, kqqsId: kqqs, kqqs }))
            calendars.set(kqqs, calendar)
          }
        }
        requireThat(calendar.dates.has(day), 'attendance', `${date}：考勤 dateList 未覆盖 ${day}，覆盖未知，不能计算考勤时间。`)
        return calendar
      }
      const next = nextAttendanceDate(date)
      const sources = new Set([await readCalendar(date), await readCalendar(next)])
      const punches: Punch[] = []
      const previousKeys = new Set<string>()
      for (const calendar of sources) {
        const keys: string[] = []
        for (const value of calendar.punches) {
          // Malformed nearby records remain review-only; never drop an unknown punch.
          const nearby = value.realDate === date || value.realDate === next || value.date === date || value.date === next
          if (!nearby) continue
          const punch = parsePunch(value, value.date as string)
          const minute = minuteOfDay(punch.time)
          const inWindow = (punch.realDate === date && minute >= 480) || (punch.realDate === next && minute < 480)
          if (!inWindow) continue
          const key = JSON.stringify([punch.date, punch.realDate, punch.time, punch.isNext, punch.outFence])
          keys.push(key)
          // Same period is read once; overlapping period responses must not duplicate punches.
          if (!previousKeys.has(key)) punches.push(punch)
        }
        for (const key of keys) previousKeys.add(key)
      }
      punches.sort((a, b) => a.realDate.localeCompare(b.realDate) || a.time.localeCompare(b.time))
      requireThat(punches.length > 0, 'no_attendance', '所选日期无打卡记录，禁止默认填入 8 小时。')
      return { date, punches, fetchedAt: Date.now() }
    }
  }
}
