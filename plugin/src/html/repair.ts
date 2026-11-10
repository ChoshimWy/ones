import type { RepairPreparation, RepairRecord } from '../repair.ts'
import { button, card, el, message, notice, request, row, select, text } from './dom.ts'

export class RepairView {
  readonly element = el('div')
  private disposed = false
  private busy = false
  private record: RepairRecord | null = null
  private readFailed = false
  constructor(private detailId: string, private changed: (busy: boolean, hasRecord: boolean) => void) {}
  async load() {
    if (this.busy || this.disposed) return
    this.setBusy(true)
    this.element.replaceChildren(notice('正在读取执行记录…'))
    try {
      const record = await request<RepairRecord | null>('repair.read', { detailId: this.detailId })
      if (this.disposed) return
      this.readFailed = false
      this.record = record
      if (record) this.showRecord(record)
      else this.element.replaceChildren()
    } catch (error) {
      if (!this.disposed) {
        this.readFailed = true
        this.element.replaceChildren(notice('执行记录读取失败，暂不可启动修复。' + message(error), true),
          button('重试读取记录', () => this.load()))
      }
    } finally { this.setBusy(false) }
  }
  dispose() { this.disposed = true }
  async open() {
    if (this.busy || this.disposed) return
    if (this.readFailed) { await this.load(); return }
    if (this.record) { this.showRecord(this.record); this.element.scrollIntoView({ block: 'nearest' }); return }
    this.setBusy(true)
    this.element.replaceChildren(notice('正在匹配已有本地项目及检查修复会话…'))
    this.element.scrollIntoView({ block: 'nearest' })
    try {
      const preparation = await request<RepairPreparation>('repair.prepare', { detailId: this.detailId })
      if (this.disposed) return
      if (preparation.existing) { this.showRecord(preparation.existing); return }
      this.form(preparation)
    } catch (error) {
      if (!this.disposed) this.element.replaceChildren(notice(message(error), true))
    } finally { this.setBusy(false) }
  }
  private setBusy(busy: boolean) {
    this.busy = busy
    if (!this.disposed) this.changed(busy || this.readFailed, this.record !== null)
  }
  private form(preparation: RepairPreparation) {
    const mapping = preparation.mapping
    let projectId = mapping.kind === 'mapped' ? mapping.project.id : ''
    let agent = 'codex'
    const start = button('创建聊天并发送', async () => {
      if (this.busy || !projectId || this.disposed) return
      this.setBusy(true)
      start.disabled = true
      this.element.replaceChildren(notice('正在收集完整正文、评论及媒体，随后创建聊天。请勿重复操作；离开页面不代表已取消启动。'))
      try {
        const result = await request<RepairRecord>('repair.start', { preparationId: preparation.id, projectId, agent, confirmed: true })
        if (!this.disposed) this.showRecord(result)
      } catch (error) {
        if (!this.disposed) this.element.replaceChildren(notice(message(error) + ' 如启动结果不明，再次点击“执行修复”只查询已有记录，不会自动重发。', true))
      } finally { this.setBusy(false) }
    }, !projectId, 'primary')
    const mappingUI = mapping.kind === 'mapped'
      ? text(`${mapping.via === 'saved' ? '已绑定' : '自动匹配'}：${mapping.project.name}`)
      : el('div', 'stack',
          notice(mapping.reason === 'target-unavailable' ? '原映射项目已失效，请重新选择。' : mapping.reason === 'ambiguous' ? '存在多个匹配项目，请选择一次。' : '未找到可靠匹配，请选择一次。'),
          select('本地项目', '', [{ value: '', label: '请选择本地项目' }, ...mapping.candidates.map(p => ({ value: p.id, label: p.name }))], value => { projectId = value; start.disabled = !value }))
    this.element.replaceChildren(card('执行修复', mappingUI,
      select('修复 Agent', agent, [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }], value => { agent = value }),
      notice('在已有项目目录下创建聊天，不创建工作区。将发送完整 Bug 正文、评论和媒体本地引用；Agent 沿用 Orca 的权限设置。'),
      text('图片/视频不是原生聊天附件。资料保存在本机私有目录，供会话读取，结束后可自行清理；不自动修改 ONES 状态。', true),
      row(start, button('取消', () => this.element.replaceChildren()))))
  }
  private showRecord(record: RepairRecord) {
    this.record = record
    const status = record.state === 'sent'
      ? '聊天已创建，消息已写入会话；不代表修复或媒体分析已完成。'
      : record.state === 'terminal'
        ? 'Orca 实际返回了终端而非聊天，可能已发送任务。请到项目核实，不会自动重试。'
        : '启动或消息结果待核实，已阻止重复发送。请到目标项目检查会话。'
    this.element.replaceChildren(card('执行记录', notice(status, record.state !== 'sent'),
      text(`执行时间：${new Date(record.createdAt).toLocaleString()}`),
      text(`项目：${record.projectName}`),
      ...(record.sessionId ? [text(`Session：${record.sessionId}`)] : []),
      ...(record.directory ? [text(`媒体目录：${record.directory}`, true)] : []),
      text('CLI 暂不支持打开指定 session，请在该项目下切换到对应聊天；查看执行记录不会再次发送任务。', true)))
  }
}
