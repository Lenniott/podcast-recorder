/**
 * Pure state-transition + request-shaping logic for the Research Assistant
 * panel (ticket 04) — kept out of ResearchPanel.svelte because
 * vitest.config.js excludes .svelte files from coverage entirely (see
 * $lib/exit-guard.js / $lib/server-copy-status.js for the same split on
 * other features: decision logic lives in a plain module, the component
 * just calls it).
 *
 * ResearchPanel.svelte's own local `entriesByTab` is fed exclusively by
 * applyResearchEntry/applyResearchState below, driven by the room's
 * `research_entry`/`research_state` broadcasts (see ws-rooms.js) — never by
 * copying or re-deriving another component's local variable, the same
 * discipline RoomTabs.svelte's `viewingTranscript` now follows.
 */
import { upsertResearchEntry, makeResearchEntryId, MAX_RESEARCH_QUESTION_LEN } from './research-sync.js'

export { makeResearchEntryId }

/** Applies a `research_entry` (create/update) broadcast into entriesByTab. */
export function applyResearchEntry(entriesByTab, msg) {
  return { ...entriesByTab, [msg.tabId]: upsertResearchEntry(entriesByTab[msg.tabId], msg.entry) }
}

/** Applies a `research_state` replay (one tab's full history) into entriesByTab. */
export function applyResearchState(entriesByTab, msg) {
  return { ...entriesByTab, [msg.tabId]: msg.entries }
}

/** Entries to show for whichever tab is currently active — never another
 *  tab's (see ADR-0002: "filed strictly per-tab"). */
export function visibleEntries(entriesByTab, activeTabId) {
  return entriesByTab[activeTabId] || []
}

/**
 * Turns a typed question into a request body for POST /rec/[slug]/research
 * (ticket 02's endpoint) — reuses the `voice` shape, with `query` set to the
 * typed question.
 *
 * Judgment call: `context`/`notes` are left empty rather than pulling in,
 * say, the Transcript-so-far. A manually typed question is already a
 * complete, self-contained ask — the participant chose exactly what to ask
 * — unlike a future Voice Trigger (ticket 06), which has no typed question
 * at all and genuinely needs the surrounding conversation as `context`, or
 * a Quick Action (ticket 05), which supplies the active tab's own text as
 * grounding. Wiring transcript/tab-text into this ticket's manual ask would
 * blur scope better left to those tickets' own judgment calls.
 */
export function buildManualAskRequest(question) {
  return { kind: 'voice', query: String(question || '').trim().slice(0, MAX_RESEARCH_QUESTION_LEN), context: '', notes: '' }
}

// Maps the research endpoint's error codes (see
// src/routes/rec/[slug]/research/+server.js's mapErrorReason) to a short,
// user-visible explanation — a failed ask must always resolve to a visible
// message, never a stuck, unexplained pending card.
const ERROR_MESSAGES = {
  unauthorized: 'You need to rejoin the room to ask a question.',
  'invalid-request': 'That question could not be sent.',
  'room-unavailable': 'This room is no longer available.',
  NOT_CONFIGURED: 'The Research Assistant is not configured for this room.',
  TIMEOUT: 'The Research Assistant took too long to respond. Try again.',
  UPSTREAM_ERROR: 'The Research Assistant could not be reached. Try again.',
  EMPTY_ANSWER: 'The Research Assistant had no answer for that. Try rephrasing.'
}

const GENERIC_ERROR_MESSAGE = 'Something went wrong asking the Research Assistant.'

export function describeResearchError(body) {
  return ERROR_MESSAGES[body?.error] || GENERIC_ERROR_MESSAGE
}
