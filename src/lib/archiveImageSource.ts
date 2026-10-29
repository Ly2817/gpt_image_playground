import { dbTransaction, STORE_IMAGES } from './idb'
import { archiveApiUrl } from './archiveBase'
import type { StoredImageRecord } from './imageBlob'

/**
 * 本机 IndexedDB 里没有这张图时，从服务端存档回源。
 * 用于「换浏览器/换设备登录后仍能看到历史」的场景：图片懒加载落回本地，之后就是本地读取。
 */

const inflight = new Map<string, Promise<StoredImageRecord | undefined>>()
const failed = new Set<string>()

export function isArchivedImageKnownMissing(id: string): boolean {
  return failed.has(id)
}

export function getArchivedImageRecord(id: string): Promise<StoredImageRecord | undefined> {
  const pending = inflight.get(id)
  if (pending) return pending
  if (failed.has(id)) return Promise.resolve(undefined)

  const task = (async (): Promise<StoredImageRecord | undefined> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(archiveApiUrl(`api/images/${encodeURIComponent(id)}`), {
        cache: 'force-cache',
        signal: controller.signal,
      })
      if (!response.ok) {
        // 404 说明服务端也没有，记下来避免反复请求
        if (response.status === 404) failed.add(id)
        return undefined
      }
      const blob = await response.blob()
      if (!blob.size) return undefined
      const record: StoredImageRecord = { id, blob, createdAt: Date.now(), source: 'generated' }
      try {
        await dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put(record))
      } catch (error) {
        // 存不进本地（配额/隐私模式）时仍然把这张图返回，本次会话可以正常显示
        console.warn('回源图片写入本地失败，仅本次可用', id, error)
      }
      return record
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
      inflight.delete(id)
    }
  })()

  inflight.set(id, task)
  return task
}
