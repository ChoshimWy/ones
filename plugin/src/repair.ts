import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, writeFile, rename, rm, lstat, mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OrcaCli, launchReceipt, type LaunchReceipt } from './adapters/orca-cli.ts'
import { mediaIds, repairPrompt } from './domain/repair-content.ts'
import { resolveProjectMapping, projectMappingKey, type MappingResult, type ProjectMapping } from './domain/project-mapping.ts'
import { requireThat, record, type Option } from './domain/model.ts'
import type { Store, Workbench } from './service.ts'

export type RepairRecord = LaunchReceipt & { projectName: string; projectId: string; createdAt: number; directory?: string }
export type RepairPreparation = { id: string; mapping: MappingResult; existing: RepairRecord | null }
type Plan = { detailId: string; scope: string; taskId: string; source: Option; mapping: MappingResult; projects: Option[]; expires: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' }

/** Durable no-resend journal. Unknown outcomes intentionally require human reconciliation. */
export class RepairWorkflow {
  private plans = new Map<string, Plan>()
  constructor(
    private service: Pick<Workbench, 'repairContext' | 'collectRepair'>,
    private store: Store,
    private cli = new OrcaCli(),
    private root = join(homedir(), 'Library', 'Application Support', 'ones-workbench', 'repairs')
  ) {}
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
  async start(input: { preparationId: string; projectId: string; agent: string; confirmed: boolean }): Promise<RepairRecord> {
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
    let attempted = false, directory: string | undefined, source: Awaited<ReturnType<Workbench['collectRepair']>> | undefined
    try {
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
      const prompt = repairPrompt(source.bug, files)
      await source.validate()
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
      return receipt
    } finally {
      source?.dispose()
      this.plans.delete(input.preparationId)
      if (!attempted) {
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
