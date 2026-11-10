import { managedEvidenceReferences, parseManagedEvidence, requireEvidence, type ManagedEvidence, type EvidenceReason } from './managed-evidence.ts'
import { record, requireThat } from './model.ts'

/// 已接受的 v2 报告保留原字段，但不从整体验证状态推断单元测试结果。
export type PreviousRepairReport = {
  reportVersion: 2
  reportSequence: number
  rootCause: string
  solution: string
  impact: string
  repair: { state: 'investigating' | 'fixed' | 'blocked'; workspace: 'isolated_worktree' | 'main_workspace' }
  validation: { status: 'passed' | 'failed' | 'not_run'; reason: string; remaining: string[]; evidence: string[] }
  delivery: { state: 'uncommitted' | 'committed' | 'merged' | 'released'; note: string }
  sourceIdentity: string
}
/// 单元测试计数直接来自 runner；未运行与跳过分开，不能由文字或证据条数推断。
export type UnitTestCounts = { status: 'passed' | 'failed' | 'not_run'; passed: number; failed: number; skipped: number; notRun: number; total: number }
/// 不适用必须说明范围原因并提供实际替代检查，不能把未运行测试自动当作不适用。
export type NotApplicableTests = { applicability: 'not_applicable'; reason: string; checks: { name: string; status: 'passed' | 'failed' | 'not_run'; evidence: string[] }[] }
export type UnitTestResult = UnitTestCounts | NotApplicableTests
/// 只由插件读受管文件生成的临时投影；不写回原始回执或接纳 Agent 注入。
export type AcceptanceEvidence = { state: 'verified' | 'pending'; fingerprint: string; note: string; reasonCode?: EvidenceReason; counts?: UnitTestCounts; source?: string; run?: string }
/// 当前回执沿用原技术记录，新增明确单元测试统计作为唯一验收门槛。
export type StructuredRepairReport = Omit<PreviousRepairReport, 'reportVersion' | 'validation'> & {
  reportVersion: 3
  validation: PreviousRepairReport['validation'] & { unitTests: UnitTestResult; managedEvidence?: ManagedEvidence }
}
/// 已接受的历史回执只读保留，不补造结构化结论。
export type LegacyRepairReport = { outcome: 'passed' | 'failed' | 'blocked'; summary: string; sourceIdentity: string; evidence: string[] }
export type RepairReport = (StructuredRepairReport | PreviousRepairReport | LegacyRepairReport) & { acceptanceEvidence?: AcceptanceEvidence }
/// 只接受明确的新版本；已存历史报告由读取路径保留，不重新接纳旧协议。
export function parseRepairReport(input: unknown): StructuredRepairReport {
  const value = record(input)
  const exact = (object: Record<string, unknown>, keys: string[]) => requireThat(Object.keys(object).sort().join(',') === keys.sort().join(','), 'receipt', '回执字段不符合协议。')
  const string = (value: unknown) => { requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 4000, 'receipt', '修复说明、源码身份和验证原因不能为空或超长。'); return value as string }
  const strings = (value: unknown) => { requireThat(Array.isArray(value) && value.length <= 20, 'receipt', '回执证据或未完成项超限。'); return (value as unknown[]).map(string) }
  exact(value,['reportVersion','reportSequence','rootCause','solution','impact','repair','validation','delivery','sourceIdentity'])
  requireThat(value.reportVersion === 3 && Number.isSafeInteger(value.reportSequence) && Number(value.reportSequence) > 0, 'receipt', '新回执必须包含结构化版本及正整数报告序号。')
  const repair = record(value.repair), validation = record(value.validation), delivery = record(value.delivery)
  exact(repair,['state','workspace'])
  exact(validation,['status','reason','remaining','evidence','unitTests',...('managedEvidence' in validation ? ['managedEvidence'] : [])])
  exact(delivery,['state','note'])
  requireThat(['investigating','fixed','blocked'].includes(String(repair.state)) && ['isolated_worktree','main_workspace'].includes(String(repair.workspace)), 'receipt', '修复进度或工作区不符合协议。')
  requireThat(['passed','failed','not_run'].includes(String(validation.status)) && ['uncommitted','committed','merged','released'].includes(String(delivery.state)), 'receipt', '验证或交付状态不符合协议。')
  const remaining = strings(validation.remaining), evidence = strings(validation.evidence)
  const managedEvidence = 'managedEvidence' in validation ? parseManagedEvidence(validation.managedEvidence) : undefined
  requireEvidence(managedEvidence || managedEvidenceReferences(evidence).length === 0, 'binding')
  const unitTests = record(validation.unitTests)
  let tests: UnitTestResult
  if (unitTests.applicability === 'not_applicable') {
    requireEvidence(!managedEvidence, 'binding')
    exact(unitTests,['applicability','reason','checks'])
    requireThat(Array.isArray(unitTests.checks) && unitTests.checks.length > 0 && unitTests.checks.length <= 20, 'receipt', '无需单元测试也必须列出替代检查。')
    const checks = (unitTests.checks as unknown[]).map(input => {
      const check = record(input)
      exact(check,['name','status','evidence'])
      requireThat(['passed','failed','not_run'].includes(String(check.status)), 'receipt', '替代检查状态无效。')
      const evidence = strings(check.evidence)
      requireThat(check.status === 'not_run' || evidence.length > 0, 'receipt', '已执行替代检查必须提供证据。')
      return {name:string(check.name),status:check.status as NotApplicableTests['checks'][number]['status'],evidence}
    })
    requireThat(new Set(checks.map(check=>check.name)).size === checks.length, 'receipt', '替代检查不能重复计入。')
    tests = {applicability:'not_applicable',reason:string(unitTests.reason),checks}
  } else {
  exact(unitTests,['status','passed','failed','skipped','notRun','total'])
  const counts = ['passed','failed','skipped','notRun','total'] as const
  requireThat(counts.every(key => Number.isSafeInteger(unitTests[key]) && Number(unitTests[key]) >= 0), 'receipt', '单元测试计数必须为非负安全整数。')
  tests = unitTests as UnitTestCounts
  requireThat(tests.total === tests.passed + tests.failed + tests.skipped + tests.notRun, 'receipt', '单元测试总数与分类计数不一致。')
  const expectedStatus = tests.total > 0 && tests.passed === tests.total ? 'passed' : tests.failed > 0 ? 'failed' : 'not_run'
  requireThat(tests.status === expectedStatus, 'receipt', '单元测试状态与计数不一致，不能把跳过或未运行算作通过。')
  requireThat(tests.passed + tests.failed === 0 || evidence.length > 0 || managedEvidence, 'receipt', '已执行单元测试必须提供命令、结果及证据。')
  }
  return { reportVersion:3,reportSequence:value.reportSequence as number,rootCause:string(value.rootCause),solution:string(value.solution),impact:string(value.impact),sourceIdentity:string(value.sourceIdentity),repair:repair as StructuredRepairReport['repair'],validation:{status:validation.status as StructuredRepairReport['validation']['status'],reason:string(validation.reason),remaining,evidence,unitTests:tests,...(managedEvidence ? {managedEvidence} : {})},delivery:{state:delivery.state as StructuredRepairReport['delivery']['state'],note:string(delivery.note)} }
}
/// 临时证据投影优先；Agent 报告的原始字段不被覆盖。
export function repairAcceptance(report: RepairReport | undefined): UnitTestResult | undefined {
  if (report?.acceptanceEvidence) return report.acceptanceEvidence.state === 'verified' ? report.acceptanceEvidence.counts : undefined
  return report && 'reportVersion' in report && report.reportVersion === 3 ? report.validation.unitTests : undefined
}
/// 不适用是显式合同分支，不从零计数或自然语言推断。
export function isNotApplicable(tests: UnitTestResult | undefined): tests is NotApplicableTests {
  return !!tests && 'applicability' in tests && tests.applicability === 'not_applicable'
}
/// 不适用的替代检查必须全部实际通过，且仍需用户明确确认。
export function repairRequiresNAConfirmation(report: RepairReport | undefined): boolean { return isNotApplicable(repairAcceptance(report)) }
/// 统一短验收描述；证据不可读取不等于没有测试结果。
export function repairValidationSummary(report: RepairReport | undefined): string {
  if (report?.acceptanceEvidence?.state === 'pending') return '验收状态：测试证据待核对'
  const tests = repairAcceptance(report)
  if (isNotApplicable(tests)) return `验收状态：无需单元测试，检查${tests.checks.length > 0 && tests.checks.every(check=>check.status === 'passed' && check.evidence.length > 0) ? '已完成' : '未完成'}`
  if (!tests || tests.total === 0) return '验收状态：暂无单元测试结果'
  return `验收状态：${tests.passed}/${tests.total}项验证已通过`
}
/// 已修复闸读取明确测试或替代检查；硬件/截图/人工剩余项不阻断。
export function repairCompletionBlocker(report: RepairReport | undefined): string {
  if (!report || !('reportVersion' in report)) return repairValidationSummary(report)
  if (report.repair.state !== 'fixed') return '代码修复尚未完成，不能更新为已修复。'
  const tests = repairAcceptance(report)
  if (isNotApplicable(tests)) return tests.reason.trim() && tests.checks.length > 0 && tests.checks.every(check=>check.status === 'passed' && check.evidence.length > 0) ? '' : repairValidationSummary(report)
  if (!tests || tests.status !== 'passed' || !Number.isSafeInteger(tests.total) || tests.total <= 0 || tests.passed !== tests.total || tests.failed !== 0 || tests.skipped !== 0 || tests.notRun !== 0) return repairValidationSummary(report)
  return ''
}
/// 列表只呈现明确字段，历史摘要不用于推断工作区或完成维度。
export function repairProgress(report: RepairReport | undefined): string {
  if (!report) return '已发起 · 等待修复回执'
  if (!('reportVersion' in report)) return '历史回执 · 进度待核实'
  if (report.repair.state === 'fixed') return report.repair.workspace === 'isolated_worktree' ? '已在隔离 Worktree 修复' : '代码修复已完成'
  return report.repair.state === 'blocked' ? '代码修复受阻' : '正在排查修复'
}
/// 评论展示三项分段说明：标题独占一行，内容次行，项间空一行；不截断或改写内容。
export function repairComment(report: RepairReport | undefined): string {
  // 无结构化字段时不能编造三项；原始历史回执仍在详情中保留。
  if (!report || !('reportVersion' in report)) return ''
  const line = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()
  return `根本原因：\n${line(report.rootCause)}\n\n解决方法：\n${line(report.solution)}\n\n影响范围：\n${line(report.impact)}`
}
