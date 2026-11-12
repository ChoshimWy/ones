import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, link, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPrivatePath, syncDirectory } from './private-files.ts'
import { record, requireThat } from './domain/model.ts'
import type { RepairRecord } from './repair.ts'

export const attemptKey = (value: RepairRecord) => value.attemptId ??
  createHash('sha256').update(JSON.stringify([value.createdAt,value.projectId,value.sessionId,value.handle,value.directory])).digest('hex')
export type JournalEntry = { file: string; record: RepairRecord }

/** The root and exclusive successor files are one append-only launch journal.
 * A parent is never deleted to unlock a retry. A partial/unknown record fails closed.
 */
export class RepairJournal {
  constructor(private root: string) {}
  async entries(key: string): Promise<JournalEntry[]> {
    const entries: JournalEntry[] = []
    let file = join(this.root, key + '.json')
    for (let depth = 0; depth < 100; depth++) {
      try {
        await assertPrivatePath(file, 'file', '修复启动记录权限不安全。')
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        let value
        try {
          const st = await handle.stat()
          requireThat(st.isFile() && st.nlink === 1 && st.size <= 16000, 'storage', '修复启动记录过大。')
          value = record(JSON.parse(await handle.readFile('utf8')))
        } finally { await handle.close() }
        requireThat(['sent','unknown','terminal'].includes(String(value.state)) &&
          typeof value.projectId === 'string' && typeof value.projectName === 'string' &&
          typeof value.createdAt === 'number' &&
          (value.phase === undefined || ['preparing','launching','settled','failed'].includes(String(value.phase))) &&
          (value.attemptId === undefined || typeof value.attemptId === 'string' && /^[a-f0-9-]{36}$/.test(value.attemptId)),
          'storage', '修复启动记录损坏，需人工核实。')
        const receipt = value as RepairRecord
        entries.push({ file, record: receipt })
        file = this.nextFile(key, receipt)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries
        throw error
      }
    }
    throw Error('Repair attempt history limit reached')
  }
  nextFile(key: string, parent: RepairRecord) {
    return join(this.root, key + '.' + attemptKey(parent) + '.next.json')
  }
  /** Publish complete bytes atomically and exclusively; a crash cannot publish an empty claim. */
  async claim(file: string, receipt: RepairRecord): Promise<void> {
    const temp = join(this.root, '.claim-' + randomUUID())
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(receipt))
      await handle.sync()
    } finally { await handle.close() }
    try { await link(temp, file) } finally { await rm(temp, { force: true }) }
    await syncDirectory(this.root)
  }
}
