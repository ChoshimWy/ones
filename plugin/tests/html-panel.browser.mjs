import assert from 'node:assert/strict'

// Run only against the fictional html-worker fixture in an isolated Orca profile.
export async function exerciseHtmlPanel({ evaluate, wait, screenshot }) {
  const click = async (label) =>
    evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Button unavailable: '+${JSON.stringify(label)});b.click()})()`
    )
  const fill = async (label, value) =>
    evaluate(
      `(()=>{const e=document.getElementById(${JSON.stringify(label)});if(!e||e.disabled)throw Error('Field unavailable');e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    )
  const select = async (label, value) =>
    evaluate(
      `(()=>{const e=document.getElementById(${JSON.stringify(label)});if(!e||e.disabled)throw Error('Select unavailable');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`
    )
  const check = async (label, value) =>
    evaluate(
      `(()=>{const label=[...document.querySelectorAll('label')].find(l=>l.textContent===${JSON.stringify(label)});const e=label?.querySelector('input');if(!e||e.disabled)throw Error('Checkbox unavailable');e.checked=${value};e.dispatchEvent(new Event('change',{bubbles:true}))})()`
    )
  const contains = async (text) =>
    evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)
  const enabled = async (label) =>
    evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});return !!b&&!b.disabled})()`
    )
  const waitText = async (text) => wait(`document.body.innerText.includes(${JSON.stringify(text)})`)
  const report = {}
  await waitText('当前显示 1 / 已读取 2 项')
  assert.equal(await contains('ONES 团队'), false)
  await evaluate(`document.querySelector('[aria-label="展开状态选项"]').click()`)
  await waitText('状态：已解决')
  await check('状态：已关闭', true)
  assert.equal(await contains('#88'), true)
  assert.equal(await contains('虚构已关闭缺陷'), true)
  await evaluate(`document.querySelector('[aria-label="移除状态：已关闭"]').click()`)
  assert.equal(await contains('虚构已关闭缺陷'), false)
  report.filters = true
  await screenshot('ones-html-filter', 'light')
  await evaluate(`document.querySelector('button.bug-item').click()`)
  await waitText('正文末尾：此页面仅使用虚构数据。')
  assert.equal(await evaluate('window.externalContentExecuted===undefined'), true)
  await evaluate(`document.querySelector('figure[data-label="虚构复现截图"]').scrollIntoView()`)
  await wait(
    `(()=>{const img=document.querySelector('img[alt="虚构复现截图"]');return img?.complete&&img.naturalWidth===640})()`
  )
  await evaluate(`document.querySelector('figure[data-label="虚构复现视频"] button').click()`)
  await waitText('正在加载媒体…')
  await screenshot('ones-html-loading', 'light')
  await wait(
    `(()=>{const v=document.querySelector('video');return v?.readyState>=2&&v.videoWidth===640})()`
  )
  assert.deepEqual(
    await evaluate(
      `(()=>{const v=document.querySelector('video');return {paused:v.paused,autoplay:v.autoplay}})()`
    ),
    { paused: true, autoplay: false }
  )
  await evaluate(`(()=>{const v=document.querySelector('video');v.muted=true;return v.play()})()`)
  await wait(`document.querySelector('video').currentTime>0.2`)
  await evaluate(`document.querySelector('video').pause()`)
  assert.equal(await evaluate(`document.querySelector('video').paused`), true)
  await evaluate(
    `new Promise((resolve,reject)=>{const v=document.querySelector('video'),timer=setTimeout(()=>reject(Error('seek timeout')),5000);v.addEventListener('seeked',()=>{clearTimeout(timer);resolve(true)},{once:true});v.currentTime=0.6})`
  )
  assert.ok(Math.abs((await evaluate(`document.querySelector('video').currentTime`)) - 0.6) < 0.12)
  const urls = await evaluate(`[...document.querySelectorAll('img,video')].map(n=>n.src)`)
  await evaluate(`window.scrollTo(0,0)`)
  await screenshot('ones-html-detail-light', 'light')
  await screenshot('ones-html-detail-dark', 'dark')
  await screenshot('ones-html-detail-narrow', 'light', 360)
  await click('更早评论')
  await waitText('更早评论全文')
  assert.equal(await contains('评论全文：图片清晰'), false)
  await click('上一页评论')
  await waitText('评论全文：图片清晰')
  await evaluate(
    `document.querySelector('figure[data-label="虚构：不支持的媒体"]').scrollIntoView()`
  )
  await waitText('媒体不可用或超出支持范围')
  await screenshot('ones-html-error', 'light')
  report.media = {
    imageDecoded: true,
    videoPlayPauseSeek: true,
    commentsPaging: true,
    rejectedUnsupported: true,
    externalHTMLNotExecuted: true
  }
  await click('返回我的 Bug')
  await waitText('当前显示 1 / 已读取 2 项')
  assert.equal(await evaluate(`document.querySelectorAll('video,img').length`), 0)
  assert.ok(
    (
      await evaluate(
        `Promise.all(${JSON.stringify(urls)}.map(async url=>{try{await fetch(url);return false}catch{return true}}))`
      )
    ).every(Boolean)
  )
  report.media.urlsRevoked = true
  await click('考勤工时')
  assert.equal(await enabled('加入分配草稿'), false)
  assert.equal(await enabled('读取考勤与已有工时'), false)
  await check('已确认 ONES 与 Coho 均为本人账号', true)
  await click('读取考勤与已有工时')
  await waitText('核对考勤依据')
  await click('读取可分配任务')
  await wait(
    `!![...document.querySelectorAll('option')].find(o=>o.textContent.includes('虚构普通任务'))`
  )
  await select('上班打卡', '0')
  await select('下班打卡', '1')
  await check('已核对本人当日上下班记录，无缺卡、跨日或外勤异常', true)
  await select('目标任务 / Bug', 'task-fixture')
  await fill('时长（分钟）', '120')
  await fill('工作描述（必填）', '虚构：修复与验证')
  await click('加入分配草稿')
  await click('校验并预览')
  await waitText('提交预览')
  await check('我确认上述任务、原日期、时长和每笔描述', true)
  assert.equal(await enabled('确认提交到 ONES'), false)
  await screenshot('ones-html-hours', 'light')
  await evaluate(
    `document.querySelector('button:disabled') && [...document.querySelectorAll('button')].find(b=>b.textContent==='确认提交到 ONES').scrollIntoView()`
  )
  await screenshot('ones-html-hours-preview', 'light')
  await click('保存草稿')
  await waitText('已保存本机草稿')
  await click('我的 Bug')
  await waitText('当前显示 1 / 已读取 2 项')
  await click('考勤工时')
  assert.equal(await contains('虚构：修复与验证'), true)
  await fill('业务日期（YYYY-MM-DD）', '2026-11-08')
  assert.equal(await contains('提交预览'), false)
  assert.equal(await enabled('加入分配草稿'), false)
  await click('恢复草稿')
  await waitText('草稿已恢复')
  assert.equal(await contains('虚构：修复与验证'), true)
  assert.equal(await enabled('加入分配草稿'), false)
  report.attendance = {
    requiresEvidence: true,
    normalTaskPreserved: true,
    manualPreview: true,
    writeDisabled: true,
    draftAcrossTabs: true,
    dateChangeInvalidates: true
  }
  await click('记录核对')
  await click('读取待核实操作')
  await waitText('只读核对此项')
  await click('只读核对此项')
  await waitText('两个匹配结果')
  assert.equal(await enabled('确认本地核对结果'), false)
  await click('读取本人当日原记录')
  await waitText('补全此条描述')
  await click('补全此条描述')
  await fill('补全描述（只更新原记录）', '虚构补全')
  await check('确认仅补全这条原记录的描述，不改变日期或时长', true)
  assert.equal(await enabled('提交原记录描述补全'), false)
  report.recovery = { ambiguousBlocked: true, descriptionWriteDisabled: true }
  await click('登录')
  await fill('ONES 邮箱', 'fixture@example.invalid')
  await fill('ONES 密码', 'fixture-only-password')
  assert.equal(await evaluate(`document.getElementById('ONES 密码').type`), 'password')
  await check('我确认仅在可信内网使用 HTTP，了解密码及令牌的传输风险', true)
  await click('登录 ONES')
  await waitText('已完成认证与身份回读')
  assert.equal(await evaluate(`document.getElementById('ONES 密码').value`), '')
  await click('考勤工时')
  assert.equal(await contains('虚构：修复与验证'), false)
  await click('登录')
  await fill('ONES 密码', 'another-fixture-password')
  await click('我的 Bug')
  await wait(`!!document.querySelector('button.bug-item')`)
  await click('登录')
  assert.equal(await evaluate(`document.getElementById('ONES 密码').value`), '')
  await screenshot('ones-html-login', 'dark')
  report.authentication = { passwordMaskedAndCleared: true, identityChangeClearsDraft: true }
  await click('退出 ONES')
  await wait(
    `document.body.innerText.includes('ONES 未登录')&&!document.body.innerText.includes('正在处理')`
  )
  await click('我的 Bug')
  await waitText('登录 ONES 后自动读取缺陷')
  assert.equal(await contains('虚构验证：完整正文'), false)
  const calls = await evaluate(`orca.plugin.request('fixture.calls').then(r=>r.value)`)
  assert.equal(
    calls.calls.some((name) =>
      ['hours.submit', 'hours.describe', 'recovery.confirm'].includes(name)
    ),
    false
  )
  assert.ok(calls.listCount >= 3)
  report.noBusinessWrites = true
  report.reentryReads = true
  return report
}

// Focused regression for the row-only detail entry; no attendance or auth operations.
export async function exerciseBugRows({ evaluate, wait, screenshot }) {
  await wait(`document.body.innerText.includes('当前显示 1 / 已读取 2 项')`)
  assert.equal(
    await evaluate(
      `document.body.innerText.includes('打开原单') || document.body.innerText.includes('实施说明')`
    ),
    false
  )
  assert.deepEqual(
    await evaluate(
      `(()=>{const b=document.querySelector('button.bug-item');return {type:b.type,disabled:b.disabled,nested:b.querySelectorAll('button,a').length,arrow:b.querySelector('svg').getAttribute('aria-hidden'),named:b.getAttribute('aria-label').includes('#88')}})()`
    ),
    { type: 'button', disabled: false, nested: 0, arrow: 'true', named: true }
  )
  await screenshot('ones-bug-row-light', 'light')
  await screenshot('ones-bug-row-dark', 'dark')
  await screenshot('ones-bug-row-narrow', 'light', 360)
  await evaluate(`document.querySelector('.bug-item-title').click()`)
  await wait(`document.body.innerText.includes('正文末尾：此页面仅使用虚构数据。')`)
  assert.equal(await evaluate(`document.querySelector('h2').textContent.startsWith('#88')`), true)
  assert.equal(
    await evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent==='打开原单')`),
    true
  )
  const back = async () => {
    await evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='返回我的 Bug').click()`
    )
    await wait(`document.body.innerText.includes('当前显示 1 / 已读取 2 项')`)
  }
  await back()
  await evaluate(
    `document.querySelector('.bug-item-arrow').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
  )
  await wait(`document.body.innerText.includes('正文末尾：此页面仅使用虚构数据。')`)
  await back()
  await evaluate(`document.querySelector('button.bug-item').click()`)
  await wait(`document.body.innerText.includes('正文末尾：此页面仅使用虚构数据。')`)
  await back()
  const calls = await evaluate(`orca.plugin.request('fixture.calls').then(r=>r.value)`)
  assert.equal(calls.calls.filter((name) => name === 'bugs.detail').length, 3)
  assert.ok(calls.listCount >= 4)
  assert.equal(
    calls.calls.some(
      (name) =>
        ![
          'status',
          'bugs.list',
          'bugs.detail',
          'bugs.media',
          'bugs.close',
          'fixture.calls'
        ].includes(name)
    ),
    false
  )
  return {
    oldButtonsRemoved: true,
    titleClick: true,
    arrowClick: true,
    wholeRowClick: true,
    matchingDetail: true,
    returnRefresh: true,
    noBusinessWrites: true
  }
}
