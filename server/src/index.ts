import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { config, paths } from './config.js'
import { basicAuthEnabled, configureBasicAuth, isAuthorized } from './auth.js'
import {
  appendRevision,
  closeDatabase,
  countRecords,
  getDatabase,
  getRecord,
  hideRecord,
  listRecords,
  logAudit,
  registerImage,
  upsertRecord,
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
