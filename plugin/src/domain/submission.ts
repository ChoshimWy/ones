import { createHash, randomUUID } from 'node:crypto'
import { id, record, requireThat, text, validDate, type Worklog } from './model.ts'

export type WriteIntent = { scope: string; date: string; task: string; owner: string; hours: number; startTime: number; description: string }
export type IntentProof = Omit<WriteIntent, 'description'> & { descriptionHash: string }
export type Receipt = {
  id: string
  fingerprint: string
  scope: string
  kind: 'add' | 'describe'
  state: 'submitting' | 'unknown' | 'verified'
  intent: IntentProof
  beforeKeys: string[]
  protectedDayHash?: string
  key?: string
}
export interface Ledger { load(): Promise<Receipt[]>; save(rows: Receipt[]): Promise<void> }
export interface Writer { add(intent: WriteIntent): Promise<string>; get(key: string): Promise<Worklog> }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function createReceipt(intent: WriteIntent, fingerprint: string, before: Worklog[]): Receipt {
  const { description, ...fields } = intent
  return {
    id: randomUUID(), fingerprint, scope: intent.scope, kind: 'add', state: 'submitting',
    intent: { ...fields, descriptionHash: hash(description) },
    beforeKeys: before.map(row => row.key)
  }
}
export function parseReceipts(raw: unknown): Receipt[] {
  requireThat(raw === null || Array.isArray(raw), 'ledger', '本地操作记录损坏，禁止写入。')
  const rows = (raw ?? []) as unknown[]
  requireThat(rows.length <= 1000, 'ledger', '本地操作记录超过上限。')
  for (const value of rows) {
    const row = record(value)
    text(row.id); text(row.scope); text(row.fingerprint)
    requireThat(['submitting', 'unknown', 'verified'].includes(String(row.state)) && ['add', 'describe'].includes(String(row.kind)), 'ledger', '操作记录状态损坏，禁止写入。')
    const intent = record(row.intent)
    validDate(intent.date); id(intent.task); id(intent.owner)
    requireThat(intent.scope === row.scope && Number.isSafeInteger(intent.hours) && Number(intent.hours) > 0 && Number.isSafeInteger(intent.startTime) && /^[a-f0-9]{64}$/.test(String(intent.descriptionHash)), 'ledger', '操作记录证据损坏，禁止写入。')
    requireThat(Array.isArray(row.beforeKeys) && row.beforeKeys.length <= 1000, 'ledger', '操作前快照损坏。')
    row.beforeKeys.forEach(key => text(key, 150))
    if (row.key !== undefined) text(row.key, 150)
    if (row.state === 'verified') text(row.key, 150)
    if (row.kind === 'describe') {
      text(row.key, 150)
      requireThat(/^[a-f0-9]{64}$/.test(String(row.protectedDayHash)), 'ledger', '描述更新保护证据损坏。')
    }
  }
  requireThat(new Set(rows.map(value => record(value).id)).size === rows.length, 'ledger', '本地操作身份重复。')
  return rows as Receipt[]
}
export function assertNoPending(rows: Receipt[], scope: string): void {
  requireThat(!rows.some(row => row.scope === scope && row.state !== 'verified'), 'unknown', '该账号存在未核实提交，禁止再次写入。')
}
// One coordinator per worker. No cross-process or server-side transaction guarantee.
export class Submission {
  private busy = false
  constructor(private ledger: Ledger, private writer: Writer) {}
  async add(intent: WriteIntent, fingerprint: string, before: Worklog[]): Promise<Receipt> {
    requireThat(!this.busy, 'busy', '另一个提交仍在进行，请等待并核对结果。')
    this.busy = true
    try {
      const rows = await this.ledger.load()
      const previous = rows.find(row => row.fingerprint === fingerprint && row.scope === intent.scope)
      if (previous?.state === 'verified') return previous
      assertNoPending(rows, intent.scope)
      requireThat(rows.length < 1000, 'ledger', '操作记录已达到上限，请先核对归档；未发起写入。')
      const receipt = createReceipt(intent, fingerprint, before)
      rows.push(receipt)
      await this.ledger.save(rows)
      try {
        receipt.key = await this.writer.add(intent)
        receipt.state = 'unknown'
        await this.ledger.save(rows)
        requireThat(!receipt.beforeKeys.includes(receipt.key), 'readback', '新增工时返回了已有记录，需要核实；不可重试。')
        const actual = await this.writer.get(receipt.key)
        requireThat(actual.key === receipt.key, 'readback', '工时回读 key 与新增结果不一致，需要核实。')
        assertWorklog(actual, intent)
        receipt.state = 'verified'
        await this.ledger.save(rows)
        return structuredClone(receipt)
      } catch {
        receipt.state = 'unknown'
        await this.ledger.save(rows).catch(() => {})
        throw new Error('submission outcome must be reconciled')
      }
    } finally { this.busy = false }
  }
}
export function assertWorklog(row: Worklog, expected: WriteIntent): void {
  requireThat(row.owner === expected.owner && row.task === expected.task && row.hours === expected.hours && row.startTime === expected.startTime && row.description === expected.description && row.type === 'recorded', 'readback', '工时回读与提交意图不一致，需要人工核实。')
}
