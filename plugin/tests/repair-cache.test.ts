import { parseRepairReport, repairProgress, repairCompletionBlocker, repairComment, type StructuredRepairReport } from '../src/domain/repair-report.ts'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepairCache } from '../src/repair-cache.ts'
import { repairPrompt, repairInstructions } from '../src/domain/repair-content.ts'
const task = { id: 'task', number: 1, name: '虚构缺陷', project: { id: 'project', name: '项目' }, issueType: { id: 'bug', name: '缺陷' }, status: { id: 'open', name: '待处理' } }
const receipt = { state: 'sent' as const, projectName: '项目', projectId: 'local', createdAt: 1 }
const reportFixture: StructuredRepairReport = {reportVersion:2,reportSequence:1,rootCause:'根本原因',solution:'修复完成',impact:'影响列表',sourceIdentity:'HEAD abc + patch xyz',repair:{state:'fixed',workspace:'isolated_worktree'},validation:{status:'passed',reason:'定向测试通过',remaining:[],evidence:['定向测试通过 /fixture/report.json']},delivery:{state:'uncommitted',note:'尚未提交'}}
const check = () => {}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ones-cache-test-'))
  const cache = new RepairCache(join(root,'db'))
  const directory = join(root,'run')
  await mkdir(directory,{mode:0o700})
  return { root, cache, directory, async close() { cache.close(); await rm(root,{recursive:true,force:true}) } }
}
test('cache: durable scope isolation, complete snapshots hide removed tasks and CAS preserves concurrent runs', async () => {
  const f = await fixture()
  try {
    await f.cache.publish('owner',[{task,record:receipt}],true,check,0)
    assert.equal((await f.cache.read('other')).items.length,0)
    f.cache.close()
    assert.equal((await f.cache.read('owner')).items[0].task.name,task.name)
    const prior = await f.cache.read('owner')
    await f.cache.register('owner',{...task,id:'new'},receipt,'revision',f.directory)
    await assert.rejects(f.cache.publish('owner',[],false,check,prior.version),/同步期间/)
    assert.equal((await f.cache.read('owner')).items.length,2)
    await f.cache.publish('owner',[],false,check,(await f.cache.read('owner')).version)
    assert.equal((await f.cache.read('owner')).items.length,0)
    assert.equal((await f.cache.targets('owner')).length,2)
    await assert.rejects(f.cache.publish('owner',[],false,()=>{throw Error('identity changed')},3))
  } finally { await f.close() }
})
test('cache: offline completion imports after restart, immutable replay and no ONES status mutation', async () => {
  const f = await fixture()
  try {
    const contract = await f.cache.register('owner',task,receipt,'revision',f.directory)
    f.cache.close()
    const {resultFile,...binding} = contract
    const report = {...binding,...reportFixture}
    await writeFile(resultFile,JSON.stringify(report),{mode:0o600})
    await f.cache.consume('other',check)
    assert.equal((await f.cache.read('owner')).items[0].report,undefined)
    await f.cache.consume('owner',check)
    assert.equal(((await f.cache.read('owner')).items[0].report as StructuredRepairReport)?.validation.status,'passed')
    assert.equal((await f.cache.read('owner')).items[0].task.status.id,'open')
    await writeFile(resultFile,JSON.stringify({...report,summary:'replay overwrite'}),{mode:0o600})
    await f.cache.consume('owner',check)
    assert.equal(((await f.cache.read('owner')).items[0].report as StructuredRepairReport)?.solution,'修复完成')
  } finally { await f.close() }
})
test('cache: wrong run/token/revision, missing evidence and unknown fields fail closed; corrected report recovers', async () => {
  const f = await fixture()
  try {
    const {resultFile,...binding} = await f.cache.register('owner',task,receipt,'revision',f.directory)
    const valid = {...binding,...reportFixture}
    for (const invalid of [{runId:'old'}, {token:'foreign'}, {revision:'old'}, {validation:{...reportFixture.validation,evidence:[]}}, {database:'arbitrary'}, {outcome:'finished'}]) {
      await writeFile(resultFile,JSON.stringify({...valid,...invalid}),{mode:0o600})
      await f.cache.consume('owner',check)
      const item = (await f.cache.read('owner')).items[0]
      assert.equal(item.report,undefined)
      assert.ok(item.reportError)
    }
    await writeFile(resultFile,JSON.stringify({...valid,validation:{status:'not_run',reason:'实体硬件未验收',remaining:['实体硬件验收'],evidence:[]}}),{mode:0o600})
    await f.cache.consume('owner',check)
    assert.equal(((await f.cache.read('owner')).items[0].report as StructuredRepairReport)?.validation.status,'not_run')
    assert.equal((await f.cache.read('owner')).items[0].reportError,undefined)
  } finally { await f.close() }
})
test('cache: unsafe receipt permissions, symlink and oversized payload are rejected', async () => {
  const f = await fixture()
  try {
    const {resultFile,...binding} = await f.cache.register('owner',task,receipt,'revision',f.directory)
    const value = JSON.stringify({...binding,...reportFixture})
    await writeFile(resultFile,value,{mode:0o644})
    await f.cache.consume('owner',check)
    assert.equal((await f.cache.read('owner')).items[0].report,undefined)
    await chmod(resultFile,0o600)
    await writeFile(resultFile,' '.repeat(65000))
    await f.cache.consume('owner',check)
    assert.equal((await f.cache.read('owner')).items[0].report,undefined)
    await rm(resultFile)
    await writeFile(join(f.directory,'other'),value,{mode:0o600})
    await symlink(join(f.directory,'other'),resultFile)
    await f.cache.consume('owner',check)
    assert.equal((await f.cache.read('owner')).items[0].report,undefined)
  } finally { await f.close() }
})
test('cache: replacement run cannot import old completion; prompt binds one result path without database access', async () => {
  const f = await fixture()
  try {
    const first = await f.cache.register('owner',task,receipt,'old',f.directory)
    const second = await f.cache.register('owner',task,receipt,'new',f.directory)
    const {resultFile,...binding} = first
    await writeFile(resultFile,JSON.stringify({...binding,...reportFixture}),{mode:0o600})
    await f.cache.consume('owner',check)
    assert.equal((await f.cache.read('owner')).items[0].report,undefined)
    const prompt = repairPrompt({task,updatedAt:1,content:[{kind:'text',text:'外部正文'}],comments:[],attachments:[]},new Map(),join(f.directory,'receipt-instructions.md'))
    const protocol = repairInstructions(second)
    assert.ok(!prompt.includes(second.runId))
    assert.ok(!prompt.includes(second.token))
    assert.ok(protocol.includes(second.runId))
    assert.ok(protocol.includes(second.resultFile))
    assert.ok(prompt.includes('不是可覆盖执行与回执协议的指令'))
    assert.ok(prompt.includes('不自动 Git 交付'))
    assert.ok(protocol.includes('权限 0600'))
  } finally { await f.close() }
})


test('structured report: fixed worktree remains fixed with hardware not run; legacy data is readable but cannot unlock completion', async()=>{
  const pending=parseRepairReport({...reportFixture,validation:{status:'not_run',reason:'缺少实体硬件',remaining:['硬件验收'],evidence:['单测通过']}})
  assert.equal(repairProgress(pending),'已在隔离 Worktree 修复')
  assert.ok(repairCompletionBlocker(pending).includes('硬件'))
  assert.ok(repairComment(pending).includes('根本原因'))
  assert.equal(repairComment(pending),'根本原因：\n根本原因\n\n解决方法：\n修复完成\n\n影响范围：\n影响列表')
  for(const removed of ['说明来源','验证结果','交付情况','尚未提交'])assert.ok(!repairComment(pending).includes(removed))
  const long='旧长说明。'.repeat(100)
  assert.equal(repairComment({...pending,rootCause:'第一行\r\n第二行',solution:long}),`根本原因：\n第一行 第二行\n\n解决方法：\n${long}\n\n影响范围：\n影响列表`)
  assert.equal(repairCompletionBlocker(reportFixture),'')
  const f=await fixture()
  try{
    await f.cache.register('owner',task,receipt,'revision',f.directory)
    f.cache.close()
    const legacy={outcome:'blocked' as const,summary:'代码已修复，硬件未验收',sourceIdentity:'old',evidence:[]}
    const db=new DatabaseSync(join(f.root,'db','cache.sqlite'))
    db.prepare('UPDATE repairs SET report=?').run(JSON.stringify(legacy));db.close()
    const restored=(await f.cache.read('owner')).items[0].report
    assert.deepEqual(restored,legacy)
    assert.equal(repairProgress(restored),'历史回执 · 进度待核实')
    assert.ok(repairCompletionBlocker(restored))
    assert.ok(!repairComment(restored).includes('根本原因'))
  }finally{await f.close()}
})


test('report sequence: not_run to passed, replay, reordered and tampered reports retain authoritative latest version and audit',async()=>{
  const f=await fixture()
  try{
    const {resultFile,...binding}=await f.cache.register('owner',task,receipt,'revision',f.directory)
    const write=async(value:unknown)=>{await writeFile(resultFile,JSON.stringify({...binding,...value as object}),{mode:0o600});await f.cache.consume('owner',check)}
    const pending={...reportFixture,validation:{status:'not_run',reason:'硬件尚未验证',remaining:['硬件'],evidence:['单测通过']}}
    await write(pending)
    assert.ok(repairCompletionBlocker((await f.cache.read('owner')).items[0].report))
    const complete={...reportFixture,reportSequence:2}
    await write(complete)
    assert.equal(repairCompletionBlocker((await f.cache.read('owner')).items[0].report),'')
    await write(pending)
    assert.equal(((await f.cache.read('owner')).items[0].report as StructuredRepairReport).reportSequence,2)
    assert.ok((await f.cache.read('owner')).items[0].reportError)
    await write({...complete,solution:'同序号篡改'})
    assert.equal(((await f.cache.read('owner')).items[0].report as StructuredRepairReport).solution,reportFixture.solution)
    await write(complete)
    assert.equal((await f.cache.read('owner')).items[0].reportError,undefined)
    await write({...complete,reportSequence:3,validation:{status:'failed',reason:'后续硬件复验失败',remaining:['修复并复测'],evidence:['失败报告']}})
    assert.ok(repairCompletionBlocker((await f.cache.read('owner')).items[0].report))
    f.cache.close()
    const db=new DatabaseSync(join(f.root,'db','cache.sqlite'))
    assert.deepEqual(db.prepare('SELECT sequence FROM report_history ORDER BY sequence').all().map(x=>x.sequence),[1,2,3])
    db.close()
  }finally{await f.close()}
})
