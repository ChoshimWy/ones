import { HoursBatch, type HoursBatchRow, type HoursBatchResult } from './hours-batch.ts'
import { recentHoursMonths, alignedHoursMonth } from './domain/hours-year.ts'
import type { HoursMonth, HoursMonthStore, HoursTasks } from './hours-cache.ts'
import { classifyDay, monthDates, businessDate, type MissingDay } from './domain/missing-hours.ts'
import { OnesTransitions } from './adapters/ones-transitions.ts'
import { filterProject, projectMappingKey, type ProjectMapping } from './domain/project-mapping.ts'
import type { Option } from './domain/model.ts'
import { createHash, randomUUID } from 'node:crypto'
import { type Allocation, type Attendance, type Preview, type Site, type Status, type Worklog, AppError, id, record, requireThat, text, validDate } from './domain/model.ts'
import { apiHours, attendanceBudget, checkAllocations, existingMinutes, startSeconds, validateDescription } from './domain/attendance.ts'
import { Submission, assertNoPending, createReceipt, parseReceipts, protectedDayHash, receiptCandidates, type Ledger, type Receipt } from './domain/submission.ts'
import { type Day, type DayInput, type Draft, type ImplementationBrief, type LoginInput, type PreviewInput, type PendingWrite, type RecoveryPreview } from './protocol.ts'
import { COHO, ONES, Transport, type Fetcher } from './adapters/http.ts'
import { refreshOnes, loginOnes, type OnesSession } from './adapters/ones-auth.ts'
import { CohoClient, loginCoho, type CohoSession } from './adapters/coho.ts'
import { OnesClient, worklogWriter } from './adapters/ones.ts'
import { BugMediaStore } from './adapters/bug-media.ts'
import { assertDetailFits, type BugDetail, type Discussion, type Attachment, type DetailPage } from './adapters/bug-details.ts'
import { allPages, mediaIds, type CompleteBug } from './domain/repair-content.ts'
import type { BugContent } from './domain/bug-content.ts'
export interface Store { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }
export interface Vault { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
export interface Dependencies { store: Store; vault: Vault; protection(): Promise<boolean>; fetcher?: Fetcher; writesVerified?: boolean; hoursCache?: HoursMonthStore }
type SavedLogin = { account: string; password: string; principal: string; httpAcknowledged: boolean; paused: boolean; retryAfter: number }
type Snapshot = { input: DayInput; data: Day; identity: string; stamp: string }
type Confirmation = { view: Preview; snapshot: Snapshot; input: PreviewInput; identity: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class Workbench {
  private sessions: { ones?: OnesSession; coho?: CohoSession } = {}
  private epochs = { ones: 0, coho: 0 }
  private saved: Partial<Record<Site, SavedLogin>> = {}
  private manualLogins: Partial<Record<Site, number>> = {}
  private autoFlights: Partial<Record<Site, { epoch: number; promise: Promise<void>; controller: AbortController }>> = {}
  private authQueues: Record<Site, Promise<unknown>> = { ones: Promise.resolve(), coho: Promise.resolve() }
  private ready?: Promise<void>
  private readonly batch: HoursBatch
  private tasksEpoch = 0
  private dayEpoch = 0
  private hoursScanEpoch = 0
  private hoursScan?: { cursor: string; identity: string; team: string; month: string; scope: string; startedAt: number; today: string; results: MissingDay[]; dates: string[]; groups: Map<string, Worklog[]>; offset: number; attendance: (date: string, signal?: AbortSignal) => Promise<Attendance> }
  private day?: Snapshot
  private preview?: Confirmation
  private recovery?: { id: string; receiptId: string; team: string; identity: string; key: string; stamp: string; expiresAt: number }
  private detailEpoch = 0
  private detailRequest?: string
  private detail?: { team: string; taskId: string; identity: string; media: BugMediaStore; view: BugDetail }
  private writeBusy = false
  private onesTransport: Transport
  private cohoTransport: Transport
  constructor(private deps: Dependencies) {
    this.onesTransport = new Transport(ONES, deps.fetcher)
    this.cohoTransport = new Transport(COHO, deps.fetcher)
    this.batch = new HoursBatch({
      writesVerified: deps.writesVerified === true,
      identity: () => this.identity(), client: team => this.ones(team),
      fresh: (input, signal) => this.fetchDay(input, signal), ledger: () => this.ledger(), scope: client => this.scope(client),
      acquire: () => { requireThat(!this.writeBusy, 'busy', '另一个写入尚未结束。'); this.writeBusy = true },
      release: () => { this.writeBusy = false },
      invalidate: (team, months) => this.invalidateHoursMonths(team, months)
    })
  }
  private ensureReady(): Promise<void> {
    this.ready ??= this.restore().catch(error => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }
  private renewal?: { session: OnesSession; epoch: number; promise: Promise<void> }
  private async ensureOnesReady(): Promise<void> {
    await this.ensureReady()
    try { await this.renewOnes() } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'auth' || !this.saved.ones) throw error
    }
    if (!this.connected('ones')) await this.autoLogin('ones')
  }
  private async ensureCohoReady(): Promise<void> {
    await this.ensureReady()
    if (!this.connected('coho')) await this.autoLogin('coho')
  }
  private connected(site: Site): boolean {
    const session = this.sessions[site]
    return !!session && (session.expiresAt === null || session.expiresAt > Date.now())
  }
  private principal(site: Site, session: OnesSession | CohoSession): string {
    return site === 'ones' ? (session as OnesSession).userId : (session as CohoSession).principal
  }
  private stopAutoLogin(site: Site): void {
    ++this.epochs[site]
    this.autoFlights[site]?.controller.abort()
    this.invalidate()
  }
  private async autoLogin(site: Site): Promise<void> {
    requireThat(this.manualLogins[site] === undefined, 'auto_login', '正在手动登录，未使用旧凭据自动登录。')
    const epoch = this.epochs[site]
    const existing = this.autoFlights[site]
    if (existing?.epoch === epoch) return existing.promise
    let saved = this.saved[site]
    if (!saved) return
    requireThat(!saved.paused, 'auto_login', '自动登录已暂停，请手动登录以更新保存的凭据。')
    requireThat(saved.retryAfter <= Date.now(), 'auto_login', '自动登录暂缓，请稍后重试。')
    const controller = new AbortController()
    const current = () => this.epochs[site] === epoch && this.saved[site] === saved && !controller.signal.aborted
    const promise = (async () => {
      try {
        requireThat(await this.deps.protection(), 'secrets', '系统安全凭证存储不可用，未发送保存的密码。')
        await this.queue(site, async () => {
          requireThat(current(), 'cancelled', '自动登录已取消。')
          // A persisted claim prevents worker restarts from retrying an uncertain password attempt.
          const claimed = { ...saved!, paused: true, retryAfter: 0 }
          await this.deps.vault.set(`credentials.${site}`, JSON.stringify(claimed))
          requireThat(current(), 'cancelled', '自动登录已取消。')
          this.saved[site] = saved = claimed
        })
        requireThat(current(), 'cancelled', '自动登录已取消。')
        const session = site === 'ones'
          ? await loginOnes(this.onesTransport, saved!.account, saved!.password, saved!.httpAcknowledged, controller.signal)
          : await loginCoho(this.cohoTransport, saved!.account, saved!.password, controller.signal)
        requireThat(this.principal(site, session) === saved!.principal, 'identity', '自动登录身份与保存凭据不一致，请手动登录。')
        await this.queue(site, async () => {
          requireThat(current(), 'cancelled', '自动登录已取消。')
          const enabled = { ...saved!, paused: false, retryAfter: 0 }
          await this.persistLogin(site, session, enabled, current)
          this.saved[site] = saved = enabled
          if (site === 'ones') this.sessions.ones = session as OnesSession
          else this.sessions.coho = session as CohoSession
          ++this.epochs[site]
          this.invalidate()
        })
      } catch (error) {
        if (current()) {
          await this.queue(site, async () => {
            if (!current()) return
            if (error instanceof AppError && error.code === 'secrets') {
              // Protection unavailable: do not rewrite any password-bearing record.
              this.saved[site] = saved = { ...saved!, paused: true }
              return
            }
            const transient = error instanceof AppError && ['network', 'rate_limit'].includes(error.code)
            const failed = { ...saved!, paused: !transient, retryAfter: transient ? Date.now() + 60000 : 0 }
            await this.deps.vault.set(`credentials.${site}`, JSON.stringify(failed))
            if (current()) this.saved[site] = saved = failed
          })
        }
        throw new AppError('auto_login', '自动登录未完成，请检查连接；密码错误、验证码或账号锁定请手动处理。')
      }
    })()
    const flight = { epoch, promise, controller }
    this.autoFlights[site] = flight
    try { await promise } finally { if (this.autoFlights[site] === flight) delete this.autoFlights[site] }
  }
  // Vault has no multi-key transaction. Publish memory only after both writes; on
  // cancellation/failure restore the previous pair under the same per-site queue.
  private async persistLogin(site: Site, session: OnesSession | CohoSession, saved: SavedLogin | undefined, current: () => boolean): Promise<void> {
    const sessionKey = `session.${site}`, savedKey = `credentials.${site}`
    const oldSession = await this.deps.vault.get(sessionKey), oldSaved = await this.deps.vault.get(savedKey)
    requireThat(current(), 'cancelled', '登录已取消。')
    try {
      await this.deps.vault.set(sessionKey, JSON.stringify(session))
      if (saved) await this.deps.vault.set(savedKey, JSON.stringify(saved))
      else await this.deps.vault.delete(savedKey)
      requireThat(current(), 'cancelled', '登录已取消，未保留该次凭据。')
    } catch (error) {
      await this.restoreVault(sessionKey, oldSession)
      await this.restoreVault(savedKey, oldSaved)
      throw error
    }
  }
  private async restoreVault(key: string, value: string | null): Promise<void> {
    if (value === null) await this.deps.vault.delete(key)
    else await this.deps.vault.set(key, value)
  }
  private async renewOnes(): Promise<void> {
    const session = this.sessions.ones, epoch = this.epochs.ones
    if (!session?.refreshToken || session.expiresAt > Date.now() + 60000) return
    if (this.renewal?.session === session && this.renewal.epoch === epoch) return this.renewal.promise
    const current = () => this.sessions.ones === session && this.epochs.ones === epoch
    const promise = (async () => {
      try {
        requireThat(await this.deps.protection(), 'secrets', '系统安全凭证存储不可用，未发送续期令牌。')
        const renewed = await refreshOnes(this.onesTransport, session)
        await this.queue('ones', async () => {
          requireThat(current(), 'stale', '续期期间账号已变化。')
          await this.deps.vault.set('session.ones', JSON.stringify(renewed))
          // Logout/login can advance the epoch while the vault write is pending.
          if (!current()) {
            await this.deps.vault.set('session.ones', JSON.stringify(session))
            throw new AppError('stale', '续期期间账号已变化。')
          }
          this.sessions.ones = renewed
        })
      } catch (error) {
        if (error instanceof AppError && error.code === 'auth') {
          await this.queue('ones', async () => {
            if (!current()) return
            ++this.epochs.ones
            delete this.sessions.ones
            this.invalidate()
            await this.deps.vault.delete('session.ones')
          })
        }
        throw error
      }
    })()
    const flight = { session, epoch, promise }
    this.renewal = flight
    try { await promise } finally { if (this.renewal === flight) this.renewal = undefined }
  }
  private async restore(): Promise<void> {
    const restored: typeof this.sessions = {}
    const saved: typeof this.saved = {}
    for (const site of ['ones', 'coho'] as const) {
      const credentials = await this.deps.vault.get(`credentials.${site}`)
      if (credentials) {
        try {
          const value = record(JSON.parse(credentials))
          text(value.account, 254); text(value.password, 256); id(value.principal)
          requireThat(typeof value.httpAcknowledged === 'boolean' && (site !== 'ones' || value.httpAcknowledged === true) && typeof value.paused === 'boolean' && typeof value.retryAfter === 'number' && Number.isSafeInteger(value.retryAfter) && value.retryAfter >= 0, 'schema', '保存的登录选项无效。')
          saved[site] = value as SavedLogin
        } catch { /* Malformed saved credentials are never sent. */ }
      }
      const raw = await this.deps.vault.get(`session.${site}`)
      if (!raw) continue
      try {
        const stored = record(JSON.parse(raw)); text(stored.token, 16000); text(stored.label)
        requireThat((site === 'coho' && stored.expiresAt === null) || (typeof stored.expiresAt === 'number' && Number.isFinite(stored.expiresAt)), 'schema', '保存的有效期格式无效。')
        if (site === 'ones') {
          if (stored.refreshToken !== undefined) text(stored.refreshToken, 16000)
          id(stored.userId); requireThat(Array.isArray(stored.teams), 'schema', '团队信息无效。')
          stored.teams.forEach(t => { id(record(t).id); text(record(t).name) })
          restored.ones = stored as unknown as OnesSession
        } else { id(stored.principal); restored.coho = stored as unknown as CohoSession }
      } catch {
        // Invalid data is not proof of revocation. Preserve it; explicit login/logout can replace it.
      }
    }
    this.sessions = restored
    this.saved = saved
  }
  private queue<T>(site: Site, action: () => Promise<T>): Promise<T> {
    const next = this.authQueues[site].then(action, action)
    this.authQueues[site] = next.catch(() => {})
    return next
  }
  /// 身份变化使所有只读与业务确认失效；普通后台扫描不调用此入口。
  private invalidate(): void {
    this.invalidateHoursScan()
    this.tasksEpoch++
    this.dayEpoch++
    this.day = undefined
    this.preview = undefined
    this.batch.clear()
    this.recovery = undefined
    this.closeDetail()
  }
  /// 独立管理扫描代次，不废弃正在查看的单日或批量预览。
  private invalidateHoursScan(): void {
    this.hoursScanEpoch++
    this.hoursScan = undefined
  }
  /// 写入前清除受影响月份，旧扫描无法再发布已过期摘要。
  private async invalidateHoursMonths(team: string, months: string[]): Promise<void> {
    this.invalidateHoursScan()
    for (const month of months) await this.deps.hoursCache?.invalidate?.(this.hoursCacheScope(team), month)
  }
  private identity(): string {
    return digest([this.sessions.ones?.userId, this.sessions.coho?.principal, this.epochs.ones, this.epochs.coho])
  }
  async status(): Promise<Status> {
    await this.ensureReady()
    // Status must still be available after a failed automatic attempt.
    await Promise.allSettled([this.ensureOnesReady(), this.ensureCohoReady()])
    return this.statusView()
  }
  private statusView(): Status {
    const connection = (site: Site) => {
      const saved = this.saved[site]
      return { connected: this.connected(site), label: this.sessions[site]?.label ?? '未登录',
        ...(saved ? { savedLogin: { account: saved.account, paused: saved.paused, retryAfter: saved.retryAfter } } : {}) }
    }
    return { identity: this.identity(), ones: connection('ones'), coho: connection('coho'), teams: this.sessions.ones?.teams ?? [], writeEnabled: this.deps.writesVerified === true, blockers: ['工时写入尚待插件端到端验证，当前仅开放预览。', 'Coho 外勤标志与考勤异常规则仍需实例验证。', '执行修复通过 CLI 在已有项目创建聊天；媒体是本地引用，不能直接打开指定 session。', 'Bug 创建与内容修改尚未开放；状态更新按详情中的独立能力闸与字段配置校验，工时闸不受影响。'] }
  }
  async login(input: LoginInput, signal?: AbortSignal): Promise<Status> {
    await this.ensureReady()
    requireThat(input.site === 'ones' || input.site === 'coho', 'input', '登录站点无效。')
    requireThat(input.remember === undefined || typeof input.remember === 'boolean', 'input', '保存登录选项无效。')
    const site = input.site
    this.stopAutoLogin(site)
    const epoch = this.epochs[site]
    const account = text(input.account, 254).trim(); let password = text(input.password, 256)
    this.manualLogins[site] = epoch
    try {
      requireThat(await this.deps.protection(), 'secrets', '系统安全凭证存储不可用，未发送密码。')
      const session = site === 'ones' ? await loginOnes(this.onesTransport, account, password, input.httpAcknowledged, signal) : await loginCoho(this.cohoTransport, account, password, signal)
      await this.queue(site, async () => {
        const current = () => this.epochs[site] === epoch && !signal?.aborted
        requireThat(current(), 'cancelled', '登录已取消或身份已切换。')
        const saved = input.remember === true ? { account, password, principal: this.principal(site, session), httpAcknowledged: site === 'ones' && input.httpAcknowledged === true, paused: false, retryAfter: 0 } : undefined
        await this.persistLogin(site, session, saved, current)
        if (saved) this.saved[site] = saved
        else delete this.saved[site]
        ++this.epochs[site]
        this.invalidate()
        if (site === 'ones') this.sessions.ones = session as OnesSession
        else this.sessions.coho = session as CohoSession
      })
      return this.statusView()
    } finally {
      password = ''; input.password = ''
      if (this.manualLogins[site] === epoch) delete this.manualLogins[site]
    }
  }
  async forgetLogin(site: Site): Promise<Status> {
    await this.ensureReady()
    requireThat(site === 'ones' || site === 'coho', 'input', '站点无效。')
    this.stopAutoLogin(site)
    delete this.saved[site]
    await this.queue(site, () => this.deps.vault.delete(`credentials.${site}`))
    return this.statusView()
  }
  async logout(site: Site): Promise<Status> {
    await this.ensureReady()
    requireThat(site === 'ones' || site === 'coho', 'input', '站点无效。')
    this.stopAutoLogin(site)
    delete this.sessions[site]
    delete this.saved[site]
    await this.queue(site, async () => {
      // Remove the reusable password first; no logout can silently re-enable it.
      await this.deps.vault.delete(`credentials.${site}`)
      await this.deps.vault.delete(`session.${site}`)
    })
    return this.statusView()
  }
  private ones(team: string): OnesClient {
    const session = this.sessions.ones
    requireThat(session && session.expiresAt > Date.now(), 'auth', '请先登录 ONES。')
    return new OnesClient(this.onesTransport, session, team)
  }
  private coho(): CohoClient {
    const session = this.sessions.coho
    requireThat(session && (session.expiresAt === null || session.expiresAt > Date.now()), 'auth', '请先登录 Coho，工时必须基于考勤。')
    return new CohoClient(this.cohoTransport, session)
  }
  private async authenticated<T>(site: Site, action: () => Promise<T>, session = this.sessions[site]): Promise<T> {
    const epoch = this.epochs[site]
    try { return await action() } catch (error) {
      if (error instanceof AppError && error.code === 'auth') {
        await this.queue(site, async () => {
          if (this.epochs[site] !== epoch || this.sessions[site] !== session) return
          ++this.epochs[site]
          this.invalidate()
          if (site === 'ones' && this.sessions.ones?.refreshToken) {
            this.sessions.ones = { ...this.sessions.ones, expiresAt: 0 }
            await this.deps.vault.set('session.ones', JSON.stringify(this.sessions.ones))
          } else {
            delete this.sessions[site]
            await this.deps.vault.delete(`session.${site}`)
          }
        })
      }
      throw error
    }
  }
  async bugStatuses(team: string, signal?: AbortSignal) {
    await this.ensureOnesReady()
    return this.authenticated('ones', async () => {
      const identity = this.identity()
      const client = this.ones(team)
      await client.assertIdentity(signal)
      const statuses = await client.bugStatuses(signal)
      requireThat(identity === this.identity(), 'stale', '状态读取期间账号已变化，请重新读取。')
      return statuses
    })
  }
  async bugs(team: string, after = '', signal?: AbortSignal) {
    await this.ensureOnesReady()
    return this.authenticated('ones', async () => {
      const identity = this.identity()
      const client = this.ones(team)
      await client.assertIdentity(signal)
      const bugs = await client.bugs(after, signal)
      requireThat(identity === this.identity(), 'stale', '缺陷读取期间账号已变化，请重新读取。')
      return bugs
    })
  }
  async tasks(team: string, after = '', signal?: AbortSignal) {
    await this.ensureOnesReady()
    return this.authenticated('ones', async () => {
      const identity = this.identity(); const client = this.ones(team)
      await client.assertIdentity(signal)
      const tasks = await client.tasks(after, signal)
      requireThat(identity === this.identity(), 'stale', '读取期间账号已变化，请重新读取。')
      return tasks
    })
  }
  closeDetail(detailId?: string): void {
    if (detailId !== undefined && this.detail?.media.detailId !== detailId && this.detailRequest !== detailId) return
    this.detailEpoch++
    this.detailRequest = undefined
    this.detail?.media.dispose()
    this.detail = undefined
  }
  private registerContent(media: BugMediaStore, content: BugContent[]): void {
    media.allow(content.flatMap(block => block.kind === 'media' ? [block.resourceId] : []))
  }
  async bugDetail(team: string, taskId: string, signal?: AbortSignal, requestId?: string): Promise<BugDetail & {detailId:string}> {
    await this.ensureOnesReady()
    this.closeDetail()
    if (requestId !== undefined) this.detailRequest = id(requestId)
    const epoch = this.detailEpoch
    return this.authenticated('ones', async () => {
      const identity = this.identity()
      const client = this.ones(team)
      await client.assertIdentity(signal)
      const task = await client.task(taskId,signal)
      await client.assertBug(task,signal)
      const reader = client.details()
      const content = await reader.content(task,signal)
      const comments = await reader.comments(taskId,undefined,signal)
      const attachments = await reader.attachments(taskId,undefined,signal)
      requireThat(identity === this.identity() && epoch === this.detailEpoch && !signal?.aborted,'stale','读取期间身份或详情已变化，请重新打开。')
      const media = new BugMediaStore(this.onesTransport,team,client.session.token)
      this.registerContent(media,content.content)
      comments.items.forEach(comment => this.registerContent(media,comment.content))
      media.allow(attachments.items.map(attachment=>attachment.id))
      const result = {detailId:media.detailId,task,...content,comments,attachments}
      assertDetailFits(result)
      this.detail = {team,taskId,identity,media,view:result}
      return result
    })
  }
  async projectFilter(team: string, localProject: Option | null, projects: Option[]) {
    await this.ensureOnesReady()
    const client = this.ones(team), identity = this.identity()
    requireThat(Array.isArray(projects) && projects.length <= 2000, 'input', '项目筛选范围过大。')
    const candidates = projects.map(p => ({ id: id(p.id), name: text(p.name, 500) }))
    requireThat(new Set(candidates.map(p => p.id)).size === candidates.length, 'input', '项目身份重复。')
    const bindings: ProjectMapping[] = []
    if (localProject) for (const project of candidates) {
      const saved = await this.deps.store.get(projectMappingKey(this.scope(client), project.id))
      if (saved) {
        const value = record(saved)
        requireThat(value.sourceProjectId === project.id && typeof value.targetProjectId === 'string', 'schema', '项目映射无效。')
        bindings.push({ sourceProjectId: project.id, targetProjectId: value.targetProjectId })
      }
    }
    requireThat(identity === this.identity(), 'stale', '账号已变化，请重新读取项目筛选。')
    return { localProject, project: filterProject(localProject, candidates, bindings) }
  }
  /// 本地缓存只绑定仍有效的登录身份；首屏不联网，所有远端动作另外鉴权。
  async repairCacheContext(team: string, signal?: AbortSignal) {
    await this.ensureOnesReady()
    const identity = this.identity(), client = this.ones(team)
    const check = () => {
      signal?.throwIfAborted()
      requireThat(identity === this.identity(), 'stale', '账号已变化，请重新读取执行记录。')
      this.ones(team)
    }
    return { scope: this.scope(client), check }
  }
  async repairListContext(team: string, signal?: AbortSignal) {
    await this.ensureOnesReady()
    const identity = this.identity(), client = this.ones(team)
    const check = () => {
      signal?.throwIfAborted()
      requireThat(identity === this.identity(), 'stale', '账号已变化，请重新读取执行记录。')
    }
    await client.assertIdentity(signal)
    const reader = await client.repairReader(signal)
    check()
    return {
      scope: this.scope(client), check,
      readTask: async (taskId: string) => {
        check()
        const task = await reader.task(taskId)
        check()
        return task
      },
      readPage: async (after: string) => {
        check()
        const page = await reader.page(after)
        check()
        return page
      }
    }
  }
  /// 状态业务上下文固定在当前详情，关闭或切身份立即撤销未发送确认。
  async transitionContext(detailId: string) {
    await this.ensureOnesReady()
    const detail = this.currentDetail(detailId), client = this.ones(detail.team)
    await client.assertIdentity()
    const check = () => { requireThat(this.currentDetail(detailId) === detail, 'stale', '详情或身份已变化，请重新打开。') }
    const task = await client.task(detail.taskId)
    check()
    requireThat(task.project.id === detail.view.task.project.id && task.issueType.id === detail.view.task.issueType.id, 'stale', 'Bug 项目或类型已变化，请重新打开。')
    detail.view = { ...detail.view, task }
    return { scope: this.scope(client), task, adapter: new OnesTransitions(this.onesTransport, client.session, detail.team), check }
  }
  async repairContext(detailId: string) {
    await this.ensureOnesReady()
    const detail = this.currentDetail(detailId)
    const client = this.ones(detail.team)
    await client.assertIdentity()
    requireThat(this.currentDetail(detailId) === detail, 'stale', '详情或账号已变化。')
    return { scope: this.scope(client), task: detail.view.task }
  }
  async collectRepair(detailId: string, signal?: AbortSignal) {
    await this.ensureOnesReady()
    const detail = this.currentDetail(detailId)
    const client = this.ones(detail.team)
    const check = () => {
      requireThat(!signal?.aborted && this.currentDetail(detailId) === detail, 'stale', '详情或账号已变化，已取消启动。')
    }
    await client.assertIdentity(signal)
    check()
    const task = await client.task(detail.taskId, signal)
    await client.assertBug(task, signal)
    requireThat(task.project.id === detail.view.task.project.id, 'stale', 'Bug 项目已变化，请刷新详情。')
    const reader = client.details(), body = await reader.content(task, signal)
    const comments = await allPages(await reader.comments(task.id, undefined, signal), before => reader.comments(task.id, before, signal))
    const attachments = await allPages(await reader.attachments(task.id, undefined, signal), before => reader.attachments(task.id, before, signal))
    check()
    const bug: CompleteBug = { task, ...body, comments, attachments }
    const media = new BugMediaStore(this.onesTransport, detail.team, client.session.token)
    try { media.allow(mediaIds(bug)) } catch (error) { media.dispose(); throw error }
    return {
      bug,
      read: async (resource: string, offset: number) => { check(); return media.read(media.detailId, resource, offset, signal) },
      validate: async () => {
        await client.assertIdentity(signal)
        const freshTask = await client.task(task.id, signal)
        const fresh = await reader.content(freshTask, signal)
        check()
        requireThat(JSON.stringify(freshTask) === JSON.stringify(task) && fresh.updatedAt === body.updatedAt, 'stale', 'Bug 收集期间已更新，请刷新后重试。')
      },
      check,
      dispose: () => media.dispose()
    }
  }
  private currentDetail(detailId: string) {
    const detail = this.detail
    requireThat(detail && detail.media.detailId === detailId && detail.identity === this.identity(),'stale','详情已变化，请重新打开。')
    this.ones(detail.team)
    return detail
  }
  async detailComments(detailId: string, before: number | undefined, signal?: AbortSignal): Promise<DetailPage<Discussion>> {
    await this.ensureOnesReady()
    return this.authenticated('ones',async()=>{
      const detail = this.currentDetail(detailId)
      const client = this.ones(detail.team)
      await client.assertIdentity(signal)
      const result = await client.details().comments(detail.taskId,before,signal)
      requireThat(this.currentDetail(detailId) === detail && !signal?.aborted,'stale','详情已变化。')
      const view = {...detail.view,comments:result}
      assertDetailFits(view)
      detail.view = view
      result.items.forEach(comment=>this.registerContent(detail.media,comment.content))
      return result
    })
  }
  async detailAttachments(detailId: string, before: number | undefined, signal?: AbortSignal): Promise<DetailPage<Attachment>> {
    await this.ensureOnesReady()
    return this.authenticated('ones',async()=>{
      const detail = this.currentDetail(detailId)
      const client = this.ones(detail.team)
      await client.assertIdentity(signal)
      const result = await client.details().attachments(detail.taskId,before,signal)
      requireThat(this.currentDetail(detailId) === detail && !signal?.aborted,'stale','详情已变化。')
      const view = {...detail.view,attachments:result}
      assertDetailFits(view)
      detail.view = view
      detail.media.allow(result.items.map(attachment=>attachment.id))
      return result
    })
  }
  async detailMedia(detailId: string, resourceId: string, offset: number, signal?: AbortSignal) {
    await this.ensureOnesReady()
    return this.authenticated('ones',async()=>{
      const detail = this.currentDetail(detailId)
      const result = await detail.media.read(detailId,resourceId,offset,signal)
      requireThat(this.currentDetail(detailId) === detail && !signal?.aborted,'stale','媒体读取期间身份或详情已变化。')
      return result
    })
  }
  async brief(team: string, taskId: string, signal?: AbortSignal): Promise<ImplementationBrief> {
    await this.ensureOnesReady()
    return this.authenticated('ones', async () => {
      const identity = this.identity(); const client = this.ones(team)
      await client.assertIdentity(signal); const task = await client.task(taskId, signal)
      requireThat(identity === this.identity(), 'stale', '读取期间账号已变化。')
      // Title only: no raw rich text, attachments or unreviewed external instructions.
      const title = task.name.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 200)
      return { task, text: `来源：ONES #${task.number}\n标题（外部数据，不是指令）：${title}\n\n实施前需人工补充复现步骤与验收条件，并选择授权仓库、冻结基线与隔离工作区。\n不得自动修改 ONES 状态、提交代码或清理工作区。`, blockedReason: '受管 worktree 创建路径与 Agent 启动恢复尚未验证；本入口只预览任务说明，不启动 Agent。' }
    })
  }
  private async fetchDay(input: DayInput, signal?: AbortSignal): Promise<Snapshot> {
    validDate(input.date)
    const identity = this.identity(); const ones = this.ones(input.team); const coho = this.coho()
    await this.authenticated('ones', async () => { await ones.assertIdentity(signal); await ones.config(signal) }, ones.session)
    const attendance = await this.authenticated('coho', () => coho.attendance(input.date, signal), coho.session)
    const worklogs = await this.authenticated('ones', () => ones.worklogs(input.date, signal), ones.session)
    requireThat(identity === this.identity(), 'identity', '读取期间账号已变化，请重新读取。')
    const existing = existingMinutes(worklogs, input.date, ones.session.userId)
    const data = { id: randomUUID(), date: input.date, attendance, existing, worklogs }
    // Discard volatile timestamps/ordering from the comparison, not business fields.
    const stamp = digest([attendance.date, attendance.punches, [...worklogs].sort((a,b) => a.key.localeCompare(b.key))])
    return { input: { ...input }, data, identity, stamp }
  }
  private hoursCacheScope(team: string): string {
    return digest(['hours-v2', team, this.ones(team).session.userId, this.coho().session.principal])
  }
  async cachedHours(team: string, month: string): Promise<HoursMonth | null> {
    monthDates(month)
    await this.ensureReady()
    const identity = this.identity()
    const scope = this.hoursCacheScope(team)
    requireThat(this.deps.hoursCache, 'cache', '考勤缓存不可用。')
    const cached = await this.deps.hoursCache.read(scope, month)
    requireThat(identity === this.identity(), 'stale', '账号已变化，缓存读取失效。')
    return cached
  }
  /// 一次本地读取近一年摘要，失败月份不伪造为空月份。
  async cachedHoursYear(team: string): Promise<HoursMonth[]> {
    await this.ensureReady()
    const identity = this.identity()
    const months: HoursMonth[] = []
    for (const month of recentHoursMonths()) {
      const cached = await this.cachedHours(team, month)
      requireThat(identity === this.identity(), 'stale', '年度缓存读取期间账号已变化。')
      if (cached) months.push(cached)
    }
    return months
  }
  /// 普通任务的本地目录；按两站身份和团队隔离。
  async cachedHoursTasks(team: string): Promise<HoursTasks | null> {
    await this.ensureReady()
    const identity = this.identity()
    const value = await this.deps.hoursCache?.readTasks?.(this.hoursCacheScope(team)) ?? null
    requireThat(identity === this.identity(), 'stale', '任务缓存读取期间账号已变化。')
    return value
  }
  /// 完整读取普通任务分页后一次性发布，失败不覆盖上次成功目录。
  async syncHoursTasks(team: string, signal?: AbortSignal): Promise<HoursTasks> {
    await this.ensureOnesReady()
    await this.ensureCohoReady()
    const epoch = ++this.tasksEpoch
    const identity = this.identity()
    const client = this.ones(team)
    const scope = this.hoursCacheScope(team)
    const startedAt = Date.now()
    const check = () => requireThat(epoch === this.tasksEpoch && identity === this.identity() && !signal?.aborted, 'stale', '任务读取已失效。')
    return this.authenticated('ones', async () => {
      await client.assertIdentity(signal)
      const typeId = await client.ordinaryTaskType(signal)
      const items: HoursTasks['items'] = []
      const cursors = new Set<string>()
      let after = ''
      for (let page = 0; page < 20; page++) {
        check()
        const value = await client.ordinaryTasks(typeId, after, signal)
        requireThat(!value.items.some(task => items.some(previous => previous.id === task.id)), 'partial', '任务分页重复，未替换本地目录。')
        items.push(...value.items)
        if (value.nextCursor === null) {
          const result = { typeId, items, savedAt: startedAt }
          check()
          requireThat(this.deps.hoursCache?.publishTasks, 'cache', '任务数据库不可用，未保存目录。')
          await this.deps.hoursCache.publishTasks(scope, result, check)
          check()
          return result
        }
        requireThat(!cursors.has(value.nextCursor), 'partial', '任务分页游标重复。')
        cursors.add(value.nextCursor)
        after = value.nextCursor
      }
      throw new AppError('partial', '普通任务超过 20 页，目录未完成，未替换本地缓存。')
    }, client.session)
  }
  /// 批量预览只读，生产提交能力由批量类内部再次硬检查。
  async previewHoursBatch(team: string, rows: HoursBatchRow[], signal?: AbortSignal) {
    await this.ensureOnesReady()
    await this.ensureCohoReady()
    requireThat(!this.writeBusy, 'busy', '提交尚未结束，请稍后预览。')
    return this.batch.preview(team, rows, signal)
  }
  /// 消费确认 token；返回结果本地保存，重入页面仍可查看部分完成状态。
  async submitHoursBatch(previewId: string, confirmed: boolean, team: string): Promise<HoursBatchResult> {
    await this.ensureOnesReady()
    const identity = this.identity()
    const scope = this.hoursCacheScope(team)
    const result = await this.batch.submit(previewId, confirmed, team)
    if (identity === this.identity()) await this.deps.store.set('hours.batch.result.' + scope, result)
    return result
  }
  /// 最近批量结果与既有待核实账本共同保留，不因离开页面而丢失。
  async hoursBatchResult(team: string): Promise<HoursBatchResult | null> {
    await this.ensureReady()
    const identity = this.identity()
    const result = await this.deps.store.get('hours.batch.result.' + this.hoursCacheScope(team))
    requireThat(identity === this.identity(), 'stale', '结果读取期间账号已变化。')
    if (result === null || result === undefined) return null
    const data = record(result)
    requireThat(Array.isArray(data.rows) && data.rows.length > 0 && data.rows.length <= 31, 'ledger', '批量结果记录损坏，请查看操作核对。')
    const rows = data.rows.map(value => {
      const row = record(value)
      requireThat(['verified', 'unknown', 'not_attempted'].includes(String(row.state)), 'ledger', '批量结果状态无效。')
      return { date: validDate(row.date), state: row.state as HoursBatchResult['rows'][number]['state'], message: text(row.message, 2000) }
    })
    requireThat(new Set(rows.map(row => row.date)).size === rows.length, 'ledger', '批量结果日期重复。')
    return { rows }
  }
  async scanHours(input: { team: string; month: string; cursor?: string; force?: boolean }, signal?: AbortSignal) {
    const dates = monthDates(input.month)
    const requestEpoch = this.hoursScanEpoch
    requireThat(!this.writeBusy, 'busy', '工时提交中，暂停后台对账。')
    if (!input.cursor && input.force !== true && this.deps.hoursCache) {
      const cached = await this.cachedHours(input.team, input.month)
      requireThat(!this.writeBusy && requestEpoch === this.hoursScanEpoch && !signal?.aborted, 'stale', '对账期间写入或查询状态已变化。')
      if (alignedHoursMonth(cached)) return { days: cached!.days, nextCursor: null, total: cached!.days.length, savedAt: cached!.savedAt }
    }
    await this.ensureOnesReady()
    await this.ensureCohoReady()
    const identity = this.identity()
    const ones = this.ones(input.team)
    const coho = this.coho()
    requireThat(!this.writeBusy && requestEpoch === this.hoursScanEpoch, 'stale', '后台查询已失效或正在写入。')
    let epoch = this.hoursScanEpoch
    const check = () => requireThat(!this.writeBusy && epoch === this.hoursScanEpoch && identity === this.identity() && !signal?.aborted, 'stale', '查询已取消或账号变化，请重新读取。')
    if (!input.cursor) {
      this.invalidateHoursScan()
      epoch = this.hoursScanEpoch
      await this.authenticated('ones', async () => { await ones.assertIdentity(signal); await ones.config(signal) }, ones.session)
      const worklogs = await this.authenticated('ones', () => ones.worklogsRange(dates[0]!, dates[dates.length - 1]!, signal), ones.session)
      check()
      const groups = new Map(dates.map(date => [date, [] as Worklog[]]))
      for (const row of worklogs) {
        requireThat(Number.isFinite(row.startTime), 'schema', '工时日期无效。')
        const date = new Date((row.startTime + 28800) * 1000).toISOString().slice(0, 10)
        const group = groups.get(date)
        requireThat(group, 'schema', '接口返回了查询范围外的工时。')
        group.push(row)
      }
      this.hoursScan = { cursor: randomUUID(), identity, team: input.team, month: input.month, scope: this.hoursCacheScope(input.team), startedAt: Date.now(), today: businessDate(), results: [], dates, groups, offset: 0, attendance: coho.attendanceReader() }
    }
    const scan = this.hoursScan
    requireThat(scan && scan.identity === identity && scan.team === input.team && scan.month === input.month &&
      (!input.cursor || input.cursor === scan.cursor), 'stale', '扫描已失效，请重新查询。')
    // Consume the cursor before I/O: concurrent retries cannot duplicate a chunk.
    scan.cursor = randomUUID()
    const days: MissingDay[] = []
    try {
      for (const date of scan.dates.slice(scan.offset, scan.offset + 7)) {
        check()
        const existing = existingMinutes(scan.groups.get(date)!, date, ones.session.userId)
        try {
          const attendance = await this.authenticated('coho', () => scan.attendance(date, signal), coho.session)
          requireThat(attendance.date === date, 'schema', '考勤日期不匹配。')
          days.push(classifyDay(attendance, existing))
        } catch (error) {
          // Only an explicitly covered day with zero punches is exempt. A requested-day
          // coverage gap or attributable field error needs review; unassignable structure aborts the scan.
          if (!(error instanceof AppError)) throw error
          if (error.code === 'no_attendance') {
            days.push(classifyDay({ date, punches: [], fetchedAt: Date.now() }, existing))
          } else if (error.code === 'attendance') {
            days.push({ date, existing, budget: null, remaining: null, state: 'review', reason: error.message })
          } else throw error
        }
        if (date === scan.today) {
          const last = days[days.length - 1]!
          last.state = 'pending'
          last.remaining = null
          last.reason = '当天尚未结束，不判定缺失工时。'
        }
        check()
        requireThat(this.hoursScan === scan, 'stale', '扫描已被新的查询替换。')
      }
      scan.results.push(...days)
      scan.offset += days.length
      const nextCursor = scan.offset < scan.dates.length ? scan.cursor : null
      let savedAt: number | null = null
      if (!nextCursor) {
        if (this.deps.hoursCache) {
          try {
            await this.deps.hoursCache.publish(scan.scope, { month: scan.month, days: scan.results, savedAt: scan.startedAt }, () => {
              check()
              requireThat(this.hoursScan === scan, 'stale', '扫描已失效，未保存缓存。')
            })
            savedAt = scan.startedAt
          } catch { /* A cache failure must not discard a complete authoritative read. */ }
        }
        check()
        requireThat(this.hoursScan === scan, 'stale', '扫描已失效。')
        this.hoursScan = undefined
      }
      return { days, nextCursor, total: scan.dates.length, savedAt }
    } catch (error) {
      if (this.hoursScan === scan) this.hoursScan = undefined
      throw error
    }
  }
  async readDay(input: DayInput, signal?: AbortSignal): Promise<Day> {
    await this.ensureOnesReady()
    await this.ensureCohoReady()
    const epoch = ++this.dayEpoch
    this.day = undefined
    this.preview = undefined
    const snapshot = await this.fetchDay(input, signal)
    requireThat(epoch === this.dayEpoch && !signal?.aborted, 'stale', '日期读取已被替换。')
    this.day = snapshot
    return snapshot.data
  }
  async makePreview(input: PreviewInput, signal?: AbortSignal): Promise<Preview> {
    await this.ensureOnesReady()
    const snapshot = this.day
    requireThat(snapshot && snapshot.data.id === input.dayId && snapshot.identity === this.identity() && Date.now() - snapshot.data.attendance.fetchedAt < 300000, 'stale', '考勤或身份已过期，请重新读取。')
    const budget = attendanceBudget(snapshot.data.attendance)
    const allocations = structuredClone(input.allocations)
    const proposed = checkAllocations(allocations, budget, snapshot.data.existing)
    const client = this.ones(snapshot.input.team)
    const rows = []
    for (const allocation of allocations) {
      const task = await client.ordinaryTask(id(allocation.taskId), signal)
      rows.push({ ...allocation, taskName: task.name })
    }
    requireThat(this.day === snapshot && snapshot.identity === this.identity(), 'stale', '预览期间身份或考勤已变化。')
    const view = { id: randomUUID(), date: snapshot.input.date, budget, existing: snapshot.data.existing, proposed, remaining: budget - snapshot.data.existing - proposed, rows, expiresAt: Date.now() + 300000 }
    this.preview = { view, snapshot, input: structuredClone(input), identity: this.identity() }
    return view
  }
  async submit(previewId: string, confirmed: boolean): Promise<{ count: number }> {
    await this.ensureOnesReady()
    requireThat(this.deps.writesVerified === true, 'not_verified', '插件工时写入尚未完成端到端验证，当前禁止提交。')
    requireThat(!this.writeBusy, 'busy', '另一个写入尚未结束。'); this.writeBusy = true
    try {
      const confirmation = this.preview
      requireThat(confirmed === true && confirmation && confirmation.view.id === previewId && confirmation.identity === this.identity() && confirmation.view.expiresAt > Date.now(), 'stale', '请重新预览并确认工时。')
      this.preview = undefined // one-shot confirmation; errors never revive it
      const client = this.ones(confirmation.snapshot.input.team)
      const fresh = await this.fetchDay(confirmation.snapshot.input)
      requireThat(fresh.stamp === confirmation.snapshot.stamp && fresh.identity === confirmation.identity, 'stale', '考勤或已登记工时发生变化，请重新分配。')
      const budget = attendanceBudget(fresh.data.attendance)
      checkAllocations(confirmation.input.allocations, budget, fresh.data.existing)
      const scope = digest([ONES, client.team, client.session.userId])
      const ledger = this.ledger()
      await this.invalidateHoursMonths(confirmation.snapshot.input.team, [fresh.input.date.slice(0, 7)])
      const writer = new Submission(ledger, worklogWriter(client))
      let count = 0
      for (const allocation of confirmation.input.allocations) {
        requireThat(this.identity() === confirmation.identity, 'identity', '身份发生变化，后续提交已停止。')
        await client.ordinaryTask(allocation.taskId)
        const rows = await client.worklogs(fresh.input.date)
        checkAllocations([allocation], budget, existingMinutes(rows, fresh.input.date, client.session.userId))
        const intent = { scope, date: fresh.input.date, task: allocation.taskId, owner: client.session.userId, hours: apiHours(allocation.minutes), startTime: startSeconds(fresh.input.date, allocation.start), description: allocation.description }
        requireThat(this.identity() === confirmation.identity, 'identity', '提交前账号已变化，未发送本笔写入。')
        await writer.add(intent, digest([previewId, count, intent]), rows); count++
      }
      this.invalidate()
      return { count }
    } finally { this.writeBusy = false }
  }
  private ledger(): Ledger {
    return {
      load: async () => parseReceipts(await this.deps.store.get('receipts')),
      save: rows => this.deps.store.set('receipts', structuredClone(rows))
    }
  }
  private scope(client: OnesClient): string { return digest([ONES, client.team, client.session.userId]) }
  async worklogs(team: string, date: string, signal?: AbortSignal): Promise<Worklog[]> {
    await this.ensureOnesReady()
    validDate(date)
    return this.authenticated('ones', async () => {
      const identity = this.identity()
      const client = this.ones(team)
      await client.assertIdentity(signal)
      const rows = await client.worklogs(date, signal)
      existingMinutes(rows, date, client.session.userId)
      requireThat(identity === this.identity(), 'stale', '读取期间账号已变化。')
      return rows
    })
  }
  async pending(team: string): Promise<PendingWrite[]> {
    await this.ensureOnesReady()
    const client = this.ones(team)
    return (await this.ledger().load()).filter(row => row.scope === this.scope(client) && row.state !== 'verified').map(row => ({
      id: row.id, kind: row.kind, date: row.intent.date, minutes: row.intent.hours * 60 / 100000,
      state: row.state as 'submitting' | 'unknown', hasKey: !!row.key
    }))
  }
  async previewRecovery(team: string, receiptId: string, signal?: AbortSignal): Promise<RecoveryPreview> {
    await this.ensureOnesReady()
    requireThat(!this.writeBusy, 'busy', '写入或核对仍在进行。')
    this.recovery = undefined
    const identity = this.identity()
    const client = this.ones(team)
    const receipt = (await this.ledger().load()).find(row => row.id === receiptId && row.scope === this.scope(client) && row.state !== 'verified')
    requireThat(receipt, 'identity', '当前身份没有这条待核实操作。')
    const rows = await this.worklogs(team, receipt.intent.date, signal)
    const matches = receiptCandidates(receipt, rows)
    requireThat(identity === this.identity(), 'stale', '核对期间账号已变化。')
    if (matches.length !== 1) return { id: null, receiptId, matchCount: matches.length, candidate: null, message: matches.length ? '发现多个符合项，无法唯一归属；继续阻断，不自动重试。' : '没有找到完整匹配项，不代表写入失败；继续阻断，不自动重试。' }
    const candidate = matches[0]
    const view = { id: randomUUID(), receiptId, team, identity, key: candidate.key, stamp: digest(rows), expiresAt: Date.now() + 300000 }
    this.recovery = view
    return { id: view.id, receiptId, matchCount: 1, candidate, message: '请核对该记录确属本次操作。确认只更新本地核对状态，不新增或修改 ONES 工时。' }
  }
  async confirmRecovery(previewId: string, confirmed: boolean): Promise<{ verified: true }> {
    await this.ensureOnesReady()
    requireThat(confirmed === true && !this.writeBusy, 'confirmation', '请确认匹配记录属于本次操作。')
    const view = this.recovery
    requireThat(view && view.id === previewId && view.identity === this.identity() && view.expiresAt > Date.now(), 'stale', '核对预览已失效，请重新回读。')
    this.recovery = undefined
    this.writeBusy = true
    try {
      const client = this.ones(view.team)
      const ledger = this.ledger()
      const receipts = await ledger.load()
      const receipt = receipts.find(row => row.id === view.receiptId && row.scope === this.scope(client) && row.state !== 'verified')
      requireThat(receipt, 'identity', '待核实操作已变化。')
      const rows = await this.worklogs(view.team, receipt.intent.date)
      const matches = receiptCandidates(receipt, rows)
      requireThat(view.identity === this.identity() && digest(rows) === view.stamp && matches.length === 1 && matches[0].key === view.key, 'conflict', '记录或身份已变化，未解除阻断。')
      receipt.key = view.key
      receipt.state = 'verified'
      await ledger.save(receipts)
      this.invalidate()
      return { verified: true }
    } finally { this.writeBusy = false }
  }
  async describe(input: { team: string; date: string; key: string; description: string; confirmed: boolean }) {
    await this.ensureOnesReady()
    requireThat(this.deps.writesVerified === true, 'not_verified', '插件描述更新尚未完成端到端验证，当前禁止提交。')
    requireThat(input.confirmed === true && !this.writeBusy, 'confirmation', '请确认更新且等待其它写入结束。')
    validateDescription(input.description)
    this.writeBusy = true
    try {
      const identity = this.identity()
      const client = this.ones(input.team)
      validDate(input.date)
      await client.assertIdentity()
      await client.config()
      const ledger = this.ledger()
      const receipts = await ledger.load()
      assertNoPending(receipts, this.scope(client))
      requireThat(receipts.length < 1000, 'ledger', '本地操作记录已达到上限。')
      const writer = worklogWriter(client)
      const original = await writer.get(text(input.key, 150))
      requireThat(original.owner === client.session.userId && original.type === 'recorded', 'identity', '不是本人登记工时。')
      const before = await client.worklogs(input.date)
      existingMinutes(before, input.date, client.session.userId)
      requireThat(before.filter(row => row.key === original.key).length === 1, 'identity', '原日期无法唯一定位该工时。')
      if (original.description === input.description) return { key: original.key }
      requireThat(original.description.trim() === '', 'conflict', '原记录已有不同描述，禁止覆盖。')
      const latest = await writer.get(original.key)
      requireThat(JSON.stringify(latest) === JSON.stringify(original), 'conflict', '原记录已变化，请重新确认。')
      const intent = { scope: this.scope(client), date: input.date, task: original.task, owner: original.owner, hours: original.hours, startTime: original.startTime, description: input.description }
      const receipt = createReceipt(intent, digest([randomUUID(), intent]), before, 'describe', original.key)
      receipts.push(receipt)
      await ledger.save(receipts)
      requireThat(identity === this.identity(), 'identity', '更新前账号已变化，未发送描述更新。')
      await writer.describe(original.key, input.description)
      const after = await client.worklogs(input.date)
      const amended = await writer.get(original.key)
      requireThat(identity === this.identity() && receiptCandidates(receipt, after).length === 1 && protectedDayHash([amended], original.key) === protectedDayHash([original], original.key) && amended.description === input.description, 'readback', '更新后保护字段不一致，请核实。')
      receipt.state = 'verified'
      await ledger.save(receipts)
      this.invalidate()
      return { key: original.key }
    } finally { this.writeBusy = false }
  }
  async saveDraft(draft: Draft): Promise<{ saved: true }> {
    await this.ensureReady()
    requireThat(this.sessions.ones && this.sessions.coho, 'identity', '请先登录两站，草稿需要绑定本人身份。')
    validDate(draft.date); requireThat(Array.isArray(draft.allocations) && draft.allocations.length <= 20, 'input', '草稿最多 20 笔。')
    for (const row of draft.allocations) { id(row.taskId); apiHours(row.minutes); text(row.description, 2000) }
    await this.deps.store.set('draft', { owner: digest([this.sessions.ones.userId, this.sessions.coho.principal]), value: draft })
    return { saved: true }
  }
  async loadDraft(): Promise<Draft | null> {
    await this.ensureReady()
    if (!this.sessions.ones || !this.sessions.coho) return null
    const stored = await this.deps.store.get('draft'); if (stored === null) return null
    const raw = record(stored)
    if (raw.owner !== digest([this.sessions.ones.userId, this.sessions.coho.principal])) return null
    this.invalidate() // restored data never carries confirmation or attendance authority
    const value = record(raw.value); validDate(value.date)
    requireThat(Array.isArray(value.allocations) && value.allocations.length <= 20, 'schema', '本机草稿格式无效。')
    for (const entry of value.allocations) { const row = record(entry); id(row.taskId); apiHours(row.minutes as number); text(row.start, 5); text(row.description, 2000) }
    return value as unknown as Draft
  }
}
