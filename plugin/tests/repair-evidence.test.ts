import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepairEvidence } from '../src/repair-evidence.ts'
import { parseRepairReport, repairCompletionBlocker, repairValidationSummary, type PreviousRepairReport } from '../src/domain/repair-report.ts'

import { evidenceFixture } from './fixtures/repair-evidence.ts'
test('acceptance evidence: legacy structured artifacts project 3/3 without rewriting original or sequence',async()=>{
  const f=await evidenceFixture()
  try{
    const original=JSON.stringify(f.report),projected=await f.projector.project(f.report)
    assert.equal(repairValidationSummary(projected),'验收状态：3/3项验证已通过')
    assert.equal(repairCompletionBlocker(projected),'')
    assert.ok(projected && 'reportVersion' in projected)
    assert.equal(projected.reportVersion,2)
    assert.equal(projected.reportSequence,2)
    assert.equal(JSON.stringify(f.report),original)
    assert.ok(projected?.acceptanceEvidence?.note.includes('交付前'))
    const first=projected!.acceptanceEvidence!.fingerprint
    await writeFile(join(f.directory,'test-summary.json'),JSON.stringify({...f.summary,extra:'changed artifact'}),{mode:0o600})
    assert.notEqual((await f.projector.project(f.report))!.acceptanceEvidence!.fingerprint,first)
  }finally{await f.close()}
})
test('acceptance evidence: unsafe ambiguous failed zero build-only and wrong-source evidence fail closed',async()=>{
  const f=await evidenceFixture()
  const pending=async(report=f.report)=>{
    const projected=await f.projector.project(report)
    assert.equal(repairValidationSummary(projected),'验收状态：测试证据待核对')
    assert.ok(repairCompletionBlocker(projected))
  }
  try{
    await pending({...f.report,sourceIdentity:'Apple source '+'b'.repeat(64)})
    await pending({...f.report,sourceIdentity:f.report.sourceIdentity+'; Apple source '+'b'.repeat(64)})
    for(const extra of [f.report.validation.evidence[0]!,join(f.apple,'00000000000000000002','evidence.json'),join(f.apple,'..','evidence.json'),'/foreign/data/apple/00000000000000000001/evidence.json'])await pending({...f.report,validation:{...f.report.validation,evidence:[...f.report.validation.evidence,extra]}})
    await pending({...f.report,validation:{...f.report.validation,evidence:[f.report.validation.evidence[0]!]}})
    const path=join(f.directory,'test-summary.json'),contents=await readFile(path)
    await writeFile(join(f.root,'outside.json'),contents,{mode:0o600});await rm(path);await symlink(join(f.root,'outside.json'),path)
    await pending();await rm(path);await f.save()
    for(const patch of [{passed:false},{synthetic:true},{inputs_stable:false},{cleanup_known:false},{request:{action:'build'}},{actual_tests:['Tests/Unit/test1','Tests/Unit/test1','Tests/Unit/test3']},{after:{source:'b'.repeat(64)}}]){
      await writeFile(join(f.directory,'evidence.json'),JSON.stringify({...f.evidence,...patch}),{mode:0o600});await pending()
    }
    await f.save()
    for(const patch of [{passedTests:0,totalTestCount:0},{passedTests:2,failedTests:1,result:'Failed'},{passedTests:2,skippedTests:1},{passedTests:3,totalTestCount:4},{expectedFailures:1}]){
      await writeFile(path,JSON.stringify({...f.summary,...patch}),{mode:0o600});await pending()
    }
  }finally{await f.close()}
})
test('acceptance N/A: explicit reason and executed checks required; missing failed and not-run cannot pass',async()=>{
  const f=await evidenceFixture()
  try{
    const make=(unitTests:unknown)=>({...f.report,reportVersion:3,validation:{...f.report.validation,evidence:[],unitTests}})
    const valid={applicability:'not_applicable',reason:'仅调整提示文字，没有可执行逻辑变化',checks:[{name:'文案和差异检查',status:'passed',evidence:['git diff --check passed; fixture review']}]}
    const accepted=parseRepairReport(make(valid))
    assert.equal(repairCompletionBlocker(accepted),'')
    assert.equal(repairValidationSummary(accepted),'验收状态：无需单元测试，检查已完成')
    for(const invalid of [{...valid,reason:''},{...valid,checks:[]},{...valid,checks:[{...valid.checks[0],evidence:[]}]},{...valid,passed:0,total:0}])assert.throws(()=>parseRepairReport(make(invalid)))
    for(const status of ['failed','not_run']){
      const pending=parseRepairReport(make({...valid,checks:[{...valid.checks[0],status}]}))
      assert.equal(repairValidationSummary(pending),'验收状态：无需单元测试，检查未完成')
      assert.ok(repairCompletionBlocker(pending))
    }
  }finally{await f.close()}
})

/// N/A 不洗掉同 run 既有单测要求；零占位和无受管引用的旧记录仍可明确补充适用性。
test('acceptance cache: nonzero and managed history cannot downgrade to N/A; zero and unreferenced v2 can',async()=>{
  const { RepairCache }=await import('../src/repair-cache.ts')
  const { DatabaseSync }=await import('node:sqlite')
  for(const mode of ['nonzero-history','managed','unavailable','zero','unreferenced']){
    const f=await evidenceFixture(),cache=new RepairCache(join(f.root,'db'),f.projector)
    try{
      const directory=join(f.root,'receipt');await mkdir(directory,{mode:0o700})
      const task={id:'task',number:1,name:'虚构任务',project:{id:'p',name:'项目'},issueType:{id:'bug',name:'缺陷'},status:{id:'open',name:'待处理'}}
      const {resultFile,...binding}=await cache.register('scope',task,{state:'sent',projectId:'p',projectName:'项目',createdAt:1},'revision',directory)
      const base={...f.report,reportVersion:3,validation:{...f.report.validation,evidence:['fixture test result'],unitTests:{status:'failed',passed:2,failed:1,skipped:0,notRun:0,total:3}}}
      const zero={...base,validation:{...base.validation,evidence:[],unitTests:{status:'not_run',passed:0,failed:0,skipped:0,notRun:0,total:0}}}
      const previous=mode==='nonzero-history'?base:mode==='zero'?zero:mode==='unreferenced'?{...f.report,validation:{...f.report.validation,evidence:['硬件未验收']}}:mode==='unavailable'?{...f.report,sourceIdentity:'unknown'}:f.report
      cache.close()
      const db=new DatabaseSync(join(f.root,'db','cache.sqlite'));db.prepare('UPDATE repairs SET report=?').run(JSON.stringify(previous));db.close()
      const write=async(report:unknown)=>{await writeFile(resultFile,JSON.stringify({...binding,...report as object}),{mode:0o600});await cache.consume('scope',()=>{})}
      if(mode==='nonzero-history')for(let sequence=3;sequence<=24;sequence++)await write({...zero,reportSequence:sequence})
      const next={...zero,reportSequence:25,validation:{...zero.validation,unitTests:{applicability:'not_applicable',reason:'仅提示文案调整，不涉及业务逻辑',checks:[{name:'文案与差异检查',status:'passed',evidence:['fixture review passed']}]}}}
      await write(next)
      const result=(await cache.read('scope')).items[0]!
      if(mode==='zero'||mode==='unreferenced'){
        assert.equal(result.reportError,undefined)
        assert.equal(repairValidationSummary(result.report),'验收状态：无需单元测试，检查已完成')
      }else{
        assert.ok(result.reportError?.includes('不能改为无需单元测试'))
        assert.notEqual((result.report as {reportSequence:number}).reportSequence,25)
      }
      if(mode==='nonzero-history'){
        cache.close()
        const read=new DatabaseSync(join(f.root,'db','cache.sqlite'),{readOnly:true})
        const rows=read.prepare('SELECT sequence FROM report_history ORDER BY sequence').all();read.close()
        assert.ok(rows.some(row=>row.sequence===2));assert.ok(rows.length<=22)
      }
    }finally{cache.close();await f.close()}
  }
})
