import { createHash, randomUUID, randomInt } from 'node:crypto'
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { id, record, requireThat, type Task } from './domain/model.ts'
import { transitionIntent, type OnesTransitions, type TransitionInput, type TransitionIntent, type TransitionSnapshot, type TransitionEvidence } from './adapters/ones-transitions.ts'

/// 确认摘要只暴露必要差异，评论为纯文本。
export type StatusPreview = { id: string; task: Task; stepName: string; targetName: string; changes: { name: string; before: string; after: string }[]; comment: string; expiresAt: number }
/// 独立账本记录，不复用工时或修复启动记录。
export type StatusOperation = { id: string; scope: string; taskId: string; createdAt: number; state: 'submitting' | 'unknown' | 'verified'; intent: TransitionIntent; asyncToken: string | null; evidence?: TransitionEvidence }
/// 面板只接收脱敏回执；异步 token、身份摘要和内部 HTML 不跨桥。
export type StatusResult = Pick<StatusOperation, 'id' | 'taskId' | 'createdAt' | 'state' | 'evidence'>
/// 明确选择公开字段，不能把持久意图直接传给面板。
function publicResult(value: StatusOperation): StatusResult {
  return { id: value.id, taskId: value.taskId, createdAt: value.createdAt, state: value.state, ...(value.evidence ? { evidence: value.evidence } : {}) }
}
/// detailId 只决定目标；身份检查在每次异步边界后再次执行。
export type StatusContext = { scope: string; task: Task; adapter: OnesTransitions; check(): void }
/// 预览绑定当前详情、身份和完整 schema，不接受 UI 替换目标。
type Plan = { detailId: string; scope: string; snapshot: TransitionSnapshot; intent: TransitionIntent; view: StatusPreview }

/// 本机单任务锁及原子账本；崩溃残留锁不自动删除，仍允许只读核对。
export class StatusJournal {
  /// 默认目录与修复记录隔离；测试可注入临时目录。
  constructor(private root = join(homedir(), 'Library', 'Application Support', 'ones-workbench', 'status-updates')) {}
  /// 对身份和任务进行不可逆路径编码，外部标识不成为任意路径。
  private key(scope: string, taskId: string): string { return createHash('sha256').update(JSON.stringify([scope, taskId])).digest('hex') }
  /// 要求资料目录仅当前用户可读写，不声称加密。
  private async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const st = await lstat(this.root)
    requireThat(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && st.uid === process.getuid?.(), 'storage', '状态账本目录权限不安全。')
  }
  /// 读取失败或损坏必须阻断新写入，不能当成没有记录。
  async read(scope: string, taskId: string): Promise<StatusOperation | null> {
    await this.ensure()
    try {
      const file = join(this.root, this.key(scope, taskId) + '.json'), st = await lstat(file)
      requireThat(st.isFile() && !st.isSymbolicLink() && st.size <= 100000 && (st.mode & 0o077) === 0, 'storage', '状态操作记录不可安全读取。')
      const value = record(JSON.parse(await readFile(file, 'utf8')))
      requireThat(value.scope === scope && value.taskId === taskId && ['submitting', 'unknown', 'verified'].includes(String(value.state)), 'storage', '状态操作记录损坏。')
      id(value.id)
      const intent = record(value.intent)
      requireThat(intent.taskId === taskId && Array.isArray(intent.fields) && typeof intent.html === 'string' && typeof intent.comment === 'string' && typeof intent.sourceStamp === 'string', 'storage', '状态操作意图损坏。')
      return value as StatusOperation
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  /// 同一 Bug 的操作跨面板/Worker 互斥；不根据时间猜测残留锁已安全。
  async lock(scope: string, taskId: string): Promise<() => Promise<void>> {
    await this.ensure()
    const path = join(this.root, this.key(scope, taskId) + '.lock')
    try {
      const file = await open(path, 'wx', 0o600)
      await file.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') requireThat(false, 'pending', '该 Bug 有执行中或崩溃残留的状态锁。仅可核对，不能重发；残留锁需人工核实后处理。')
      throw error
    }
    return () => unlink(path)
  }
  /// 写临时文件并 fsync 后原子替换；调用方必须持有该任务锁。
  async save(value: StatusOperation): Promise<void> {
    await this.ensure()
    requireThat(Buffer.byteLength(JSON.stringify(value)) <= 90000, 'storage', '状态账本超出容量，未发送新请求。')
    const path = join(this.root, this.key(value.scope, value.taskId) + '.json'), temporary = `${path}.${randomUUID()}.tmp`
    const previous = await this.read(value.scope, value.taskId)
    if (previous && previous.id !== value.id) {
      requireThat(previous.state === 'verified', 'pending', '未核实的旧操作不能被替换。')
      const archive = join(this.root, `${this.key(value.scope, value.taskId)}.${id(previous.id)}.history.json`)
      try {
        const history = await open(archive, 'wx', 0o600)
        try { await history.writeFile(JSON.stringify(previous)); await history.sync() } finally { await history.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        requireThat(await readFile(archive, 'utf8') === JSON.stringify(previous), 'storage', '历史操作记录不一致，已停止覆盖。')
      }
    }
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    const directory = await open(this.root, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}
/// 状态预览、单次提交与核对流程；不订阅会话、不修改 Bug 描述。
export class StatusWorkflow {
  /// 有界短期确认，仅保存当前 Worker 有效预览。
  private plans = new Map<string, Plan>()
  /// 独立能力闸默认关闭，不能由 panel 输入开启。
  constructor(private context: (detailId: string) => Promise<StatusContext>, private journal = new StatusJournal(), private writesVerified = false) {}
  /// 返回完整字段与未结束操作，详情重开不能绕过待核实账本。
  async options(detailId: string) {
    const context = await this.context(detailId), operation = await this.journal.read(context.scope, context.task.id)
    const snapshot = await context.adapter.snapshot(context.task)
    context.check()
    return { snapshot, operation: operation ? publicResult(operation) : null, writeEnabled: this.writesVerified, blockedReason: this.writesVerified ? '' : '状态提交尚待插件真实端到端验证，当前仅开放预览与只读核对。' }
  }
  /// 重新读取最新详情/schema，校验全部输入，再创建有时限确认。
  async preview(input: TransitionInput): Promise<StatusPreview> {
    const context = await this.context(id(input.detailId)), operation = await this.journal.read(context.scope, context.task.id)
    requireThat(!operation || operation.state === 'verified', 'pending', '已有结果待核实，不能创建新提交。')
    const snapshot = await context.adapter.snapshot(context.task), intent = transitionIntent(snapshot, input, Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[randomInt(62)]).join(''))
    context.check()
    const step = snapshot.steps.find(s => s.id === intent.stepId)!
    const label = (field: typeof step.fields[number], value: string) => (field.options.find(o => o.id === value)?.name ?? value) || '（空）'
    const view: StatusPreview = { id: randomUUID(), task: snapshot.task, stepName: step.name, targetName: step.target.name, comment: intent.comment, expiresAt: Date.now() + 300000, changes: step.fields.map(field => ({ name: field.name, before: label(field, field.value), after: label(field, input.fields[field.id]!) })) }
    for (const [key, plan] of this.plans) if (plan.view.expiresAt <= Date.now()) this.plans.delete(key)
    requireThat(this.plans.size < 50, 'busy', '预览过多，请稍后重新打开详情。')
    this.plans.set(view.id, { detailId: input.detailId, scope: context.scope, snapshot, intent, view })
    return view
  }
  /// 持久化先于业务请求；网络或回读失败保留 unknown，不重发。
  async submit(previewId: string, confirmed: boolean): Promise<StatusResult> {
    requireThat(confirmed === true, 'confirm', '请确认状态、字段差异与完整评论。')
    requireThat(this.writesVerified, 'unverified', '状态写能力尚未完成插件端到端验证。')
    const plan = this.plans.get(id(previewId))
    requireThat(plan && plan.view.expiresAt > Date.now(), 'stale', '预览已失效，请重新预览。')
    this.plans.delete(previewId)
    const context = await this.context(plan.detailId)
    requireThat(context.scope === plan.scope, 'stale', '提交身份已变化。')
    const unlock = await this.journal.lock(context.scope, context.task.id)
    try {
      // 1. 锁内重读并验证预览，任何变化均零业务写入。
      const old = await this.journal.read(context.scope, context.task.id)
      requireThat(!old || old.state === 'verified', 'pending', '已有待核实状态操作。')
      const fresh = await context.adapter.snapshot(context.task)
      context.check()
      requireThat(fresh.stamp === plan.snapshot.stamp, 'stale', 'Bug 或步骤字段已变化，请刷新详情后重新预览。')
      const operation: StatusOperation = { id: randomUUID(), scope: context.scope, taskId: context.task.id, createdAt: Date.now(), state: 'submitting', intent: plan.intent, asyncToken: null }
      await this.journal.save(operation)
      context.check()
      // 2. 一旦发送便不受离页取消影响，结果写回账本但不发布到新详情。
      try {
        operation.asyncToken = await context.adapter.submit(operation.intent)
        operation.evidence = await context.adapter.reconcile(operation.intent, operation.asyncToken)
        operation.state = operation.evidence.status && operation.evidence.fields && operation.evidence.comment ? 'verified' : 'unknown'
      } catch { operation.state = 'unknown' }
      await this.journal.save(operation)
      context.check()
      return publicResult(operation)
    } finally { await unlock() }
  }
  /// 只能核对同身份、同 Bug 的已有操作，永远不调用 submit。
  async reconcile(detailId: string, operationId: string): Promise<StatusResult> {
    const context = await this.context(detailId), operation = await this.journal.read(context.scope, context.task.id)
    requireThat(operation && operation.id === id(operationId), 'identity', '操作不属于当前 Bug 或账号。')
    const evidence = await context.adapter.reconcile(operation.intent, operation.asyncToken)
    context.check()
    const result = { ...operation, evidence, state: evidence.status && evidence.fields && evidence.comment ? 'verified' as const : 'unknown' as const }
    // 锁存在时只返回核对证据，不覆盖仍执行中的账本，也不清理崩溃残留锁。
    let unlock: (() => Promise<void>) | undefined
    try { unlock = await this.journal.lock(context.scope, context.task.id) } catch { return publicResult(result) }
    try {
      const latest = await this.journal.read(context.scope, context.task.id)
      requireThat(latest?.id === operation.id, 'stale', '状态操作已变化，请重新读取。')
      await this.journal.save(result)
    } finally { await unlock() }
    return publicResult(result)
  }
}
