import { record, requireThat } from './model.ts'

/// 新报告明确区分代码进度、验收和交付，不从自然语言猜测完成状态。
export type StructuredRepairReport = {
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
/// 已接受的历史回执只读保留，不补造结构化结论。
export type LegacyRepairReport = { outcome: 'passed' | 'failed' | 'blocked'; summary: string; sourceIdentity: string; evidence: string[] }
export type RepairReport = StructuredRepairReport | LegacyRepairReport
/// 只接受明确的新版本；已存历史报告由读取路径保留，不重新接纳旧协议。
export function parseRepairReport(input: unknown): StructuredRepairReport {
  const value = record(input)
  const exact = (object: Record<string, unknown>, keys: string[]) => requireThat(Object.keys(object).sort().join(',') === keys.sort().join(','), 'receipt', '回执字段不符合协议。')
  const string = (value: unknown) => { requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 4000, 'receipt', '四项说明、源码身份和原因不能为空或超长。'); return value as string }
  const strings = (value: unknown) => { requireThat(Array.isArray(value) && value.length <= 20, 'receipt', '回执证据或未完成项超限。'); return (value as unknown[]).map(string) }
  exact(value,['reportVersion','reportSequence','rootCause','solution','impact','repair','validation','delivery','sourceIdentity'])
  requireThat(value.reportVersion === 2 && Number.isSafeInteger(value.reportSequence) && Number(value.reportSequence) > 0, 'receipt', '新回执必须包含结构化版本及正整数报告序号。')
  const repair = record(value.repair), validation = record(value.validation), delivery = record(value.delivery)
  exact(repair,['state','workspace'])
  exact(validation,['status','reason','remaining','evidence'])
  exact(delivery,['state','note'])
  requireThat(['investigating','fixed','blocked'].includes(String(repair.state)) && ['isolated_worktree','main_workspace'].includes(String(repair.workspace)), 'receipt', '修复进度或工作区不符合协议。')
  requireThat(['passed','failed','not_run'].includes(String(validation.status)) && ['uncommitted','committed','merged','released'].includes(String(delivery.state)), 'receipt', '验证或交付状态不符合协议。')
  const remaining = strings(validation.remaining), evidence = strings(validation.evidence)
  requireThat(validation.status !== 'passed' || (evidence.length > 0 && remaining.length === 0), 'receipt', '验证通过必须包含证据且没有未完成验收。')
  return { reportVersion:2,reportSequence:value.reportSequence as number,rootCause:string(value.rootCause),solution:string(value.solution),impact:string(value.impact),sourceIdentity:string(value.sourceIdentity),repair:repair as StructuredRepairReport['repair'],validation:{status:validation.status as StructuredRepairReport['validation']['status'],reason:string(validation.reason),remaining,evidence},delivery:{state:delivery.state as StructuredRepairReport['delivery']['state'],note:string(delivery.note)} }
}
/// 已修复闸读取权威报告，编辑评论不能改变本结论。
export function repairCompletionBlocker(report: RepairReport | undefined): string {
  if (!report || !('reportVersion' in report)) return '缺少结构化修复与验证回执，不能更新为已修复。'
  if (report.repair.state !== 'fixed') return '代码修复尚未完成，不能更新为已修复。'
  if (report.validation.status !== 'passed' || report.validation.remaining.length) return `验收尚未完成：${report.validation.reason}`
  return ''
}
/// 列表只呈现明确字段，历史摘要不用于推断工作区或完成维度。
export function repairProgress(report: RepairReport | undefined): string {
  if (!report) return '已发起 · 等待修复回执'
  if (!('reportVersion' in report)) return '历史回执 · 进度待核实'
  if (report.repair.state === 'fixed') return report.repair.workspace === 'isolated_worktree' ? '已在隔离 Worktree 修复' : '代码修复已完成'
  return report.repair.state === 'blocked' ? '代码修复受阻' : '正在排查修复'
}
/// 四项结构化内容自动填充评论；交付和未完成项始终保留供人工编辑。
export function repairComment(report: RepairReport | undefined): string {
  if (!report || !('reportVersion' in report)) return report ? `历史回执（未结构化，不能据此证明完成）\n${report.summary}` : ''
  const labels = {passed:'通过',failed:'失败',not_run:'未完成 / 未运行'}
  return `说明来源：Agent 结构化回执，非插件独立验收。\n\n根本原因\n${report.rootCause}\n\n解决方法\n${report.solution}\n\n影响范围\n${report.impact}\n\n验证结果\n${labels[report.validation.status]}：${report.validation.reason}\n未完成项：${report.validation.remaining.join('；') || '无报告未完成项'}\n\n交付情况\n${report.delivery.state}：${report.delivery.note}`
}
