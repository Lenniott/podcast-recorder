import { describe, it, expect } from 'vitest'
import { participantPresence, clampMicLabel, recordingElapsedSeconds } from '../../src/lib/participant-display.js'

describe('participantPresence', () => {
  it('is online only while the socket is connected', () => {
    expect(participantPresence('connected')).toBe('online')
  })

  it('is offline while connecting or disconnected, even if they are recording', () => {
    expect(participantPresence('connecting')).toBe('offline')
    expect(participantPresence('disconnected')).toBe('offline')
    expect(participantPresence('disconnected', { recording: true })).toBe('offline')
  })
})

describe('clampMicLabel', () => {
  it('leaves short names alone', () => {
    expect(clampMicLabel('Shure SM7B')).toBe('Shure SM7B')
  })

  it('caps at 20 characters and ellipsizes the rest', () => {
    const out = clampMicLabel('Default - MacBook Pro Microphone')
    expect(out).toBe('Default - MacBook Pr…')
    expect(out.replace(/…$/, '').length).toBe(20)
  })
})

describe('recordingElapsedSeconds', () => {
  it('returns null when startedAt is missing so the UI cannot invent 00:00', () => {
    expect(recordingElapsedSeconds(null, 50_000)).toBeNull()
    expect(recordingElapsedSeconds(undefined, 50_000)).toBeNull()
  })

  it('is whole seconds since startedAt', () => {
    expect(recordingElapsedSeconds(10_000, 25_400)).toBe(15)
  })
})
