import { RepairEvidence } from './repair-evidence.ts'
import { isDeepStrictEqual } from 'node:util'
import { parseRepairReport, repairAcceptance, isNotApplicable, type RepairReport } from './domain/repair-report.ts'
export type { RepairReport } from './domain/repair-report.ts'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError, requireThat, record, type Task } from './domain/model.ts'
import type { RepairListItem, RepairRecord } from './repair.ts'

/// Agent 回执只是报告，不等价于独立验证证据通过。
/// scope 包含站点、团队与账号；远端快照与本地修复状态分离。
export type CachedRepairs = { items: RepairListItem[]; syncedAt: number | null; reconciledAt: number | null; version: number }
/// 单次回执能力只授权指定 run，不能访问 ONES 或任意数据库字段。
export type ReceiptContract = { runId: string; revision: string; token: string; resultFile: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/// SQLite 为展示投影；JSON 启动账本继续独立负责防重发。仅 Worker 写入本库。
export class RepairCache {
  private database?: DatabaseSync
  private opening?: Promise<DatabaseSync>
  constructor(private root: string, private evidence = new RepairEvidence()) {}
  /// 惰性创建私有目录，拒绝符号链接及未知数据库版本，不迁移其它数据。
  private async db(): Promise<DatabaseSync> {
    if (this.database) return this.database
    if (this.opening) return this.opening
    this.opening = (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const dir = await lstat(this.root)
      requireThat(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid?.() && (dir.mode & 0o077) === 0, 'storage', '执行缓存目录权限不安全。')
      const path = join(this.root, 'cache.sqlite')
      try { const file = await open(path, 'wx', 0o600); await file.close() }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const file = await lstat(path)
      requireThat(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.uid === process.getuid?.() && (file.mode & 0o077) === 0, 'storage', '执行缓存文件权限不安全。')
      const db = new DatabaseSync(path)
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;')
      const version = db.prepare('PRAGMA user_version').get()!.user_version
      if (version !== 0 && version !== 1) { db.close(); throw Error('Unsupported repair cache schema') }
      db.exec(`CREATE TABLE IF NOT EXISTS repairs(scope TEXT NOT NULL, task_id TEXT NOT NULL, task TEXT NOT NULL, receipt TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1, run_id TEXT, revision TEXT, token_hash TEXT, result_file TEXT, report TEXT, report_error TEXT, PRIMARY KEY(scope,task_id));
        CREATE TABLE IF NOT EXISTS sync(scope TEXT PRIMARY KEY, synced_at INTEGER, reconciled_at INTEGER, version INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS report_history(scope TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, report TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(scope,task_id,run_id,sequence));
        PRAGMA user_version=1;`)
      this.database = db
      return db
    })()
    try { return await this.opening } finally { this.opening = undefined }
  }
  /// 关闭用于测试或宿主生命周期；不删除持久数据。
  close(): void { this.database?.close(); this.database = undefined }
  /// 网络不可用也可读取本账号缓存；调用方仍须验证本地登录身份。
  async read(scope: string): Promise<CachedRepairs> {
    const db = await this.db()
    const rows = db.prepare('SELECT task,receipt,report,report_error FROM repairs WHERE scope=? AND visible=1').all(scope)
    const sync = db.prepare('SELECT synced_at,reconciled_at,version FROM sync WHERE scope=?').get(scope)
    return { version: Number(sync?.version ?? 0), items: rows.map(row => ({ task: JSON.parse(String(row.task)), record: JSON.parse(String(row.receipt)), ...(row.report ? { report: JSON.parse(String(row.report)) } : {}), ...(row.report_error ? { reportError: String(row.report_error) } : {}) })).sort((a,b) => b.record.createdAt-a.record.createdAt), syncedAt: sync?.synced_at == null ? null : Number(sync.synced_at), reconciledAt: sync?.reconciled_at == null ? null : Number(sync.reconciled_at) }
  }
  /// 隐藏的历史任务也定向对账，重新分配回来时可恢复显示。
  async targets(scope: string): Promise<RepairListItem[]> {
    const rows = (await this.db()).prepare('SELECT task,receipt FROM repairs WHERE scope=?').all(scope)
    return rows.map(row => ({ task: JSON.parse(String(row.task)), record: JSON.parse(String(row.receipt)) }))
  }
  /// 仅完整读取后发布快照；缺失任务隐藏而非删除修复历史。
  async publish(scope: string, items: RepairListItem[], reconcile: boolean, check: () => void, expectedVersion: number): Promise<void> {
    const db = await this.db()
    check()
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare('SELECT version FROM sync WHERE scope=?').get(scope)
      requireThat(Number(current?.version ?? 0) === expectedVersion, 'stale', '同步期间执行记录已更新，请重新刷新。')
      db.prepare('UPDATE repairs SET visible=0 WHERE scope=?').run(scope)
      for (const item of items) db.prepare('INSERT INTO repairs(scope,task_id,task,receipt) VALUES(?,?,?,?) ON CONFLICT(scope,task_id) DO UPDATE SET task=excluded.task,receipt=excluded.receipt,visible=1').run(scope, item.task.id, JSON.stringify(item.task), JSON.stringify(item.record))
      db.prepare('INSERT INTO sync(scope,synced_at,reconciled_at,version) VALUES(?,?,?,1) ON CONFLICT(scope) DO UPDATE SET synced_at=excluded.synced_at,reconciled_at=COALESCE(excluded.reconciled_at,sync.reconciled_at),version=sync.version+1').run(scope, Date.now(), reconcile ? Date.now() : null)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  /// 服务明确拒绝身份或权限时隐藏缓存，防止本地轮询重新显示已撤销数据。
  async revoke(scope: string): Promise<void> {
    const db = await this.db()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE repairs SET visible=0 WHERE scope=?').run(scope)
      db.prepare('UPDATE sync SET version=version+1 WHERE scope=?').run(scope)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  /// 启动前登记绑定，使瞬时完成的回执也可恢复；不更改防重发账本。
  async register(scope: string, task: Task, receipt: RepairRecord, revision: string, directory: string): Promise<ReceiptContract> {
    const db = await this.db()
    const runId = randomUUID(), token = randomBytes(32).toString('hex'), resultFile = join(directory, 'result.json')
    db.exec('BEGIN IMMEDIATE')
    try {
    db.prepare('INSERT INTO repairs(scope,task_id,task,receipt,run_id,revision,token_hash,result_file) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,task_id) DO UPDATE SET task=excluded.task,receipt=excluded.receipt,visible=1,run_id=excluded.run_id,revision=excluded.revision,token_hash=excluded.token_hash,result_file=excluded.result_file,report=NULL,report_error=NULL').run(scope,task.id,JSON.stringify(task),JSON.stringify(receipt),runId,revision,hash(token),resultFile)
    db.prepare('INSERT INTO sync(scope,version) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET version=sync.version+1').run(scope)
    db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return { runId, revision, token, resultFile }
  }
  /// 预发送失败撤销本次投影；只有确实未调用 launch 才允许调用。
  async abandon(scope: string, taskId: string): Promise<void> {
    const db = await this.db()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM repairs WHERE scope=? AND task_id=?').run(scope,taskId)
      db.prepare('UPDATE sync SET version=version+1 WHERE scope=?').run(scope)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  /// 更新发送回执，不改变已有 Agent 报告或授权版本。
  async launched(scope: string, taskId: string, receipt: RepairRecord): Promise<void> {
    const db = await this.db()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE repairs SET receipt=? WHERE scope=? AND task_id=?').run(JSON.stringify(receipt),scope,taskId)
      db.prepare('UPDATE sync SET version=version+1 WHERE scope=?').run(scope)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  /// 私有结果文件支持插件关闭后写入；同 run 序号单调更新，同序号同内容幂等，保留最近二十条审计。
  async consume(scope: string, check: () => void): Promise<void> {
    const db = await this.db()
    const rows = db.prepare('SELECT task_id,run_id,revision,token_hash,result_file,report FROM repairs WHERE scope=? AND run_id IS NOT NULL').all(scope)
    for (const row of rows) {
      // 已接受旧协议只读保留，不尝试升级或推断历史四项。
      if (row.report && !('reportSequence' in JSON.parse(String(row.report)))) continue
      check()
      let handle
      try {
        handle = await open(String(row.result_file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const st = await handle.stat()
        requireThat(st.isFile() && st.nlink === 1 && st.uid === process.getuid?.() && (st.mode & 0o077) === 0 && st.size <= 64000, 'receipt', '回执文件类型、权限或大小不符合要求。')
        const value = record(JSON.parse(await handle.readFile('utf8')))
        requireThat(value.runId === row.run_id && value.revision === row.revision && typeof value.token === 'string' && hash(value.token) === row.token_hash, 'receipt', '回执不属于本次任务或输入版本。')
        const {runId, revision, token, ...payload} = value
        // 已接受 v2 的原文件保留可读；只允许显式 v3 更高序号更新，不重新接纳旧协议。
        if (payload.reportVersion === 2 && row.report && isDeepStrictEqual(payload, JSON.parse(String(row.report)))) continue
        const report = parseRepairReport(payload)
        if (isNotApplicable(report.validation.unitTests)) {
          // 只阻止已明确要求单测的历史；旧 v2 无受管引用并不等于已执行测试。
          const history = db.prepare('SELECT report FROM report_history WHERE scope=? AND task_id=? AND run_id=?').all(scope,String(row.task_id),String(row.run_id))
          if (row.report) history.push({report:row.report})
          for (const item of history) {
            const prior = await this.evidence.project(JSON.parse(String(item.report)))
            const tests = repairAcceptance(prior)
            requireThat(prior?.acceptanceEvidence?.state !== 'pending' && (!tests || isNotApplicable(tests) || tests.total === 0), 'acceptance', '本次执行已有单元测试要求或测试证据待核对，不能改为无需单元测试。')
          }
        }
        check()
        // 同一事务重读最新序号，跨 Worker 的迟到旧报告也不能覆盖新报告。
        db.exec('BEGIN IMMEDIATE')
        try {
          const current = db.prepare('SELECT run_id,report FROM repairs WHERE scope=? AND task_id=?').get(scope,String(row.task_id))
          requireThat(current?.run_id === row.run_id, 'receipt', '执行轮次已变化，未接收旧回执。')
          requireThat(!isNotApplicable(report.validation.unitTests) || current.report === row.report, 'receipt', '核对不适用期间报告已变化，请重新接收。')
          const previous = current.report ? JSON.parse(String(current.report)) : undefined
          requireThat(!previous || ('reportSequence' in previous && report.reportSequence >= previous.reportSequence), 'receipt', '旧报告序号不能覆盖最新结果。')
          requireThat(!previous || report.reportSequence !== previous.reportSequence || JSON.stringify(report) === JSON.stringify(previous), 'receipt', '同一报告序号的内容不可变更。')
          // 导入旧报告的审计锚点仅复制已有内容，不改变原序号或推断结果。
          if (previous?.reportSequence) db.prepare('INSERT OR IGNORE INTO report_history(scope,task_id,run_id,sequence,report,received_at) VALUES(?,?,?,?,?,?)').run(scope,String(row.task_id),String(row.run_id),previous.reportSequence,String(current.report),Date.now())
          const encoded = JSON.stringify(report)
          db.prepare('INSERT OR IGNORE INTO report_history(scope,task_id,run_id,sequence,report,received_at) VALUES(?,?,?,?,?,?)').run(scope,String(row.task_id),String(row.run_id),report.reportSequence,encoded,Date.now())
          db.prepare('UPDATE repairs SET report=?,report_error=NULL WHERE scope=? AND task_id=? AND run_id=?').run(encoded,scope,String(row.task_id),String(row.run_id))
          // 最近二十条之外，最多保留两个防降级锚点，避免零占位更新挤掉既有单测要求。
          db.prepare(`DELETE FROM report_history WHERE scope=?1 AND task_id=?2 AND run_id=?3
            AND sequence NOT IN (SELECT sequence FROM report_history WHERE scope=?1 AND task_id=?2 AND run_id=?3 ORDER BY sequence DESC LIMIT 20)
            AND sequence NOT IN (SELECT MIN(sequence) FROM report_history WHERE scope=?1 AND task_id=?2 AND run_id=?3 AND json_extract(report,'$.validation.unitTests.total')>0 HAVING MIN(sequence) IS NOT NULL)
            AND sequence NOT IN (SELECT MIN(sequence) FROM report_history WHERE scope=?1 AND task_id=?2 AND run_id=?3 AND json_extract(report,'$.reportVersion')=2 AND EXISTS (SELECT 1 FROM json_each(report,'$.validation.evidence') WHERE value LIKE '%/data/apple/%') HAVING MIN(sequence) IS NOT NULL)`).run({'1':scope,'2':String(row.task_id),'3':String(row.run_id)})
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          check()
          db.prepare('UPDATE repairs SET report_error=? WHERE scope=? AND task_id=? AND run_id=? ').run(error instanceof AppError && error.code === 'acceptance' ? error.message : '回执未接收：格式、身份、权限或证据不符合协议；可修正结果文件后重试。',scope,String(row.task_id),String(row.run_id))
        }
      } finally { await handle?.close() }
    }
  }
}
