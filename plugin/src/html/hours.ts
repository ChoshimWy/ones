import { attendanceBudget } from '../domain/attendance.ts'
import { taskDraft, type MissingDay } from '../domain/missing-hours.ts'
import { safeFailure } from '../domain/model.ts'
import type { Allocation, Preview, Task, TaskPage } from '../domain/model.ts'
import type { Day, Draft } from '../protocol.ts'
import type { WorkbenchUI } from './panel.ts'
import {
  button,
  card,
  check,
  hours,
  input,
  notice,
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
  private months = '1'
  private scan: MissingDay[] | null = null
  preview: Preview | null = null
  confirmed = false
  private mapping = false
  private day: Day | null = null
  private tasks: Task[] = []
  private next: string | null = null
  private cursors = new Set<string>()
  private selected = ''
  private startPunch = ''
  private endPunch = ''
  private punchesConfirmed = false
  private start = '09:00'
  private minutes = '480'
  private description = ''
  private allocations: Allocation[] = []
  constructor(private app: WorkbenchUI) {}
  clearDay(): void {
    this.day = null
    this.preview = null
    this.confirmed = false
    this.startPunch = ''
    this.endPunch = ''
    this.punchesConfirmed = false
  }
  clear(): void {
    this.clearDay()
    this.tasks = []
    this.next = null
    this.cursors.clear()
    this.selected = ''
    this.allocations = []
    this.mapping = false
    this.scan = null
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
          { team: this.app.team, date: this.date, mappingConfirmed: this.mapping },
          signal
        ),
      (day) => {
        this.day = day
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
  private scanMissing(): void {
    this.scan = null
    this.app.invalidateDay()
    void this.app.run(
      async signal => {
        const days: MissingDay[] = []
        let cursor: string | undefined
        do {
          const result = await request<{ days: MissingDay[]; nextCursor: string | null; total: number }>(
            'hours.scan', { team: this.app.team, months: Number(this.months), mappingConfirmed: this.mapping, cursor }, signal)
          days.push(...result.days)
          this.app.info = `正在核对考勤：${days.length} / ${result.total} 天；尚未完成，不作为缺报结论。`
          this.app.render()
          cursor = result.nextCursor ?? undefined
        } while (cursor)
        this.app.info = '扫描完成；选择日期后会重新读取当日考勤与工时。'
        return days.reverse()
      },
      result => { this.scan = result }
    )
  }
  private generate(): void {
    this.app.invalidate()
    try {
      const task = this.tasks.find(t => t.id === this.selected)
      if (!task || !this.day || this.startPunch === '' || this.endPunch === '') throw new Error()
      const budget = attendanceBudget(this.day.attendance, { start: Number(this.startPunch), end: Number(this.endPunch), confirmed: this.punchesConfirmed })
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
            selection: {
              start: Number(this.startPunch),
              end: Number(this.endPunch),
              confirmed: this.punchesConfirmed
            },
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
          this.date = value.date
          this.allocations = value.allocations
          this.app.info = '草稿已恢复，请重新读取考勤和任务。'
        } else this.app.info = '当前身份没有草稿。'
      }
    )
  }
  render(): HTMLElement {
    const app = this.app,
      authenticated = app.status?.ones.connected && app.status?.coho.connected
    const content = stack(
      notice('扫描缺报 → 考勤交叉核对 → 按任务生成草稿。考勤额度只是上限，不自动填满或提交。'),
      app.teamSelect(),
      input('业务日期（YYYY-MM-DD）', this.date, (v) => this.changeDate(v), { disabled: app.busy }),
      check(
        '已确认 ONES 与 Coho 均为本人账号',
        this.mapping,
        (v) => {
          this.mapping = v
          this.scan = null
          app.invalidateDay()
          app.render()
        },
        app.busy
      ),
      row(
        button(
          '读取考勤与已有工时',
          () => this.loadDay(),
          app.busy || !authenticated || !this.mapping || !app.team
        ),
        button(
          '读取可分配任务',
          () => this.loadTasks(),
          app.busy || !app.status?.ones.connected || !app.team
        )
      ),
      this.next
        ? button('加载更多工作项（列表尚未完整）', () => this.loadTasks(true), app.busy)
        : null
    )
    content.append(card(
      '查找缺少工时的日期',
      select('查询范围', this.months, [
        { value: '1', label: '近一个月' }, { value: '2', label: '近两个月' },
        { value: '3', label: '近三个月' }, { value: '6', label: '近半年' }, { value: '12', label: '近一年' }
      ], value => { this.months = value; this.scan = null; app.render() }, app.busy),
      text('按上海时区查询至昨天；逐日核对考勤，长范围可能耗时较久。失败不视为缺报。', true),
      button('扫描工时与考勤', () => this.scanMissing(), app.busy || !authenticated || !this.mapping || !app.team)
    ))
    if (this.scan) {
      const labels = { missing: '未填写', partial: '未达考勤额度', covered: '已覆盖', review: '待核实考勤' }
      content.append(card('扫描结果',
        text(`已核对 ${this.scan.length} 天 · 未填写 ${this.scan.filter(d => d.state === 'missing').length} 天 · 未达额度 ${this.scan.filter(d => d.state === 'partial').length} 天 · 待核实 ${this.scan.filter(d => d.state === 'review').length} 天`),
        ...this.scan.filter(d => d.state !== 'covered' || d.existing > (d.budget ?? 0)).map(day => stack(
          text(day.date + ' · ' + labels[day.state]),
          text('已有 ' + hours(day.existing) + (day.remaining === null ? '' : ' · 可分配上限 ' + hours(day.remaining))),
          text(day.reason, true),
          button('核对 ' + day.date, () => { this.changeDate(day.date); this.loadDay() }, app.busy)
        ))
      ))
    }
    if (this.day) {
      const choices = [
        { value: '', label: '请选择实际记录' },
        ...this.day.attendance.punches.map((p, index) => ({
          value: String(index),
          label: `${p.date} ${p.time}${p.isNext ? ' · 跨日' : ''}${p.outFence !== false ? ' · 外勤标志待核对' : ''}`
        }))
      ]
      const choose = (which: 'start' | 'end', value: string) => {
        if (which === 'start') this.startPunch = value
        else this.endPunch = value
        this.punchesConfirmed = false
        app.invalidate()
        app.render()
      }
      content.append(
        card(
          '核对考勤依据',
          text(`${this.day.attendance.date} · ${this.day.attendance.punches.length} 条打卡`),
          select('上班打卡', this.startPunch, choices, (v) => choose('start', v), app.busy),
          select('下班打卡', this.endPunch, choices, (v) => choose('end', v), app.busy),
          check(
            '已核对本人当日上下班记录，无缺卡、跨日或外勤异常',
            this.punchesConfirmed,
            (v) => {
              this.punchesConfirmed = v
              app.invalidate()
              app.render()
            },
            app.busy
          ),
          text('不自动配对；异常记录不默认计 8 小时。', true),
          text('当日已登记：' + hours(this.day.existing))
        )
      )
    } else content.append(notice('尚无有效考勤依据；未读取成功前，新增工时不可提交。'))
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
          app.busy || !this.day || !this.selected || !this.punchesConfirmed || this.startPunch === '' || this.endPunch === ''),
        text('使用所填时长生成，不自动推断投入；空描述按任务标题建议，提交前须人工确认。', true),
        button(
          '加入分配草稿',
          () => this.add(),
          app.busy || !this.day || this.allocations.length >= 20
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
            !this.punchesConfirmed ||
            this.startPunch === '' ||
            this.endPunch === '' ||
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
