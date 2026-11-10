import { repairProgress, repairCompletionBlocker } from '../domain/repair-report.ts'
import type { CachedRepairs } from '../repair-cache.ts'
import type { Task } from '../domain/model.ts'
import { button, card, el, message, notice, request, row, text, UIError } from './dom.ts'

/// 缓存首屏与远端同步分离；切页销毁后所有迟到响应失效。
export class ImplementationView {
  readonly element = el('div', 'stack')
  private controller = new AbortController()
  private generation = 0
  private disposed = false
  private data?: CachedRepairs
  private status = '正在读取本地执行记录…'
  private failed = false
  private busy = false
  private timer?: ReturnType<typeof setInterval>
  private ticks = 0
  constructor(private team: string, private openDetail: (task: Task, updateStatus?: boolean) => void) {
    void this.load()
    this.timer = setInterval(() => {
      if (!this.busy && !this.disposed) void this.poll(++this.ticks % 12 === 0)
    }, 5000)
  }
  /// 取消本页读取；共享后台同步可继续，但不能更新已销毁页面。
  dispose() {
    this.disposed = true
    this.generation++
    this.controller.abort()
    clearInterval(this.timer)
  }
  /// 所有远端业务动作仍由详情重新鉴权，缓存不是写入授权。
  private render() {
    const data = this.data
    this.element.replaceChildren(
      row(el('h2', '', '执行记录'), button('刷新执行记录', () => this.load(true), this.busy)),
      this.failed ? notice(this.status, true) : text(`${this.busy ? '正在同步' : '本地记录'}${data?.syncedAt ? ` · 上次更新 ${new Date(data.syncedAt).toLocaleTimeString()}` : ' · 首次同步中'}`, true),
      ...((data?.items.length ?? 0) ? data!.items.map(({ task, record, report, reportError }) => card(
        `#${task.number} ${task.name}`,
        text(report ? repairProgress(report) : record.state === 'sent' ? '已发起 · 等待修复回执' : '启动结果待核实，不会重复发送'),
        ...(report && repairCompletionBlocker(report) ? [notice(repairCompletionBlocker(report))] : report ? [text('Agent 报告验收通过，证据待人工核验', true)] : []),
        ...(reportError ? [notice('修复回执更新未接收，请在详情查看。', true)] : []),
        row(button('查看详情', () => this.openDetail(task)), button('更新状态', () => this.openDetail(task,true)))
      )) : data ? [notice(data.syncedAt ? '暂无匹配的执行记录。' : '暂无本地缓存，首次同步可能需要等待。')] : [])
    )
  }
  /// 先显示缓存，再按过期时间同步；刷新失败不抹去缓存且明确标识。
  private async load(force = false) {
    if (this.disposed || this.busy) return
    if (!this.team) { this.status = '请先登录 ONES 并选择团队。'; this.render(); return }
    this.busy = true
    const generation = ++this.generation
    this.render()
    try {
      const data = await request<CachedRepairs>('repair.cache', { team: this.team }, this.controller.signal)
      if (this.disposed || generation !== this.generation) return
      this.data = data
      this.failed = false
      this.status = '已显示本地缓存'
      this.render()
      if (force || !data.syncedAt || Date.now() - data.syncedAt >= 30000) {
        this.status = '已显示本地缓存 · 正在后台同步…'
        this.render()
        this.data = await request<CachedRepairs>('repair.sync', { team: this.team }, this.controller.signal)
        if (this.disposed || generation !== this.generation) return
        this.status = '远端同步完成'
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      if (error instanceof UIError && ['auth','forbidden','identity','stale'].includes(error.code ?? '')) this.data = undefined
      this.failed = true
      this.status = this.data ? `同步失败，当前显示上次缓存（可能过期）：${message(error)}` : `执行记录不可用：${message(error)}`
    } finally {
      if (!this.disposed && generation === this.generation) { this.busy = false; this.render() }
    }
  }
  /// 可见页每五秒接收本地回执，每分钟同步；不会后台发起修复。
  private async poll(sync: boolean) {
    if (sync) { await this.load(true); return }
    if (!this.team) return
    this.busy = true
    const generation = this.generation
    try {
      const data = await request<CachedRepairs>('repair.cache', { team: this.team }, this.controller.signal)
      if (!this.disposed && generation === this.generation) { this.data = data; this.render() }
    } catch (error) {
      if (!this.disposed && error instanceof UIError && ['auth','forbidden','identity','stale'].includes(error.code ?? '')) { this.data = undefined; this.status = message(error); this.failed = true; this.render() }
    }
    finally { this.busy = false; if (!this.disposed && generation === this.generation) this.render() }
  }
}
