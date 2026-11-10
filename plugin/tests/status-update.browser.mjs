import assert from 'node:assert/strict'
// 仅虚构 Worker；多步请求/恢复保护由 repair-actions.test.ts 验证。
export async function exerciseStatusUpdate({evaluate,wait,screenshot}){
  const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Unavailable '+${JSON.stringify(label)});b.click()})()`)
  const fill=(label,value,event='input')=>evaluate(`(()=>{const x=document.getElementById(${JSON.stringify(label)});x.value=${JSON.stringify(value)};x.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))})()`)
  await click('更新状态')
  await wait(`!!document.getElementById('修复说明（三项，可编辑）')`)
  assert.equal(await evaluate(`document.getElementById('修复说明（三项，可编辑）').value.includes('根本原因')`),true)
  await fill('修复说明（三项，可编辑）','我编辑为全部通过')
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent==='预览状态更新').disabled`),true)
  await screenshot('completion-validation-blocked','dark',360)
  await evaluate(`orca.host.call('plugin.request',{name:'fixture.report-mode',input:{mode:'passed'}})`)
  await click('刷新详情')
  await wait(`[...document.querySelectorAll('button')].some(x=>x.textContent==='更新状态'&&!x.disabled)`)
  await click('更新状态')
  await fill('完成修复 · 根因 *（必填）','logic','change')
  await fill('完成修复 · 解决版本','v-next')
  await click('预览状态更新')
  await wait(`!!document.querySelector('[data-status-preview]')`)
  await screenshot('completion-business-preview','light',460)
  await evaluate(`orca.host.call('plugin.request',{name:'fixture.transition-mode',input:{mode:'unknown'}})`)
  await click('确认更新为已修复')
  await wait(`[...document.querySelectorAll('button')].some(x=>x.textContent==='核对结果'&&!x.disabled)`)
  await screenshot('completion-unknown','dark',360)
  await click('核对结果')
  await wait(`document.body.innerText.includes('媒体验证项目 · 已修复')`)
  const calls=await evaluate(`orca.host.call('plugin.request',{name:'fixture.calls',input:{}}).then(r=>r.output.value.calls)`)
  assert.equal(calls.filter(x=>x==='bugs.businessSubmit').length,1)
  assert.equal(calls.filter(x=>x==='bugs.transitionSubmit').length,0)
  return{structuredPrefill:true,editedCommentCannotUnlock:true,oneBusinessConfirm:true,unknownReconciledWithoutResend:true}
}
export async function exerciseStatusKeyboard({evaluate,wait,press}){
  await evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent==='更新状态').click()`)
  await wait(`!!document.querySelector('textarea')`)
  await evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent==='收起状态表单').click()`)
  assert.equal(await evaluate(`document.activeElement?.textContent`),'更新状态')
  await press('Tab')
  assert.equal(await evaluate(`document.activeElement?.textContent`),'查看执行记录')
  return{focusReturned:true,nativeTabOrder:true}
}
