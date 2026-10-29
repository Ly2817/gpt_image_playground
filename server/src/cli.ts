import { countRecords, getDatabase, getImage, getRecord, listRecordImageIds, listRecords } from './db.js'
import { imageFilePath } from './storage.js'
import { config } from './config.js'

/**
 * 存档查询工具，在容器内运行：
 *   docker exec <容器名> node server-dist/cli.js list
 *   docker exec <容器名> node server-dist/cli.js list --all --limit 50
 *   docker exec <容器名> node server-dist/cli.js show <任务id>
 *   docker exec <容器名> node server-dist/cli.js stats
 */

function formatTime(ms: number | null): string {
  if (!ms) return '-'
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function truncate(text: string, length = 40): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > length ? `${single.slice(0, length)}…` : single
}

function commandList(args: string[]) {
  const includeHidden = args.includes('--all')
  const limitIndex = args.indexOf('--limit')
  const limit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? '30', 10) || 30 : 30
  const rows = listRecords({ limit, includeHidden })
  if (!rows.length) {
    console.log('暂无记录')
    return
  }
  console.log(`共显示 ${rows.length} 条${includeHidden ? '（含用户已删除）' : '（不含用户已删除）'}\n`)
  console.log(['创建时间'.padEnd(20), '状态'.padEnd(8), '图片'.padEnd(5), '已隐藏', '提示词'].join(' '))
  console.log('-'.repeat(110))
  for (const row of rows) {
    const images = listRecordImageIds(row.id)
    const createdAt = formatTime(row.task_created_at ?? row.first_seen_at)
    console.log(
      [
        createdAt.padEnd(20),
        (row.status || '-').padEnd(8),
        String(images.length).padEnd(5),
        row.hidden_at ? '  是  ' : '  否  ',
        truncate(row.prompt, 36),
      ].join(' '),
    )
    console.log(`${' '.repeat(4)}id: ${row.id}`)
  }
}

function commandShow(args: string[]) {
  const id = args[0]
  if (!id) {
    console.error('用法: show <任务id>')
    process.exit(1)
  }
  const row = getRecord(id)
  if (!row) {
    console.error(`记录不存在: ${id}`)
    process.exit(1)
  }
  console.log(`任务 id   : ${row.id}`)
  console.log(`状态      : ${row.status}`)
  console.log(`创建时间  : ${formatTime(row.task_created_at)}`)
  console.log(`首次入库  : ${formatTime(row.first_seen_at)}`)
  console.log(`最后上报  : ${formatTime(row.last_seen_at)}`)
  console.log(`上报次数  : ${row.revision}`)
  console.log(`用户已删除: ${row.hidden_at ? `是（${formatTime(row.hidden_at)}，${row.hidden_reason ?? ''}）` : '否'}`)
  console.log(`提示词    :\n${row.prompt}\n`)

  const imageIds = listRecordImageIds(row.id)
  console.log(`关联图片共 ${imageIds.length} 张：`)
  for (const imageId of imageIds) {
    const meta = getImage(imageId)
    if (!meta) continue
    console.log(
      `  [${meta.role.padEnd(20)}] ${imageId}  ${formatBytes(meta.bytes)}  存于 ${imageFilePath(imageId, meta.ext)}`,
    )
  }

  const task = JSON.parse(row.payload_json) as Record<string, unknown>
  const params = task.params
  if (params && typeof params === 'object') {
    console.log(`\n参数      : ${JSON.stringify(params)}`)
  }
}

function commandStats() {
  const stats = countRecords()
  console.log(`数据目录      : ${config.dataDir}`)
  console.log(`任务总数      : ${stats.total}`)
  console.log(`用户已删除    : ${stats.hidden}`)
  console.log(`图片文件数    : ${stats.images}`)
  console.log(`图片占用      : ${formatBytes(stats.imageBytes)}`)
}

function commandImage(args: string[]) {
  const id = args[0]
  if (!id) {
    console.error('用法: image <图片id>')
    process.exit(1)
  }
  const meta = getImage(id)
  if (!meta) {
    console.error(`图片不存在: ${id}`)
    process.exit(1)
  }
  console.log(imageFilePath(id, meta.ext))
}

function main() {
  const [command = 'stats', ...args] = process.argv.slice(2)
  getDatabase()
  switch (command) {
    case 'list':
      return commandList(args)
    case 'show':
      return commandShow(args)
    case 'stats':
      return commandStats()
    case 'image':
      return commandImage(args)
    default:
      console.error(`未知命令: ${command}`)
      console.error('可用命令: list [--all] [--limit N] | show <id> | stats | image <图片id>')
      process.exit(1)
  }
}

main()
