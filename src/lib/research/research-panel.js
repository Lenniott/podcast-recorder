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
import { parseResearchCard } from './research-card.js'
import { upsertResearchEntry, makeResearchEntryId, MAX_RESEARCH_QUESTION_LEN } from './research-sync.js'
import { MAX_TAB_TEXT_LEN } from '../room/tab-sync.js'
import { TRANSCRIPT_TAB_ID } from '../room/transcript-sync.js'

export { makeResearchEntryId }

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
export function buildManualAskRequest(question, currentTabText = '', transcriptLines = [], videoTitle = '') {
  return {
    kind: 'voice',
    query: String(question || '').trim().slice(0, MAX_RESEARCH_QUESTION_LEN),
    context: '',
    notes: '',
    currentTab: formatCurrentTabContext(currentTabText, videoTitle).slice(0, MAX_TAB_TEXT_LEN),
    transcript: joinTranscriptLines(transcriptLines).trim().slice(0, RESEARCH_TRANSCRIPT_BUDGET),
    // Sent alongside `currentTab` rather than only inside it, so a prompt can
    // ask for the title on its own via `{video_title}` (see CONTEXT.md).
    videoTitle: String(videoTitle || '').trim()
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

/**
 * The currently active notes tab's whole text (never the Transcript —
 * Custom does not run on Turns).
 */
export function activeNotesTabText(tabTexts, activeTabId) {
  if (!activeTabId || activeTabId === TRANSCRIPT_TAB_ID) return ''
  return tabTexts[activeTabId] || ''
}

/** YouTube title for the active notes tab, if the player has reported one. */
export function activeTabVideoTitle(tabVideoTitles, activeTabId) {
  if (!activeTabId || activeTabId === TRANSCRIPT_TAB_ID) return ''
  return String(tabVideoTitles?.[activeTabId] || '').trim()
}

/**
 * `{current_tab}` body: video title first (when known), then notes.
 * A missing title is omitted rather than leaving an empty "Video:" line.
 */
export function formatCurrentTabContext(notesText = '', videoTitle = '') {
  const notes = String(notesText || '')
  const title = String(videoTitle || '').trim()
  const notesBody = notes.trim() ? notes : ''
  if (!title) return notes
  return notesBody ? `Video: ${title}\n\n${notesBody}` : `Video: ${title}`
}

export function hasUsableResearchAnswer(answer) {
  return !!parseResearchCard(answer)
}

/**
 * One panel-button descriptor per configured Custom Prompt that does NOT
 * run against a highlight — the mirror image of selection-annotations.js's
 * customPromptActions, which handles the ones that do. `usesSelection` on
 * each summary (see db.js's listCustomPromptSummaries) is the one fact that
 * decides which list a prompt lands in: it references `{selection}` and
 * belongs only in the highlight popup, or it doesn't and belongs only here.
 * Never both, never neither.
 *
 * Same "always show it, disabled with a reason, rather than hide it"
 * philosophy as customPromptActions — a guest without Guest Research
 * Access should see the show's prompts exist, not wonder if they vanished.
 *
 * @param {{id:string,title:string,usesSelection?:boolean}[]} prompts — listCustomPromptSummaries()
 * @param {{canRun?:boolean}} options
 */
export function panelPromptButtons(prompts, { canRun = false } = {}) {
  return (prompts || [])
    // Strictly `=== false`, not just falsy: a summary with no usesSelection
    // at all (an old/unexpected shape) is excluded from BOTH lists rather
    // than defaulting into one — see customPromptActions' mirroring
    // `=== true`/truthy check just above its own doc comment.
    .filter((p) => p?.id && p.usesSelection === false && String(p?.title ?? '').trim())
    .map((p) => {
      const label = String(p.title).trim()
      return {
        id: p.id,
        label,
        disabled: !canRun,
        title: canRun ? `Run “${label}”` : 'Only the host can run a prompt in this room'
      }
    })
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
