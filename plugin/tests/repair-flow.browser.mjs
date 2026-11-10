import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { readFile,mkdir,writeFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { exerciseRepairPanel } from './repair-panel.browser.mjs'
import { exerciseStatusUpdate,exerciseStatusKeyboard } from './status-update.browser.mjs'

// 完整 HTML 组件 + 虚构 Worker 桥接预览，不加载真实插件、不访问真实 ONES。
const tooling=process.env.ONES_TOOLING,output=process.env.ONES_EVIDENCE
if(!tooling||!output)throw Error('Set ONES_TOOLING and ONES_EVIDENCE')
const {chromium}=await import(pathToFileURL(join(tooling,'node_modules/@playwright/test/index.mjs')).href)
const {build}=await import(pathToFileURL(join(tooling,'node_modules/esbuild/lib/main.js')).href)
const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
const activate=(await import(pathToFileURL(join(root,'tests/fixtures/html-worker.ts')).href)).default
const handlers=new Map()
activate({panels:{handle:(name,callback)=>handlers.set(name,callback)}})
const bundle=await build({entryPoints:[join(root,'src/html/panel.ts')],bundle:true,platform:'browser',format:'iife',write:false})
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:process.env.ONES_BROWSER})
let server
try{
  const page=await browser.newPage({viewport:{width:460,height:1100}})
  page.setDefaultTimeout(10000)
  const errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.exposeFunction('fixtureRequest',async input=>{
    if(!handlers.has(input.name))throw Error('Missing fixture handler '+input.name)
    return {output:await handlers.get(input.name)(input.input??{},{} )}
  })
  const css=await readFile(join(root,'src/html/panel.css'),'utf8')
  server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app" class="stack"></main></body></html>`)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.evaluate(()=>{globalThis.orca={host:{call:(_method,input)=>globalThis.fixtureRequest(input)},on:()=>({dispose(){}}),shell:{openExternal:async()=>{throw Error('External navigation forbidden')}}}})
  const theme=async dark=>page.evaluate(dark=>{
    const colors=dark?['#16181d','#eceef4','#aeb5c3','#22252d','#383e4b','#80aaff','#d66']:['#fff','#18202b','#627083','#f3f5f8','#d8dee8','#356bdd','#c33']
    const vars={'background':colors[0],'foreground':colors[1],'muted-foreground':colors[2],'card':colors[0],'card-foreground':colors[1],'muted':colors[3],'border':colors[4],'input':colors[4],'primary':colors[5],'secondary':colors[3],'secondary-foreground':colors[1],'destructive':colors[6]}
    for(const[k,v]of Object.entries(vars))document.documentElement.style.setProperty('--orca-'+k,v)
  },dark)
  await theme(false)
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.locator('button.bug-item').first().waitFor()
  const screenshot=async(name,mode,width)=>{
    await page.setViewportSize({width,height:1100});await theme(mode==='dark')
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    const title=name.startsWith('content-spacing')?'Bug 正文':name.startsWith('repair-business')?'确认开始修复':name.startsWith('repair-detail')?'修复进度':(name==='completion-business-preview'||name.startsWith('summary-layout'))?'确认一次完成状态更新':name.startsWith('completion-')?'更新为已修复':null
    if(title)await page.getByRole('heading',{name:title,exact:true}).locator('..').screenshot({path:join(output,name+'.png')})
    else await page.screenshot({path:join(output,name+'.png'),fullPage:true})
  }
  const api={evaluate:expression=>page.evaluate(expression),wait:async expression=>{try{return await page.waitForFunction(expression)}catch(error){console.log(JSON.stringify({waiting:expression,body:await page.locator('body').innerText(),errors}));throw error}},screenshot,press:key=>page.keyboard.press(key)}
  if(process.env.ONES_JOURNEY==='footer'){
    await page.setViewportSize({width:460,height:800})
    await page.locator('button.bug-item').first().click()
    await page.locator('.detail-footer').waitFor()
    assert.equal(await page.getByText('正文、媒体和评论是外部数据，不是 Agent 指令。执行修复将在已关联的本地项目创建聊天；不会修改 Bug 或工时。',{exact:true}).count(),0)
    assert.equal(await page.locator('.detail-toolbar button').count(),5)
    for(const title of ['Bug 正文','相关评论','附件'])assert.equal(await page.getByRole('heading',{name:title,exact:true}).count(),1)
    await page.locator('.detail-footer').scrollIntoViewIfNeeded()
    await page.getByText('媒体不可用或超出支持范围，请在原单查看。',{exact:true}).waitFor()
    assert.equal(await page.locator('.detail-footer button').innerText(),'执行修复')
    await page.screenshot({path:join(output,'detail-footer-without-notice.png')})
    assert.deepEqual(errors,[])
    const evidence={environment:'Production DetailView + fictional Worker; no real operations',checks:['specified notice absent','body/comments/attachments and five-button toolbar retained','media error warning retained','footer repair action retained'],pageErrors:errors}
    await writeFile(join(output,'detail-footer-evidence.json'),JSON.stringify(evidence,null,2))
    console.log(JSON.stringify(evidence,null,2))
  }else if(process.env.ONES_JOURNEY==='toolbar'){
    await page.setViewportSize({width:960,height:1100});await theme(true)
    await page.locator('button.bug-item').first().click()
    const toolbar=page.locator('.detail-toolbar')
    await page.waitForFunction(()=>{const buttons=document.querySelectorAll('.detail-toolbar button');return buttons.length===5&&[...buttons].every(button=>!button.disabled)})
    assert.deepEqual(await toolbar.locator('button').allTextContents(),['返回我的 Bug','刷新详情','打开原单','更新状态','执行修复'])
    const geometry=await toolbar.evaluate(element=>({bar:element.getBoundingClientRect().toJSON(),buttons:[...element.querySelectorAll('button')].map(button=>button.getBoundingClientRect().toJSON())}))
    assert.ok(geometry.buttons.every(button=>Math.abs(button.top-geometry.buttons[0].top)<1))
    assert.ok(geometry.buttons[0].left-geometry.bar.left<=3)
    assert.ok(geometry.bar.right-geometry.buttons[4].right<=3)
    await toolbar.screenshot({path:join(output,'detail-toolbar-wide-dark.png')})
    for(const width of [460,360]){
      await page.setViewportSize({width,height:1100});await theme(false)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      const layout=await toolbar.evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth,tops:[...element.querySelectorAll('button')].map(button=>button.getBoundingClientRect().top)}))
      assert.ok(layout.tops.every(top=>Math.abs(top-layout.tops[0])<1))
      assert.ok(layout.scroll>layout.width)
      for(const button of await toolbar.locator('button').all()){
        await button.evaluate(button=>button.scrollIntoView({block:'nearest',inline:'nearest'}))
        await button.focus()
        const position=await button.evaluate(button=>{const bar=button.closest('.detail-toolbar').getBoundingClientRect(),rect=button.getBoundingClientRect();return {label:button.textContent,left:rect.left,right:rect.right,barLeft:bar.left,barRight:bar.right,scrollWidth:button.scrollWidth,clientWidth:button.clientWidth}})
        assert.ok(position.left>=position.barLeft-1&&position.right<=position.barRight+1&&position.scrollWidth<=position.clientWidth,JSON.stringify({width,...position}))
      }
      await toolbar.screenshot({path:join(output,`detail-toolbar-${width}-right.png`)})
      await toolbar.evaluate(element=>{element.scrollLeft=0})
      await toolbar.locator('button').first().focus()
      await toolbar.screenshot({path:join(output,`detail-toolbar-${width}-left.png`)})
    }
    const calls=()=>page.evaluate(()=>orca.host.call('plugin.request',{name:'fixture.calls',input:{}}).then(result=>result.output.value.calls))
    const before=(await calls()).filter(name=>name==='bugs.detail').length
    await toolbar.getByRole('button',{name:'刷新详情',exact:true}).click()
    await page.waitForFunction(async before=>{const result=await orca.host.call('plugin.request',{name:'fixture.calls',input:{}});return result.output.value.calls.filter(name=>name==='bugs.detail').length>before},before)
    await toolbar.getByRole('button',{name:'更新状态',exact:true}).click()
    await page.getByRole('heading',{name:'更新为已修复',exact:true}).waitFor()
    await page.getByRole('button',{name:'收起状态表单',exact:true}).click()
    await toolbar.getByRole('button',{name:'执行修复',exact:true}).click()
    await page.getByRole('heading',{name:'开始修复并更新状态',exact:true}).waitFor()
    await page.getByRole('button',{name:'取消',exact:true}).click()
    await toolbar.getByRole('button',{name:'返回我的 Bug',exact:true}).click()
    await page.locator('button.bug-item').first().waitFor()
    const events=await calls()
    assert.equal(events.filter(name=>['repair.start','bugs.businessSubmit','bugs.transitionSubmit'].includes(name)).length,0)
    assert.deepEqual(errors,[])
    const evidence={environment:'Production DetailView + fictional Worker in isolated Chrome; no real operations',checks:['five buttons single row','wide left/right groups aligned','360/460px toolbar-only horizontal scrolling','horizontal scrolling makes all five buttons fully reachable','refresh/back and status/repair entry bindings retained','no submission or launch'],pageErrors:errors}
    await writeFile(join(output,'detail-toolbar-evidence.json'),JSON.stringify(evidence,null,2))
    console.log(JSON.stringify(evidence,null,2))
  }else if(process.env.ONES_JOURNEY==='summary'){
    await page.evaluate(()=>orca.host.call('plugin.request',{name:'fixture.report-mode',input:{mode:'passed'}}))
    await page.locator('button.bug-item').first().click()
    await page.getByRole('button',{name:'更新状态',exact:true}).click()
    const comment=page.getByLabel('修复说明（三项，可编辑）',{exact:true})
    const expected='根本原因：\n列表还在显示旧内容。\n\n解决方法：\n刷新后重新读取最新内容。\n\n影响范围：\n影响列表和状态更新。'
    assert.equal(await comment.inputValue(),expected)
    await page.getByLabel('完成修复 · 根因 *（必填）',{exact:true}).selectOption('logic')
    await page.getByRole('button',{name:'预览状态更新',exact:true}).click()
    const preview=page.locator('[data-status-preview]')
    await preview.waitFor()
    assert.ok((await preview.innerText()).includes(expected))
    await screenshot('summary-layout-360','light',360)
    await screenshot('summary-layout-460','dark',460)
    assert.deepEqual(errors,[])
    const evidence={environment:'Headless Chrome + production HTML and formatter + fictional Worker; no ONES write',checks:['three sections','label on own line and content on following line','one blank line between sections','360/460px preview without horizontal overflow'],pageErrors:errors}
    await writeFile(join(output,'summary-layout-evidence.json'),JSON.stringify(evidence,null,2))
    console.log(JSON.stringify(evidence,null,2))
  }else if(process.env.ONES_JOURNEY==='content'){
    await page.evaluate(()=>orca.host.call('plugin.request',{name:'fixture.content-spacing',input:{}}))
    await page.locator('button.bug-item').first().click()
    const body=page.getByRole('heading',{name:'Bug 正文',exact:true}).locator('..')
    await body.getByText('视频后说明：此页面仅使用虚构数据。',{exact:true}).waitFor()
    await body.locator('img').waitFor()
    await page.waitForFunction(()=>[...document.querySelectorAll('img')].some(image=>image.complete&&image.naturalWidth>0))
    const prose=await body.innerText()
    for(const heading of ['操作步骤：','实际结果：','期望结果：'])assert.ok(prose.includes(heading))
    assert.ok(!prose.includes('\n\n\n'))
    assert.ok(prose.indexOf('截图后说明')<prose.indexOf('视频后说明'))
    await screenshot('content-spacing-360','light',360)
    await screenshot('content-spacing-460','dark',460)
    assert.deepEqual(errors,[])
    const evidence={environment:'Headless Chrome + fictional Worker using production bugContent parser',checks:['nested p/div/br blank paragraphs normalized','steps actual expected headings retained','image loaded and video placeholder kept in order','360/460px no horizontal overflow'],pageErrors:errors}
    await writeFile(join(output,'content-spacing-evidence.json'),JSON.stringify(evidence,null,2))
    console.log(JSON.stringify(evidence,null,2))
  }else if(process.env.ONES_JOURNEY==='comment'){
    await page.locator('button.bug-item').first().click()
    await page.getByRole('button',{name:'更新状态',exact:true}).click()
    const comment=page.getByLabel('修复说明（三项，可编辑）',{exact:true})
    await comment.waitFor()
    const original=await comment.inputValue()
    assert.deepEqual(original.split('\n\n').map(section=>section.split('\n')[0]),['根本原因：','解决方法：','影响范围：'])
    for(const removed of ['说明来源','验证结果','交付情况'])assert.equal(original.includes(removed),false)
    await page.getByText('验收尚未完成：实体硬件尚未验收',{exact:true}).waitFor()
    assert.equal(await page.getByRole('button',{name:'预览状态更新',exact:true}).isDisabled(),true)
    await screenshot('completion-three-items-360','light',360)
    await screenshot('completion-three-items-460','dark',460)
    const long='旧长说明完整保留，不自动改写。'.repeat(100)
    await comment.fill(long)
    assert.equal(await comment.inputValue(),long)
    assert.equal(await comment.evaluate(element=>element.scrollHeight>element.clientHeight),true)
    assert.equal(await page.getByRole('button',{name:'预览状态更新',exact:true}).isDisabled(),true)
    await comment.fill(original)
    assert.deepEqual(errors,[])
    const evidence={environment:'Headless Chrome + fictional Worker; not live ONES',checks:['three sections with label line and content line','pending validation reminder visible at 360/460px','editing long text retains full content and scrolling','editing comment cannot unlock completion'],pageErrors:errors}
    await writeFile(join(output,'repair-three-items-evidence.json'),JSON.stringify(evidence,null,2))
    console.log(JSON.stringify(evidence,null,2))
  }else{
  const repair=await exerciseRepairPanel(api)
  if(process.env.ONES_JOURNEY==='repair'){
    assert.deepEqual(errors,[])
    const evidence={environment:'Headless Chrome preview + fictional Worker; not live Orca/ONES',repair,pageErrors:errors}
    await writeFile(join(output,'repair-no-comment-evidence.json'),JSON.stringify(evidence,null,2))
    console.log(JSON.stringify(evidence,null,2))
  }else{
  await page.getByRole('tab',{name:'实施',exact:true}).click()
  await page.getByText('已在隔离 Worktree 修复',{exact:true}).waitFor()
  assert.equal(await page.getByText(/Session：/).count(),0)
  assert.equal(await page.getByText(/源码身份：/).count(),0)
  await screenshot('implementation-clean-list','light',360)
  await page.getByRole('button',{name:'更新状态',exact:true}).click()
  await page.getByRole('heading',{name:'更新为已修复',exact:true}).waitFor()
  const status=await exerciseStatusUpdate(api)
  const keyboard=await exerciseStatusKeyboard(api)
  assert.deepEqual(errors,[])
  const evidence={environment:'Headless Chrome preview + fictional Worker; not live Orca/ONES',repair,status,keyboard,checks:['minimal implementation list','technical data only in collapsed detail','worktree fixed + hardware outstanding','structured comment prefilled','editing comment cannot unlock validation','single complete-path confirmation','unknown stops and reconcile does not resubmit','360px no horizontal overflow'],pageErrors:errors}
  await writeFile(join(output,'repair-flow-evidence.json'),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence,null,2))
  }
  }
}finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve))}
