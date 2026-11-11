
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Workbench } from '../src/service.ts'
import { authFixture, loginInput, deferred } from './fixtures/remember-auth.ts'
import type { Site } from '../src/domain/model.ts'
const sites: Site[] = ['ones', 'coho']
const day = { team: 'team', date: '2026-01-05', mappingConfirmed: true }

test('saved login: explicit opt-in only, vault only, public status never includes password/token', async () => {
  for (const site of sites) {
    const f = authFixture()
    await f.service.login(loginInput(site))
    assert.equal(f.secrets.has('credentials.' + site), false)
    const input = loginInput(site, true), status = await f.service.login(input)
    assert.equal(input.password, '')
    assert.equal(JSON.parse(f.secrets.get('credentials.' + site)!).password, 'fictional-password')
    assert.equal(f.ordinary.size, 0)
    assert.equal(status[site].savedLogin?.paused, false)
    assert.equal(JSON.stringify(status).includes('fictional-password'), false)
    assert.equal(JSON.stringify(status).includes('fixture-refresh'), false)
    await f.service.login(loginInput(site, false))
    assert.equal(f.secrets.has('credentials.' + site), false)
  }
})
test('saved login: each expired platform restores automatically across restart and reads real business chain', async () => {
  for (const site of sites) {
    const f = authFixture()
    await f.service.login(loginInput(site, true))
    f.expire(site)
    const service = f.restart()
    assert.equal((await service.status())[site].connected, true)
    assert.equal(f.control.passwordCalls[site], 2)
    if (site === 'ones') assert.equal((await service.bugs('team')).items.length, 1)
    else assert.equal((await service.readDay(day)).attendance.punches.length, 2)
  }
})
test('saved login: ONES refresh wins; invalid grant falls back once; network refresh never sends password', async () => {
  for (const mode of ['success', 'invalid', 'network'] as const) {
    const f = authFixture()
    await f.service.login(loginInput('ones', true))
    f.expire('ones', true); f.control.refresh = mode
    const status = await f.restart().status()
    assert.equal(f.control.refreshCalls, 1)
    assert.equal(f.control.passwordCalls.ones, mode === 'invalid' ? 2 : 1)
    assert.equal(status.ones.connected, mode !== 'network')
  }
})
test('saved login: simultaneous status calls share a single password attempt on both sites', async () => {
  for (const site of sites) {
    const f = authFixture()
    await f.service.login(loginInput(site, true)); f.expire(site)
    const started = deferred(), release = deferred()
    f.control.hold = async () => { started.resolve(); await release.promise }
    const service = f.restart(), first = service.status()
    await started.promise
    const rest = [service.status(), service.status()]
    release.resolve()
    await Promise.all([first, ...rest])
    assert.equal(f.control.passwordCalls[site], 2)
  }
})
test('saved login: rejected credentials pause durably, transient failure backs off across restart', async () => {
  for (const site of sites) for (const failure of ['credentials', 'network'] as const) {
    const f = authFixture()
    await f.service.login(loginInput(site, true)); f.expire(site)
    f.control.fail[site] = failure
    const service = f.restart(), status = await service.status()
    assert.equal(status[site].connected, false)
    assert.equal(status[site].savedLogin?.paused, failure === 'credentials')
    if (failure === 'network') assert.ok(status[site].savedLogin!.retryAfter > Date.now())
    await service.status(); await f.restart().status()
    assert.equal(f.control.passwordCalls[site], 2)
  }
})
test('saved login: in-flight persisted claim prevents retries after worker restart', async () => {
  const f = authFixture()
  await f.service.login(loginInput('coho', true)); f.expire('coho')
  const started = deferred(), release = deferred()
  f.control.hold = async () => { started.resolve(); await release.promise }
  const first = f.restart().status()
  await started.promise
  assert.equal((await f.restart().status()).coho.savedLogin?.paused, true)
  assert.equal(f.control.passwordCalls.coho, 2)
  release.resolve(); await first
})
test('saved login: explicit forget and logout cancel delayed password login without resurrecting secrets', async () => {
  for (const site of sites) for (const action of ['forgetLogin', 'logout'] as const) {
    const f = authFixture()
    await f.service.login(loginInput(site, true)); f.expire(site)
    const started = deferred(), release = deferred()
    f.control.hold = async () => { started.resolve(); await release.promise }
    const service = f.restart(), pending = service.status()
    await started.promise
    await service[action](site)
    release.resolve(); await pending
    assert.equal(f.secrets.has('credentials.' + site), false)
    assert.equal((await service.status())[site].connected, false)
    assert.equal((await f.restart().status())[site].savedLogin, undefined)
  }
})
test('saved login: keyring unavailable sends no saved password', async () => {
  const f = authFixture()
  await f.service.login(loginInput('coho', true)); f.expire('coho')
  let writes = 0
  const service = new Workbench({ ...f.deps, protection: async () => false, vault: { ...f.deps.vault, set: async () => { writes++; throw Error('No secret writes permitted') } } })
  assert.equal((await service.status()).coho.connected, false)
  assert.equal(f.control.passwordCalls.coho, 1)
  assert.equal(writes, 0)
})
test('saved login: HTTP/business 401 recovers on next status, never replays business action', async () => {
  for (const site of sites) {
    const f = authFixture()
    await f.service.login(loginInput(site, true))
    // For ONES, make the next server revocation fail refresh to exercise password fallback.
    f.control.refresh = 'invalid'
    f.control.revoked[site] = true
    if (site === 'ones') await assert.rejects(f.service.bugs('team'))
    else await assert.rejects(f.service.readDay(day))
    const business = f.control.businessCalls, calendars = f.control.calendarCalls
    assert.equal((await f.service.status())[site].connected, true)
    assert.equal(f.control.businessCalls, business)
    assert.equal(f.control.calendarCalls, calendars)
    assert.equal(f.control.passwordCalls[site], 2)
  }
})
test('saved login: changed principal pauses instead of accepting another identity', async () => {
  for (const site of sites) {
    const f = authFixture()
    await f.service.login(loginInput(site, true)); f.expire(site)
    f.control.principal[site] = 'someone-else'
    const status = await f.restart().status()
    assert.equal(status[site].connected, false)
    assert.equal(status[site].savedLogin?.paused, true)
  }
})
test('saved login: manual login blocks old automatic credentials and can repair a paused record', async () => {
  const f = authFixture()
  await f.service.login(loginInput('coho', true)); f.expire('coho')
  f.control.fail.coho = 'credentials'
  const service = f.restart(); await service.status()
  delete f.control.fail.coho
  const started = deferred(), release = deferred()
  f.control.hold = async () => { started.resolve(); await release.promise }
  const login = service.login(loginInput('coho', true))
  await started.promise
  await service.status()
  assert.equal(f.control.passwordCalls.coho, 3)
  release.resolve()
  assert.equal((await login).coho.savedLogin?.paused, false)
})
test('saved login: failed paired vault write restores previous session and credentials', async () => {
  const f = authFixture()
  const before = [...f.secrets]
  let fail = true
  const service = new Workbench({ ...f.deps, vault: { ...f.deps.vault, set: async (key, value) => {
    if (key === 'credentials.coho' && fail) { fail = false; throw Error('keyring write failed') }
    await f.deps.vault.set(key, value)
  } } })
  await assert.rejects(service.login(loginInput('coho', true)))
  assert.deepEqual([...f.secrets], before)
})
test('saved login: cancel or logout during credential persistence cannot retain password', async () => {
  for (const logout of [false, true]) {
    const f = authFixture(), started = deferred(), release = deferred(), controller = new AbortController()
    const service = new Workbench({ ...f.deps, vault: { ...f.deps.vault, set: async (key, value) => {
      if (key === 'credentials.coho') { started.resolve(); await release.promise }
      await f.deps.vault.set(key, value)
    } } })
    const pending = assert.rejects(service.login(loginInput('coho', true), controller.signal))
    await started.promise
    const leaving = logout ? service.logout('coho') : Promise.resolve(controller.abort())
    await Promise.resolve()
    release.resolve(); await pending; await leaving
    assert.equal(f.secrets.has('credentials.coho'), false)
  }
})
test('saved login: valid session never triggers password login or business replay', async () => {
  const f = authFixture()
  for (const site of sites) await f.service.login(loginInput(site, true))
  await f.service.status(); await f.restart().status()
  assert.deepEqual(f.control.passwordCalls, { ones: 1, coho: 1 })
  assert.equal(f.control.businessCalls, 0)
})

test('saved login: malformed saved consent and captcha never trigger repeated password attempts', async () => {
  const f = authFixture()
  await f.service.login(loginInput('ones', true)); f.expire('ones')
  const key = 'credentials.ones', valid = f.secrets.get(key)!
  f.secrets.set(key, JSON.stringify({ ...JSON.parse(valid), httpAcknowledged: false }))
  assert.equal((await f.restart().status()).ones.savedLogin, undefined)
  assert.equal(f.control.passwordCalls.ones, 1)
  f.secrets.set(key, valid)
  let attempts = 0
  const service = new Workbench({ ...f.deps, fetcher: async (url, init) => {
    if (String(url).endsWith('/identity/api/login')) { attempts++; return Response.json({ errcode: 'AuthFailure.CaptchaRequired' }) }
    return f.deps.fetcher(url, init)
  } })
  assert.equal((await service.status()).ones.savedLogin?.paused, true)
  await service.status()
  assert.equal(attempts, 1)
})
