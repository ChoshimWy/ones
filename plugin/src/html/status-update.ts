import type { StatusWorkflow, StatusPreview, StatusResult } from '../status-update.ts'
import { button, card, el, input, message, notice, request, row, select, text } from './dom.ts'

/// 在详情内手动编辑和确认状态，不读取会话、不覆盖原描述。
export class StatusView {
  /// 独立区域，复用现有 card 与主题样式。
  readonly element = el('div', 'stack')
  /// 当前详情取得的权威步骤；读取失败立即清除。
  private options?: Awaited<ReturnType<StatusWorkflow['options']>>
  /// 用户明确选择的步骤，不从状态筛选猜测。
  private selected = ''
  /// 按当前 schema 保存用户输入的字段值。
  private values: Record<string, string> = {}
  /// 手动总结各段，不自动推断版本或验证结果。
  private summary = { cause: '', solution: '', impact: '', validation: '', delivery: '' }
  /// 有时限确认，任何本地编辑即撤销。
  private preview?: StatusPreview
  /// 从独立账本恢复的公开回执。
  private operation?: StatusResult
  /// 是否显示当前详情内的状态表单。
  private expanded = false
  /// 互斥 UI 动作，不能代替 Worker 防重。
  private busy = false
  /// 阻止离页后的迟到结果发布。
  private disposed = false
  /// 经过桥接错误裁剪后的可见错误。
  private error = ''
  /// 刷新由父详情统一执行，保证后续修复操作使用新的 detailId。
  constructor(private detailId: string, private availability: (disabled: boolean, reason: string) => void, private updated: () => Promise<void>, private closed: () => void) {}
  /// 失效后迟到响应不再更新其它 Bug。
  dispose(): void { this.disposed = true; this.element.replaceChildren() }
  /// 读取步骤及账本；失败保留可见重试，不展示过期可提交选项。
  async load(): Promise<void> {
    this.busy = true
    this.options = undefined
    this.availability(true, '正在读取状态步骤…')
    try {
      const options = await request<Awaited<ReturnType<StatusWorkflow['options']>>>('bugs.transitionOptions', { detailId: this.detailId })
      if (this.disposed) return
      this.options = options
      this.operation = options.operation ?? undefined
      const supported = options.snapshot.steps.filter(s => !s.blockers.length)
      this.availability(!supported.length && !this.operation, supported.length ? '' : options.snapshot.steps.flatMap(s => s.blockers).join('；') || '当前无可用状态步骤。')
      if (this.operation) this.expanded = true
      this.error = ''
    } catch (error) {
      if (this.disposed) return
      this.error = message(error)
      this.availability(true, '状态配置读取失败。')
    } finally {
      if (!this.disposed) { this.busy = false; this.render() }
    }
  }
  /// 入口与修复记录无关；展开后需用户明确选择步骤。
  open(): void { this.expanded = true; this.render(); this.element.querySelector<HTMLElement>('select,button')?.focus() }
  /// 修改任何输入即撤销本地预览，Worker 仍会独立核实。
  private invalidate(): void { this.preview = undefined; this.element.querySelector('[data-status-preview]')?.remove() }
  /// 保留未提交/未发布等说明，以纯文本生成评论供人工复核。
  private comment(): string {
    return `说明来源：用户手动填写/粘贴；非插件独立验证。\n\n根本原因\n${this.summary.cause}\n\n解决方法\n${this.summary.solution}\n\n影响范围\n${this.summary.impact}\n\n验证结果 / 未完成项\n${this.summary.validation}\n\n交付情况\n${this.summary.delivery}`
  }
  /// 所有异步动作互斥；发送失败只允许读取账本，不重新发送同一预览。
  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    this.error = ''
    this.render()
    try { await action() } catch (error) { if (!this.disposed) this.error = message(error) }
    finally { if (!this.disposed) { this.busy = false; this.render() } }
  }
  /// 展示权威核对各项和后置状态，不能把仅 HTTP 成功当更新成功。
  private result(operation: StatusResult): HTMLElement {
    const evidence = operation.evidence
    return card(operation.state === 'verified' ? '更新成功' : '结果待核实',
      text(`操作：${operation.id}`),
      notice(evidence?.message ?? '请求可能已发送。请核对结果，不要重发。', operation.state !== 'verified'),
      evidence ? text(`状态：${evidence.status ? '一致' : '未确认'} · 字段：${evidence.fields ? '一致' : '未确认'} · 本次评论：${evidence.comment ? '一致' : '未确认'}`) : null,
      text(`后置动作：${evidence?.asyncStatus ?? '未确认'}${evidence?.asyncStatus === 'done' ? '' : '（未证明完成）'}`, true),
      button('核对结果', () => this.act(async () => {
        const result = await request<StatusResult>('bugs.transitionReconcile', { detailId: this.detailId, operationId: operation.id })
        if (this.disposed) return
        this.operation = result
        if (result.state === 'verified') await this.updated()
      }), this.busy))
  }
  /// 原生控件保障键盘与禁用语义，长文本换行依赖共享 CSS。
  private render(): void {
    this.element.replaceChildren()
    if (this.error) this.element.append(notice(this.error, true), button('重试读取状态配置', () => this.load(), this.busy))
    if (!this.expanded || !this.options) return
    const options = this.options, step = options.snapshot.steps.find(s => s.id === this.selected)
    const content = card('更新状态', text(`当前状态：${options.snapshot.task.status.name}`), notice('手动检查总结、根因分类及解决版本；不会修改 Bug 原始描述，也不会自动监控修复会话。'))
    if (this.operation) content.append(this.result(this.operation))
    if (!this.operation || this.operation.state === 'verified') {
      content.append(select('流转步骤', this.selected, [{ value: '', label: '请选择步骤' }, ...options.snapshot.steps.map(s => ({ value: s.id, label: `${s.name} → ${s.target.name}${s.blockers.length ? '（不可用）' : ''}` }))], value => {
        this.selected = value
        this.values = Object.fromEntries(options.snapshot.steps.find(s => s.id === value)?.fields.map(f => [f.id, f.value]) ?? [])
        this.invalidate()
        this.render()
      }, this.busy))
      if (step) {
        content.append(text(`${options.snapshot.task.status.name} → ${step.target.name}`))
        for (const blocker of step.blockers) content.append(notice(blocker, true))
        for (const field of step.fields) {
          const label = `${field.name}${field.required ? ' *（必填）' : ''}`
          content.append(field.type === 1 ? select(label, this.values[field.id] ?? '', [{ value: '', label: '请选择' }, ...field.options.map(o => ({ value: o.id, label: o.name }))], value => { this.values[field.id] = value; this.invalidate() }, this.busy)
            : input(label, this.values[field.id] ?? '', value => { this.values[field.id] = value; this.invalidate() }, { disabled: this.busy }))
        }
        for (const [key, label] of [['cause', '根本原因说明'], ['solution', '解决方法（可粘贴修复总结）'], ['impact', '影响范围'], ['validation', '验证结果 / 未完成项'], ['delivery', '交付情况（未提交 / 未合并 / 未发布请保留）']] as const)
          content.append(input(label, this.summary[key], value => { this.summary[key] = value; this.invalidate() }, { multiline: true, disabled: this.busy }))
        content.append(button('预览状态更新', () => this.act(async () => {
          if (!Object.values(this.summary).some(v => v.trim())) { this.error = '请填写或粘贴修复说明，再人工检查未完成项。'; return }
          const preview = await request<StatusPreview>('bugs.transitionPreview', { detailId: this.detailId, stepId: this.selected, fields: this.values, comment: this.comment() })
          if (!this.disposed) this.preview = preview
        }), this.busy || !!step.blockers.length))
      }
    }
    if (!options.writeEnabled) content.append(notice(options.blockedReason))
    if (this.busy) content.append(notice('正在处理。离开详情不会撤销已发送请求；未知结果不得重发。'))
    if (this.preview) {
      const preview = this.preview
      const confirmation = card('确认预览', text(`#${preview.task.number} ${preview.task.name}`), text(`${preview.task.status.name} → ${preview.targetName} · ${preview.stepName}`), ...preview.changes.map(c => text(`${c.name}：${c.before} → ${c.after}`)), text(preview.comment), button('确认更新状态', () => this.act(async () => {
        this.preview = undefined
        try {
          const operation = await request<StatusResult>('bugs.transitionSubmit', { previewId: preview.id, confirmed: true })
          if (this.disposed) return
          this.operation = operation
          if (operation.state === 'verified') await this.updated()
        } catch (error) {
          if (!this.disposed) await this.load()
          throw error
        }
      }), this.busy || !options.writeEnabled, 'primary'))
      confirmation.dataset.statusPreview = 'true'
      content.append(confirmation)
    }
    content.append(row(button('收起状态表单', () => { this.expanded = false; this.render(); this.closed() }, this.busy)))
    this.element.append(content)
  }
}
