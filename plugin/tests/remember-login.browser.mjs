
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { authFixture, accounts } from './fixtures/remember-auth.ts'
import { safeFailure } from '../src/domain/model.ts'

const tooling = process.env.ONES_TOOLING, output = process.env.ONES_EVIDENCE
if (!tooling || !output) throw Error('Set ONES_TOOLING and ONES_EVIDENCE')
const { chromium } = await import(pathToFileURL(join(tooling, 'node_modules/@playwright/test/index.mjs')).href)
const { build } = await import(pathToFileURL(join(tooling, 'node_modules/esbuild/lib/main.js')).href)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bundle = await build({ stdin: { contents: `import { WorkbenchUI } from ${JSON.stringify(join(root, 'src/html/panel.ts'))}; globalThis.ui = new WorkbenchUI(document.querySelector('main'))`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', write: false })
await mkdir(output, { recursive: true })
const fixture = authFixture()
let service = fixture.service
const browser = await chromium.launch({ headless: true, executablePath: process.env.ONES_BROWSER })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('fixtureRequest', async ({ name, input }) => {
    try {
      let value
      if (name === 'status') value = await service.status()
      else if (name === 'auth.login') value = await service.login(input)
      else if (name === 'auth.logout') value = await service.logout(input.site)
      else if (name === 'auth.forget') value = await service.forgetLogin(input.site)
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
  const settled = () => page.waitForFunction(() => !globalThis.ui.busy && !globalThis.ui.statusSync)
  const checkbox = site => page.getByLabel((site === 'ones' ? 'ONES' : 'Coho') + ' 保存账号密码并自动登录', { exact: true })
  await badge('ONES 已认证').waitFor()
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  // Unchanged resume status must not replace the clicked/focused form controls.
  // Native host focus can arrive between pointerdown and click.
  await settled()
  await page.evaluate(() => { globalThis.focusedControl = document.getElementById('Coho 密码'); globalThis.focusedControl.focus(); window.dispatchEvent(new Event('focus')) })
  await settled()
  assert.equal(await page.evaluate(() => globalThis.focusedControl === document.getElementById('Coho 密码') && document.activeElement === globalThis.focusedControl), true)
  for (const site of ['ones', 'coho']) {
    const name = site === 'ones' ? 'ONES' : 'Coho'
    assert.equal(await checkbox(site).isChecked(), false)
    await page.getByLabel(site === 'ones' ? 'ONES 邮箱' : 'Coho 账号', { exact: true }).fill(accounts[site])
    await page.getByLabel(name + ' 密码', { exact: true }).fill('fictional-password')
    await checkbox(site).check()
    if (site === 'ones') await page.getByLabel('我确认仅在可信内网使用 HTTP，了解密码及令牌的传输风险', { exact: true }).check()
    await page.getByRole('button', { name: '登录 ' + name, exact: true }).click()
    await settled()
    assert.equal(fixture.secrets.has('credentials.' + site), true)
    assert.equal(await page.getByLabel(name + ' 密码', { exact: true }).inputValue(), '')
  }
  await page.screenshot({ path: join(output, 'saved-login-both-dark.png'), fullPage: true })
  // Expiry while asleep, simulated only in the fictional vault; never touches a live token.
  fixture.expire('ones', true); fixture.expire('coho')
  fixture.control.refresh = 'invalid'
  service = fixture.restart()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await settled()
  assert.deepEqual(fixture.control.passwordCalls, { ones: 2, coho: 2 })
  await badge('ONES 已认证').waitFor(); await badge('Coho 已认证').waitFor()
  // Actual read fails once, status restores authentication, old failure is not kept under green badges.
  fixture.control.revoked.ones = true
  await page.getByRole('tab', { name: '我的 Bug', exact: true }).click()
  await page.getByText('登录已恢复，请重新读取数据；未自动重试任何写入。', { exact: true }).waitFor()
  assert.equal(fixture.control.passwordCalls.ones, 3)
  assert.equal(await page.getByText(/认证已失效/).count(), 0)
  await page.getByRole('button', { name: '刷新缺陷', exact: true }).click()
  await page.locator('button.bug-item').waitFor()
  await page.screenshot({ path: join(output, 'saved-login-recovered.png'), fullPage: true })
  await page.getByRole('tab', { name: '登录', exact: true }).click()
  await checkbox('ones').uncheck()
  await settled()
  assert.equal(fixture.secrets.has('credentials.ones'), false)
  assert.equal(fixture.secrets.has('session.ones'), true)
  // Wrong stored password pauses; repeated focus never loops login.
  fixture.expire('coho'); fixture.control.fail.coho = 'credentials'
  service = fixture.restart()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.getByText('自动登录已暂停，请手动登录更新凭据。', { exact: true }).waitFor()
  await badge('Coho 未登录').waitFor()
  const attempts = fixture.control.passwordCalls.coho
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await settled()
  assert.equal(fixture.control.passwordCalls.coho, attempts)
  await theme(false); await page.setViewportSize({ width: 360, height: 1000 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(output, 'saved-login-paused-light-360.png'), fullPage: true })
  await page.getByRole('button', { name: '退出 Coho', exact: true }).click()
  await settled()
  assert.equal(fixture.secrets.has('credentials.coho'), false)
  assert.equal(fixture.secrets.has('session.coho'), false)
  assert.equal(await checkbox('coho').isChecked(), false)
  // Recovery must also clear the stale error when only one platform is configured.
  await page.getByLabel('ONES 密码', { exact: true }).fill('fictional-password')
  await checkbox('ones').check()
  await page.getByRole('button', { name: '登录 ONES', exact: true }).click()
  await settled()
  fixture.control.revoked.ones = true
  await page.getByRole('tab', { name: '我的 Bug', exact: true }).click()
  await page.getByText('登录状态已更新，请检查未登录的平台；未自动重试任何写入。', { exact: true }).waitFor()
  await badge('ONES 已认证').waitFor(); await badge('Coho 未登录').waitFor()
  assert.equal(await page.getByText(/认证已失效/).count(), 0)
  assert.deepEqual(errors, [])
  const evidence = {
    environment: 'Headless Chrome; production HTML + Workbench; fictional HTTP/Vault only',
    checks: ['unchanged focus preserves form nodes and keyboard focus', 'both checkboxes default off', 'successful opt-in stores credentials only in fixture vault', 'password fields cleared and never refilled', 'expiry/focus restores both accounts with ONES refresh fallback', 'auth error recovery clears contradictory error and next explicit read succeeds', 'uncheck deletes saved password without logging out valid session', 'wrong password pauses across repeated focus', 'logout clears saved credentials even while disconnected', '360px no horizontal overflow', 'single-platform recovery also clears stale auth errors'],
    pageErrors: errors,
    screenshots: ['saved-login-both-dark.png', 'saved-login-recovered.png', 'saved-login-paused-light-360.png']
  }
  await writeFile(join(output, 'remember-browser-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally { await browser.close() }
