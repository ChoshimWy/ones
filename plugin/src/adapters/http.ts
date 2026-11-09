import { AppError, record, requireThat } from '../domain/model.ts'
export const ONES = 'http://aputureones.com:8088'
export const COHO = 'https://w.coho.net.cn'
export type Fetcher = typeof fetch
export class Transport {
  constructor(private readonly origin: typeof ONES | typeof COHO, private readonly fetcher: Fetcher = fetch) {}
  async response(path: string, options: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.origin)
    requireThat(url.origin === this.origin && !url.username && !url.password && !url.hash && path.startsWith('/'), 'origin', '仅允许已配置的服务地址。')
    try {
      return await this.fetcher(url, { ...options, redirect: 'manual', credentials: 'omit', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) })
    } catch { throw new AppError('network', '网络不可达或请求超时，未自动重试。') }
  }
  async json(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.response(path, options)
    const stages: Record<string, string> = {
      '/project/api/project/auth/login_support': 'ONES 登录配置',
      '/project/api/project/users/me': 'ONES 身份回读',
      '/project/api/project/auth/token_info': 'ONES 团队回读',
      '/gateway/auth/account/requestToken': 'Coho 密码认证',
      '/gateway/auth/user/getCurrentUser': 'Coho 身份回读'
    }
    return readJSON(response, stages[path])
  }
}
export async function readJSON(response: Response, stage?: string): Promise<Record<string, unknown>> {
  try { return await parseJSON(response) }
  catch (error) {
    if (stage && error instanceof AppError) throw new AppError(error.code, `${stage}：${error.message}`)
    throw error
  }
}
async function parseJSON(response: Response): Promise<Record<string, unknown>> {
  if (response.status === 401) throw new AppError('auth', '认证已失效，请在插件中重新登录。')
  if (response.status === 403) throw new AppError('forbidden', '当前账号无权限或认证步骤尚未完成。')
  if (response.status === 429) throw new AppError('rate_limit', '请求过于频繁，请稍后重试。')
  requireThat(response.ok && response.status < 300, 'http', `服务拒绝请求或发生重定向（HTTP ${response.status}），已停止操作。`)
  requireThat((response.headers.get('content-type') ?? '').includes('json'), 'schema', '服务返回非 JSON 内容，可能需要重新认证。')
  requireThat(Number(response.headers.get('content-length') ?? 0) <= 2 * 1024 * 1024, 'size', '响应过大，请缩小查询范围。')
  const reader = response.body?.getReader()
  requireThat(reader, 'schema', '服务返回空响应。')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      requireThat(size <= 2 * 1024 * 1024, 'size', '响应过大，请缩小查询范围。')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new AppError('schema', '接口返回无效 JSON。') }
  const data = record(parsed)
  if (typeof data.errcode === 'string' && /Captcha|MFA|CredentialRetryCountExceeded/.test(data.errcode)) throw new AppError('auth_step', '需要验证码、MFA 或账号暂时锁定；本版无法继续，请勿重复尝试密码。')
  if (data.errcode === 'AuthFailure.InvalidPassword') throw new AppError('credentials', '账号或密码不正确，未自动重试。')
  requireThat(!data.errcode && !data.error && (!data.errors || (Array.isArray(data.errors) && data.errors.length === 0)), 'business', '服务业务校验未通过；请核对登录、权限或字段，未自动重试。')
  return data
}
export function jsonBody(data: unknown, token?: string): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) }
}
