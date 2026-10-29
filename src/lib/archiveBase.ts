/**
 * 存档服务的地址拼接。单独成文件，让 archiveSync 与 archiveImageSource
 * 都能复用而不产生循环依赖。
 */

/**
 * 服务端下发配置时用来占位的 Key。
 * 真实 Key 只存在服务器，由代理层在转发时注入；前端各处「是否已配置 Key」的校验靠它通过。
 * 必须与服务端 config.ts 里的 SERVER_MANAGED_KEY 保持一致。
 */
export const SERVER_MANAGED_API_KEY = '__server_managed__'

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
