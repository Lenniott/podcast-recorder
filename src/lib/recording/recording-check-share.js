/**
 * Wire format for the record-start listen-back clip shared with the other
 * peer. PCM only — the host rebuilds a WAV locally. Size is capped so a
 * JSON WebSocket never carries the full 30s preview buffer.
 */

export const SHARE_AFTER_SAMPLES = 3 * 48000
export const MAX_SHARE_SAMPLES = 8 * 48000
export const MAX_SHARE_PCM_BASE64_CHARS = Math.ceil((MAX_SHARE_SAMPLES * 2) / 3) * 4

export function encodeInt16PcmBase64(i16) {
  const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength)
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function decodeInt16PcmBase64(pcm) {
  if (typeof pcm !== 'string' || pcm.length === 0 || pcm.length > MAX_SHARE_PCM_BASE64_CHARS) {
    return null
  }
  let binary
  try {
    binary = atob(pcm)
  } catch {
    return null
  }
  if (binary.length < 2 || binary.length % 2 !== 0) return null
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer)
}

export function canPlayRecordingCheck({ isHost, isSelf, hasPreview } = {}) {
  return isHost === true && isSelf !== true && hasPreview === true
}
