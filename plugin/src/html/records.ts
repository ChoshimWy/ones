import type { Worklog } from '../domain/model.ts'
import type { PendingWrite, RecoveryPreview } from '../protocol.ts'
import type { WorkbenchUI } from './panel.ts'
import { button, card, check, hours, input, notice, request, stack, text } from './dom.ts'
const localStart = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
export class RecordsView {
  private records: Worklog[] = []
  private selected = ''
  private description = ''
  private descriptionConfirmed = false
  private pending: PendingWrite[] = []
  private recovery: RecoveryPreview | null = null
  private confirmed = false
  constructor(private app: WorkbenchUI) {}
  clear(): void {
    this.records = []
    this.selected = ''
    this.description = ''
    this.descriptionConfirmed = false
    this.pending = []
    this.recovery = null
    this.confirmed = false
  }
  private loadPending(): void {
    this.pending = []
    this.recovery = null
    this.confirmed = false
    void this.app.run(
      (signal) => request<PendingWrite[]>('recovery.list', { team: this.app.team }, signal),
      (value) => {
        this.pending = value
      }
    )
  }
  private loadRecords(): void {
    this.clear()
    this.app.invalidate()
    void this.app.run(
      (signal) =>
        request<Worklog[]>(
          'hours.list',
          { team: this.app.team, date: this.app.hours.date },
          signal
        ),
      (value) => {
        this.records = value
      }
    )
  }
  render(): HTMLElement {
    const app = this.app,
      recovery = this.recovery,
      selected = this.records.find((r) => r.key === this.selected)
    const pending = card(
      '待核实操作',
      text('只读回查，确认仅更新本地账本；零/多匹配保持阻断，不重发。', true),
      button(
        '读取待核实操作',
        () => this.loadPending(),
        app.busy || !app.status?.ones.connected || !app.team
      ),
      ...this.pending.map((item) =>
        stack(
          text(
            `${item.date} · ${item.kind === 'add' ? '新增工时' : '补全描述'} · ${hours(item.minutes)} · ${item.hasKey ? '已有服务端 key' : '未取得 key'}`
          ),
          button(
            '只读核对此项',
            () => {
              this.recovery = null
              this.confirmed = false
              return app.run(
                (signal) =>
                  request<RecoveryPreview>(
                    'recovery.preview',
                    { team: app.team, receiptId: item.id },
                    signal
                  ),
                (value) => {
                  this.recovery = value
                }
              )
            },
            app.busy
          )
        )
      )
    )
    if (!this.pending.length) pending.append(text('尚未读取或当前身份没有待核实操作。', true))
    if (recovery) pending.append(notice(`匹配记录：${recovery.matchCount} · ${recovery.message}`))
    if (recovery?.candidate) {
      const item = recovery.candidate
      pending.append(
        stack(
          text(`${localStart(item.startTime)} · ${hours((item.hours * 60) / 100000)}`),
          text('任务标识：' + item.task),
          text('实际描述：' + item.description),
          check(
            '我确认该记录属于本次操作，仅解除本地核对阻断',
            this.confirmed,
            (v) => {
              this.confirmed = v
              app.render()
            },
            app.busy
          ),
          button(
            '确认本地核对结果',
            () =>
              app.run(
                (signal) =>
                  request(
                    'recovery.confirm',
                    { previewId: recovery.id, confirmed: this.confirmed },
                    signal
                  ),
                () => {
                  app.invalidateDay()
                  app.info =
                    '已更新本地账本，未向 ONES 发送写入。请重读考勤并核对保留草稿，勿重复登记。'
                }
              ),
            app.busy || !recovery.id || !this.confirmed
          )
        )
      )
    }
    const records = card(
      '原记录描述补全',
      text('只补本人原记录的空描述，不新增工时、不改变日期时长归属。生产写入仍关闭。', true),
      input('记录日期（YYYY-MM-DD）', app.hours.date, (v) => app.hours.changeDate(v), {
        disabled: app.busy
      }),
      button(
        '读取本人当日原记录',
        () => this.loadRecords(),
        app.busy || !app.status?.ones.connected || !app.team
      ),
      ...this.records.map((item) =>
        stack(
          text(`${localStart(item.startTime)} · ${hours((item.hours * 60) / 100000)}`),
          text(item.description || '描述为空'),
          button(
            '补全此条描述',
            () => {
              this.selected = item.key
              this.description = ''
              this.descriptionConfirmed = false
              app.render()
            },
            app.busy || !!item.description.trim()
          )
        )
      )
    )
    if (selected)
      records.append(
        stack(
          text(
            `原记录：${selected.key} · ${localStart(selected.startTime)} · ${hours((selected.hours * 60) / 100000)}`
          ),
          input(
            '补全描述（只更新原记录）',
            this.description,
            (v) => {
              this.description = v
              this.descriptionConfirmed = false
              app.render()
            },
            { multiline: true, disabled: app.busy }
          ),
          check(
            '确认仅补全这条原记录的描述，不改变日期或时长',
            this.descriptionConfirmed,
            (v) => {
              this.descriptionConfirmed = v
              app.render()
            },
            app.busy
          ),
          button(
            '提交原记录描述补全',
            () =>
              app.run(
                (signal) =>
                  request(
                    'hours.describe',
                    {
                      team: app.team,
                      date: app.hours.date,
                      key: selected.key,
                      description: this.description,
                      confirmed: this.descriptionConfirmed
                    },
                    signal
                  ),
                () => {
                  app.invalidateDay()
                  app.info = '原描述已回读核实。'
                }
              ),
            app.busy ||
              !app.status?.descriptionWriteEnabled ||
              !this.description.trim() ||
              !this.descriptionConfirmed
          )
        )
      )
    return stack(app.teamSelect(), pending, records)
  }
}
