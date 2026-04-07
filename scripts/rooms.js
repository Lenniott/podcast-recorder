#!/usr/bin/env node
/**
 * Room management CLI
 *
 * Usage:
 *   node scripts/rooms.js list
 *   node scripts/rooms.js delete <slug>
 *   node scripts/rooms.js delete --all
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'

const DB_PATH = process.env.DB_PATH || './data/rooms.db'
mkdirSync('./data', { recursive: true })

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
  console.log(`\n${'SLUG'.padEnd(14)} ${'NAME'.padEnd(40)} CREATED`)
  console.log('─'.repeat(80))
  for (const r of rooms) {
    console.log(`${r.slug.padEnd(14)} ${r.name.slice(0, 39).padEnd(40)} ${formatDate(r.created_at)}`)
  }
  console.log(`\n${rooms.length} room(s) total.\n`)
}

function deleteRoom(slug) {
  const room = db.prepare('SELECT * FROM rooms WHERE slug = ?').get(slug)
  if (!room) {
    console.error(`Room not found: ${slug}`)
    process.exit(1)
  }
  db.prepare('DELETE FROM rooms WHERE slug = ?').run(slug)
  console.log(`Deleted: ${slug} ("${room.name}")`)
}

function deleteAll() {
  const { count } = db.prepare('SELECT COUNT(*) as count FROM rooms').get()
  db.prepare('DELETE FROM rooms').run()
  console.log(`Deleted ${count} room(s).`)
}

switch (command) {
  case 'list':
    list()
    break

  case 'delete':
    if (!arg) { console.error('Usage: node scripts/rooms.js delete <slug|--all>'); process.exit(1) }
    if (arg === '--all') deleteAll()
    else deleteRoom(arg)
    break

  default:
    console.log('Usage:')
    console.log('  node scripts/rooms.js list')
    console.log('  node scripts/rooms.js delete <slug>')
    console.log('  node scripts/rooms.js delete --all')
}
