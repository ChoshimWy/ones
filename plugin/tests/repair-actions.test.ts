import { evidenceFixture } from './fixtures/repair-evidence.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/service.ts'
import { RepairWorkflow } from '../src/repair.ts'
import { RepairActions } from '../src/repair-actions.ts'
import { StatusJournal, StatusWorkflow } from '../src/status-update.ts'
import { OrcaCli } from '../src/adapters/orca-cli.ts'
import { statusPath } from '../src/domain/status-path.ts'
import type { RepairReport, StructuredRepairReport } from '../src/domain/repair-report.ts'

const report: StructuredRepairReport={reportVersion:3,reportSequence:1,rootCause:'根因',solution:'解决方法',impact:'影响范围',repair:{state:'fixed',workspace:'isolated_worktree'},validation:{status:'passed',reason:'定向验收通过',remaining:[],evidence:['fixture passed'],unitTests:{status:'passed',passed:3,failed:0,skipped:0,notRun:0,total:3}},delivery:{state:'uncommitted',note:'未提交未合并'},sourceIdentity:'HEAD fixture patch fixture'}
async function fixture(t:{after(fn:()=>Promise<void>):void},project: (report: RepairReport)=>Promise<RepairReport | undefined> = async report=>report){
  const root=await mkdtemp(join(tmpdir(),'ones-business-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const names:Record<string,string>={pending:'待处理',confirmed:'确认',repairing:'修复中',done:'已修复'}
  const state={status:'pending',version:1,commentRequired:'',messageReads:0,writeMessageReads:[] as number[],writes:[] as string[],messages:[] as Record<string,unknown>[],value:'',lost:'',fail:'',drift:false,driftAfterFirst:false,denied:false,unknownField:false,targetFails:false,launchFails:false,launches:0,prompt:'',externalAfterRepair:false,report:structuredClone(report)}
  const edges=[['confirm-action','pending','confirmed'],['repair-action','confirmed','repairing'],['finish-action','repairing','done']]
  const baseTask={id:'bug',number:1,name:'虚构缺陷',project:{id:'project',name:'Project'},issueType:{id:'bug-type',name:'缺陷'}}
  const definition=()=>edges.map(([uuid,source,target])=>({uuid,name:uuid+(state.drift?' changed':''),project_uuid:'project',issue_type_uuid:'bug-type',issue_type_scope_uuid:'scope',start_status_uuid:source,end_status_uuid:target,condition:null,trigger:null,post_function:[],fields:[{field_uuid:'tf-comment',type:-1,required:state.commentRequired===uuid},...(uuid==='repair-action'?[{field_uuid:'classification',type:2,required:true,default_value:''},...(state.unknownField?[{field_uuid:'unknown',type:9,required:true}]:[])]:[])]}))
  const stored=new Map<string,unknown>([['session.ones',JSON.stringify({userId:'owner',token:'fixture',label:'用户',teams:[{id:'team',name:'团队'}],expiresAt:Date.now()+600000})]])
  const store={get:async(key:string)=>stored.get(key)??null,set:async(key:string,value:unknown)=>{stored.set(key,value)},delete:async(key:string)=>{stored.delete(key)}}
  const service=new Workbench({store,vault:{get:async(key)=>stored.get(key) as string??null,set:store.set,delete:store.delete},protection:async()=>true,fetcher:async(url,init)=>{
    const path=new URL(String(url)).pathname
    if(path.endsWith('/users/me'))return Response.json({uuid:'owner'})
    if(path.endsWith('/items/graphql'))return Response.json({data:{tasks:[{uuid:'bug',number:1,name:baseTask.name,project:{uuid:'project',name:'Project'},issueType:{uuid:'bug-type',name:'缺陷'},status:{uuid:state.status,name:names[state.status]}}]}})
    if(path.endsWith('/issue_types'))return Response.json({issue_types:[{uuid:'bug-type',name:'缺陷',built_in:true,type:0,detail_type:3,default_configs:{default_task_status_configs:[{status_uuid:'pending'}]}}]})
    if(path.endsWith('/info')){const response=Response.json({uuid:'bug',project_uuid:'project',issue_type_uuid:'bug-type',issue_type_scope_uuid:'scope',status_uuid:state.status,server_update_stamp:state.version,summary:baseTask.name,desc_rich:'<p>原始描述不可覆盖</p>',desc:'原始描述不可覆盖',field_values:[{field_uuid:'classification',type:2,value:state.value}]});if(state.externalAfterRepair&&state.status==='repairing'){state.status='done';state.version++;state.externalAfterRepair=false}return response}
    if(path.endsWith('/messages')){state.messageReads++;return Response.json({messages:state.messages,has_next:false})}
    if(path.endsWith('/attachments'))return Response.json({attachments:[],has_next:false})
    if(path.endsWith('/transitions'))return Response.json({transitions:state.denied?[]:definition().filter(x=>x.start_status_uuid===state.status).map(x=>({uuid:x.uuid}))})
    if(path.endsWith('/stamps/data'))return Response.json({transition:{transitions:definition()}})
    if(path.endsWith('/fields'))return Response.json({fields:[{uuid:'classification',name:'分类说明',type:2,fixed:false,options:null}]})
    if(path.endsWith('/field_configs'))return Response.json({field_configs:[{field_uuid:'classification',type:2,project_uuid:'project',issue_type_uuid:'bug-type',issue_type_scope_uuid:'scope',option_configs:null}]})
    if(path.endsWith('/task_statuses'))return Response.json({task_statuses:Object.entries(names).map(([uuid,name])=>({uuid,name}))})
    if(path.endsWith('/evaluated_permissions'))return Response.json({tasks:{bug:{view_tasks:true,update_tasks:true,transit_tasks:true}}})
    if(path.endsWith('/new_transit')){
      const body=JSON.parse(String(init?.body))
      const edge=edges.find(x=>x[0]===body.transition_uuid)!
      assert.equal(edge[1],state.status)
      assert.deepEqual(Object.keys(body).sort(),[...(edge[0]==='finish-action'?['discussion']:[]),'field_values','manhours','resource_uuids','transition_uuid'])
      state.writeMessageReads.push(state.messageReads)
      state.writes.push(edge[0]!)
      if(state.fail===edge[0])return Response.json({},{status:500})
      state.status=edge[2]!;state.version++
      for(const field of body.field_values)if(field.field_uuid==='classification')state.value=field.value
      if(body.discussion)state.messages.push({...body.discussion,type:'discussion',ref_id:'bug',ref_type:'task',from:'owner',send_time:1000000+state.version,rich_text:body.discussion.text})
      if(state.driftAfterFirst&&state.writes.length===1)state.drift=true
      if(state.lost===edge[0])throw Error('lost response')
      return Response.json({})
    }
    throw Error('Unexpected path '+path)
  }})
  class CLI extends OrcaCli{
    async projects(){return[{id:'local',name:'Project'}]}
    async target(){if(state.targetFails)throw Error('CLI unavailable');return{projectId:'local',name:'Project',path:'/fixture/project',selector:'id:fixture::/fixture/project'}}
    async launch(_target:unknown,_agent:string,prompt:string){state.launches++;state.prompt=prompt;assert.equal(state.status,'repairing');if(state.launchFails)throw Error('launch unknown');return{outcome:{kind:'structured',sessionId:'fixture-session'},prompt:{outcome:'journaled',messageId:'fixture-message'}}}
  }
  const repair=new RepairWorkflow(service,store,new CLI(),join(root,'repairs'))
  const journal=new StatusJournal(join(root,'status'))
  const create=()=>new StatusWorkflow(id=>service.transitionContext(id),journal,true,async()=>project(state.report))
  const statuses=create(),actions=new RepairActions(repair,statuses)
  const detail=await service.bugDetail('team','bug')
  const input=async()=>{
    const preparation=await actions.prepare(detail.detailId)
    const fields=Object.fromEntries(preparation.status!.route.map(x=>[x.step.id,Object.fromEntries(x.step.fields.map(f=>[f.id,'人工补齐字段']))]))
    return{preparationId:preparation.id,projectId:'local',agent:'codex',fields}
  }
  return{root,state,service,repair,statuses,actions,journal,create,detail,input}
}
test('repair business: full preflight then one confirmation executes legal steps and launches from fresh repairing content',async t=>{
  const f=await fixture(t),input=await f.input()
  const preview=await f.actions.preview(input)
  assert.deepEqual(preview.status.route.map(x=>x.step.id),['confirm-action','repair-action'])
  assert.equal(f.state.writes.length,0);assert.equal(f.state.launches,0)
  assert.equal(preview.status.comment,null)
  const reads=f.state.messageReads
  const result=await f.actions.start(preview.id,true)
  assert.equal(result.state,'sent')
  assert.deepEqual(f.state.writes,['confirm-action','repair-action'])
  assert.deepEqual(f.state.writeMessageReads,[reads,reads])
  assert.equal(f.state.messages.length,0)
  const operation=await f.journal.read((await f.service.transitionContext(f.detail.detailId)).scope,'bug')
  assert.equal(operation!.evidence!.comment,'not_applicable')
  assert.equal(f.state.launches,1)
  assert.ok(f.state.prompt.includes('原始描述不可覆盖'))
  assert.ok(f.state.prompt.includes('receipt-instructions.md'))
  assert.ok(!f.state.prompt.includes('reportVersion'))
  assert.equal((await f.service.transitionContext(f.detail.detailId)).task.status.id,'repairing')
  assert.ok((await f.actions.prepare(f.detail.detailId)).existing)
  await assert.rejects(f.actions.start(preview.id,true))
  assert.equal(f.state.launches,1)
})
test('repair business: CLI unavailable, missing later required field, unsupported path and preview drift produce zero writes',async t=>{
  for(const failure of ['cli','field','unsupported','drift']){
    const f=await fixture(t)
    if(failure==='unsupported'){f.state.unknownField=true;await assert.rejects(f.input());continue}
    const input=await f.input()
    if(failure==='cli'){f.state.targetFails=true;await assert.rejects(f.actions.preview(input))}
    if(failure==='field'){input.fields['repair-action']!.classification='';await assert.rejects(f.actions.preview(input))}
    if(failure==='drift'){const p=await f.actions.preview(input);f.state.version++;await assert.rejects(f.actions.start(p.id,true))}
    assert.equal(f.state.writes.length,0);assert.equal(f.state.launches,0)
  }
})
test('repair business: unknown first step blocks launch and restart; reconcile then one remaining-path confirmation never resends first step',async t=>{
  const f=await fixture(t),p=await f.actions.preview(await f.input())
  const reads=f.state.messageReads
  f.state.lost='confirm-action'
  await assert.rejects(f.actions.start(p.id,true),/核实/)
  assert.equal(f.state.launches,0);assert.equal(f.state.status,'confirmed')
  const scope=(await f.service.transitionContext(f.detail.detailId)).scope
  const operation=(await f.journal.read(scope,'bug'))!
  assert.equal(operation.state,'unknown');assert.equal(operation.business?.index,1)
  assert.equal(operation.intent.comment,null)
  assert.equal(operation.intent.commentId,null)
  assert.equal(operation.intent.html,null)
  const restored=f.create()
  const options=await restored.businessOptions(f.detail.detailId,'修复中')
  await assert.rejects(restored.businessPreview({detailId:f.detail.detailId,goal:'修复中',fields:Object.fromEntries(options.route.map(x=>[x.step.id,{classification:'人工补齐字段'}])),comment:'继续'}),/核对/)
  const reconciled=await restored.reconcile(f.detail.detailId,operation.id)
  assert.equal(reconciled.state,'verified')
  assert.equal(reconciled.evidence!.comment,'not_applicable')
  assert.equal(f.state.messageReads,reads)
  f.state.lost=''
  const next=await f.actions.preview(await f.input())
  assert.equal(next.status.route.length,1)
  await f.actions.start(next.id,true)
  assert.deepEqual(f.state.writes,['confirm-action','repair-action']);assert.equal(f.state.launches,1)
})
test('repair business: later schema drift preserves partial success; launch failure preserves repairing state and no resend',async t=>{
  const f=await fixture(t),p=await f.actions.preview(await f.input())
  f.state.driftAfterFirst=true
  await assert.rejects(f.actions.start(p.id,true),/配置/)
  assert.equal(f.state.status,'confirmed');assert.equal(f.state.launches,0)
  f.state.driftAfterFirst=false
  const next=await f.actions.preview(await f.input())
  f.state.launchFails=true
  assert.equal((await f.actions.start(next.id,true)).state,'unknown')
  assert.equal(f.state.status,'repairing');assert.equal(f.state.launches,1)
  assert.equal((await f.actions.prepare(f.detail.detailId)).existing?.state,'unknown')
  assert.deepEqual(f.state.writes,['confirm-action','repair-action'])
})
test('completion business: authoritative validation gate cannot be bypassed by editable comment; three concise items become one final comment',async t=>{
  const f=await fixture(t)
  f.state.status='repairing';f.state.version++;f.state.commentRequired='finish-action'
  f.state.report.validation={status:'not_run',reason:'缺少硬件',remaining:['硬件验收'],evidence:['单测通过'],unitTests:{status:'not_run',passed:2,failed:0,skipped:0,notRun:1,total:3}}
  const options=await f.statuses.businessOptions(f.detail.detailId,'已修复')
  assert.equal(options.completionBlocker,'验收状态：2/3项验证已通过')
  assert.ok(options.comment?.includes('根因'))
  await assert.rejects(f.statuses.businessPreview({detailId:f.detail.detailId,goal:'已修复',fields:{'finish-action':{}},comment:'我把文字改为验证通过'}),/验收/)
  assert.equal(f.state.writes.length,0)
  f.state.report.validation.unitTests=structuredClone(report.validation.unitTests)
  const good=await f.statuses.businessOptions(f.detail.detailId,'已修复')
  const p=await f.statuses.businessPreview({detailId:f.detail.detailId,goal:'已修复',fields:{'finish-action':{}},comment:good.comment})
  assert.equal((await f.statuses.businessSubmit(p.id,true)).state,'verified')
  assert.equal(f.state.status,'done')
  assert.ok(String(f.state.messages.at(-1)?.text).includes('影响范围'))
  assert.equal(f.state.messages.at(-1)?.text,'<p>根本原因：<br>根因<br><br>解决方法：<br>解决方法<br><br>影响范围：<br>影响范围</p>')
})
test('business path: ambiguous paths and disallowed initial step fail closed',async t=>{
  const f=await fixture(t)
  const snapshot=(await f.statuses.options(f.detail.detailId)).snapshot
  const original=snapshot.graph![0]!
  snapshot.graph!.push({...original,step:{...original.step,id:'another'}})
  snapshot.steps.push(snapshot.graph!.at(-1)!.step)
  assert.throws(()=>statusPath(snapshot,'修复中'),/多条/)
  snapshot.steps=[]
  assert.throws(()=>statusPath(snapshot,'修复中'),/路径/)
})


test('repair business: unknown second step and account logout never launch or permit silent retry',async t=>{
  const f=await fixture(t),p=await f.actions.preview(await f.input())
  f.state.fail='repair-action'
  await assert.rejects(f.actions.start(p.id,true),/核实/)
  assert.equal(f.state.status,'confirmed');assert.equal(f.state.launches,0)
  const context=await f.service.transitionContext(f.detail.detailId)
  const operation=(await f.journal.read(context.scope,'bug'))!
  assert.equal(operation.business?.index,2);assert.equal(operation.state,'unknown')
  assert.equal((await f.create().reconcile(f.detail.detailId,operation.id)).state,'unknown')
  await assert.rejects(f.actions.preview(await f.input()),/核对/)
  assert.deepEqual(f.state.writes,['confirm-action','repair-action'])
  const g=await fixture(t),good=await g.actions.preview(await g.input())
  await g.service.logout('ones')
  await assert.rejects(g.actions.start(good.id,true))
  assert.equal(g.state.writes.length,0);assert.equal(g.state.launches,0)
})

test('completion business: report changes after preview cannot be hidden by edited comment',async t=>{
  const f=await fixture(t)
  f.state.status='repairing';f.state.version++
  const p=await f.statuses.businessPreview({detailId:f.detail.detailId,goal:'已修复',fields:{'finish-action':{}},comment:'完成'})
  f.state.report.validation={status:'not_run',reason:'硬件未验收',remaining:['硬件'],evidence:['2 passed'],unitTests:{status:'not_run',passed:2,failed:0,skipped:0,notRun:1,total:3}}
  await assert.rejects(f.statuses.businessSubmit(p.id,true),/验收/)
  assert.equal(f.state.writes.length,0)
})


test('completion business: a newer passed report with changed source also invalidates old confirmation',async t=>{
  const f=await fixture(t)
  f.state.status='repairing';f.state.version++
  const p=await f.statuses.businessPreview({detailId:f.detail.detailId,goal:'已修复',fields:{'finish-action':{}},comment:'完成'})
  f.state.report={...f.state.report,reportSequence:2,sourceIdentity:'different HEAD and patch'}
  await assert.rejects(f.statuses.businessSubmit(p.id,true),/回执已变化/)
  assert.equal(f.state.writes.length,0)
})


test('repair business: external status change after final readback but before collection prevents Agent launch',async t=>{
  const f=await fixture(t),p=await f.actions.preview(await f.input())
  f.state.externalAfterRepair=true
  await assert.rejects(f.actions.start(p.id,true),/不处于/)
  assert.equal(f.state.status,'done')
  assert.equal(f.state.launches,0)
  assert.deepEqual(f.state.writes,['confirm-action','repair-action'])
})


test('business confirmation: completion endpoint cannot consume a start-repair preview',async t=>{
  const f=await fixture(t),p=await f.actions.preview(await f.input())
  await assert.rejects(f.statuses.businessSubmit(p.status.id,true),/入口/)
  assert.equal(f.state.writes.length,0)
  assert.equal((await f.actions.start(p.id,true)).state,'sent')
})

/// 评论必填属于整个预览路径的约束，后续步骤要求也必须在任何写入前阻断。
test('repair business: required comment on either step fails closed before writes or launch',async t=>{
  for(const step of ['confirm-action','repair-action']){
    const f=await fixture(t)
    f.state.commentRequired=step
    const input=await f.input()
    await assert.rejects(f.actions.preview(input),/要求填写评论/)
    assert.deepEqual(f.state.writes,[])
    assert.equal(f.state.launches,0)
  }
})
/// 生产目标不能被输入扩展为评论通道；两个步骤均保留无评论语义。
test('repair business: injected comment is discarded by target contract for every step',async t=>{
  const f=await fixture(t),input=await f.input()
  const reads=f.state.messageReads
  const p=await f.statuses.businessPreview({detailId:f.detail.detailId,goal:'修复中',fields:input.fields,comment:'不应发送的评论'})
  assert.equal(p.comment,null)
  const result=await f.statuses.businessSubmit(p.id,true,'修复中')
  assert.equal(result.state,'verified')
  assert.equal(result.operations.length,2)
  assert.ok(result.operations.every(x=>x.evidence?.comment==='not_applicable'))
  assert.equal(f.state.messageReads,reads)
  assert.equal(f.state.messages.length,0)
})

/// 真实业务入口只认完整非空单元测试通过；评论、整体通过状态和证据存在不能解锁。
test('completion business: zero failed skipped and not-run unit tests cause zero writes',async t=>{
  for(const unitTests of [
    {status:'not_run' as const,passed:0,failed:0,skipped:0,notRun:0,total:0},
    {status:'failed' as const,passed:2,failed:1,skipped:0,notRun:0,total:3},
    {status:'not_run' as const,passed:2,failed:0,skipped:1,notRun:0,total:3},
    {status:'not_run' as const,passed:0,failed:0,skipped:0,notRun:3,total:3},
  ]){
    const f=await fixture(t)
    f.state.status='repairing';f.state.version++
    f.state.report.validation.unitTests=unitTests
    await assert.rejects(f.statuses.businessPreview({detailId:f.detail.detailId,goal:'已修复',fields:{'finish-action':{}},comment:'已经全部完成'}),/验收状态/)
    assert.deepEqual(f.state.writes,[])
  }
})

/// 不适用必须独立人工确认，评论不能代替；替代检查失败仍零写。
test('acceptance business: N/A completed checks require explicit confirmation and failed checks block',async t=>{
  const f=await fixture(t)
  f.state.status='repairing';f.state.version++
  f.state.report.validation.unitTests={applicability:'not_applicable',reason:'仅调整提示文案，不涉及逻辑',checks:[{name:'文案与差异检查',status:'passed',evidence:['fixture review passed']}]}
  const input={detailId:f.detail.detailId,goal:'已修复' as const,fields:{'finish-action':{}},comment:'三项说明'}
  assert.equal((await f.statuses.businessOptions(f.detail.detailId,'已修复')).noUnitTestsConfirmationRequired,true)
  await assert.rejects(f.statuses.businessPreview(input),/明确确认/)
  assert.deepEqual(f.state.writes,[])
  const preview=await f.statuses.businessPreview({...input,noUnitTestsConfirmed:true})
  assert.equal((await f.statuses.businessSubmit(preview.id,true)).state,'verified')
  const g=await fixture(t)
  g.state.status='repairing';g.state.version++
  g.state.report.validation.unitTests={applicability:'not_applicable',reason:'仅提示文案',checks:[{name:'文案检查',status:'failed',evidence:['fixture failed']}]}
  await assert.rejects(g.statuses.businessPreview({...input,detailId:g.detail.detailId,noUnitTestsConfirmed:true}),/检查未完成/)
  assert.deepEqual(g.state.writes,[])
})
/// 旧回执通过同一投影进入真实业务路径；证据改变后旧确认立即失效。
test('acceptance business: legacy artifact projection permits submit but changed artifact invalidates preview',async t=>{
  const e=await evidenceFixture();t.after(e.close)
  const f=await fixture(t,report=>e.projector.project(report))
  f.state.status='repairing';f.state.version++
  f.state.report=e.report as unknown as StructuredRepairReport
  const input={detailId:f.detail.detailId,goal:'已修复' as const,fields:{'finish-action':{}},comment:'根本原因：虚构原因'}
  const options=await f.statuses.businessOptions(f.detail.detailId,'已修复')
  assert.equal(options.validationSummary,'验收状态：3/3项验证已通过')
  const preview=await f.statuses.businessPreview(input)
  await writeFile(join(e.directory,'test-summary.json'),JSON.stringify({...e.summary,observation:'changed'}),{mode:0o600})
  await assert.rejects(f.statuses.businessSubmit(preview.id,true),/回执已变化/)
  assert.deepEqual(f.state.writes,[])
  const fresh=await f.statuses.businessPreview(input)
  assert.equal((await f.statuses.businessSubmit(fresh.id,true)).state,'verified')
})
