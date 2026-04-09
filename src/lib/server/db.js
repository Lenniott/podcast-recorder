import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

let _db = null

function getDb() {
  if (_db) return _db

  const DB_PATH = process.env.DB_PATH || './data/rooms.db'

  // Don't try to create directories for in-memory DBs
  if (DB_PATH !== ':memory:') {
    mkdirSync(dirname(DB_PATH), { recursive: true })
  }

  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      slug          TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    )
  `)

  try {
    _db.prepare(`ALTER TABLE rooms ADD COLUMN show_upload INTEGER NOT NULL DEFAULT 1`).run()
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e
  }

  return _db
}

/** For tests only — resets the db singleton so a fresh DB_PATH is used */
export function _resetDb() {
  if (_db) { try { _db.close() } catch {} }
  _db = null
}

export function createRoom({ slug, name, passwordHash, showUpload = true }) {
  const su = showUpload ? 1 : 0
  getDb().prepare(`
    INSERT INTO rooms (slug, name, password_hash, created_at, show_upload)
    VALUES (?, ?, ?, ?, ?)
  `).run(slug, name, passwordHash, Date.now(), su)
}

export function getRoomBySlug(slug) {
  return getDb().prepare('SELECT * FROM rooms WHERE slug = ?').get(slug) || null
}

export function roomExists(slug) {
  return !!getDb().prepare('SELECT 1 FROM rooms WHERE slug = ?').get(slug)
}

export default { getDb }
