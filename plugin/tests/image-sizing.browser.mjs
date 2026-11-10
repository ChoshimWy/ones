import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 真实 MediaView + 虚构受控字节；不连接宿主、外部图片或真实 Bug。
const tooling=process.env.ONES_TOOLING, output=process.env.ONES_EVIDENCE
if(!tooling||!output)throw Error('Set ONES_TOOLING and ONES_EVIDENCE')
const {chromium}=await import(pathToFileURL(join(tooling,'node_modules/@playwright/test/index.mjs')).href)
const {build}=await import(pathToFileURL(join(tooling,'node_modules/esbuild/lib/main.js')).href)
const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
const bundle=await build({stdin:{contents:`import {MediaView} from './src/html/media.ts';let views=[];globalThis.createMedia=(items)=>{for(const view of views)view.dispose();views=items.map(([id,kind,label])=>new MediaView('fixture-detail',id,kind,label));document.querySelector('main').replaceChildren(...views.map(v=>v.element))};globalThis.disposeMedia=()=>{for(const view of views)view.dispose()}`,resolveDir:root},bundle:true,platform:'browser',format:'iife',write:false})
const css=await readFile(join(root,'src/html/panel.css'),'utf8')
const assets=JSON.parse(await readFile(join(root,'tests/fixtures/fixture-assets.json'),'utf8'))
const browser=await chromium.launch({headless:true,executablePath:process.env.ONES_BROWSER})
try{
  await mkdir(output,{recursive:true})
  const page=await browser.newPage({viewport:{width:460,height:900}})
  page.setDefaultTimeout(10000)
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.setContent(`<meta charset="utf-8"><style>${css}main{max-width:540px;margin:auto;display:flex;flex-direction:column;gap:18px}</style><main></main>`)
  await page.evaluate(webm=>{
    const png=(width,height,label)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.fillStyle='#16324a';ctx.fillRect(0,0,width,height);ctx.strokeStyle='#5ed6c5';ctx.lineWidth=Math.min(width,height)/30;ctx.strokeRect(8,8,width-16,height-16);ctx.fillStyle='white';ctx.font=`${Math.min(width,height)/10}px sans-serif`;ctx.fillText(label,width/10,height/2);return canvas.toDataURL('image/png').split(',')[1]}
    const data={portrait:png(600,1800,'PORTRAIT'),landscape:png(1800,600,'LANDSCAPE'),small:png(80,40,'SMALL'),slow:png(100,100,'WAIT'),video:webm}
    globalThis.mediaReads=0
    globalThis.orca={host:{call:async(_method,{name,input})=>{
      if(name!=='bugs.media')throw Error('Unexpected request')
      globalThis.mediaReads++
      if(input.resourceId==='slow')await new Promise(resolve=>{globalThis.releaseSlow=resolve})
      const raw=input.resourceId==='broken'?'PHN2Zz4=':data[input.resourceId]
      return{output:{ok:true,value:{mime:input.resourceId==='broken'?'image/svg+xml':input.resourceId==='video'?'video/webm':'image/png',total:atob(raw).length,offset:0,data:raw,next:null}}}
    }}}
  },assets.webm)
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  const theme=async dark=>page.evaluate(dark=>{
    for(const[key,value]of Object.entries(dark?{background:'#16181d',foreground:'#eceef4',muted:'#22252d',border:'#383e4b',input:'#383e4b',secondary:'#22252d','muted-foreground':'#aeb5c3'}:{background:'#fff',foreground:'#18202b',muted:'#f3f5f8',border:'#d8dee8',input:'#d8dee8',secondary:'#f3f5f8','muted-foreground':'#627083'}))document.documentElement.style.setProperty('--orca-'+key,value)
  },dark)
  await theme(false)
  await page.evaluate(()=>createMedia([['portrait','image','纵向图片'],['landscape','image','横向图片'],['small','image','小尺寸图片'],['video','video','视频不改动']]))
  for(const label of ['纵向图片','横向图片','小尺寸图片']){
    const image=page.getByAltText(label,{exact:true})
    await image.scrollIntoViewIfNeeded()
    await page.waitForFunction(label=>{const image=[...document.querySelectorAll('img')].find(image=>image.alt===label);return image?.complete&&image.naturalWidth>0},label)
  }
  const sizes=await page.locator('.media-image-frame').evaluateAll(frames=>frames.map(frame=>{const img=frame.querySelector('img');return{frame:frame.getBoundingClientRect().height,width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,fit:getComputedStyle(img).objectFit}}))
  for(const size of sizes){assert.equal(size.frame,240);assert.ok(size.height<=240);assert.ok(size.width<=420);assert.equal(size.fit,'contain');assert.ok(Math.abs(size.width/size.height-size.naturalWidth/size.naturalHeight)<0.02)}
  assert.equal(sizes[2].width,80);assert.equal(sizes[2].height,40)
  assert.deepEqual(await page.locator('figcaption').allTextContents(),['纵向图片','横向图片','小尺寸图片','视频不改动'])
  assert.equal(await page.locator('.media-image-frame button, .media-image-frame [tabindex], [aria-haspopup], dialog').count(),0)
  const portrait=page.getByAltText('纵向图片',{exact:true})
  const reads=await page.evaluate(()=>mediaReads)
  await portrait.click()
  assert.equal(await page.locator('dialog').count(),0)
  assert.equal(await portrait.evaluate(image=>image.tabIndex),-1)
  assert.equal(await page.evaluate(()=>mediaReads),reads)
  await page.locator('main').screenshot({path:join(output,'image-sizing-460.png')})
  await page.setViewportSize({width:360,height:900});await theme(true)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.locator('main').screenshot({path:join(output,'image-sizing-360.png')})
  const oldURL=await portrait.getAttribute('src')
  await page.evaluate(()=>disposeMedia())
  assert.equal(await page.locator('img').count(),0)
  assert.equal(await page.evaluate(async url=>{try{await fetch(url);return true}catch{return false}},oldURL),false)
  await page.evaluate(()=>createMedia([['slow','image','加载中图片']]))
  await page.waitForFunction(()=>typeof releaseSlow==='function')
  assert.equal(await page.locator('img,dialog').count(),0)
  await page.evaluate(()=>{disposeMedia();releaseSlow()})
  await page.evaluate(()=>createMedia([['broken','image','安全拒绝图片']]))
  await page.getByText('媒体不可用或超出支持范围，请在原单查看。',{exact:true}).waitFor()
  assert.equal(await page.locator('img,dialog').count(),0)
  await page.evaluate(()=>createMedia([['video','video','视频不改动']]))
  await page.getByRole('button',{name:'加载媒体',exact:true}).click()
  await page.locator('video').waitFor()
  assert.equal(await page.locator('video').evaluate(video=>video.controls&&!video.autoplay&&!video.classList.contains('media-thumbnail')&&getComputedStyle(video).maxHeight==='none'),true)
  assert.equal(await page.locator('.media-image-frame').count(),0)
  assert.deepEqual(errors,[])
  const evidence={environment:'Isolated Chrome + production MediaView + fictional bytes; non-interactive image sizing',sizes,checks:['240px contain portrait/landscape','small image not enlarged','images have no button/tabindex/preview entry','click has no effect or refetch','dispose revokes Blob','pending/failed images not displayed','video unchanged'],pageErrors:errors}
  await writeFile(join(output,'image-sizing-evidence.json'),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence,null,2))
}finally{await browser.close()}
