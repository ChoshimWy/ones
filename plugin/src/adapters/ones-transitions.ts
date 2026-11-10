import { createHash } from 'node:crypto'
import { id, record, requireThat, text, type Option, type Task } from '../domain/model.ts'
import { Transport, jsonBody } from './http.ts'
import type { OnesSession } from './ones-auth.ts'

/// 仅支持已核实的单选与文本；其它约束阻断该步骤，不猜测字段。
export type TransitionField = { id: string; name: string; type: 1 | 2; required: boolean; value: string; options: Option[] }
/// 步骤与完整 schema 绑定；阻断原因仍对用户可见。
export type TransitionStep = { id: string; name: string; target: Option; fields: TransitionField[]; blockers: string[] }
/// 写前版本包含原始详情和配置摘要，防止确认后字段/步骤变化。
export type TransitionSnapshot = { task: Task; stamp: string; steps: TransitionStep[] }
/// 只允许已确认字段与纯文本评论输入。
export type TransitionInput = { detailId: string; stepId: string; fields: Record<string, string>; comment: string }
/// 持久化的最小请求，不包含凭证、任意 URL 或原始 Bug 正文。
export type TransitionIntent = { taskId: string; sourceStamp: string; sourceStatus: string; stepId: string; target: Option; fields: { field_uuid: string; type: number; value: string }[]; commentId: string; comment: string; html: string }
/// 回读结果逐项说明；异步后置状态独立，不把 none 当 done。
export type TransitionEvidence = { status: boolean; fields: boolean; comment: boolean; asyncStatus: string; message: string }

/// 转义用户输入后生成唯一的评论 HTML；不接受外部 HTML 指令。
export function commentHTML(value: string): string {
  const escaped = text(value, 12000).trim().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  requireThat(escaped.length > 0, 'input', '请填写修复说明并人工检查未完成项。')
  return `<p>${escaped.replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')}</p>`
}
/// 构造预览与提交共同使用的字段，拒绝额外字段、未知选项和超长文本。
export function transitionIntent(snapshot: TransitionSnapshot, input: TransitionInput, commentId: string): TransitionIntent {
  const step = snapshot.steps.find(step => step.id === input.stepId)
  requireThat(step && !step.blockers.length, 'schema', '该步骤不可执行，请在原单核对字段或权限。')
  const values = record(input.fields)
  requireThat(Object.keys(values).length === step.fields.length && Object.keys(values).every(key => step.fields.some(f => f.id === key)), 'input', '提交字段与步骤配置不一致。')
  const fields = step.fields.map(field => {
    const value = values[field.id]
    requireThat(typeof value === 'string' && value.length <= 2000, 'input', '字段值过长或格式无效。')
    requireThat(!field.required || value.trim().length > 0, 'input', `请填写${field.name}。`)
    requireThat(field.type !== 1 || (!value && !field.required) || field.options.some(o => o.id === value), 'input', `请选择有效的${field.name}。`)
    return { field_uuid: field.id, type: field.type, value }
  }).filter(field => {
    const schema = step.fields.find(value => value.id === field.field_uuid)!
    return schema.required || field.value !== schema.value
  })
  const comment = text(input.comment, 12000).replace(/\r\n?/g, '\n').trim()
  const intent = { taskId: snapshot.task.id, sourceStamp: snapshot.stamp, sourceStatus: snapshot.task.status.id, stepId: step.id, target: step.target, fields, commentId: id(commentId), comment, html: commentHTML(comment) }
  requireThat(Buffer.byteLength(JSON.stringify(intent)) <= 60000, 'size', '状态提交超出容量，请缩短说明或在原单操作；未截断。')
  return intent
}
/// 实例限定的状态 Adapter；所有请求复用 Worker Vault Bearer，不接触浏览器存储。
export class OnesTransitions {
  /// 认证身份由调用方捕获，网络无自动重试。
  constructor(private transport: Transport, private session: OnesSession, private team: string) {}
  /// 固定团队路径，所有动态标识先校验。
  private get base(): string { return `/project/api/project/team/${id(this.team)}` }
  /// 只读请求统一携带当前认证。
  private get(path: string): Promise<Record<string, unknown>> { return this.transport.json(path, { headers: { Authorization: `Bearer ${this.session.token}` } }) }
  /// 以 task 允许步骤、project stamps、scope 和字段目录交集建立完整配置。
  async snapshot(task: Task): Promise<TransitionSnapshot> {
    // 1. 获取权威详情与只读元数据；stamps POST 是读取，不是业务写入。
    const info = await this.get(`${this.base}/task/${id(task.id)}/info`)
    requireThat(info.uuid === task.id && info.project_uuid === task.project.id && info.issue_type_uuid === task.issueType.id && info.status_uuid === task.status.id, 'stale', 'Bug 身份或状态已变化，请刷新详情。')
    id(info.issue_type_scope_uuid)
    requireThat(Number.isSafeInteger(info.server_update_stamp), 'schema', 'Bug 缺少版本戳。')
    const [allowed, stamps, catalog, configs, statuses, permissions] = await Promise.all([
      this.get(`${this.base}/task/${id(task.id)}/transitions`),
      this.transport.json(`${this.base}/project/${id(task.project.id)}/stamps/data?t=transition`, jsonBody({ transition: 0 }, this.session.token)),
      this.get(`${this.base}/fields`),
      this.get(`${this.base}/project/${id(task.project.id)}/issue_type/${id(task.issueType.id)}/field_configs`),
      this.get(`${this.base}/task_statuses`),
      this.transport.json(`${this.base}/tasks/evaluated_permissions`, jsonBody({ tasks: { [task.id]: ['view_tasks', 'update_tasks', 'transit_tasks'] } }, this.session.token))
    ])
    const permission = record(record(permissions.tasks)[task.id])
    requireThat(permission.view_tasks === true && permission.transit_tasks === true, 'forbidden', '当前账号没有查看或流转该 Bug 的权限。')
    const transitions = record(stamps.transition).transitions
    requireThat(Array.isArray(allowed.transitions) && Array.isArray(transitions) && Array.isArray(catalog.fields) && Array.isArray(configs.field_configs) && Array.isArray(statuses.task_statuses) && Array.isArray(info.field_values), 'schema', '状态字段元数据不完整，不能使用步骤简表提交。')
    const statusCatalog = statuses.task_statuses.map(record)
    const allowedIds = allowed.transitions.map(v => id(record(v).uuid))
    const definitions = catalog.fields.map(record), fieldConfigs = configs.field_configs.map(record), current = info.field_values.map(record)
    // 2. 每个允许步骤都必须唯一关联配置；未知约束保留为可见阻断。
    const steps = allowedIds.map(stepId => {
      const candidates = transitions.map(record).filter(s => s.uuid === stepId && s.project_uuid === task.project.id && s.issue_type_uuid === task.issueType.id && s.issue_type_scope_uuid === info.issue_type_scope_uuid && s.start_status_uuid === task.status.id)
      requireThat(candidates.length === 1, 'schema', '允许步骤无法唯一关联完整字段配置。')
      const step = candidates[0]!, blockers: string[] = []
      const target = statusCatalog.find(s => s.uuid === step.end_status_uuid)
      requireThat(target && Array.isArray(step.fields), 'schema', '步骤目标或字段配置缺失。')
      if (step.condition !== null || step.trigger !== null || !Array.isArray(step.post_function) || step.post_function.length) blockers.push('该步骤含未支持的条件、触发器或后置动作，请打开原单。')
      if (permission.update_tasks !== true && step.fields.some(v => record(v).field_uuid !== 'tf-comment')) blockers.push('没有字段更新权限，请在原单核对。')
      const fields: TransitionField[] = []
      for (const raw of step.fields) {
        const field = record(raw)
        if (field.field_uuid === 'tf-comment' && field.type === -1 && typeof field.required === 'boolean') continue
        const definition = definitions.find(v => v.uuid === field.field_uuid)
        const config = fieldConfigs.find(v => v.field_uuid === field.field_uuid && v.project_uuid === task.project.id && v.issue_type_uuid === task.issueType.id && v.issue_type_scope_uuid === info.issue_type_scope_uuid)
        if (!definition || !config || ![1, 2].includes(Number(field.type)) || definition.type !== field.type || config.type !== field.type || typeof field.required !== 'boolean' || config.option_configs !== null || definition.fixed === true) {
          blockers.push('存在未支持或缺失编辑配置的字段，请打开原单。')
          continue
        }
        const type = field.type as 1 | 2, options = type === 1 && Array.isArray(definition.options) ? definition.options.map(v => { const option = record(v); return { id: id(option.uuid), name: text(option.value, 500) } }) : []
        if (type === 1 && (!options.length || new Set(options.map(v => v.id)).size !== options.length)) blockers.push('单选字段选项不完整。')
        const values = current.filter(v => v.field_uuid === field.field_uuid)
        const value = values[0]?.value ?? field.default_value ?? ''
        if (values.length > 1 || typeof value !== 'string') { blockers.push('已有字段值格式未支持。'); continue }
        fields.push({ id: id(field.field_uuid), name: text(definition.name), type, required: field.required, value, options })
      }
      if (new Set(fields.map(f => f.id)).size !== fields.length || fields.length > 30) blockers.push('字段重复或超过支持容量。')
      return { id: stepId, name: text(step.name), target: { id: id(target.uuid), name: text(target.name) }, fields, blockers }
    })
    requireThat(steps.length <= 30 && new Set(allowedIds).size === allowedIds.length, 'schema', '步骤重复或超出容量。')
    requireThat(Buffer.byteLength(JSON.stringify(steps)) <= 160000, 'size', '状态字段与选项超出面板容量，未截断；请打开原单。')
    return { task, steps, stamp: createHash('sha256').update(JSON.stringify([info, stamps, catalog, configs, allowed, permissions])).digest('hex') }
  }
  /// 单次发送已持久化意图；任何异常都交由只读核对，绝不自动重发。
  async submit(intent: TransitionIntent): Promise<string | null> {
    const result = await this.transport.json(`${this.base}/task/${id(intent.taskId)}/new_transit`, jsonBody({ transition_uuid: intent.stepId, field_values: intent.fields, discussion: { uuid: intent.commentId, content_type: 1, text: intent.html }, manhours: [], resource_uuids: [] }, this.session.token))
    return typeof result.async_token === 'string' ? text(result.async_token, 500) : null
  }
  /// 只读确认状态、字段、本客户端评论 UUID/作者/正文；找不到不等于失败。
  async reconcile(intent: TransitionIntent, token: string | null): Promise<TransitionEvidence> {
    const info = await this.get(`${this.base}/task/${id(intent.taskId)}/info`)
    requireThat(info.uuid === intent.taskId && Array.isArray(info.field_values), 'readback', '无法确认原 Bug 字段。')
    let before: number | undefined, comment = false
    // 1. 有界翻页寻找本操作评论；不能仅凭目标状态宣布成功。
    for (let page = 0; page < 10; page++) {
      const result = await this.get(`${this.base}/task/${id(intent.taskId)}/messages?count=20${before === undefined ? '' : `&max=${before}`}`)
      requireThat(Array.isArray(result.messages) && typeof result.has_next === 'boolean', 'readback', '评论分页缺失。')
      const messages = result.messages.map(record), matches = messages.filter(m => m.uuid === intent.commentId)
      if (matches.length) {
        const match = matches[0]!
        comment = matches.length === 1 && match.type === 'discussion' && match.ref_id === intent.taskId && match.ref_type === 'task' && match.from === this.session.userId && (typeof match.rich_text === 'string' && match.rich_text ? match.rich_text : match.text) === intent.html
        break
      }
      if (!result.has_next) break
      const next = Math.min(...messages.map(m => Number(m.send_time)))
      requireThat(Number.isSafeInteger(next) && next > 0 && (before === undefined || next < before), 'readback', '评论分页未推进。')
      before = next
    }
    // 2. 后置任务状态单独报告，读取失败不覆盖三项权威证据。
    let asyncStatus = '未确认'
    if (token) {
      try { const data = await this.get(`${this.base}/transition_async_status?token=${encodeURIComponent(token)}`); asyncStatus = typeof data.status === 'string' ? data.status.slice(0, 100) : '未确认' } catch { /* 后置查询不等于业务提交失败。 */ }
    }
    const fields = intent.fields.every(field => { const matches = (info.field_values as unknown[]).map(record).filter(v => v.field_uuid === field.field_uuid); return matches.length === 1 && matches[0]!.type === field.type && matches[0]!.value === field.value })
    const status = info.status_uuid === intent.target.id
    return { status, fields, comment, asyncStatus, message: status && fields && comment ? '状态、字段及本次评论已回读一致。' : '结果待核实：未确认全部状态、字段和本次评论；禁止重发。' }
  }
}
