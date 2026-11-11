
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import assert from 'node:assert/strict'
import { Workbench, type Vault } from '../src/service.ts'
import { refreshOnes, type OnesSession } from '../src/adapters/ones-auth.ts'
import { Transport, ONES, type Fetcher } from '../src/adapters/http.ts'

const session: OnesSession = { token: 'old-access', refreshToken: 'old-refresh', expiresAt: 1, userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }] }
const tokens = { access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function fixture(response: () => Promise<Response>, stored = session) {
  const data = new Map([['session.ones', JSON.stringify(stored)]])
  const vault: Vault = { get: async key => data.get(key) ?? null, set: async (key, value) => { data.set(key, value) }, delete: async key => { data.delete(key) } }
  let refreshes = 0, business = 0
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === '/identity/oauth/token') {
      refreshes++
      assert.equal(init?.redirect, 'manual')
      assert.equal(init?.credentials, 'omit')
      const form = new URLSearchParams(String(init?.body))
      assert.equal(form.get('grant_type'), 'refresh_token')
      assert.equal(form.get('client_id'), 'ones.v1')
      assert.equal(form.get('refresh_token'), 'old-refresh')
      return response()
    }
    business++
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer new-access')
    if (path.endsWith('/users/me')) return Response.json({ uuid: 'owner' })
    if (path.endsWith('/issue_types')) return Response.json({ issue_types: [{ uuid: 'bug', name: '缺陷', built_in: true, type: 0, detail_type: 3, default_configs: { default_task_status_configs: [{ status_uuid: 'open' }] } }] })
    if (path.endsWith('/items/graphql')) return Response.json({ data: { buckets: [{ tasks: [], pageInfo: { hasNextPage: false, endCursor: '', unstable: false } }] } })
    throw Error('unexpected endpoint')
  }
  const deps = { store: vault, vault, protection: async () => true, fetcher }
  return { data, vault, deps, service: new Workbench(deps), counts: () => ({ refreshes, business }) }
}

test('refresh: expired session rotates, persists and then reads with new access token', async () => {
  const f = fixture(async () => Response.json(tokens))
  assert.deepEqual(await f.service.bugs('team'), { items: [], nextCursor: null })
  assert.equal(JSON.parse(f.data.get('session.ones')!).refreshToken, tokens.refresh_token)
  assert.equal((await new Workbench(f.deps).status()).ones.connected, true)
  assert.deepEqual(f.counts(), { refreshes: 1, business: 3 })
})
test('refresh: concurrent status and reads share one exchange', async () => {
  const started = deferred<void>(), finish = deferred<Response>()
  const f = fixture(() => { started.resolve(); return finish.promise })
  const calls = [f.service.status(), f.service.bugs('team'), f.service.bugs('team')]
  await started.promise
  assert.equal(f.counts().refreshes, 1)
  finish.resolve(Response.json(tokens))
  await Promise.all(calls)
  assert.equal(f.counts().refreshes, 1)
})
test('refresh: transient network/503/invalid schema preserve credentials and send no business request', async () => {
  for (const response of [async () => { throw Error('offline') }, async () => Response.json({}, { status: 503 }), async () => Response.json({ ...tokens, expires_in: '3600' })]) {
    const f = fixture(response), before = f.data.get('session.ones')
    await assert.rejects(f.service.bugs('team'))
    assert.equal(f.data.get('session.ones'), before)
    assert.equal(f.counts().business, 0)
  }
})
test('refresh: invalid_grant and 401 revoke only ONES; unknown 400 retains it', async () => {
  for (const [status, error, revoked] of [[400, 'invalid_grant', true], [401, 'unauthorized', true], [400, 'invalid_client', false]] as const) {
    const f = fixture(async () => Response.json({ error }, { status }))
    f.data.set('session.coho', JSON.stringify({ token: 'coho', principal: 'owner', label: 'Fixture', expiresAt: null }))
    await assert.rejects(f.service.bugs('team'))
    assert.equal(f.data.has('session.ones'), !revoked)
    assert.equal(f.data.has('session.coho'), true)
    assert.equal(f.counts().business, 0)
  }
})
test('refresh: logout during network cannot resurrect old session', async () => {
  const started = deferred<void>(), finish = deferred<Response>()
  const f = fixture(() => { started.resolve(); return finish.promise })
  const pending = assert.rejects(f.service.bugs('team'))
  await started.promise
  await f.service.logout('ones')
  finish.resolve(Response.json(tokens))
  await pending
  assert.equal(f.data.has('session.ones'), false)
  assert.equal(f.counts().business, 0)
})
test('refresh: logout during vault persistence cannot resurrect old session', async () => {
  const started = deferred<void>(), finish = deferred<void>()
  const f = fixture(async () => Response.json(tokens))
  const service = new Workbench({ ...f.deps, vault: { ...f.vault, set: async (key, value) => { started.resolve(); await finish.promise; await f.vault.set(key, value) } } })
  const pending = assert.rejects(service.bugs('team'))
  await started.promise
  const logout = service.logout('ones')
  await Promise.resolve()
  finish.resolve()
  await pending; await logout
  assert.equal(f.data.has('session.ones'), false)
})
test('refresh: unavailable keyring does not transmit token', async () => {
  const f = fixture(async () => Response.json(tokens))
  const service = new Workbench({ ...f.deps, protection: async () => false })
  await assert.rejects(service.bugs('team'), /凭证存储/)
  assert.deepEqual(f.counts(), { refreshes: 0, business: 0 })
  assert.equal(f.data.has('session.ones'), true)
})
test('refresh: valid token does not refresh; old sessions without refresh token require login after expiry', async () => {
  for (const stored of [{ ...session, expiresAt: Date.now() + 3600000 }, { ...session, refreshToken: undefined }]) {
    const f = fixture(async () => { throw Error('unexpected exchange') }, stored)
    const status = await f.service.status()
    assert.equal(status.ones.connected, stored.expiresAt > Date.now())
    assert.equal(f.counts().refreshes, 0)
  }
})
test('refresh: omitted rotation retains refresh token; malformed rotation and redirects fail closed', async () => {
  const { refresh_token: _, ...withoutRotation } = tokens
  const renewed = await refreshOnes(new Transport(ONES, async () => Response.json(withoutRotation)), session)
  assert.equal(renewed.refreshToken, session.refreshToken)
  for (const response of [Response.json({ ...tokens, refresh_token: '' }), new Response(null, { status: 302, headers: { Location: 'https://example.com' } })]) {
    await assert.rejects(refreshOnes(new Transport(ONES, async () => response), session))
  }
})

test('refresh: stale invalid_grant cannot revoke a newly logged-in ONES account', async () => {
  const started = deferred<void>(), finish = deferred<Response>()
  const f = fixture(() => { started.resolve(); return finish.promise })
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/login_support')) return Response.json({ org_uuid: 'org' })
    if (path.endsWith('/encryption_cert')) return Response.json({ public_key: publicKey })
    if (path === '/identity/api/login') return Response.json({ org_users: [{ org: { org_uuid: 'org', region_uuid: 'region' }, org_user: { org_user_uuid: 'replacement' } }] })
    if (path === '/identity/authorize') {
      const state = new URLSearchParams(String(init?.body)).get('state')
      return new Response(null, { status: 302, headers: { Location: ONES + '/auth/authorize/callback?code=fixture&state=' + state } })
    }
    if (path === '/identity/oauth/token' && new URLSearchParams(String(init?.body)).get('grant_type') === 'authorization_code') return Response.json({ ...tokens, access_token: 'replacement-access' })
    if (path.endsWith('/users/me')) return Response.json({ uuid: 'replacement', email: 'replacement@example.test' })
    if (path.endsWith('/token_info')) return Response.json({ teams: [{ uuid: 'team', name: 'Team' }] })
    return f.deps.fetcher(url, init)
  }
  const service = new Workbench({ ...f.deps, fetcher })
  const rejected = assert.rejects(service.bugs('team'))
  await started.promise
  await service.login({ site: 'ones', account: 'replacement@example.test', password: 'fixture-password', httpAcknowledged: true })
  finish.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }))
  await rejected
  assert.equal(JSON.parse(f.data.get('session.ones')!).userId, 'replacement')
  assert.equal((await service.status()).ones.connected, true)
})
