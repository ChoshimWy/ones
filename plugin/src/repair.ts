import { RepairJournal, attemptKey } from './repair-journal.ts'
import { RepairEvidence } from './repair-evidence.ts'
import { RepairCache, type CachedRepairs, type RepairReport } from './repair-cache.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, writeFile, rename, rm, lstat, mkdtemp } from 'node:fs/promises'
import { privateDataRoot, ensurePrivateDirectory, assertPrivatePath, syncDirectory } from './private-files.ts'
import { join } from 'node:path'
import { OrcaCli, launchReceipt, type LaunchReceipt } from './adapters/orca-cli.ts'
import { mediaIds, repairPrompt, repairInstructions } from './domain/repair-content.ts'
import { resolveProjectMapping, projectMappingKey, type MappingResult, type ProjectMapping } from './domain/project-mapping.ts'
import { AppError, requireThat, record, type Option, type Task } from './domain/model.ts'
import type { Store, Workbench } from './service.ts'

export type RepairRecord = LaunchReceipt & { attemptId?: string; phase?: 'preparing' | 'launching' | 'settled' | 'failed'; restart?: { previousAttempt: string; basis: string; confirmedAt: number }; projectName: string; projectId: string; createdAt: number; directory?: string }
export type RepairListItem = { task: Task; record: RepairRecord; report?: RepairReport; reportError?: string }
export type RepairPreparation = { id: string; mapping: MappingResult; existing: RepairRecord | null }
type RestartPlan = { parent: RepairRecord; fingerprint: string; observation: Awaited<ReturnType<OrcaCli['sessionStatus']>> }
type Plan = { restart?: RestartPlan; detailId: string; scope: string; taskId: string; source: Option; mapping: MappingResult; projects: Option[]; expires: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'image/gif': 'gif', 'application/pdf': 'pdf' }

/** Durable no-resend journal. Unknown outcomes intentionally require human reconciliation. */
export class RepairWorkflow {
  private plans = new Map<string, Plan>()
  private cache: RepairCache
  private syncing = new Map<string, Promise<CachedRepairs>>()
  constructor(
    private service: Pick<Workbench, 'repairContext' | 'collectRepair'>,
    private store: Store,
    private cli = new OrcaCli(),
    private root = join(privateDataRoot(), 'repairs'),
    private evidence = new RepairEvidence()
  ) { this.cache = new RepairCache(root + '-cache',evidence) }
  private key(scope: string, taskId: string) { return digest([scope, taskId]) }
  private async ensureRoot() {
    await ensurePrivateDirectory(this.root, '修复资料目录权限不安全。')
  }
  private async existing(key: string): Promise<RepairRecord | null> {
    return (await new RepairJournal(this.root).entries(key)).at(-1)?.record ?? null
  }
  async history(detailId: string): Promise<{ record: RepairRecord; report?: RepairReport }[]> {
    const context = await this.service.repairContext(detailId)
    if (!await this.hasRoot()) return []
    const entries = await new RepairJournal(this.root).entries(this.key(context.scope, context.task.id))
    const fresh = await this.service.repairContext(detailId)
    requireThat(fresh.scope === context.scope && fresh.task.id === context.task.id, 'identity', '账号或 Bug 已变化。')
    const history = await Promise.all(entries.slice(0,-1).reverse().map(async entry => {
      const archived = await this.cache.archived(context.scope,context.task.id,attemptKey(entry.record))
      return { record: entry.record, ...(archived?.report ? { report: archived.report } : {}) }
    }))
    const final = await this.service.repairContext(detailId)
    requireThat(final.scope === context.scope && final.task.id === context.task.id, 'identity', '账号或 Bug 已变化。')
    return history
  }
  async inspectRestart(detailId: string) {
    const preparation = await this.prepare(detailId)
    const parent = preparation.existing ?? await this.read(detailId)
    requireThat(parent, 'stale', '没有可重新执行的记录。')
    const observation = parent.phase === 'failed'
      ? { state: 'stopped' as const, reason: '上一轮在调用 Agent 前失败，尚未发送。' }
      : await this.cli.sessionStatus(parent).catch(() => ({ state: 'unknown' as const, reason: '宿主查询失败，无法核实原 Agent 是否停止。' }))
    const plan = this.plans.get(preparation.id)!
    const current = await this.existing(this.key(plan.scope, plan.taskId))
    requireThat(digest(current) === digest(parent), 'stale', '核对期间执行轮次已变化。')
    plan.restart = { parent, fingerprint: digest(parent), observation }
    return { id: preparation.id, record: parent, observation, history: await this.history(detailId) }
  }
  async restart(input: { inspectionId: string; agent: string; confirmed: boolean; stoppedConfirmed: boolean; reason: string }, verifyStatus?: (detailId: string) => Promise<void>) {
    const plan = this.plans.get(input.inspectionId), restart = plan?.restart
    requireThat(plan && restart && plan.expires > Date.now(), 'stale', '会话核对已过期，请重新核对。')
    requireThat(input.confirmed === true, 'confirm', '请确认重新执行修复。')
    requireThat(restart.observation.state !== 'running', 'busy', '原 Agent 仍在运行，不能重新执行。')
    requireThat(restart.observation.state === 'stopped' || input.stoppedConfirmed === true &&
      typeof input.reason === 'string' && input.reason.trim().length >= 4 && input.reason.length <= 500,
      'confirm', '请先确认原 Agent 已停止，并填写人工核实依据。')
    const observation = restart.parent.phase === 'failed' ? restart.observation : await this.cli.sessionStatus(restart.parent).catch(() => ({ state: 'unknown' as const, reason: '宿主查询失败，无法核实停止状态。' }))
    requireThat(observation.state !== 'running', 'busy', '原 Agent 仍在运行，不能重新执行。')
    requireThat(observation.state === 'stopped' || input.stoppedConfirmed === true &&
      typeof input.reason === 'string' && input.reason.trim().length >= 4 && input.reason.length <= 500,
      'confirm', '停止状态无法核实，请重新核对并人工确认。')
    return this.start({ preparationId: input.inspectionId, projectId: restart.parent.projectId, agent: input.agent, confirmed: true },
      undefined, { ...(verifyStatus ? { beforeCollect: () => verifyStatus(plan.detailId) } : {}), basis: observation.state === 'stopped' ? observation.reason : '人工确认：' + input.reason.trim() })
  }
  private async hasRoot(): Promise<boolean> {
    try {
      await assertPrivatePath(this.root, 'directory', '修复资料目录权限不安全。')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    return true
  }
  async read(detailId: string): Promise<RepairRecord | null> {
    const context = await this.service.repairContext(detailId)
    if (!await this.hasRoot()) return null
    return this.existing(this.key(context.scope, context.task.id))
  }
  async list(context: Pick<Awaited<ReturnType<Workbench['repairListContext']>>, 'scope' | 'check' | 'readPage'>): Promise<RepairListItem[]> {
    context.check()
    if (!await this.hasRoot()) { context.check(); return [] }
    const items: RepairListItem[] = [], cursors = new Set<string>(), tasks = new Set<string>()
    let after = '', bytes = 0
    for (let count = 0; ; count++) {
      context.check()
      requireThat(count < 100, 'size', '缺陷分页超出执行记录查询上限，未展示不完整列表。')
      const page = await context.readPage(after)
      bytes += Buffer.byteLength(JSON.stringify(page))
      requireThat(tasks.size + page.items.length <= 5000 && bytes <= 8 * 1024 * 1024, 'size', '缺陷数量超出执行记录查询上限，未展示不完整列表。')
      for (const task of page.items) {
        context.check()
        if (tasks.has(task.id)) continue
        tasks.add(task.id)
        const receipt = await this.existing(this.key(context.scope, task.id))
        if (receipt) items.push({ task, record: receipt })
      }
      context.check()
      if (page.nextCursor === null) return items.sort((a, b) => b.record.createdAt - a.record.createdAt)
      requireThat(page.nextCursor !== after && !cursors.has(page.nextCursor), 'partial', '执行记录查询分页未推进，请重试。')
      cursors.add(page.nextCursor)
      after = page.nextCursor
    }
  }
  /// 首屏仅访问本地；顺带接收插件关闭期间完成的回执。
  async cached(context: Awaited<ReturnType<Workbench['repairCacheContext']>>): Promise<CachedRepairs> {
    context.check()
    await this.cache.consume(context.scope, context.check)
    const result = await this.cache.read(context.scope)
    for (const item of result.items) {
      const current = await this.existing(this.key(context.scope,item.task.id))
      if (current && attemptKey(current) !== attemptKey(item.record)) {
        item.record = current
        delete item.report
        delete item.reportError
      }
      await this.projectReport(item); context.check()
    }
    context.check()
    return result
  }
  /// 合并同 scope 同步；网络快照只在完整成功后发布，每日对账恢复旧账本。
  async sync(context: Awaited<ReturnType<Workbench['repairCacheContext']>>, online: () => Promise<Awaited<ReturnType<Workbench['repairListContext']>>>): Promise<CachedRepairs> {
    let pending = this.syncing.get(context.scope)
    if (!pending) {
      pending = (async () => {
        const fresh = await online()
        context.check()
        requireThat(fresh.scope === context.scope, 'identity', '同步账号已变化，未写入缓存。')
        const prior = await this.cache.read(context.scope)
        const reconcile = !prior.reconciledAt || Date.now() - prior.reconciledAt > 86400000
        const items: RepairListItem[] = []
        if (reconcile) items.push(...await this.list(fresh))
        else for (const item of await this.cache.targets(context.scope)) {
          fresh.check()
          const task = await fresh.readTask(item.task.id)
          if (task) {
            const receipt = await this.existing(this.key(fresh.scope, task.id))
            if (receipt) items.push({ task, record: receipt })
          }
        }
        await this.cache.publish(context.scope, items, reconcile, fresh.check, prior.version)
        return this.cached(fresh)
      })().catch(async error => {
        if (error instanceof AppError && ['auth','forbidden','identity'].includes(error.code)) await this.cache.revoke(context.scope)
        throw error
      })
      this.syncing.set(context.scope, pending)
      void pending.finally(() => { if (this.syncing.get(context.scope) === pending) this.syncing.delete(context.scope) }).catch(() => {})
    }
    const result = await pending
    context.check()
    return result
  }
  async prepare(detailId: string): Promise<RepairPreparation> {
    const context = await this.service.repairContext(detailId)
    await this.ensureRoot()
    const existing = await this.existing(this.key(context.scope, context.task.id))
    const projects = await this.cli.projects()
    const mappingKey = projectMappingKey(context.scope, context.task.project.id)
    const saved = await this.store.get(mappingKey) as ProjectMapping | null
    const mapping = resolveProjectMapping(context.task.project, projects, saved ?? undefined)
    const id = randomUUID()
    for (const [key, plan] of this.plans) if (plan.expires < Date.now()) this.plans.delete(key)
    requireThat(this.plans.size < 100, 'busy', '待确认修复过多，请稍后重试。')
    this.plans.set(id, { detailId, scope: context.scope, taskId: context.task.id, source: context.task.project, projects, mapping, expires: Date.now() + 600000 })
    return { id, mapping, existing: existing?.phase === 'failed' ? null : existing }
  }
  /// 保留可选字段缺省语义，避免等待回执的记录在 Worker JSON 边界被拒绝。
  private async projectReport(item: RepairListItem): Promise<void> {
    const report = await this.evidence.project(item.report)
    if (report) item.report = report
    else delete item.report
  }
  /// 详情读取完整执行结果，技术信息只在详情展示；不解析历史摘要猜状态。
  async result(detailId: string): Promise<RepairListItem | null> {
    const context = await this.service.repairContext(detailId)
    await this.cache.consume(context.scope, () => {})
    const item = (await this.cache.read(context.scope)).items.find(x=>x.task.id===context.task.id)
    const current = await this.existing(this.key(context.scope, context.task.id))
    if (item && (!current || attemptKey(current) !== attemptKey(item.record))) return null
    if (item) await this.projectReport(item)
    const fresh = await this.service.repairContext(detailId)
    requireThat(fresh.scope === context.scope && fresh.task.id === context.task.id, 'identity', '读取回执期间身份已变化。')
    return item ?? null
  }
  /// 开始修复的只读预检，冻结可执行 CLI 目标；实际启动仍重复检查。
  async preflight(input: { preparationId: string; projectId: string; agent: string }) {
    requireThat(input.agent === 'codex' || input.agent === 'claude', 'input', '不支持的 Agent。')
    const plan = this.plans.get(input.preparationId)
    requireThat(plan && plan.expires > Date.now(), 'stale', '修复准备已过期。')
    const context = await this.service.repairContext(plan.detailId)
    requireThat(context.scope === plan.scope && context.task.id === plan.taskId && context.task.project.id === plan.source.id, 'identity', '修复目标已变化。')
    requireThat(plan.projects.some(p=>p.id===input.projectId) && (plan.mapping.kind !== 'mapped' || plan.mapping.project.id===input.projectId), 'scope', '项目不属于已确认映射。')
    const fresh = (await this.cli.projects()).find(p=>p.id===input.projectId)
    requireThat(fresh, 'stale', '目标项目已移除。')
    const target = await this.cli.target(fresh)
    return {detailId:plan.detailId,task:context.task,scope:context.scope,target}
  }
  async start(input: { preparationId: string; projectId: string; agent: string; confirmed: boolean }, hook?: { target: Awaited<ReturnType<OrcaCli['target']>>; targetStatus: string; beforeCollect(): Promise<void> }, restartApproval?: { basis: string; beforeCollect?: () => Promise<void> }): Promise<RepairRecord> {
    requireThat(input.confirmed === true, 'confirm', '请确认创建聊天并发送 Bug 内容。')
    requireThat(input.agent === 'codex' || input.agent === 'claude', 'input', '不支持的 Agent。')
    const plan = this.plans.get(input.preparationId)
    requireThat(plan && plan.expires > Date.now(), 'stale', '执行确认已过期，请重新打开。')
    const context = await this.service.repairContext(plan.detailId)
    requireThat(context.scope === plan.scope && context.task.id === plan.taskId && context.task.project.id === plan.source.id, 'stale', '账号或 Bug 项目已变化。')
    const key = this.key(plan.scope, plan.taskId)
    const existing = await this.existing(key)
    const restart = restartApproval ? plan.restart : existing?.phase === 'failed' ? { parent: existing, fingerprint: digest(existing) } : undefined
    if (restart) requireThat(digest(existing) === restart.fingerprint, 'stale', '执行记录已变化，请重新核对，未重复发送。')
    else if (existing) return existing
    const project = plan.projects.find(p => p.id === input.projectId)
    requireThat(project && (plan.mapping.kind !== 'mapped' || plan.mapping.project.id === project.id), 'scope', '所选项目不属于当前映射。')
    const fresh = (await this.cli.projects()).find(p => p.id === project.id)
    requireThat(fresh, 'stale', '本地项目已移除，请重新映射。')
    const target = await this.cli.target(fresh)
    requireThat(!hook || JSON.stringify(hook.target) === JSON.stringify(target), 'stale', '确认后 CLI 目标目录已变化。')
    const receipt: RepairRecord = { attemptId: randomUUID(), phase: 'preparing', ...(restart ? { restart: { previousAttempt: attemptKey(restart.parent), basis: restartApproval?.basis ?? '上轮未调用 Agent，重新准备', confirmedAt: Date.now() } } : {}), state: 'unknown', projectName: fresh.name, projectId: fresh.id, createdAt: Date.now() }
    const ledger = new RepairJournal(this.root)
    const journal = restart ? ledger.nextFile(key, restart.parent) : join(this.root, key + '.json')
    try { await ledger.claim(journal, receipt) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      requireThat(!restart, 'busy', '此轮已登记重新执行，请刷新记录，不能重复发送。')
      const prior = await this.existing(key)
      requireThat(prior, 'busy', '此 Bug 正在准备启动。')
      return prior
    }
    const assertCurrent = async () => {
      const current = await this.existing(key)
      requireThat(current && attemptKey(current) === receipt.attemptId, 'stale', '已有新执行轮次，旧启动已停止。')
    }
    let registered = false
    let attempted = false, directory: string | undefined, source: Awaited<ReturnType<Workbench['collectRepair']>> | undefined
    try {
      // 状态达到修复中且逐步回读后，才收集最新正文，避免旧状态快照失效。
      await hook?.beforeCollect()
      await restartApproval?.beforeCollect?.()
      source = await this.service.collectRepair(plan.detailId)
      if (restartApproval) requireThat(source.bug.task.status.name === '修复中', 'stale', 'Bug 已不处于修复中，请刷新并通过状态操作核对；本次重启不更改 ONES 状态。')
      await assertCurrent()
      directory = await mkdtemp(join(this.root, key + '-'))
      const files = new Map<string, string>()
      let total = 0
      for (const resource of mediaIds(source.bug)) {
        let offset = 0, mime = '', size = 0
        const chunks: Buffer[] = []
        for (;;) {
          const chunk = await source.read(resource, offset)
          requireThat(chunk.offset === offset && (offset === 0 || (chunk.mime === mime && chunk.total === size)), 'media', '媒体分块身份不一致。')
          mime = chunk.mime; size = chunk.total
          const bytes = Buffer.from(chunk.data, 'base64')
          total += bytes.length
          requireThat(bytes.length > 0 && total <= 64 * 1024 * 1024 && offset + bytes.length <= size, 'size', '媒体总量超过 64 MiB 或分块无效，未发送。')
          chunks.push(bytes)
          offset += bytes.length
          if (chunk.next === null) { requireThat(offset === size, 'partial', '媒体未完整读取。'); break }
          requireThat(chunk.next === offset, 'partial', '媒体分页未推进。')
        }
        // Unknown types stay opaque; remote filenames never become local paths.
        const file = join(directory, `${files.size + 1}.${Object.hasOwn(extension, mime) ? extension[mime] : 'bin'}`)
        await writeFile(file, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' })
        files.set(resource, file)
      }
      const revision = digest(source.bug)
      await assertCurrent()
      const entries = await ledger.entries(key)
      const ownIndex = entries.findIndex(x => attemptKey(x.record) === receipt.attemptId)
      requireThat(ownIndex >= 0 && ownIndex === entries.length - 1, 'stale', '已有新执行轮次，未覆盖回执缓存。')
      const ancestors = entries.slice(0, ownIndex).map(x => attemptKey(x.record))
      const contract = await this.cache.register(plan.scope, source.bug.task, receipt, revision, directory, restart?.parent, ancestors)
      registered = true
      // 协议先以独占私有文件完整落盘；失败沿原 registered cleanup 清理，绝不启动。
      const instructionsFile = join(directory, 'receipt-instructions.md')
      const instructions = await open(instructionsFile, 'wx', 0o600)
      try {
        await instructions.writeFile(repairInstructions(contract))
        await instructions.sync()
      } finally { await instructions.close() }
      await syncDirectory(directory)
      await assertPrivatePath(instructionsFile, 'file', '回执协议文件权限不安全，未启动。')
      const prompt = repairPrompt(source.bug, files, instructionsFile) + (restart ? '\n这是一次中断后的新执行轮次。先检查项目已有修改及遗留 Worktree，再决定继续路径；不得覆盖、回滚他人改动，不沿用旧轮次的测试通过结论。' : '')
      requireThat(Buffer.byteLength(prompt) <= 48000, 'size', '包含继续执行说明的消息超过 CLI 预算，未发送。')
      await source.validate()
      requireThat(!hook || source.bug.task.status.id === hook.targetStatus, 'stale', 'Agent 启动前 Bug 已不处于已确认的修复中状态，未启动。')
      const currentTarget = await this.cli.target(fresh)
      requireThat(JSON.stringify(currentTarget) === JSON.stringify(target), 'stale', '项目执行目录已变化。')
      await this.store.set(projectMappingKey(plan.scope, plan.source.id), { sourceProjectId: plan.source.id, targetProjectId: fresh.id })
      source.check()
      receipt.directory = directory
      await this.persist(journal, receipt)
      source.check()
      await assertCurrent()
      receipt.phase = 'launching'
      await this.persist(journal, receipt)
      await assertCurrent()
      source.check()
      attempted = true
      try { Object.assign(receipt, launchReceipt(await this.cli.launch(target, input.agent, prompt))) }
      catch { receipt.state = 'unknown' }
      receipt.phase = 'settled'
      await this.persist(journal, receipt)
      await assertCurrent()
      await this.cache.launched(plan.scope, plan.taskId, receipt)
      return receipt
    } finally {
      source?.dispose()
      this.plans.delete(input.preparationId)
      if (!attempted) {
        if (registered) await this.cache.abandon(plan.scope, plan.taskId, receipt.attemptId)
        if (directory) await rm(directory, { recursive: true, force: true })
        receipt.phase = 'failed'
        await this.persist(journal, receipt)
      }
    }
  }
  private async persist(file: string, receipt: RepairRecord) {
    const temp = file + '.' + randomUUID()
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync() }
    finally { await handle.close() }
    await rename(temp, file)
    await this.syncRoot()
  }
  private async syncRoot() {
    await syncDirectory(this.root)
  }
}
