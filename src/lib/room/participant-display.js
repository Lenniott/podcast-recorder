/**
 * Room presence as shown on a participant card: Online vs Offline from the
 * socket only. Recording is a separate REC line — folding it into this
 * label is what made the old status pill lie after a disconnect.
 */
export function participantPresence(wsStatus) {
  return wsStatus === 'connected' ? 'online' : 'offline'
}

/** Sidebar is ~240px; long device names wrap onto a second line and stop at 20 chars. */
export const MIC_LABEL_MAX = 20

export function clampMicLabel(label) {
  const text = String(label || '')
  if (text.length <= MIC_LABEL_MAX) return text
  return `${text.slice(0, MIC_LABEL_MAX)}…`
}

/** Elapsed whole seconds since a take's startedAt, or null if we don't have one. */
export function recordingElapsedSeconds(startedAt, now = Date.now()) {
  const start = Number(startedAt)
  if (!Number.isFinite(start) || start <= 0) return null
  return Math.max(0, Math.floor((now - start) / 1000))
}
