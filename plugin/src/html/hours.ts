import { hoursCalendar } from './hours-calendar.ts'
import { attendanceBudget, resolveAttendance } from '../domain/attendance.ts'
import { taskDraft, businessDate, type MissingDay } from '../domain/missing-hours.ts'
import { safeFailure } from '../domain/model.ts'
import type { Allocation, Preview, Task, TaskPage } from '../domain/model.ts'
import type { HoursMonth } from '../hours-cache.ts'
import type { Day, Draft } from '../protocol.ts'
import type { WorkbenchUI } from './panel.ts'
import {
  button,
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
  preview: Preview | null = null
  confirmed = false
  private day: Day | null = null
  private tasks: Task[] = []
  private next: string | null = null
  private cursors = new Set<string>()
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
    this.next = null
    this.cursors.clear()
    this.selected = ''
    this.allocations = []
    this.scan = null
    this.calendarMonth = businessDate().slice(0, 7)
    this.savedAt = null
    this.cached = false
    this.loadError = ''
    this.progress = ''
    this.description = ''
  }
  changeDate(value: string): void {
    this.allocations = []
    this.description = ''
    this.date = value
    this.app.invalidateDay()
    this.app.render()
  }
  private loadTasks(more = false): void {
    const after = more ? this.next : ''
    if (after === null) return
    if (!more) {
      this.tasks = []
      this.selected = ''
      this.next = null
      this.cursors.clear()
      this.app.invalidate()
    }
    void this.app.run(
      (signal) => request<TaskPage>('tasks.list', { team: this.app.team, after }, signal),
      (page) => {
        if (
          new Set(page.items.map((t) => t.id)).size !== page.items.length ||
          page.items.some((t) => this.tasks.some((old) => old.id === t.id)) ||
          (page.nextCursor !== null && this.cursors.has(page.nextCursor))
        ) {
          this.next = null
          this.app.error = '任务分页重复，列表不完整，请重新读取。'
          return
        }
        this.tasks.push(...page.items)
        this.next = page.nextCursor
        if (this.next) this.cursors.add(this.next)
      }
    )
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
        queueMicrotask(() => { if (this.active && this.day?.id === day.id && !this.tasks.length) this.loadTasks() })
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
  enter(): void {
    if (this.active) return
    this.active = true
    void this.loadMonth(businessDate().slice(0, 7))
  }
  leave(): void {
    this.active = false
    this.generation++
    this.controller?.abort()
    this.controller = undefined
    this.loading = false
  }
  private async loadMonth(month: string): Promise<void> {
    this.controller?.abort()
    const generation = ++this.generation
    const team = this.app.team
    const identity = this.app.status?.identity
    this.calendarMonth = month
    this.app.invalidateDay()
    this.scan = null
    this.loadError = ''
    this.progress = ''
    this.savedAt = null
    this.cached = false
    if (!team || !this.app.status?.ones.connected || !this.app.status.coho.connected) {
      this.loading = false
      this.app.render()
      return
    }
    const controller = new AbortController()
    this.controller = controller
    const current = () => this.active && this.generation === generation && team === this.app.team && identity === this.app.status?.identity && !controller.signal.aborted
    this.loading = true
    this.app.render()
    try {
      try {
        const cached = await request<HoursMonth | null>('hours.cache', { team, month }, controller.signal)
        if (!current()) return
        if (cached) { this.scan = cached.days; this.savedAt = cached.savedAt; this.cached = true; this.app.render() }
      } catch { if (!current()) return /* Cache failure does not prevent a fresh query. */ }
      const days: MissingDay[] = []
      let cursor: string | undefined
      let savedAt: number | null = null
      do {
        const result = await request<{ days: MissingDay[]; nextCursor: string | null; total: number; savedAt: number | null }>(
          'hours.scan', { team, month, ...(cursor ? { cursor } : {}) }, controller.signal)
        if (!current()) return
        days.push(...result.days)
        this.progress = `正在更新 ${month}：${days.length} / ${result.total} 天`
        this.app.render()
        cursor = result.nextCursor ?? undefined
        savedAt = result.savedAt
      } while (cursor)
      this.scan = days
      this.savedAt = savedAt
      this.cached = false
      this.progress = savedAt ? '已更新并保存到插件数据库' : '已更新，数据库保存失败；下次将重新查询'
    } catch (error) {
      if (current()) {
        const failure = error instanceof UIError ? message(error) : '月份数据读取失败，请检查连接后重试。'
        this.loadError = this.cached ? '更新失败，当前显示上次缓存；' + failure : failure
        this.progress = ''
      }
    } finally {
      if (current()) { this.loading = false; this.controller = undefined; this.app.render() }
    }
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
      busy: app.busy, loading: this.loading,
      changeMonth: month => { this.allocations = []; this.description = ''; void this.loadMonth(month) },
      chooseDate: date => { this.changeDate(date); this.loadDay() }
    }))
    const stamp = this.savedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(this.savedAt) : ''
    content.append(row(
      text(this.loading ? (this.progress || '正在读取当月考勤与工时…') : this.progress || (this.cached ? '显示本机缓存' : ''), true),
      stamp ? text((this.cached ? '缓存于 ' : '更新于 ') + stamp, true) : null,
      button('刷新', () => { void this.loadMonth(this.calendarMonth) }, app.busy || this.loading)
    ))
    if (this.loadError) content.append(notice(this.loadError, true))
    if (this.next && this.day) content.append(button('加载更多任务', () => this.loadTasks(true), app.busy))
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
          '目标任务 / Bug',
          this.selected,
          [
            { value: '', label: '先读取可分配任务' },
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
                (signal) =>
                  request<{ count: number }>(
                    'hours.submit',
                    { previewId: preview.id, confirmed: this.confirmed },
                    signal
                  ),
                (value) => {
                  app.invalidateDay()
                  this.allocations = []
                  app.info = `已逐笔回读 ${value.count} 笔工时。`
                }
              ),
            app.busy || !app.status?.writeEnabled || !this.confirmed
          )
        )
      )
    content.append(notice('写入安全闸未开放：目前仅允许读取、分配和预览；不会写入 ONES。'))
    return content
  }
}
