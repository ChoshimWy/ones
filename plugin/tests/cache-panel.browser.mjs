import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 独立 Chromium 预览，虚构桥接响应；不安装插件、不读取真实 ONES 或启动 Agent。
const tooling = process.env.ONES_TOOLING
const output = process.env.ONES_EVIDENCE
if (!tooling || !output) throw Error('Set ONES_TOOLING and ONES_EVIDENCE to existing tooling and evidence paths')
const { chromium } = await import(pathToFileURL(join(tooling, 'node_modules/@playwright/test/index.mjs')).href)
const { build } = await import(pathToFileURL(join(tooling, 'node_modules/esbuild/lib/main.js')).href)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bundle = await build({ stdin: { contents: `import { ImplementationView } from ${JSON.stringify(join(root,'src/html/implementation.ts'))}; globalThis.createView = () => { globalThis.view?.dispose(); globalThis.view = new ImplementationView('team', () => {}); document.querySelector('main').replaceChildren(globalThis.view.element) }`, resolveDir: root, loader:'ts' }, bundle:true, platform:'browser', format:'iife', write:false })
await mkdir(output,{recursive:true})
const browser = await chromium.launch({headless:true, ...(process.env.ONES_BROWSER ? { executablePath: process.env.ONES_BROWSER } : {})})
try {
  const page = await browser.newPage({viewport:{width:360,height:1000}})
  const errors = []
  page.on('pageerror',e=>errors.push(e.message))
  const css = await readFile(join(root,'src/html/panel.css'),'utf8')
  await page.setContent(`<html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="stack"></main></body></html>`)
  await page.evaluate(() => {
    globalThis.fixture = { syncCalls:0, cacheCalls:0, fail:false, auth:false, hold:true, data:{version:1,syncedAt:1,reconciledAt:1,items:[{task:{id:'fixture',number:88,name:'虚构验证：本地缓存先显示，远端后台同步',project:{id:'p',name:'测试项目'},issueType:{id:'bug',name:'缺陷'},status:{id:'open',name:'待处理'}},record:{state:'sent',projectId:'local',projectName:'虚构本地项目',createdAt:1794186000000,sessionId:'fixture-session'}}]} }
    globalThis.orca = {host:{call:async (_method,{name})=>{
      const f = globalThis.fixture
      if(name==='repair.cache'){f.cacheCalls++;return {output:{ok:true,value:structuredClone(f.data)}}}
      if(name!=='repair.sync') throw Error('Unexpected request '+name)
      f.syncCalls++
      if(f.hold) await new Promise(resolve=>{globalThis.releaseSync=resolve})
      if(f.auth) return {output:{ok:false,error:{code:'auth',message:'认证已失效'}}}
      if(f.fail) return {output:{ok:false,error:{code:'network',message:'网络不可达'}}}
      f.data.syncedAt=Date.now()
      f.data.items[0].report={reportVersion:3,reportSequence:1,rootCause:'旧缓存',solution:'修复刷新',impact:'列表',repair:{state:'fixed',workspace:'isolated_worktree'},validation:{status:'passed',reason:'定向验证通过',remaining:[],evidence:['fixture report'],unitTests:{status:'passed',passed:3,failed:0,skipped:0,notRun:0,total:3}},delivery:{state:'uncommitted',note:'未提交'},sourceIdentity:'fixture source'}
      return {output:{ok:true,value:structuredClone(f.data)}}
    }}}
  })
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  const theme = async dark => page.evaluate(dark => {
    const colors = dark ? ['#16181d','#eceef4','#aeb5c3','#22252d','#383e4b','#80aaff','#d66'] : ['#fff','#18202b','#627083','#f3f5f8','#d8dee8','#356bdd','#c33']
    const vars = {'background':colors[0],'foreground':colors[1],'muted-foreground':colors[2],'card':colors[0],'card-foreground':colors[1],'muted':colors[3],'border':colors[4],'input':colors[4],'primary':colors[5],'secondary':colors[3],'secondary-foreground':colors[1],'destructive':colors[6]}
    for(const [k,v] of Object.entries(vars)) document.documentElement.style.setProperty('--orca-'+k,v)
  },dark)
  await theme(false)
  await page.evaluate(()=>globalThis.createView())
  await page.getByText(/^正在同步/).waitFor()
  await page.getByRole('heading',{name:'#88 虚构验证：本地缓存先显示，远端后台同步',exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>globalThis.fixture.syncCalls),1)
  await page.screenshot({path:join(output,'cache-first-light.png'),fullPage:true})
  await page.evaluate(()=>{globalThis.fixture.hold=false;globalThis.releaseSync()})
  await page.getByText('已在隔离 Worktree 修复',{exact:true}).waitFor()
  assert.equal(await page.getByText('Session：fixture-session',{exact:true}).count(),0)
  await theme(true)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.screenshot({path:join(output,'receipt-dark-narrow.png'),fullPage:true})
  await page.evaluate(()=>globalThis.createView())
  await page.getByText(/^本地记录/).waitFor()
  assert.equal(await page.evaluate(()=>globalThis.fixture.syncCalls),1)
  await page.evaluate(()=>globalThis.view.poll(false))
  assert.equal(await page.getByRole('button',{name:'刷新执行记录'}).isEnabled(),true)
  await page.evaluate(()=>{globalThis.fixture.fail=true})
  await page.getByRole('button',{name:'刷新执行记录'}).click()
  await page.getByText('同步失败，当前显示上次缓存（可能过期）：网络不可达',{exact:true}).waitFor()
  await page.getByRole('heading',{name:'#88 虚构验证：本地缓存先显示，远端后台同步',exact:true}).waitFor()
  await page.screenshot({path:join(output,'sync-failed-cache.png'),fullPage:true})
  await page.evaluate(()=>{globalThis.fixture.auth=true})
  await page.getByRole('button',{name:'刷新执行记录'}).click()
  await page.getByText('执行记录不可用：认证已失效',{exact:true}).waitFor()
  assert.equal(await page.getByText('Session：fixture-session',{exact:true}).count(),0)
  await page.evaluate(()=>{globalThis.fixture.auth=false;globalThis.fixture.fail=false;globalThis.fixture.hold=true;globalThis.fixture.data.syncedAt=1;globalThis.createView()})
  await page.getByText(/^正在同步/).waitFor()
  await page.evaluate(()=>{globalThis.view.dispose();document.querySelector('main').textContent='已切换页面';globalThis.releaseSync()})
  await page.waitForTimeout(100)
  assert.equal(await page.locator('main').innerText(),'已切换页面')
  assert.deepEqual(errors,[])
  const evidence={environment:'Headless Chromium preview; fictional bridge, not live Orca/ONES',checks:['cache visible before unresolved network','fresh reentry skips network','Agent report distinct from independent verification','remote status unchanged','failed sync retains marked cache','auth failure hides private cache','disposed view ignores late response','360px no horizontal overflow'],screenshots:['cache-first-light.png','receipt-dark-narrow.png','sync-failed-cache.png'],pageErrors:errors}
  await writeFile(join(output,'browser-evidence.json'),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence,null,2))
} finally {await browser.close()}
