import { describe, it, expect } from 'vitest'
import { deriveExitGuard, isIncompleteServerCopyUpload } from '../../src/lib/recording/exit-guard.js'

describe('deriveExitGuard', () => {
  it('does not block leaving when neither recording nor upload is in progress', () => {
    const guard = deriveExitGuard({ hasActiveLocalRecording: false, hasIncompleteServerCopyUpload: false })
    expect(guard).toEqual({ blocking: false, severity: null, message: '' })
  })

  it('blocks with "recording" severity while the local recording is active, regardless of upload state', () => {
    const guard = deriveExitGuard({ hasActiveLocalRecording: true, hasIncompleteServerCopyUpload: false })
    expect(guard.blocking).toBe(true)
    expect(guard.severity).toBe('recording')
    expect(guard.message).toMatch(/local recording/i)
    expect(guard.message).toMatch(/finalized/i)
  })

  it('blocks with "upload" severity once recording has stopped but the server copy has not finished', () => {
    const guard = deriveExitGuard({ hasActiveLocalRecording: false, hasIncompleteServerCopyUpload: true })
    expect(guard.blocking).toBe(true)
    expect(guard.severity).toBe('upload')
  })

  it('says the local recording is already saved and leaving means sending it another way', () => {
    const guard = deriveExitGuard({ hasActiveLocalRecording: false, hasIncompleteServerCopyUpload: true })
    expect(guard.message).toMatch(/saved/i)
    expect(guard.message).toMatch(/another way/i)
  })

  it('prioritizes the active-recording warning when both conditions are true, so the two warnings never collide', () => {
    const guard = deriveExitGuard({ hasActiveLocalRecording: true, hasIncompleteServerCopyUpload: true })
    expect(guard.severity).toBe('recording')
  })

  it('gives the upload warning distinctly softer language than the active-recording warning', () => {
    const recordingGuard = deriveExitGuard({ hasActiveLocalRecording: true, hasIncompleteServerCopyUpload: false })
    const uploadGuard = deriveExitGuard({ hasActiveLocalRecording: false, hasIncompleteServerCopyUpload: true })
    expect(uploadGuard.message).not.toBe(recordingGuard.message)
    // The active-recording warning implies real risk to the recording itself...
    expect(recordingGuard.message).toMatch(/could stop it/i)
    // ...the upload warning must not imply that risk — the WAV is already safe.
    expect(uploadGuard.message).not.toMatch(/could stop it/i)
  })
})

describe('isIncompleteServerCopyUpload', () => {
  it('is true for uploading and catching_up', () => {
    expect(isIncompleteServerCopyUpload('uploading')).toBe(true)
    expect(isIncompleteServerCopyUpload('catching_up')).toBe(true)
  })

  it('is false for idle, complete, and failed', () => {
    expect(isIncompleteServerCopyUpload('idle')).toBe(false)
    expect(isIncompleteServerCopyUpload('complete')).toBe(false)
    expect(isIncompleteServerCopyUpload('failed')).toBe(false)
  })

  it('is false for unknown/undefined state', () => {
    expect(isIncompleteServerCopyUpload(undefined)).toBe(false)
    expect(isIncompleteServerCopyUpload('bogus')).toBe(false)
  })
})
