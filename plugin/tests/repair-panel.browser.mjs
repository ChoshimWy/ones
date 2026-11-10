import assert from 'node:assert/strict'
// 仅虚构 Worker，禁止用于真实业务账号。
export async function exerciseRepairPanel({evaluate,wait,screenshot}) {
  const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Unavailable '+${JSON.stringify(label)});b.click()})()`)
  await evaluate(`document.querySelector('button.bug-item').click()`)
  await wait(`[...document.querySelectorAll('button')].some(x=>x.textContent==='执行修复'&&!x.disabled)`)
  await click('执行修复')
  await wait(`!!document.getElementById('开始修复 · 分类说明 *（必填）')`)
  await evaluate(`(()=>{const x=document.getElementById('开始修复 · 分类说明 *（必填）');x.value='已确认需修复';x.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await click('预览开始修复')
  await wait(`[...document.querySelectorAll('button')].some(x=>x.textContent==='开始修复并更新状态')`)
  assert.equal(await evaluate(`document.body.innerText.includes('状态流转不提交评论')`),true)
  await screenshot('repair-business-confirm','light',360)
  await click('开始修复并更新状态')
  await wait(`document.body.innerText.includes('已在隔离 Worktree 修复')`)
  assert.equal(await evaluate(`document.body.innerText.includes('Session：')`),false)
  await screenshot('repair-detail-folded','dark',360)
  await evaluate(`document.querySelector('details summary').click()`)
  await wait(`document.body.innerText.includes('Session：session-fixture-only')`)
  await screenshot('repair-detail-technical','dark',460)
  await click('刷新详情')
  await wait(`[...document.querySelectorAll('button')].some(x=>x.textContent==='查看执行记录'&&!x.disabled)`)
  const calls=await evaluate(`orca.host.call('plugin.request',{name:'fixture.calls',input:{}}).then(r=>r.output.value.calls)`)
  assert.equal(calls.filter(x=>x==='repair.start').length,1)
  return{singleConfirmation:true,requiredFields:true,foldedTechnical:true,noDuplicateLaunch:true}
}
