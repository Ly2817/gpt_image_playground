import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './config.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id               TEXT PRIMARY KEY,
  prompt           TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT '',
  payload_json     TEXT    NOT NULL DEFAULT '{}',
  task_created_at  INTEGER,
  task_updated_at  INTEGER,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1,
  hidden_at        INTEGER,
  hidden_reason    TEXT
);

CREATE INDEX IF NOT EXISTS idx_records_created ON records(task_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_hidden  ON records(hidden_at);

CREATE TABLE IF NOT EXISTS record_images (
  image_id       TEXT PRIMARY KEY,
  record_id      TEXT,
  role           TEXT NOT NULL DEFAULT 'other',
  ext            TEXT NOT NULL DEFAULT 'png',
  bytes          INTEGER NOT NULL DEFAULT 0,
  width          INTEGER,
  height         INTEGER,
  first_seen_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_record_images_record ON record_images(record_id);

CREATE TABLE IF NOT EXISTS record_revisions (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id     TEXT NOT NULL,
  at            INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT '',
  payload_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_revisions_record ON record_revisions(record_id, seq DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  action     TEXT NOT NULL,
  record_id  TEXT,
  detail     TEXT
);

-- 全站共享的前端设置（目前只存 API 配置：profiles + activeProfileId）
CREATE TABLE IF NOT EXISTS shared_config (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json  TEXT    NOT NULL DEFAULT '{}',
  revision      INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL
);
`

export interface RecordRow {
  id: string
  prompt: string
  status: string
  payload_json: string
  task_created_at: number | null
  task_updated_at: number | null
  first_seen_at: number
  last_seen_at: number
  revision: number
  hidden_at: number | null
  hidden_reason: string | null
}

export interface ImageRow {
  image_id: string
  record_id: string | null
  role: string
  ext: string
  bytes: number
  width: number | null
  height: number | null
  first_seen_at: number
}

let database: DatabaseSync | null = null

export function getDatabase(): DatabaseSync {
  if (database) return database
  mkdirSync(dirname(paths.database), { recursive: true })
  const db = new DatabaseSync(paths.database)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  database = db
  return db
}

export function closeDatabase() {
  database?.close()
  database = null
}

/**
 * node:sqlite 的 get/all 返回 Record<string, SQLOutputValue>，
 * 这里统一收敛成具体行类型，避免每个调用点都写双重断言。
 */
function one<T>(row: unknown): T | undefined {
  return row as T | undefined
}

function many<T>(rows: unknown): T[] {
  return rows as T[]
}

/** 上报任务快照：同 id 重复上报时更新内容并累加 revision，但不动 hidden_at */
export function upsertRecord(input: {
  id: string
  prompt: string
  status: string
  payloadJson: string
  taskCreatedAt: number | null
  taskUpdatedAt: number | null
  now: number
}): void {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO records
       (id, prompt, status, payload_json, task_created_at, task_updated_at, first_seen_at, last_seen_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       prompt          = excluded.prompt,
       status          = excluded.status,
       payload_json    = excluded.payload_json,
       task_created_at = excluded.task_created_at,
       task_updated_at = excluded.task_updated_at,
       last_seen_at    = excluded.last_seen_at,
       revision        = records.revision + 1`,
  ).run(
    input.id,
    input.prompt,
    input.status,
    input.payloadJson,
    input.taskCreatedAt,
    input.taskUpdatedAt,
    input.now,
    input.now,
  )
}

/** 追加一条快照版本，用于追溯任务在不同阶段的内容 */
export function appendRevision(input: { recordId: string; at: number; status: string; payloadJson: string }) {
  getDatabase()
    .prepare('INSERT INTO record_revisions (record_id, at, status, payload_json) VALUES (?, ?, ?, ?)')
    .run(input.recordId, input.at, input.status, input.payloadJson)
}

export function getRecord(id: string): RecordRow | undefined {
  return one<RecordRow>(getDatabase().prepare('SELECT * FROM records WHERE id = ?').get(id))
}

export function listRecords(options: { limit: number; before?: number; includeHidden: boolean }): RecordRow[] {
  const db = getDatabase()
  const hiddenClause = options.includeHidden ? '' : 'AND hidden_at IS NULL'
  if (options.before) {
    return many<RecordRow>(
      db
        .prepare(
          `SELECT * FROM records
           WHERE COALESCE(task_created_at, first_seen_at) < ? ${hiddenClause}
           ORDER BY COALESCE(task_created_at, first_seen_at) DESC
           LIMIT ?`,
        )
        .all(options.before, options.limit),
    )
  }
  return many<RecordRow>(
    db
      .prepare(
        `SELECT * FROM records
         WHERE 1 = 1 ${hiddenClause}
         ORDER BY COALESCE(task_created_at, first_seen_at) DESC
         LIMIT ?`,
      )
      .all(options.limit),
  )
}

export function countRecords(): { total: number; hidden: number; images: number; imageBytes: number } {
  const db = getDatabase()
  const record = one<{ n: number }>(db.prepare('SELECT COUNT(*) AS n FROM records').get())
  const hidden = one<{ n: number }>(db.prepare('SELECT COUNT(*) AS n FROM records WHERE hidden_at IS NOT NULL').get())
  const images = one<{ n: number; b: number }>(
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM record_images').get(),
  )
  return { total: record?.n ?? 0, hidden: hidden?.n ?? 0, images: images?.n ?? 0, imageBytes: images?.b ?? 0 }
}

/** 记录图片元数据；同一图片 id 只登记一次（重复上报不覆盖首次记录） */
export function registerImage(input: {
  imageId: string
  recordId: string | null
  role: string
  ext: string
  bytes: number
  width: number | null
  height: number | null
  now: number
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO record_images (image_id, record_id, role, ext, bytes, width, height, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(image_id) DO UPDATE SET
         record_id = COALESCE(record_images.record_id, excluded.record_id),
         ext       = excluded.ext,
         bytes     = CASE WHEN excluded.bytes > 0 THEN excluded.bytes ELSE record_images.bytes END,
         width     = COALESCE(excluded.width, record_images.width),
         height    = COALESCE(excluded.height, record_images.height)`,
    )
    .run(input.imageId, input.recordId, input.role, input.ext, input.bytes, input.width, input.height, input.now)
}

export function getImage(imageId: string): ImageRow | undefined {
  return one<ImageRow>(getDatabase().prepare('SELECT * FROM record_images WHERE image_id = ?').get(imageId))
}

export function listRecordImageIds(recordId: string): string[] {
  const rows = many<{ image_id: string }>(
    getDatabase().prepare('SELECT image_id FROM record_images WHERE record_id = ?').all(recordId),
  )
  return rows.map((row) => row.image_id)
}

/** 用户侧删除：只打隐藏标记，数据与图片文件永久保留 */
export function hideRecord(id: string, now: number, reason: string): boolean {
  const db = getDatabase()
  const existing = getRecord(id)
  if (!existing) return false
  if (existing.hidden_at == null) {
    db.prepare('UPDATE records SET hidden_at = ?, hidden_reason = ? WHERE id = ?').run(now, reason, id)
    logAudit({ at: now, action: 'hide', recordId: id, detail: reason })
    return true
  }
  return false
}

export function logAudit(input: { at: number; action: string; recordId: string | null; detail: string }) {
  getDatabase()
    .prepare('INSERT INTO audit_log (at, action, record_id, detail) VALUES (?, ?, ?, ?)')
    .run(input.at, input.action, input.recordId, input.detail)
}

/** 所有被用户删除过的记录 id，前端据此把本地残留也清掉 */
export function listHiddenRecordIds(): string[] {
  const rows = many<{ id: string }>(
    getDatabase().prepare('SELECT id FROM records WHERE hidden_at IS NOT NULL ORDER BY hidden_at DESC').all(),
  )
  return rows.map((row) => row.id)
}

export interface SharedConfigRow {
  payload_json: string
  revision: number
  updated_at: number
}

export function getSharedConfig(): SharedConfigRow | undefined {
  return one<SharedConfigRow>(getDatabase().prepare('SELECT * FROM shared_config WHERE id = 1').get())
}

export function saveSharedConfig(payloadJson: string, now: number): number {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO shared_config (id, payload_json, revision, updated_at)
     VALUES (1, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET
       payload_json = excluded.payload_json,
       revision     = shared_config.revision + 1,
       updated_at   = excluded.updated_at`,
  ).run(payloadJson, now)
  const row = getSharedConfig()
  return row?.revision ?? 1
}
