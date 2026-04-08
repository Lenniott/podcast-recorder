import { fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { getRoomBySlug } from '$lib/server/db.js'
import { verifyPassword, makeSessionToken, verifySessionToken } from '$lib/server/auth.js'

const COOKIE = (slug) => `pr_auth_${slug}`
const NAME_COOKIE = (slug) => `pr_name_${slug}`
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

// Only mark cookies secure when HTTPS is explicitly confirmed.
// Prevents silent cookie rejection during HTTP LAN / Docker testing.
function isSecure() {
  return env.HTTPS === 'true' || env.FORCE_HTTPS === 'true'
}

export async function load({ params, cookies }) {
  const { slug } = params
  console.log('[load /rec/%s] called', slug)
  const room = getRoomBySlug(slug)

  if (!room) {
    console.log('[load /rec/%s] room not found → redirect /', slug)
    throw redirect(303, '/?notfound=1')
  }

  const token = cookies.get(COOKIE(slug))
  const authenticated = verifySessionToken(token, slug, room.password_hash, env.SECRET)
  console.log('[load /rec/%s] authenticated=%s', slug, authenticated)

  return {
    slug,
    roomName: room.name,
    authenticated,
    participantName: cookies.get(NAME_COOKIE(slug)) || '',
    createdAt: room.created_at
  }
}

export const actions = {
  enter: async ({ params, request, cookies }) => {
    const { slug } = params
    console.log('[action enter] slug=%s', slug)
    const room = getRoomBySlug(slug)

    if (!room) throw redirect(303, '/')

    const data = await request.formData()
    const password = String(data.get('password') || '')
    const name = String(data.get('name') || '').trim().slice(0, 50)

    if (!name) {
      return fail(400, { error: 'Please enter your name.', values: { name } })
    }

    const valid = await verifyPassword(password, room.password_hash)
    if (!valid) {
      return fail(403, { error: 'Wrong password. Try again.', values: { name } })
    }

    const token = makeSessionToken(slug, room.password_hash, env.SECRET)
    cookies.set(COOKIE(slug), token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      secure: isSecure()
    })
    cookies.set(NAME_COOKIE(slug), name, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      secure: isSecure()
    })
    console.log('[action enter] cookie set (secure=%s) → redirect', isSecure())

    throw redirect(303, `/rec/${slug}`)
  }
}
