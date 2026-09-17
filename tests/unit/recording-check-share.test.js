import { describe, it, expect } from 'vitest'
import {
  encodeInt16PcmBase64,
  decodeInt16PcmBase64,
  canPlayRecordingCheck,
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
})
