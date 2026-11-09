import assert from 'node:assert/strict'
export async function exerciseProjectFollow({ evaluate, wait, screenshot, activate }) {
  const request = name => evaluate(`orca.host.call('plugin.request',{name:${JSON.stringify(name)},input:{}}).then(r=>r.output.value)`)
  const selected = () => evaluate(`document.getElementById('项目筛选').value`)
  const waitSelected = value => wait(`document.getElementById('项目筛选')?.value===${JSON.stringify(value)}`)
  const statusTags = await evaluate(`document.querySelector('.selected-tags').textContent`)
  await activate('SidusLinkPro')
  await waitSelected('ones-sidus')
  assert.equal(await evaluate(`document.querySelectorAll('.bug-item').length`), 1)
  await screenshot('ones-project-follow-sidus', 'dark', 460)
  await activate('OtherProject')
  await waitSelected('ones-other')
  assert.equal(await evaluate(`document.querySelector('.bug-item').innerText.includes('OtherProject')`), true)
  await activate('UnmatchedProject')
  await waitSelected('all')
  await wait(`document.body.innerText.includes('未找到唯一匹配')`)
  assert.equal(await evaluate(`document.querySelectorAll('.bug-item').length`), 2)
  assert.equal(await evaluate(`document.querySelector('.selected-tags').textContent`), statusTags)
  await screenshot('ones-project-follow-all', 'light', 360)
  await activate('SidusLinkPro')
  await waitSelected('ones-sidus')
  await evaluate(`(()=>{const s=document.getElementById('项目筛选');s.value='all';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='刷新缺陷').click()`)
  await wait(`document.querySelectorAll('.bug-item').length===2 && !document.body.innerText.includes('正在刷新缺陷')`)
  assert.equal(await selected(), 'all')
  await activate('OtherProject')
  await waitSelected('ones-other')
  await request('fixture.follow-hold')
  await activate('SidusLinkPro')
  // The worker tells the driver when the old focus result is held; no fixed sleep.
  for (let i=0;i<100;i++) {
    if ((await request('fixture.follow-stats')).pending === 1) break
    if(i===99)throw Error('Old response was not held')
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  await activate('UnmatchedProject')
  await wait(`document.body.innerText.includes('跟随 Orca：UnmatchedProject')`)
  await request('fixture.follow-release')
  await wait(`document.getElementById('项目筛选')?.value==='all'`)
  assert.equal(await selected(), 'all')
  assert.equal(await evaluate(`document.querySelector('.selected-tags').textContent`), statusTags)
  return { automaticMatch: true, unmatchedShowsAll: true, manualSurvivesRefresh: true, nextProjectResumesFollowing: true, staleResponseRejected: true, statusFilterPreserved: true }
}

export async function exerciseSameProjectTerminal({ evaluate, wait, activate, addTerminal }) {
  await activate('SidusLinkPro')
  await wait(`document.getElementById('项目筛选')?.value==='ones-sidus'`)
  await evaluate(`(()=>{const s=document.getElementById('项目筛选');s.value='all';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  const completed = () => evaluate(`orca.host.call('plugin.request',{name:'fixture.follow-stats',input:{}}).then(r=>r.output.value.completed)`)
  const before = await completed()
  await addTerminal('SidusLinkPro')
  for (let i=0;i<100;i++) {
    if (await completed() > before) break
    if(i===99)throw Error('Terminal change was not resolved')
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  assert.equal(await evaluate(`document.getElementById('项目筛选').value`), 'all')
  assert.equal(await evaluate(`document.body.innerText.includes('手动筛选')`), true)
  await activate('OtherProject')
  await wait(`document.getElementById('项目筛选')?.value==='ones-other'`)
  return { sameProjectTerminalPreservesManual: true, subsequentProjectChangeFollows: true }
}
