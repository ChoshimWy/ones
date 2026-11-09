import { constants, createHash, publicEncrypt, randomBytes } from 'node:crypto'
import { AppError, id, record, requireThat, text, type Option } from '../domain/model.ts'
import { ONES, Transport, jsonBody, readJSON } from './http.ts'
export type OnesSession = { token: string; userId: string; label: string; teams: Option[]; expiresAt: number }

// A transient, host-only cookie jar for the identity flow. Never stored or sent to Project API.
class LoginCookies {
  private items: { name: string; value: string; path: string; secure: boolean; expires: number }[] = []
  absorb(response: Response, requestPath: string): void {
    for (const raw of response.headers.getSetCookie()) {
      const parts = raw.split(';').map(v => v.trim()); const first = parts.shift()!
      const cut = first.indexOf('='); if (cut < 1) continue
      const name = first.slice(0, cut); const value = first.slice(cut + 1)
      if (!/^[\w-]+$/.test(name) || /[\r\n;]/.test(value)) continue
      const attributes = new Map(parts.map(v => { const i = v.indexOf('='); return [v.slice(0, i < 0 ? undefined : i).toLowerCase(), i < 0 ? '' : v.slice(i + 1)] }))
      const domain = attributes.get('domain')?.replace(/^\./, '')
      requireThat(!domain || domain === new URL(ONES).hostname, 'origin', '登录 Cookie 域不匹配。')
      const path = attributes.get('path') || requestPath.slice(0, requestPath.lastIndexOf('/') + 1)
      const expires = attributes.has('max-age') ? Date.now() + Number(attributes.get('max-age')) * 1000 : attributes.has('expires') ? Date.parse(attributes.get('expires')!) : Infinity
      this.items = this.items.filter(v => !(v.name === name && v.path === path))
      if (expires > Date.now()) this.items.push({ name, value, path, secure: attributes.has('secure'), expires })
    }
  }
  header(path: string): string {
    return this.items.filter(v => !v.secure && v.expires > Date.now() && (path === v.path || path.startsWith(v.path.endsWith('/') ? v.path : `${v.path}/`))).sort((a,b) => b.path.length-a.path.length).map(v => `${v.name}=${v.value}`).join('; ')
  }
}

export async function loginOnes(transport: Transport, account: string, password: string, httpAcknowledged: boolean, signal?: AbortSignal): Promise<OnesSession> {
  requireThat(httpAcknowledged === true, 'http_consent', '请确认 ONES 内网 HTTP 明文传输风险。')
  requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account) && account.length <= 254 && password.length > 0 && password.length <= 256, 'input', '请输入有效邮箱和密码。')
  const cookies = new LoginCookies()
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); const cookie = cookies.header(path)
    if (cookie) headers.set('Cookie', cookie)
    const response = await transport.response(path, { ...init, headers, signal })
    cookies.absorb(response, path)
    return response
  }
  const support = await transport.json('/project/api/project/auth/login_support', { signal })
  const org = id(support.org_uuid)
  const cert = await readJSON(await send('/identity/api/encryption_cert', jsonBody({})), 'ONES 密码加密配置')
  const key = text(cert.public_key, 8192)
  requireThat(key.startsWith('-----BEGIN PUBLIC KEY-----'), 'auth_contract', '当前密码加密配置不受支持。')
  let encrypted: string
  try { encrypted = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8')).toString('base64') }
  catch { throw new AppError('auth_contract', '密码加密失败，未发送登录请求。') }
  const login = await readJSON(await send('/identity/api/login', jsonBody({ email: account, password: encrypted })), 'ONES 密码认证')
  requireThat(Array.isArray(login.org_users), 'auth_contract', '登录需要验证码、MFA 或其它尚未支持的认证步骤。')
  const matches = login.org_users.map(record).filter(v => record(v.org).org_uuid === org)
  requireThat(matches.length === 1, 'auth_contract', '当前账号与 ONES 组织不能唯一匹配。')
  const membership = matches[0]; const region = id(record(membership.org).region_uuid); const user = id(record(membership.org_user).org_user_uuid)
  const verifier = randomBytes(48).toString('base64url'); const state = randomBytes(24).toString('hex')
  const callback = `${ONES}/auth/authorize/callback`
  const form = new URLSearchParams({ client_id: 'ones.v1', scope: `openid offline_access ones:org:${region}:${org}:${user}`, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), redirect_uri: callback, state })
  const authorization = await send('/identity/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() })
  requireThat([302, 303].includes(authorization.status), 'auth_contract', '组织授权需要额外操作，未自动跟随页面。')
  let location = new URL(authorization.headers.get('location') ?? '', ONES)
  requireThat(location.origin === ONES && !location.username && !location.password && !location.hash, 'auth_origin', '授权回调跨越指定站点，已阻止。')
  if (location.pathname === '/identity/organization_select') {
    requireThat(!location.searchParams.has('error'), 'auth_step', '组织授权要求额外认证，已停止。')
    const requestId = id(location.searchParams.get('id'))
    const request = await readJSON(await send(`/identity/api/auth_request/${requestId}`), 'ONES 授权请求回读')
    const expectedScopes = ['openid', 'offline_access', `ones:org:${region}:${org}:${user}`]
    requireThat(Array.isArray(request.scopes) && request.scopes.length === expectedScopes.length && expectedScopes.every(scope => (request.scopes as unknown[]).includes(scope)), 'auth_scope', '授权范围与本次登录不一致，未确认组织。')
    const finalized = await readJSON(await send('/identity/api/auth_request/finalize', jsonBody({ auth_request_id: requestId, region_uuid: region, org_uuid: org, org_user_uuid: user })), 'ONES 组织授权确认')
    const relativeCallback = text(finalized.callback_url, 16000)
    requireThat(relativeCallback.startsWith('/') && !relativeCallback.startsWith('//'), 'auth_origin', '组织授权回调不是受控相对地址，已阻止。')
    // Identity's getFullIDSUrl prefixes its /identity root to callback_url.
    const next = new URL(`${ONES}/identity${relativeCallback}`)
    requireThat(next.origin === ONES && !next.username && !next.password && !next.hash, 'auth_origin', '组织授权回调跨站，已阻止。')
    if (next.pathname === '/auth/authorize/callback') {
      location = next
    } else {
      // The official identity app opens this finalizer-provided continuation.
      // Limit it to the authentication namespace, GET once, and never auto-follow it.
      requireThat(next.pathname.startsWith('/identity/') && !next.pathname.startsWith('/identity/api/'), 'auth_step', '组织授权返回未支持的后续步骤，已停止。')
      const continuation = await send(`${next.pathname}${next.search}`)
      requireThat([302, 303].includes(continuation.status), 'auth_step', '组织授权后仍需要额外认证，已停止。')
      location = new URL(continuation.headers.get('location') ?? '', ONES)
    }
  }
  requireThat(location.origin === ONES && !location.username && !location.password && !location.hash, 'auth_origin', '授权回调跨越指定站点，已阻止。')
  requireThat(location.pathname === '/auth/authorize/callback', 'auth_step', '授权仍停留在额外认证步骤，未跟随跳转。')
  requireThat(location.searchParams.get('state') === state, 'auth_state', '授权回调状态校验失败，未交换令牌。')
  requireThat(!location.searchParams.has('error'), 'auth_rejected', '授权服务拒绝当前 OAuth 请求，未交换令牌。')
  const code = text(location.searchParams.get('code'), 4000)
  const tokens = await readJSON(await send('/identity/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'ones.v1', code, code_verifier: verifier, redirect_uri: callback }).toString() }), 'ONES 令牌交换')
  const token = text(tokens.access_token, 16000)
  requireThat(String(tokens.token_type).toLowerCase() === 'bearer' && typeof tokens.expires_in === 'number' && tokens.expires_in > 0, 'auth_contract', '令牌类型或有效期不受支持。')
  const me = await transport.json('/project/api/project/users/me', { headers: { Authorization: `Bearer ${token}` }, signal })
  requireThat(me.uuid === user && typeof me.email === 'string' && me.email.toLowerCase() === account.toLowerCase(), 'identity', '登录身份回读不匹配。')
  const info = await transport.json('/project/api/project/auth/token_info', { headers: { Authorization: `Bearer ${token}` }, signal })
  requireThat(Array.isArray(info.teams), 'auth_contract', '登录成功，但团队信息接口尚未匹配。')
  const teams = info.teams.map(v => { const t = record(v); return { id: id(t.uuid), name: text(t.name) } })
  return { token, userId: user, label: text(me.name ?? me.email), teams, expiresAt: Date.now() + Math.min(tokens.expires_in, 86400) * 1000 }
}
