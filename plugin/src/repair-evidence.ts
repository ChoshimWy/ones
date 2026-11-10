import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { record, requireThat } from './domain/model.ts'
import { isNotApplicable, type RepairReport, type UnitTestCounts } from './domain/repair-report.ts'

/// 当前受管安装的 product_root/data/apple；只能由 Worker 构造时注入测试目录，panel/回执不能改根。
export const managedAppleEvidenceRoot = join(homedir(), '.oxhorse-worker', 'data', 'apple')
/// 受管历史证据的只读投影，不是 Apple final gate，也不声称新 HEAD 已重新验证。
export class RepairEvidence {
  /// root 来源于受管安装或测试依赖注入；不接受外部 Bug/Agent 提供的根路径。
  constructor(private root = managedAppleEvidenceRoot) {}
  /// 固定文件无链接、同 UID、不可被其它用户写、有限大小；读取前后核对目录与文件身份。
  private async read(run: string, name: string): Promise<string> {
    const directory = join(this.root,run), path = join(directory,name)
    const parents = [this.root,directory]
    const prior = await Promise.all(parents.map(async parent => {
      const st = await lstat(parent)
      requireThat(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() && (st.mode & 0o022) === 0 && await realpath(parent) === resolve(parent), 'evidence', '证据目录不可安全读取。')
      return st
    }))
    const handle = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const st = await handle.stat()
      requireThat(st.isFile() && st.nlink === 1 && st.uid === process.getuid?.() && (st.mode & 0o022) === 0 && st.size > 0 && st.size <= 2 * 1024 * 1024, 'evidence', '证据文件类型、权限或大小无效。')
      // 固定上限读取，文件增长也不能造成无界内存读取。
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1)
      let length = 0
      while (length < buffer.length) {
        const chunk = await handle.read(buffer,length,buffer.length-length,length)
        if (!chunk.bytesRead) break
        length += chunk.bytesRead
      }
      const after = await handle.stat(), current = await lstat(path)
      requireThat(length === st.size && after.size === st.size && after.mtimeMs === st.mtimeMs && current.ino === st.ino && current.dev === st.dev && !current.isSymbolicLink(), 'evidence', '读取时证据已变化。')
      for (let i=0;i<parents.length;i++) {
        const now = await lstat(parents[i]!)
        requireThat(!now.isSymbolicLink() && now.ino === prior[i]!.ino && now.dev === prior[i]!.dev && await realpath(parents[i]!) === resolve(parents[i]!), 'evidence', '读取时证据目录已变化。')
      }
      return buffer.subarray(0,length).toString('utf8')
    } finally { await handle.close() }
  }
  /// 仅跟随 evidence 数组明确列出的唯一固定文件配对；不解析自然语言的通过数量。
  async project(report: RepairReport | undefined): Promise<RepairReport | undefined> {
    if (!report) return report
    const original = {...report}
    delete original.acceptanceEvidence
    const explicit = 'reportVersion' in original ? original.validation.evidence : original.evidence
    const references = explicit.filter(value => value.includes('/data/apple/') || value.endsWith('/evidence.json') || value.endsWith('/test-summary.json'))
    if (!references.length) return original
    const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    try {
      // 1. 多个 run、相对路径、遍历和不完整配对均拒绝，绝不从多个结果中挑成功。
      const paths = references.filter(value=>value.startsWith('/'))
      const parsed = paths.map(value => {
        const relative = value.slice(this.root.length+1)
        requireThat(value.startsWith(this.root+'/') && /^[0-9]{20}\/(evidence\.json|test-summary\.json|result\.xcresult)$/.test(relative), 'evidence', '证据路径不属于受管固定产物。')
        return relative.split('/')
      })
      const runs = new Set(parsed.map(parts=>parts[0]))
      requireThat(runs.size === 1 && new Set(paths).size === paths.length, 'evidence', '证据引用重复或存在多个运行，需人工核对。')
      const run = [...runs][0]!
      requireThat(parsed.some(parts=>parts[1]==='evidence.json') && parsed.some(parts=>parts[1]==='test-summary.json'), 'evidence', '缺少受管证据配对。')
      const raw = await this.read(run,'evidence.json'), summaryRaw = await this.read(run,'test-summary.json')
      const evidence = record(JSON.parse(raw)), summary = record(JSON.parse(summaryRaw))
      // 2. 仅接受真实 selected-test、稳定源码与完整成功收口；build-only/失败不能投影为通过。
      const source = record(evidence.before).source
      requireThat(typeof source === 'string' && /^[a-f0-9]{64}$/.test(source) && record(evidence.after).source === source, 'evidence', '测试输入身份不稳定。')
      const declared = [...original.sourceIdentity.matchAll(/\bApple source\s+([a-f0-9]{64})\b/g)].map(match=>match[1])
      requireThat(declared.length === 1 && declared[0] === source, 'evidence', '回执没有唯一明确绑定此 Apple 测试源码身份。')
      requireThat(evidence.version === '0.1.0' && evidence.synthetic === false && evidence.stage === 'complete' && evidence.verification_mode === 'strict' && evidence.inputs_stable === true && evidence.cleanup_known === true && evidence.passed === true && evidence.exit_code === 0 && record(evidence.request).action === 'selected-test' && evidence.bundle === join(this.root,run,'result.xcresult'), 'evidence', '受管证据不是完整成功的真实定向测试。')
      const counts = ['passedTests','failedTests','skippedTests','expectedFailures','totalTestCount']
      requireThat(counts.every(key=>Number.isSafeInteger(summary[key]) && Number(summary[key])>=0), 'evidence', '测试统计不完整。')
      const total = Number(summary.totalTestCount), passed = Number(summary.passedTests)
      requireThat(total > 0 && passed === total && summary.failedTests === 0 && summary.skippedTests === 0 && summary.expectedFailures === 0 && summary.result === 'Passed', 'evidence', '存在失败、跳过或零测试，不能确认通过。')
      const actual = evidence.actual_tests
      requireThat(Array.isArray(actual) && actual.length === total && actual.every(value=>typeof value === 'string' && /^[^/]+\/[^/]+\/[^/]+$/.test(value)) && new Set(actual).size === total, 'evidence', '实际执行测试与统计不一致。')
      const requested = record(evidence.request).only_testing
      requireThat(Array.isArray(requested) && requested.length > 0 && requested.every(selector=>typeof selector === 'string' && actual.some(test=>test === selector || test.startsWith(selector+'/'))) && actual.every(test=>requested.some(selector=>test === selector || test.startsWith(selector+'/'))), 'evidence', '测试选择与实际执行不一致。')
      const tests: UnitTestCounts = {status:'passed',passed,total,failed:0,skipped:0,notRun:0}
      if ('reportVersion' in original && original.reportVersion === 3) {
        const claimed = original.validation.unitTests
        requireThat(!isNotApplicable(claimed) && Object.keys(tests).every(key=>claimed[key as keyof UnitTestCounts] === tests[key as keyof UnitTestCounts]), 'evidence', '回执与实际测试统计不一致。')
      }
      // 3. 内容摘要并入临时回执，既有完成预览/逐步重读自然检测证据变化，不持久改写原报告。
      return {...original,acceptanceEvidence:{state:'verified',counts:tests,run,source,fingerprint:fingerprint([original.sourceIdentity,raw,summaryRaw]),note:'受管历史测试证据；仅对应回执明确引用的 Apple source（可为交付前身份），不表示合并后的 HEAD 已重新测试。'}}
    } catch {
      return {...original,acceptanceEvidence:{state:'pending',fingerprint:fingerprint(references),note:'测试证据路径、来源绑定、统计或文件状态待核对；未改写原始回执。'}}
    }
  }
}
