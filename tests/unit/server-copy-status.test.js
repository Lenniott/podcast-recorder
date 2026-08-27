import { describe, it, expect } from 'vitest'
import {
  deriveServerCopyDisplay,
  deriveServerCopyUploadState,
  shouldAnnounceServerCopyFailure,
  canShowServerCopyDownload
} from '../../src/lib/server-copy-status.js'

describe('deriveServerCopyDisplay', () => {
  it('reports unavailable when there is no status at all (never started)', () => {
    expect(deriveServerCopyDisplay(null)).toEqual({ state: 'unavailable', percent: 0 })
    expect(deriveServerCopyDisplay(undefined)).toEqual({ state: 'unavailable', percent: 0 })
  })

  it('reports unavailable while a session request is still pending acceptance', () => {
    const status = { accepted: false, failed: false, finalized: false, progress: 0 }
    expect(deriveServerCopyDisplay(status)).toEqual({ state: 'unavailable', percent: 0 })
  })

  it('reports failed when the session was rejected (expired/deleted room)', () => {
    const status = { accepted: false, failed: true, finalized: false, progress: 0 }
    expect(deriveServerCopyDisplay(status)).toEqual({ state: 'failed', percent: 0 })
  })

  it('reports in_progress with a rounded percentage while uploading', () => {
    const status = { accepted: true, failed: false, finalized: false, progress: 0.4321 }
    expect(deriveServerCopyDisplay(status)).toEqual({ state: 'in_progress', percent: 43 })
  })

  it('reports in_progress at 100% on a fast connection without treating it as complete', () => {
    const status = { accepted: true, failed: false, finalized: false, progress: 1 }
    expect(deriveServerCopyDisplay(status)).toEqual({ state: 'in_progress', percent: 100 })
  })

  it('reports complete only once finalized, pinned at 100%', () => {
    const status = { accepted: true, failed: false, finalized: true, progress: 1 }
    expect(deriveServerCopyDisplay(status)).toEqual({ state: 'complete', percent: 100 })
  })

  it('reports failed once a chunk upload has failed mid-transfer, keeping last known percent', () => {
    const status = { accepted: true, failed: true, finalized: false, progress: 0.6 }
    expect(deriveServerCopyDisplay(status)).toEqual({ state: 'failed', percent: 60 })
  })

  it('never lets a NaN/undefined progress produce a broken percent', () => {
    const status = { accepted: true, failed: false, finalized: false, progress: undefined }
    expect(deriveServerCopyDisplay(status)).toEqual({ state: 'in_progress', percent: 0 })
  })

  it('clamps percent into [0, 100] even given out-of-range progress', () => {
    expect(deriveServerCopyDisplay({ accepted: true, progress: -0.2 }).percent).toBe(0)
    expect(deriveServerCopyDisplay({ accepted: true, progress: 1.5 }).percent).toBe(100)
  })
})

describe('deriveServerCopyUploadState', () => {
  it('is idle when there is no session yet, or one that has not been accepted', () => {
    expect(deriveServerCopyUploadState(null, { isRecording: true })).toBe('idle')
    expect(deriveServerCopyUploadState({ accepted: false, failed: false }, { isRecording: true })).toBe('idle')
  })

  it('is failed when the session was rejected outright, even with nothing queued', () => {
    expect(deriveServerCopyUploadState({ accepted: false, failed: true }, { isRecording: true })).toBe('failed')
  })

  it('is failed once a chunk upload has failed mid-transfer', () => {
    const status = { accepted: true, failed: true, finalized: false }
    expect(deriveServerCopyUploadState(status, { isRecording: true })).toBe('failed')
    expect(deriveServerCopyUploadState(status, { isRecording: false })).toBe('failed')
  })

  it('is complete only once finalized, regardless of recording state', () => {
    const status = { accepted: true, failed: false, finalized: true }
    expect(deriveServerCopyUploadState(status, { isRecording: true })).toBe('complete')
    expect(deriveServerCopyUploadState(status, { isRecording: false })).toBe('complete')
  })

  it('is "uploading" while accepted-but-not-finalized and the local recording is still active', () => {
    const status = { accepted: true, failed: false, finalized: false }
    expect(deriveServerCopyUploadState(status, { isRecording: true })).toBe('uploading')
  })

  it('is "catching_up" once the local recording has stopped but the copy has not finalized yet', () => {
    const status = { accepted: true, failed: false, finalized: false }
    expect(deriveServerCopyUploadState(status, { isRecording: false })).toBe('catching_up')
  })

  it('defaults isRecording to false when not passed', () => {
    const status = { accepted: true, failed: false, finalized: false }
    expect(deriveServerCopyUploadState(status)).toBe('catching_up')
  })
})

describe('shouldAnnounceServerCopyFailure', () => {
  it('is true once recording has fully stopped and the copy has failed, unannounced', () => {
    expect(shouldAnnounceServerCopyFailure({ recordingState: 'idle', uploadState: 'failed' })).toBe(true)
  })

  it('is false while still recording, even if the copy has already failed — never interrupts an active take', () => {
    expect(shouldAnnounceServerCopyFailure({ recordingState: 'recording', uploadState: 'failed' })).toBe(false)
  })

  it('is false once already announced — fires at most once per take', () => {
    expect(
      shouldAnnounceServerCopyFailure({ recordingState: 'idle', uploadState: 'failed', announced: true })
    ).toBe(false)
  })

  it('is false for every non-failed upload state', () => {
    for (const uploadState of ['idle', 'uploading', 'catching_up', 'complete']) {
      expect(shouldAnnounceServerCopyFailure({ recordingState: 'idle', uploadState })).toBe(false)
    }
  })

  it('is false with no arguments at all', () => {
    expect(shouldAnnounceServerCopyFailure()).toBe(false)
  })
})

describe('canShowServerCopyDownload', () => {
  it('is true only when the viewer is host and the copy is complete', () => {
    expect(canShowServerCopyDownload({ isHost: true, state: 'complete' })).toBe(true)
  })

  it('is false for a host when the copy is not complete', () => {
    for (const state of ['unavailable', 'in_progress', 'failed']) {
      expect(canShowServerCopyDownload({ isHost: true, state })).toBe(false)
    }
  })

  it('is false for a non-host even when the copy is complete', () => {
    expect(canShowServerCopyDownload({ isHost: false, state: 'complete' })).toBe(false)
  })

  it('is false with no arguments at all', () => {
    expect(canShowServerCopyDownload()).toBe(false)
  })
})
