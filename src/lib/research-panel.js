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
import { MAX_TAB_TEXT_LEN } from './tab-sync.js'
import { TRANSCRIPT_TAB_ID } from './transcript-sync.js'

export { makeResearchEntryId }

// The five Quick Action buttons (ticket 05; CONTEXT.md's Quick Action
// entry) — must match research-assistant.js's own QUICK_ACTION_INSTRUCTIONS
// keys exactly, since actionId is forwarded verbatim to that server-side map.
const QUICK_ACTION_IDS = new Set(['define', 'keyFacts', 'factCheck', 'findExamples', 'analyze'])

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

/** Applies a `tab_text` broadcast into ResearchPanel's own tabId -> text
 *  copy (ticket 05) — fed from the exact same wire message RoomTabs.svelte's
 *  own `tabTexts` is fed from (see ResearchPanel.svelte), never copied or
 *  re-derived from RoomTabs' internal state, the same "one shared broadcast,
 *  never two independently-tracked copies" discipline `tabs_state`'s
 *  dual-routing to researchPanel already follows for `activeTabId`. */
export function applyTabText(tabTexts, msg) {
  return { ...tabTexts, [msg.tabId]: msg.text }
}

/** Applies a `transcript_state` replay (the full Transcript-so-far) into
 *  ResearchPanel's own copy of the transcript lines. */
export function applyTranscriptState(transcriptLines, msg) {
  return msg.lines
}

/** Applies one live `transcript_line` broadcast — appended, never reordered
 *  or dropped (see ADR-0002). */
export function applyTranscriptLine(transcriptLines, msg) {
  return [...transcriptLines, { id: msg.id, speaker: msg.speaker, text: msg.text, at: msg.at }]
}

/** The Transcript's lines-so-far as one block of text, "Speaker: text" per
 *  line — the same shape TranscriptTab.svelte renders each line as. */
function transcriptLinesToText(lines) {
  return (lines || []).map((line) => `${line.speaker}: ${line.text}`).join('\n')
}

/**
 * The currently active tab's whole text to act on (ticket 05) — an ordinary
 * tab's own `tab_text`, or, for the reserved Transcript tab id, its
 * lines-so-far joined into one block of text. Never a selection, never
 * another tab's text (see CONTEXT.md's Quick Action entry).
 */
export function activeTabText(tabTexts, transcriptLines, activeTabId) {
  if (activeTabId === TRANSCRIPT_TAB_ID) return transcriptLinesToText(transcriptLines)
  return tabTexts[activeTabId] || ''
}

/** Whether there's anything for a Quick Action button to act on — the
 *  ResearchPanel.svelte button-disabled check is built on this exact
 *  function, so "disabled" and "would refuse to send" can never disagree. */
export function hasQuickActionText(text) {
  return !!String(text || '').trim()
}

/**
 * Turns a Quick Action id + the active tab's whole text into a request body
 * for POST /rec/[slug]/research (ticket 02's endpoint) — the `quickAction`
 * shape ticket 02 already defined server-side: `{ kind: 'quickAction',
 * actionId, text }`. The client never builds instruction text itself —
 * research-assistant.js's QUICK_ACTION_INSTRUCTIONS owns that wording.
 *
 * Returns null for an unknown actionId, or for empty/whitespace-only text —
 * "nothing to act on" is a request that's never sent at all, never a request
 * sent with empty text (this is also what ResearchPanel.svelte's button-
 * disabled check is built on, so "disabled" and "would refuse to send" can
 * never disagree).
 */
export function buildQuickActionRequest(actionId, text) {
  if (!QUICK_ACTION_IDS.has(actionId)) return null
  const trimmed = String(text || '').trim().slice(0, MAX_TAB_TEXT_LEN)
  if (!trimmed) return null
  return { kind: 'quickAction', actionId, text: trimmed }
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
