import { redirect, error } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { createHmac, timingSafeEqual } from 'crypto'

const SITE_COOKIE = 'pr_site_auth'

// ── Rate limiting ────────────────────────────────────────────────────────────
// Sliding window: track POST timestamps per IP for sensitive actions.
// In-memory is fine for a single-process server.

/** @type {Map<string, number[]>} */
const postLog = new Map()

// Clean up entries older than the window every few minutes
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS
  for (const [key, times] of postLog) {
    const fresh = times.filter(t => t > cutoff)
    if (fresh.length === 0) postLog.delete(key)
    else postLog.set(key, fresh)
  }
}, 2 * 60 * 1000)

const WINDOW_MS = 60_000
const AUTH_ACTIONS = new Set(['/site_enter', '/enter'])

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

  // Rate-limit all POST actions (form submissions)
  if (event.request.method === 'POST') {
    const ip = getIp(event)
    const action = event.url.searchParams.toString() // e.g. "/enter" or "/site_enter"
    const isAuthAction = AUTH_ACTIONS.has(action)
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
