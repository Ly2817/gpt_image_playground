import { createHash, timingSafeEqual } from 'node:crypto'

let expectedUser = ''
let expectedPass = ''

export function configureBasicAuth(user: string, pass: string) {
  expectedUser = user
  expectedPass = pass
}

export function basicAuthEnabled(): boolean {
  return expectedUser.length > 0
}

/** 定长比较，避免通过响应时间推断凭据 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** 校验 Authorization: Basic 头；未配置凭据时整体放行（认证交给外层 Nginx） */
export function isAuthorized(header: string | undefined): boolean {
  if (!basicAuthEnabled()) return true
  if (!header?.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 0) return false
  const user = decoded.slice(0, separator)
  const pass = decoded.slice(separator + 1)
  return safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)
}
