import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './config.js'
import { getImage, registerImage } from './db.js'

/** 图片 id 只允许安全字符，避免路径穿越 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'])
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

export function isValidImageId(id: string): boolean {
  return ID_PATTERN.test(id)
}

export function normalizeExt(raw: string | null | undefined): string {
  const value = (raw ?? '').toLowerCase().replace(/^\./, '')
  return ALLOWED_EXT.has(value) ? value : 'png'
}

export function extFromMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined
  return EXT_BY_MIME[mime.split(';')[0]?.trim().toLowerCase() ?? '']
}

/** 按 id 前两位分片，避免单个目录堆积过多文件 */
function shardDir(imageId: string): string {
  return join(paths.images, imageId.slice(0, 2))
}

export function imageFilePath(imageId: string, ext: string): string {
  return join(shardDir(imageId), `${imageId}.${normalizeExt(ext)}`)
}

export function imageExists(imageId: string, ext: string): boolean {
  return existsSync(imageFilePath(imageId, ext))
}

/** 写入图片。已存在同 id 同扩展名文件时直接跳过，保证重复上报幂等 */
export function saveImage(input: {
  imageId: string
  ext: string
  buffer: Buffer
  recordId: string | null
  role: string
  width: number | null
  height: number | null
  now: number
}): { stored: boolean; bytes: number; ext: string } {
  const ext = normalizeExt(input.ext)
  const file = imageFilePath(input.imageId, ext)
  // 空 buffer 只登记元数据，绝不落盘占位文件，否则后续真实上传会被判为“已存在”而跳过
  const shouldWrite = input.buffer.length > 0
  let stored = false
  if (shouldWrite && !existsSync(file)) {
    mkdirSync(shardDir(input.imageId), { recursive: true })
    writeFileSync(file, input.buffer)
    stored = true
  }
  const bytes = shouldWrite
    ? stored
      ? input.buffer.length
      : statSync(file).size
    : 0
  registerImage({
    imageId: input.imageId,
    recordId: input.recordId,
    role: input.role,
    ext,
    bytes,
    width: input.width,
    height: input.height,
    now: input.now,
  })
  return { stored, bytes, ext }
}

/** 读取图片：优先用库里登记的扩展名，缺失时逐个探测 */
export function loadImage(imageId: string): { buffer: Buffer; ext: string; bytes: number } | undefined {
  const row = getImage(imageId)
  if (row) {
    const file = imageFilePath(imageId, row.ext)
    if (existsSync(file)) {
      const buffer = readFileSync(file)
      return { buffer, ext: normalizeExt(row.ext), bytes: buffer.length }
    }
  }
  const dir = shardDir(imageId)
  if (!existsSync(dir)) return undefined
  const hit = readdirSync(dir).find((name) => name.startsWith(`${imageId}.`))
  if (!hit) return undefined
  const buffer = readFileSync(join(dir, hit))
  return { buffer, ext: normalizeExt(hit.slice(imageId.length + 1)), bytes: buffer.length }
}

/** 判断 base64 dataUrl 的 MIME，仅用于上报时兜底识别扩展名 */
export function extFromDataUrl(dataUrl: string | undefined): string | undefined {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl ?? '')
  return match ? extFromMime(match[1]) : undefined
}
