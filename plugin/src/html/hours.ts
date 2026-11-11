import { alignedHoursMonth, completeHoursMonth, recentHoursMonths, hoursTotals } from '../domain/hours-year.ts'
import type { HoursBatchPreview, HoursBatchResult, HoursBatchRow } from '../hours-batch.ts'
import { hoursCalendar } from './hours-calendar.ts'
import { attendanceBudget, resolveAttendance } from '../domain/attendance.ts'
import { taskDraft, businessDate, type MissingDay } from '../domain/missing-hours.ts'
import { safeFailure } from '../domain/model.ts'
import type { Allocation, Preview, Task } from '../domain/model.ts'
import type { HoursMonth, HoursTasks } from '../hours-cache.ts'
import type { Day, Draft } from '../protocol.ts'
import type { WorkbenchUI } from './panel.ts'
import {
  button,
  el,
  card,
  check,
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
  private batchRows = new Map<string, { minutes: string; start: string }>()
  private batchTask = ''
  private batchDescription = ''
  private batchPreview: HoursBatchPreview | null = null
  private batchConfirmed = false
  private batchPreviewElement?: HTMLElement
  private batchResult: HoursBatchResult | null = null
  preview: Preview | null = null
  confirmed = false
  private day: Day | null = null
  private tasks: Task[] = []
  private selected = ''
  private start = '09:00'
  private minutes = '480'
  private description = ''
  private allocations: Allocation[] = []
  constructor(private app: WorkbenchUI) {}
  clearDay(): void {
    this.day = null
    this.preview = null
    this.confirmed = false
  }
  clear(): void {
    this.leave()
    this.clearDay()
    this.tasks = []
    this.selected = ''
    this.allocations = []
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
    this.batchPreview = null
    this.batchConfirmed = false
    this.batchResult = null
  }
  changeDate(value: string): void {
    this.allocations = []
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
  private loadDay(): void {
    this.app.invalidateDay()
    void this.app.run(
      (signal) =>
        request<Day>(
          'day.read',
          { team: this.app.team, date: this.date },
          signal
        ),
      (day) => {
        this.day = day
        try { this.start = resolveAttendance(day.attendance).start } catch { /* Anomalous days remain blocked. */ }
      }
    )
  }
  private add(): void {
    this.app.invalidate()
    if (!this.day || !this.selected || !this.description.trim()) {
      this.app.error = '请先读取考勤，选择任务并填写描述。'
      this.app.render()
      return
    }
    const minutes = Number(this.minutes)
    if (!Number.isSafeInteger(minutes) || minutes <= 0) {
      this.app.error = '请输入正整数分钟。'
      this.app.render()
      return
    }
    this.allocations.push({
      taskId: this.selected,
      start: this.start,
      minutes,
      description: this.description
    })
    this.description = ''
    this.app.error = ''
    this.app.render()
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
  /// 修改任何批量字段都使前台确认失效，服务端确认还会在提交前重读。
  private invalidateBatch(): void {
    this.batchPreview = null
    this.batchConfirmed = false
    // 输入时只移除过期确认子树，保留当前输入框和光标，不让旧闭包重新确认。
    this.batchPreviewElement?.remove()
    this.batchPreviewElement = undefined
  }
  /// 仅缺报日期可选；保留跨月选择，每批最多 31 日。
  private toggleBatch(date: string): void {
    this.invalidateBatch()
    if (this.batchRows.has(date)) this.batchRows.delete(date)
    else {
      const day = this.months.get(date.slice(0, 7))?.days.find(day => day.date === date)
      if (!day || !['missing', 'partial'].includes(day.state) || this.batchRows.size >= 31) return
      this.batchRows.set(date, { minutes: String(day.remaining ?? 0), start: '09:00' })
    }
    this.app.render()
  }
  /// 批次预览由 Worker 校验逐日投入与当前普通任务，不直接提交本地建议额度。
  private previewBatch(): void {
    this.invalidateBatch()
    const rows: HoursBatchRow[] = [...this.batchRows].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({
      date, taskId: this.batchTask, start: value.start, minutes: Number(value.minutes), description: this.batchDescription
    }))
    void this.app.run(signal => request<HoursBatchPreview>('hours.batchPreview', { team: this.app.team, rows }, signal), value => { this.batchPreview = value })
  }
  private generate(): void {
    this.app.invalidate()
    try {
      const task = this.tasks.find(t => t.id === this.selected)
      if (!task || !this.day) throw new Error()
      const budget = attendanceBudget(this.day.attendance)
      this.allocations.push(taskDraft(task, this.start, Number(this.minutes), this.description, budget, this.day.existing, this.allocations))
      this.description = ''
      this.app.info = '已生成待确认草稿；任务标题不是完成证据，请核对实际时长和描述后预览。'
    } catch (error) { this.app.error = safeFailure(error).message }
    this.app.render()
  }
  private makePreview(): void {
    const day = this.day
    if (!day) return
    this.app.invalidate()
    void this.app.run(
      (signal) =>
        request<Preview>(
          'hours.preview',
          {
            dayId: day.id,
            allocations: this.allocations
          },
          signal
        ),
      (value) => {
        this.preview = value
      }
    )
  }
  private save(): void {
    void this.app.run(
      (signal) => request('draft.save', { date: this.date, allocations: this.allocations }, signal),
      () => {
        this.app.info = '已保存本机草稿；重新打开后必须重读考勤。'
      }
    )
  }
  private restore(): void {
    void this.app.run(
      (signal) => request<Draft | null>('draft.load', undefined, signal),
      (value) => {
        this.app.invalidateDay()
        if (value) {
          this.app.info = '正在恢复草稿并重读考勤。'
          queueMicrotask(() => { void this.loadMonth(value.date.slice(0, 7)).then(() => {
            if (!this.active || this.calendarMonth !== value.date.slice(0, 7)) return
            this.date = value.date
            this.allocations = value.allocations
            this.loadDay()
          }) })
        } else this.app.info = '当前身份没有草稿。'
      }
    )
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
            this.batchRows.set(day.date, { minutes: String(day.remaining ?? 0), start: '09:00' })
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
      input(`${date} 时长（分钟）`, value.minutes, next => { value.minutes = next; this.invalidateBatch() }, { type: 'number', disabled: app.busy }),
      button(`移除 ${date}`, () => this.toggleBatch(date), app.busy)))
    if (this.batchRows.size) section.append(
      input('批量工作描述（必填）', this.batchDescription, value => { this.batchDescription = value; this.invalidateBatch() }, { multiline: true, disabled: app.busy }),
      button('校验批量工时并预览', () => this.previewBatch(), app.busy || !this.batchTask),
      text('不会自动均摊或提交；预览会逐日重新读取考勤、已有工时及普通任务。', true))
    const preview = this.batchPreview
    if (preview) {
      this.batchPreviewElement = card('批量提交预览',
      text(`${preview.rows.length} 天，共 ${hours(preview.total)}`),
      ...preview.rows.map(value => text(`${value.date} · ${value.taskName} · ${value.start} · 本次 ${hours(value.minutes)} · 考勤 ${hours(value.budget)} · 已登记 ${hours(value.existing)} · ${value.description}`)),
      check('确认每个日期、普通任务、实际时长和描述', this.batchConfirmed, value => { if (this.batchPreview !== preview) return; this.batchConfirmed = value; app.render() }, app.busy),
      button('确认批量提交到 ONES', () => {
        if (this.batchPreview !== preview) return
        return app.run(
        () => request<HoursBatchResult>('hours.batchSubmit', { team: app.team, previewId: preview.id, confirmed: this.batchConfirmed }),
        result => {
          this.batchResult = result
          this.invalidateBatch()
          for (const month of new Set(preview.rows.map(row => row.date.slice(0, 7)))) { this.months.delete(month); this.enqueueMonth(month, true) }
          for (const row of result.rows) if (row.state === 'verified') this.batchRows.delete(row.date)
          this.showMonth()
          void this.pump(this.generation)
        })
      }, app.busy || !app.status?.writeEnabled || !this.batchConfirmed))
      section.append(this.batchPreviewElement)
    }
    if (this.batchResult) section.append(card('上次批量结果', ...this.batchResult.rows.map(row => text(`${row.date} · ${row.state === 'verified' ? '已回读' : row.state === 'unknown' ? '结果待核实' : '未提交'} · ${row.message}`))))
    if (!app.status?.writeEnabled) section.append(notice('生产工时写入尚未验收：可选择和预览，提交暂不可用；不会写入真实工时。'))
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
      changeMonth: month => { this.allocations = []; this.description = ''; void this.loadMonth(month) },
      chooseDate: date => { this.changeDate(date); this.loadDay() }
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
        content.append(card('考勤已自动识别',
          text(this.day.date + ' · ' + calculated.start + '—' + calculated.end),
          text('折算工时：' + hours(calculated.budget) + ' · 已登记：' + hours(this.day.existing)),
          text('符合正常考勤规则，无需手动配对或确认。', true)))
      } catch (error) {
        content.append(card('考勤异常，暂不可分配',
          text(this.day.date + ' · ' + this.day.attendance.punches.length + ' 条打卡'),
          ...this.day.attendance.punches.map(p => text(p.date + ' ' + p.time)),
          notice(safeFailure(error).message, true)))
      }
    } else {
      content.append(notice('选择日历中的日期，自动识别考勤后分配工时。'))
      content.append(button('恢复草稿', () => this.restore(), app.busy || !authenticated))
      return content
    }
    content.append(
      card(
        '按任务生成草稿 / 手动分配',
        select(
          '目标普通任务',
          this.selected,
          [
            { value: '', label: '请选择普通任务' },
            ...this.tasks.map((t) => ({ value: t.id, label: `#${t.number} ${t.name}` }))
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
            '时长（分钟）',
            this.minutes,
            (v) => {
              this.minutes = v
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
        button('按所选任务生成草稿', () => this.generate(),
          app.busy || !attendanceValid || !this.selected),
        text('使用所填时长生成，不自动推断投入；空描述按任务标题建议，提交前须人工确认。', true),
        button(
          '加入分配草稿',
          () => this.add(),
          app.busy || !attendanceValid || this.allocations.length >= 20
        ),
        text('用整数分钟记录，API 精确编码为 3 分钟的倍数。半小时取整仅用于考勤额度。', true)
      )
    )
    if (this.allocations.length)
      content.append(
        card(
          '待分配草稿',
          ...this.allocations.map((item, index) =>
            stack(
              text(this.tasks.find((t) => t.id === item.taskId)?.name ?? '待重新核对的任务'),
              text(`${item.start} · ${hours(item.minutes)} · ${item.description}`),
              button(
                '移除此项',
                () => {
                  this.allocations.splice(index, 1)
                  app.invalidate()
                  app.render()
                },
                app.busy
              )
            )
          )
        )
      )
    content.append(
      row(
        button(
          '保存草稿',
          () => this.save(),
          app.busy || !authenticated || !this.allocations.length
        ),
        button('恢复草稿', () => this.restore(), app.busy || !authenticated),
        button(
          '校验并预览',
          () => this.makePreview(),
          app.busy ||
            !this.day ||
            !attendanceValid ||
            !this.allocations.length
        )
      )
    )
    const preview = this.preview
    if (preview)
      content.append(
        card(
          '提交预览',
          text('业务日期：' + preview.date),
          text(
            `考勤额度 ${hours(preview.budget)} · 已有 ${hours(preview.existing)} · 本次 ${hours(preview.proposed)} · 剩余 ${hours(preview.remaining)}`
          ),
          ...preview.rows.map((item) =>
            text(`${item.taskName}｜${item.start}｜${hours(item.minutes)}｜${item.description}`)
          ),
          check(
            '我确认上述任务、原日期、时长和每笔描述',
            this.confirmed,
            (v) => {
              this.confirmed = v
              app.render()
            },
            app.busy
          ),
          button(
            '确认提交到 ONES',
            () =>
              app.run(
                async (signal) => {
                  try {
                    return await request<{ count: number }>('hours.submit', { previewId: preview.id, confirmed: this.confirmed }, signal)
                  } catch (error) {
                    // 提交失败可能是未知结果：移除本地结论并只读回查，绝不重发写入。
                    this.clearDay()
                    const month = preview.date.slice(0, 7)
                    this.months.delete(month)
                    this.enqueueMonth(month, true)
                    this.showMonth()
                    void this.pump(this.generation)
                    throw error
                  }
                },
                (value) => {
                  app.invalidateDay()
                  this.allocations = []
                  const month = preview.date.slice(0, 7)
                  this.months.delete(month)
                  this.enqueueMonth(month, true)
                  this.showMonth()
                  void this.pump(this.generation)
                  app.info = `已逐笔回读 ${value.count} 笔工时。`
                }
              ),
            app.busy || !app.status?.writeEnabled || !this.confirmed
          )
        )
      )
    if (!app.status?.writeEnabled) content.append(notice('写入安全闸未开放：目前仅允许读取、分配和预览；不会写入 ONES。'))
    return content
  }
}
