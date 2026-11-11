import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { evidenceFixture } from './fixtures/repair-evidence.ts'
import { RepairCache } from '../src/repair-cache.ts'
import { managedEvidenceFiles, supplementalEvidenceFiles } from '../src/domain/managed-evidence.ts'
import { repairInstructions } from '../src/domain/repair-content.ts'
import { parseRepairReport, repairCompletionBlocker, repairValidationSummary } from '../src/domain/repair-report.ts'

const counts = {status:'passed',passed:1,failed:0,skipped:0,notRun:0,total:1}
async function fixture() {
  const f = await evidenceFixture()
  f.evidence.actual_tests = ['Tests/Unit/test1']
  f.evidence.request.only_testing = ['Tests/Unit/test1']
  f.summary.passedTests = f.summary.totalTestCount = 1
  await f.save()
  const report = parseRepairReport({...f.report,reportVersion:3,sourceIdentity:'HEAD fixture; final_source_digest='+f.evidence.before.source,
    validation:{...f.report.validation,evidence:[],unitTests:counts,managedEvidence:{kind:'apple_selected_test',runId:f.run,sourceDigest:f.evidence.before.source}}})
  return {...f,report}
}

test('evidence contract: generated instructions to cache and projection use structured binding, not prose',async()=>{
  const f=await fixture(),cache=new RepairCache(join(f.root,'cache'),f.projector)
  try {
    const directory=join(f.root,'receipt');await mkdir(directory,{mode:0o700})
    const task={id:'task',number:1,name:'虚构任务',project:{id:'p',name:'项目'},issueType:{id:'bug',name:'缺陷'},status:{id:'open',name:'待处理'}}
    const contract=await cache.register('scope',task,{state:'sent',projectId:'p',projectName:'项目',createdAt:1},'revision',directory)
    const instructions=repairInstructions(contract)
    const template=JSON.parse(instructions.split('字段须严格为：')[1]!.split('\n')[0]!)
    const {runId,revision,token,...payload}=template
    assert.doesNotThrow(()=>parseRepairReport(payload))
    assert.ok(instructions.includes('validation.managedEvidence'))
    for(const name of [...managedEvidenceFiles,...supplementalEvidenceFiles]) assert.ok(instructions.includes(name))
    assert.ok(instructions.includes('回执已写入，插件接纳与证据核验待确认'))
    const write=async(report:unknown)=>{await writeFile(contract.resultFile,JSON.stringify({runId,revision,token,...report as object}),{mode:0o600});await cache.consume('scope',()=>{})}
    await write({...payload,...f.report,validation:{...f.report.validation,evidence:[join(f.directory,'tests.json')]}})
    let row=(await cache.read('scope')).items[0]!
    assert.equal(row.reportError,undefined)
    assert.equal(repairValidationSummary(row.report),'验收状态：1/1项验证已通过')
    assert.equal(repairCompletionBlocker(row.report),'')
    assert.deepEqual((await f.projector.project(row.report))?.acceptanceEvidence?.counts,counts)
    // 新报告缺少绑定，拒收原因可见且保留先前有效序号。
    const {managedEvidence,...validation}=f.report.validation
    await write({...f.report,reportSequence:3,validation:{...validation,evidence:[join(f.directory,'evidence.json')]}})
    row=(await cache.read('scope')).items[0]!
    assert.match(row.reportError!,/validation.managedEvidence/)
    assert.match(row.reportError!,/本次报告尚未生效/)
    assert.equal(row.report && 'reportSequence' in row.report && row.report.reportSequence,2)
    await write({...f.report,reportSequence:3})
    assert.equal((await cache.read('scope')).items[0]!.reportError,undefined)
    await write({...f.report,reportSequence:3}) // 幂等
    assert.equal((await cache.read('scope')).items[0]!.reportError,undefined)
    await write({...f.report,reportSequence:3,solution:'不同内容'})
    assert.ok((await cache.read('scope')).items[0]!.reportError)
    await write(f.report) // 旧序号
    assert.ok((await cache.read('scope')).items[0]!.reportError)
  } finally {cache.close();await f.close()}
})

test('evidence contract: missing malformed and N/A binding rejected before acceptance',async()=>{
  const f=await fixture()
  try {
    for(const managedEvidence of [null,{}, {...f.report.validation.managedEvidence,runId:'../outside'}, {...f.report.validation.managedEvidence,sourceDigest:'HEAD'}, {...f.report.validation.managedEvidence,root:'/foreign'}]) {
      assert.throws(()=>parseRepairReport({...f.report,validation:{...f.report.validation,managedEvidence}}),/受管任务与测试源码身份/)
    }
    assert.throws(()=>parseRepairReport({...f.report,validation:{...f.report.validation,unitTests:{applicability:'not_applicable',reason:'文案',checks:[]}}}),/受管任务与测试源码身份/)
    // 注入的通过投影不会成为回执字段。
    assert.throws(()=>parseRepairReport({...f.report,acceptanceEvidence:{state:'verified'}}))
  } finally {await f.close()}
})

test('evidence contract: unreadable evidence recovers; source counts selection and execution failures stay pending',async()=>{
  const f=await fixture()
  const expect=async(reason:string,report=f.report)=>{
    const projected=await f.projector.project(report)
    assert.equal(projected?.acceptanceEvidence?.reasonCode,reason)
    assert.equal(repairValidationSummary(projected),'验收状态：测试证据待核对')
    assert.ok(repairCompletionBlocker(projected))
  }
  try {
    await rm(join(f.directory,'test-summary.json'));await expect('unreadable')
    await f.save()
    assert.equal((await f.projector.project(f.report))?.acceptanceEvidence?.state,'verified')
    await expect('source',{...f.report,validation:{...f.report.validation,managedEvidence:{...f.report.validation.managedEvidence!,sourceDigest:'b'.repeat(64)}}})
    await expect('references',{...f.report,validation:{...f.report.validation,evidence:[join(f.apple,'00000000000000000002','evidence.json')]}})
    for(const patch of [{passedTests:0,totalTestCount:0},{passedTests:0,failedTests:1,result:'Failed'},{passedTests:0,skippedTests:1},{totalTestCount:2}]) {
      await writeFile(join(f.directory,'test-summary.json'),JSON.stringify({...f.summary,...patch}),{mode:0o600});await expect('counts')
    }
    await f.save()
    await expect('counts',{...f.report,validation:{...f.report.validation,unitTests:{...counts,status:'passed',passed:2,total:2}}})
    for(const patch of [{synthetic:true},{passed:false},{request:{action:'build'}}]) {
      await writeFile(join(f.directory,'evidence.json'),JSON.stringify({...f.evidence,...patch}),{mode:0o600});await expect('execution')
    }
    await writeFile(join(f.directory,'evidence.json'),JSON.stringify({...f.evidence,actual_tests:['Tests/Unit/other']}),{mode:0o600});await expect('selection')
    await writeFile(join(f.directory,'evidence.json'),'not json secret',{mode:0o600});await expect('malformed')
    assert.ok(!(await f.projector.project(f.report))?.acceptanceEvidence?.note.includes('secret'))
  } finally {await f.close()}
})

test('evidence contract: accepted old v3 stays read-only; higher sequence binding repairs pending evidence',async()=>{
  const {DatabaseSync}=await import('node:sqlite')
  const f=await fixture(),cache=new RepairCache(join(f.root,'cache'),f.projector)
  try {
    const directory=join(f.root,'receipt');await mkdir(directory,{mode:0o700})
    const task={id:'task',number:1,name:'虚构任务',project:{id:'p',name:'项目'},issueType:{id:'bug',name:'缺陷'},status:{id:'open',name:'待处理'}}
    const {resultFile,...binding}=await cache.register('scope',task,{state:'sent',projectId:'p',projectName:'项目',createdAt:1},'revision',directory)
    const {managedEvidence,...validation}=f.report.validation
    const old={...f.report,validation:{...validation,evidence:[join(f.directory,'evidence.json'),join(f.directory,'test-summary.json')]}}
    cache.close()
    const db=new DatabaseSync(join(f.root,'cache','cache.sqlite'))
    db.prepare('UPDATE repairs SET report=?').run(JSON.stringify(old));db.close()
    await writeFile(resultFile,JSON.stringify({...binding,...old}),{mode:0o600})
    await cache.consume('scope',()=>{})
    const row=(await cache.read('scope')).items[0]!
    assert.equal(row.reportError,undefined)
    assert.deepEqual(row.report,old)
    assert.equal((await f.projector.project(row.report))?.acceptanceEvidence?.reasonCode,'binding')
    await writeFile(resultFile,JSON.stringify({...binding,...f.report,reportSequence:3}),{mode:0o600})
    await cache.consume('scope',()=>{})
    const updated=(await cache.read('scope')).items[0]!
    assert.equal(updated.reportError,undefined)
    assert.equal(repairValidationSummary(await f.projector.project(updated.report)),'验收状态：1/1项验证已通过')
    cache.close()
    const read=new DatabaseSync(join(f.root,'cache','cache.sqlite'),{readOnly:true})
    assert.deepEqual(JSON.parse(String(read.prepare('SELECT report FROM report_history WHERE sequence=2').get()!.report)),old)
    read.close()
  }finally{cache.close();await f.close()}
})

test('evidence contract: supplemental tests file never replaces authoritative evidence or weakens reference checks',async()=>{
  const f=await fixture()
  const report={...f.report,validation:{...f.report.validation,evidence:[join(f.directory,'tests.json')]}}
  try {
    // Supplementary material is not opened or used as a pass/fail authority.
    await writeFile(join(f.directory,'tests.json'),'not authoritative JSON',{mode:0o600})
    const before=JSON.stringify(report)
    assert.equal((await f.projector.project(report))?.acceptanceEvidence?.state,'verified')
    assert.equal(JSON.stringify(report),before)
    await rm(join(f.directory,'tests.json'))
    assert.equal((await f.projector.project(report))?.acceptanceEvidence?.state,'verified')
    for(const extra of [
      join(f.directory,'tests.json'),
      join(f.apple,'00000000000000000002','tests.json'),
      '/foreign/data/apple/'+f.run+'/tests.json',
      f.directory+'/../'+f.run+'/tests.json',
      join(f.directory,'unknown.json'),
    ]) {
      const projected=await f.projector.project({...report,validation:{...report.validation,evidence:[...report.validation.evidence,extra]}})
      assert.equal(projected?.acceptanceEvidence?.reasonCode,'references')
      assert.ok(repairCompletionBlocker(projected))
    }
    await writeFile(join(f.directory,'test-summary.json'),JSON.stringify({...f.summary,passedTests:0,failedTests:1,result:'Failed'}),{mode:0o600})
    assert.equal((await f.projector.project(report))?.acceptanceEvidence?.reasonCode,'counts')
    await f.save()
    await rm(join(f.directory,'test-summary.json'))
    assert.equal((await f.projector.project(report))?.acceptanceEvidence?.reasonCode,'unreadable')
    // Legacy reports still need the authoritative pair, not just a supplementary file.
    const legacy={...report,reportVersion:2 as const}
    assert.equal((await f.projector.project(legacy))?.acceptanceEvidence?.reasonCode,'references')
  } finally {await f.close()}
})
