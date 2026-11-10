import { RepairCache, type CachedRepairs, type RepairReport } from './repair-cache.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, writeFile, rename, rm, lstat, mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OrcaCli, launchReceipt, type LaunchReceipt } from './adapters/orca-cli.ts'
import { mediaIds, repairPrompt } from './domain/repair-content.ts'
import { resolveProjectMapping, projectMappingKey, type MappingResult, type ProjectMapping } from './domain/project-mapping.ts'
import { AppError, requireThat, record, type Option, type Task } from './domain/model.ts'
import type { Store, Workbench } from './service.ts'

export type RepairRecord = LaunchReceipt & { projectName: string; projectId: string; createdAt: number; directory?: string }
export type RepairListItem = { task: Task; record: RepairRecord; report?: RepairReport; reportError?: string }
export type RepairPreparation = { id: string; mapping: MappingResult; existing: RepairRecord | null }
type Plan = { detailId: string; scope: string; taskId: string; source: Option; mapping: MappingResult; projects: Option[]; expires: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' }

/** Durable no-resend journal. Unknown outcomes intentionally require human reconciliation. */
export class RepairWorkflow {
  private plans = new Map<string, Plan>()
  private cache: RepairCache
  private syncing = new Map<string, Promise<CachedRepairs>>()
  constructor(
    private service: Pick<Workbench, 'repairContext' | 'collectRepair'>,
    private store: Store,
    private cli = new OrcaCli(),
    private root = join(homedir(), 'Library', 'Application Support', 'ones-workbench', 'repairs')
  ) { this.cache = new RepairCache(root + '-cache') }
  private key(scope: string, taskId: string) { return digest([scope, taskId]) }
  private async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const st = await lstat(this.root)
    requireThat(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && st.uid === process.getuid?.(), 'storage', '修复资料目录权限不安全。')
  }
  private async existing(key: string): Promise<RepairRecord | null> {
    try {
      const file = join(this.root, key + '.json'), st = await lstat(file)
      requireThat(st.isFile() && !st.isSymbolicLink() && st.size <= 16000, 'storage', '修复启动记录不可安全读取，已停止。')
      const value = record(JSON.parse(await readFile(file, 'utf8')))
      requireThat(['sent', 'unknown', 'terminal'].includes(String(value.state)) && typeof value.projectId === 'string' && typeof value.projectName === 'string' && typeof value.createdAt === 'number', 'storage', '修复记录损坏，需人工核实。')
      return value as RepairRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  private async hasRoot(): Promise<boolean> {
    try {
      const st = await lstat(this.root)
      requireThat(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && st.uid === process.getuid?.(), 'storage', '修复资料目录权限不安全。')
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
    return { id, mapping, existing }
  }
  /// 详情读取完整执行结果，技术信息只在详情展示；不解析历史摘要猜状态。
  async result(detailId: string): Promise<RepairListItem | null> {
    const context = await this.service.repairContext(detailId)
    await this.cache.consume(context.scope, () => {})
    const item = (await this.cache.read(context.scope)).items.find(x=>x.task.id===context.task.id)
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
  async start(input: { preparationId: string; projectId: string; agent: string; confirmed: boolean }, hook?: { target: Awaited<ReturnType<OrcaCli['target']>>; targetStatus: string; beforeCollect(): Promise<void> }): Promise<RepairRecord> {
    requireThat(input.confirmed === true, 'confirm', '请确认创建聊天并发送 Bug 内容。')
    requireThat(input.agent === 'codex' || input.agent === 'claude', 'input', '不支持的 Agent。')
    const plan = this.plans.get(input.preparationId)
    requireThat(plan && plan.expires > Date.now(), 'stale', '执行确认已过期，请重新打开。')
    const context = await this.service.repairContext(plan.detailId)
    requireThat(context.scope === plan.scope && context.task.id === plan.taskId && context.task.project.id === plan.source.id, 'stale', '账号或 Bug 项目已变化。')
    const key = this.key(plan.scope, plan.taskId)
    const existing = await this.existing(key)
    if (existing) return existing
    const project = plan.projects.find(p => p.id === input.projectId)
    requireThat(project && (plan.mapping.kind !== 'mapped' || plan.mapping.project.id === project.id), 'scope', '所选项目不属于当前映射。')
    const fresh = (await this.cli.projects()).find(p => p.id === project.id)
    requireThat(fresh, 'stale', '本地项目已移除，请重新映射。')
    const target = await this.cli.target(fresh)
    requireThat(!hook || JSON.stringify(hook.target) === JSON.stringify(target), 'stale', '确认后 CLI 目标目录已变化。')
    const receipt: RepairRecord = { state: 'unknown', projectName: fresh.name, projectId: fresh.id, createdAt: Date.now() }
    const journal = join(this.root, key + '.json')
    let reservation
    try { reservation = await open(journal, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const prior = await this.existing(key)
        requireThat(prior, 'busy', '此 Bug 正在准备启动，请稍后查看。')
        return prior
      }
      throw error
    }
    // Empty or partial journal after a crash is fail-closed, never treated as permission to retry.
    try { await reservation.writeFile(JSON.stringify(receipt)); await reservation.sync() }
    finally { await reservation.close() }
    await this.syncRoot()
    let registered = false
    let attempted = false, directory: string | undefined, source: Awaited<ReturnType<Workbench['collectRepair']>> | undefined
    try {
      // 状态达到修复中且逐步回读后，才收集最新正文，避免旧状态快照失效。
      await hook?.beforeCollect()
      source = await this.service.collectRepair(plan.detailId)
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
        requireThat(extension[mime], 'media', '媒体格式暂不支持。')
        const file = join(directory, `${files.size + 1}.${extension[mime]}`)
        await writeFile(file, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' })
        files.set(resource, file)
      }
      const revision = digest(source.bug)
      const contract = await this.cache.register(plan.scope, source.bug.task, receipt, revision, directory)
      registered = true
      const prompt = repairPrompt(source.bug, files, contract)
      await source.validate()
      requireThat(!hook || source.bug.task.status.id === hook.targetStatus, 'stale', 'Agent 启动前 Bug 已不处于已确认的修复中状态，未启动。')
      const currentTarget = await this.cli.target(fresh)
      requireThat(JSON.stringify(currentTarget) === JSON.stringify(target), 'stale', '项目执行目录已变化。')
      await this.store.set(projectMappingKey(plan.scope, plan.source.id), { sourceProjectId: plan.source.id, targetProjectId: fresh.id })
      source.check()
      receipt.directory = directory
      await this.persist(journal, receipt)
      source.check()
      attempted = true
      try { Object.assign(receipt, launchReceipt(await this.cli.launch(target, input.agent, prompt))) }
      catch { receipt.state = 'unknown' }
      await this.persist(journal, receipt)
      await this.cache.launched(plan.scope, plan.taskId, receipt)
      return receipt
    } finally {
      source?.dispose()
      this.plans.delete(input.preparationId)
      if (!attempted) {
        if (registered) await this.cache.abandon(plan.scope, plan.taskId)
        if (directory) await rm(directory, { recursive: true, force: true })
        await rm(journal, { force: true })
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
    const directory = await open(this.root, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}
