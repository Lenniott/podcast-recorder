import { describe, it, expect } from 'vitest'
import { deriveServerCopyDisplay } from '../../src/lib/server-copy-status.js'

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
