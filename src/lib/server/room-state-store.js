/**
 * Room State Store — the deep module owning a room's shared content
 * (tabs/text/video today; the Transcript and Research Assistant entries
 * are later, same-shaped additions — see ADR-0002 and tickets 01/04).
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

const DEFAULT_GRACE_MS = 10_000

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
    }
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
      if (findTabIndex(content, id) === -1) return { ok: false, error: 'Unknown tab' }
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

  function setTabText(slug, tabId, text) {
    return withRoom(slug, (content) => {
      const tab = findTab(content, String(tabId || ''))
      if (!tab) return { ok: false, error: 'Unknown tab' }
      tab.text = String(text ?? '').slice(0, MAX_TAB_TEXT_LEN)
      return { ok: true, room: content }
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
    _resetForTests
  }
}
