import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repairPrompt } from '../src/domain/repair-content.ts'

// 仅渲染真实 formatter 生成的虚构消息，不连接 Orca、ONES 或创建 Agent。
const tooling = process.env.ONES_TOOLING, output = process.env.ONES_EVIDENCE
if (!tooling || !output) throw Error('Set ONES_TOOLING and ONES_EVIDENCE')
const { chromium } = await import(pathToFileURL(join(tooling, 'node_modules/@playwright/test/index.mjs')).href)
const prompt = repairPrompt({
  task: { id:'fixture', number:1, name:'虚构缺陷', project:{id:'project',name:'虚构项目'}, issueType:{id:'bug',name:'缺陷'}, status:{id:'pending',name:'待处理'} },
  updatedAt:1, content:[{kind:'text',text:'列表状态刷新后仍显示旧内容。'}], comments:[], attachments:[]
}, new Map(), '/Users/example/Library/Application Support/ones-workbench/repairs/fixture-run/receipt-instructions.md')
assert.ok(!prompt.includes('reportSequence'))
assert.ok(!prompt.includes('"token"'))
const browser = await chromium.launch({ headless:true, executablePath:process.env.ONES_BROWSER })
try {
  await mkdir(output, {recursive:true})
  const page = await browser.newPage({viewport:{width:460,height:900}})
  await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:20px;background:#f4f5f8;font:14px/1.65 system-ui;color:#1d2633}main{padding:18px;background:white;border:1px solid #d8dee8;border-radius:10px}h1{font-size:16px;margin:0 0 14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0}</style><main><h1>修复会话消息 · 虚构渲染预览</h1><pre></pre></main>')
  await page.locator('pre').textContent().then(value=>assert.equal(value,''))
  await page.locator('pre').evaluate((element,value)=>{element.textContent=value},prompt)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.locator('main').screenshot({path:join(output,'repair-prompt-short.png')})
  const evidence={environment:'Isolated Headless Chrome text preview; not Orca chat or live ONES',width:460,checks:['production formatter with fictional Bug','four-line instructions','no inline JSON/token/sequence','no horizontal overflow']}
  await writeFile(join(output,'repair-prompt-evidence.json'),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify(evidence,null,2))
} finally { await browser.close() }
