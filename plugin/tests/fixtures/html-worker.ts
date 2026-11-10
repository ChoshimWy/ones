import type { OrcaWorkerApi } from 'orca/worker'
import { readFileSync } from 'node:fs'
const assets = JSON.parse(readFileSync(new URL('./fixture-assets.json', import.meta.url), 'utf8'))
const task = {
  id: 'bug-fixture',
  number: 88,
  name: '虚构验证：完整正文、图片、视频与评论',
  project: { id: 'project', name: '媒体验证项目' },
  issueType: { id: 'bug', name: '缺陷' },
  status: { id: 'pending', name: '待处理' }
}
const normalTask = {
  ...task,
  id: 'task-fixture',
  number: 89,
  name: '虚构普通任务',
  issueType: { id: 'task', name: '任务' }
}
const status = {
  ones: { connected: true, label: '虚构账号' },
  coho: { connected: true, label: '虚构考勤账号' },
  teams: [{ id: 'team', name: '虚构团队' }],
  writeEnabled: false,
  blockers: []
}
const detail = {
  detailId: 'detail-fixture',
  task,
  content: [
    {
      kind: 'text',
      text: '复现步骤\n1. 打开缺陷详情。\n2. 查看正文图片并播放视频。\n预期：正文、媒体、评论完整显示，不触发任何工时或 Bug 写入。\n<script>window.externalContentExecuted=true</script>'
    },
    { kind: 'media', resourceId: 'image', mediaType: 'image', label: '虚构复现截图' },
    { kind: 'media', resourceId: 'video', mediaType: 'video', label: '虚构复现视频' },
    { kind: 'text', text: '正文末尾：此页面仅使用虚构数据。' }
  ],
  updatedAt: 100,
  comments: {
    items: [
      {
        id: 'comment',
        author: '测试评论者',
        sentAt: 1794000000000000,
        content: [{ kind: 'text', text: '评论全文：图片清晰，视频支持播放、暂停和跳转。' }]
      }
    ],
    nextMax: 100
  },
  attachments: {
    items: [
      { id: 'broken', name: '虚构：不支持的媒体', mime: 'image/png', size: 64, createdAt: 100 }
    ],
    nextMax: null
  }
}
export default function activate(orca: OrcaWorkerApi): void {
  const calls: string[] = []
  let transitionMode = 'success'
  let transitionOperation: Record<string, unknown> | null = null
  let transitionInput: Record<string, unknown> | null = null
  let transitionRelease: (() => void) | undefined
  let repairManual = false
  let repairRecord: Record<string, unknown> | null = null
  let repairReadFails = false
  let implementationSeeded = false
  let implementationDelay = 0
  let draft: unknown = null
  let listCount = 0
  let reportMode = 'not_run'
  const report = () => ({reportVersion:2,reportSequence:1,rootCause:'状态刷新沿用了旧对象',solution:'修复后读取权威数据并刷新本地投影',impact:'实施列表与后续状态操作',repair:{state:'fixed',workspace:'isolated_worktree'},validation:{status:reportMode,reason:reportMode==='passed'?'定向验证通过':'实体硬件尚未验收',remaining:reportMode==='passed'?[]:['实体硬件验收'],evidence:['定向测试通过 /fixture/report.json']},delivery:{state:'uncommitted',note:'未提交、未合并、未发布'},sourceIdentity:'HEAD fixture + patch fixture'})
  const finalStep = () => ({id:'fix',name:'完成修复',target:{id:'done',name:'已修复'},blockers:[],fields:[{id:'cause',name:'根因',type:1,required:true,value:'',options:[{id:'logic',name:'代码逻辑问题'}]},{id:'version',name:'解决版本',type:2,required:false,value:'',options:[]}]})
  const startRoute = () => [{source:task.status,step:{id:'confirm',name:'确认',target:{id:'confirmed',name:'确认'},fields:[],blockers:[]}},{source:{id:'confirmed',name:'确认'},step:{id:'start',name:'开始修复',target:{id:'repairing',name:'修复中'},fields:[{id:'classification',name:'分类说明',type:2,required:true,value:'',options:[]}],blockers:[]}}]
  const summary = () => `说明来源：Agent 结构化回执，非插件独立验收。\n\n根本原因\n${report().rootCause}\n\n解决方法\n${report().solution}\n\n影响范围\n${report().impact}\n\n验证结果\n${report().validation.reason}\n\n交付情况\n未提交、未合并、未发布`
  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    status: () => status,
    'fixture.transition-mode': input => { transitionMode = String(input.mode); return {} },
    'fixture.transition-release': () => { transitionRelease?.(); return {} },
    'fixture.report-mode': input => {reportMode=String(input.mode);return{}},
    'bugs.businessOptions': () => ({snapshot:{task,stamp:'fixture-stamp',steps:[finalStep()]},goal:'已修复',route:task.status.id==='done'?[]:[{source:task.status,step:finalStep()}],comment:summary(),completionBlocker:reportMode==='passed'?'':'验收尚未完成：实体硬件尚未验收',operation:transitionOperation,writeEnabled:true,blockedReason:''}),
    'bugs.businessPreview': input => {
      const fields=input.fields as Record<string,Record<string,string>>
      if(reportMode!=='passed')throw Error('验收未完成')
      if(!fields.fix?.cause)throw Error('Fixture required root cause')
      transitionInput=input
      return{id:'preview-fixture',task,goal:'已修复',route:[{source:task.status,step:finalStep()}],fields,comment:input.comment,expiresAt:Date.now()+300000}
    },
    'bugs.businessSubmit': async()=>{
      transitionOperation={id:'operation-fixture',state:'unknown',createdAt:Date.now(),evidence:{status:false,fields:false,comment:false,asyncStatus:'none',message:'结果待核实；禁止重发。'}}
      if(transitionMode==='hold')await new Promise<void>(resolve=>{transitionRelease=resolve})
      if(transitionMode==='unknown')return{state:'unknown',operations:[transitionOperation],target:'已修复'}
      task.status={id:'done',name:'已修复'}
      detail.comments.items.unshift({id:'new-comment',author:'虚构用户',sentAt:1794000000000000,content:[{kind:'text',text:String(transitionInput?.comment)}]})
      transitionOperation.state='verified'
      return{state:'verified',operations:[transitionOperation],target:'已修复'}
    },
    'bugs.transitionReconcile': () => {
      task.status = { id: 'done', name: '已修复' }
      detail.comments.items.unshift({ id: 'new-comment', author: '虚构用户', sentAt: 1794000000000000, content: [{ kind: 'text', text: String(transitionInput?.comment) }] })
      if (transitionOperation) { transitionOperation.state = 'verified'; transitionOperation.evidence = { status: true, fields: true, comment: true, asyncStatus: 'none', message: '状态、字段及本次评论已回读一致。' } }
      return transitionOperation
    },
    'fixture.repair-manual': () => { repairRecord = null; repairManual = true; return { changed: true } },
    'fixture.repair-error': input => { repairReadFails = input.enabled === true; return {} },
    'fixture.implementation': input => {
      implementationSeeded = input.seeded === true
      implementationDelay = Number(input.delay ?? 0)
      repairReadFails = input.error === true
      if (implementationSeeded) repairRecord = { state: 'sent', projectId: 'local-fixture', projectName: '本地虚构项目', createdAt: 1794186000000, sessionId: 'session-fixture-only' }
      return {}
    },
    'repair.cache': () => {
      const rows = implementationSeeded ? [
        { task, record: repairRecord, report: report() },
        { task: { ...task, id: 'closed-bug', number: 90, name: '虚构已关闭缺陷', status: { id: 'closed', name: '已关闭' } }, record: { state: 'unknown', projectId: 'local-fixture', projectName: '本地虚构项目', createdAt: 1794185000000 } }
      ] : repairRecord ? [{ task, record: repairRecord, report: report() }] : []
      return { items: rows, syncedAt: 1794186000000, reconciledAt: 1794186000000, version: 1 }
    },
    'repair.sync': async () => {
      const failed = repairReadFails
      const rows = implementationSeeded ? [
        { task, record: repairRecord, report: report() },
        { task: { ...task, id: 'closed-bug', number: 90, name: '虚构已关闭缺陷', status: { id: 'closed', name: '已关闭' } }, record: { state: 'unknown', projectId: 'local-fixture', projectName: '本地虚构项目', createdAt: 1794185000000 } }
      ] : repairRecord ? [{ task, record: repairRecord, report: report() }] : []
      if (implementationDelay) await new Promise(resolve => setTimeout(resolve, implementationDelay))
      if (failed) throw Error('Fixture record list failed')
      return { items: rows, syncedAt: Date.now(), reconciledAt: Date.now(), version: 2 }
    },
    'repair.read': () => {
      if (repairReadFails) return Promise.reject(Error('Fixture record read failed'))
      return repairRecord
    },
    'repair.result': () => repairRecord ? {task,record:repairRecord,report:report()} : null,
    'repair.previewStart': input => {
      const fields=input.fields as Record<string,Record<string,string>>
      if(input.projectId!=='local-fixture'||!fields.start?.classification)throw Error('Fixture required root cause')
      return{id:'start-preview',projectName:'本地虚构项目',status:{id:'business-start',task,goal:'修复中',route:startRoute(),fields,comment:'开始修复',expiresAt:Date.now()+300000}}
    },
    'repair.prepare': () => ({ id: 'repair-plan', status:{snapshot:{task},route:startRoute(),operation:null,writeEnabled:true}, mapping: repairManual ? { kind: 'manual', reason: 'missing', candidates: [{ id: 'local-fixture', name: '本地虚构项目' }] } : { kind: 'mapped', via: 'automatic', project: { id: 'local-fixture', name: '本地虚构项目' } }, existing: repairRecord }),
    'repair.start': input => {
      if (input.previewId !== 'start-preview' || input.confirmed !== true) throw Error('Invalid fixture repair')
      task.status = {id:'repairing',name:'修复中'}
      repairRecord = { state: 'sent', projectId: 'local-fixture', projectName: '本地虚构项目', createdAt: 1794186000000, sessionId: 'session-fixture-only' }
      return repairRecord
    },
    'fixture.calls': () => ({ calls, listCount }),
    'auth.login': (input) => {
      status[input.site === 'coho' ? 'coho' : 'ones'].connected = true
      return status
    },
    'auth.logout': (input) => {
      status[input.site === 'coho' ? 'coho' : 'ones'].connected = false
      return status
    },
    'bugs.list': () => {
      listCount++
      return {
        items: [
          task,
          {
            ...task,
            id: 'closed',
            status: { id: 'closed', name: '已关闭' },
            name: '虚构已关闭缺陷'
          }
        ],
        nextCursor: null
      }
    },
    'bugs.statuses': () =>
      ['待处理', '重新打开', '修复中', '已关闭', '已解决'].map((name, i) => ({
        id: String(i),
        name
      })),
    'bugs.detail': () => detail,
    'bugs.comments': (input) =>
      input.before === 100
        ? {
            items: [
              {
                id: 'older',
                author: '较早评论者',
                sentAt: 1600000000000000,
                content: [{ kind: 'text', text: '更早评论全文' }]
              }
            ],
            nextMax: null
          }
        : detail.comments,
    'bugs.close': () => ({ closed: true }),
    'bugs.media': async (input) => {
      if (input.resourceId === 'broken')
        return { mime: 'image/svg+xml', total: 6, offset: 0, data: 'PHN2Zy8+', next: null }
      const video = input.resourceId === 'video'
      if (video) await new Promise((resolve) => setTimeout(resolve, 1300))
      const bytes = Buffer.from(video ? assets.webm : assets.png, 'base64'),
        offset = Number(input.offset),
        end = Math.min(bytes.length, offset + 524288)
      return {
        mime: video ? 'video/webm' : 'image/png',
        total: bytes.length,
        offset,
        data: bytes.subarray(offset, end).toString('base64'),
        next: end === bytes.length ? null : end
      }
    },
    'tasks.list': () => ({ items: [task, normalTask], nextCursor: null }),
    'day.read': (input) => ({
      id: 'day-fixture',
      date: String(input.date),
      attendance: {
        date: String(input.date),
        punches: [
          {
            date: String(input.date),
            realDate: String(input.date),
            time: '09:00',
            isNext: false,
            outFence: false
          },
          {
            date: String(input.date),
            realDate: String(input.date),
            time: '18:30',
            isNext: false,
            outFence: false
          }
        ],
        fetchedAt: 1
      },
      existing: 0,
      worklogs: []
    }),
    'hours.preview': (input) => ({
      id: 'preview-fixture',
      date: '2026-11-09',
      budget: 480,
      existing: 0,
      proposed: 120,
      remaining: 360,
      rows: (input.allocations as object[]).map((item) => ({ ...item, taskName: '虚构普通任务' })),
      expiresAt: Date.now() + 10000
    }),
    'draft.save': (input) => {
      draft = input
      return { saved: true }
    },
    'draft.load': () => draft,
    'hours.list': () => [
      {
        key: 'record-fixture',
        task: 'task-fixture',
        owner: 'owner',
        hours: 200000,
        startTime: 1794186000,
        description: '',
        type: 'recorded'
      }
    ],
    'recovery.list': () => [
      {
        id: 'receipt',
        kind: 'add',
        date: '2026-11-09',
        minutes: 120,
        state: 'unknown',
        hasKey: false
      }
    ],
    'recovery.preview': () => ({
      id: null,
      receiptId: 'receipt',
      matchCount: 2,
      candidate: null,
      message: '两个匹配结果，不能解除阻断。'
    })
  }
  for (const [name, handler] of Object.entries(handlers))
    orca.panels.handle(name, (input) => {
      calls.push(name)
      return Promise.resolve().then(() => handler(input as Record<string, unknown>)).then((value) => ({
        ok: true,
        value
      })).catch(error => ({ ok: false, error: { code: 'fixture', message: error.message === 'Fixture required root cause' ? '请填写根因。' : '虚构读取失败。' } }))
    })
}
