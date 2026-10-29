import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from './config.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

const COMPRESSIBLE = new Set([
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'text/css; charset=utf-8',
  'application/json; charset=utf-8',
  'application/manifest+json; charset=utf-8',
  'image/svg+xml',
])

/** 构建产物内容不变，gzip 结果按路径+大小缓存在内存里 */
const gzipCache = new Map<string, Buffer>()
const GZIP_CACHE_LIMIT = 200

export function contentTypeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function acceptsGzip(req: IncomingMessage): boolean {
  return /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')
}

/** 把请求路径解析为 staticDir 内的真实文件，越界返回 null */
export function resolveStaticPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const target = resolve(config.staticDir, `.${normalized.startsWith('/') ? normalized : `/${normalized}`}`)
  const root = resolve(config.staticDir)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean {
  let filePath = resolveStaticPath(urlPath)
  if (!filePath) return false

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html')
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false

  const stat = statSync(filePath)
  const type = contentTypeFor(filePath)
  const immutable = urlPath.startsWith('/assets/')
  const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'no-cache'

  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('Vary', 'Accept-Encoding')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  if (acceptsGzip(req) && COMPRESSIBLE.has(type) && stat.size > 1024) {
    const key = `${filePath}:${stat.size}`
    let compressed = gzipCache.get(key)
    if (!compressed) {
      compressed = gzipSync(readFileSync(filePath))
      if (gzipCache.size >= GZIP_CACHE_LIMIT) gzipCache.clear()
      gzipCache.set(key, compressed)
    }
    res.setHeader('Content-Encoding', 'gzip')
    res.setHeader('Content-Length', compressed.length)
    res.writeHead(200)
    res.end(compressed)
    return true
  }

  res.setHeader('Content-Length', stat.size)
  res.writeHead(200)
  createReadStream(filePath).pipe(res)
  return true
}

/** SPA 兜底：未知路径一律返回 index.html，交给前端路由处理 */
export function serveIndexHtml(req: IncomingMessage, res: ServerResponse) {
  const indexFile = join(config.staticDir, 'index.html')
  if (!existsSync(indexFile)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('前端构建产物缺失')
    return
  }
  const buffer = readFileSync(indexFile)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Content-Length', buffer.length)
  res.writeHead(200)
  res.end(buffer)
}
