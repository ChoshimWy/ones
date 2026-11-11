import { requireThat } from './model.ts'

/// 只描述受管任务与测试输入；不能由回执指定读取根目录或判定通过。
export type ManagedEvidence = { kind: 'apple_selected_test'; runId: string; sourceDigest: string }
export const managedEvidenceExample: ManagedEvidence = { kind:'apple_selected_test',runId:'00000000000000000001',sourceDigest:'a'.repeat(64) }
// Fixed authoritative files and optional supplementary references share one contract.
// Supplementary contents are never opened or used to establish acceptance.
export const managedEvidenceFiles: readonly string[] = ['evidence.json','test-summary.json','result.xcresult']
export const supplementalEvidenceFiles: readonly string[] = ['tests.json']
export const evidenceReasons = {
  binding: '未提供有效的受管任务与测试源码身份，请填写 validation.managedEvidence。',
  references: '证据引用不完整、重复、跨任务或不属于受管目录。',
  unreadable: '受管证据文件不可安全读取，请检查文件是否存在、权限及是否正在变化。',
  malformed: '受管证据文件格式无效。',
  source: '回执与测试源码身份不一致，或测试前后源码发生变化。',
  execution: '受管任务不是完整成功的真实定向测试。',
  counts: '实际测试统计不完整、未全部通过或与回执不一致。',
  selection: '实际执行测试与选择范围或统计数量不一致。',
} as const
export type EvidenceReason = keyof typeof evidenceReasons
export function requireEvidence(condition: unknown, reason: EvidenceReason): asserts condition {
  requireThat(condition, `evidence_${reason}`, evidenceReasons[reason])
}
export function managedEvidenceReferences(values: string[]): string[] {
  return values.filter(value => value.includes('/data/apple/') || value.endsWith('/evidence.json') || value.endsWith('/test-summary.json'))
}
export function parseManagedEvidence(value: unknown): ManagedEvidence {
  requireEvidence(!!value && typeof value === 'object' && !Array.isArray(value), 'binding')
  const input = value as Record<string, unknown>
  requireEvidence(Object.keys(input).sort().join(',') === 'kind,runId,sourceDigest'
    && input.kind === 'apple_selected_test'
    && typeof input.runId === 'string' && /^[0-9]{20}$/.test(input.runId)
    && typeof input.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(input.sourceDigest), 'binding')
  return {kind:'apple_selected_test',runId:input.runId as string,sourceDigest:input.sourceDigest as string}
}
