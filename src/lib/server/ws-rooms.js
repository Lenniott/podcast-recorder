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
 *   { type: 'clap' }                     — broadcast sync clap
 *   { type: 'recording_state', state }   — 'recording' | 'stopped'
 *
 * Protocol (server → client):
 *   { type: 'presence',        peers: [{name, recording}] }
 *   { type: 'clap',            timestamp, from }
 *   { type: 'recording_state', name, state }
 *   { type: 'error',           message }
 *   { type: 'rejected',        message }
 */

import { roomExists } from './db.js'

const MAX_PEERS = 2

// rooms: Map<slug, Map<clientId, peer>>
// peer: { ws, clientId, name, recording, slug }
const rooms = new Map()

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function sendPresence(slug) {
  const room = rooms.get(slug)
  if (!room) return
  const peers = Array.from(room.values()).map(p => ({ name: p.name, recording: p.recording }))
  const msg = { type: 'presence', peers }
  for (const peer of room.values()) send(peer.ws, msg)
}

function broadcast(slug, msg, excludeClientId = null) {
  const room = rooms.get(slug)
  if (!room) return
  for (const peer of room.values()) {
    if (peer.clientId !== excludeClientId) send(peer.ws, msg)
  }
}

/** For tests only — wipes all rooms so each test starts clean */
export function _resetRooms() {
  rooms.clear()
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

    if (!rooms.has(slug)) rooms.set(slug, new Map())
    const room = rooms.get(slug)

    // Placeholder peer — clientId set when 'join' arrives
    let clientId = null
    const peer = { ws, clientId: null, name: 'Guest', recording: false, slug }

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      if (msg.type === 'join') {
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
          room.set(clientId, peer)
        } else if (clientId) {
          // Subsequent join = name update
          peer.name = incomingName
        }

        sendPresence(slug)
      }

      if (msg.type === 'clap' && clientId) {
        const event = { type: 'clap', timestamp: new Date().toISOString(), from: peer.name }
        for (const p of room.values()) send(p.ws, event)
      }

      if (msg.type === 'recording_state' && clientId) {
        peer.recording = msg.state === 'recording'
        sendPresence(slug)
        broadcast(slug, { type: 'recording_state', name: peer.name, state: msg.state }, clientId)
      }
    })

    ws.on('close', () => {
      if (clientId) {
        room.delete(clientId)
        if (room.size === 0) rooms.delete(slug)
        else sendPresence(slug)
      }
    })

    ws.on('error', () => {
      if (clientId) room.delete(clientId)
    })
  })
}
