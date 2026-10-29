import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { lookup } from 'node:dns/promises'
import { mkdirSync } from 'node:fs'
import { config, paths, SERVER_MANAGED_KEY } from './config.js'
import { basicAuthEnabled, configureBasicAuth, isAuthorized } from './auth.js'
import {
  appendRevision,
  closeDatabase,
  countRecords,
  findSharedProfile,
  getDatabase,
  getRecord,
  getSharedConfig,
  getSharedProfiles,
  hideRecord,
  listHiddenRecordIds,
  listRecords,
  logAudit,
  registerImage,
  saveSharedConfig,
  upsertRecord,
  type StoredProfile,
} from './db.js'
import { extFromMime, isValidImageId, loadImage, normalizeExt, saveImage } from './storage.js'
import { serveIndexHtml, serveStatic } from './static.js'

const startedAt = Date.now()

function log(...args: unknown[]) {
  if (config.logLevel !== 'quiet') console.log(new Date().toISOString(), ...args)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', payload.length)
  res.writeHead(status)
  res.end(payload)
}

function fail(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, { ok: false, error: message })
}

/** 读取请求体，超限立即中止，避免大文件把内存打满 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson<T>(req: IncomingMessage, limit = config.maxJsonBytes): Promise<T> {
  const raw = await readBody(req, limit)
  if (!raw.length) throw Object.assign(new Error('请求体为空'), { statusCode: 400 })
  try {
    return JSON.parse(raw.toString('utf8')) as T
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 })
  }
}

interface ReportedImage {
  id?: unknown
  role?: unknown
  ext?: unknown
  width?: unknown
  height?: unknown
}

interface ReportPayload {
  task?: Record<string, unknown>
  images?: ReportedImage[]
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** POST /api/records —— 上报任务快照，重复上报会累加 revision 并留版本历史 */
async function handleReport(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<ReportPayload>(req)
  const task = body.task
  if (!task || typeof task !== 'object') return fail(res, 400, '缺少 task 字段')
  const id = str(task.id)
  if (!id) return fail(res, 400, 'task.id 缺失')

  const now = Date.now()
  const payloadJson = JSON.stringify(task)
  const status = str(task.status)
  const prompt = str(task.prompt)
  const taskCreatedAt = num(task.createdAt)
  const taskUpdatedAt = num(task.updatedAt) ?? num(task.finishedAt) ?? num(task.startedAt)

  upsertRecord({ id, prompt, status, payloadJson, taskCreatedAt, taskUpdatedAt, now })
  appendRevision({ recordId: id, at: now, status, payloadJson })

  // 关联图片：二进制由 PUT /api/images/:id 先行上传，这里只登记归属
  for (const image of body.images ?? []) {
    const imageId = str(image.id)
    if (!isValidImageId(imageId)) continue
    registerImage({
      imageId,
      recordId: id,
      role: str(image.role, 'other'),
      ext: normalizeExt(str(image.ext)),
      bytes: 0,
      width: num(image.width),
      height: num(image.height),
      now,
    })
  }

  log(`record ${id} status=${status} rev-images=${body.images?.length ?? 0}`)
  sendJson(res, 200, { ok: true, id, at: now })
}

/** PUT /api/images/:id —— 上传图片二进制，已存在则跳过（幂等） */
async function handleImageUpload(req: IncomingMessage, res: ServerResponse, imageId: string, query: URLSearchParams) {
  if (!isValidImageId(imageId)) return fail(res, 400, '非法的图片 id')
  const buffer = await readBody(req, config.maxImageBytes)
  if (!buffer.length) return fail(res, 400, '图片内容为空')
  const ext = normalizeExt(query.get('ext') ?? extFromMime(req.headers['content-type']) ?? 'png')
  const result = saveImage({
    imageId,
    ext,
    buffer,
    recordId: query.get('recordId') || null,
    role: query.get('role') ?? 'other',
    width: Number.parseInt(query.get('w') ?? '', 10) || null,
    height: Number.parseInt(query.get('h') ?? '', 10) || null,
    now: Date.now(),
  })
  sendJson(res, 200, { ok: true, stored: result.stored, bytes: result.bytes, ext: result.ext })
}

function handleImageDownload(res: ServerResponse, imageId: string) {
  if (!isValidImageId(imageId)) return fail(res, 400, '非法的图片 id')
  const image = loadImage(imageId)
  if (!image) return fail(res, 404, '图片不存在')
  res.setHeader('Content-Type', `image/${image.ext === 'jpg' ? 'jpeg' : image.ext}`)
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('Content-Length', image.bytes)
  res.writeHead(200)
  res.end(image.buffer)
}

function handleList(res: ServerResponse, query: URLSearchParams) {
  const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '100', 10) || 100, 1), 500)
  const before = Number.parseInt(query.get('before') ?? '', 10) || undefined
  const includeHidden = query.get('includeHidden') === '1'
  const rows = listRecords({ limit, before, includeHidden })
  sendJson(res, 200, {
    ok: true,
    records: rows.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      revision: row.revision,
      taskCreatedAt: row.task_created_at,
      taskUpdatedAt: row.task_updated_at,
      firstSeenAt: row.first_seen_at,
      hidden: row.hidden_at != null,
      task: JSON.parse(row.payload_json) as unknown,
    })),
    hasMore: rows.length === limit,
  })
}

/** 带扩展名或位于 assets 下的请求属于构建产物，缺文件应返回 404，不能回落到 HTML */
function looksLikeAsset(urlPath: string): boolean {
  return urlPath.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(urlPath)
}

function notFound(res: ServerResponse, message = '资源不存在') {
  const payload = Buffer.from(message)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Length', payload.length)
  res.writeHead(404)
  res.end(payload)
}

/** 下发给前端时抹掉真实 Key，只留占位符，前端各处「是否已配置 Key」的校验依然能通过 */
function sanitizeConfig(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed
  const source = parsed as { profiles?: unknown }
  if (!Array.isArray(source.profiles)) return parsed
  return {
    ...source,
    profiles: source.profiles.map((profile) => {
      if (!profile || typeof profile !== 'object') return profile
      const item = profile as Record<string, unknown>
      const hasKey = typeof item.apiKey === 'string' && item.apiKey.trim().length > 0
      return { ...item, apiKey: hasKey ? SERVER_MANAGED_KEY : '' }
    }),
  }
}

/** 前端回推时 Key 是占位符或空，按 profile id 沿用服务端已存的真实 Key */
function mergeProfilesWithStoredKey(incoming: unknown[]): unknown[] {
  const stored = new Map(getSharedProfiles().map((profile) => [profile.id, profile]))
  return incoming.map((profile) => {
    if (!profile || typeof profile !== 'object') return profile
    const item = profile as Record<string, unknown>
    const key = typeof item.apiKey === 'string' ? item.apiKey : ''
    if (key && key !== SERVER_MANAGED_KEY) return item
    const id = typeof item.id === 'string' ? item.id : ''
    return { ...item, apiKey: stored.get(id)?.apiKey ?? '' }
  })
}

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
]

/** 环回、内网、链路本地与云元数据地址一律视为不可访问 */
function isPrivateIp(address: string): boolean {
  const ip = address.toLowerCase()
  if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return true
  if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7))
  return PRIVATE_IPV4.some((pattern) => pattern.test(ip))
}

function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return isPrivateIp(host)
  return false
}

/** DNS 解析结果缓存，避免每次代理请求都查一次 */
const dnsCache = new Map<string, { isPrivate: boolean; at: number }>()
const DNS_CACHE_TTL = 60_000

async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  const cached = dnsCache.get(hostname)
  if (cached && Date.now() - cached.at < DNS_CACHE_TTL) return cached.isPrivate
  let isPrivate = false
  try {
    const addresses = await lookup(hostname, { all: true })
    isPrivate = addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))
  } catch {
    // 解析失败交给后续 fetch 报错，不在这里拦截
    return false
  }
  dnsCache.set(hostname, { isPrivate, at: Date.now() })
  return isPrivate
}

/** fal 的同步与队列接口分属两个域名，配置里只填了其中一个也要放行 */
function isFalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'fal.run' || host.endsWith('.fal.run') || host === 'fal.ai' || host.endsWith('.fal.ai')
}

/**
 * 校验转发目标。返回 null 表示允许，否则返回拒绝原因。
 * 两道关卡：必须落在某个已配置 profile 的地址范围内，且不能是内网/环回/元数据地址。
 * 否则任何拿到账号的人都能把这里当成内网跳板（SSRF）。
 */
async function rejectProxyTarget(profile: StoredProfile, target: URL): Promise<string | null> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'target 只支持 http/https'

  const isFal = profile.provider === 'fal'
  const baseRaw = (profile.baseUrl ?? '').trim() || (isFal ? 'https://fal.run' : '')
  if (!baseRaw) return '该配置没有设置 API 地址'
  let base: URL
  try {
    base = new URL(baseRaw)
  } catch {
    return '该配置的 API 地址不合法'
  }

  const sameOrigin = base.origin === target.origin || (isFal && isFalHost(target.hostname))
  const basePath = base.pathname.replace(/\/+$/, '')
  const pathAllowed =
    !sameOrigin ? false
      : isFal ? true
        : basePath === '' || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
  if (!sameOrigin || !pathAllowed) {
    return '只能转发到当前配置里设置的 API 地址'
  }

  if (!config.allowPrivateProxy) {
    if (isForbiddenHostname(target.hostname)) return '不允许访问内网或环回地址'
    if (await resolvesToPrivateAddress(target.hostname)) return '不允许访问内网或环回地址'
  }
  return null
}

/**
 * AI 请求代理：浏览器不再持有真实 Key。
 * 收到的请求按 profileId 找到服务端存的 Key 注入后再转发，响应（含流式）原样透传。
 */
async function handleProxy(req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
    return fail(res, 405, '代理只支持 GET / POST / HEAD')
  }

  const profileId = query.get('profile') ?? ''
  const target = query.get('target') ?? ''
  if (!target) return fail(res, 400, '缺少 target 参数')

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return fail(res, 400, 'target 不是合法 URL')
  }

  const profile = findSharedProfile(profileId)
  if (!profile) return fail(res, 404, '找不到对应的 API 配置')
  const realKey = (profile.apiKey ?? '').trim()
  if (!realKey) return fail(res, 400, '该配置没有可用的 API Key')

  const rejection = await rejectProxyTarget(profile, targetUrl)
  if (rejection) {
    log(`proxy 拒绝 ${method} ${targetUrl.host}${targetUrl.pathname}: ${rejection}`)
    return fail(res, 403, rejection)
  }

  const hasBody = method !== 'GET' && method !== 'HEAD'
  const body = hasBody ? await readBody(req, config.maxProxyBodyBytes) : undefined

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue
    const lower = name.toLowerCase()
    // 长度由 fetch 重算；accept-encoding 交给 fetch 协商；cookie 属于本站，不该带给上游
    if (lower === 'host' || lower === 'content-length' || lower === 'connection' || lower === 'accept-encoding' || lower === 'cookie') continue
    headers[lower] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  headers.authorization = profile.provider === 'fal' ? `Key ${realKey}` : `Bearer ${realKey}`

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  const startedAt = Date.now()
  let upstream: Response
  try {
    upstream = await fetch(targetUrl, { method, headers, body, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    log(`proxy ${method} ${targetUrl.pathname} -> 502 ${message}`)
    return fail(res, 502, `转发失败：${message}`)
  }

  log(`proxy ${method} ${targetUrl.host}${targetUrl.pathname} -> ${upstream.status} (${Date.now() - startedAt}ms)`)

  res.statusCode = upstream.status
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    // fetch 已解压响应体，压缩相关的头不能再透传，长度也交给 chunked；
    // set-cookie 也不回传，避免上游给本站种 cookie
    if (
      lower === 'content-encoding' || lower === 'content-length' || lower === 'transfer-encoding'
      || lower === 'connection' || lower === 'set-cookie'
    ) return
    res.setHeader(name, value)
  })

  if (!upstream.body) {
    res.end()
    return
  }

  // 手动搬运以便处理背压，流式响应可以边收边发
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once('drain', resolve))
      }
    }
  } catch {
    // 客户端断开或上游断流，直接收尾
  } finally {
    res.end()
  }
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // API 访问日志，便于运维排查同步问题
  if (path.startsWith('/api/')) {
    res.on('finish', () => log(`${method} ${path} -> ${res.statusCode}`))
  }

  if (path === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      basicAuth: basicAuthEnabled(),
    })
  }

  if (path === '/api/stats') {
    return sendJson(res, 200, { ok: true, ...countRecords(), dataDir: config.dataDir })
  }

  // 业务接口统一要求认证，直连容器端口也绕不过去
  if (path.startsWith('/api/')) {
    if (!isAuthorized(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="lysoft-img-web"')
      return fail(res, 401, '未认证')
    }
  }

  if (path === '/api/records' && method === 'GET') return handleList(res, url.searchParams)

  // 已删除记录 id 列表：各端拉下来后把本地残留一起清掉，做到删除全局生效
  if (path === '/api/deletions' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ids: listHiddenRecordIds() })
  }

  // 全站共享的前端配置（API 配置），改一次所有人生效
  if (path === '/api/config') {
    if (method === 'GET') {
      const row = getSharedConfig()
      let parsed: unknown = null
      if (row) {
        try {
          parsed = JSON.parse(row.payload_json)
        } catch {
          parsed = null
        }
      }
      return sendJson(res, 200, {
        ok: true,
        config: sanitizeConfig(parsed),
        revision: row?.revision ?? 0,
        updatedAt: row?.updated_at ?? null,
      })
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req)
      if (!Array.isArray(body.profiles)) return fail(res, 400, 'profiles 必须是数组')
      const payload = {
        profiles: mergeProfilesWithStoredKey(body.profiles),
        activeProfileId: str(body.activeProfileId),
        agentTextProfileId: typeof body.agentTextProfileId === 'string' ? body.agentTextProfileId : null,
        agentImageProfileId: typeof body.agentImageProfileId === 'string' ? body.agentImageProfileId : null,
      }
      const revision = saveSharedConfig(JSON.stringify(payload), Date.now())
      log(`shared config saved rev=${revision} profiles=${body.profiles.length}`)
      return sendJson(res, 200, { ok: true, revision })
    }
  }

  if (path === '/api/proxy') return handleProxy(req, res, url.searchParams)

  if (path === '/api/records' && method === 'POST') return handleReport(req, res)

  const hideMatch = /^\/api\/records\/([^/]+)\/hide$/.exec(path)
  if (hideMatch && method === 'POST') {
    const id = decodeURIComponent(hideMatch[1] ?? '')
    const changed = hideRecord(id, Date.now(), 'user-deleted')
    log(`hide ${id} changed=${changed}`)
    return sendJson(res, 200, { ok: true, hidden: true, changed })
  }

  const recordMatch = /^\/api\/records\/([^/]+)$/.exec(path)
  if (recordMatch && method === 'GET') {
    const row = getRecord(decodeURIComponent(recordMatch[1] ?? ''))
    if (!row) return fail(res, 404, '记录不存在')
    return sendJson(res, 200, {
      ok: true,
      record: {
        id: row.id,
        revision: row.revision,
        hidden: row.hidden_at != null,
        task: JSON.parse(row.payload_json) as unknown,
      },
    })
  }

  const imageMatch = /^\/api\/images\/([^/]+)$/.exec(path)
  if (imageMatch) {
    const imageId = decodeURIComponent(imageMatch[1] ?? '')
    if (method === 'PUT' || method === 'POST') return handleImageUpload(req, res, imageId, url.searchParams)
    if (method === 'GET') return handleImageDownload(res, imageId)
  }

  if (path.startsWith('/api/')) return fail(res, 404, '接口不存在')

  if (method === 'GET' || method === 'HEAD') {
    if (serveStatic(req, res, path)) return
    if (looksLikeAsset(path)) return notFound(res)
    return serveIndexHtml(req, res)
  }

  return fail(res, 405, '方法不允许')
}

function main() {
  mkdirSync(paths.images, { recursive: true })
  getDatabase()
  if (config.basicAuthUser) configureBasicAuth(config.basicAuthUser, config.basicAuthPass)
  logAudit({ at: Date.now(), action: 'server-start', recordId: null, detail: `pid=${process.pid}` })

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      const status = (error as { statusCode?: number }).statusCode ?? 500
      const message = error instanceof Error ? error.message : String(error)
      if (status >= 500) console.error(new Date().toISOString(), 'handler error', error)
      if (!res.headersSent) fail(res, status, message)
      else res.end()
    })
  })

  server.listen(config.port, config.host, () => {
    log(`listening on ${config.host}:${config.port}`)
    log(`static dir: ${config.staticDir}`)
    log(`data dir:   ${config.dataDir}`)
    log(`basic auth: ${basicAuthEnabled() ? 'enabled' : 'disabled'}`)
  })

  const shutdown = (signal: string) => {
    log(`received ${signal}, shutting down`)
    server.close(() => {
      closeDatabase()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
