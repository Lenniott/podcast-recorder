/**
 * Usage Dashboard — one entry point, `getUsageDashboard()`, for the section
 * of the create-room page (see CONTEXT.md) showing Research Assistant
 * cost/usage across every room. Concentrates reads across db.js (rooms,
 * research_usage), room-state-store.js (a room's live tab/Transcript/
 * research-entry counts, hot or evicted alike) and server-copy-storage.js
 * (recording length, from each take's own WAV header) behind one call —
 * see ADR "Usage Dashboard gets its own aggregation module" (architecture
 * review) for why this doesn't live inline in a page load.
 */
import { listRooms, getResearchUsageTotals, getResearchUsageByRoom } from './db.js'
import { roomStateStore } from './ws-rooms.js'
import { listServerCopyFiles } from './server-copy-storage.js'

const BYTES_PER_SAMPLE = 2 // 16-bit mono PCM, fixed — see audio-utils.js's buildWavHeader

// Every e2e room is named "E2E <spec name> <timestamp>" (see
// tests/playwright/helpers.js's createRoom and every spec's own call) — an
// existing, already-relied-on convention, not a new marker invented for
// this filter. HIDE_TEST_ROOMS_IN_DASHBOARD (same injectable-`env`/
// truthy-string shape as research-eval-log.js's isResearchEvalLogEnabled)
// keeps a local dev run's e2e churn out of the per-room table without
// touching what a production deployment sees — nothing there is ever
// named "E2E ", so the flag has no effect in production regardless.
export function hideTestRoomsInDashboard(env = process.env) {
  const raw = String(env.HIDE_TEST_ROOMS_IN_DASHBOARD || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function isTestRoom(name) {
  return String(name || '').startsWith('E2E ')
}

/** Total recorded seconds across every participant/take in a room — summed
 *  from each WAV's own byte size and sample rate, not estimated. */
function recordingSeconds(slug) {
  let seconds = 0
  for (const file of listServerCopyFiles(slug)) {
    const dataBytes = Math.max(0, file.byteSize - 44)
    seconds += dataBytes / (file.sampleRate * BYTES_PER_SAMPLE)
  }
  return Math.round(seconds)
}

/** Tab count, research-card count, and a word-count estimate of the
 *  Transcript — read the same way a reconnecting participant would (see
 *  roomStateStore's export doc comment), so a room mid-recording reports
 *  the same live numbers a durable-only read would miss. */
function contentStats(slug) {
  const content = roomStateStore.getRoom(slug)
  const tabCount = content.tabs?.list?.length ?? 0
  const researchCardCount = Object.values(content.research || {}).reduce((sum, list) => sum + list.length, 0)
  const transcriptWords = (content.transcript?.lines || [])
    .reduce((sum, line) => sum + String(line.text || '').trim().split(/\s+/).filter(Boolean).length, 0)
  return { tabCount, researchCardCount, transcriptWords }
}

/** Totals + a per-room breakdown, newest room first. Usage rows (calls/
 *  tokens/cost) key off room slug and outlive a deleted room; every other
 *  stat here only exists for a room still in `rooms`. Totals are always
 *  all-time/all-room, e2e included — HIDE_TEST_ROOMS_IN_DASHBOARD only
 *  thins the per-room table, not the running totals. */
export function getUsageDashboard(env = process.env) {
  const totals = getResearchUsageTotals()
  const usageBySlug = new Map(getResearchUsageByRoom().map((row) => [row.slug, row]))
  const hideTestRooms = hideTestRoomsInDashboard(env)

  const rooms = listRooms()
    .filter((room) => !hideTestRooms || !isTestRoom(room.name))
    .map((room) => {
      const usage = usageBySlug.get(room.slug)
      const { tabCount, researchCardCount, transcriptWords } = contentStats(room.slug)
      return {
        slug: room.slug,
        name: room.name,
        createdAt: room.created_at,
        calls: usage?.calls ?? 0,
        tokens: usage?.tokens ?? 0,
        cost: usage?.cost ?? 0,
        recordingSeconds: recordingSeconds(room.slug),
        transcriptWords,
        tabCount,
        researchCardCount
      }
    })

  return { totals, rooms }
}
