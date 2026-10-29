import type { ApiProfile, TaskRecord } from '../types'
import { archiveApiUrl } from './archiveBase'
import { getStoredImageRecord } from './imageBlob'

/**
 * 与服务端存档服务对接的同步层。
 * 设计原则：所有上报都是「尽力而为」，网络或服务端异常绝不能影响本地生成流程。
 */

const REPORTED_IMAGES_KEY = 'archive:reported-images:v1'
const HEALTH_TTL = 60_000
const MAX_REPORTED_IDS = 8000

export interface ArchiveRecord {
  id: string
  prompt: string
  status: string
  revision: number
  taskCreatedAt: number | null
  taskUpdatedAt: number | null
  firstSeenAt: number
  hidden: boolean
  task: TaskRecord
}

let available: boolean | null = null
let healthCheckedAt = 0
let probing: Promise<boolean> | null = null

/** 站内 API 地址：跟随前端 base 路径，避免子目录部署时打到域名根 */
function apiUrl(path: string): string {
  return archiveApiUrl(path)
}

function loadReportedImageIds(): Set<string> {
  try {
    const raw = localStorage.getItem(REPORTED_IMAGES_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

const reportedImageIds = loadReportedImageIds()

function persistReportedImageIds() {
  try {
    const ids = [...reportedImageIds]
    const trimmed = ids.length > MAX_REPORTED_IDS ? ids.slice(ids.length - MAX_REPORTED_IDS) : ids
    localStorage.setItem(REPORTED_IMAGES_KEY, JSON.stringify(trimmed))
  } catch {
    /* 配额不足时放弃持久化，下次重新上传即可 */
  }
}

/** 带超时的 fetch：服务端不可达时不能把页面启动拖住 */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 探测存档服务是否可用；结果缓存 60 秒，失败后不阻塞任何本地功能 */
export async function isArchiveAvailable(recheck = false): Promise<boolean> {
  if (!recheck && available !== null && Date.now() - healthCheckedAt < HEALTH_TTL) return available
  if (probing) return probing
  probing = (async () => {
    try {
      const response = await fetchWithTimeout(apiUrl('api/health'), { cache: 'no-store' }, 5000)
      available = response.ok
    } catch {
      available = false
    } finally {
      healthCheckedAt = Date.now()
      probing = null
    }
    return available
  })()
  return probing
}

function extOf(blob: Blob): string {
  const type = blob.type.toLowerCase()
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('webp')) return 'webp'
  if (type.includes('gif')) return 'gif'
  if (type.includes('bmp')) return 'bmp'
  if (type.includes('avif')) return 'avif'
  return 'png'
}

interface ImagePayload {
  blob: Blob
  ext: string
  width?: number
  height?: number
}

async function loadImagePayload(id: string): Promise<ImagePayload | null> {
  const record = await getStoredImageRecord(id)
  if (!record) return null
  if (record.blob) {
    return { blob: record.blob, ext: extOf(record.blob), width: record.width, height: record.height }
  }
  if (!record.dataUrl) return null
  try {
    const response = await fetch(record.dataUrl)
    const blob = await response.blob()
    return { blob, ext: extOf(blob), width: record.width, height: record.height }
  } catch {
    return null
  }
}

interface ImageRef {
  id: string
  role: string
}

/** 汇总任务引用的全部图片，按角色分类 */
export function collectTaskImageRefs(task: TaskRecord): ImageRef[] {
  const refs: ImageRef[] = []
  const seen = new Set<string>()
  const push = (id: string | null | undefined, role: string) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    refs.push({ id, role })
  }
  for (const id of task.inputImageIds ?? []) push(id, 'input')
  push(task.maskTargetImageId, 'mask-target')
  push(task.maskImageId, 'mask')
  for (const id of task.streamPartialImageIds ?? []) push(id, 'stream-partial')
  for (const id of task.outputImages ?? []) push(id, 'output')
  for (const id of task.transparentOriginalImages ?? []) push(id, 'transparent-original')
  return refs
}

/** 上传单张图片；已上传过的直接跳过，避免重复传输大图 */
async function uploadImage(ref: ImageRef, recordId: string): Promise<{ id: string; ext: string; width?: number; height?: number } | null> {
  if (reportedImageIds.has(ref.id)) return null
  const payload = await loadImagePayload(ref.id)
  if (!payload) return null
  const params = new URLSearchParams({ role: ref.role, ext: payload.ext, recordId })
  if (payload.width) params.set('w', String(payload.width))
  if (payload.height) params.set('h', String(payload.height))
  const response = await fetchWithTimeout(
    apiUrl(`api/images/${encodeURIComponent(ref.id)}?${params.toString()}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': payload.blob.type || 'application/octet-stream' },
      body: payload.blob,
    },
    120_000,
  )
  if (!response.ok) return null
  reportedImageIds.add(ref.id)
  persistReportedImageIds()
  return { id: ref.id, ext: payload.ext, width: payload.width, height: payload.height }
}

const inFlight = new Set<string>()

/** 上报任务快照。成功返回 true；任何异常都静默吞掉，不影响本地流程 */
export async function reportTask(task: TaskRecord): Promise<boolean> {
  if (!(await isArchiveAvailable())) return false
  if (inFlight.has(task.id)) return false
  inFlight.add(task.id)
  try {
    const refs = collectTaskImageRefs(task)
    const images: Array<{ id: string; role: string; ext: string; width?: number; height?: number }> = []
    for (const ref of refs) {
      const uploaded = await uploadImage(ref, task.id)
      if (uploaded) images.push({ ...uploaded, role: ref.role })
      else if (reportedImageIds.has(ref.id)) images.push({ id: ref.id, role: ref.role, ext: 'png' })
    }
    const response = await fetchWithTimeout(
      apiUrl('api/records'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, images }),
      },
      30_000,
    )
    return response.ok
  } catch {
    return false
  } finally {
    inFlight.delete(task.id)
  }
}

/** 拉取服务端历史；失败返回空数组，让前端继续用本地数据 */
export async function fetchArchiveRecords(limit = 200): Promise<ArchiveRecord[]> {
  if (!(await isArchiveAvailable())) return []
  try {
    const response = await fetchWithTimeout(apiUrl(`api/records?limit=${limit}`), { cache: 'no-store' }, 15_000)
    if (!response.ok) return []
    const body = (await response.json()) as { records?: ArchiveRecord[] }
    return Array.isArray(body.records) ? body.records : []
  } catch {
    return []
  }
}

/** 拉取服务端「已被删除」的记录 id，用于把本地残留也清掉 */
export async function fetchHiddenRecordIds(): Promise<Set<string>> {
  if (!(await isArchiveAvailable())) return new Set()
  try {
    const response = await fetchWithTimeout(apiUrl('api/deletions'), { cache: 'no-store' }, 10_000)
    if (!response.ok) return new Set()
    const body = (await response.json()) as { ids?: unknown }
    return new Set(Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

const PENDING_HIDES_KEY = 'archive:pending-hides:v1'

function loadPendingHides(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_HIDES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function savePendingHides(ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(PENDING_HIDES_KEY, JSON.stringify(ids))
    else localStorage.removeItem(PENDING_HIDES_KEY)
  } catch {
    /* 存不下就放弃重试，不影响本地删除 */
  }
}

function addPendingHide(recordId: string) {
  const ids = loadPendingHides()
  if (!ids.includes(recordId)) {
    ids.push(recordId)
    savePendingHides(ids)
  }
}

/**
 * 通知服务端「用户删除了这条」——只做隐藏标记，服务器留档不动。
 * 失败时进重试队列，下次启动补发，保证删除最终在所有设备生效。
 */
export async function hideArchiveRecord(recordId: string): Promise<boolean> {
  if (!(await isArchiveAvailable())) {
    addPendingHide(recordId)
    return false
  }
  try {
    const response = await fetchWithTimeout(apiUrl(`api/records/${encodeURIComponent(recordId)}/hide`), { method: 'POST' }, 10_000)
    if (response.ok) return true
    addPendingHide(recordId)
    return false
  } catch {
    addPendingHide(recordId)
    return false
  }
}

/** 补发此前没送达的删除请求 */
export async function flushPendingHides(): Promise<void> {
  const ids = loadPendingHides()
  if (!ids.length) return
  if (!(await isArchiveAvailable())) return
  const remaining: string[] = []
  for (const id of ids) {
    try {
      const response = await fetchWithTimeout(apiUrl(`api/records/${encodeURIComponent(id)}/hide`), { method: 'POST' }, 10_000)
      if (!response.ok) remaining.push(id)
    } catch {
      remaining.push(id)
    }
  }
  savePendingHides(remaining)
}

// ===== 全站共享的 API 配置 =====

export interface SharedApiConfig {
  profiles: ApiProfile[]
  activeProfileId: string
  /** Agent 模式引用的 profile id 也一并共享，否则换设备后会指向不存在的配置 */
  agentTextProfileId?: string | null
  agentImageProfileId?: string | null
}

const CONFIG_PENDING_KEY = 'archive:config-pending:v1'

function markConfigPending() {
  try {
    localStorage.setItem(CONFIG_PENDING_KEY, '1')
  } catch {
    /* 忽略 */
  }
}

function clearConfigPending() {
  try {
    localStorage.removeItem(CONFIG_PENDING_KEY)
  } catch {
    /* 忽略 */
  }
}

/** 本地是否有尚未推送成功的配置改动 */
export function hasPendingConfigPush(): boolean {
  try {
    return localStorage.getItem(CONFIG_PENDING_KEY) === '1'
  } catch {
    return false
  }
}

export async function fetchSharedConfig(): Promise<SharedApiConfig | null> {
  if (!(await isArchiveAvailable())) return null
  try {
    const response = await fetchWithTimeout(apiUrl('api/config'), { cache: 'no-store' }, 10_000)
    if (!response.ok) return null
    const body = (await response.json()) as { config?: unknown }
    const config = body.config
    if (!config || typeof config !== 'object') return null
    const profiles = (config as { profiles?: unknown }).profiles
    if (!Array.isArray(profiles) || profiles.length === 0) return null
    const activeProfileId = (config as { activeProfileId?: unknown }).activeProfileId
    const agentText = (config as { agentTextProfileId?: unknown }).agentTextProfileId
    const agentImage = (config as { agentImageProfileId?: unknown }).agentImageProfileId
    return {
      profiles: profiles as ApiProfile[],
      activeProfileId: typeof activeProfileId === 'string' ? activeProfileId : '',
      agentTextProfileId: typeof agentText === 'string' ? agentText : null,
      agentImageProfileId: typeof agentImage === 'string' ? agentImage : null,
    }
  } catch {
    return null
  }
}

export async function pushSharedConfig(config: SharedApiConfig): Promise<boolean> {
  if (!(await isArchiveAvailable())) {
    markConfigPending()
    return false
  }
  try {
    const response = await fetchWithTimeout(
      apiUrl('api/config'),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      },
      15_000,
    )
    if (response.ok) {
      clearConfigPending()
      return true
    }
    markConfigPending()
    return false
  } catch {
    markConfigPending()
    return false
  }
}

// ===== 同浏览器多标签页通知 =====

const CHANNEL_NAME = 'gpt-image-archive-sync'
let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME)
    } catch {
      return null
    }
  }
  return channel
}

/** 本地删除了任务，通知同源的其他标签页刷新列表 */
export function notifyRecordsChanged() {
  getChannel()?.postMessage({ type: 'records-changed', at: Date.now() })
}

export function onRecordsChanged(listener: () => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const handler = (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type === 'records-changed') listener()
  }
  ch.addEventListener('message', handler)
  return () => ch.removeEventListener('message', handler)
}

/** 已上报任务签名，用于抑制同一状态的重复上报 */
const reportedSignatures = new Map<string, string>()

export function taskSignature(task: TaskRecord): string {
  return [
    task.status,
    task.finishedAt ?? 0,
    task.elapsed ?? 0,
    (task.outputImages ?? []).length,
    (task.streamPartialImageIds ?? []).length,
  ].join('|')
}

/** 把服务端已有的任务登记为「无需再报」，避免刷新后又把历史全量回传 */
export function markTaskReported(task: TaskRecord) {
  reportedSignatures.set(task.id, taskSignature(task))
  for (const ref of collectTaskImageRefs(task)) reportedImageIds.add(ref.id)
}

/** 判断是否需要上报：只报终结态（done / error），且同一状态只报一次 */
export function shouldReportTask(task: TaskRecord): boolean {
  if (task.status === 'running') return false
  return reportedSignatures.get(task.id) !== taskSignature(task)
}

export function markTaskReportedIfNeeded(task: TaskRecord) {
  reportedSignatures.set(task.id, taskSignature(task))
}
