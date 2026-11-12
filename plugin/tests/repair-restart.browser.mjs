import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Same Chrome/esbuild fixture environment as repair-flow.browser.mjs; no live ONES or Agent calls.
const tooling=process.env.ONES_TOOLING, output=process.env.ONES_EVIDENCE
if(!tooling||!output)throw Error('Set ONES_TOOLING and ONES_EVIDENCE')
const {chromium}=await import(pathToFileURL(join(tooling,'node_modules/@playwright/test/index.mjs')).href)
const {build}=await import(pathToFileURL(join(tooling,'node_modules/esbuild/lib/main.js')).href)
const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
const bundle=await build({stdin:{contents:"import { RepairView } from './src/html/repair.ts'; const view=new RepairView('fixture-detail',()=>{}); document.body.append(view.element); void view.load();",resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'iife',write:false})
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:process.env.ONES_BROWSER})
try {
  const page=await browser.newPage({viewport:{width:460,height:1000}})
  const errors=[],calls=[]
  let state='unknown',fail=false
  page.on('pageerror',e=>errors.push(e.message))
  const record={state:'sent',attemptId:'fixture-attempt',phase:'settled',projectName:'Fixture Project',projectId:'fixture-project',createdAt:1700000000000,sessionId:'fixture-session'}
  await page.exposeFunction('fixtureRequest',async ({name,input})=>{
    calls.push({name,input})
    if(name==='repair.read')return {ok:true,value:record}
    if(name==='repair.result')return {ok:true,value:null}
    if(name==='repair.inspectRestart')return {ok:true,value:{id:'fixture-inspection',record,observation:{state,reason:state==='unknown'?'宿主未自动核实停止状态。':state==='running'?'已发现运行中的原 Agent。':'已确认原 Agent 停止。'},history:[{record:{...record,sessionId:'old-fixture-session'}}]}}
    if(name==='repair.restart'){
      assert.equal(input.confirmed,true)
      assert.equal(input.stoppedConfirmed,true)
      if(fail)return {ok:false,error:{code:'unknown',message:'启动结果待核实'}}
      return {ok:true,value:{...record,attemptId:'fixture-new-attempt',sessionId:'fixture-new-session'}}
    }
    throw Error('Unexpected fixture request '+name)
  })
  const css=await readFile(join(root,'src/html/panel.css'),'utf8')
  await page.setContent('<style>'+css+'</style><main></main>')
  await page.evaluate(()=>{globalThis.orca={host:{call:async(_method,input)=>({output:await globalThis.fixtureRequest(input)})}}})
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  const shot=async(name,dark=false,width=460)=>{
    await page.setViewportSize({width,height:1000})
    await page.evaluate(dark=>{
      const vars=dark?{background:'#16181d',foreground:'#eceef4','muted-foreground':'#aeb5c3',card:'#16181d','card-foreground':'#eceef4',muted:'#22252d',border:'#383e4b',input:'#383e4b',primary:'#80aaff',secondary:'#22252d','secondary-foreground':'#eceef4',destructive:'#d66'}:{background:'#fff',foreground:'#18202b','muted-foreground':'#627083',card:'#fff','card-foreground':'#18202b',muted:'#f3f5f8',border:'#d8dee8',input:'#d8dee8',primary:'#356bdd',secondary:'#f3f5f8','secondary-foreground':'#18202b',destructive:'#c33'}
      for(const[k,v]of Object.entries(vars))document.documentElement.style.setProperty('--orca-'+k,v)
    },dark)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await page.screenshot({path:join(output,name+'.png'),fullPage:true})
  }
  await page.getByRole('button',{name:'核对会话 / 重新执行'}).click()
  await page.getByRole('heading',{name:'核对原 Agent 会话'}).waitFor()
  await page.getByRole('button',{name:'重新执行修复',exact:true}).click()
  await page.getByText('请确认原 Agent 已停止，并填写人工核实依据。',{exact:true}).waitFor()
  assert.equal(calls.filter(x=>x.name==='repair.restart').length,0)
  await shot('restart-unknown-light-360',false,360)
  await page.getByRole('checkbox').check()
  await page.getByLabel('人工核实依据（至少 4 字）').fill('已在宿主终止原 Agent')
  await page.getByRole('button',{name:'重新执行修复',exact:true}).click()
  await page.getByRole('heading',{name:'确认重新执行'}).waitFor()
  // Editing the basis invalidates the displayed confirmation.
  await page.getByLabel('人工核实依据（至少 4 字）').fill('已停止并核实原进程')
  assert.equal(await page.getByRole('button',{name:'确认创建新修复会话'}).count(),0)
  await page.getByRole('button',{name:'重新执行修复',exact:true}).click()
  await shot('restart-confirm-dark-460',true)
  await page.getByRole('button',{name:'确认创建新修复会话'}).click()
  await page.getByRole('heading',{name:'修复进度'}).waitFor()
  assert.equal(calls.filter(x=>x.name==='repair.restart').length,1)
  state='running'
  await page.getByRole('button',{name:'核对会话 / 重新执行'}).click()
  await page.getByText('原 Agent 仍在运行，请返回原会话；不能重新执行。',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'重新执行修复',exact:true}).count(),0)
  await shot('restart-running-light-460')
  state='stopped'
  await page.getByRole('button',{name:'重新核对',exact:true}).click()
  await page.getByText('已确认原 Agent 停止。',{exact:true}).waitFor()
  assert.equal(await page.getByRole('checkbox').count(),0)
  await shot('restart-stopped-dark-460',true)
  fail=true
  await page.getByRole('button',{name:'重新执行修复',exact:true}).click()
  await page.getByRole('button',{name:'确认创建新修复会话'}).click()
  await page.getByRole('button',{name:'重新读取执行记录'}).waitFor()
  assert.equal(await page.getByRole('button',{name:'确认创建新修复会话'}).count(),0)
  assert.equal(calls.filter(x=>x.name==='repair.restart').length,2)
  assert.deepEqual(errors,[])
  const evidence={environment:'Production RepairView + fictional bridge in headless Chrome; no live Agent or ONES writes',checks:['unknown requires checkbox and basis','editing invalidates confirmation','one explicit restart request','running state blocks restart','stopped state confirmation','unknown result does not resend','light 360px / dark 460px no horizontal overflow'],pageErrors:errors}
  await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence))
} finally { await browser.close() }
