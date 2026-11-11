
import { generateKeyPairSync } from 'node:crypto'
import { Workbench, type Vault, type Store } from '../../src/service.ts'
import { ONES, type Fetcher } from '../../src/adapters/http.ts'
import type { Site } from '../../src/domain/model.ts'
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
export const accounts = { ones: 'fixture@example.test', coho: 'fixture-coho' }
export const loginInput = (site: Site, remember = false) => ({ site, account: accounts[site], password: 'fictional-password', httpAcknowledged: true, remember })
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
export function authFixture() {
  const secrets = new Map<string, string>(), ordinary = new Map<string, unknown>()
  secrets.set('session.ones', JSON.stringify({ token: 'ones-0', userId: 'owner', label: 'Fixture ONES', teams: [{ id: 'team', name: '验证团队' }], expiresAt: Date.now() + 86400000 }))
  secrets.set('session.coho', JSON.stringify({ token: 'coho-0', principal: 'owner', label: 'Coho · ATS', expiresAt: Date.now() + 86400000 }))
  const vault: Vault = { get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value) }, delete: async key => { secrets.delete(key) } }
  const store: Store = { get: async key => ordinary.get(key) ?? null, set: async (key, value) => { ordinary.set(key, value) }, delete: async key => { ordinary.delete(key) } }
  const control = {
    passwordCalls: { ones: 0, coho: 0 }, refreshCalls: 0, businessCalls: 0, calendarCalls: 0,
    fail: {} as Partial<Record<Site, 'network' | 'credentials'>>,
    revoked: { ones: false, coho: false }, principal: { ones: 'owner', coho: 'owner' },
    refresh: 'success' as 'success' | 'invalid' | 'network',
    hold: undefined as undefined | ((site: Site) => Promise<void>), paths: [] as string[]
  }
  const password = async (site: Site) => {
    control.passwordCalls[site]++
    await control.hold?.(site)
    if (control.fail[site] === 'network') throw Error('fixture offline')
    if (control.fail[site] === 'credentials') return site === 'ones'
      ? Response.json({ errcode: 'AuthFailure.InvalidPassword' })
      : Response.json({ code: 400, data: { errorCode: 1 } })
    control.revoked[site] = false
    return null
  }
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname
    control.paths.push(path)
    if (path.endsWith('/login_support')) return Response.json({ org_uuid: 'org' })
    if (path.endsWith('/encryption_cert')) return Response.json({ public_key: publicKey })
    if (path === '/identity/api/login') return await password('ones') ?? Response.json({ org_users: [{ org: { org_uuid: 'org', region_uuid: 'region' }, org_user: { org_user_uuid: control.principal.ones } }] })
    if (path === '/identity/authorize') return new Response(null, { status: 302, headers: { Location: ONES + '/auth/authorize/callback?code=fixture&state=' + new URLSearchParams(String(init?.body)).get('state') } })
    if (path === '/identity/oauth/token') {
      if (new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token') {
        control.refreshCalls++
        if (control.refresh === 'invalid') return Response.json({ error: 'invalid_grant' }, { status: 400 })
        if (control.refresh === 'network') throw Error('fixture offline')
      }
      return Response.json({ access_token: 'ones-new', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 })
    }
    if (path.endsWith('/requestToken')) return await password('coho') ?? Response.json({ code: 200, data: { token: 'coho-new', expTime: 3600 } })
    if (path.endsWith('/users/me')) return control.revoked.ones ? Response.json({}, { status: 401 }) : Response.json({ uuid: control.principal.ones, email: accounts.ones, name: 'Fixture ONES' })
    if (path.endsWith('/token_info')) return Response.json({ teams: [{ uuid: 'team', name: '验证团队' }] })
    if (path.endsWith('/getCurrentUser')) return Response.json(control.revoked.coho ? { code: 401 } : { code: 200, data: { tenantCode: 'ATS', globalId: control.principal.coho } })
    control.businessCalls++
    if (path.endsWith('/info')) return Response.json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
    if (path.endsWith('/issue_types')) return Response.json({ issue_types: [{ uuid: 'bug', name: '缺陷', built_in: true, type: 0, detail_type: 3, default_configs: { default_task_status_configs: [{ status_uuid: 'open' }] } }] })
    if (path.endsWith('/getInfoByDateAndUser')) return Response.json({ code: 200, data: { kqqs: 'period' } })
    if (path.endsWith('/attCalendar')) {
      control.calendarCalls++
      return Response.json({ code: 200, data: { dateList: [{ date: '2026-01-05' }], dkList: ['09:00', '18:30'].map(time => ({ date: '2026-01-05', realDate: '2026-01-05', time, isNext: false, outFence: false })) } })
    }
    if (path.endsWith('/items/graphql')) return Response.json({ data: { buckets: [{ tasks: [{ uuid: 'task', number: 1, name: '虚构缺陷：自动登录验证', project: { uuid: 'project', name: '验证项目' }, issueType: { uuid: 'bug', name: '缺陷' }, status: { uuid: 'open', name: '待处理' } }], manhours: [], pageInfo: { hasNextPage: false, endCursor: '', unstable: false } }] } })
    throw Error('Unexpected fixture endpoint')
  }
  const deps = { vault, store, fetcher, protection: async () => true }
  return {
    secrets, ordinary, control, deps, service: new Workbench(deps),
    restart: () => new Workbench(deps),
    expire: (site: Site, keepRefresh = false) => {
      const stored = JSON.parse(secrets.get('session.' + site)!)
      stored.expiresAt = 1
      if (!keepRefresh) delete stored.refreshToken
      secrets.set('session.' + site, JSON.stringify(stored))
    }
  }
}
