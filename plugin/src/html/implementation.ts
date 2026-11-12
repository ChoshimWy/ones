import { repairProgress } from '../domain/repair-report.ts'
import type { CachedRepairs } from '../repair-cache.ts'
import type { Task } from '../domain/model.ts'
import { button, el, message, notice, request, row, text, UIError } from './dom.ts'

// 仅用于文字着色；业务状态名称仍使用 ONES 原值，未知状态不猜测。
const statusTones: Record<string, string> = {
  '待处理': 'pending',
  '确认': 'confirmed',
  '已确认': 'confirmed',
  '修复中': 'repairing',
  '已修复': 'fixed',
  '已关闭': 'closed',
  '重新打开': 'reopened'
}
function bugStatus(task: Task): HTMLElement {
  const name = task.status.name.trim() || '未知状态'
  return el('span', `implementation-status status-${statusTones[name] ?? 'unknown'}`, name)
}

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
  private restoredScroll = false
  constructor(
    private team: string,
    private openDetail: (task: Task, updateStatus?: boolean) => void,
    private initialScroll = 0
  ) {
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
  /// 完整缓存连续展示；轮询刷新保留滚动位置，不额外发起网络请求。
  private render() {
    const data = this.data
    const items = data?.items ?? []
    const scroll = this.restoredScroll ? window.scrollY : this.initialScroll
    const horizontalScroll = this.element.querySelector('.bug-items')?.scrollLeft ?? 0
    this.element.replaceChildren(
      row(el('h2', '', '执行记录'), button('刷新执行记录', () => this.load(true), this.busy)),
      this.failed ? notice(this.status, true) : text(`${this.busy ? '正在同步' : '本地记录'}${data?.syncedAt ? ` · 上次更新 ${new Date(data.syncedAt).toLocaleTimeString()}` : ' · 首次同步中'}`, true),
      ...(items.length ? [this.renderItems(items)] : data ? [notice(data.syncedAt ? '暂无匹配的执行记录。' : '暂无本地缓存，首次同步可能需要等待。')] : []),
      text(`共 ${items.length} 条执行记录`, true)
    )
    requestAnimationFrame(() => {
      if (this.disposed || !this.element.isConnected) return
      window.scrollTo(0, scroll)
      const region = this.element.querySelector('.bug-items')
      if (region) region.scrollLeft = horizontalScroll
      if (data || this.failed) this.restoredScroll = true
    })
  }
  /// 与 Bug 列表共用紧凑表格样式；详细验证信息保留在详情页。
  private renderItems(items: CachedRepairs['items']): HTMLElement {
    const headings = ['编号', '标题', 'Bug 状态', '修复进度', '操作'].map(label => {
      const heading = el('th', '', label)
      heading.scope = 'col'
      return heading
    })
    const rows = items.map(({ task, record, report, reportError }) => {
      const detail = button('', () => this.openDetail(task), false, 'bug-item')
      detail.title = task.name
      detail.setAttribute('aria-label', `查看 Bug #${task.number} ${task.name} 的详情`)
      detail.append(el('span', 'bug-item-title', task.name))
      const progress = report ? repairProgress(report) : record.state === 'sent' ? '等待修复回执' : '启动结果待核实'
      const update = button('更新状态', () => this.openDetail(task, true))
      const recordRow = el('tr', 'bug-table-row',
        el('td', 'bug-table-number', `#${task.number}`),
        el('td', 'bug-table-title', detail),
        el('td', '', bugStatus(task)),
        el('td', 'implementation-progress', progress,
          reportError ? el('span', 'implementation-receipt-error', '回执异常，请查看详情') : null),
        el('td', '', update))
      recordRow.addEventListener('click', event => {
        if (!detail.contains(event.target as Node) && !update.contains(event.target as Node)) detail.click()
      })
      return recordRow
    })
    const region = el('div', 'bug-items', el('table', 'bug-table implementation-table',
      el('caption', 'sr-only', '实施列表'),
      el('thead', '', el('tr', '', ...headings)),
      el('tbody', '', ...rows)))
    region.tabIndex = 0
    region.setAttribute('role', 'region')
    region.setAttribute('aria-label', '实施表格，可横向滚动查看全部列')
    return region
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
