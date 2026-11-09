import type { Attachment, BugDetail, DetailPage, Discussion } from '../adapters/bug-details.ts'
import type { BugContent } from './bug-content.ts'
import { requireThat } from './model.ts'

export async function allPages<T extends { id: string }>(first: DetailPage<T>, read: (before: number) => Promise<DetailPage<T>>): Promise<T[]> {
  const items: T[] = [], seen = new Set<string>(), cursors = new Set<number>()
  let page = first, bytes = 0
  for (let count = 0; ; count++) {
    requireThat(count < 100 && items.length + page.items.length <= 2000, 'size', 'Bug 评论或附件超出完整收集上限，未截断发送。')
    bytes += Buffer.byteLength(JSON.stringify(page))
    requireThat(bytes <= 1024 * 1024, 'size', '评论或附件总内容超过收集预算，未截断发送。')
    for (const item of page.items) {
      // Inclusive timestamp cursors may repeat a boundary item; only identical records are safe.
      const previous = items.find(x => x.id === item.id)
      if (seen.has(item.id)) requireThat(JSON.stringify(previous) === JSON.stringify(item), 'stale', '分页期间内容变化，请重试。')
      else { seen.add(item.id); items.push(item) }
    }
    if (page.nextMax === null) return items
    requireThat(!cursors.has(page.nextMax) && (cursors.size === 0 || page.nextMax < Math.min(...cursors)), 'partial', '详情分页未推进，未发送。')
    cursors.add(page.nextMax)
    page = await read(page.nextMax)
  }
}
export type CompleteBug = Omit<BugDetail, 'comments' | 'attachments'> & { comments: Discussion[]; attachments: Attachment[] }
export function mediaIds(bug: CompleteBug): string[] {
  const ids = new Set<string>()
  for (const blocks of [bug.content, ...bug.comments.map(c => c.content)])
    for (const b of blocks) {
      if (b.kind === 'media') ids.add(b.resourceId)
      else requireThat(!b.text.includes('[此媒体缺少受控资源标识'), 'media', 'Bug 包含无法读取的媒体，未发送不完整内容。')
    }
  for (const attachment of bug.attachments) {
    requireThat(/^(image|video)\//.test(attachment.mime), 'media', 'Bug 含暂不支持传递的附件，未发送不完整内容；请在原单查看。')
    ids.add(attachment.id)
  }
  requireThat(ids.size <= 100, 'size', 'Bug 媒体数量超出上限，未截断发送。')
  return [...ids]
}
export function repairPrompt(bug: CompleteBug, files: Map<string, string>): string {
  const render = (blocks: BugContent[]) => blocks.map(b => {
    if (b.kind === 'text') return b.text
    const file = files.get(b.resourceId)
    requireThat(file, 'media', '媒体未完整保存，未发送。')
    return `${b.mediaType === 'image' ? '图片' : '视频'}：${b.label}\n本地文件：${JSON.stringify(file)}`
  }).join('\n')
  const body = [
    `#${bug.task.number} ${bug.task.name}`, `项目：${bug.task.project.name}`, '描述：', render(bug.content),
    '评论（按原单分页顺序）：', ...bug.comments.map(c => `${c.author} · ${new Date(c.sentAt / 1000).toISOString()}\n${render(c.content)}`),
    '附件：', ...bug.attachments.map(a => {
      const file = files.get(a.id)
      requireThat(file, 'media', '附件未完整保存，未发送。')
      return `${a.name}\n本地文件：${JSON.stringify(file)}`
    })
  ].join('\n')
  const prompt = `排查并修复以下内容\n《${body}》`
  requireThat(!prompt.includes('\0') && Buffer.byteLength(prompt) <= 48000, 'size', 'Bug 内容超过 CLI 消息预算或包含无效字符，未截断发送。')
  return prompt
}
