import { randomUUID, createHash } from 'node:crypto'
import { attendanceBudget, checkAllocations, apiHours, startSeconds } from './domain/attendance.ts'
import { businessDate } from './domain/missing-hours.ts'
import { requireThat, validDate, safeFailure, type Allocation } from './domain/model.ts'
import { Submission, assertNoPending, type Ledger } from './domain/submission.ts'
import { worklogWriter, type OnesClient } from './adapters/ones.ts'
import type { Day, DayInput } from './protocol.ts'

/// 一日一笔普通任务工时，日期和实际投入都必须在确认页明确列出。
export type HoursBatchRow = Allocation & { date: string }
/// Worker 生成的不可变预览；缓存和调用方参数不构成提交授权。
export type HoursBatchPreview = { id: string; expiresAt: number; rows: (HoursBatchRow & { taskName: string; budget: number; existing: number })[]; total: number }
/// 部分结果明确区分已回读、未知与未发送，禁止整批盲目重试。
export type HoursBatchResult = { rows: { date: string; state: 'verified' | 'unknown' | 'not_attempted'; message: string }[] }
/// 仅由 Workbench 构造：生产 writesVerified 固定 false，不能从请求参数修改。
export type HoursBatchContext = {
  readonly writesVerified: boolean
  identity(): string
  client(team: string): OnesClient
  fresh(input: DayInput, signal?: AbortSignal): Promise<{ data: Day; stamp: string }>
  ledger(): Ledger
  scope(client: OnesClient): string
  acquire(): void
  release(): void
  invalidate(team: string, months: string[]): Promise<void>
}

/// 批量流程复用已有账本；类自身先检查生产写入门禁，再允许任何 mutation。
export class HoursBatch {
  private confirmation?: { view: HoursBatchPreview; team: string; identity: string; stamps: string[] }
  private generation = 0
  constructor(private readonly context: HoursBatchContext) {}

  /// 身份或明确业务意图改变时废弃旧确认，不影响只读扫描。
  clear(): void {
    this.generation++
    this.confirmation = undefined
  }

  /// 重读全部日期及普通任务，形成单次可消费的确认 token。
  async preview(team: string, input: HoursBatchRow[], signal?: AbortSignal): Promise<HoursBatchPreview> {
    this.clear()
    const generation = this.generation
    const identity = this.context.identity()
    requireThat(Array.isArray(input) && input.length > 0 && input.length <= 31, 'input', '每批请选择 1～31 个日期。')
    const allocations = structuredClone(input)
    requireThat(new Set(allocations.map(row => row.date)).size === allocations.length, 'input', '批量日期不能重复。')
    const client = this.context.client(team)
    const rows: HoursBatchPreview['rows'] = []
    const stamps: string[] = []
    // 1. 每日重新核对，不把本地摘要视作写入凭据。
    for (const allocation of allocations) {
      validDate(allocation.date)
      requireThat(allocation.date < businessDate(), 'input', '当天尚未结束或日期在未来，不能批量登记。')
      requireThat(!signal?.aborted && identity === this.context.identity() && generation === this.generation, 'stale', '批量预览已失效。')
      const snapshot = await this.context.fresh({ team, date: allocation.date }, signal)
      const task = await client.ordinaryTask(allocation.taskId, signal)
      const budget = attendanceBudget(snapshot.data.attendance)
      checkAllocations([allocation], budget, snapshot.data.existing)
      rows.push({ ...allocation, taskName: task.name, budget, existing: snapshot.data.existing })
      stamps.push(snapshot.stamp)
    }
    requireThat(!signal?.aborted && identity === this.context.identity() && generation === this.generation, 'stale', '批量预览已失效。')
    const view = { id: randomUUID(), expiresAt: Date.now() + 300000, rows, total: rows.reduce((sum, row) => sum + row.minutes, 0) }
    this.confirmation = { view: structuredClone(view), team, identity, stamps }
    return view
  }

  /// 生产门禁未开放时立即拒绝；仅合成测试注入 true 可验证后续状态机。
  async submit(previewId: string, confirmed: boolean, team: string): Promise<HoursBatchResult> {
    requireThat(this.context.writesVerified === true, 'not_verified', '插件工时写入尚未完成端到端验证，当前禁止批量提交。')
    this.context.acquire()
    try {
      const confirmation = this.confirmation
      requireThat(confirmed === true && confirmation?.team === team && confirmation.view.id === previewId && confirmation.view.expiresAt > Date.now() && confirmation.identity === this.context.identity(), 'stale', '批量确认已过期，请重新预览。')
      this.confirmation = undefined
      const client = this.context.client(confirmation.team)
      const scope = this.context.scope(client)
      const ledger = this.context.ledger()
      assertNoPending(await ledger.load(), scope)
      const writer = new Submission(ledger, worklogWriter(client))
      const result: HoursBatchResult = { rows: confirmation.view.rows.map(row => ({ date: row.date, state: 'not_attempted', message: '尚未发送' })) }
      // 2. 删除旧摘要并停止旧扫描发布，未知写入也不允许沿用旧对账结论。
      await this.context.invalidate(confirmation.team, [...new Set(confirmation.view.rows.map(row => row.date.slice(0, 7)))])
      for (const [index, row] of confirmation.view.rows.entries()) {
        let sending = false
        try {
          requireThat(this.context.identity() === confirmation.identity, 'identity', '账号已变化，后续日期未提交。')
          const fresh = await this.context.fresh({ team: confirmation.team, date: row.date })
          requireThat(fresh.stamp === confirmation.stamps[index], 'stale', '考勤或已登记工时变化，请重新预览。')
          await client.ordinaryTask(row.taskId)
          const budget = attendanceBudget(fresh.data.attendance)
          checkAllocations([row], budget, fresh.data.existing)
          requireThat(this.context.identity() === confirmation.identity, 'identity', '账号已变化，未发送本笔写入。')
          const intent = { scope, date: row.date, task: row.taskId, owner: client.session.userId, hours: apiHours(row.minutes), startTime: startSeconds(row.date, row.start), description: row.description }
          const fingerprint = createHash('sha256').update(JSON.stringify([previewId, index, intent])).digest('hex')
          sending = true
          await writer.add(intent, fingerprint, fresh.data.worklogs)
          result.rows[index] = { date: row.date, state: 'verified', message: '已提交并回读一致' }
        } catch (error) {
          const pending = sending && (await ledger.load()).some(receipt => receipt.scope === scope && receipt.state !== 'verified')
          result.rows[index] = { date: row.date, state: pending ? 'unknown' : 'not_attempted', message: pending ? '写入结果需先核实，不可重试' : safeFailure(error).message }
          break
        }
      }
      return result
    } finally { this.context.release() }
  }
}
