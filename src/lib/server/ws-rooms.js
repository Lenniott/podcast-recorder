/**
 * WebSocket room management.
 *
 * Each browser tab sends a stable `clientId` (random string stored in
 * sessionStorage). If a tab reconnects (HMR, network blip, etc.) the
 * server closes the old connection and replaces it — so you never see
 * ghost "Host" badges pile up.
 *
 * Rooms are capped at 2 connections (host + guest). A third attempt is
 * rejected immediately.
 *
 * Protocol (client → server):
 *   { type: 'join', name, clientId }     — announce on connect
 *   { type: 'ping', seq, sentAt }        — clock sync probe
 *   { type: 'clap' }                     — broadcast sync clap
 *   { type: 'recording_state', state }   — 'recording' | 'stopped'
 *   { type: 'yt_duck', talking }         — hold-to-talk; any peer; room ORs all holds
 *   { type: 'tab_create', tabId, title? }
 *                                        — client-generated tabId (like clientId);
 *                                          host and guest are equally allowed
 *   { type: 'tab_switch', tabId }        — changes the room's shared active tab
 *   { type: 'tab_close',  tabId }        — refused if it's the only tab left
 *   { type: 'tab_video',  tabId, action, videoId, playing, positionSec }
 *                                        — action: 'load' | 'clear' | 'control';
 *                                          full desired video state for that tab;
 *                                          videoId '' clears it. No host gate —
 *                                          any peer may load/clear/control any tab.
 *   { type: 'tab_text',   tabId, text }  — full shared text for that tab
 *                                          (last write wins, no host gate)
 *
 * Protocol (server → client):
 *   { type: 'presence',        peers: [{name, recording}] }
 *   { type: 'pong',            seq, clientSentAt, serverReceivedAt }
 *   { type: 'clap',            timestamp, from }
 *   { type: 'recording_state', name, state }
 *   { type: 'yt_duck',         talking } — true while any peer is holding Talk
 *   { type: 'tabs_state',      tabs: [{id, title}], activeTabId }
 *                                        — structural changes (create/switch/close)
 *                                          and replayed in full to late joiners
 *   { type: 'tab_video',       tabId, videoId, playing, positionSec,
 *                              positionAtMs, triggerAtMs }
 *                                        — broadcast on command, replayed per-tab
 *                                          (for tabs with a loaded video) to late
 *                                          joiners. Timing fields (all server
 *                                          clock), same lead-time scheme as before:
 *                                            triggerAtMs  — when every client should
 *                                                           apply this state (~lead
 *                                                           ms ahead, absorbs WS
 *                                                           jitter)
 *                                            positionAtMs — timeline origin for
 *                                                           effectivePosition(); late
 *                                                           join keeps the stored
 *                                                           positionAtMs and gets a
 *                                                           fresh triggerAtMs
 *   { type: 'tab_text',        tabId, text }
 *                                        — broadcast to everyone except the sender
 *                                          (so a typist's own textarea isn't
 *                                          clobbered mid-keystroke), replayed
 *                                          per-tab (for tabs with non-empty text)
 *                                          to late joiners
 *   { type: 'error',           message }
 *   { type: 'rejected',        message }
 */

import { roomExists, getRoomBySlug } from './db.js'
import { verifyHostClaimToken } from './auth.js'
import { MAX_TABS, MAX_TAB_TEXT_LEN, nextTabTitle } from '../tab-sync.js'

const MAX_PEERS = 2
const CLAP_LEAD_MS = 250 // shared future trigger — absorbs per-client WS jitter
const TAB_VIDEO_LEAD_MS = 250 // same idea as clap: schedule apply slightly in the future
const YT_VIDEO_ID = /^[\w-]{11}$/

// rooms: Map<slug, Map<clientId, peer>>
// peer: { ws, clientId, name, recording, slug, role, claimedHost, joinedAt, talking }
const rooms = new Map()

// tabRooms: Map<slug, {
//   tabs: Map<tabId, { id, title, video: {videoId,playing,positionSec,positionAtMs}|null, text }>,
//   order: [tabId, ...],   // insertion order — stable display + close fallback
//   activeTabId: string|null
// }>
// Kept in memory only (no save state), so late joiners can catch up, same as the
// old single-video ytStates map this replaces.
const tabRooms = new Map()

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function sendPresence(slug) {
  const room = rooms.get(slug)
  if (!room) return
  const peers = Array.from(room.values()).map((p) => ({
    clientId: p.clientId,
    name: p.name,
    recording: p.recording,
    role: p.role || 'guest',
    isHost: (p.role || 'guest') === 'host'
  }))
  const msg = { type: 'presence', peers }
  for (const peer of room.values()) send(peer.ws, msg)
}

function parseCookies(header = '') {
  const out = new Map()
  for (const part of String(header).split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx)
    const raw = trimmed.slice(idx + 1)
    try {
      out.set(key, decodeURIComponent(raw))
    } catch {
      out.set(key, raw)
    }
  }
  return out
}

function recomputeRoles(room) {
  const peers = Array.from(room.values())
  const claimed = peers
    .filter((p) => p.claimedHost)
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))
  const hostClientId = claimed[0]?.clientId || null
  for (const p of peers) {
    p.role = hostClientId && p.clientId === hostClientId ? 'host' : 'guest'
  }
}

function broadcast(slug, msg, excludeClientId = null) {
  const room = rooms.get(slug)
  if (!room) return
  for (const peer of room.values()) {
    if (peer.clientId !== excludeClientId) send(peer.ws, msg)
  }
}

function anyoneTalking(slug) {
  const room = rooms.get(slug)
  if (!room) return false
  for (const peer of room.values()) {
    if (peer.talking) return true
  }
  return false
}

function sendDuck(slug) {
  const room = rooms.get(slug)
  if (!room) return
  const msg = { type: 'yt_duck', talking: anyoneTalking(slug) }
  for (const peer of room.values()) send(peer.ws, msg)
}

// ── Tabs ─────────────────────────────────────────────────────────────────

function makeTabId() {
  return 'tab-' + Math.random().toString(36).slice(2, 10)
}

/** Lazily creates a room's tab state with one default, active, empty tab. */
function ensureTabRoom(slug) {
  if (tabRooms.has(slug)) return tabRooms.get(slug)
  const id = makeTabId()
  const troom = {
    tabs: new Map([[id, { id, title: nextTabTitle([]), video: null, text: '' }]]),
    order: [id],
    activeTabId: id
  }
  tabRooms.set(slug, troom)
  return troom
}

function tabsSnapshot(troom) {
  return troom.order.map((id) => {
    const tab = troom.tabs.get(id)
    return { id: tab.id, title: tab.title }
  })
}

function sendTabsState(slug) {
  const room = rooms.get(slug)
  const troom = tabRooms.get(slug)
  if (!room || !troom) return
  const msg = { type: 'tabs_state', tabs: tabsSnapshot(troom), activeTabId: troom.activeTabId }
  for (const peer of room.values()) send(peer.ws, msg)
}

/** Replays a room's full tab state (structure + per-tab video/text) to one late joiner. */
function replayTabsTo(ws, troom) {
  send(ws, { type: 'tabs_state', tabs: tabsSnapshot(troom), activeTabId: troom.activeTabId })
  for (const tabId of troom.order) {
    const tab = troom.tabs.get(tabId)
    if (tab.video) {
      send(ws, { type: 'tab_video', tabId: tab.id, ...tab.video, triggerAtMs: Date.now() + TAB_VIDEO_LEAD_MS })
    }
    if (tab.text) {
      send(ws, { type: 'tab_text', tabId: tab.id, text: tab.text })
    }
  }
}

/** For tests only — wipes all rooms so each test starts clean */
export function _resetRooms() {
  rooms.clear()
  tabRooms.clear()
}

export function getPeerRole(slug, clientId) {
  const room = rooms.get(slug)
  if (!room || !clientId) return null
  const peers = Array.from(room.values())
  const idx = peers.findIndex((peer) => peer.clientId === clientId)
  if (idx === -1) return null
  return idx === 0 ? 'host' : 'guest'
}

export function setupWss(wss) {
  wss.on('connection', (ws, req) => {
    const url  = new URL(req.url, 'http://localhost')
    const slug = url.searchParams.get('slug')

    if (!slug) {
      send(ws, { type: 'error', message: 'No slug provided' })
      ws.close()
      return
    }

    if (!roomExists(slug)) {
      send(ws, { type: 'error', message: 'Room not found' })
      ws.close(4004, 'Room not found')
      return
    }

    const roomRow = getRoomBySlug(slug)
    const cookies = parseCookies(req.headers.cookie || '')
    const hostToken = cookies.get(`pr_host_${slug}`) || ''
    const connectionHostClaim = !!roomRow && verifyHostClaimToken(hostToken, slug, roomRow.password_hash, process.env.SECRET)

    if (!rooms.has(slug)) rooms.set(slug, new Map())
    const room = rooms.get(slug)

    // Placeholder peer — clientId set when 'join' arrives
    let clientId = null
    const peer = {
      ws,
      clientId: null,
      name: 'Guest',
      recording: false,
      slug,
      role: 'guest',
      claimedHost: connectionHostClaim,
      joinedAt: Date.now(),
      talking: false
    }

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      if (msg.type === 'join') {
        const firstJoin    = !clientId
        const incomingId   = String(msg.clientId || '').slice(0, 64) || null
        const incomingName = String(msg.name || 'Guest').slice(0, 50).trim() || 'Guest'

        if (!clientId && incomingId) {
          // First join — register this peer

          // Evict stale connection with same clientId (HMR reconnect)
          if (room.has(incomingId)) {
            const stale = room.get(incomingId)
            stale.ws.close(1000, 'Replaced by new connection')
            room.delete(incomingId)
          }

          // Cap at MAX_PEERS
          if (room.size >= MAX_PEERS) {
            send(ws, { type: 'rejected', message: 'Room is full (max 2 people).' })
            ws.close(4003, 'Room full')
            return
          }

          clientId      = incomingId
          peer.clientId = clientId
          peer.name     = incomingName
          peer.joinedAt = Date.now()
          room.set(clientId, peer)
        } else if (clientId) {
          // Subsequent join = name update
          peer.name = incomingName
        }

        recomputeRoles(room)
        sendPresence(slug)

        if (firstJoin && clientId) {
          replayTabsTo(ws, ensureTabRoom(slug))
          send(ws, { type: 'yt_duck', talking: anyoneTalking(slug) })
        }
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong', seq: msg.seq, clientSentAt: msg.sentAt, serverReceivedAt: Date.now() })
      }

      if (msg.type === 'clap' && clientId) {
        // Broadcast a shared future trigger time to reduce per-client WS jitter.
        const event = {
          type: 'clap',
          timestamp: new Date().toISOString(),
          triggerAtMs: Date.now() + CLAP_LEAD_MS,
          from: peer.name
        }
        for (const p of room.values()) send(p.ws, event)
      }

      if (msg.type === 'recording_state' && clientId) {
        peer.recording = msg.state === 'recording'
        recomputeRoles(room)
        sendPresence(slug)
        broadcast(slug, { type: 'recording_state', name: peer.name, state: msg.state }, clientId)
      }

      if (msg.type === 'yt_duck' && clientId) {
        peer.talking = !!msg.talking
        sendDuck(slug)
      }

      if (msg.type === 'tab_create' && clientId) {
        const troom = ensureTabRoom(slug)
        const tabId = String(msg.tabId || '').slice(0, 64)

        if (!tabId || troom.tabs.has(tabId)) {
          send(ws, { type: 'error', message: 'Invalid or duplicate tab id' })
          return
        }
        if (troom.tabs.size >= MAX_TABS) {
          send(ws, { type: 'error', message: `Too many tabs open (max ${MAX_TABS}).` })
          return
        }

        const requestedTitle = String(msg.title || '').trim().slice(0, 50)
        const title = requestedTitle || nextTabTitle(tabsSnapshot(troom).map((t) => t.title))

        troom.tabs.set(tabId, { id: tabId, title, video: null, text: '' })
        troom.order.push(tabId)
        troom.activeTabId = tabId
        sendTabsState(slug)
      }

      if (msg.type === 'tab_switch' && clientId) {
        const troom = tabRooms.get(slug)
        const tabId = String(msg.tabId || '')
        if (!troom || !troom.tabs.has(tabId)) {
          send(ws, { type: 'error', message: 'Unknown tab' })
          return
        }
        troom.activeTabId = tabId
        sendTabsState(slug)
      }

      if (msg.type === 'tab_close' && clientId) {
        const troom = tabRooms.get(slug)
        const tabId = String(msg.tabId || '')
        if (!troom || !troom.tabs.has(tabId)) {
          send(ws, { type: 'error', message: 'Unknown tab' })
          return
        }
        if (troom.tabs.size <= 1) {
          send(ws, { type: 'error', message: 'Cannot close the only remaining tab' })
          return
        }

        const idx = troom.order.indexOf(tabId)
        troom.tabs.delete(tabId)
        troom.order.splice(idx, 1)
        if (troom.activeTabId === tabId) {
          troom.activeTabId = troom.order[Math.max(0, idx - 1)]
        }
        sendTabsState(slug)
      }

      if (msg.type === 'tab_video' && clientId) {
        const troom = tabRooms.get(slug)
        const tabId = String(msg.tabId || '')
        const tab = troom?.tabs.get(tabId)
        if (!tab) {
          send(ws, { type: 'error', message: 'Unknown tab' })
          return
        }

        const videoId = String(msg.videoId || '')
        const action = msg.action === 'load' || msg.action === 'clear' || msg.action === 'control'
          ? msg.action
          : (videoId === '' ? 'clear' : 'load')

        if (videoId !== '' && !YT_VIDEO_ID.test(videoId)) {
          send(ws, { type: 'error', message: 'Invalid YouTube video id' })
          return
        }

        if (action === 'control' && videoId !== (tab.video?.videoId || '')) {
          // A control message must target the video already loaded in this tab —
          // it can never be used to smuggle in a load/clear.
          return
        }

        if (videoId === '') {
          tab.video = null
          for (const p of room.values()) {
            send(p.ws, { type: 'tab_video', tabId: tab.id, videoId: '', playing: false, positionSec: 0, positionAtMs: 0, triggerAtMs: 0 })
          }
          return
        }

        const positionSec = Number(msg.positionSec)
        const applyAtMs = Date.now() + TAB_VIDEO_LEAD_MS
        tab.video = {
          videoId,
          playing: !!msg.playing,
          positionSec: Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0,
          positionAtMs: applyAtMs
        }
        for (const p of room.values()) {
          send(p.ws, { type: 'tab_video', tabId: tab.id, ...tab.video, triggerAtMs: applyAtMs })
        }
      }

      if (msg.type === 'tab_text' && clientId) {
        const troom = tabRooms.get(slug)
        const tabId = String(msg.tabId || '')
        const tab = troom?.tabs.get(tabId)
        if (!tab) {
          send(ws, { type: 'error', message: 'Unknown tab' })
          return
        }
        tab.text = String(msg.text ?? '').slice(0, MAX_TAB_TEXT_LEN)
        broadcast(slug, { type: 'tab_text', tabId: tab.id, text: tab.text }, clientId)
      }
    })

    ws.on('close', () => {
      if (clientId) {
        room.delete(clientId)
        if (room.size === 0) {
          rooms.delete(slug)
          tabRooms.delete(slug)
        } else {
          recomputeRoles(room)
          sendPresence(slug)
          sendDuck(slug)
        }
      }
    })

    ws.on('error', () => {
      if (clientId) room.delete(clientId)
    })
  })
}
