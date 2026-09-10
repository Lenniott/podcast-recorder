/**
 * Room State Store — the deep module owning a room's shared content:
 * tabs/text/video, the Transcript (ticket 01), per-tab Research
 * Assistant entries (ticket 04), and per-tab Annotations (ADR-0008) — all
 * same-shaped sibling content kinds, see ADR-0002.
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

import { MAX_TABS, MAX_TAB_TEXT_LEN, nextTabTitle } from '../room/tab-sync.js'
import { MAX_TRANSCRIPT_LINE_LEN, MAX_TRANSCRIPT_SPEAKER_LEN, TRANSCRIPT_TAB_ID } from '../room/transcript-sync.js'
import { MAX_RESEARCH_QUESTION_LEN, MAX_RESEARCH_ANSWER_LEN, sanitizeCitations } from '../research/research-sync.js'
import {
  ANNOTATION_KINDS,
  MAX_ANNOTATION_TEXT_LEN,
  MAX_ANNOTATION_ANSWER_LEN,
  MAX_ANNOTATION_AUTHOR_LEN,
  isAiAuthoredKind,
  normalizeQuote,
  upsertAnnotation
} from '../research/annotation-sync.js'

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
    research: {},
    // Sibling content, keyed by tab id — the same shape as `research` above
    // and a parallel collection to it, not a field on it (see ADR-0008 and
    // ticket 03). `annotations[tabId]` is the list of Annotations anchored
    // to that tab, in creation order; a tab with none has no key here.
    annotations: {}
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
    if (!content.annotations) content.annotations = {}
    // A room saved by a pre-ticket-06 build can have been left with the
    // reserved Transcript id as its activeTabId, back when that was a
    // switchable room-shared view (ADR-0008 retired it). Nothing renders
    // that any more, so heal it here — same one-shot, on-hydration
    // normalisation as the backfills above, rather than making every
    // reader defend against an activeTabId that names no tab.
    const list = content.tabs?.list
    if (Array.isArray(list) && list.length && !list.some((t) => t.id === content.tabs.activeTabId)) {
      content.tabs.activeTabId = list[0].id
    }
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
      // Every destination must be a real entry in tabs.list — including
      // the reserved Transcript id, which used to be the one exception
      // (ADR-0008, ticket 06 retired it). The Transcript is no longer a
      // room-shared *view* anyone can switch to: it is a facet of each
      // participant's own right-hand panel, opened locally, never
      // broadcast. The id itself lives on purely as the storage key for
      // Turn-anchored Annotations (ticket 03's per-tab convention) — it is
      // a key, not a place, so it needs no mention here at all: it now
      // fails the same tabs.list lookup any unknown id does, exactly as
      // closeTab/setTabText below have always failed it.
      if (findTabIndex(content, id) === -1) {
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

  // ── Annotations (per-tab, shared — see ADR-0008 and ticket 03) ─────────

  /**
   * Records one Annotation against the tab its quote was highlighted in.
   *
   * `quote` is frozen here and is never recomputed or replaced by any later
   * call (ticket 04 re-finds it in current Notes text to draw a highlight;
   * that is a read, and a failed match leaves the Annotation and its quote
   * exactly as stored).
   *
   * A **Comment** has no pending/resolve lifecycle: its content is already
   * complete the moment a person submits it, so it is born 'answered' and
   * this is the only mutation it ever gets. A **Card** (ADR-0008, ticket
   * 05) does: its body is a Research Assistant answer that does not exist
   * yet, so it is born 'pending' with an empty `text` — real, broadcast
   * state from the instant it is created, never a client-only illusion —
   * and moves exactly once, through resolveAnnotation or errorAnnotation
   * below. Which kinds work that way is isAiAuthoredKind's call, not a
   * literal 'card' test here.
   *
   * `tabId` is validated against the room's real tabs but is otherwise
   * taken from the caller — deliberately unlike research_ask, which forces
   * the room's *currently active* tab. An Annotation is anchored to the tab
   * whose text was highlighted; a peer switching tabs between the highlight
   * and the submit must not silently re-file it under a tab whose Notes
   * never contained the quote.
   *
   * `author` is passed in by ws-rooms.js from the creating peer's own join
   * name — never read off the wire message, so nobody can post a Comment
   * under someone else's name.
   */
  function addAnnotation(slug, tabId, { id, kind, quote, text, author, customPromptId } = {}) {
    return withRoom(slug, (content) => {
      const annotationId = String(id || '').slice(0, 64)
      if (!annotationId) return { ok: false, error: 'Invalid annotation id' }

      const tid = String(tabId || '')
      // An Annotation may be anchored to a Notes tab OR to a Transcript Turn
      // (ADR-0008). The Transcript is deliberately never an entry in
      // tabs.list (ADR-0002), so a plain findTabIndex check would refuse
      // every Turn-anchored Annotation — which is exactly what the reserved
      // id exists to key. This is the ONE place that id is a legitimate
      // destination, and it is a storage key, not a view: switchTab,
      // closeTab and setTabText all still refuse it.
      if (tid !== TRANSCRIPT_TAB_ID && findTabIndex(content, tid) === -1) {
        return { ok: false, error: 'Unknown tab' }
      }

      const annotationKind = ANNOTATION_KINDS.includes(kind) ? kind : null
      if (!annotationKind) return { ok: false, error: 'Unknown annotation kind' }

      const cleanQuote = normalizeQuote(quote)
      if (!cleanQuote) return { ok: false, error: 'An annotation needs the text it is anchored to' }

      const awaitingAnswer = isAiAuthoredKind(annotationKind)
      const cleanText = String(text || '').trim().slice(0, MAX_ANNOTATION_TEXT_LEN)
      // Only a human-authored Annotation must arrive with its body — a Card's
      // body is the answer, and the answer is the thing we are waiting for.
      if (!cleanText && !awaitingAnswer) return { ok: false, error: 'A comment cannot be empty' }

      const existing = (content.annotations[tid] || []).find((a) => a.id === annotationId)
      if (existing) {
        // Same id, already stored: this is a reconnecting client re-sending
        // a create it never saw acknowledged (see annotation-outbox.js), not
        // a second Annotation. Re-broadcast what is already stored rather
        // than storing a near-duplicate — the stored record, quote included,
        // stays exactly as first written. `duplicate` is what tells
        // ws-rooms.js not to spend a second Research Assistant call on a
        // replayed annotation_ask.
        return { ok: true, room: content, entry: existing, tabId: tid, duplicate: true }
      }

      const entry = {
        id: annotationId,
        tabId: tid,
        kind: annotationKind,
        quote: cleanQuote,
        text: awaitingAnswer ? '' : cleanText,
        status: awaitingAnswer ? 'pending' : 'answered',
        error: null,
        citations: [],
        // Which Custom Prompt produced this Card, kept so a later ticket can
        // tell two Cards on the same quote apart; null for a Comment.
        customPromptId: customPromptId ? String(customPromptId).slice(0, 64) : null,
        author: String(author || '').trim().slice(0, MAX_ANNOTATION_AUTHOR_LEN) || 'Guest',
        at: Date.now()
      }
      content.annotations[tid] = upsertAnnotation(content.annotations[tid], entry)
      return { ok: true, room: content, entry, tabId: tid, duplicate: false }
    })
  }

  /** Finds an Annotation by id across every tab's list — same reasoning as
   *  findResearchEntry: an Annotation's tabId is fixed at creation, so a
   *  later resolve/error never has to re-supply it. */
  function findAnnotation(content, annotationId) {
    for (const tabId of Object.keys(content.annotations)) {
      const idx = content.annotations[tabId].findIndex((a) => a.id === annotationId)
      if (idx !== -1) return { tabId, idx }
    }
    return null
  }

  /** The Research Assistant answered a pending Card. Mirrors
   *  resolveResearchEntry — `quote`, `author` and `at` are untouched. */
  function resolveAnnotation(slug, annotationId, { text, citations } = {}) {
    return withRoom(slug, (content) => {
      const found = findAnnotation(content, String(annotationId || ''))
      if (!found) return { ok: false, error: 'Unknown annotation' }

      const entry = content.annotations[found.tabId][found.idx]
      const answer = String(text || '').trim().slice(0, MAX_ANNOTATION_ANSWER_LEN)
      if (!answer) return { ok: false, error: 'A card cannot resolve to an empty answer' }
      entry.status = 'answered'
      entry.text = answer
      entry.citations = sanitizeCitations(citations)
      entry.error = null
      return { ok: true, room: content, entry, tabId: found.tabId }
    })
  }

  /** The lookup behind a pending Card failed. This and resolveAnnotation are
   *  the ONLY places a pending Card's status changes — a Card left pending
   *  with no explanation is precisely the "UI claiming things are fine when
   *  they might not be" AGENTS.md forbids, so the reason is always stored
   *  and always visible. */
  function errorAnnotation(slug, annotationId, { message } = {}) {
    return withRoom(slug, (content) => {
      const found = findAnnotation(content, String(annotationId || ''))
      if (!found) return { ok: false, error: 'Unknown annotation' }

      const entry = content.annotations[found.tabId][found.idx]
      entry.status = 'errored'
      entry.error = String(message || 'Something went wrong.').slice(0, MAX_ANNOTATION_ANSWER_LEN)
      entry.text = ''
      entry.citations = []
      return { ok: true, room: content, entry, tabId: found.tabId }
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
    addAnnotation,
    resolveAnnotation,
    errorAnnotation,
    _resetForTests
  }
}
