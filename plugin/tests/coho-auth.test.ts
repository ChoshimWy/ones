
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginCoho } from '../src/adapters/coho.ts'
import { COHO, Transport, type Fetcher } from '../src/adapters/http.ts'
import { Workbench, type Vault } from '../src/service.ts'
const user = { tenantCode: 'ATS', globalId: 'owner' }
const login = () => ({ site: 'coho' as const, account: 'fixture', password: 'fixture-password', httpAcknowledged: false })
const ones = { token: 'ones', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt: Date.now() + 86400000 }
const coho = { token: 'coho', principal: 'owner', label: 'Coho', expiresAt: null }
function fixture(fetcher: Fetcher, expiry: number | null = null) {
  const data = new Map([['session.ones', JSON.stringify(ones)], ['session.coho', JSON.stringify({ ...coho, expiresAt: expiry })]])
  const vault: Vault = { get: async key => data.get(key) ?? null, set: async (key, value) => { data.set(key, value) }, delete: async key => { data.delete(key) } }
  const deps = { store: vault, vault, protection: async () => true, fetcher }
  return { data, deps, service: new Workbench(deps) }
}
function fetcherFor(code: number | string, status = 200): Fetcher {
  return async url => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/users/me')) return Response.json({ uuid: 'owner' })
    if (path.endsWith('/info')) return Response.json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
    if (path.endsWith('/getCurrentUser')) return Response.json({ code, data: user }, { status })
    throw Error('Unexpected request')
  }
}
const day = { team: 'team', date: '2026-01-05', mappingConfirmed: true }

test('coho auth: server expTime is seconds and survives vault restore; secrets stay out of Status', async () => {
  for (const expTime of [7200, '7200']) {
    const before = Date.now()
    const f = fixture(async url => String(url).endsWith('/requestToken')
      ? Response.json({ code: 200, data: { token: 'new-coho', expTime } })
      : Response.json({ code: 200, data: user }))
    const status = await f.service.login(login())
    const after = Date.now(), stored = JSON.parse(f.data.get('session.coho')!)
    assert.ok(stored.expiresAt >= before + 7200000 && stored.expiresAt <= after + 7200000)
    assert.equal(stored.refreshToken, undefined)
    assert.equal((await new Workbench(f.deps).status()).coho.connected, true)
    assert.equal(JSON.stringify(status).includes('new-coho'), false)
  }
})
test('coho auth: unknown expiry is not replaced with invented TTL; malformed expiry fails closed', async () => {
  for (const expTime of [undefined, null, 0, -1, '', 'tomorrow', true, Number.MAX_VALUE]) {
    const transport = new Transport(COHO, async url => String(url).endsWith('/requestToken')
      ? Response.json({ code: 200, data: { token: 'new-coho', expTime } })
      : Response.json({ code: 200, data: user }))
    const call = loginCoho(transport, 'fixture', 'fixture-password')
    if (expTime === undefined || expTime === null) assert.equal((await call).expiresAt, null)
    else await assert.rejects(call, /有效期/)
  }
})
test('coho auth: HTTP 200 business 401 revokes only Coho; permissions and transient failures preserve it', async () => {
  for (const [code, http, revoked] of [[401, 200, true], ['401', 200, true], [200, 401, true], [403, 200, false], [500, 200, false], [200, 503, false]] as const) {
    const f = fixture(fetcherFor(code, http))
    await assert.rejects(f.service.readDay(day))
    assert.equal(f.data.has('session.coho'), !revoked)
    assert.equal(f.data.has('session.ones'), true)
    assert.equal((await new Workbench(f.deps).status()).coho.connected, !revoked)
  }
})
test('coho auth: expired session is disconnected on restore and sends no attendance request', async () => {
  let calls = 0
  const f = fixture(async () => { calls++; throw Error('No request allowed') }, 1)
  assert.equal((await f.service.status()).coho.connected, false)
  assert.equal(f.data.has('session.coho'), true)
  await assert.rejects(f.service.readDay(day), /请先登录 Coho/)
  assert.equal(calls, 0)
})
test('coho auth: old business 401 cannot erase a replacement Coho login', async () => {
  let entered!: () => void, release!: (response: Response) => void
  const started = new Promise<void>(r => { entered = r }), response = new Promise<Response>(r => { release = r })
  const ordinary = fetcherFor(200)
  const f = fixture(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/requestToken')) return Response.json({ code: 200, data: { token: 'replacement', expTime: 7200 } })
    if (path.endsWith('/getCurrentUser')) {
      if (new Headers(init?.headers).get('Authorization') === 'Bearer coho') { entered(); return response }
      return Response.json({ code: 200, data: user })
    }
    return ordinary(url, init)
  })
  const pending = assert.rejects(f.service.readDay(day))
  await started
  await f.service.login(login())
  release(Response.json({ code: 401 }))
  await pending
  assert.equal(JSON.parse(f.data.get('session.coho')!).token, 'replacement')
  assert.equal((await f.service.status()).coho.connected, true)
})
