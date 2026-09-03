/**
 * Pure state-transition + request-shaping logic for the Research Assistant
 * panel (ticket 04) — kept out of ResearchPanel.svelte because
 * vitest.config.js excludes .svelte files from coverage entirely (see
 * $lib/recording/exit-guard.js / $lib/server-copy/server-copy-status.js for the same split on
 * other features: decision logic lives in a plain module, the component
 * just calls it).
 *
 * ResearchPanel.svelte's own local `entriesByTab` is fed exclusively by
 * applyResearchEntry/applyResearchState below, driven by the room's
 * `research_entry`/`research_state` broadcasts (see ws-rooms.js) — never by
 * copying or re-deriving another component's local variable, the same
 * discipline RoomTabs.svelte's `viewingTranscript` now follows.
 */
import { parseResearchCard, TURN_ACTION_IDS } from './research-card.js'
import { upsertResearchEntry, makeResearchEntryId, MAX_RESEARCH_QUESTION_LEN } from './research-sync.js'
import { MAX_TAB_TEXT_LEN } from '../room/tab-sync.js'
import { TRANSCRIPT_TAB_ID } from '../room/transcript-sync.js'

export { makeResearchEntryId, TURN_ACTION_IDS }

const TURN_ACTION_ID_SET = new Set(TURN_ACTION_IDS)
const RESEARCH_TRANSCRIPT_BUDGET = MAX_TAB_TEXT_LEN

/** Applies a `research_entry` (create/update) broadcast into entriesByTab. */
export function applyResearchEntry(entriesByTab, msg) {
  return { ...entriesByTab, [msg.tabId]: upsertResearchEntry(entriesByTab[msg.tabId], msg.entry) }
}

/** Applies a `research_state` replay (one tab's full history) into entriesByTab. */
export function applyResearchState(entriesByTab, msg) {
  return { ...entriesByTab, [msg.tabId]: msg.entries }
}

/** Applies a `research_removed` broadcast — drops one entry from its tab's
 *  list outright (unlike applyResearchEntry, which always upserts). */
export function applyResearchRemove(entriesByTab, msg) {
  const list = entriesByTab[msg.tabId]
  if (!list) return entriesByTab
  return { ...entriesByTab, [msg.tabId]: list.filter((e) => e.id !== msg.entryId) }
}

/** Entries to show for whichever tab is currently active — never another
 *  tab's (see ADR-0002: "filed strictly per-tab"). Newest first so the
 *  lookup you just ran is at the top of the skim list. */
export function visibleEntries(entriesByTab, activeTabId) {
  return newestFirst((entriesByTab[activeTabId] || []).filter(isSkimVisibleEntry))
}

export function newestFirst(entries) {
  return (entries || [])
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.at || 0) - (a.entry.at || 0) || a.index - b.index)
    .map(({ entry }) => entry)
}

/** A Research Card the panel may show while people are talking — pending
 *  Ask/Custom, errors, or an answered entry with a real parsed card.
 *  Empty/"nothing to add" answers stay in the eval log, not the skim list. */
export function isSkimVisibleEntry(entry) {
  if (!entry) return false
  if (entry.status === 'pending' || entry.status === 'errored') return true
  if (entry.status === 'answered') return !!parseResearchCard(entry.answer)
  return false
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
 *
 * `currentTab`/`transcript` are sent anyway, separately from `context`/
 * `notes` — not folded into the question automatically, only substituted
 * server-side (research-assistant.js) if the asker wrote a `{current_tab}`/
 * `{transcript}` Placeholder into `query` themselves (see CONTEXT.md).
 */
export function buildManualAskRequest(question, currentTabText = '', transcriptLines = []) {
  return {
    kind: 'voice',
    query: String(question || '').trim().slice(0, MAX_RESEARCH_QUESTION_LEN),
    context: '',
    notes: '',
    currentTab: String(currentTabText || '').slice(0, MAX_TAB_TEXT_LEN),
    transcript: joinTranscriptLines(transcriptLines).trim().slice(0, RESEARCH_TRANSCRIPT_BUDGET)
  }
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

function formatTranscriptLine(line) {
  return `${line.speaker}: ${line.text}`
}

function joinTranscriptLines(lines) {
  return (lines || []).map(formatTranscriptLine).join('\n')
}

/** Two Turns before the Focus Turn, plus one after if it already exists. */
export function groundingLinesForFocus(transcriptLines, focusTurnId) {
  const lines = transcriptLines || []
  const index = lines.findIndex((line) => line.id === focusTurnId)
  if (index < 0) return []
  const before = lines.slice(Math.max(0, index - 2), index)
  const after = lines.slice(index + 1, index + 2)
  return [...before, ...after]
}

export function buildTurnActionRequest(transcriptLines, focusTurnId, actionId) {
  if (!TURN_ACTION_ID_SET.has(actionId)) return null
  const lines = transcriptLines || []
  const focus = lines.find((line) => line.id === focusTurnId)
  if (!focus || !String(focus.text || '').trim()) return null
  const grounding = joinTranscriptLines(groundingLinesForFocus(lines, focusTurnId)).slice(0, RESEARCH_TRANSCRIPT_BUDGET)
  const focusText = formatTranscriptLine(focus).slice(0, RESEARCH_TRANSCRIPT_BUDGET)
  return { kind: 'turnAction', actionId, focus: focusText, grounding }
}

/** Collapses a card's citations to one per source site, shown as its bare
 *  host (e.g. "en.wikipedia.org") rather than the page title — a research
 *  card can cite the same domain twice (two different Wikipedia pages, a
 *  search result and its AMP mirror) and the skim list only needs to know
 *  which *sites* backed the claim, not every individual URL. First
 *  occurrence wins so citation order (most-relevant-first, from the
 *  web-search plugin) still decides which link a repeated host points at. */
export function dedupeCitationsByHost(citations) {
  const seen = new Set()
  const result = []
  for (const citation of citations || []) {
    const host = hostOf(citation?.url)
    if (!host || seen.has(host)) continue
    seen.add(host)
    result.push({ url: citation.url, host })
  }
  return result
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Which Turn Action icons should stay disabled because they've already
 *  been run — room-shared (derived from `entriesByTab`, the same
 *  research_entry state every peer replays on join) rather than a local
 *  "I clicked this in my browser" flag, so it survives a refresh and is
 *  consistent for every participant. Scans every tab's entries, not just
 *  the active one — a Turn Action's entry is filed under whichever tab was
 *  active *when it was asked* (see ws-rooms.js's research_ask handler),
 *  which may not be the tab that's active now. */
export function deriveDoneActionsByTurn(entriesByTab) {
  const result = {}
  for (const list of Object.values(entriesByTab || {})) {
    for (const entry of list || []) {
      if (!entry?.turnId || !TURN_ACTION_ID_SET.has(entry.actionId)) continue
      const done = result[entry.turnId] || (result[entry.turnId] = [])
      if (!done.includes(entry.actionId)) done.push(entry.actionId)
    }
  }
  return result
}

/**
 * The currently active notes tab's whole text (never the Transcript Tab —
 * Custom does not run on Turns).
 */
export function activeNotesTabText(tabTexts, activeTabId) {
  if (!activeTabId || activeTabId === TRANSCRIPT_TAB_ID) return ''
  return tabTexts[activeTabId] || ''
}

export function hasCustomText(text) {
  return !!String(text || '').trim()
}

export function buildCustomRequest(text, transcriptLines) {
  const trimmed = String(text || '').trim().slice(0, MAX_TAB_TEXT_LEN)
  if (!trimmed) return null
  const transcript = joinTranscriptLines(transcriptLines).trim().slice(0, RESEARCH_TRANSCRIPT_BUDGET)
  return { kind: 'custom', text: trimmed, transcript }
}

export function hasUsableResearchAnswer(answer) {
  return !!parseResearchCard(answer)
}

// Maps the research endpoint's error codes (see
// src/routes/rec/[slug]/research/+server.js's mapErrorReason) to a short,
// user-visible explanation — a failed ask must always resolve to a visible
// message, never a stuck, unexplained pending card.
const ERROR_MESSAGES = {
  unauthorized: 'You need to rejoin the room to ask a question.',
  forbidden: 'You do not have access to Custom in this room.',
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
