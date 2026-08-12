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
 *   { type: 'yt_state', action, videoId, playing, positionSec }
 *                                        — action: 'load' | 'clear' (host only) or
 *                                          'control' (host, or guest if the room has
 *                                          guest_can_control_playback set); full desired
 *                                          shared-video state; videoId '' clears the video
 *   { type: 'yt_duck', talking }         — hold-to-talk; any peer; room ORs all holds
 *
 * Protocol (server → client):
 *   { type: 'presence',        peers: [{name, recording}] }
 *   { type: 'pong',            seq, clientSentAt, serverReceivedAt }
 *   { type: 'clap',            timestamp, from }
 *   { type: 'recording_state', name, state }
 *   { type: 'yt_state',        videoId, playing, positionSec,
 *                              positionAtMs, triggerAtMs }
 *                                        — broadcast on command and replayed to late
 *                                          joiners. Timing fields (all server clock):
 *                                            triggerAtMs  — when every client should
 *                                                           apply this state (~lead ms
 *                                                           ahead, absorbs WS jitter)
 *                                            positionAtMs — timeline origin for
 *                                                           effectivePosition(); late
 *                                                           join keeps the stored
 *                                                           positionAtMs and gets a
 *                                                           fresh triggerAtMs so the
 *                                                           client can advance past
 *                                                           elapsed play time
 *   { type: 'yt_duck',         talking } — true while any peer is holding Talk
 *   { type: 'error',           message }
 *   { type: 'rejected',        message }
 */

import { roomExists, getRoomBySlug } from './db.js'
import { verifyHostClaimToken } from './auth.js'

const MAX_PEERS = 2
const CLAP_LEAD_MS = 250 // shared future trigger — absorbs per-client WS jitter
const YT_LEAD_MS = 250   // same idea as clap: schedule apply slightly in the future
const YT_VIDEO_ID = /^[\w-]{11}$/

// rooms: Map<slug, Map<clientId, peer>>
// peer: { ws, clientId, name, recording, slug, role, claimedHost, joinedAt }
const rooms = new Map()

// ytStates: Map<slug, { videoId, playing, positionSec, positionAtMs }>
// The room's shared YouTube video, kept so late joiners can catch up.
const ytStates = new Map()

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

/** For tests only — wipes all rooms so each test starts clean */
export function _resetRooms() {
  rooms.clear()
  ytStates.clear()
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

        // Catch a late joiner (or reconnect) up on the shared video.
        // Spread keeps the stored positionAtMs (so effectivePosition advances
        // through elapsed play time); only triggerAtMs is freshened.
        if (firstJoin && clientId && ytStates.has(slug)) {
          send(ws, {
            type: 'yt_state',
            ...ytStates.get(slug),
            triggerAtMs: Date.now() + YT_LEAD_MS
          })
        }
        if (firstJoin && clientId) {
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

      if (msg.type === 'yt_state' && clientId) {
        const action = msg.action === 'load' || msg.action === 'clear' || msg.action === 'control'
          ? msg.action
          : (String(msg.videoId || '') === '' ? 'clear' : 'load')

        const guestCanControl = !!roomRow?.guest_can_control_playback
        const allowed = peer.role === 'host' || (action === 'control' && peer.role === 'guest' && guestCanControl)
        if (!allowed) {
          send(ws, { type: 'error', message: 'Only the host can control playback' })
          return
        }

        const videoId = String(msg.videoId || '')
        if (videoId !== '' && !YT_VIDEO_ID.test(videoId)) {
          send(ws, { type: 'error', message: 'Invalid YouTube video id' })
          return
        }

        if (action === 'control' && videoId !== (ytStates.get(slug)?.videoId || '')) {
          // A guest control message must target the video already playing —
          // it can never be used to smuggle in a load/clear.
          return
        }

        if (videoId === '') {
          ytStates.delete(slug)
          for (const p of room.values()) {
            send(p.ws, { type: 'yt_state', videoId: '', playing: false, positionSec: 0, positionAtMs: 0, triggerAtMs: 0 })
          }
          return
        }

        const positionSec = Number(msg.positionSec)
        const applyAtMs = Date.now() + YT_LEAD_MS
        const state = {
          videoId,
          playing: !!msg.playing,
          positionSec: Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0,
          positionAtMs: applyAtMs
        }
        ytStates.set(slug, state)
        for (const p of room.values()) {
          send(p.ws, { type: 'yt_state', ...state, triggerAtMs: applyAtMs })
        }
      }

      if (msg.type === 'yt_duck' && clientId) {
        peer.talking = !!msg.talking
        sendDuck(slug)
      }
    })

    ws.on('close', () => {
      if (clientId) {
        room.delete(clientId)
        if (room.size === 0) {
          rooms.delete(slug)
          ytStates.delete(slug)
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
