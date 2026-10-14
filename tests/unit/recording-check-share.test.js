import { describe, it, expect } from 'vitest'
import {
  encodeInt16PcmBase64,
  decodeInt16PcmBase64,
  canPlayRecordingCheck,
  recordingCheckMessage,
  stayQuietCopy,
  isCheckTurn,
  CHECK_TURN,
  STAY_QUIET_HOST,
  STAY_QUIET_GUEST,
  MAX_SHARE_PCM_BASE64_CHARS
} from '../../src/lib/recording/recording-check-share.js'

describe('recording-check-share', () => {
  it('round-trips little-endian Int16 PCM through base64', () => {
    const pcm = new Int16Array([-32768, -1, 0, 1, 32767])
    expect(Array.from(decodeInt16PcmBase64(encodeInt16PcmBase64(pcm)))).toEqual(
      [-32768, -1, 0, 1, 32767]
    )
  })

  it('rejects empty, odd-length, and oversized base64 rather than inventing samples', () => {
    expect(decodeInt16PcmBase64('')).toBe(null)
    expect(decodeInt16PcmBase64('YQ==')).toBe(null) // 1 decoded byte
    expect(decodeInt16PcmBase64('!!!!')).toBe(null)
    expect(decodeInt16PcmBase64('a'.repeat(MAX_SHARE_PCM_BASE64_CHARS + 1))).toBe(null)
  })

  it('canPlayRecordingCheck is host-only, other-peer, and needs a clip', () => {
    expect(canPlayRecordingCheck({ isHost: true, isSelf: false, hasPreview: true })).toBe(true)
    expect(canPlayRecordingCheck({ isHost: false, isSelf: false, hasPreview: true })).toBe(false)
    expect(canPlayRecordingCheck({ isHost: true, isSelf: true, hasPreview: true })).toBe(false)
    expect(canPlayRecordingCheck({ isHost: true, isSelf: false, hasPreview: false })).toBe(false)
  })

  it('recordingCheckMessage adds a Check Turn on the existing recording_check type', () => {
    expect(recordingCheckMessage({ open: true, turn: CHECK_TURN.host })).toEqual({
      type: 'recording_check',
      open: true,
      turn: 'host'
    })
    expect(recordingCheckMessage({ open: false })).toEqual({
      type: 'recording_check',
      open: false
    })
    expect(isCheckTurn('mic')).toBe(false)
  })

  it('stayQuietCopy is the explicit turn sentence, not a blank string for host or guest', () => {
    expect(stayQuietCopy(CHECK_TURN.host)).toBe(STAY_QUIET_HOST)
    expect(stayQuietCopy(CHECK_TURN.guest)).toBe(STAY_QUIET_GUEST)
    expect(stayQuietCopy(CHECK_TURN.passed)).toBe('')
    expect(stayQuietCopy(null)).toBe('')
  })
})
