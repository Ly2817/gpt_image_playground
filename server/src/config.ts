import { resolve } from 'node:path'

function readInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const config = {
  port: readInt('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** 静态站点根目录（前端构建产物） */
  staticDir: resolve(process.env.STATIC_DIR ?? 'dist'),
  /** 持久化根目录：SQLite 库与图片都在这里，必须挂载数据卷 */
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  /** 单张图片上限，默认 64MB */
  maxImageBytes: readInt('MAX_IMAGE_BYTES', 64 * 1024 * 1024),
  /** 任务快照 JSON 上限，默认 8MB（含 base64 参数等） */
  maxJsonBytes: readInt('MAX_JSON_BYTES', 8 * 1024 * 1024),
  /** 代理转发的请求体上限，默认 512MB（图生图的输入图可能很大） */
  maxProxyBodyBytes: readInt('MAX_PROXY_BODY_BYTES', 512 * 1024 * 1024),
  /**
   * 是否允许代理访问内网/环回地址。默认关闭，防止把代理当成内网跳板（SSRF）。
   * 只有对接部署在内网的自建模型服务时才需要打开。
   */
  allowPrivateProxy: process.env.ALLOW_PRIVATE_PROXY === 'true',
  /** 直连保护：容器端口直接暴露时仍要求 Basic 认证，留空则不启用 */
  basicAuthUser: process.env.BASIC_AUTH_USER ?? '',
  basicAuthPass: process.env.BASIC_AUTH_PASS ?? '',
  /** 日志级别：quiet | normal | verbose */
  logLevel: process.env.LOG_LEVEL ?? 'normal',
} as const

export const paths = {
  database: resolve(config.dataDir, 'archive.db'),
  images: resolve(config.dataDir, 'images'),
} as const

/**
 * 下发给前端的占位 Key。前端各处的「是否已配置 Key」校验都要通过，
 * 真实 Key 只在服务器上，由代理层注入。
 */
export const SERVER_MANAGED_KEY = '__server_managed__'
