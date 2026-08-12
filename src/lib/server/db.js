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
    _db.prepare(`ALTER TABLE rooms ADD COLUMN password_plain TEXT`).run()
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e
  }

  try {
    _db.prepare(`ALTER TABLE rooms ADD COLUMN guest_can_control_playback INTEGER NOT NULL DEFAULT 0`).run()
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e
  }

  // Drop the retired n8n-upload flag column from existing DBs (SQLite 3.35+).
  // No-op if it's already gone, or if the SQLite version can't drop columns.
  try {
    _db.prepare(`ALTER TABLE rooms DROP COLUMN show_upload`).run()
  } catch (e) {
    if (!/no such column/i.test(String(e?.message || e))) throw e
  }

  return _db
}

/** For tests only — resets the db singleton so a fresh DB_PATH is used */
export function _resetDb() {
  if (_db) { try { _db.close() } catch {} }
  _db = null
}

export function createRoom({ slug, name, passwordHash, passwordPlain = null, guestCanControlPlayback = false }) {
  const gc = guestCanControlPlayback ? 1 : 0
  getDb().prepare(`
    INSERT INTO rooms (slug, name, password_hash, password_plain, created_at, guest_can_control_playback)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(slug, name, passwordHash, passwordPlain, Date.now(), gc)
}

export function getRoomBySlug(slug) {
  return getDb().prepare('SELECT * FROM rooms WHERE slug = ?').get(slug) || null
}

export function roomExists(slug) {
  return !!getDb().prepare('SELECT 1 FROM rooms WHERE slug = ?').get(slug)
}

export default { getDb }
