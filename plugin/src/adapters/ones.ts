import { AppError, id, record, requireThat, text, type Task, type TaskPage, type Worklog } from '../domain/model.ts'
import { Transport, jsonBody } from './http.ts'
import type { OnesSession } from './ones-auth.ts'
import { BugDetailsReader } from './bug-details.ts'

function option(value: unknown) {
  const item = record(value)
  return { id: id(item.uuid), name: text(item.name) }
}
export function parseTask(value: unknown): Task {
  const task = record(value)
  requireThat(Number.isSafeInteger(task.number), 'schema', '任务编号无效。')
  return { id: id(task.uuid), number: task.number as number, name: text(task.name, 2000), project: option(task.project), issueType: option(task.issueType), status: option(task.status) }
}
export function parseWorklog(value: unknown): Worklog {
  const row = record(value)
  requireThat(Number.isSafeInteger(row.hours) && Number.isSafeInteger(row.startTime) && typeof row.description === 'string', 'schema', '工时字段格式不匹配。')
  return { key: text(row.key, 150), owner: id(record(row.owner).uuid), task: id(record(row.task).uuid), type: text(row.type), hours: row.hours as number, startTime: row.startTime as number, description: row.description }
}
const TASK_FIELDS = 'uuid number name project{uuid name} issueType{uuid name} status{uuid name}'
const WORKLOG_FIELDS = 'key hours startTime type description owner{uuid} task{uuid}'
export class OnesClient {
  constructor(private transport: Transport, readonly session: OnesSession, readonly team: string) {
    id(team)
    requireThat(session.teams.some(t => t.id === team), 'identity', '所选团队不属于当前登录身份。')
  }
  private get base() { return `/project/api/project/team/${this.team}` }
  async assertIdentity(signal?: AbortSignal): Promise<void> {
    const user = await this.transport.json('/project/api/project/users/me', { headers: { Authorization: `Bearer ${this.session.token}` }, signal })
    requireThat(user.uuid === this.session.userId, 'identity', '当前 ONES 身份已变化。')
  }
  async config(signal?: AbortSignal): Promise<void> {
    const info = await this.transport.json(`${this.base}/info`, { headers: { Authorization: `Bearer ${this.session.token}` }, signal })
    requireThat(info.timezone === 'Asia/Shanghai' && info.workhours_unit === 'hour' && Array.isArray(info.configs) && info.configs.some(v => { const c = record(v); return c.type === 'manhour_mode' && c.data === 'simple' }), 'config', '当前仅支持 Asia/Shanghai、小时单位、simple 工时模式。')
  }
  async graph(query: string, variables: Record<string, unknown>, type: 'Task' | 'Manhour', signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.transport.json(`${this.base}/items/graphql?t=${type}`, { ...jsonBody({ query, variables }, this.session.token), signal })
    return record(result.data)
  }
  private async pages(kind: 'tasks' | 'manhours', filter: Record<string, unknown>, signal?: AbortSignal): Promise<unknown[]> {
    const rows: unknown[] = []; const cursors = new Set<string>(); let after = ''
    const fields = kind === 'tasks' ? TASK_FIELDS : WORKLOG_FIELDS
    const sort = kind === 'tasks' ? 'serverUpdateStamp' : 'startTime'
    for (let page = 0; page < 20; page++) {
      // JSON encoding prevents a server cursor from becoming GraphQL source.
      const query = `query PluginPage($filter: Filter){buckets(groupBy:{${kind}:{}},pagination:{limit:50,after:${JSON.stringify(after)},preciseCount:true}){${kind}(filter:$filter,orderBy:{${sort}:DESC}){${fields}} pageInfo{hasNextPage endCursor unstable}}}`
      const data = await this.graph(query, { filter }, kind === 'tasks' ? 'Task' : 'Manhour', signal)
      requireThat(Array.isArray(data.buckets) && data.buckets.length === 1, 'partial', '分页响应不完整，不能用于额度或完整列表判断。')
      const bucket = record(data.buckets[0]); const meta = record(bucket.pageInfo)
      requireThat(Array.isArray(bucket[kind]) && meta.unstable === false && typeof meta.hasNextPage === 'boolean', 'partial', '查询期间数据不稳定，请重新读取。')
      rows.push(...bucket[kind] as unknown[])
      if (meta.hasNextPage === false) return rows
      const cursor = text(meta.endCursor, 8192)
      requireThat(cursor !== after && !cursors.has(cursor), 'partial', '分页游标重复，已停止读取。')
      cursors.add(cursor); after = cursor
    }
    throw new AppError('partial', '已达到 20 页读取上限，结果不完整；需缩小查询范围，不能据此计算额度。')
  }
  private async bugType(signal?: AbortSignal) {
    const data = await this.transport.json(`${this.base}/issue_types`, { headers: { Authorization: `Bearer ${this.session.token}` }, signal })
    requireThat(Array.isArray(data.issue_types), 'schema', '工作项类型配置缺失，不能确认缺陷类型。')
    const matches = data.issue_types.map(record).filter(type => type.name === '缺陷')
    requireThat(matches.length === 1, 'schema', '无法唯一确认“缺陷”类型，已停止查询；不会退回全部工作项。')
    const type = matches[0]
    requireThat(type.built_in === true && type.type === 0 && type.detail_type === 3, 'schema', '缺陷类型属性与已验证实例不匹配。')
    const configs = record(type.default_configs).default_task_status_configs
    requireThat(Array.isArray(configs) && configs.length > 0, 'schema', '缺陷状态配置缺失；不会使用团队全部状态代替。')
    const statusIds = configs.map(value => id(record(value).status_uuid))
    requireThat(new Set(statusIds).size === statusIds.length, 'schema', '缺陷状态配置存在重复身份。')
    return { ...option(type), statusIds }
  }
  async bugStatuses(signal?: AbortSignal) {
    const type = await this.bugType(signal)
    const all = await this.statuses(signal)
    return type.statusIds.map(statusId => {
      const status = all.find(value => value.id === statusId)
      requireThat(status, 'schema', '缺陷配置引用的状态不存在，请刷新配置。')
      return status
    })
  }
  /// 一个同步周期仅解析一次缺陷类型；定向查询同时约束负责人和类型。
  async repairReader(signal?: AbortSignal) {
    const type = await this.bugType(signal)
    return {
      page: (after: string) => this.assignedTaskPage(after, signal, type.id),
      task: async (taskId: string): Promise<Task | null> => {
        const data = await this.graph(`query PluginRepairTask($filter: Filter){tasks(filter:$filter,limit:2){${TASK_FIELDS}}}`, { filter: { uuid_equal: id(taskId), assign_in: [this.session.userId], issueType_in: [type.id] } }, 'Task', signal)
        requireThat(Array.isArray(data.tasks) && data.tasks.length <= 1, 'partial', '定向缺陷响应不完整。')
        if (!data.tasks.length) return null
        const task = parseTask(data.tasks[0])
        requireThat(task.id === taskId && task.issueType.id === type.id, 'identity', '定向缺陷身份不匹配。')
        return task
      }
    }
  }
  async bugs(after = '', signal?: AbortSignal): Promise<TaskPage> {
    const type = await this.bugType(signal)
    return this.assignedTaskPage(after, signal, type.id)
  }
  async statuses(signal?: AbortSignal) {
    const data = await this.transport.json(`${this.base}/task_statuses`, { headers: { Authorization: `Bearer ${this.session.token}` }, signal })
    requireThat(Array.isArray(data.task_statuses), 'schema', '完整状态列表缺失，请重试；不会用任务页中的状态替代。')
    const statuses = data.task_statuses.map(option)
    requireThat(new Set(statuses.map(status => status.id)).size === statuses.length, 'schema', '状态配置存在重复身份，请重新读取。')
    return statuses
  }
  async tasks(after = '', signal?: AbortSignal): Promise<TaskPage> {
    return this.assignedTaskPage(after, signal)
  }
  private async assignedTaskPage(after: string, signal?: AbortSignal, issueTypeId?: string): Promise<TaskPage> {
    requireThat(typeof after === 'string' && after.length <= 8192, 'input', '分页游标格式无效。')
    const query = `query PluginTaskPage($filter: Filter){buckets(groupBy:{tasks:{}},pagination:{limit:50,after:${JSON.stringify(after)},preciseCount:true}){tasks(filter:$filter,orderBy:{serverUpdateStamp:DESC}){${TASK_FIELDS}} pageInfo{hasNextPage endCursor unstable}}}`
    const data = await this.graph(query, { filter: { assign_in: [this.session.userId], ...(issueTypeId ? { issueType_in: [issueTypeId] } : {}) } }, 'Task', signal)
    requireThat(Array.isArray(data.buckets) && data.buckets.length === 1, 'partial', '任务分页响应不完整。')
    const bucket = record(data.buckets[0])
    const meta = record(bucket.pageInfo)
    requireThat(Array.isArray(bucket.tasks) && meta.unstable === false && typeof meta.hasNextPage === 'boolean', 'partial', '任务分页不稳定，请重新读取。')
    const items = bucket.tasks.map(parseTask)
    requireThat(!issueTypeId || items.every(task => task.issueType.id === issueTypeId), 'scope', '服务端返回非缺陷工作项，已停止展示。')
    requireThat(new Set(items.map(task => task.id)).size === items.length, 'partial', '任务分页存在重复身份。')
    const nextCursor = meta.hasNextPage ? text(meta.endCursor, 8192) : null
    requireThat(nextCursor === null || (nextCursor !== after && items.length > 0), 'partial', '任务分页游标未推进。')
    return { items, nextCursor }
  }
  details(): BugDetailsReader {
    return new BugDetailsReader(this.base, (path, signal) => this.transport.json(path, { headers: { Authorization: `Bearer ${this.session.token}` }, signal }))
  }
  async assertBug(task: Task, signal?: AbortSignal): Promise<void> {
    requireThat(task.issueType.id === (await this.bugType(signal)).id, 'scope', '详情入口仅支持缺陷。')
  }
  async task(taskId: string, signal?: AbortSignal): Promise<Task> {
    const data = await this.graph(`query PluginTask($filter: Filter){tasks(filter:$filter,limit:2){${TASK_FIELDS}}}`, { filter: { uuid_equal: id(taskId) } }, 'Task', signal)
    requireThat(Array.isArray(data.tasks) && data.tasks.length === 1, 'identity', '任务已删除、不可访问或不能唯一定位。')
    const task = parseTask(data.tasks[0]); requireThat(task.id === taskId, 'identity', '任务身份不匹配。')
    return task
  }
  async worklogs(date: string, signal?: AbortSignal): Promise<Worklog[]> {
    const rows = (await this.pages('manhours', { owner_in: [this.session.userId], type_equal: 'recorded', startTime_range: { from: date, to: date } }, signal)).map(parseWorklog)
    requireThat(new Set(rows.map(row => row.key)).size === rows.length, 'partial', '工时列表存在重复记录，不能计算额度。')
    return rows
  }
}

// Kept separate from reads. Production handlers gate access until end-to-end write validation.
export function worklogWriter(client: OnesClient) {
  return {
    async add(intent: import('../domain/submission.ts').WriteIntent): Promise<string> {
      const data = await client.graph('mutation PluginAdd{addManhour(task:$task,owner:$owner,type:$type,hours:$hours,start_time:$start_time,description:$description,mode:$mode){key}}', { task: intent.task, owner: intent.owner, type: 'recorded', hours: intent.hours, start_time: intent.startTime, description: intent.description, mode: 'simple' }, 'Manhour')
      return text(record(data.addManhour).key, 150)
    },
    async get(key: string): Promise<Worklog> {
      const data = await client.graph(`query PluginReadback($filter: Filter){manhours(filter:$filter,limit:2){${WORKLOG_FIELDS}}}`, { filter: { key_equal: key } }, 'Manhour')
      requireThat(Array.isArray(data.manhours) && data.manhours.length === 1, 'readback', '无法唯一回读原工时。')
      const row = parseWorklog(data.manhours[0]); requireThat(row.key === key, 'readback', '工时 key 不匹配。')
      return row
    },
    async describe(key: string, description: string): Promise<void> {
      const data = await client.graph('mutation PluginDescribe{updateManhour(key:$key,description:$description,mode:$mode){key}}', { key, description, mode: 'simple' }, 'Manhour')
      requireThat(record(data.updateManhour).key === key, 'readback', '描述更新响应不匹配，需要核实。')
    }
  }
}
