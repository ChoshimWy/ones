import type { RepairListItem } from '../repair.ts'
import type { Task } from '../domain/model.ts'
import { button, card, el, message, notice, request, row, text } from './dom.ts'

export class ImplementationView {
  readonly element = el('div', 'stack')
  private controller = new AbortController()
  private generation = 0
  private disposed = false
  constructor(private team: string, private openDetail: (task: Task) => void) {
    void this.load()
  }
  dispose() {
    this.disposed = true
    this.generation++
    this.controller.abort()
  }
  private async load() {
    if (this.disposed) return
    this.controller.abort()
    this.controller = new AbortController()
    const generation = ++this.generation
    const header = row(el('h2', '', '执行记录'), button('刷新执行记录', () => this.load()))
    const body = el('div', 'stack')
    this.element.replaceChildren(header,
      text('显示当前团队、本人负责 Bug 的本地执行记录，包含已关闭状态，不受“我的 Bug”筛选影响。', true),
      notice('已发起仅表示任务已发送，不代表修复完成；当前尚未接入 Agent 运行与完成状态。'), body)
    if (!this.team) { body.append(notice('请先登录 ONES 并选择团队。')); return }
    body.append(notice('正在读取执行记录…'))
    try {
      const items = await request<RepairListItem[]>('repair.list', { team: this.team }, this.controller.signal)
      if (this.disposed || generation !== this.generation) return
      body.replaceChildren(...(items.length ? items.map(({ task, record }) => card(
        `#${task.number} ${task.name}`,
        notice(record.state === 'sent' ? '已发起 · 完成状态未确认' : record.state === 'terminal' ? '待核实 · 返回终端，可能已发送' : '待核实 · 启动或发送结果不明', record.state !== 'sent'),
        text(`Bug 状态：${task.status.name} · ${task.project.name}`, true),
        text(`执行时间：${new Date(record.createdAt).toLocaleString()}`),
        text(`目标项目：${record.projectName}`),
        ...(record.sessionId ? [text(`Session：${record.sessionId}`, true)] : []),
        button('查看 Bug 详情', () => this.openDetail(task))
      )) : [notice('暂无匹配的执行记录。可从“我的 Bug”进入详情执行修复。')]))
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        body.replaceChildren(notice('执行记录加载失败：' + message(error), true))
    }
  }
}
