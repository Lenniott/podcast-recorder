// Friend room cap (friend-password-auth ticket 03) — pure display helper
// for the Rooms-full view. The actual cap/expiry computation (which rooms
// are active, and their order) lives server-side in
// $lib/server/friend-room-cap.js and is never redone here — this only
// formats a millisecond duration for display.

export function formatRemaining(ms) {
  const clamped = Math.max(0, ms)
  if (clamped < 60000) return 'less than a minute'

  const totalMinutes = Math.ceil(clamped / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}
