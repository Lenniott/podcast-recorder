import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { isRoomExpired } from './room-lifetime.js'
import { removeServerCopiesForRoom } from './server-copy-storage.js'
import { normalizeOutputFormat } from '../home/custom-prompts.js'
import { promptReferencesSelection } from '../research/placeholders.js'

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

  // Deployment-wide settings — one row per key. A key/value shape (rather
  // than a dedicated column-per-setting table) so a new setting is another
  // row, not a migration. The Research Prompt and Research Prompt Title
  // used to live here as two rows; ADR-0008 replaced that single pair with
  // the custom_prompts collection below, and migrateLegacyResearchPrompt()
  // moves any surviving pair across.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  // Custom Prompts (see CONTEXT.md, ADR-0008) — the deployment-wide list of
  // named `{title, prompt text}` pairs that replaced the one global Research
  // Prompt. Same site-password-gated scope as the setting it replaced: not
  // per-room, and no room column here deliberately. `id` is the stable
  // identifier a highlight-triggered lookup references, so it must survive a
  // title edit — hence a generated id rather than the title as a key.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS custom_prompts (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      position   INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  // Per-prompt output format (structured-research-output ticket 02) — 'text'
  // (today's freeform reply) or 'blocks' (research-blocks.js's typed
  // containers). Same ALTER-then-ignore-duplicate-column pattern as
  // rooms.password_plain/guest_ai_allowed above. Defaults to 'text' so every
  // Custom Prompt that existed before this column did keeps behaving exactly
  // as it did before — zero migration risk.
  try {
    _db.prepare(`ALTER TABLE custom_prompts ADD COLUMN output_format TEXT NOT NULL DEFAULT 'text'`).run()
  } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e
  }

  migrateLegacyResearchPrompt(_db)

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

const LEGACY_RESEARCH_PROMPT_KEY = 'research_prompt'
const LEGACY_RESEARCH_PROMPT_TITLE_KEY = 'research_prompt_title'

/**
 * One-time move of the retired single Research Prompt (two `settings` rows)
 * into the custom_prompts collection, so an existing deployment's prompt
 * isn't silently lost the first time it runs this build. Only ever fires on
 * a DB that still has those rows; the rows are deleted afterwards so it
 * can't run twice or resurrect a prompt the operator has since deleted.
 */
function migrateLegacyResearchPrompt(db) {
  const read = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? ''
  const prompt = read(LEGACY_RESEARCH_PROMPT_KEY)
  const title = read(LEGACY_RESEARCH_PROMPT_TITLE_KEY)
  if (!prompt && !title) return

  if (String(prompt).trim() || String(title).trim()) {
    db.prepare(`
      INSERT INTO custom_prompts (id, title, prompt, position, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(makeCustomPromptId(), String(title).trim() || 'Custom', String(prompt), 0, Date.now())
  }
  db.prepare('DELETE FROM settings WHERE key IN (?, ?)')
    .run(LEGACY_RESEARCH_PROMPT_KEY, LEGACY_RESEARCH_PROMPT_TITLE_KEY)
}

/** Stable Custom Prompt id — opaque, only ever compared for equality. */
function makeCustomPromptId() {
  return `cp_${randomBytes(8).toString('hex')}`
}

function toCustomPrompt(row) {
  return row
    ? { id: row.id, title: row.title, prompt: row.prompt, outputFormat: normalizeOutputFormat(row.output_format) }
    : null
}

/**
 * Every configured Custom Prompt (see CONTEXT.md), in author-chosen order.
 * Includes the full template text — for the Usage Dashboard editor and for
 * server-side resolution, not for shipping wholesale to a room's clients.
 */
export function listCustomPrompts() {
  return getDb()
    .prepare('SELECT id, title, prompt, output_format FROM custom_prompts ORDER BY position ASC, created_at ASC')
    .all()
    .map(toCustomPrompt)
}

/**
 * Custom Prompt id + title (+ usesSelection), never the template text
 * itself — what a room's clients need to render one button per prompt,
 * without shipping every prompt's instructions to every participant. This
 * is the "list all Custom Prompts" seam other surfaces call.
 *
 * `usesSelection` (computed here, from `prompt`, and never returned itself)
 * is what splits a prompt between the two places its button can appear: a
 * template that references `{selection}` only ever means something run
 * against a highlighted excerpt, so it belongs in the highlight popup and
 * nowhere else; one that doesn't has no excerpt to run against, so it
 * belongs in the Research panel as a standalone button instead. See
 * `promptReferencesSelection` (research/placeholders.js) for the exact
 * rule — same one `buildCustomPromptRequest` already uses to decide what a
 * template is handed, so a prompt can never end up in a place its own
 * template disagrees with.
 */
export function listCustomPromptSummaries() {
  return getDb()
    .prepare('SELECT id, title, prompt FROM custom_prompts ORDER BY position ASC, created_at ASC')
    .all()
    .map((row) => ({ id: row.id, title: row.title, usesSelection: promptReferencesSelection(row.prompt) }))
}

/** One Custom Prompt by its stable id — null when there's no such prompt. */
export function getCustomPrompt(id) {
  const row = getDb()
    .prepare('SELECT id, title, prompt, output_format FROM custom_prompts WHERE id = ?')
    .get(String(id ?? ''))
  return toCustomPrompt(row) || null
}

/**
 * The saved template text for one Custom Prompt id — the seam a triggered
 * lookup resolves through. An unknown id gives '', matching the Placeholder
 * rule: a missing piece of context is silently empty, never an error here.
 * The caller decides whether an empty template is worth refusing.
 */
export function getCustomPromptTemplate(id) {
  return getCustomPrompt(id)?.prompt ?? ''
}

/** Appends a Custom Prompt to the end of the list; returns the created row. */
export function createCustomPrompt({ title, prompt, outputFormat }) {
  const db = getDb()
  const nextPosition = (db.prepare('SELECT MAX(position) AS max FROM custom_prompts').get()?.max ?? -1) + 1
  const record = {
    id: makeCustomPromptId(),
    title: String(title ?? '').trim(),
    prompt: String(prompt ?? ''),
    outputFormat: normalizeOutputFormat(outputFormat)
  }
  db.prepare(`
    INSERT INTO custom_prompts (id, title, prompt, position, created_at, output_format) VALUES (?, ?, ?, ?, ?, ?)
  `).run(record.id, record.title, record.prompt, nextPosition, Date.now(), record.outputFormat)
  return record
}

/** Retitles/rewrites one Custom Prompt in place — its id is unchanged, so a
 *  prompt stays the same prompt to anything holding a reference to it. */
export function updateCustomPrompt(id, { title, prompt, outputFormat }) {
  return getDb()
    .prepare('UPDATE custom_prompts SET title = ?, prompt = ?, output_format = ? WHERE id = ?')
    .run(String(title ?? '').trim(), String(prompt ?? ''), normalizeOutputFormat(outputFormat), String(id ?? '')).changes > 0
}

export function deleteCustomPrompt(id) {
  return getDb().prepare('DELETE FROM custom_prompts WHERE id = ?').run(String(id ?? '')).changes > 0
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
