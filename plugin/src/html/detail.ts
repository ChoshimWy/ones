import { StatusView } from './status-update.ts'
import type { BugDetail, DetailPage, Discussion, Attachment } from '../adapters/bug-details.ts'
import type { BugContent } from '../domain/bug-content.ts'
import {
  button,
  card,
  el,
  message,
  notice,
  openOriginal,
  request,
  row,
  stack,
  text
} from './dom.ts'
import { RepairView } from './repair.ts'
import { MediaView } from './media.ts'

type Detail = BugDetail & { detailId: string }
export class DetailView {
  readonly element = el('div', 'stack')
  private body = el('div', 'stack')
  private error = el('div')
  private progress = el('div')
  private current?: Detail
  private controller = new AbortController()
  private generation = 0
  private pendingId?: string
  private media: Record<'body' | 'comments' | 'attachments', MediaView[]> = {
    body: [],
    comments: [],
    attachments: []
  }
  private cursors: Record<'comments' | 'attachments', (number | undefined)[]> = {
    comments: [undefined],
    attachments: [undefined]
  }
  private sections = { comments: el('div'), attachments: el('div') }
  private busy = false
  /// 状态子视图随 detailId 失效，不复用旧确认。
  private statusView?: StatusView
  /// 同页状态表单容器。
  private statusArea = el('div')
  /// 与修复启动独立的状态操作入口。
  private statusTop = button('更新状态', () => this.statusView?.open(), true)
  /// 步骤缺失、权限或 schema 不支持的可见原因。
  private statusReason = el('p', 'muted')
  /// 权威详情刷新后通知父列表刷新，保留当前结果。
  updated?: () => Promise<void>
  private repair?: RepairView
  private repairArea = el('div')
  private repairTop = button('执行修复', () => this.repair?.open(), true, 'primary')
  private repairBottom = button('执行修复', () => this.repair?.open(), true, 'primary')
  constructor(
    private team: string,
    private taskId: string,
    backLabel = '返回我的 Bug',
    private showStatus = false
  ) {
    this.element.append(
      el('div', 'detail-toolbar',
        el('div', 'detail-toolbar-group',
          button(backLabel, () => this.back?.()),
          button('刷新详情', () => this.open()),
          button('打开原单', () => openOriginal(team, taskId))
        ),
        el('div', 'detail-toolbar-group detail-toolbar-right', this.statusTop, this.repairTop)
      ),
      this.statusReason,
      this.statusArea,
      this.repairArea,
      this.progress,
      this.error,
      this.body
    )
    void this.open()
  }
  back?: () => void
  private closeRemote(id: string): void {
    void request('bugs.close', { detailId: id }).catch(() => {})
  }
  private clearMedia(kind: 'body' | 'comments' | 'attachments'): void {
    this.media[kind].forEach((v) => v.dispose())
    this.media[kind] = []
  }
  private reset(): void {
    this.statusView?.dispose()
    this.statusView = undefined
    this.statusArea.replaceChildren()
    this.statusTop.disabled = true
    this.statusReason.textContent = ''
    this.repair?.dispose()
    this.repair = undefined
    this.repairArea.replaceChildren()
    this.repairTop.disabled = true
    this.repairBottom.disabled = true
    this.generation++
    this.controller.abort()
    this.controller = new AbortController()
    const id = this.current?.detailId ?? this.pendingId
    if (id) this.closeRemote(id)
    this.current = undefined
    this.pendingId = undefined
    for (const kind of ['body', 'comments', 'attachments'] as const) this.clearMedia(kind)
  }
  dispose(): void {
    this.reset()
    this.element.replaceChildren()
  }
  private async open(): Promise<void> {
    this.reset()
    const generation = this.generation
    this.busy = true
    this.body.replaceChildren()
    this.error.replaceChildren()
    this.progress.replaceChildren(notice('正在读取 Bug 详情…'))
    this.pendingId = `view-${crypto.randomUUID()}`
    this.cursors = { comments: [undefined], attachments: [undefined] }
    try {
      const detail = await request<Detail>(
        'bugs.detail',
        { team: this.team, taskId: this.taskId, requestId: this.pendingId },
        this.controller.signal
      )
      if (generation !== this.generation) {
        this.closeRemote(detail.detailId)
        return
      }
      this.current = detail
      this.statusView = new StatusView(detail.detailId, (disabled, reason) => {
        this.statusTop.disabled = disabled
        this.statusReason.textContent = reason
      }, async () => {
        await this.open()
        await this.updated?.()
      }, () => this.statusTop.focus())
      this.statusArea.replaceChildren(this.statusView.element)
      void this.statusView.load().then(() => { if (this.showStatus && generation === this.generation) { this.showStatus = false; this.statusView?.open() } })
      this.repair = new RepairView(detail.detailId, (busy, hasRecord) => {
        this.repairTop.disabled = busy
        this.repairBottom.disabled = busy
        this.repairTop.textContent = this.repairBottom.textContent = hasRecord ? '查看执行记录' : '执行修复'
      }, async warning => {
        await this.open()
        if (warning) this.error.replaceChildren(notice(warning,true))
        await this.updated?.()
      })
      this.repairArea.replaceChildren(this.repair.element)
      this.repairTop.disabled = false
      this.repairBottom.disabled = false
      void this.repair.load()
      this.body.replaceChildren(
        el('h2', '', `#${detail.task.number} ${detail.task.name}`),
        text(`${detail.task.project.name} · ${detail.task.status.name}`, true),
        card(
          'Bug 正文',
          detail.content.length
            ? this.content(detail.content, 'body')
            : text('原单正文为空。', true)
        ),
        this.sections.comments,
        this.sections.attachments,
        el('div', 'row detail-footer', this.repairBottom)
      )
    } catch (error) {
      if (generation === this.generation) this.error.replaceChildren(notice(message(error), true))
    } finally {
      if (generation === this.generation) {
        this.busy = false
        this.progress.replaceChildren()
        if (this.current) {
          this.renderPage('comments')
          this.renderPage('attachments')
        }
      }
    }
  }
  private content(blocks: BugContent[], kind: 'body' | 'comments' | 'attachments'): HTMLElement {
    return stack(
      ...blocks.map((block) => {
        if (block.kind === 'text') return text(block.text)
        const media = new MediaView(
          this.current!.detailId,
          block.resourceId,
          block.mediaType,
          block.label
        )
        this.media[kind].push(media)
        return media.element
      })
    )
  }
  private renderPage(kind: 'comments' | 'attachments'): void {
    const detail = this.current
    if (!detail) return
    this.clearMedia(kind)
    const children: HTMLElement[] = []
    if (kind === 'comments')
      for (const item of detail.comments.items)
        children.push(
          stack(
            el(
              'h3',
              '',
              `${item.author} · ${new Date(item.sentAt / 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
            ),
            this.content(item.content, 'comments')
          )
        )
    else
      for (const item of detail.attachments.items) {
        const entry = stack(text(`${item.name} · ${Math.ceil(item.size / 1024)} KiB`))
        if (/^(image|video)\//.test(item.mime))
          entry.append(
            this.content(
              [
                {
                  kind: 'media',
                  resourceId: item.id,
                  mediaType: item.mime.startsWith('image/') ? 'image' : 'video',
                  label: item.name
                }
              ],
              'attachments'
            )
          )
        else entry.append(text('此附件不支持内嵌，请在原单查看。', true))
        children.push(entry)
      }
    const name = kind === 'comments' ? '评论' : '附件',
      page = detail[kind]
    if (!children.length)
      children.push(
        text(page.nextMax === null ? `本页无${name}。` : `本页暂无${name}，仍有更早记录。`, true)
      )
    children.push(
      row(
        button(
          '上一页' + name,
          () => this.page(kind, true),
          this.busy || this.cursors[kind].length <= 1
        ),
        text(
          `第 ${this.cursors[kind].length} 页 · ${page.nextMax === null ? '本次分页结束' : '仍有更早记录'}`,
          true
        ),
        button('更早' + name, () => this.page(kind, false), this.busy || page.nextMax === null)
      )
    )
    this.sections[kind].replaceChildren(
      card(kind === 'comments' ? '相关评论' : '附件', ...children)
    )
  }
  private async page(kind: 'comments' | 'attachments', back: boolean): Promise<void> {
    const current = this.current
    if (!current || this.busy) return
    const history = this.cursors[kind],
      next = current[kind].nextMax
    if (back ? history.length <= 1 : next === null) return
    const updated = back ? history.slice(0, -1) : [...history, next!],
      generation = this.generation
    this.busy = true
    this.error.replaceChildren()
    this.progress.replaceChildren(
      notice('正在读取' + (kind === 'comments' ? '评论' : '附件') + '…')
    )
    try {
      const page = await request<DetailPage<Discussion> | DetailPage<Attachment>>(
        'bugs.' + kind,
        {
          detailId: current.detailId,
          ...(updated.at(-1) === undefined ? {} : { before: updated.at(-1) })
        },
        this.controller.signal
      )
      if (generation !== this.generation) return
      this.current =
        kind === 'comments'
          ? { ...current, comments: page as DetailPage<Discussion> }
          : { ...current, attachments: page as DetailPage<Attachment> }
      this.cursors[kind] = updated
    } catch (error) {
      if (generation === this.generation)
        this.error.replaceChildren(notice(message(error) + ' 原页保留，未标记全部加载。', true))
    } finally {
      if (generation === this.generation) {
        this.busy = false
        this.progress.replaceChildren()
        this.renderPage(kind)
      }
    }
  }
}
