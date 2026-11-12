import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Workbench, type Vault } from '../src/service.ts'
import { type Fetcher } from '../src/adapters/http.ts'

const ones = { token: 'fixture-ones', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt: Date.now() + 172800000 }
const coho = { token: 'fixture-old', principal: 'owner', label: 'Fixture', expiresAt: null }
function fixture(fetcher?: Fetcher) {
  const data = new Map<string, string>([['session.ones', JSON.stringify(ones)], ['session.coho', JSON.stringify(coho)]])
  const vault: Vault = { get: async key => data.get(key) ?? null, set: async (key, value) => { data.set(key, value) }, delete: async key => { data.delete(key) } }
  const deps = { store: vault, vault, protection: async () => true, fetcher }
  return { data, vault, deps, service: new Workbench(deps) }
}
const login = () => ({ site: 'coho' as const, account: 'fixture', password: 'fixture-password', httpAcknowledged: false })
const json = (data: unknown, status = 200) => Response.json(data, { status })
const auth: Fetcher = async url => String(url).endsWith('requestToken') ? json({ code: 200, data: { token: 'fixture-new' } }) : json({ code: 200, data: { tenantCode: 'ATS', globalId: 'owner' } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const day = { team: 'team', date: '2026-01-05' }

test('auth lifecycle: reload restores both sites without network or deletion', async () => {
  const f = fixture(async () => { throw Error('unexpected network') })
  const before = [...f.data]
  for (const service of [f.service, new Workbench(f.deps)]) {
    const status = await service.status()
    assert.equal(status.ones.connected, true)
    assert.equal(status.coho.connected, true)
  }
  assert.deepEqual([...f.data], before)
})

test('auth lifecycle: transient vault failure retries; malformed/expired records are not erased on restore', async () => {
  const f = fixture()
  let fail = true
  const service = new Workbench({ ...f.deps, vault: { ...f.vault, get: async key => { if (fail) throw Error('locked'); return f.vault.get(key) } } })
  await assert.rejects(service.status())
  fail = false
  assert.equal((await service.status()).ones.connected, true)
  f.data.set('session.ones', JSON.stringify({ ...ones, expiresAt: 1 }))
  f.data.set('session.coho', 'invalid-json')
  const before = [...f.data]
  const status = await new Workbench(f.deps).status()
  assert.equal(status.ones.connected, false)
  assert.equal(status.coho.connected, false)
  assert.deepEqual([...f.data], before)
})

test('auth lifecycle: failed replacement login preserves old session across restart', async () => {
  const f = fixture(async () => json({}, 401))
  const before = [...f.data]
  await assert.rejects(f.service.login(login()))
  assert.deepEqual([...f.data], before)
  assert.equal((await new Workbench(f.deps).status()).coho.connected, true)
})

test('auth lifecycle: cancellation during persistence restores previous session', async () => {
  const f = fixture(auth), started = deferred<void>(), finish = deferred<void>()
  const controller = new AbortController()
  const service = new Workbench({ ...f.deps, vault: { ...f.vault, set: async (key, value) => { started.resolve(); await finish.promise; await f.vault.set(key, value) } } })
  const before = [...f.data]
  const rejected = assert.rejects(service.login(login(), controller.signal))
  await started.promise
  controller.abort(); finish.resolve(); await rejected
  assert.deepEqual([...f.data], before)
  assert.equal((await new Workbench(f.deps).status()).coho.connected, true)
})

function dayFetcher(cohoResponse: () => Promise<Response>): Fetcher {
  return async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/users/me')) return json({ uuid: 'owner' })
    if (path.endsWith('/info')) return json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
    if (path.endsWith('/getCurrentUser') && new Headers(init?.headers).get('Authorization') === 'Bearer fixture-old') return cohoResponse()
    if (path.endsWith('/getInfoByDateAndUser')) return json({ code: 200, data: { kqqs: 'period' } })
    if (path.endsWith('/attCalendar')) return json({ code: 200, data: { dateList: [{ date: day.date }], workList: [], dkList: ['09:00', '18:30'].map(time => ({ date: day.date, realDate: day.date, time, isNext: false, outFence: false })) } })
    if (path.endsWith('/items/graphql')) return json({ data: { buckets: [{ manhours: [], pageInfo: { hasNextPage: false, endCursor: '', unstable: false } }] } })
    return auth(url, init)
  }
}

test('auth lifecycle: old request 401 cannot remove replacement login', async () => {
  const started = deferred<void>(), response = deferred<Response>()
  const f = fixture(dayFetcher(() => { started.resolve(); return response.promise }))
  const rejected = assert.rejects(f.service.readDay(day))
  await started.promise
  await f.service.login(login())
  response.resolve(json({}, 401)); await rejected
  assert.equal((await f.service.readDay(day)).attendance.punches.length, 2)
  assert.equal(JSON.parse(f.data.get('session.coho')!).token, 'fixture-new')
  assert.equal((await new Workbench(f.deps).status()).coho.connected, true)
})

test('auth lifecycle: current server 401 revokes only affected site; 503 retains it', async () => {
  for (const code of [401, 503]) {
    const f = fixture(dayFetcher(async () => json({}, code)))
    await assert.rejects(f.service.readDay(day))
    const status = await new Workbench(f.deps).status()
    assert.equal(status.ones.connected, true)
    assert.equal(status.coho.connected, code !== 401)
  }
})

test('auth lifecycle: successful login has no invented Coho TTL; explicit logout persists', async () => {
  const f = fixture(auth)
  await f.service.login(login())
  assert.equal(JSON.parse(f.data.get('session.coho')!).expiresAt, null)
  await f.service.logout('coho')
  assert.equal((await new Workbench(f.deps).status()).coho.connected, false)
  assert.equal((await f.service.status()).ones.connected, true)
})

test('auth lifecycle: expired ONES cannot send business requests', async () => {
  let requests = 0
  const f = fixture(async () => { requests++; throw Error('unexpected network') })
  f.data.set('session.ones', JSON.stringify({ ...ones, expiresAt: 1 }))
  await assert.rejects(f.service.bugs('team'))
  assert.equal(requests, 0)
  assert.equal((await f.service.status()).ones.connected, false)
})

test('auth lifecycle: logout during login persistence cannot resurrect a session', async () => {
  const f = fixture(auth), started = deferred<void>(), finish = deferred<void>()
  const service = new Workbench({ ...f.deps, vault: { ...f.vault, set: async (key, value) => { started.resolve(); await finish.promise; await f.vault.set(key, value) } } })
  const rejected = assert.rejects(service.login(login()))
  await started.promise
  const logout = service.logout('coho')
  await Promise.resolve()
  finish.resolve()
  await rejected; await logout
  assert.equal((await new Workbench(f.deps).status()).coho.connected, false)
  assert.equal(f.data.has('session.coho'), false)
})
