import { fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { createRoom, getRoomBySlug } from '$lib/server/db.js'
import { hashPassword, generateSlug } from '$lib/server/auth.js'
import { createHmac, timingSafeEqual } from 'crypto'

const SITE_COOKIE = 'pr_site_auth'

// Cookie is only marked secure if we're explicitly told HTTPS is in use.
// Avoids cookie being silently rejected during HTTP-only LAN/Docker testing.
function isSecure() {
  return env.HTTPS === 'true' || env.FORCE_HTTPS === 'true'
}

function makeSiteToken() {
  const secret   = env.SECRET
  const password = env.SITE_PASSWORD || ''
  return createHmac('sha256', secret).update('site:' + password).digest('hex')
}

function verifySiteToken(token) {
  if (!env.SITE_PASSWORD) return true   // no password set — open access
  if (!token) return false
  const expected = makeSiteToken()
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))
  } catch { return false }
}

export async function load({ cookies }) {
  const siteAuthed = verifySiteToken(cookies.get(SITE_COOKIE))
  console.log('[load /] siteProtected=%s siteAuthed=%s', !!env.SITE_PASSWORD, siteAuthed)
  return { siteAuthed, siteProtected: !!env.SITE_PASSWORD }
}

export const actions = {
  site_enter: async ({ request, cookies }) => {
    console.log('[action site_enter] called')
    const data     = await request.formData()
    const password = String(data.get('password') || '').trim()

    const provided = createHmac('sha256', env.SECRET).update('site:' + password).digest('hex')
    const expected = makeSiteToken()
    let match = false
    try {
      match = timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
    } catch { match = false }
    if (!match) {
      return fail(403, { siteError: 'Wrong password.' })
    }

    console.log('[action site_enter] correct — setting cookie (secure=%s)', isSecure())
    cookies.set(SITE_COOKIE, makeSiteToken(), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 3,
      secure: isSecure()
    })

    throw redirect(303, '/')
  },

  create: async ({ request, cookies }) => {
    console.log('[action create] called')

    if (env.SITE_PASSWORD && !verifySiteToken(cookies.get(SITE_COOKIE))) {
      console.log('[action create] not site-authed')
      return fail(403, { siteError: 'Not authorised.' })
    }

    const data     = await request.formData()
    const name     = String(data.get('name') || '').trim()
    const password = String(data.get('password') || '').trim()

    console.log('[action create] name=%s passwordLen=%d', name, password.length)

    if (!name)               return fail(400, { error: 'Episode name is required', name, password })
    if (name.length > 100)   return fail(400, { error: 'Name too long (max 100 chars)', name, password })
    if (!password)           return fail(400, { error: 'Password is required', name, password })
    if (password.length < 4) return fail(400, { error: 'Password must be at least 4 characters', name, password })

    let slug
    try {
      for (let i = 0; i < 5; i++) {
        slug = generateSlug()
        if (!getRoomBySlug(slug)) break
      }
      const passwordHash = await hashPassword(password)
      createRoom({ slug, name, passwordHash })
      console.log('[action create] room created slug=%s', slug)
    } catch (err) {
      console.error('[action create] DB error:', err)
      return fail(500, { error: 'Could not create room. Check server logs.', name, password: '' })
    }

    throw redirect(303, `/rec/${slug}`)
  }
}
