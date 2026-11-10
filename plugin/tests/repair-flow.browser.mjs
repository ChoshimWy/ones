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
    const title=name.startsWith('content-spacing')?'Bug 正文':name.startsWith('repair-business')?'确认开始修复':name.startsWith('repair-detail')?'修复进度':name==='completion-business-preview'?'确认一次完成状态更新':name.startsWith('completion-')?'更新为已修复':null
    if(title)await page.getByRole('heading',{name:title,exact:true}).locator('..').screenshot({path:join(output,name+'.png')})
    else await page.screenshot({path:join(output,name+'.png'),fullPage:true})
  }
  const api={evaluate:expression=>page.evaluate(expression),wait:async expression=>{try{return await page.waitForFunction(expression)}catch(error){console.log(JSON.stringify({waiting:expression,body:await page.locator('body').innerText(),errors}));throw error}},screenshot,press:key=>page.keyboard.press(key)}
  if(process.env.ONES_JOURNEY==='content'){
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
    assert.deepEqual(original.split('\n').map(line=>line.split('：')[0]),['根本原因','解决方法','影响范围'])
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
    const evidence={environment:'Headless Chrome + fictional Worker; not live ONES',checks:['three labeled lines only','pending validation reminder visible at 360/460px','editing long text retains full content and scrolling','editing comment cannot unlock completion'],pageErrors:errors}
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
