import { describe, it, expect } from 'vitest'
import { createCheckTurnCoordinator } from '../../src/lib/recording/check-turn-coordinator.js'
import { createRoomRecordingState } from '../../src/lib/recording/synced-recording-session.js'

function pair(options = {}) {
  const messages = [], markers = [], peers = [
    { clientId: 'h', role: 'host' }, { clientId: 'g', role: 'guest' }
  ]
  const room = createRoomRecordingState({ publish: m => messages.push(m), reply: (_, m) => messages.push(m) })
  const initialPeers = options.solo ? peers.filter(p => p.clientId === options.solo) : peers
  room.presence(initialPeers)
  room.receive(options.solo || 'h', { type: 'recording_session', phase: 'recording' })
  const coordinators = {}, contexts = {}
  for (const peer of peers) {
    contexts[peer.clientId] = { participantId: peer.clientId, role: peer.role, peers: initialPeers, recording: initialPeers.includes(peer), attemptId: 'take-1', connected: true }
    coordinators[peer.clientId] = createCheckTurnCoordinator({
      getContext: () => contexts[peer.clientId], send: m => room.receive(peer.clientId, m),
      requestTakeStart: m => markers.push({ ...m, participantId: peer.clientId }),
      rotateAttempt: options.rotateAttempt || (async () => ({ status: 'ready', attemptId: 'take-2' })),
      onPreviewReady: options.onPreviewReady, onIssue: options.onIssue, resetTakeMarker: options.resetTakeMarker
    })
  }
  function flush() { while (messages.length) { const m = messages.shift(); for (const c of Object.values(coordinators)) c.receive(m) } }
  flush()
  coordinators.h.start(); coordinators.g.start(); flush()
  return { ...coordinators, contexts, room, flush, markers, messages, allPeers: peers }
}

describe('Check Turn coordinator through authoritative paired room messages', () => {
  it('offers host then guest checks and requests one controlling marker without restarting capture', () => {
    const p = pair()
    expect(p.h.view.ownCheckVisible).toBe(true)
    expect(p.g.view.stayQuietRole).toBe('host')
    p.h.confirm(); p.flush()
    expect(p.g.view.ownCheckVisible).toBe(true)
    expect(p.h.view.stayQuietRole).toBe('guest')
    p.g.confirm(); p.flush()
    expect(p.h.view.complete).toBe(true)
    expect(p.g.view.complete).toBe(true)
    expect(p.markers).toHaveLength(1)
    expect(p.markers[0].participantId).toBe('h')
    p.h.confirm(); p.g.confirm(); p.h.resync(); p.g.resync(); p.flush()
    expect(p.markers).toHaveLength(1)
  })
})


it('both can dismiss locally and replay cannot reopen the guest when their turn arrives', () => {
  const p = pair()
  p.g.dismiss(); p.h.dismiss(); p.h.dismiss(); p.flush()
  expect(p.h.view.presentation).toBe(null)
  expect(p.g.view.presentation).toBe(null)
  expect(p.g.view.canShow).toBe(true)
  expect(p.markers).toHaveLength(0)
  p.g.resync(); p.h.resync(); p.flush()
  expect(p.g.view.presentation).toBe(null)
  p.g.show()
  expect(p.g.view.presentation).toBe('own')
  p.g.dismiss(); p.flush()
  expect(p.markers).toHaveLength(1)
})

it('retake dismissal survives deferred ready and Stop invalidates a second late ready', async () => {
  const pending = [], rolls = []
  const p = pair({ rotateAttempt: m => { rolls.push(m); return new Promise(resolve => pending.push(resolve)) } })
  p.h.confirm(); p.flush()
  p.g.reject(); p.g.reject(); p.flush()
  expect(rolls).toHaveLength(2)
  p.h.dismiss()
  expect(p.h.view.presentation).toBe(null)
  pending[0]({ status: 'ready', attemptId: 'take-2' })
  pending[1]({ status: 'ready', attemptId: 'take-2' })
  await Promise.resolve(); p.flush()
  expect(p.h.view.presentation).toBe(null)
  p.h.show(); p.h.reject(); p.flush()
  p.h.stop(); p.g.stop()
  const before = p.messages.length
  const stopped = p.h.view
  pending[2]({ status: 'ready', attemptId: 'take-3' })
  pending[3]({ status: 'ready', attemptId: 'take-3' })
  await Promise.resolve()
  expect(p.h.view.presentation).toBe(null)
  expect(p.g.view.presentation).toBe(null)
  expect(p.messages).toHaveLength(before)
  expect(p.h.view).toEqual(stopped)
  expect(p.markers).toHaveLength(0)
})

it('resync republishes confirmed preview after own check closes without accepting old writes', () => {
  const previews = []
  const p = pair({ onPreviewReady: m => previews.push(m) })
  p.h.handleWritten(new Int16Array([12, 34]), { attemptId: 'take-1' })
  p.h.confirm(); p.flush()
  previews.length = 0
  p.h.handleWritten(new Int16Array([99]), { attemptId: 'old' })
  p.h.resync(); p.flush()
  expect([...previews[0].pcm]).toEqual([12, 34])
})

it('reconnect retains the recording session and check round when a socket briefly disappears', () => {
  const p = pair()
  const original = { ...p.g.view }
  p.g.dismiss()
  const solo = p.room.presence([p.contexts.h.peers[0]])
  p.h.receive(solo)
  const rejoined = p.room.presence(p.contexts.h.peers)
  p.h.receive(rejoined); p.g.receive(rejoined)
  p.g.resync(); p.h.resync(); p.flush()
  expect(p.g.view.sessionId).toBe(original.sessionId)
  expect(p.g.view.roundId).toBe(original.roundId)
  expect(p.g.view.presentation).toBe(null)
})

it('an older recording-session snapshot cannot replace the next active session', () => {
  const p = pair()
  const old = { type: 'recording_session', phase: 'recording', sessionId: p.room.check.sessionId, check: { ...p.room.check } }
  p.room.receive('h', { type: 'recording_session', phase: 'idle' }); p.flush()
  p.room.receive('h', { type: 'recording_session', phase: 'recording' }); p.flush()
  p.h.start(); p.g.start(); p.flush()
  const current = p.h.view.sessionId
  p.h.receive(old); p.g.receive(old)
  p.h.receive({ type: 'recording_session', phase: 'idle', sessionId: old.sessionId })
  expect(p.h.view.sessionId).toBe(current)
  expect(p.h.view.presentation).toBe('own')
  expect(p.h.acceptsPreview({ sessionId: old.sessionId, roundId: 1 })).toBe(false)
})

it('old round turns and rejection requests cannot affect a newer round', async () => {
  const p = pair()
  const old = { ...p.room.check }
  p.h.reject(); p.flush(); await Promise.resolve(); p.flush()
  const current = { ...p.h.view }
  for (const turn of ['host', 'guest', 'passed']) {
    p.h.receive({ type: 'presence', check: { ...old, turn, revision: 100 } })
    p.g.receive({ type: 'presence', check: { ...old, turn, revision: 100 } })
  }
  p.room.receive('h', { type: 'recording_check', ...old, action: 'reject' }); p.flush()
  expect(p.h.view.roundId).toBe(current.roundId)
  expect(p.h.view.presentation).toBe('own')
  expect(p.g.view.stayQuietRole).toBe('host')
  expect(p.markers).toHaveLength(0)
})

for (const outcome of ['failed', 'throws']) {
  it(`retake ${outcome} reports an issue and closes screens without retrying`, async () => {
    const issues = [], rolls = []
    const p = pair({ onIssue: m => issues.push(m), rotateAttempt: async m => {
      rolls.push(m)
      if (outcome === 'throws') throw new Error('disk')
      return { status: 'failed', error: new Error('disk') }
    } })
    p.h.reject(); p.flush(); await Promise.resolve(); p.flush()
    expect(issues).toHaveLength(2)
    expect(issues[0].code).toBe('check-retake-failed')
    expect(p.h.view.presentation).toBe(null)
    expect(p.g.view.presentation).toBe(null)
    p.h.show(); p.g.resync(); p.flush()
    expect(rolls).toHaveLength(2)
    expect(p.markers).toHaveLength(0)
  })
}

it('priority dialogs yield the check without passing it and closing them requires Show check', () => {
  const p = pair()
  p.contexts.h.activeDialog = 'stop-request'; p.h.contextChanged()
  expect(p.h.view.presentation).toBe(null)
  expect(p.h.view.turn).toBe('host')
  p.contexts.h.activeDialog = null; p.h.contextChanged()
  expect(p.h.view.canShow).toBe(true)
  p.h.show()
  expect(p.h.view.presentation).toBe('own')
  expect(p.markers).toHaveLength(0)
})

for (const participant of ['h', 'g']) {
  it(`${participant} no longer waits on a departed peer and retains their own solo progress`, () => {
    const p = pair()
    p.h.confirm(); p.flush()
    const remaining = p.contexts.h.peers.filter(peer => peer.clientId === participant)
    const event = p.room.presence(remaining)
    p[participant].receive(event)
    expect(p[participant].view.waiting).toBe(false)
    if (participant === 'h') expect(p.h.view.complete).toBe(true)
    else { expect(p.g.view.ownCheckVisible).toBe(true); p.g.confirm(); p.flush(); expect(p.g.view.complete).toBe(true) }
  })
}

it('disposal prevents late retake, preview, marker, view, and room effects', async () => {
  const pending = [], previews = []
  const p = pair({ onPreviewReady: m => previews.push(m), rotateAttempt: () => new Promise(resolve => pending.push(resolve)) })
  p.h.reject(); p.flush()
  p.h.dispose(); p.g.dispose()
  pending.forEach(resolve => resolve({ status: 'ready', attemptId: 'late' }))
  await Promise.resolve()
  p.h.start(); p.h.resync(); p.h.show()
  p.h.handleWritten(new Int16Array([1]), { attemptId: 'late' })
  p.h.receive({ type: 'presence', check: p.room.check })
  expect(p.h.view.presentation).toBe(null)
  expect(p.messages).toHaveLength(0)
  expect(previews).toHaveLength(0)
  expect(p.markers).toHaveLength(0)
})


it('solo-passed guest joins a genuinely newer host-led round without rotating their saved attempt', () => {
  const resets = [], rolls = []
  const p = pair({ solo: 'g', resetTakeMarker: () => resets.push('reset'), rotateAttempt: () => rolls.push('roll') })
  p.g.dismiss(); p.flush()
  expect(p.g.view.complete).toBe(true)
  const soloRound = p.g.view.roundId
  const soloSession = p.g.view.sessionId
  const joined = p.room.presence(p.allPeers)
  p.contexts.h.recording = true
  p.contexts.h.peers = p.contexts.g.peers = p.allPeers
  p.h.receive(joined); p.g.receive(joined); p.h.start(); p.flush()
  expect(p.g.view.roundId).toBeGreaterThan(soloRound)
  expect(p.g.view.sessionId).toBe(soloSession)
  expect(p.g.view.presentation).toBe(null)
  expect(p.g.view.attemptId).toBe('take-1')
  expect(resets).toHaveLength(1)
  p.h.confirm(); p.flush()
  p.g.show(); p.g.confirm(); p.flush()
  expect(p.g.view.complete).toBe(true)
  expect(p.markers).toHaveLength(2) // original solo boundary and the new shared boundary
  expect(rolls).toHaveLength(0)
})

it.each(['h', 'g'])('%s can hide a wait with no reply and leave the other check pending', participant => {
  const p = pair()
  if (participant === 'h') { p.h.confirm(); p.flush() }
  p[participant].dismiss()
  expect(p[participant].view.presentation).toBe(null)
  expect(p[participant].view.pending).toBe(true)
  expect(p[participant].view.canShow).toBe(true)
  expect(p.markers).toHaveLength(0)
})

it('stopped lifecycles reject late presence and confirmed audio, and Show check remains inert', () => {
  const previews = []
  const p = pair({ onPreviewReady: m => previews.push(m) })
  const check = { ...p.room.check }
  p.h.stop(); p.g.stop()
  for (const c of [p.h, p.g]) {
    c.receive({ type: 'presence', check })
    c.handleWritten(new Int16Array([123]), { attemptId: 'take-1' })
    c.show(); c.resync()
    expect(c.view.presentation).toBe(null)
    expect(c.buildPreview(48000).size).toBe(44)
  }
  expect(previews).toHaveLength(0)
  expect(p.markers).toHaveLength(0)
})

it('late written audio from a rejected attempt cannot refill the fresh check', async () => {
  const p = pair()
  p.h.handleWritten(new Int16Array([101]), { attemptId: 'take-1' })
  p.h.reject(); p.flush(); await Promise.resolve(); p.flush()
  p.h.handleWritten(new Int16Array([202]), { attemptId: 'take-1' })
  expect(p.h.buildPreview(48000).size).toBe(44)
  p.h.handleWritten(new Int16Array([303]), { attemptId: 'take-2' })
  const bytes = await p.h.buildPreview(48000).arrayBuffer()
  expect([...new Int16Array(bytes.slice(44))]).toEqual([303])
})

it('Stop between retake ready and its queued continuation prevents every old effect', async () => {
  const pending = []
  const p = pair({ rotateAttempt: () => new Promise(resolve => pending.push(resolve)) })
  p.h.reject(); p.flush()
  pending.forEach(resolve => resolve({ status: 'ready', attemptId: 'late' }))
  p.h.stop(); p.g.stop()
  const stoppedHost = p.h.view, stoppedGuest = p.g.view
  await Promise.resolve()
  expect(p.h.view).toEqual(stoppedHost)
  expect(p.g.view).toEqual(stoppedGuest)
  expect(p.messages).toHaveLength(0)
  expect(p.markers).toHaveLength(0)
})

it('a new recording invalidates old retake results without replacing its active attempt', async () => {
  const pending = []
  const p = pair({ rotateAttempt: () => new Promise(resolve => pending.push(resolve)) })
  p.h.reject(); p.flush()
  p.room.receive('h', { type: 'recording_session', phase: 'idle' }); p.flush()
  p.contexts.h.attemptId = p.contexts.g.attemptId = 'new-session-take'
  p.room.receive('h', { type: 'recording_session', phase: 'recording' }); p.flush()
  p.h.start(); p.g.start(); p.flush()
  const current = p.h.view
  pending.forEach(resolve => resolve({ status: 'ready', attemptId: 'old-session-retake' }))
  await Promise.resolve(); p.flush()
  expect(p.h.view).toEqual(current)
  expect(p.h.view.attemptId).toBe('new-session-take')
  expect(p.markers).toHaveLength(0)
})

it('starting real capture in an existing retake round uses its fresh file instead of rolling again', () => {
  const p = pair()
  p.h.reject(); p.flush()
  const rolls = []
  const fresh = createCheckTurnCoordinator({
    getContext: () => ({ ...p.contexts.h, attemptId: 'freshly-opened' }),
    send: message => p.room.receive('h', message),
    rotateAttempt: () => { rolls.push('roll'); return Promise.resolve({ status: 'ready', attemptId: 'extra' }) },
    requestTakeStart: () => {}
  })
  fresh.receive({ type: 'recording_session', phase: 'recording', sessionId: p.room.check.sessionId, check: p.room.check })
  fresh.start()
  expect(rolls).toHaveLength(0)
  expect(fresh.view.attemptId).toBe('freshly-opened')
  expect(fresh.view.ownCheckVisible).toBe(true)
})

it('a reinitialized authoritative room can resume checks on the existing local file after a long disconnect', () => {
  const p = pair()
  p.g.dismiss()
  const previous = { ...p.room.check }
  const recovered = createRoomRecordingState({ publish: event => { p.h.receive(event); p.g.receive(event) }, reply: () => {} })
  recovered.presence(p.allPeers)
  recovered.receive('h', { type: 'recording_session_sync', phase: 'recording' })
  expect(p.h.view.sessionId).not.toBe(previous.sessionId)
  expect(p.h.view.attemptId).toBe('take-1')
  expect(p.g.view.presentation).toBe(null)
  p.h.receive({ type: 'recording_session', phase: 'recording', sessionId: previous.sessionId, check: previous })
  expect(p.h.view.sessionId).toBe(recovered.check.sessionId)
})

it('room recovery during retake keeps checks pending until a current attempt is ready', async () => {
  const pending = []
  const p = pair({ rotateAttempt: () => new Promise(resolve => pending.push(resolve)) })
  p.h.reject(); p.flush()
  const recovered = createRoomRecordingState({ publish: event => { p.h.receive(event); p.g.receive(event) }, reply: () => {} })
  recovered.presence(p.allPeers)
  recovered.receive('h', { type: 'recording_session_sync', phase: 'recording' })
  expect(p.h.view.retaking).toBe(true)
  expect(pending).toHaveLength(4)
  pending[0]({ status: 'ready', attemptId: 'obsolete' })
  pending[1]({ status: 'ready', attemptId: 'obsolete' })
  await Promise.resolve()
  expect(p.h.view.retaking).toBe(true)
  pending[2]({ status: 'ready', attemptId: 'recovered' })
  pending[3]({ status: 'ready', attemptId: 'recovered' })
  await Promise.resolve()
  expect(p.h.view.attemptId).toBe('recovered')
  expect(p.h.view.ownCheckVisible).toBe(true)
})
