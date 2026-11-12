import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tooling = process.env.ONES_TOOLING, output = process.env.ONES_EVIDENCE
if (!tooling || !output) throw Error('Set ONES_TOOLING and ONES_EVIDENCE')
const { chromium } = await import(pathToFileURL(join(tooling, 'node_modules/@playwright/test/index.mjs')).href)
const { build } = await import(pathToFileURL(join(tooling, 'node_modules/esbuild/lib/main.js')).href)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bundle = await build({ stdin: { contents: `import { HoursView } from ${JSON.stringify(join(root, 'src/html/hours.ts'))}; import { WorkbenchUI } from ${JSON.stringify(join(root, 'src/html/panel.ts'))}; globalThis.HoursView=HoursView; globalThis.WorkbenchUI=WorkbenchUI;`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', write: false })
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.ONES_BROWSER ? { executablePath: process.env.ONES_BROWSER } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(`<html><head><style>${await readFile(join(root, 'src/html/panel.css'), 'utf8')}</style></head><body><main></main></body></html>`)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.evaluate(() => {
    globalThis.setup = (mode, outcome = 'success') => {
      const f = globalThis.fixture = { writes: 0, previews: 0, outcome, mode, hold: false }
      const app = globalThis.app = {
        epoch: 0, disposed: false, busy: false, team: 'fixture-team', error: '', info: '',
        status: { identity: 'fixture', ones: { connected: true }, coho: { connected: true }, writeEnabled: true },
        records: { clear() {} },
        run: WorkbenchUI.prototype.run, invalidate: WorkbenchUI.prototype.invalidate, invalidateDay: WorkbenchUI.prototype.invalidateDay,
        render() {
          const main = document.querySelector('main')
          main.replaceChildren()
          const notice = document.createElement('p')
          notice.textContent = this.error || this.info
          main.append(notice, this.hours.render())
        }
      }
      const v = app.hours = new HoursView(app)
      v.calendarMonth = '2026-02'
      v.date = '2026-02-03'
      v.day = { id: 'day', date: v.date, existing: 0, worklogs: [], attendance: { date: v.date, fetchedAt: Date.now(), punches: ['08:53', '18:32'].map(time => ({ date: v.date, realDate: v.date, time, isNext: false, outFence: false })) } }
      v.tasks = [{ id: 'task', number: 1, name: '虚构普通任务', project: { id: 'p', name: '项目' }, issueType: { id: 't', name: '任务' }, status: { id: 's', name: '进行中' } }]
      v.allocations = [{ taskId: 'task', start: '09:00', minutes: 480, description: '虚构任务完成记录' }]
      v.batchTask = 'task'
      v.batchDescription = '虚构逐日实际工作记录'
      if (mode === 'batch') for (const date of ['2026-02-03', '2026-02-04', '2026-02-05']) v.batchRows.set(date, { minutes: '480', start: '09:00' })
      v.months.set('2026-02', { month: '2026-02', savedAt: Date.now(), days: [] })
      globalThis.orca = { host: { call: async (_method, { name, input }) => {
        if (name === 'hours.preview') {
          f.previews++
          return { output: { ok: true, value: { id: 'single', date: v.date, budget: 480, existing: 0, proposed: 480, remaining: 0, expiresAt: Date.now() + 300000, rows: input.allocations.map(r => ({ ...r, taskName: '虚构普通任务' })) } } }
        }
        if (name === 'hours.batchPreview') {
          f.previews++
          return { output: { ok: true, value: { id: 'batch', total: 1440, expiresAt: Date.now() + 300000, rows: input.rows.map(r => ({ ...r, budget: 480, existing: 0, taskName: '虚构普通任务' })) } } }
        }
        if (name === 'hours.submit' || name === 'hours.batchSubmit') {
          if (!input.confirmed) throw Error('missing confirmation')
          f.writes++
          if (f.hold) await new Promise(resolve => { globalThis.release = resolve })
          if (f.outcome === 'transport') throw Error('reply lost')
          if (name === 'hours.submit') return { output: { ok: true, value: { count: 1 } } }
          return { output: { ok: true, value: { rows: ['2026-02-03', '2026-02-04', '2026-02-05'].map((date, i) => ({ date, state: i === 0 ? 'verified' : i === 1 ? 'unknown' : 'not_attempted', message: i === 0 ? '已提交并回读一致' : i === 1 ? '写入结果需先核实，不可重试' : '尚未发送' })) } } }
        }
        throw Error('Unexpected request: ' + name)
      } } }
      app.render()
    }
  })
  const theme = async dark => page.evaluate(dark => {
    const palette = dark ? ['#16181d', '#eceef4', '#aeb5c3', '#22252d', '#383e4b', '#80aaff'] : ['#ffffff', '#18202b', '#627083', '#f3f5f8', '#d8dee8', '#356bdd']
    for (const [key, value] of Object.entries({ background: palette[0], foreground: palette[1], 'muted-foreground': palette[2], card: palette[0], 'card-foreground': palette[1], muted: palette[3], border: palette[4], input: palette[4], primary: palette[5], secondary: palette[3], 'secondary-foreground': palette[1] })) document.documentElement.style.setProperty('--orca-' + key, value)
  }, dark)
  await theme(false)
  await page.evaluate(() => setup('single'))
  await page.getByRole('button', { name: '校验并预览', exact: true }).click()
  const single = page.getByRole('button', { name: '确认提交到 ONES', exact: true })
  assert.equal(await single.isDisabled(), true)
  await page.getByLabel('我确认上述任务、原日期、时长和每笔描述').check()
  assert.equal(await single.isEnabled(), true)
  await page.screenshot({ path: join(output, 'single-confirm-light.png'), fullPage: true })
  await page.evaluate(() => { fixture.hold = true })
  await single.click()
  assert.equal(await single.isDisabled(), true)
  await page.evaluate(() => release())
  await page.getByText('已逐笔回读 1 笔工时。', { exact: true }).waitFor()
  assert.equal(await single.count(), 0)
  assert.equal(await page.evaluate(() => fixture.writes), 1)

  await page.setViewportSize({ width: 360, height: 900 })
  await theme(true)
  await page.evaluate(() => setup('batch'))
  await page.getByRole('button', { name: '校验批量工时并预览' }).click()
  const batch = page.getByRole('button', { name: '确认批量提交到 ONES' })
  assert.equal(await batch.isDisabled(), true)
  await page.getByLabel('确认每个日期、普通任务、实际时长和描述').check()
  assert.equal(await batch.isEnabled(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(output, 'batch-confirm-dark-360.png'), fullPage: true })
  // Editing a field revokes confirmation before any write.
  await page.getByLabel('2026-02-04 时长（分钟）').fill('240')
  assert.equal(await batch.count(), 0)
  assert.equal(await page.evaluate(() => fixture.writes), 0)
  await page.getByRole('button', { name: '校验批量工时并预览' }).click()
  await page.getByLabel('确认每个日期、普通任务、实际时长和描述').check()
  await batch.click()
  await page.getByText('2026-02-04 · 结果待核实 · 写入结果需先核实，不可重试', { exact: true }).waitFor()
  assert.equal(await page.getByText('2026-02-05 · 未提交 · 尚未发送', { exact: true }).count(), 1)
  assert.equal(await batch.count(), 0)
  assert.equal(await page.evaluate(() => app.hours.batchRows.has('2026-02-03')), false)
  assert.equal(await page.evaluate(() => app.hours.day), null)
  assert.equal(await page.evaluate(() => app.hours.months.has('2026-02')), false)
  await page.screenshot({ path: join(output, 'batch-partial-dark-360.png'), fullPage: true })

  for (const mode of ['single', 'batch']) {
    await page.evaluate(mode => setup(mode, 'transport'), mode)
    await page.getByRole('button', { name: mode === 'single' ? '校验并预览' : '校验批量工时并预览', exact: true }).click()
    await page.getByLabel(mode === 'single' ? '我确认上述任务、原日期、时长和每笔描述' : '确认每个日期、普通任务、实际时长和描述').check()
    await page.getByRole('button', { name: mode === 'single' ? '确认提交到 ONES' : '确认批量提交到 ONES', exact: true }).click()
    await page.getByText('操作未完成，请检查连接后重试；未知写入结果不可重发。', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => fixture.writes), 1)
    assert.equal(await page.evaluate(() => app.hours.preview === null && app.hours.batchPreview === null && app.hours.day === null && !app.hours.months.has('2026-02') && app.hours.queue.includes('2026-02')), true)
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(output, 'batch-unknown-dark-360.png'), fullPage: true })
  assert.deepEqual(errors, [])
  const evidence = { environment: 'Headless Chromium; production HoursView and WorkbenchUI.run; fictional bridge; no live business writes', checks: ['explicit confirmation', 'single busy and success', 'batch editing revokes preview', 'partial results and untouched dates', 'single and batch lost replies clear preview/day/month and enqueue refresh', '360px no horizontal overflow'], screenshots: ['single-confirm-light.png', 'batch-confirm-dark-360.png', 'batch-partial-dark-360.png', 'batch-unknown-dark-360.png'], pageErrors: errors }
  await writeFile(join(output, 'browser-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally { await browser.close() }
