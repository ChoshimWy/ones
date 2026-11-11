import { DatabaseSync } from 'node:sqlite'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { ensurePrivateDirectory, assertPrivatePath } from './private-files.ts'
import { record, requireThat, validDate, minuteOfDay, text, id, type Task } from './domain/model.ts'
import { businessDate, type MissingDay } from './domain/missing-hours.ts'

export type HoursMonth = { month: string; days: MissingDay[]; savedAt: number }
/// 完整任务目录仅用于本地展示；提交仍重新验证当前任务类型及可访问性。
export type HoursTasks = { typeId: string; items: Task[]; savedAt: number }
export interface HoursMonthStore {
  read(scope: string, month: string): Promise<HoursMonth | null>
  publish(scope: string, value: HoursMonth, check: () => void): Promise<void>
  invalidate?(scope: string, month: string): Promise<void>
  readTasks?(scope: string): Promise<HoursTasks | null>
  publishTasks?(scope: string, value: HoursTasks, check: () => void): Promise<void>
}
// Store only the complete display projection, never tokens, raw punches, worklog
// descriptions. Task summaries are stored separately with explicit user authorization. The authoritative day must still be read before preview.
export function parseHoursMonth(value: unknown, month: string): HoursMonth {
  validDate(month + '-01')
  const data = record(value)
  requireThat(data.month === month && Number.isSafeInteger(data.savedAt) && (data.savedAt as number) > 0 && Array.isArray(data.days) && data.days.length > 0 && data.days.length <= 31, 'cache', '月度缓存无效，请重新读取。')
  const seen = new Set<string>()
  const days = data.days.map((value): MissingDay => {
    const row = record(value)
    const date = validDate(row.date)
    requireThat(date.startsWith(month + '-') && date <= businessDate() && !seen.has(date), 'cache', '月度缓存日期不匹配。')
    seen.add(date)
    requireThat(typeof row.existing === 'number' && Number.isFinite(row.existing) && row.existing >= 0 &&
      (row.budget === null || (typeof row.budget === 'number' && Number.isFinite(row.budget) && row.budget >= 0)) &&
      (row.remaining === null || (typeof row.remaining === 'number' && Number.isFinite(row.remaining) && row.remaining >= 0)) &&
      ['missing','partial','covered','review','not_required','pending'].includes(String(row.state)), 'cache', '月度缓存字段无效。')
    const result: MissingDay = { date, existing: row.existing, budget: row.budget as number | null, remaining: row.remaining as number | null, state: row.state as MissingDay['state'], reason: text(row.reason, 2000) }
    if (row.attendanceTime !== undefined) {
      const times = record(row.attendanceTime)
      minuteOfDay(times.start); minuteOfDay(times.end)
      result.attendanceTime = { start: times.start as string, end: times.end as string }
    }
    return result
  }).sort((a, b) => a.date.localeCompare(b.date))
  requireThat(days.every((day, index) => Number(day.date.slice(-2)) === index + 1), 'cache', '月度缓存不完整。')
  return { month, days, savedAt: data.savedAt as number }
}

export class HoursCache implements HoursMonthStore {
  private database?: DatabaseSync
  private opening?: Promise<DatabaseSync>
  constructor(private root: string) {}
  private async db(): Promise<DatabaseSync> {
    if (this.database) return this.database
    if (this.opening) return this.opening
    this.opening = (async () => {
      await ensurePrivateDirectory(this.root, '考勤缓存目录权限不安全。')
      const path = join(this.root, 'hours.sqlite')
      try { const file = await open(path, 'wx', 0o600); await file.close() }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await assertPrivatePath(path, 'file', '考勤缓存文件权限不安全。')
      const db = new DatabaseSync(path)
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;')
      const version = db.prepare('PRAGMA user_version').get()!.user_version
      if (version !== 0 && version !== 1) { db.close(); throw Error('Unsupported hours cache schema') }
      db.exec('CREATE TABLE IF NOT EXISTS tasks(scope TEXT PRIMARY KEY, data TEXT NOT NULL, saved_at INTEGER NOT NULL);');
      db.exec('CREATE TABLE IF NOT EXISTS months(scope TEXT NOT NULL, month TEXT NOT NULL, data TEXT NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY(scope,month)); PRAGMA user_version=1;')
      this.database = db
      return db
    })()
    try { return await this.opening } finally { this.opening = undefined }
  }
  async read(scope: string, month: string): Promise<HoursMonth | null> {
    validDate(month + '-01')
    const row = (await this.db()).prepare('SELECT data FROM months WHERE scope=? AND month=?').get(scope, month)
    return row ? parseHoursMonth(JSON.parse(String(row.data)), month) : null
  }
  async publish(scope: string, value: HoursMonth, check: () => void): Promise<void> {
    const data = parseHoursMonth(value, value.month)
    const db = await this.db()
    check()
    db.prepare('INSERT INTO months(scope,month,data,saved_at) VALUES(?,?,?,?) ON CONFLICT(scope,month) DO UPDATE SET data=excluded.data,saved_at=excluded.saved_at WHERE excluded.saved_at>=months.saved_at').run(scope, data.month, JSON.stringify(data), data.savedAt)
  }
  /// 写入前移除该月份摘要，避免成功或未知结果后继续使用旧的已对齐结论。
  async invalidate(scope: string, month: string): Promise<void> {
    validDate(month + '-01')
    const db = await this.db()
    db.prepare('DELETE FROM months WHERE scope=? AND month=?').run(scope, month)
  }
  /// 本地普通任务摘要读取，不进行任何云端请求。
  async readTasks(scope: string): Promise<HoursTasks | null> {
    const row = (await this.db()).prepare('SELECT data FROM tasks WHERE scope=?').get(scope)
    return row ? parseHoursTasks(JSON.parse(String(row.data))) : null
  }
  /// 完整分页且身份仍有效才原子替换任务目录，失败保留旧版本。
  async publishTasks(scope: string, value: HoursTasks, check: () => void): Promise<void> {
    const data = parseHoursTasks(value)
    const db = await this.db()
    check()
    db.prepare('INSERT INTO tasks(scope,data,saved_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data,saved_at=excluded.saved_at WHERE excluded.saved_at>=tasks.saved_at').run(scope, JSON.stringify(data), data.savedAt)
  }
  close(): void { this.database?.close(); this.database = undefined }
}

/// 校验数据库任务目录，拒绝混入其它工作项类型或重复身份。
export function parseHoursTasks(value: unknown): HoursTasks {
  const data = record(value)
  const typeId = id(data.typeId)
  requireThat(Number.isSafeInteger(data.savedAt) && Number(data.savedAt) > 0 && Array.isArray(data.items) && data.items.length <= 1000, 'cache', '任务缓存不完整。')
  const option = (value: unknown) => { const data = record(value); return { id: id(data.id), name: text(data.name) } }
  const items = data.items.map(value => {
    const task = record(value)
    const issueType = option(task.issueType)
    requireThat(issueType.id === typeId && issueType.name === '任务' && Number.isSafeInteger(task.number), 'cache', '任务缓存类型不匹配。')
    return { id: id(task.id), name: text(task.name, 2000), number: task.number as number, issueType, project: option(task.project), status: option(task.status) }
  })
  requireThat(new Set(items.map(task => task.id)).size === items.length, 'cache', '任务缓存有重复记录。')
  return { typeId, items, savedAt: data.savedAt as number }
}
