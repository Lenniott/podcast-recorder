/**
 * Room State Store — the deep module owning a room's shared content:
 * tabs/text/video, the Transcript (ticket 01), and per-tab Research
 * Assistant entries (ticket 04) — all same-shaped sibling content kinds,
 * see ADR-0002.
 *
 * Lifecycle: while >=1 participant is connected, a room's content lives
 * only in the injected `hot` store (no disk I/O). The instant the last
 * participant disconnects (onParticipantLeft), a grace timer starts; if
 * nobody reconnects before it fires, the content is flushed to the
 * injected `durable` store and evicted from `hot`. A reconnect
 * (onParticipantJoined) at any point — including while a flush is
 * in-flight — cancels the eviction and the room keeps running hot.
 *
 * ws-rooms.js is the only caller and talks to this module exclusively
 * through the interface returned here — it never touches `hot` or
 * `durable` directly, and never sees whether a room was ever evicted.
 */

import { MAX_TABS, MAX_TAB_TEXT_LEN, nextTabTitle } from '../tab-sync.js'
import { MAX_TRANSCRIPT_LINE_LEN, MAX_TRANSCRIPT_SPEAKER_LEN, TRANSCRIPT_TAB_ID } from '../transcript-sync.js'
import { MAX_RESEARCH_QUESTION_LEN, MAX_RESEARCH_ANSWER_LEN, sanitizeCitations } from '../research-sync.js'

const DEFAULT_GRACE_MS = 10_000

/**
 * Reads the grace period from `ROOM_STATE_GRACE_MS` (milliseconds) —
 * same injectable-`env`/parse/fallback shape as `room-lifetime.js`'s
 * `getRoomMaxAgeHours`. Not exposed as a config *hours* value like room
 * expiry — this is meant to be tuned in milliseconds, and tuned way down
 * (e.g. the e2e suite sets it to 200ms — see playwright.config.js) so
 * tests never have to sleep through a real 10-second wait.
 */
export function getRoomStateGraceMs(env = process.env) {
  const raw = Number.parseInt(String(env.ROOM_STATE_GRACE_MS || ''), 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_MS
}

function makeTabId() {
  return 'tab-' + Math.random().toString(36).slice(2, 10)
}

/** Default hot store: a plain in-memory map. Swappable in tests. */
function createInMemoryHotStore() {
  const map = new Map()
  return {
    get: (slug) => map.get(slug),
    set: (slug, content) => { map.set(slug, content) },
    delete: (slug) => { map.delete(slug) },
    clear: () => { map.clear() }
  }
}

function createDefaultRoomContent() {
  const id = makeTabId()
  return {
    tabs: {
      list: [{ id, title: nextTabTitle([]), video: null, text: '' }],
      activeTabId: id
    },
    // Sibling content, not an entry in tabs.list — the Transcript is never
    // an ordinary Tab a client can create/switch/close/rename (see
    // ADR-0002 and ticket 01). Its own permanent, uncloseable presence in
    // the room's UI tab strip is a client-side concern (RoomTabs.svelte
    // always renders one, alongside whatever real tabs.list holds); here
    // it's just the append-only line log every room always has.
    transcript: { lines: [] },
    // Sibling content, keyed by tab id (never an entry in tabs.list either —
    // see ADR-0002 and ticket 04). `research[tabId]` is that tab's own
    // history of research entries, in the order they were asked; a tab with
    // no entries yet simply has no key here rather than an empty array, so
    // a brand-new room's research map is `{}`.
    research: {}
  }
}

export function createRoomStateStore({
  hot = createInMemoryHotStore(),
  durable,
  graceMs = DEFAULT_GRACE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (!durable) throw new Error('createRoomStateStore: a durable store adapter is required')

  // Per-slug lifecycle bookkeeping — separate from room *content*, which
  // lives only in `hot`/`durable`. `occupied` tracks whether ws-rooms.js
  // currently considers the room non-empty; `graceTimer` is the pending
  // eviction (null once fired or cancelled); `flushInFlight` guards
  // against the grace timer somehow firing twice concurrently for the
  // same slug.
  const meta = new Map()

  function getMeta(slug) {
    let m = meta.get(slug)
    if (!m) {
      m = { occupied: false, graceTimer: null, flushInFlight: false }
      meta.set(slug, m)
    }
    return m
  }

  function cancelGraceTimer(m) {
    if (m.graceTimer == null) return
    clearTimeoutFn(m.graceTimer)
    m.graceTimer = null
  }

  function onParticipantJoined(slug) {
    const m = getMeta(slug)
    m.occupied = true
    cancelGraceTimer(m)
    return ensureRoom(slug)
  }

  function onParticipantLeft(slug) {
    const m = getMeta(slug)
    m.occupied = false
    cancelGraceTimer(m)
    m.graceTimer = setTimeoutFn(() => {
      m.graceTimer = null
      flushAndEvict(slug, m)
    }, graceMs)
    m.graceTimer?.unref?.()
  }

  function flushAndEvict(slug, m) {
    if (m.flushInFlight) return
    const content = hot.get(slug)
    if (content == null) return // nothing hot to flush

    m.flushInFlight = true
    let savePromise
    try {
      savePromise = Promise.resolve(durable.save(slug, content))
    } catch (err) {
      savePromise = Promise.resolve() // a synchronous throw fails the flush the same as a rejection
    }
    savePromise
      .catch(() => {}) // never lose live state over a failed flush — see below
      .then(() => {
        m.flushInFlight = false
        // Only evict if nobody reconnected (and no fresh grace timer is
        // already pending) while the write was in flight — this is what
        // keeps a race-landing reconnect from ever losing live state or
        // leaving the room simultaneously hot and evicted.
        if (!m.occupied && m.graceTimer == null) {
          hot.delete(slug)
        }
      })
  }

  function ensureRoom(slug) {
    let content = hot.get(slug)
    if (content) return content
    let loaded = null
    try {
      loaded = durable.load(slug)
    } catch {
      // A durable-storage read failure isn't itself data loss — the room
      // simply starts fresh rather than taking the whole join down with it.
      loaded = null
    }
    content = loaded || createDefaultRoomContent()
    // Content saved by a build that predates a given content kind (e.g. the
    // Transcript, ticket 01) won't have that key at all — backfill it here,
    // once, on hydration, rather than every call site defending against a
    // missing kind. This is the extension point ticket 00 promised: a new
    // content kind slots in without changing getRoom's shape or callers.
    if (!content.transcript) content.transcript = { lines: [] }
    if (!content.research) content.research = {}
    hot.set(slug, content)
    return content
  }

  function getRoom(slug) {
    return ensureRoom(slug)
  }

  /** Runs `mutate` against a room's hot content, hydrating first if needed. */
  function withRoom(slug, mutate) {
    return mutate(ensureRoom(slug))
  }

  function createTab(slug, { tabId, title } = {}) {
    return withRoom(slug, (content) => {
      const list = content.tabs.list
      const id = String(tabId || '').slice(0, 64)

      if (!id || list.some((t) => t.id === id)) {
        return { ok: false, error: 'Invalid or duplicate tab id' }
      }
      if (list.length >= MAX_TABS) {
        return { ok: false, error: `Too many tabs open (max ${MAX_TABS}).` }
      }

      const requestedTitle = String(title || '').trim().slice(0, 50)
      const tabTitle = requestedTitle || nextTabTitle(list.map((t) => t.title))
      list.push({ id, title: tabTitle, video: null, text: '' })
      content.tabs.activeTabId = id
      return { ok: true, room: content }
    })
  }

  function findTabIndex(content, tabId) {
    return content.tabs.list.findIndex((t) => t.id === tabId)
  }

  function switchTab(slug, tabId) {
    return withRoom(slug, (content) => {
      const id = String(tabId || '')
      // The one exception to "must be a real entry in tabs.list": the
      // reserved Transcript id is a valid *destination* to switch the
      // room's shared view to, even though (by design — see ADR-0002 and
      // createDefaultRoomContent) it is never itself an entry in
      // tabs.list. This is what makes "which pill the room is looking at"
      // genuinely room-shared for the Transcript too, broadcast the same
      // way switching to any real tab already is — not a second,
      // per-browser-only mechanism. closeTab/setTabText below still find
      // nothing at this id and refuse it exactly as before.
      if (id !== TRANSCRIPT_TAB_ID && findTabIndex(content, id) === -1) {
        return { ok: false, error: 'Unknown tab' }
      }
      content.tabs.activeTabId = id
      return { ok: true, room: content }
    })
  }

  function closeTab(slug, tabId) {
    return withRoom(slug, (content) => {
      const list = content.tabs.list
      const id = String(tabId || '')
      const idx = findTabIndex(content, id)
      if (idx === -1) return { ok: false, error: 'Unknown tab' }
      if (list.length <= 1) return { ok: false, error: 'Cannot close the only remaining tab' }

      list.splice(idx, 1)
      if (content.tabs.activeTabId === id) {
        content.tabs.activeTabId = list[Math.max(0, idx - 1)].id
      }
      return { ok: true, room: content }
    })
  }

  function findTab(content, tabId) {
    return content.tabs.list.find((t) => t.id === tabId)
  }

  function setTabVideo(slug, tabId, video) {
    return withRoom(slug, (content) => {
      const tab = findTab(content, String(tabId || ''))
      if (!tab) return { ok: false, error: 'Unknown tab' }
      tab.video = video
      return { ok: true, room: content }
    })
  }

  function makeTranscriptLineId() {
    return 'line-' + Math.random().toString(36).slice(2, 10)
  }

  function appendTranscriptLine(slug, { speaker, text } = {}) {
    return withRoom(slug, (content) => {
      const cleanSpeaker = String(speaker || '').trim().slice(0, MAX_TRANSCRIPT_SPEAKER_LEN)
      const cleanText = String(text || '').trim().slice(0, MAX_TRANSCRIPT_LINE_LEN)
      if (!cleanSpeaker || !cleanText) {
        return { ok: false, error: 'A transcript line needs both a speaker and text' }
      }

      const line = { id: makeTranscriptLineId(), speaker: cleanSpeaker, text: cleanText, at: Date.now() }
      // Append-only: this is the ONLY place a room's transcript is ever
      // mutated. It always pushes; it never reorders or replaces an
      // existing line (see ADR-0002 — that's the whole reason the
      // Transcript can't reuse tab_text's last-write-wins mechanism).
      content.transcript.lines.push(line)
      return { ok: true, room: content, line }
    })
  }

  function setTabText(slug, tabId, text) {
    return withRoom(slug, (content) => {
      const tab = findTab(content, String(tabId || ''))
      if (!tab) return { ok: false, error: 'Unknown tab' }
      tab.text = String(text ?? '').slice(0, MAX_TAB_TEXT_LEN)
      return { ok: true, room: content }
    })
  }

  // ── Research Assistant entries (per-tab, shared — see ADR-0002 and
  //    ticket 04) ────────────────────────────────────────────────────────

  /** Finds an entry by id across every tab's history (an entry's tabId is
   *  fixed at creation — see addResearchEntry — so a later resolve/error
   *  never needs the caller to know or re-supply which tab it lives under,
   *  even if the room's currently-active tab has since changed). */
  function findResearchEntry(content, entryId) {
    for (const tabId of Object.keys(content.research)) {
      const idx = content.research[tabId].findIndex((e) => e.id === entryId)
      if (idx !== -1) return { tabId, idx }
    }
    return null
  }

  function addResearchEntry(slug, tabId, { id, question } = {}) {
    return withRoom(slug, (content) => {
      const entryId = String(id || '').slice(0, 64)
      if (!entryId || findResearchEntry(content, entryId)) {
        return { ok: false, error: 'Invalid or duplicate research entry id' }
      }

      const cleanQuestion = String(question || '').trim().slice(0, MAX_RESEARCH_QUESTION_LEN)
      if (!cleanQuestion) {
        return { ok: false, error: 'A research question cannot be empty' }
      }

      const tid = String(tabId || '')
      const entry = {
        id: entryId,
        tabId: tid,
        question: cleanQuestion,
        status: 'pending',
        answer: null,
        citations: [],
        error: null,
        at: Date.now()
      }
      // A pending entry is real, broadcast state the instant it's created
      // (see ws-rooms.js's research_ask handler) — never a client-only
      // illusion invented before the server has recorded anything.
      if (!content.research[tid]) content.research[tid] = []
      content.research[tid].push(entry)
      return { ok: true, room: content, entry, tabId: tid }
    })
  }

  function resolveResearchEntry(slug, entryId, { answer, citations } = {}) {
    return withRoom(slug, (content) => {
      const found = findResearchEntry(content, String(entryId || ''))
      if (!found) return { ok: false, error: 'Unknown research entry' }

      const entry = content.research[found.tabId][found.idx]
      entry.status = 'answered'
      entry.answer = String(answer || '').slice(0, MAX_RESEARCH_ANSWER_LEN)
      entry.citations = sanitizeCitations(citations)
      entry.error = null
      return { ok: true, room: content, entry, tabId: found.tabId }
    })
  }

  function errorResearchEntry(slug, entryId, { message } = {}) {
    return withRoom(slug, (content) => {
      const found = findResearchEntry(content, String(entryId || ''))
      if (!found) return { ok: false, error: 'Unknown research entry' }

      const entry = content.research[found.tabId][found.idx]
      entry.status = 'errored'
      // A failed request must always resolve to a visible error, never an
      // entry stuck pending forever — this is the ONLY other place a
      // pending entry's status ever changes, alongside resolveResearchEntry
      // above.
      entry.error = String(message || 'Something went wrong.').slice(0, MAX_RESEARCH_ANSWER_LEN)
      entry.answer = null
      return { ok: true, room: content, entry, tabId: found.tabId }
    })
  }

  /** Removes one research entry outright (not a status change — the entry
   *  disappears from the tab's history for everyone, unlike resolve/error
   *  above which always leave the entry in place). Lets a participant clear
   *  a card they no longer want cluttering the skim list. */
  function removeResearchEntry(slug, entryId) {
    return withRoom(slug, (content) => {
      const found = findResearchEntry(content, String(entryId || ''))
      if (!found) return { ok: false, error: 'Unknown research entry' }

      content.research[found.tabId].splice(found.idx, 1)
      return { ok: true, room: content, tabId: found.tabId, entryId: String(entryId) }
    })
  }

  /** For tests only — clears hot content and cancels every pending grace
   *  timer, so each test starts clean (mirrors ws-rooms.js's own
   *  _resetRooms, since this Store now owns what that used to hold). */
  function _resetForTests() {
    for (const m of meta.values()) cancelGraceTimer(m)
    meta.clear()
    hot.clear?.()
  }

  return {
    getRoom,
    onParticipantJoined,
    onParticipantLeft,
    createTab,
    switchTab,
    closeTab,
    setTabVideo,
    setTabText,
    appendTranscriptLine,
    addResearchEntry,
    resolveResearchEntry,
    errorResearchEntry,
    removeResearchEntry,
    _resetForTests
  }
}
