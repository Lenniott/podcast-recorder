import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { isRoomExpired } from './room-lifetime.js'
import { removeServerCopiesForRoom } from './server-copy-storage.js'

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

  // Drop retired columns from existing DBs (SQLite 3.35+). No-op if a column
  // is already gone, or if the SQLite version can't drop columns.
  for (const column of ['show_upload', 'guest_can_control_playback']) {
    try {
      _db.prepare(`ALTER TABLE rooms DROP COLUMN ${column}`).run()
    } catch (e) {
      if (!/no such column/i.test(String(e?.message || e))) throw e
    }
  }

  return _db
}

/** For tests only — resets the db singleton so a fresh DB_PATH is used */
export function _resetDb() {
  if (_db) { try { _db.close() } catch {} }
  _db = null
}

export function createRoom({ slug, name, passwordHash, passwordPlain = null }) {
  getDb().prepare(`
    INSERT INTO rooms (slug, name, password_hash, password_plain, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(slug, name, passwordHash, passwordPlain, Date.now())
}

export function getRoomBySlug(slug) {
  return getDb().prepare('SELECT * FROM rooms WHERE slug = ?').get(slug) || null
}

export function getActiveRoomBySlug(slug, { now = Date.now(), cleanupExpired = true } = {}) {
  const room = getRoomBySlug(slug)
  if (!room) return null
  if (!isRoomExpired(room, now)) return room
  if (cleanupExpired) deleteRoom(slug)
  return null
}

export function roomExists(slug) {
  return !!getActiveRoomBySlug(slug)
}

export function deleteRoom(slug) {
  removeServerCopiesForRoom(slug)
  return getDb().prepare('DELETE FROM rooms WHERE slug = ?').run(slug).changes
}

export function cleanupExpiredRooms({ now = Date.now() } = {}) {
  const rooms = getDb().prepare('SELECT slug, created_at FROM rooms').all()
  let deleted = 0
  for (const room of rooms) {
    if (!isRoomExpired(room, now)) continue
    deleted += deleteRoom(room.slug)
  }
  return deleted
}

export default { getDb }
