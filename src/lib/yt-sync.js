/**
 * Pure helpers for synced YouTube playback, shared by every tab's video.
 *
 * No DOM, no player — everything here is unit-testable math and parsing.
 * The wire protocol lives in src/lib/server/ws-rooms.js; the player lives
 * in src/lib/TabVideoPlayer.svelte.
 */

const VIDEO_ID = /^[\w-]{11}$/

/**
 * Extract an 11-char YouTube video id from user input.
 * Accepts watch URLs, youtu.be short links, /shorts/ links, /embed/ links
 * and raw ids. Returns null when nothing valid is found.
 */
export function parseYouTubeId(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  if (VIDEO_ID.test(raw)) return raw

  let url
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return null
  }

  const host = url.hostname.replace(/^www\.|^m\./, '')
  let candidate = null

  if (host === 'youtu.be') {
    candidate = url.pathname.split('/')[1]
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, first, second] = url.pathname.split('/')
    if (first === 'watch') candidate = url.searchParams.get('v')
    else if (first === 'shorts' || first === 'embed' || first === 'live') candidate = second
  }

  return candidate && VIDEO_ID.test(candidate) ? candidate : null
}

/**
 * Where the shared video should be at `atServerMs` (server clock).
 * A playing video advances from positionSec since positionAtMs;
 * a paused one stays put.
 */
export function effectivePosition(state, atServerMs) {
  if (!state.playing) return state.positionSec
  return state.positionSec + Math.max(0, atServerMs - state.positionAtMs) / 1000
}
