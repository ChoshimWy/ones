import { alignedHoursMonth, completeHoursMonth, recentHoursMonths, hoursTotals } from '../domain/hours-year.ts'
import type { HoursBatchPreview, HoursBatchResult, HoursBatchRow } from '../hours-batch.ts'
import { hoursCalendar } from './hours-calendar.ts'
import { hoursToMinutes, minutesToHoursInput } from './hours-input.ts'
import { attendanceBudget, resolveAttendance, checkAllocations } from '../domain/attendance.ts'
import { businessDate, type MissingDay } from '../domain/missing-hours.ts'
import { safeFailure } from '../domain/model.ts'
import type { Allocation, Preview, Task } from '../domain/model.ts'
import type { HoursMonth, HoursTasks } from '../hours-cache.ts'
import type { Day, ImplementationBrief } from '../protocol.ts'
import type { WorkbenchUI } from './panel.ts'
import {
  button,
  el,
  card,
  hours,
  input,
  notice,
  message,
  UIError,
  request,
  row,
  select,
  stack,
  text
} from './dom.ts'

export class HoursView {
  date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
  private calendarMonth = businessDate().slice(0, 7)
  private scan: MissingDay[] | null = null
  private active = false
  private generation = 0
  private controller?: AbortController
  private loading = false
  private loadError = ''
  private progress = ''
  private savedAt: number | null = null
  private cached = false
  /// 年度数据与月份队列独立于当前日历页，不因切月使前台置灰。
  private months = new Map<string, HoursMonth>()
  private monthErrors = new Map<string, string>()
  private queue: string[] = []
  private forced = new Set<string>()
  private scanningMonth: string | null = null
  private pumping = false
  private taskLoading = false
  private taskNote = ''
  private batchRows = new Map<string, { hours: string; start: string }>()
  private batchTask = ''
  private batchDescription = ''
  private batchRevision = 0
  private batchResult: HoursBatchResult | null = null
  private submitting = false
  private day: Day | null = null
  private tasks: Task[] = []
  private dayTasks: Task[] = []
  private supplementOptions: { taskId: string; description: string; start: string }[] = []
  private supplementChoice = ''
  private supplementNote = ''
  private get availableTasks(): Task[] {
    return [...new Map([...this.tasks, ...this.dayTasks].map(task => [task.id, task])).values()]
  }
  private selected = ''
  private start = '09:00'
  private durationHours = '8'
  private description = ''
  constructor(private app: WorkbenchUI) {}
  clearDay(): void {
    this.day = null
    this.dayTasks = []
    this.supplementOptions = []
    this.supplementChoice = ''
    this.supplementNote = ''
  }
  clear(): void {
    this.leave()
    this.clearDay()
    this.tasks = []
    this.selected = ''
    this.scan = null
    this.calendarMonth = businessDate().slice(0, 7)
    this.savedAt = null
    this.cached = false
    this.loadError = ''
    this.progress = ''
    this.description = ''
    this.months.clear()
    this.monthErrors.clear()
    this.batchRows.clear()
    this.batchTask = ''
    this.batchDescription = ''
    this.batchRevision++
    this.batchResult = null
  }
  changeDate(value: string): void {
    this.description = ''
    this.date = value
    this.app.invalidateDay()
    this.app.render()
  }
  /// 普通任务先展示 SQLite 摘要，再后台读取完整目录；不占用前台业务锁。
  private async loadTasks(force = false): Promise<void> {
    if (this.taskLoading || !this.active) return
    const generation = this.generation
    const team = this.app.team
    const identity = this.app.status?.identity
    const signal = this.controller?.signal
    const current = () => this.active && generation === this.generation && identity === this.app.status?.identity && team === this.app.team && !signal?.aborted
    this.taskLoading = true
    this.taskNote = '正在后台更新普通任务…'
    this.app.render()
    try {
      if (!force) {
        try {
          const cached = await request<HoursTasks | null>('hours.tasksCache', { team }, signal)
          if (!current()) return
          if (cached) { this.tasks = cached.items; this.app.render() }
        } catch { if (!current()) return /* 损坏缓存不阻止重新读取云端完整任务目录。 */ }
      }
      const value = await request<HoursTasks>('hours.tasksSync', { team }, signal)
      if (!current()) return
      this.tasks = value.items
      this.taskNote = `普通任务 ${value.items.length} 项，已保存本地数据库`
    } catch (error) {
      if (current()) this.taskNote = '任务更新失败，保留已缓存任务；' + message(error)
    } finally {
      if (current()) { this.taskLoading = false; this.app.render() }
    }
  }
  private loadDay(prefill = false): void {
    this.app.invalidateDay()
    const date = this.date
    const generation = this.generation
    const team = this.app.team
    const identity = this.app.status?.identity
    void this.app.run(
      async signal => {
        const day = await request<Day>('day.read', { team, date }, signal)
        const tasks: Task[] = []
        let note = ''
        if (prefill && day.existing > 0 && attendanceBudget(day.attendance) > day.existing) {
          // Historical work may no longer be assigned to me; read task names independently.
          const ids = [...new Set(day.worklogs.map(row => row.task))]
          if (ids.length > 20) note = '当天任务过多，请手动选择补充任务。'
          else {
            for (const taskId of ids) {
              try {
                const detail = await request<ImplementationBrief>('tasks.brief', { team, taskId }, signal)
                if (detail.task.issueType.name === '任务') tasks.push(detail.task)
              } catch {
                if (signal.aborted) throw new Error('cancelled')
                note = '部分原任务无法读取，请核对后手动选择；不会使用未核实的任务。'
              }
            }
          }
        }
        return { day, tasks, note }
      },
      ({ day, tasks, note }) => {
        if (date !== this.date || generation !== this.generation || team !== this.app.team || identity !== this.app.status?.identity) return
        this.day = day
        this.dayTasks = tasks
        try { this.start = resolveAttendance(day.attendance).start } catch { /* Anomalous days remain blocked. */ }
        if (!prefill) return
        this.selected = ''
        this.description = ''
        this.durationHours = minutesToHoursInput(Math.max(0, attendanceBudget(day.attendance) - day.existing))
        const options = new Map<string, { taskId: string; description: string; start: string }>()
        for (const log of day.worklogs) {
          if (!tasks.some(task => task.id === log.task)) continue
          const start = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(log.startTime * 1000))
          options.set(JSON.stringify([log.task, log.description]), { taskId: log.task, description: log.description, start })
        }
        this.supplementOptions = [...options.values()]
        this.supplementNote = note
        queueMicrotask(() => { if (typeof document !== 'undefined' && this.date === date) document.getElementById('hours-supplement')?.scrollIntoView({ block: 'start' }) })
        if (this.supplementOptions.length === 1) {
          this.applySupplement('0')
          this.supplementNote ||= '已复用当天任务和描述，并填入剩余额度；核对后点击“补充工时”直接提交。'
        } else if (this.supplementOptions.length > 1) {
          this.supplementNote ||= '当天有多个任务或描述，请选择要复用的记录；不会自动分摊差额。'
        }
      }
    )
  }
  private applySupplement(value: string): void {
    this.app.invalidate()
    this.supplementChoice = value
    const option = value === '' ? undefined : this.supplementOptions[Number(value)]
    this.selected = option?.taskId ?? ''
    this.description = option?.description ?? ''
    if (option) this.start = option.start
  }
  /// The form itself is the confirmation: freeze exactly what the user clicked,
  /// validate server-side, then consume the existing one-shot submission contract.
  private supplement(): void {
    const app = this.app
    const day = this.day
    if (app.busy || this.submitting || !day || !app.status?.writeEnabled) return
    let allocation: Allocation
    try {
      allocation = { taskId: this.selected, start: this.start, minutes: hoursToMinutes(this.durationHours), description: this.description }
      if (!allocation.taskId) throw new UIError('请选择补充工时的普通任务。')
      checkAllocations([allocation], attendanceBudget(day.attendance), day.existing)
    } catch (error) {
      app.error = error instanceof UIError ? error.message : safeFailure(error).message
      app.render()
      return
    }
    const team = app.team
    const identity = app.status.identity
    const generation = this.generation
    const month = day.date.slice(0, 7)
    app.invalidate()
    this.submitting = true
    void app.run(async signal => {
      const preview = await request<Preview>('hours.preview', { dayId: day.id, allocations: [allocation] }, signal)
      if (signal.aborted || this.day !== day || this.generation !== generation || app.team !== team || app.status?.identity !== identity)
        throw new UIError('日期或身份已变化，未提交工时。', 'stale')
      // The server's calculation may not substitute another date or allocation.
      const row = preview.rows[0]
      if (preview.date !== day.date || preview.rows.length !== 1 || !row ||
          row.taskId !== allocation.taskId || row.start !== allocation.start ||
          row.minutes !== allocation.minutes || row.description !== allocation.description)
        throw new UIError('工时校验结果与本次填写不一致，未提交。', 'stale')
      try {
        return await request<{ count: number }>('hours.submit', { previewId: preview.id, confirmed: true }, signal)
      } finally {
        // Success and ambiguous delivery both invalidate this form. Never auto-retry.
        if (app.team === team && app.status?.identity === identity) {
          if (this.day === day) this.clearDay()
          this.months.delete(month)
          this.enqueueMonth(month, true)
          this.showMonth()
          if (this.active) void this.pump(this.generation)
        }
      }
    }, result => {
      app.info = `已补充工时并回读确认 ${result.count} 笔。`
    }).finally(() => {
      this.submitting = false
      app.render()
    })
  }
  /// 进入时读取近一年本地快照，当前月优先补齐，普通任务独立后台同步。
  enter(): void {
    if (this.active) return
    this.active = true
    this.calendarMonth = businessDate().slice(0, 7)
    const generation = ++this.generation
    this.controller = new AbortController()
    void this.startYear(generation)
    void this.loadTasks()
  }
  /// 离开只停止本轮网络工作，保留已成功入库与用户草稿。
  leave(): void {
    this.active = false
    this.generation++
    this.controller?.abort()
    this.controller = undefined
    this.loading = false
    this.taskLoading = false
    this.pumping = false
    this.scanningMonth = null
    this.queue = []
    this.forced.clear()
  }
  /// 年度读取不依赖云端成功；未成功月份保持未知，并显示覆盖进度。
  private async startYear(generation: number): Promise<void> {
    const team = this.app.team
    const identity = this.app.status?.identity
    const signal = this.controller?.signal
    const current = () => this.active && generation === this.generation && team === this.app.team && identity === this.app.status?.identity && !signal?.aborted
    try {
      const cached = await request<HoursMonth[]>('hours.yearCache', { team }, signal)
      if (!current()) return
      for (const value of cached) if (!this.months.has(value.month) || this.months.get(value.month)!.savedAt <= value.savedAt) this.months.set(value.month, value)
      this.showMonth()
    } catch (error) { if (current()) this.loadError = '本地年度数据读取失败；' + message(error) }
    if (!current()) return
    for (const month of recentHoursMonths()) if (!completeHoursMonth(this.months.get(month))) this.enqueueMonth(month)
    this.enqueueMonth(this.calendarMonth)
    this.prioritizeMonth(this.calendarMonth)
    void this.pump(generation)
    try {
      const result = await request<HoursBatchResult | null>('hours.batchResult', { team }, signal)
      if (current()) { this.batchResult = result; this.app.render() }
    } catch { /* 最近结果读取失败不影响只读月历；待核实写入仍由服务端账本阻断。 */ }
  }
  /// 当前月显示引用只来自对应本地条目，旧月份响应不能覆盖新页。
  private showMonth(): void {
    const value = this.months.get(this.calendarMonth)
    this.scan = value?.days ?? null
    this.savedAt = value?.savedAt ?? null
    this.cached = !!value
    this.loadError = this.monthErrors.get(this.calendarMonth) ?? ''
    this.app.render()
  }
  /// 已核对完整历史月不自动联网；强制刷新保留显式通道。
  private enqueueMonth(month: string, force = false): void {
    if (force) this.forced.add(month)
    if (!force && alignedHoursMonth(this.months.get(month))) return
    if ((this.scanningMonth !== month || force) && !this.queue.includes(month)) this.queue.push(month)
  }
  /// 把用户当前月置于待执行队首，不中断正在处理的服务端分页。
  private prioritizeMonth(month: string): void {
    const index = this.queue.indexOf(month)
    if (index >= 0) { this.queue.splice(index, 1); this.queue.unshift(month) }
  }
  /// 切月立即展示本地缓存，后台保持单扫描器，避免多个游标相互废弃。
  private async loadMonth(month: string, force = false): Promise<void> {
    this.calendarMonth = month
    this.app.invalidateDay()
    this.showMonth()
    const generation = this.generation
    const team = this.app.team
    const identity = this.app.status?.identity
    const signal = this.controller?.signal
    if (!this.months.has(month)) {
      try {
        const value = await request<HoursMonth | null>('hours.cache', { team, month }, signal)
        if (!this.active || generation !== this.generation || team !== this.app.team || identity !== this.app.status?.identity) return
        if (value) this.months.set(month, value)
        this.showMonth()
      } catch { /* 无缓存时仍允许后台查询；未查询日期不伪造为缺报。 */ }
    }
    if (!this.active || generation !== this.generation) return
    this.enqueueMonth(month, force)
    this.prioritizeMonth(month)
    void this.pump(generation)
  }
  /// 逐月分批更新，本轮失败仅记录一次；任何错误都不发布部分月份。
  private async pump(generation: number): Promise<void> {
    if (this.pumping || !this.active) return
    this.pumping = true
    const team = this.app.team
    const identity = this.app.status?.identity
    const signal = this.controller?.signal
    const current = () => this.active && generation === this.generation && team === this.app.team && identity === this.app.status?.identity && !signal?.aborted
    try {
      while (this.queue.length && current()) {
        const month = this.queue.shift()!
        const force = this.forced.delete(month)
        if (!force && alignedHoursMonth(this.months.get(month))) continue
        this.scanningMonth = month
        this.loading = true
        this.progress = `后台更新 ${month}`
        this.app.render()
        try {
          const days: MissingDay[] = []
          let cursor: string | undefined
          let savedAt: number | null = null
          do {
            const result = await request<{ days: MissingDay[]; nextCursor: string | null; total: number; savedAt: number | null }>(
              'hours.scan', { team, month, ...(force ? { force: true } : {}), ...(cursor ? { cursor } : {}) }, signal)
            if (!current()) return
            days.push(...result.days)
            savedAt = result.savedAt
            cursor = result.nextCursor ?? undefined
            this.progress = `后台更新 ${month}：${days.length} / ${result.total} 天`
            this.app.render()
          } while (cursor)
          this.months.set(month, { month, days, savedAt: savedAt ?? Date.now() })
          if (savedAt) this.monthErrors.delete(month)
          else this.monthErrors.set(month, '云端已更新，但数据库保存失败；重启后需重新查询。')
        } catch (error) {
          if (!current()) return
          this.monthErrors.set(month, (this.months.has(month) ? '更新失败，保留本地结果；' : '更新失败，本月尚无本地结果；') + message(error))
        }
        this.scanningMonth = null
        this.showMonth()
      }
    } finally {
      if (current()) {
        this.pumping = false
        this.loading = false
        this.scanningMonth = null
        this.progress = '后台同步结束；已对齐历史月份不会重复读取云端'
        this.showMonth()
      }
    }
  }
  /// Editing the form revokes the internal validation result without another UI confirmation.
  private invalidateBatch(): void {
    this.batchRevision++
  }
  /// 仅缺报日期可选；保留跨月选择，每批最多 31 日。
  private toggleBatch(date: string): void {
    this.invalidateBatch()
    if (this.batchRows.has(date)) this.batchRows.delete(date)
    else {
      const day = this.months.get(date.slice(0, 7))?.days.find(day => day.date === date)
      if (!day || !['missing', 'partial'].includes(day.state) || this.batchRows.size >= 31) return
      this.batchRows.set(date, { hours: minutesToHoursInput(day.remaining ?? 0), start: '09:00' })
    }
    this.app.render()
  }
  /// Clicking submits exactly the displayed batch; internal validation is not a UI step.
  private submitBatch(): void {
    const app = this.app
    if (app.busy || this.submitting || !app.status?.writeEnabled) return
    let rows: HoursBatchRow[]
    try {
      if (!this.batchTask || !this.batchDescription.trim() || !this.batchRows.size)
        throw new UIError('请选择日期、普通任务并填写工作描述。')
      rows = [...this.batchRows].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({
        date, taskId: this.batchTask, start: value.start, minutes: hoursToMinutes(value.hours), description: this.batchDescription
      }))
    } catch (error) {
      app.error = message(error)
      app.render()
      return
    }
    const team = app.team
    const identity = app.status.identity
    const generation = this.generation
    const revision = this.batchRevision
    app.invalidate()
    this.submitting = true
    void app.run(async signal => {
      const preview = await request<HoursBatchPreview>('hours.batchPreview', { team, rows }, signal)
      if (signal.aborted || this.generation !== generation || this.batchRevision !== revision ||
          app.team !== team || app.status?.identity !== identity)
        throw new UIError('日期、填写内容或身份已变化，未提交工时。', 'stale')
      if (preview.rows.length !== rows.length || preview.rows.some((row, index) => {
        const expected = rows[index]!
        return row.date !== expected.date || row.taskId !== expected.taskId || row.start !== expected.start ||
          row.minutes !== expected.minutes || row.description !== expected.description
      })) throw new UIError('批量校验结果与本次填写不一致，未提交。', 'stale')
      let result: HoursBatchResult | undefined
      this.batchResult = null
      try {
        result = await request<HoursBatchResult>('hours.batchSubmit', { team, previewId: preview.id, confirmed: true }, signal)
        return result
      } finally {
        if (app.team === team && app.status?.identity === identity) {
          this.clearDay()
          // Unknown delivery cannot leave a ready-to-replay batch. Only proven unsent rows remain.
          for (const row of rows)
            if (!result?.rows.some(value => value.date === row.date && value.state === 'not_attempted')) this.batchRows.delete(row.date)
          this.invalidateBatch()
          for (const month of new Set(rows.map(row => row.date.slice(0, 7)))) { this.months.delete(month); this.enqueueMonth(month, true) }
          this.showMonth()
          if (this.active) void this.pump(this.generation)
        }
      }
    }, result => { this.batchResult = result }).finally(() => {
      this.submitting = false
      app.render()
    })
  }
  /// 日历下展示年度覆盖、缺报总数与普通任务批量分配，不隐藏尚未完成的月份。
  private renderBatch(): HTMLElement {
    const app = this.app
    const window = recentHoursMonths()
    const cachedMonths = window.map(month => this.months.get(month)).filter((value): value is HoursMonth => !!value)
    const total = hoursTotals(cachedMonths.flatMap(value => value.days))
    const current = hoursTotals(this.scan ?? [])
    const section = card('缺少工时填写',
      text(`本地近一年已完整读取 ${cachedMonths.filter(value => completeHoursMonth(value)).length} / 12 个月 · 缺报 ${total.count} 天 · 缺少 ${hours(total.minutes)}`),
      text(`本月缺报 ${current.count} 天 · 待核实 ${current.review} 天；全年待核实 ${total.review} 天`, true),
      text(`范围 ${window.at(-1)} ～ ${window[0]}；未读取月份不计入缺报统计。`, true),
      text('统计基于本地已读取数据，不代表实时云端结论；历史未齐月份可能滞后，切换该月会后台更新。', true),
      cachedMonths.length ? text('本地年度最早快照：' + new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(Math.min(...cachedMonths.map(value => value.savedAt))), true) : null,
      this.monthErrors.size ? text(`后台更新失败或保存未完成 ${this.monthErrors.size} 个月，请切换对应月份查看或刷新。`, true) : null,
      row(button('选择本月缺报日期', () => {
        this.invalidateBatch()
        for (const day of this.scan ?? []) {
          if (['missing', 'partial'].includes(day.state) && !this.batchRows.has(day.date) && this.batchRows.size < 31)
            this.batchRows.set(day.date, { hours: minutesToHoursInput(day.remaining ?? 0), start: '09:00' })
        }
        app.render()
      }, app.busy), button('清空日期选择', () => { this.batchRows.clear(); this.invalidateBatch(); app.render() }, app.busy)),
      text(`已选 ${this.batchRows.size} / 31 天，可跨月选择；建议时长为未登记额度，请逐日改为实际投入。`, true),
      text(this.taskNote, true),
      button('刷新普通任务', () => this.loadTasks(true), this.taskLoading),
      select('批量目标普通任务', this.batchTask, [{ value: '', label: '请选择任务（不含缺陷）' }, ...this.tasks.map(task => ({ value: task.id, label: `#${task.number} ${task.name}` }))], value => { this.batchTask = value; this.invalidateBatch(); app.render() }, app.busy))
    for (const [date, value] of [...this.batchRows].sort(([a], [b]) => a.localeCompare(b))) section.append(el('div', 'hours-batch-date',
      text(date),
      input(`${date} 开始时间`, value.start, next => { value.start = next; this.invalidateBatch() }, { disabled: app.busy }),
      input(`${date} 时长（小时）`, value.hours, next => { value.hours = next; this.invalidateBatch() }, { type: 'number', disabled: app.busy }),
      button(`移除 ${date}`, () => this.toggleBatch(date), app.busy)))
    if (this.batchRows.size) section.append(
      input('批量工作描述（必填）', this.batchDescription, value => { this.batchDescription = value; this.invalidateBatch() }, { multiline: true, disabled: app.busy }),
      button('提交工时', () => this.submitBatch(), app.busy || this.submitting || !this.batchTask || !app.status?.writeEnabled),
      text('点击即提交所选日期的工时；系统逐日校验额度，不再弹出二次确认。', true))
    if (this.batchResult) section.append(card('上次批量结果', ...this.batchResult.rows.map(row => text(`${row.date} · ${row.state === 'verified' ? '已回读' : row.state === 'unknown' ? '结果待核实' : '未提交'} · ${row.message}`))))
    if (!app.status?.writeEnabled) section.append(notice('生产工时写入尚未验收：可选择和填写，提交暂不可用；不会写入真实工时。'))
    return section
  }
  render(): HTMLElement {
    const app = this.app,
      authenticated = app.status?.ones.connected && app.status?.coho.connected
    const content = stack()
    if (!authenticated || !app.team) {
      content.append(notice('请在登录页连接 ONES、Coho 并选择团队。'))
      return content
    }
    content.append(hoursCalendar({
      days: this.scan ?? [], month: this.calendarMonth, selected: this.day?.date ?? null,
      busy: app.busy, selectedDates: new Set(this.batchRows.keys()), toggleDate: date => this.toggleBatch(date),
      changeMonth: month => { this.description = ''; void this.loadMonth(month) },
      chooseDate: date => { this.changeDate(date); this.loadDay(true) }
    }))
    const stamp = this.savedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(this.savedAt) : ''
    content.append(row(
      text(this.loading ? (this.progress || '正在读取当月考勤与工时…') : this.progress || (this.cached ? '显示本机缓存' : ''), true),
      stamp ? text((this.cached ? '缓存于 ' : '更新于 ') + stamp, true) : null,
      button('刷新当前月', () => { void this.loadMonth(this.calendarMonth, true) }, app.busy || this.scanningMonth === this.calendarMonth)
    ))
    if (this.loadError) content.append(notice(this.loadError, true))
    content.append(this.renderBatch())
    let attendanceValid = false
    if (this.day) {
      try {
        const calculated = resolveAttendance(this.day.attendance)
        attendanceValid = true
        content.append(card(calculated.basis === 'punch' ? '考勤已自动识别' : '已审批工作时长',
          text(this.day.date + ' · ' + calculated.start + '—' + (calculated.endNextDay ? '次日 ' : '') + calculated.end),
          text('折算工时：' + hours(calculated.budget) + ' · 已登记：' + hours(this.day.existing)),
          text(calculated.basis === 'punch' ? '符合正常考勤规则，无需手动配对或确认。' : '依据审批时长及未覆盖的有效打卡时间计算；审批与打卡不重复累计。', true)))
      } catch (error) {
        content.append(card('考勤异常，暂不可分配',
          text(this.day.date + ' · ' + this.day.attendance.punches.length + ' 条打卡'),
          ...this.day.attendance.punches.map(p => text(p.date + ' ' + p.time)),
          notice(safeFailure(error).message, true)))
      }
    } else {
      content.append(notice('选择日历中的日期，自动识别考勤后分配工时。'))
      return content
    }
    content.append(
      card(
        '工时补充',
        this.supplementNote ? text(this.supplementNote, true) : null,
        this.supplementOptions.length > 1 ? select('复用当天已登记记录', this.supplementChoice,
          [{ value: '', label: '请选择原任务和描述' }, ...this.supplementOptions.map((option, index) => ({
            value: String(index),
            label: (this.dayTasks.find(task => task.id === option.taskId)?.name ?? option.taskId) + ' · ' + (option.description || '原描述为空')
          }))], value => { this.applySupplement(value); app.render() }, app.busy) : null,
        select(
          '目标普通任务',
          this.selected,
          [
            { value: '', label: '请选择普通任务' },
            ...this.availableTasks.map((t) => ({ value: t.id, label: `#${t.number} ${t.name}` }))
          ],
          (v) => {
            this.selected = v
            app.render()
          },
          app.busy
        ),
        row(
          input(
            '开始时间',
            this.start,
            (v) => {
              this.start = v
            },
            { disabled: app.busy }
          ),
          input(
            '时长（小时）',
            this.durationHours,
            (v) => {
              this.durationHours = v
            },
            { disabled: app.busy }
          )
        ),
        input(
          '工作描述（必填）',
          this.description,
          (v) => {
            this.description = v
          },
          { multiline: true, disabled: app.busy }
        ),
        button('补充工时', () => this.supplement(),
          app.busy || this.submitting || !attendanceValid || !app.status?.writeEnabled)
      )
    )
    content.lastElementChild!.id = 'hours-supplement'
    if (!app.status?.writeEnabled) content.append(notice('写入安全闸未开放：目前仅允许读取；不会写入 ONES。'))
    return content
  }
}
