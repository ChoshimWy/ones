import type { Status, Site, Task, Option, TaskPage } from '../domain/model.ts'
import {
  arrowIcon,
  button,
  card,
  check,
  el,
  input,
  message,
  notice,
  request,
  row,
  select,
  stack,
  text
} from './dom.ts'
import { DetailView } from './detail.ts'
import { HoursView } from './hours.ts'
import { RecordsView } from './records.ts'

export class WorkbenchUI {
  status: Status | null = null
  team = ''
  busy = false
  error = ''
  info = ''
  readonly hours = new HoursView(this)
  readonly records = new RecordsView(this)
  private tab = 'bugs'
  private epoch = 0
  private controller?: AbortController
  private disposed = false
  private detail?: DetailView
  private accounts: Record<Site, string> = { ones: '', coho: '' }
  private passwords: Record<Site, string> = { ones: '', coho: '' }
  private httpConsent = false
  private bugs: Task[] = []
  private next: string | null = null
  private cursors = new Set<string>()
  private bugController?: AbortController
  private bugGeneration = 0
  private bugLoading = false
  private bugLoaded = false
  private bugError = ''
  private project = 'all'
  private projectName = ''
  private projectFollowing = true
  private projectFollowNote = ''
  private projectGeneration = 0
  private localProjectId?: string | null
  private focusKey?: string
  private workspaceSubscription?: { dispose(): void }
  private statuses: string[] | null = ['待处理', '重新打开', '修复中']
  private catalog: Option[] | null = null
  private expanded = false
  constructor(private root: HTMLElement) {
    try {
      this.workspaceSubscription = orca.on('workspace.changed', ({ context }) => {
        const key = JSON.stringify(context ? [context.displayName, context.branch, context.terminals.map(t => t.id).sort()] : null)
        if (this.disposed || key === this.focusKey) return
        this.focusKey = key
        void this.followProject(true)
      })
    } catch { /* No read capability: the initial query falls back to all projects. */ }
    void this.start()
  }
  private async start(): Promise<void> {
    await this.refresh()
    if (!this.disposed && this.tab === 'bugs') void this.loadBugs()
  }
  private async followProject(focusChanged = false): Promise<void> {
    const generation = ++this.projectGeneration, epoch = this.epoch
    if ((!this.projectFollowing && !focusChanged) || this.disposed || !this.status?.ones.connected || !this.team) return
    const team = this.team
    const projects = [...new Map(this.bugs.map(task => [task.project.id, task.project])).values()]
    this.render()
    const current = () => generation === this.projectGeneration && epoch === this.epoch && team === this.team && !this.disposed
    try {
      const result = await request<{ localProject: Option | null; project: Option | null }>('bugs.projectFilter', { team, projects })
      if (!current()) return
      const localProjectId = result.localProject?.id ?? null
      if (focusChanged && localProjectId !== this.localProjectId) this.projectFollowing = true
      this.localProjectId = localProjectId
      if (!this.projectFollowing) return
      this.project = result.project?.id ?? 'all'
      this.projectName = result.project?.name ?? ''
      this.projectFollowNote = result.localProject
        ? `跟随 Orca：${result.localProject.name} · ${result.project ? '已匹配项目' : '未找到唯一匹配，显示全部已读取项目'}`
        : '未能识别当前 Orca 项目，显示全部已读取项目。'
    } catch {
      if (!current()) return
      this.project = 'all'
      this.projectName = ''
      this.localProjectId = null
      this.projectFollowing = true
      this.projectFollowNote = '项目跟随不可用，显示全部已读取项目。'
    } finally { if (current()) this.render() }
  }
  async run<T>(
    action: (signal: AbortSignal) => Promise<T>,
    accept: (value: T) => void
  ): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    this.error = ''
    this.info = ''
    const controller = new AbortController(),
      epoch = this.epoch
    this.controller = controller
    this.render()
    try {
      const value = await action(controller.signal)
      if (epoch === this.epoch && !this.disposed) accept(value)
    } catch (error) {
      if (epoch === this.epoch && !this.disposed) this.error = message(error)
    } finally {
      if (this.controller === controller) {
        this.controller = undefined
        this.busy = false
        this.render()
      }
    }
  }
  invalidate(): void {
    this.epoch++
    this.hours.preview = null
    this.hours.confirmed = false
  }
  invalidateDay(): void {
    this.invalidate()
    this.hours.clearDay()
    this.records.clear()
  }
  private cancelBugs(): void {
    this.bugGeneration++
    this.bugController?.abort()
    this.bugController = undefined
    this.bugLoading = false
  }
  private clearBusiness(): void {
    this.detail?.dispose()
    this.detail = undefined
    this.cancelBugs()
    this.invalidateDay()
    this.hours.clear()
    this.bugs = []
    this.next = null
    this.cursors.clear()
    this.bugLoaded = false
    this.bugError = ''
    this.projectGeneration++
    this.projectFollowing = true
    this.localProjectId = undefined
    this.projectFollowNote = ''
    this.project = 'all'
    this.projectName = ''
    this.statuses = ['待处理', '重新打开', '修复中']
    this.catalog = null
    this.expanded = false
  }
  private acceptStatus(status: Status): void {
    const team = status.teams.some((t) => t.id === this.team)
      ? this.team
      : status.teams.length === 1
        ? status.teams[0].id
        : ''
    if (
      team !== this.team ||
      this.status?.ones.label !== status.ones.label ||
      this.status?.ones.connected !== status.ones.connected ||
      this.status?.coho.label !== status.coho.label ||
      this.status?.coho.connected !== status.coho.connected
    )
      this.clearBusiness()
    this.team = team
    this.status = status
  }
  private async refresh(): Promise<void> {
    await this.run(
      (signal) => request<Status>('status', undefined, signal),
      (value) => this.acceptStatus(value)
    )
  }
  private async login(site: Site): Promise<void> {
    if (this.busy) return
    this.clearBusiness()
    let password = this.passwords[site]
    this.passwords[site] = ''
    try {
      await this.run(
        (signal) =>
          request<Status>(
            'auth.login',
            { site, account: this.accounts[site], password, httpAcknowledged: this.httpConsent },
            signal
          ),
        (value) => {
          this.acceptStatus(value)
          this.info = '已完成认证与身份回读。'
        }
      )
    } finally {
      password = ''
      this.passwords[site] = ''
    }
  }
  private logout(site: Site): void {
    if (this.busy) return
    this.clearBusiness()
    this.passwords[site] = ''
    void this.run(
      (signal) => request<Status>('auth.logout', { site }, signal),
      (value) => this.acceptStatus(value)
    )
  }
  private cancel(): void {
    this.epoch++
    this.controller?.abort()
    this.passwords = { ones: '', coho: '' }
    this.error = '操作已取消；若刚提交登录，请刷新连接状态。'
    this.render()
  }
  changeTab(value: string): void {
    if (this.busy || value === this.tab) return
    if (this.tab === 'bugs') this.cancelBugs()
    if (this.tab === 'implementation') {
      this.detail?.dispose()
      this.detail = undefined
    }
    this.tab = value
    this.passwords = { ones: '', coho: '' }
    this.error = ''
    this.info = ''
    this.render()
    if (value === 'bugs') void this.loadBugs()
  }
  private openDetail(task: Task): void {
    this.cancelBugs()
    this.detail?.dispose()
    this.tab = 'implementation'
    this.error = ''
    this.info = ''
    this.detail = new DetailView(this.team, task.id)
    this.detail.back = () => this.changeTab('bugs')
    this.render()
  }
  async loadBugs(more = false): Promise<void> {
    if (more && this.bugLoading) return
    const after = more ? this.next : ''
    if (after === null) return
    this.cancelBugs()
    this.bugError = ''
    this.projectGeneration++
    if (!more) {
      this.bugs = []
      this.next = null
      this.cursors.clear()
      this.bugLoaded = false
      this.catalog = null
      this.expanded = false
    }
    if (!this.status?.ones.connected || !this.team) {
      this.render()
      return
    }
    const generation = this.bugGeneration,
      epoch = this.epoch,
      team = this.team,
      controller = new AbortController()
    this.bugController = controller
    this.bugLoading = true
    this.render()
    const current = () =>
      generation === this.bugGeneration &&
      epoch === this.epoch &&
      team === this.team &&
      !this.disposed
    try {
      const page = await request<TaskPage>('bugs.list', { team, after }, controller.signal)
      if (!current()) return
      const previous = more ? this.bugs : []
      if (
        new Set(page.items.map((t) => t.id)).size !== page.items.length ||
        page.items.some((t) => previous.some((old) => old.id === t.id)) ||
        (page.nextCursor !== null && this.cursors.has(page.nextCursor))
      ) {
        this.next = null
        this.bugError = '缺陷分页重复或未推进，列表不完整，请重新刷新。'
        return
      }
      this.bugs = [...previous, ...page.items]
      this.next = page.nextCursor
      this.bugLoaded = true
      if (this.next) this.cursors.add(this.next)
      if (this.projectFollowing) void this.followProject()
    } catch (error) {
      if (current()) this.bugError = message(error)
    } finally {
      if (generation === this.bugGeneration) {
        this.bugLoading = false
        this.bugController = undefined
        this.render()
      }
    }
  }
  private loadStatuses(): void {
    this.catalog = null
    void this.run(
      (signal) => request<Option[]>('bugs.statuses', { team: this.team }, signal),
      (value) => {
        this.catalog = value
      }
    )
  }
  teamSelect(): HTMLElement {
    return select(
      'ONES 团队',
      this.team,
      [
        { value: '', label: '请选择当前团队' },
        ...(this.status?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))
      ],
      (value) => {
        this.team = value
        this.clearBusiness()
        this.render()
      },
      this.busy
    )
  }
  private settings(): HTMLElement {
    const login = (site: Site) => {
      const name = site === 'ones' ? 'ONES' : 'Coho',
        connection = this.status?.[site]
      return card(
        site === 'ones' ? 'ONES · 内网项目管理' : 'Coho · 本人考勤',
        text(site === 'ones' ? 'aputureones.com:8088' : 'w.coho.net.cn · ATS', true),
        text(connection?.connected ? connection.label : '未登录', true),
        input(
          site === 'ones' ? 'ONES 邮箱' : 'Coho 账号',
          this.accounts[site],
          (v) => {
            this.accounts[site] = v
            this.render()
          },
          { disabled: this.busy }
        ),
        input(
          name + ' 密码',
          this.passwords[site],
          (v) => {
            this.passwords[site] = v
            this.render()
          },
          { type: 'password', disabled: this.busy }
        ),
        site === 'ones'
          ? check(
              '我确认仅在可信内网使用 HTTP，了解密码及令牌的传输风险',
              this.httpConsent,
              (v) => {
                this.httpConsent = v
                this.render()
              },
              this.busy
            )
          : null,
        row(
          button(
            '登录 ' + name,
            () => this.login(site),
            this.busy ||
              !this.accounts[site] ||
              !this.passwords[site] ||
              (site === 'ones' && !this.httpConsent)
          ),
          button('退出 ' + name, () => this.logout(site), this.busy || !connection?.connected)
        )
      )
    }
    return stack(
      text('密码仅用于本次登录，不保存；令牌由 Worker 存入系统保护的插件凭证库。', true),
      login('ones'),
      (this.status?.teams.length ?? 0) > 1 ? this.teamSelect() : null,
      login('coho'),
      button('刷新连接状态', () => this.refresh(), this.busy)
    )
  }
  private bugList(): HTMLElement {
    const projects = new Map(
      this.bugs.map((t) => [t.project.id, { value: t.project.id, label: t.project.name }])
    )
    if (this.project !== 'all' && !projects.has(this.project))
      projects.set(this.project, {
        value: this.project,
        label: this.projectName || '已选项目（本次尚未读取）'
      })
    const list = this.bugs.filter(
      (t) =>
        (this.project === 'all' || t.project.id === this.project) &&
        (this.statuses === null || this.statuses.includes(t.status.name))
    )
    const selectedTags = el('div', 'selected-tags')
    const tags = el('div', 'tags', selectedTags)
    for (const name of this.statuses ?? ['全部状态']) {
      const remove = button('×', () => {
        this.statuses = this.statuses === null ? [] : this.statuses.filter((s) => s !== name)
        this.render()
      })
      remove.setAttribute('aria-label', '移除状态：' + name)
      selectedTags.append(el('span', 'tag', name, remove))
    }
    if (this.statuses?.length === 0) selectedTags.append(text('请选择状态', true))
    const toggle = button(
      '',
      () => {
        this.expanded = !this.expanded
        if (this.expanded && this.catalog === null) this.loadStatuses()
        else this.render()
      },
      this.busy
    )
    toggle.classList.add('status-toggle')
    toggle.append(arrowIcon('filter-arrow'))
    toggle.setAttribute('aria-label', this.expanded ? '收起状态选项' : '展开状态选项')
    toggle.setAttribute('aria-expanded', String(this.expanded))
    tags.append(toggle)
    tags.addEventListener('click', (event) => {
      // Nested buttons keep their own action; the rest of the field toggles the picker.
      if (event.target instanceof Element && !event.target.closest('button')) toggle.click()
    })
    const picker = stack(text('状态筛选'), tags)
    if (this.expanded) {
      const options = [...new Set((this.catalog ?? []).map((s) => s.name))]
      const choices = el(
        'div',
        'stack catalog',
        ...options.map((name) =>
          check(
            '状态：' + name,
            this.statuses === null || this.statuses.includes(name),
            (checked) => {
              const current = this.statuses ?? options
              this.statuses = checked
                ? [...new Set([...current, name])]
                : current.filter((s) => s !== name)
              this.render()
            }
          )
        )
      )
      picker.append(
        card(
          '缺陷状态',
          text('只列缺陷类型配置，不是团队所有工作项状态。', true),
          button(
            this.catalog === null ? '重试读取缺陷状态' : '刷新缺陷状态',
            () => this.loadStatuses(),
            this.busy || !this.team || !this.status?.ones.connected
          ),
          this.catalog === null
            ? text(this.busy ? '正在读取缺陷状态…' : '状态读取未完成，请重试。', true)
            : stack(
                check('全部状态', this.statuses === null, (v) => {
                  this.statuses = v ? null : ['待处理', '重新打开', '修复中']
                  this.render()
                }),
                choices
              ),
          row(
            button('恢复默认状态', () => {
              this.statuses = ['待处理', '重新打开', '修复中']
              this.render()
            }),
            button('清空状态', () => {
              this.statuses = []
              this.render()
            })
          )
        )
      )
    }
    const items = stack(
      ...list.map((task) => {
        const item = button('', () => this.openDetail(task), this.busy, 'card bug-item')
        item.setAttribute('aria-label', `查看 Bug #${task.number} ${task.name} 的详情`)
        const arrow = arrowIcon('bug-item-arrow')
        item.append(
          el(
            'span',
            'bug-item-main',
            el('span', 'bug-item-title', `#${task.number} ${task.name}`),
            el('span', 'muted', `${task.project.name} · 缺陷 · ${task.status.name}`)
          ),
          arrow
        )
        return item
      })
    )
    return stack(
      row(
        text('进入时自动刷新 · 仅本人缺陷', true),
        button(
          '刷新缺陷',
          () => this.loadBugs(),
          this.busy || this.bugLoading || !this.status?.ones.connected || !this.team
        )
      ),
      this.status?.ones.connected && !this.team
        ? notice('请在登录页选择 ONES 团队；多团队账号不默选。')
        : null,
      this.bugLoading ? notice('正在刷新缺陷…') : null,
      this.bugError ? notice(this.bugError + ' 本次结果不完整。', true) : null,
      select(
        '项目筛选',
        this.project,
        [{ value: 'all', label: '全部已读取项目' }, ...projects.values()],
        (v) => {
          this.projectGeneration++
          this.projectFollowing = false
          this.projectFollowNote = '手动筛选；下次切换 Orca 项目后恢复自动匹配。'
          this.project = v
          this.projectName = projects.get(v)?.label ?? ''
          this.render()
        },
        false,
        true
      ),
      this.projectFollowNote ? text(this.projectFollowNote, true) : null,
      picker,
      this.bugLoaded
        ? text(
            `当前显示 ${list.length} / 已读取 ${this.bugs.length} 项；${this.bugError ? '结果不完整' : this.next ? '仍有下一页' : '本次分页结束'}`,
            true
          )
        : null,
      list.length
        ? items
        : text(
            this.bugLoading
              ? '正在更新缺陷列表'
              : this.bugError
                ? '缺陷读取失败，不代表没有缺陷'
                : !this.status?.ones.connected
                  ? '登录 ONES 后自动读取缺陷'
                  : '已读取数据中无匹配缺陷',
            true
          ),
      this.next
        ? button(
            '加载更多缺陷（列表尚未完整）',
            () => this.loadBugs(true),
            this.busy || this.bugLoading
          )
        : null,
      notice('Bug 创建、修改、状态流转尚未开放。读取不改变原 Bug。')
    )
  }
  render(): void {
    if (this.disposed) return
    const active = document.activeElement,
      focusId = active instanceof HTMLElement ? active.id : ''
    const selection =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? [active.selectionStart, active.selectionEnd]
        : null
    const scroll = window.scrollY
    const nav = el('nav')
    nav.setAttribute('aria-label', '工作台功能')
    nav.setAttribute('role', 'tablist')
    for (const [value, label] of [
      ['bugs', '我的 Bug'],
      ['implementation', '实施'],
      ['hours', '考勤工时'],
      ['recovery', '记录核对'],
      ['settings', '登录']
    ]) {
      const tab = button(label, () => this.changeTab(value), this.busy)
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(value === this.tab))
      nav.append(tab)
    }
    const content =
      this.tab === 'bugs'
        ? this.bugList()
        : this.tab === 'settings'
          ? this.settings()
          : this.tab === 'hours'
            ? this.hours.render()
            : this.tab === 'recovery'
              ? this.records.render()
              : (this.detail?.element ?? text('点击“我的 Bug”中的列表条目查看完整详情。', true))
    this.root.replaceChildren(
      row(el('h1', '', 'ONES 工作台'), el('span', 'badge', '开发预览')),
      text('从问题到实施，从考勤到工时', true),
      row(
        el('span', 'badge', `ONES ${this.status?.ones.connected ? '已认证' : '未登录'}`),
        el('span', 'badge', `Coho ${this.status?.coho.connected ? '已认证' : '未登录'}`)
      ),
      nav,
      ...(this.busy
        ? [
            row(
              notice('正在处理，请勿重复提交'),
              button('取消当前请求', () => this.cancel())
            )
          ]
        : []),
      ...(this.error ? [notice(this.error, true)] : []),
      ...(this.info ? [notice(this.info)] : []),
      content
    )
    if (focusId) {
      const field = document.getElementById(focusId)
      field?.focus({ preventScroll: true })
      if (
        selection &&
        (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
        selection[0] !== null
      )
        try {
          field.setSelectionRange(selection[0], selection[1])
        } catch {}
    }
    window.scrollTo(0, scroll)
  }
  dispose(): void {
    this.disposed = true
    this.projectGeneration++
    this.workspaceSubscription?.dispose()
    this.epoch++
    this.controller?.abort()
    this.cancelBugs()
    this.detail?.dispose()
    this.passwords = { ones: '', coho: '' }
    this.root.querySelectorAll<HTMLInputElement>('input[type=password]').forEach((input) => {
      input.value = ''
    })
  }
}
const root = document.getElementById('app')
if (root) {
  const app = new WorkbenchUI(root)
  window.addEventListener('pagehide', () => app.dispose(), { once: true })
}
