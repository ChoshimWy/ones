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
  constructor(private team: string, private openDetail: (task: Task) => void) {
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
      text('当前团队本人负责 Bug 的本地执行记录；缓存可能过期，远端状态在后台同步。', true),
      notice(this.status, this.failed),
      text(data?.syncedAt ? `上次同步：${new Date(data.syncedAt).toLocaleString()} · 缓存快照，非实时授权` : '尚未完成远端同步', true),
      notice('Agent 回执属于自报结果；验证证据待核验，不会自动更改 ONES 状态。'),
      ...((data?.items.length ?? 0) ? data!.items.map(({ task, record, report, reportError }) => card(
        `#${task.number} ${task.name}`,
        notice(report ? report.outcome === 'passed' ? 'Agent 报告修复与验证通过 · 证据待核验' : report.outcome === 'failed' ? 'Agent 报告验证失败' : 'Agent 报告受阻' : record.state === 'sent' ? '已发起 · 等待 Agent 回执' : '待核实 · 启动或发送结果不明', report ? report.outcome !== 'passed' : record.state !== 'sent'),
        text(`ONES 状态（快照）：${task.status.name} · ${task.project.name}`, true),
        text(`执行时间：${new Date(record.createdAt).toLocaleString()}`),
        text(`目标项目：${record.projectName}`),
        ...(record.sessionId ? [text(`Session：${record.sessionId}`, true)] : []),
        ...(report ? [text(report.summary), text(`源码身份：${report.sourceIdentity}`, true), ...report.evidence.map(item => text(item, true))] : []),
        ...(reportError ? [notice(reportError, true)] : []),
        button('查看 Bug 详情', () => this.openDetail(task))
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
