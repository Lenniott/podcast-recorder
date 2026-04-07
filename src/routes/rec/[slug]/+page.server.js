import { fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { getRoomBySlug } from '$lib/server/db.js'
import { verifyPassword, makeSessionToken, verifySessionToken } from '$lib/server/auth.js'

const COOKIE = (slug) => `pr_auth_${slug}`
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

export async function load({ params, cookies }) {
  const { slug } = params
  const room = getRoomBySlug(slug)

  if (!room) {
    throw redirect(303, '/?notfound=1')
  }

  const secret = env.SECRET || 'dev-secret-change-me'
  const token = cookies.get(COOKIE(slug))
  const authenticated = verifySessionToken(token, slug, room.password_hash, secret)

  return {
    slug,
    roomName: room.name,
    authenticated,
    createdAt: room.created_at
  }
}

export const actions = {
  enter: async ({ params, request, cookies }) => {
    const { slug } = params
    const room = getRoomBySlug(slug)

    if (!room) throw redirect(303, '/')

    const data = await request.formData()
    const password = String(data.get('password') || '')

    const valid = await verifyPassword(password, room.password_hash)
    if (!valid) {
      return fail(403, { error: 'Wrong password. Try again.' })
    }

    const secret = env.SECRET || 'dev-secret-change-me'
    const token = makeSessionToken(slug, room.password_hash, secret)
    cookies.set(COOKIE(slug), token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      secure: env.NODE_ENV === 'production'
    })

    throw redirect(303, `/rec/${slug}`)
  }
}
