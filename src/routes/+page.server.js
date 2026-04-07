import { fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { createRoom, getRoomBySlug } from '$lib/server/db.js'
import { hashPassword, generateSlug } from '$lib/server/auth.js'
import { createHmac, timingSafeEqual } from 'crypto'

const SITE_COOKIE = 'pr_site_auth'

function makeSiteToken() {
  const secret   = env.SECRET        || 'dev-secret-change-me'
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
  return { siteAuthed, siteProtected: !!env.SITE_PASSWORD }
}

export const actions = {
  site_enter: async ({ request, cookies }) => {
    const data     = await request.formData()
    const password = String(data.get('password') || '').trim()

    if (password !== env.SITE_PASSWORD) {
      return fail(403, { siteError: 'Wrong password.' })
    }

    cookies.set(SITE_COOKIE, makeSiteToken(), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      secure: env.NODE_ENV === 'production'
    })

    throw redirect(303, '/')
  },

  create: async ({ request, cookies }) => {
    if (env.SITE_PASSWORD && !verifySiteToken(cookies.get(SITE_COOKIE))) {
      return fail(403, { siteError: 'Not authorised.' })
    }

    const data     = await request.formData()
    const name     = String(data.get('name') || '').trim()
    const password = String(data.get('password') || '').trim()

    if (!name)               return fail(400, { error: 'Episode name is required', name, password })
    if (name.length > 100)   return fail(400, { error: 'Name too long (max 100 chars)', name, password })
    if (!password)           return fail(400, { error: 'Password is required', name, password })
    if (password.length < 4) return fail(400, { error: 'Password must be at least 4 characters', name, password })

    let slug
    for (let i = 0; i < 5; i++) {
      slug = generateSlug()
      if (!getRoomBySlug(slug)) break
    }

    const passwordHash = await hashPassword(password)
    createRoom({ slug, name, passwordHash })

    throw redirect(303, `/rec/${slug}`)
  }
}
