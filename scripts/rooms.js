#!/usr/bin/env node
/**
 * Room management CLI
 *
 * Usage:
 *   node scripts/rooms.js list
 *   node scripts/rooms.js delete <index|index,index-range|slug|all|--all>
 */

import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'fs'
import { dirname, resolve, sep } from 'path'

const DB_PATH = process.env.DB_PATH || './data/rooms.db'
mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
const [,, command, arg] = process.argv

function formatDate(ms) {
  return new Date(ms).toLocaleString()
}

function list() {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all()
  if (rooms.length === 0) {
    console.log('No rooms found.')
    return
  }
  console.log(`\n${'#'.padEnd(4)} ${'SLUG'.padEnd(14)} ${'NAME'.padEnd(40)} CREATED`)
  console.log('─'.repeat(84))
  for (const [index, r] of rooms.entries()) {
    console.log(`${String(index + 1).padEnd(4)} ${r.slug.padEnd(14)} ${r.name.slice(0, 39).padEnd(40)} ${formatDate(r.created_at)}`)
  }
  console.log(`\n${rooms.length} room(s) total.\n`)
}

function deleteRoom(slug) {
  const room = db.prepare('SELECT * FROM rooms WHERE slug = ?').get(slug)
  if (!room) {
    console.error(`Room not found: ${slug}`)
    process.exit(1)
  }
  deleteServerCopies(slug)
  db.prepare('DELETE FROM rooms WHERE slug = ?').run(slug)
  console.log(`Deleted: ${slug} ("${room.name}")`)
}

function deleteAll() {
  const rooms = db.prepare('SELECT slug FROM rooms').all()
  for (const room of rooms) deleteServerCopies(room.slug)
  db.prepare('DELETE FROM rooms').run()
  console.log(`Deleted ${rooms.length} room(s).`)
}

function getServerCopyRoomDir(slug) {
  const root = resolve(process.env.SERVER_COPY_DIR || './data/server-copies')
  const dir = resolve(root, String(slug || ''))
  if (dir !== root && dir.startsWith(root + sep)) return dir
  throw new Error('Invalid room slug for server-copy storage')
}

function deleteServerCopies(slug) {
  rmSync(getServerCopyRoomDir(slug), { recursive: true, force: true })
}

function parseIndexSelection(selection, maxIndex) {
  const result = new Set()
  const parts = selection.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return { ok: false, error: 'Empty selection.' }

  for (const part of parts) {
    if (part.includes('-')) {
      const [startRaw, endRaw] = part.split('-').map((v) => v.trim())
      const start = Number.parseInt(startRaw, 10)
      const end = Number.parseInt(endRaw, 10)
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return { ok: false, error: `Invalid range: "${part}"` }
      }
      if (start < 1 || end < 1 || start > end || end > maxIndex) {
        return { ok: false, error: `Range out of bounds: "${part}" (valid: 1-${maxIndex})` }
      }
      for (let i = start; i <= end; i++) result.add(i)
      continue
    }

    const value = Number.parseInt(part, 10)
    if (!Number.isInteger(value)) return { ok: false, error: `Invalid index: "${part}"` }
    if (value < 1 || value > maxIndex) {
      return { ok: false, error: `Index out of bounds: "${part}" (valid: 1-${maxIndex})` }
    }
    result.add(value)
  }

  return { ok: true, indices: [...result].sort((a, b) => a - b) }
}

function deleteBySelection(selection) {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all()
  if (rooms.length === 0) {
    console.log('No rooms found.')
    return
  }

  const parsed = parseIndexSelection(selection, rooms.length)
  if (!parsed.ok) {
    console.error(parsed.error)
    process.exit(1)
  }

  const deleteStmt = db.prepare('DELETE FROM rooms WHERE slug = ?')
  for (const index of parsed.indices) {
    const room = rooms[index - 1]
    deleteServerCopies(room.slug)
    deleteStmt.run(room.slug)
    console.log(`Deleted #${index}: ${room.slug} ("${room.name}")`)
  }
  console.log(`Deleted ${parsed.indices.length} room(s).`)
}

switch (command) {
  case 'list':
    list()
    break

  case 'delete':
    if (!arg) { console.error('Usage: node scripts/rooms.js delete <index|index,index-range|slug|all|--all>'); process.exit(1) }
    if (arg === '--all' || arg.toLowerCase() === 'all') {
      deleteAll()
    } else if (/^\d+([,-]\d+)*(-\d+)?$/.test(arg)) {
      deleteBySelection(arg)
    } else {
      deleteRoom(arg)
    }
    break

  default:
    console.log('Usage:')
    console.log('  node scripts/rooms.js list')
    console.log('  node scripts/rooms.js delete <index|index,index-range|slug|all|--all>')
}
