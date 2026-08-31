#!/usr/bin/env node
/**
 * Research Assistant eval harness.
 *
 * Feeds a canned mock conversation into a throwaway room's live Transcript,
 * one line at a time spaced out over real time (like an actual
 * conversation happening), then fires the exact same request
 * ResearchPanel.svelte's "Research recent conversation" button sends, and
 * prints the real AI output.
 *
 * Deliberately talks to a running server over its real WS + HTTP protocol
 * — the same one `npm run dev`/`npm run start` already exposes — rather
 * than importing src/lib/server/* modules directly. This mirrors
 * scripts/rooms.js's own convention (talk to the DB/crypto primitives
 * directly, never risk pulling in a SvelteKit-only import chain from a
 * plain `node` process), and it means every case here exercises the exact
 * same server-side code path a real user's click does — the real
 * room-state-store, the real research endpoint, a real OpenRouter call.
 *
 * Needs a real OPENROUTER_API_KEY in the server's .env to see a real
 * answer rather than a "not configured" error — this script makes genuine,
 * billed API calls once you have one set. Nothing here works without a
 * server already running (`npm run dev` in another terminal first).
 *
 * Usage (from the repo root, with `npm run dev` already running elsewhere):
 *   node --env-file=.env scripts/research-eval.js               # every case
 *   node --env-file=.env scripts/research-eval.js wrong-fact    # one case
 *   node --env-file=.env scripts/research-eval.js --list        # list cases, no calls
 *   node --env-file=.env scripts/research-eval.js --keep        # don't delete the rooms after
 *   node --env-file=.env scripts/research-eval.js --http=http://localhost:3000 --ws-port=3000
 *                                                                # against `npm run start` (single port)
 *
 * Or via the npm script (same env-file convention as `dev`/`start`):
 *   npm run research:eval -- wrong-fact
 */

import Database from 'better-sqlite3'
import { WebSocket } from 'ws'
import { createHmac, randomBytes } from 'crypto'
import { hash as bcryptHash } from 'bcryptjs'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// ─── Mock conversation cases ────────────────────────────────────────────
// Each line is spoken `afterMs` after the previous one (or after the case
// starts, for the first line) — paced to land the whole case in roughly a
// 15-25 second window, the same ballpark a short real exchange would take.
// Picked to cover the shapes of moment Research Mode's Gate Check
// (deferred, see docs/adr/0004) was meant to react to differently, so
// running all of them shows whether the current prompt (built for an
// explicit ask, not a "is there even anything here" judgment) forces an
// answer where a real Gate Check would have stayed silent.
const CASES = {
  'wrong-fact': {
    description: 'A specific, checkable factual claim that is actually wrong (a famous myth).',
    lines: [
      { speaker: 'Host', text: "You know the Great Wall of China is the only man-made structure visible from space, right?", afterMs: 0 },
      { speaker: 'Guest', text: "Oh yeah, I've heard that one, it's wild.", afterMs: 3000 },
      { speaker: 'Host', text: 'Astronauts have said you can just spot it with the naked eye up there.', afterMs: 4000 }
    ]
  },
  'obscure-reference': {
    description: 'A real but obscure named thing dropped without explanation.',
    lines: [
      { speaker: 'Guest', text: "This whole situation reminds me of the Dyatlov Pass incident, honestly.", afterMs: 0 },
      { speaker: 'Host', text: "Ha, sure, if you say so.", afterMs: 3000 },
      { speaker: 'Guest', text: "No but seriously, nobody's ever fully explained what happened there.", afterMs: 4000 }
    ]
  },
  'direct-question': {
    description: 'Someone explicitly asks a factual question mid-conversation.',
    lines: [
      { speaker: 'Host', text: "Wait, when did the Berlin Wall actually come down? I always forget the exact year.", afterMs: 0 },
      { speaker: 'Guest', text: "Late eighties sometime? I want to say '89.", afterMs: 3500 }
    ]
  },
  'pure-banter': {
    description: 'No factual content at all — checks whether the current prompt still forces an answer when a real Gate Check would have stayed silent.',
    lines: [
      { speaker: 'Host', text: "How's the coffee this morning?", afterMs: 0 },
      { speaker: 'Guest', text: "Pretty good actually, a bit strong.", afterMs: 3000 },
      { speaker: 'Host', text: "Yeah mine too, might need a refill before we keep going.", afterMs: 3500 }
    ]
  },
  'multiple-topics': {
    description: 'Two unrelated factual things in one window — checks how the model prioritizes when there\'s more than one candidate.',
    lines: [
      { speaker: 'Host', text: "So first, remind me — what year did the Titanic actually sink?", afterMs: 0 },
      { speaker: 'Guest', text: "1912, I think. Anyway, totally different topic, but did you know octopuses have three hearts?", afterMs: 4000 },
      { speaker: 'Host', text: "Wait really? That seems made up.", afterMs: 3500 }
    ]
  }
}

// ─── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')))
const opts = Object.fromEntries(
  args.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => a.slice(2).split('='))
)
const caseNames = args.filter((a) => !a.startsWith('--'))

if (flags.has('--list')) {
  console.log('Available cases:\n')
  for (const [name, { description }] of Object.entries(CASES)) {
    console.log(`  ${name.padEnd(20)} ${description}`)
  }
  process.exit(0)
}

const HTTP_BASE = opts.http || 'http://localhost:5173'
const WS_PORT = opts['ws-port'] || process.env.DEV_WS_PORT || '3001'
const WS_BASE = opts.ws || `ws://localhost:${WS_PORT}`
const KEEP_ROOMS = flags.has('--keep')

const SECRET = process.env.SECRET
if (!SECRET) {
  console.error('SECRET is not set — run this with the same .env your server uses, e.g.:\n  node --env-file=.env scripts/research-eval.js')
  process.exit(1)
}
if (!process.env.OPENROUTER_API_KEY) {
  console.warn('⚠️  OPENROUTER_API_KEY is not set in this .env — every case will get a "not configured" error, not a real answer.\n')
}

const selectedCases = caseNames.length > 0
  ? Object.fromEntries(caseNames.map((name) => {
      if (!CASES[name]) {
        console.error(`Unknown case "${name}". Run with --list to see available cases.`)
        process.exit(1)
      }
      return [name, CASES[name]]
    }))
  : CASES

// ─── Throwaway room setup — same DB the running server reads/writes
//     (better-sqlite3's WAL mode makes this a separate process's writes
//     visible to the server immediately) ──────────────────────────────
const DB_PATH = process.env.DB_PATH || './data/rooms.db'
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
// Idempotent — matches $lib/server/db.js's own schema exactly, so this
// script works even against a DB the real server hasn't touched yet (its
// own CREATE TABLE IF NOT EXISTS is lazy, on first real DB access).
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    slug          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_plain TEXT,
    created_at    INTEGER NOT NULL
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS room_content (
    slug       TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)

function makeSlug() {
  return 'eval-' + randomBytes(4).toString('hex')
}

async function createEvalRoom(name) {
  const slug = makeSlug()
  const password = randomBytes(8).toString('hex')
  const passwordHash = await bcryptHash(password, 10)
  db.prepare(`
    INSERT INTO rooms (slug, name, password_hash, password_plain, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(slug, name, passwordHash, password, Date.now())
  return { slug, passwordHash }
}

function deleteEvalRoom(slug) {
  db.prepare('DELETE FROM rooms WHERE slug = ?').run(slug)
  db.prepare('DELETE FROM room_content WHERE slug = ?').run(slug)
}

// Same HMAC shape as $lib/server/auth.js's makeSessionToken — reimplemented
// directly (not imported) for the same reason scripts/rooms.js talks to
// better-sqlite3 directly: this runs as a plain `node` process, and
// src/lib/server/* isn't guaranteed import-safe outside SvelteKit/Vite.
function makeSessionToken(slug, passwordHash) {
  return createHmac('sha256', SECRET).update(`${slug}:${passwordHash}`).digest('hex')
}

// ─── Drive one case ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function feedTranscript(slug, lines) {
  const ws = new WebSocket(`${WS_BASE}/ws?slug=${slug}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ type: 'join', name: 'Eval Script', clientId: randomBytes(6).toString('hex') }))
  await sleep(200) // let 'join' land before the first transcript_line

  for (const line of lines) {
    if (line.afterMs) await sleep(line.afterMs)
    ws.send(JSON.stringify({ type: 'transcript_line', speaker: line.speaker, text: line.text }))
  }
  await sleep(300) // let the last line's broadcast/append settle
  ws.close()
}

async function askResearchAssistant(slug, passwordHash, context) {
  const cookie = `pr_auth_${slug}=${makeSessionToken(slug, passwordHash)}`
  const res = await fetch(`${HTTP_BASE}/rec/${slug}/research`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ kind: 'voice', query: null, context, notes: '' })
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function transcriptText(lines) {
  return lines.map((l) => `${l.speaker}: ${l.text}`).join('\n')
}

async function runCase(name, { description, lines }, outDir) {
  console.log(`\n=== ${name} ===`)
  console.log(description)

  const { slug, passwordHash } = await createEvalRoom(`Eval — ${name}`)
  console.log(`Room: ${slug} (feeding ${lines.length} lines over ~${lines.reduce((s, l) => s + l.afterMs, 0) / 1000}s)`)

  try {
    await feedTranscript(slug, lines)
    const context = transcriptText(lines)
    const { status, body } = await askResearchAssistant(slug, passwordHash, context)

    console.log(`\n--- Transcript fed in ---\n${context}`)
    console.log(`\n--- Response (HTTP ${status}) ---`)
    if (body.answer) {
      console.log(body.answer)
      if (body.citations?.length) {
        console.log('\nCitations:')
        for (const c of body.citations) console.log(`  - ${c.title || c.url}: ${c.url}`)
      }
    } else {
      console.log(JSON.stringify(body, null, 2))
    }

    writeFileSync(
      join(outDir, `${name}.md`),
      [
        `# ${name}`,
        '',
        description,
        '',
        '## Transcript fed in',
        '```',
        context,
        '```',
        '',
        `## Response (HTTP ${status})`,
        '```json',
        JSON.stringify(body, null, 2),
        '```'
      ].join('\n')
    )
  } finally {
    if (!KEEP_ROOMS) deleteEvalRoom(slug)
  }
}

async function main() {
  const outDir = join('.scratch', 'research-assistant', 'eval-runs', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(outDir, { recursive: true })
  console.log(`Server: ${HTTP_BASE} (HTTP) / ${WS_BASE} (WS)`)
  console.log(`Saving results to ${outDir}/`)

  for (const [name, def] of Object.entries(selectedCases)) {
    await runCase(name, def, outDir)
  }

  console.log(`\nDone. Results saved to ${outDir}/`)
  db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
