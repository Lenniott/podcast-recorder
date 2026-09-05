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

  // Guest Research Access (see CONTEXT.md) — set once, at room creation,
  // replacing the old deployment-wide RESEARCH_GUEST_CAN_ASK env var.
  // Stored as 0/1 (SQLite has no boolean type); read back as a JS boolean
  // by getRoomBySlug/getActiveRoomBySlug's callers via `!!room.guest_ai_allowed`.
  try {
    _db.prepare(`ALTER TABLE rooms ADD COLUMN guest_ai_allowed INTEGER NOT NULL DEFAULT 0`).run()
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

  // Durable backing for the Room State Store (see room-state-store.js): a
  // room's tabs/text/video (and, later, transcript/research-assistant
  // content) once it's evicted from RAM after its grace period. One row
  // per room, the whole content blob as JSON — the shape is owned by the
  // Room State Store, not by this table, so it can grow new named pieces
  // of content without a migration here.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS room_content (
      slug       TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Deployment-wide settings — one row per key. Holds the Research Prompt
  // and Research Prompt Title (see CONTEXT.md), replacing the retired
  // RESEARCH_CUSTOM_PROMPT env var and the hardcoded INTERPRETATION_MODE_PROMPT
  // constant. A key/value shape (rather than a dedicated column-per-setting
  // table) so a new setting is another row, not a migration.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  // Always-on usage log backing the Usage Dashboard — one row per
  // askResearchAssistant call, every call, regardless of whether the debug
  // Research Eval Log is enabled (see ADR-0007). Never read/written outside
  // db.js's own accessors below.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS research_usage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_slug  TEXT NOT NULL,
      mode       TEXT NOT NULL,
      tokens     INTEGER,
      cost       REAL,
      created_at INTEGER NOT NULL
    )
  `)

  return _db
}

/** For tests only — resets the db singleton so a fresh DB_PATH is used */
export function _resetDb() {
  if (_db) { try { _db.close() } catch {} }
  _db = null
}

export function createRoom({ slug, name, passwordHash, passwordPlain = null, guestAiAllowed = false }) {
  getDb().prepare(`
    INSERT INTO rooms (slug, name, password_hash, password_plain, guest_ai_allowed, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(slug, name, passwordHash, passwordPlain, guestAiAllowed ? 1 : 0, Date.now())
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

/** Every non-expired room, newest first — Usage Dashboard's own room list. */
export function listRooms() {
  return getDb().prepare('SELECT * FROM rooms ORDER BY created_at DESC').all()
}

export function roomExists(slug) {
  return !!getActiveRoomBySlug(slug)
}

export function deleteRoom(slug) {
  removeServerCopiesForRoom(slug)
  deleteRoomContent(slug)
  return getDb().prepare('DELETE FROM rooms WHERE slug = ?').run(slug).changes
}

/** Durable adapter for the Room State Store — see room-state-store.js. */
export function saveRoomContent(slug, content) {
  getDb().prepare(`
    INSERT INTO room_content (slug, content, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(slug, JSON.stringify(content), Date.now())
}

export function loadRoomContent(slug) {
  const row = getDb().prepare('SELECT content FROM room_content WHERE slug = ?').get(slug)
  return row ? JSON.parse(row.content) : null
}

export function deleteRoomContent(slug) {
  return getDb().prepare('DELETE FROM room_content WHERE slug = ?').run(slug).changes
}

const RESEARCH_PROMPT_KEY = 'research_prompt'
const RESEARCH_PROMPT_TITLE_KEY = 'research_prompt_title'

/** The Research Prompt (see CONTEXT.md) — '' when unset. Custom also needs a Title. */
export function getResearchPrompt() {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(RESEARCH_PROMPT_KEY)
  return row ? row.value : ''
}

export function setResearchPrompt(value) {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(RESEARCH_PROMPT_KEY, String(value ?? ''))
}

/** The Research Prompt Title — Custom's button label. '' when unset. */
export function getResearchPromptTitle() {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(RESEARCH_PROMPT_TITLE_KEY)
  return row ? row.value : ''
}

export function setResearchPromptTitle(value) {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(RESEARCH_PROMPT_TITLE_KEY, String(value ?? '').trim())
}

/** One row per askResearchAssistant call — see ADR-0007. Never throws into
 *  the lookup path: a failed usage write shouldn't fail a lookup that
 *  otherwise succeeded. */
export function recordResearchUsage({ roomSlug, mode, tokens = null, cost = null }) {
  try {
    getDb().prepare(`
      INSERT INTO research_usage (room_slug, mode, tokens, cost, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(roomSlug, mode, tokens, cost, Date.now())
  } catch {
    // logging must never fail a lookup — see research-eval-log.js's own doc comment
  }
}

/** Usage Dashboard totals — every call, every room, all time. */
export function getResearchUsageTotals() {
  return getDb().prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
    FROM research_usage
  `).get()
}

/** Usage Dashboard per-room breakdown — one row per room that has ever had
 *  a call, including rooms since deleted (room_slug is not a foreign key,
 *  deliberately — usage history outlives the room it was run in). */
export function getResearchUsageByRoom() {
  return getDb().prepare(`
    SELECT room_slug AS slug, COUNT(*) AS calls, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
    FROM research_usage
    GROUP BY room_slug
    ORDER BY MAX(created_at) DESC
  `).all()
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
