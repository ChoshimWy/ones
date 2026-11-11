
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Workbench } from '../src/service.ts'
import { safeFailure } from '../src/domain/model.ts'

const tooling = process.env.ONES_TOOLING, output = process.env.ONES_EVIDENCE
if (!tooling || !output) throw Error('Set ONES_TOOLING and ONES_EVIDENCE')
const { chromium } = await import(pathToFileURL(join(tooling, 'node_modules/@playwright/test/index.mjs')).href)
const { build } = await import(pathToFileURL(join(tooling, 'node_modules/esbuild/lib/main.js')).href)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bundle = await build({ stdin: { contents: `import { WorkbenchUI } from ${JSON.stringify(join(root, 'src/html/panel.ts'))}; globalThis.ui = new WorkbenchUI(document.querySelector('main'))`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', write: false })
await mkdir(output, { recursive: true })
let now = Date.now(), refreshes = 0, offline = false, revoked = false, statuses = 0
const realNow = Date.now
Date.now = () => now
const ones = { token: 'fixture-access', refreshToken: 'fixture-refresh', userId: 'owner', label: '虚构用户', teams: [{ id: 'team', name: '验证团队' }], expiresAt: now + 120000 }
const data = new Map([['session.ones', JSON.stringify(ones)], ['session.coho', JSON.stringify({ token: 'fixture-coho', principal: 'owner', label: '虚构用户', expiresAt: null })]])
const vault = { get: async key => data.get(key) ?? null, set: async (key, value) => { data.set(key, value) }, delete: async key => { data.delete(key) } }
const service = new Workbench({ store: vault, vault, protection: async () => true, fetcher: async (url, init) => {
  const path = new URL(String(url)).pathname
  if (path === '/identity/oauth/token') {
    refreshes++
    if (offline) throw Error('fixture offline')
    if (revoked) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    return Response.json({ access_token: 'fixture-renewed', refresh_token: 'fixture-rotated', token_type: 'Bearer', expires_in: 3600 })
  }
  if (revoked) return Response.json({}, { status: 401 })
  if (path.endsWith('/users/me')) return Response.json({ uuid: 'owner' })
  if (path.endsWith('/issue_types')) return Response.json({ issue_types: [{ uuid: 'bug', name: '缺陷', built_in: true, type: 0, detail_type: 3, default_configs: { default_task_status_configs: [{ status_uuid: 'open' }] } }] })
  if (path.endsWith('/items/graphql')) return Response.json({ data: { buckets: [{ tasks: [{ uuid: 'fixture-task', number: 1, name: '虚构缺陷：解锁后仍可读取', project: { uuid: 'project', name: '验证项目' }, issueType: { uuid: 'bug', name: '缺陷' }, status: { uuid: 'open', name: '待处理' } }], pageInfo: { hasNextPage: false, endCursor: '', unstable: false } }] } })
  throw Error('Unexpected fixture endpoint')
} })
const browser = await chromium.launch({ headless: true, executablePath: process.env.ONES_BROWSER })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('fixtureRequest', async ({ name, input }) => {
    try {
      let value
      if (name === 'status') { statuses++; value = await service.status() }
      else if (name === 'bugs.list') value = await service.bugs(input.team, input.after)
      else if (name === 'bugs.projectFilter') value = { localProject: null, project: null }
      else throw Error('Unexpected request ' + name)
      return { output: { ok: true, value } }
    } catch (error) { return { output: { ok: false, error: safeFailure(error) } } }
  })
  const css = await readFile(join(root, 'src/html/panel.css'), 'utf8')
  await page.setContent(`<html lang="zh-CN"><head><meta charset="utf-8"><style>${css}</style></head><body><main class="stack"></main></body></html>`)
  await page.evaluate(() => {
    globalThis.orca = { host: { call: (_method, input) => globalThis.fixtureRequest(input) }, on: () => ({ dispose() {} }) }
  })
  const theme = async dark => page.evaluate(dark => {
    const colors = dark ? ['#16181d', '#eceef4', '#aeb5c3', '#22252d', '#383e4b', '#80aaff', '#d66'] : ['#fff', '#18202b', '#627083', '#f3f5f8', '#d8dee8', '#356bdd', '#c33']
    const vars = { background: colors[0], foreground: colors[1], 'muted-foreground': colors[2], card: colors[0], 'card-foreground': colors[1], muted: colors[3], border: colors[4], input: colors[4], primary: colors[5], secondary: colors[3], 'secondary-foreground': colors[1], destructive: colors[6] }
    for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty('--orca-' + key, value)
  }, dark)
  await theme(true)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const badge = value => page.getByText(value, { exact: true })
  const refresh = () => page.getByRole('button', { name: '刷新缺陷', exact: true })
  await page.locator('button.bug-item').waitFor()
  await badge('ONES 已认证').waitFor()
  assert.equal(refreshes, 0)
  // Wall clock advances during sleep. Focus causes real Workbench renewal, no password.
  now += 180000
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => !globalThis.ui.statusSync)
  assert.equal(refreshes, 1)
  assert.equal(JSON.parse(data.get('session.ones')).refreshToken, 'fixture-rotated')
  await refresh().click()
  await page.locator('button.bug-item').waitFor()
  await badge('ONES 已认证').waitFor()
  assert.equal(await page.locator('.notice.danger').count(), 0)
  await page.screenshot({ path: join(output, 'auth-resumed-dark.png'), fullPage: true })
  // Temporary failure keeps credentials, disconnected UI can recover on next visibility event.
  now += 3700000; offline = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await badge('ONES 未登录').waitFor()
  assert.equal(data.has('session.ones'), true)
  assert.equal(await page.locator('button.bug-item').count(), 0)
  offline = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await badge('ONES 已认证').waitFor()
  await refresh().click()
  await page.locator('button.bug-item').waitFor()
  // Remote auth failure synchronizes the badges and removes private cached rows.
  revoked = true
  await refresh().click()
  await badge('ONES 未登录').waitFor()
  await badge('Coho 已认证').waitFor()
  assert.equal(await badge('ONES 已认证').count(), 0)
  assert.equal(await page.locator('button.bug-item').count(), 0)
  assert.equal(await refresh().isDisabled(), true)
  assert.equal(data.has('session.ones'), false)
  await theme(false)
  await page.setViewportSize({ width: 360, height: 1000 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(output, 'auth-expired-light-360.png'), fullPage: true })
  await page.evaluate(() => globalThis.ui.dispose())
  const count = statuses
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  assert.equal(statuses, count)
  assert.deepEqual(errors, [])
  const evidence = { environment: 'Headless Chrome; production HTML + Workbench, fictional HTTP/vault; not physical lock/unlock or live ONES', checks: ['focus renews expired session and next bug read succeeds', 'visibility failure preserves vault and hides stale rows', 'next resume recovers without password', '401 synchronizes ONES badge and clears cache while Coho stays connected', 'disposed listeners do not send requests', '360px no horizontal overflow'], refreshes, pageErrors: errors, screenshots: ['auth-resumed-dark.png', 'auth-expired-light-360.png'] }
  await writeFile(join(output, 'auth-browser-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally { Date.now = realNow; await browser.close() }
