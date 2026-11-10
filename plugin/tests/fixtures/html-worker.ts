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
  let repairManual = false
  let repairRecord: Record<string, unknown> | null = null
  let repairReadFails = false
  let implementationSeeded = false
  let implementationDelay = 0
  let draft: unknown = null
  let listCount = 0
  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    status: () => status,
    'fixture.repair-manual': () => { repairRecord = null; repairManual = true; return { changed: true } },
    'fixture.repair-error': input => { repairReadFails = input.enabled === true; return {} },
    'fixture.implementation': input => {
      implementationSeeded = input.seeded === true
      implementationDelay = Number(input.delay ?? 0)
      repairReadFails = input.error === true
      if (implementationSeeded) repairRecord = { state: 'sent', projectId: 'local-fixture', projectName: '本地虚构项目', createdAt: 1794186000000, sessionId: 'session-fixture-only' }
      return {}
    },
    'repair.list': async () => {
      const failed = repairReadFails
      const rows = implementationSeeded ? [
        { task, record: repairRecord },
        { task: { ...task, id: 'closed-bug', number: 90, name: '虚构已关闭缺陷', status: { id: 'closed', name: '已关闭' } }, record: { state: 'unknown', projectId: 'local-fixture', projectName: '本地虚构项目', createdAt: 1794185000000 } }
      ] : repairRecord ? [{ task, record: repairRecord }] : []
      if (implementationDelay) await new Promise(resolve => setTimeout(resolve, implementationDelay))
      if (failed) throw Error('Fixture record list failed')
      return rows
    },
    'repair.read': () => {
      if (repairReadFails) return Promise.reject(Error('Fixture record read failed'))
      return repairRecord
    },
    'repair.prepare': () => ({ id: 'repair-plan', mapping: repairManual ? { kind: 'manual', reason: 'missing', candidates: [{ id: 'local-fixture', name: '本地虚构项目' }] } : { kind: 'mapped', via: 'automatic', project: { id: 'local-fixture', name: '本地虚构项目' } }, existing: repairRecord }),
    'repair.start': input => {
      if (input.projectId !== 'local-fixture' || input.confirmed !== true) throw Error('Invalid fixture repair')
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
      return Promise.resolve(handler(input as Record<string, unknown>)).then((value) => ({
        ok: true,
        value
      }))
    })
}
