import { redirect, error } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { createHmac, timingSafeEqual } from 'crypto'

const SITE_COOKIE = 'pr_site_auth'

// ── Rate limiting ────────────────────────────────────────────────────────────
// Sliding window: track POST timestamps per IP for sensitive actions.
// In-memory is fine for a single-process server.

/** @type {Map<string, number[]>} */
const postLog = new Map()

const WINDOW_MS = 60_000
const AUTH_ACTIONS = new Set(['/site_enter', '/enter'])

// Clean up entries older than the window every few minutes
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS
  for (const [key, times] of postLog) {
    const fresh = times.filter(t => t > cutoff)
    if (fresh.length === 0) postLog.delete(key)
    else postLog.set(key, fresh)
  }
}, 2 * 60 * 1000)
cleanupTimer.unref?.()

function parseInt_(val, fallback) {
  const n = Number.parseInt(String(val || ''), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const MAX_POSTS      = parseInt_(env.MAX_POSTS_PER_MIN, 20)
const MAX_AUTH_POSTS = parseInt_(env.MAX_AUTH_POSTS_PER_MIN, 10)

function getIp(event) {
  return (
    event.request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    event.request.headers.get('x-real-ip') ||
    'unknown'
  )
}

// SvelteKit named actions are the first query key that starts with `/`
// (see call_action in @sveltejs/kit). Other params may sit before that
// (`?expired=1&/enter`), so we must not take keys()[0] blindly. A key
// without the slash is a normal query param, not an action name.
function formActionFromUrl(url) {
  for (const key of url.searchParams.keys()) {
    if (key.startsWith('/')) return key
  }
  return ''
}

function checkRateLimit(ip, isAuthAction) {
  const key = isAuthAction ? `auth:${ip}` : `post:${ip}`
  const max = isAuthAction ? MAX_AUTH_POSTS : MAX_POSTS
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const times = (postLog.get(key) ?? []).filter(t => t > cutoff)
  if (times.length >= max) return false
  times.push(now)
  postLog.set(key, times)
  return true
}

function isServerCopyUpload(pathname) {
  return /^\/rec\/[^/]+\/server-copy\/(?:session|chunks|finalize)$/.test(pathname)
}

// ── Site auth ────────────────────────────────────────────────────────────────

function verifySiteToken(token) {
  if (!env.SITE_PASSWORD) return true
  if (!token) return false
  const expected = createHmac('sha256', env.SECRET)
    .update('site:' + (env.SITE_PASSWORD || ''))
    .digest('hex')
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))
  } catch { return false }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export async function handle({ event, resolve }) {
  const { pathname } = event.url

  // Static assets: skip everything
  if (pathname.startsWith('/_app/') || pathname === '/favicon.ico') {
    return resolve(event)
  }

  // Rate-limit human-scale POST actions. Server-copy upload requests are
  // already authenticated by room cookie + clientId token, and chunk traffic
  // arrives many times per minute during a normal recording. Counting this
  // flow here can make an otherwise complete upload fail at finalize time.
  if (event.request.method === 'POST' && !isServerCopyUpload(pathname)) {
    const ip = getIp(event)
    const isAuthAction = AUTH_ACTIONS.has(formActionFromUrl(event.url))
    if (!checkRateLimit(ip, isAuthAction)) {
      throw error(429, 'Too many requests — slow down and try again in a minute.')
    }
  }

  // Site password gate (only when SITE_PASSWORD is set)
  if (env.SITE_PASSWORD) {
    // Room pages and WS use their own room-password auth
    if (!pathname.startsWith('/rec/') && pathname !== '/ws') {
      if (!verifySiteToken(event.cookies.get(SITE_COOKIE))) {
        if (pathname !== '/') throw redirect(303, '/')
      }
    }
  }

  return resolve(event)
}
