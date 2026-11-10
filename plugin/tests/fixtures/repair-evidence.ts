import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepairEvidence } from '../../src/repair-evidence.ts'
import type { PreviousRepairReport } from '../../src/domain/repair-report.ts'

/// 虚构受管目录和最小结构，不复制真实 Bug、设备、凭据或完整执行记录。
export async function evidenceFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(),'ones-evidence-')))
  const apple = join(root,'data','apple'), run = '00000000000000000001', directory = join(apple,run), source = 'a'.repeat(64)
  await mkdir(directory,{recursive:true,mode:0o700})
  const evidence = {version:'0.1.0',synthetic:false,stage:'complete',verification_mode:'strict',inputs_stable:true,cleanup_known:true,passed:true,exit_code:0,request:{action:'selected-test',only_testing:['Tests/Unit/test1','Tests/Unit/test2','Tests/Unit/test3']},bundle:join(directory,'result.xcresult'),before:{source},after:{source},actual_tests:['Tests/Unit/test1','Tests/Unit/test2','Tests/Unit/test3']}
  const summary = {passedTests:3,failedTests:0,skippedTests:0,expectedFailures:0,totalTestCount:3,result:'Passed'}
  const report: PreviousRepairReport = {reportVersion:2,reportSequence:2,rootCause:'虚构原因',solution:'虚构解决',impact:'虚构影响',repair:{state:'fixed',workspace:'isolated_worktree'},validation:{status:'not_run',reason:'硬件未验收',remaining:['硬件'],evidence:[join(directory,'evidence.json'),join(directory,'test-summary.json'),join(directory,'result.xcresult')]},delivery:{state:'merged',note:'测试对应交付前身份'},sourceIdentity:`tested pre-delivery identity; Apple source ${source}`}
  const save = async () => {await writeFile(join(directory,'evidence.json'),JSON.stringify(evidence),{mode:0o600});await writeFile(join(directory,'test-summary.json'),JSON.stringify(summary),{mode:0o600})}
  await save()
  return {root,apple,directory,run,evidence,summary,report,save,projector:new RepairEvidence(apple),close:()=>rm(root,{recursive:true,force:true})}
}
