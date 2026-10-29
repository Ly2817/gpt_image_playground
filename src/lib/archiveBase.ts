/**
 * 存档服务的地址拼接。单独成文件，让 archiveSync 与 archiveImageSource
 * 都能复用而不产生循环依赖。
 */

/**
 * 跟随前端 base 路径拼接站内 API，子目录部署时不会打到域名根。
 * 刻意用 location.origin 而不是 document.baseURI：后者在某些访问方式下会带上
 * URL 内嵌凭据（https://user:pass@host/...），带 userinfo 的 URL 会被 fetch 直接拒绝。
 */
export function archiveApiUrl(path: string): string {
  const { origin, pathname } = window.location
  const dir = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1)
  return `${origin}${dir}${path.replace(/^\/+/, '')}`
}
