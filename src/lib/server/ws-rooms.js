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
 *   { type: 'recording_state', state, startedAt? }
 *                                        — 'recording' | 'stopped'. startedAt is the
 *                                          recorder's Date.now() when this take began
 *                                          (resent on registerResync so the clock does
 *                                          not restart after a reconnect).
 *   { type: 'server_copy_progress', state, percent }
 *                                        — this peer's server-copy upload status, sent by
 *                                          $lib/server-copy/server-copy-upload.js's caller (see the
 *                                          room page) on every threshold-crossing progress
 *                                          change and again on every reconnect (state is
 *                                          not remembered across a dropped connection, same
 *                                          as recording_state). state is one of
 *                                          'unavailable' | 'in_progress' | 'complete' | 'failed';
 *                                          percent is a rounded 0-100 integer, never a byte count.
 *   { type: 'mic_info',        label }   — selected mic display name; stored on the peer
 *                                          and included in presence. Re-announce on
 *                                          registerResync after reconnect (server forgets it).
 *   { type: 'yt_duck', talking }         — hold-to-talk; any peer; room ORs all holds
 *   { type: 'transcript_activity', active }
 *                                        — sent by transcript-capture.js while an
 *                                          interim (non-final) speech result is
 *                                          in flight, i.e. "a transcript_line is
 *                                          probably about to land" — cleared the
 *                                          moment that line is finalized, or
 *                                          after a short no-further-interim
 *                                          decay, or on stop(). Ephemeral, like
 *                                          yt_duck's `talking`: tracked only on
 *                                          the peer object, never persisted, and
 *                                          the room broadcasts the OR across all
 *                                          peers (anyoneTranscribing) rather than
 *                                          this sender's raw value — so it means
 *                                          "someone's speech is being processed
 *                                          right now," not "this specific peer
 *                                          is." This is deliberately NOT the
 *                                          interim text itself — no live
 *                                          streaming of unfinalized words to
 *                                          other peers, just a heads-up that
 *                                          something is coming.
 *   { type: 'tab_create', tabId, title? }
 *                                        — client-generated tabId (like clientId);
 *                                          host and guest are equally allowed
 *   { type: 'tab_switch', tabId }        — changes the room's shared active tab.
 *                                          tabId also accepts the reserved
 *                                          Transcript id (transcript-sync.js's
 *                                          TRANSCRIPT_TAB_ID) as a valid
 *                                          destination — "which pill the room
 *                                          is looking at" is one shared piece
 *                                          of state, broadcast to every peer
 *                                          the same way switching to any real
 *                                          tab already is, even though the
 *                                          Transcript is never itself an
 *                                          entry in tabs.list (see ADR-0002).
 *   { type: 'tab_close',  tabId }        — refused if it's the only tab left,
 *                                          and always refused for the reserved
 *                                          Transcript id (it is never in
 *                                          tabs.list to begin with — "cannot
 *                                          be closed" is structural, not a
 *                                          special-cased check)
 *   { type: 'tab_video',  tabId, action, videoId, playing, positionSec }
 *                                        — action: 'load' | 'clear' | 'control';
 *                                          full desired video state for that tab;
 *                                          videoId '' clears it. No host gate —
 *                                          any peer may load/clear/control any tab.
 *   { type: 'tab_text',   tabId, text }  — full shared text for that tab
 *                                          (last write wins, no host gate)
 *   { type: 'tabs_sync' }                — request a full replay (structure +
 *                                          per-tab video/text, and the full
 *                                          transcript-so-far). Used when the
 *                                          UI remounts without a WS reconnect.
 *   { type: 'transcript_line', speaker, text }
 *                                        — append one new, already-finalized
 *                                          Transcript Tab line (see
 *                                          CONTEXT.md's Turn/Transcript Tab
 *                                          and ADR-0002). Any peer may send
 *                                          one at any time — this is
 *                                          deliberately NOT the same
 *                                          mechanism as tab_text: the server
 *                                          only ever appends, never replaces,
 *                                          so two lines from two speakers
 *                                          arriving close together both
 *                                          survive in a stable (arrival)
 *                                          order instead of one silently
 *                                          overwriting the other.
 *   { type: 'research_ask', entryId, question, turnId?, actionId? }
 *                                        — manual "ask a question" (ticket 04;
 *                                          Quick Actions/Voice Trigger, tickets
 *                                          05/06, will reuse this same message).
 *                                          turnId/actionId are set only for a
 *                                          Turn Action ask (TextBlock.svelte's
 *                                          icon row) — carried onto the entry
 *                                          so every peer's `entries` can derive
 *                                          "this Turn Action already ran on
 *                                          this Block" (deriveDoneActionsByTurn
 *                                          in research-panel.js) and keep that
 *                                          icon disabled after a refresh.
 *                                          Host-only by default — a guest
 *                                          peer is refused with `error` and
 *                                          no entry is created — unless
 *                                          Guest Research Access is on for
 *                                          this room (see CONTEXT.md);
 *                                          covers Ask, Turn Actions, and
 *                                          Custom alike, one gate.
 *                                          entryId is client-generated (like
 *                                          tab_create's tabId) so the asking
 *                                          browser can correlate its own later
 *                                          research_resolve/research_error
 *                                          without a round trip first. Filed
 *                                          under the room's CURRENT active tab
 *                                          (server-determined, never
 *                                          client-supplied) — this is what
 *                                          keeps an entry strictly scoped to
 *                                          whichever Tab was active at ask time.
 *   { type: 'research_resolve', entryId, answer, citations }
 *                                        — sent by the asking client once its
 *                                          own POST /rec/[slug]/research call
 *                                          (ticket 02's endpoint) succeeds.
 *                                          Moves that entry from pending to
 *                                          answered for every peer.
 *   { type: 'research_error', entryId, message }
 *                                        — sent by the asking client when that
 *                                          same request fails for any reason
 *                                          (non-2xx, network error, timeout).
 *                                          Moves the entry from pending to
 *                                          errored with a visible `message` —
 *                                          a pending entry must never be left
 *                                          stuck with no explanation.
 *   { type: 'research_remove', entryId }
 *                                        — host-only by default (same gate
 *                                          as research_ask) discards one
 *                                          research card outright (unlike
 *                                          resolve/error, which change
 *                                          status but keep the entry).
 *                                          Removes it from the tab's stored
 *                                          history so a late joiner never
 *                                          sees it again.
 *
 * Protocol (server → client):
 *   { type: 'presence',        peers: [{name, recording, serverCopyState, serverCopyPercent, micLabel}] }
 *   { type: 'server_copy_token', clientId, token }
 *                                        — sent ONLY to the connection whose 'join' just
 *                                          claimed this clientId, never broadcast (ticket
 *                                          11: bind server-copy clientId to owner). `token`
 *                                          is a stateless (slug, clientId)-scoped capability
 *                                          token (auth.js's makeServerCopyToken) the client
 *                                          must present on every server-copy/{session,chunks,
 *                                          finalize} request alongside this clientId — it's
 *                                          what proves the caller actually owns the clientId,
 *                                          since clientId itself is broadcast presence data
 *                                          and the room's session cookie is identical for
 *                                          every participant.
 *   { type: 'pong',            seq, clientSentAt, serverReceivedAt }
 *   { type: 'clap',            timestamp, from }
 *   { type: 'recording_state', name, state }
 *   { type: 'yt_duck',         talking } — true while any peer is holding Talk
 *   { type: 'transcript_activity', active }
 *                                        — true while ANY peer currently has an
 *                                          interim result in flight (same OR
 *                                          shape as yt_duck's talking); sent to
 *                                          every peer including the sender, and
 *                                          replayed once on join so a late
 *                                          joiner isn't stuck assuming false.
 *   { type: 'tabs_state',      tabs: [{id, title}], activeTabId }
 *                                        — structural changes (create/switch/close)
 *                                          and replayed in full to late joiners.
 *                                          `tabs` never includes the Transcript
 *                                          (it is sibling content, not a tab —
 *                                          see room-state-store.js), but
 *                                          `activeTabId` CAN be the reserved
 *                                          Transcript id when the room is
 *                                          currently looking at it — that's
 *                                          still one shared value for
 *                                          everyone, exactly like any real tab.
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
 *   { type: 'transcript_state', lines: [{id, speaker, text, at}] }
 *                                        — the room's full Transcript-so-far, in
 *                                          order; sent once per join and once per
 *                                          tabs_sync (mirrors tabs_state/tab_text's
 *                                          own replay-on-join pattern), always
 *                                          BEFORE any live transcript_line for
 *                                          that connection. Not scoped to a tab —
 *                                          the Transcript is one room-wide,
 *                                          permanent, uncloseable Tab, not an
 *                                          entry in tabs_state's tabs list.
 *   { type: 'transcript_line',  id, speaker, text, at }
 *                                        — one appended line, broadcast to EVERY
 *                                          peer including the sender (unlike
 *                                          tab_text) since the Transcript has no
 *                                          local optimistic UI to protect from a
 *                                          clobber — the server is the single
 *                                          source of truth for line order. `at`
 *                                          is the server's Date.now() when it was
 *                                          appended; `id` is stable for Svelte
 *                                          keying, never reused.
 *   { type: 'research_entry',   tabId, entry }
 *                                        — one research entry created or
 *                                          updated (pending -> answered/
 *                                          errored), broadcast to EVERY peer
 *                                          including the sender — same
 *                                          reasoning as transcript_line: no
 *                                          local optimistic UI to protect,
 *                                          the server is the single source of
 *                                          truth for entry status. `entry` is
 *                                          `{id, tabId, question, status,
 *                                          answer, citations, error, at}`;
 *                                          `status` is 'pending' | 'answered'
 *                                          | 'errored'.
 *   { type: 'research_state',   tabId, entries }
 *                                        — one tab's full research history so
 *                                          far, in order; sent once per tab
 *                                          that has any entries, on join and
 *                                          on tabs_sync (mirrors tab_video/
 *                                          tab_text's own per-tab replay),
 *                                          always BEFORE any live
 *                                          research_entry for that connection.
 *   { type: 'research_removed', tabId, entryId }
 *                                        — one research entry deleted
 *                                          outright, broadcast to EVERY peer
 *                                          including the sender (same
 *                                          reasoning as research_entry — the
 *                                          server is the single source of
 *                                          truth for the tab's history).
 *   { type: 'error',           message }
 *   { type: 'rejected',        message }
 */

import { getActiveRoomBySlug, saveRoomContent, loadRoomContent } from './db.js'
import { getHostClaim, makeServerCopyToken } from './auth.js'
import { createRoomStateStore, getRoomStateGraceMs } from './room-state-store.js'

const MAX_PEERS = 2
const CLAP_LEAD_MS = 250 // shared future trigger — absorbs per-client WS jitter
const TAB_VIDEO_LEAD_MS = 250 // same idea as clap: schedule apply slightly in the future
const YT_VIDEO_ID = /^[\w-]{11}$/
const SERVER_COPY_STATES = new Set(['unavailable', 'in_progress', 'complete', 'failed'])

// rooms: Map<slug, Map<clientId, peer>>
// peer: { ws, clientId, name, recording, slug, role, claimedHost, guestAiAllowed,
//         joinedAt, talking, transcribing, serverCopyState, serverCopyPercent,
//         serverCopyTakeId, micLabel }
const rooms = new Map()

// A room's tabs/text/video, Transcript (ticket 01), and per-tab Research
// Assistant entries (ticket 04) — all sibling content kinds, see ADR-0002 —
// live entirely behind this one small interface now: while >=1 participant
// is connected content stays in RAM only; the moment the last one
// disconnects, a grace timer (ROOM_STATE_GRACE_MS, default 10s — see
// room-state-store.js's getRoomStateGraceMs) decides whether to flush it to
// the `room_content` table (extended in db.js) and evict it, or — on a
// reconnect — keep running hot exactly as before. No handler below reaches
// into a raw Map or DB row for this content directly. See
// room-state-store.js for the full contract.
//
// Exported (read-only in practice — every write goes through a WS message
// handler below) so the Usage Dashboard (usage-dashboard.js) can read a
// live room's tab/Transcript/research-entry counts the same way a
// reconnecting participant would, without waiting for the grace-period
// flush to `room_content`.
export const roomStateStore = createRoomStateStore({
  durable: {
    save: (slug, content) => saveRoomContent(slug, content),
    load: (slug) => loadRoomContent(slug)
  },
  graceMs: getRoomStateGraceMs()
})

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
    recordingStartedAt: p.recording ? p.recordingStartedAt || null : null,
    role: p.role || 'guest',
    isHost: (p.role || 'guest') === 'host',
    // Separate from `recording` on purpose — local recording and the
    // server-copy upload are different guarantees and must never be
    // merged into one status (see ticket 06).
    serverCopyState: p.serverCopyState || 'unavailable',
    serverCopyPercent: p.serverCopyPercent || 0,
    serverCopyTakeId: p.serverCopyTakeId || null,
    micLabel: p.micLabel || ''
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

function anyoneTranscribing(slug) {
  const room = rooms.get(slug)
  if (!room) return false
  for (const peer of room.values()) {
    if (peer.transcribing) return true
  }
  return false
}

function sendTranscriptActivity(slug) {
  const room = rooms.get(slug)
  if (!room) return
  const msg = { type: 'transcript_activity', active: anyoneTranscribing(slug) }
  for (const peer of room.values()) send(peer.ws, msg)
}

// ── Tabs ─────────────────────────────────────────────────────────────────

function tabsSnapshot(content) {
  return content.tabs.list.map((tab) => ({ id: tab.id, title: tab.title }))
}

function sendTabsState(slug) {
  const room = rooms.get(slug)
  if (!room) return
  const content = roomStateStore.getRoom(slug)
  const msg = { type: 'tabs_state', tabs: tabsSnapshot(content), activeTabId: content.tabs.activeTabId }
  for (const peer of room.values()) send(peer.ws, msg)
}

/** Replays a room's full tab state (structure + per-tab video/text) to one late joiner. */
function replayTabsTo(ws, content) {
  send(ws, { type: 'tabs_state', tabs: tabsSnapshot(content), activeTabId: content.tabs.activeTabId })
  for (const tab of content.tabs.list) {
    if (tab.video) {
      send(ws, { type: 'tab_video', tabId: tab.id, ...tab.video, triggerAtMs: Date.now() + TAB_VIDEO_LEAD_MS })
    }
    if (tab.text) {
      send(ws, { type: 'tab_text', tabId: tab.id, text: tab.text })
    }
  }
  replayTranscriptTo(ws, content)
  replayResearchTo(ws, content)
}

// ── Transcript (append-only — see ADR-0002 and ticket 01) ─────────────────

/** Replays a room's full transcript-so-far, in order, to one late joiner/resyncer. */
function replayTranscriptTo(ws, content) {
  send(ws, { type: 'transcript_state', lines: content.transcript.lines })
}

// ── Research Assistant entries (per-tab, shared — see ADR-0002 and
//    ticket 04) ─────────────────────────────────────────────────────────

/** Replays every tab's accumulated research history, in order, to one late
 *  joiner/resyncer — one message per tab that actually has entries (mirrors
 *  tab_video/tab_text's own "only send what's there" per-tab replay). */
function replayResearchTo(ws, content) {
  for (const tabId of Object.keys(content.research)) {
    const entries = content.research[tabId]
    if (entries.length) send(ws, { type: 'research_state', tabId, entries })
  }
}

/** For tests only — wipes all rooms so each test starts clean */
export function _resetRooms() {
  rooms.clear()
  roomStateStore._resetForTests()
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

    const roomRow = getActiveRoomBySlug(slug)
    if (!roomRow) {
      send(ws, { type: 'error', message: 'Room not found' })
      ws.close(4004, 'Room not found')
      return
    }

    const cookies = parseCookies(req.headers.cookie || '')
    const connectionHostClaim = getHostClaim(slug, cookies, roomRow, process.env.SECRET)

    if (!rooms.has(slug)) rooms.set(slug, new Map())
    const room = rooms.get(slug)

    // Placeholder peer — clientId set when 'join' arrives
    let clientId = null
    const peer = {
      ws,
      clientId: null,
      name: 'Guest',
      recording: false,
      recordingStartedAt: null,
      slug,
      role: 'guest',
      claimedHost: connectionHostClaim,
      // Guest Research Access (see CONTEXT.md) — fixed for the life of the
      // room, read once here off `roomRow` rather than re-checked per
      // message; see research_ask/research_remove below.
      guestAiAllowed: !!roomRow.guest_ai_allowed,
      joinedAt: Date.now(),
      talking: false,
      serverCopyState: 'unavailable',
      serverCopyPercent: 0,
      serverCopyTakeId: null,
      micLabel: ''
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
          replayTabsTo(ws, roomStateStore.onParticipantJoined(slug))
          send(ws, { type: 'yt_duck', talking: anyoneTalking(slug) })
          send(ws, { type: 'transcript_activity', active: anyoneTranscribing(slug) })
          // Exclusive to this connection — never broadcast (see the
          // 'server_copy_token' protocol doc above and ticket 11). This is
          // the one channel that can prove "this connection owns
          // clientId," since clientId is otherwise just broadcast
          // presence data.
          send(ws, { type: 'server_copy_token', clientId, token: makeServerCopyToken(slug, clientId, process.env.SECRET) })
        }
      }

      if (msg.type === 'tabs_sync' && clientId) {
        replayTabsTo(ws, roomStateStore.getRoom(slug))
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
        if (peer.recording) {
          const startedAt = Number(msg.startedAt)
          peer.recordingStartedAt = Number.isFinite(startedAt) && startedAt > 0
            ? startedAt
            : null
        } else {
          peer.recordingStartedAt = null
        }
        recomputeRoles(room)
        sendPresence(slug)
        broadcast(slug, { type: 'recording_state', name: peer.name, state: msg.state }, clientId)
      }

      if (msg.type === 'server_copy_progress' && clientId) {
        // Trust only a known state enum and an in-range integer percent —
        // this is client-reported, so don't let a bad/hostile value show
        // as if it were a real upload status to the other peer.
        if (!SERVER_COPY_STATES.has(msg.state)) return
        const percent = Number(msg.percent)
        peer.serverCopyState = msg.state
        peer.serverCopyPercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0
        if (Object.hasOwn(msg, 'takeId')) {
          const takeId = String(msg.takeId || '').slice(0, 64)
          peer.serverCopyTakeId = takeId || null
        }
        sendPresence(slug)
      }

      if (msg.type === 'mic_info' && clientId) {
        peer.micLabel = String(msg.label || '').slice(0, 80)
        sendPresence(slug)
      }

      if (msg.type === 'yt_duck' && clientId) {
        peer.talking = !!msg.talking
        sendDuck(slug)
      }

      if (msg.type === 'transcript_activity' && clientId) {
        peer.transcribing = !!msg.active
        sendTranscriptActivity(slug)
      }

      if (msg.type === 'tab_create' && clientId) {
        const result = roomStateStore.createTab(slug, { tabId: msg.tabId, title: msg.title })
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        sendTabsState(slug)
      }

      if (msg.type === 'tab_switch' && clientId) {
        const result = roomStateStore.switchTab(slug, String(msg.tabId || ''))
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        sendTabsState(slug)
      }

      if (msg.type === 'tab_close' && clientId) {
        const result = roomStateStore.closeTab(slug, String(msg.tabId || ''))
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        sendTabsState(slug)
      }

      if (msg.type === 'tab_video' && clientId) {
        const tabId = String(msg.tabId || '')
        const tab = roomStateStore.getRoom(slug).tabs.list.find((t) => t.id === tabId)
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
          roomStateStore.setTabVideo(slug, tabId, null)
          for (const p of room.values()) {
            send(p.ws, { type: 'tab_video', tabId, videoId: '', playing: false, positionSec: 0, positionAtMs: 0, triggerAtMs: 0 })
          }
          return
        }

        const positionSec = Number(msg.positionSec)
        const applyAtMs = Date.now() + TAB_VIDEO_LEAD_MS
        const video = {
          videoId,
          playing: !!msg.playing,
          positionSec: Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0,
          positionAtMs: applyAtMs
        }
        roomStateStore.setTabVideo(slug, tabId, video)
        for (const p of room.values()) {
          send(p.ws, { type: 'tab_video', tabId, ...video, triggerAtMs: applyAtMs })
        }
      }

      if (msg.type === 'transcript_line' && clientId) {
        const result = roomStateStore.appendTranscriptLine(slug, { speaker: msg.speaker, text: msg.text })
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        // Broadcast to every peer, including the sender — unlike tab_text
        // there is no local optimistic echo to protect (the Transcript is
        // read-only in the UI), and the server is the single source of
        // ordering truth for two near-simultaneous lines from different
        // speakers (see ADR-0002).
        for (const p of room.values()) {
          send(p.ws, { type: 'transcript_line', ...result.line })
        }
      }

      if (msg.type === 'research_ask' && clientId) {
        // Host-only by default — a guest can view the panel but not create
        // an entry (see ResearchPanel.svelte, which hides the ask
        // form/Turn Actions/Custom from a non-host the same way). One
        // gate for every Research Assistant action, Custom included — see
        // Guest Research Access in CONTEXT.md — cached on the peer at
        // connect (see `guestAiAllowed` above), not re-read per message.
        if (peer.role !== 'host' && !peer.guestAiAllowed) {
          send(ws, { type: 'error', message: 'Only the host can ask the Research Assistant.' })
          return
        }
        // Filed under the room's CURRENT active tab — server-determined,
        // never trusting a client-supplied tabId — so "creating an entry
        // while Tab A is active only ever appears under Tab A" holds even
        // if a hostile/buggy client tried to name a different tab.
        const activeTabId = roomStateStore.getRoom(slug).tabs.activeTabId
        const result = roomStateStore.addResearchEntry(slug, activeTabId, {
          id: msg.entryId,
          question: msg.question,
          turnId: msg.turnId,
          actionId: msg.actionId
        })
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        for (const p of room.values()) {
          send(p.ws, { type: 'research_entry', tabId: result.tabId, entry: result.entry })
        }
      }

      if (msg.type === 'research_resolve' && clientId) {
        const result = roomStateStore.resolveResearchEntry(slug, msg.entryId, { answer: msg.answer, citations: msg.citations })
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        for (const p of room.values()) {
          send(p.ws, { type: 'research_entry', tabId: result.tabId, entry: result.entry })
        }
      }

      if (msg.type === 'research_error' && clientId) {
        const result = roomStateStore.errorResearchEntry(slug, msg.entryId, { message: msg.message })
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        for (const p of room.values()) {
          send(p.ws, { type: 'research_entry', tabId: result.tabId, entry: result.entry })
        }
      }

      if (msg.type === 'research_remove' && clientId) {
        // Same gate as research_ask above — a guest can view the list but
        // not create or delete an entry unless Guest Research Access is on.
        if (peer.role !== 'host' && !peer.guestAiAllowed) {
          send(ws, { type: 'error', message: 'Only the host can remove a research card.' })
          return
        }
        const result = roomStateStore.removeResearchEntry(slug, msg.entryId)
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        for (const p of room.values()) {
          send(p.ws, { type: 'research_removed', tabId: result.tabId, entryId: result.entryId })
        }
      }

      if (msg.type === 'tab_text' && clientId) {
        const tabId = String(msg.tabId || '')
        const result = roomStateStore.setTabText(slug, tabId, msg.text ?? '')
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error })
          return
        }
        const tab = result.room.tabs.list.find((t) => t.id === tabId)
        broadcast(slug, { type: 'tab_text', tabId: tab.id, text: tab.text }, clientId)
      }
    })

    ws.on('close', () => {
      if (!clientId) return
      // A reconnect with the same clientId already replaced this socket —
      // do not delete the new peer (or we'd empty the room and, previously,
      // wipe tab memory while the user was still connected).
      const current = room.get(clientId)
      if (current && current.ws !== ws) return
      room.delete(clientId)
      if (room.size === 0) {
        rooms.delete(slug)
        roomStateStore.onParticipantLeft(slug)
      } else {
        recomputeRoles(room)
        sendPresence(slug)
        sendDuck(slug)
        sendTranscriptActivity(slug)
      }
    })

    ws.on('error', () => {
      if (!clientId) return
      const current = room.get(clientId)
      if (current && current.ws !== ws) return
      room.delete(clientId)
      // Note: unlike 'close' below, an 'error' disconnect doesn't trigger
      // onParticipantLeft (nor rooms.delete/sendPresence) even when this
      // was the last peer — matching this handler's pre-existing, narrower
      // cleanup scope. A subsequent 'close' for the same socket (which a
      // real ws library still fires after 'error') covers it from there.
    })
  })
}
