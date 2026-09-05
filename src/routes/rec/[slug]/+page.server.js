import { fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { deleteRoom, getRoomBySlug, getResearchPrompt, getResearchPromptTitle } from '$lib/server/db.js'
import { isCustomEnabled } from '$lib/home/research-prompt.js'
import { isRoomExpired } from '$lib/server/room-lifetime.js'
import { verifyPassword, makeSessionToken, verifySessionToken, getHostClaim } from '$lib/server/auth.js'

const COOKIE = (slug) => `pr_auth_${slug}`
const NAME_COOKIE = (slug) => `pr_name_${slug}`
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

// Only mark cookies secure when HTTPS is explicitly confirmed.
// Prevents silent cookie rejection during HTTP LAN / Docker testing.
function isSecure() {
  return env.HTTPS === 'true' || env.FORCE_HTTPS === 'true'
}

function isAuthenticatedForRoom(cookies, slug, room) {
  const token = cookies.get(COOKIE(slug))
  return verifySessionToken(token, slug, room.password_hash, env.SECRET)
}

export async function load({ params, cookies }) {
  const { slug } = params
  console.log('[load /rec/%s] called', slug)
  const room = getRoomBySlug(slug)

  if (!room) {
    console.log('[load /rec/%s] room not found → redirect /', slug)
    throw redirect(303, '/?notfound=1')
  }

  if (isRoomExpired(room, Date.now(), env)) {
    console.log('[load /rec/%s] room expired → redirect /', slug)
    deleteRoom(slug)
    throw redirect(303, '/?expired=1')
  }

  const token = cookies.get(COOKIE(slug))
  const authenticated = verifySessionToken(token, slug, room.password_hash, env.SECRET)
  const isHostClaim = getHostClaim(slug, cookies, room, env.SECRET)
  console.log('[load /rec/%s] authenticated=%s', slug, authenticated)

  return {
    slug,
    roomName: room.name,
    authenticated,
    participantName: cookies.get(NAME_COOKIE(slug)) || '',
    isHostClaim,
    guestCanAskResearch: !!room.guest_ai_allowed,
    customEnabled: isCustomEnabled(getResearchPrompt(), getResearchPromptTitle()),
    customTitle: getResearchPromptTitle(),
    createdAt: room.created_at,
    roomPassword: isHostClaim ? (room.password_plain || null) : null
  }
}

export const actions = {
  enter: async ({ params, request, cookies }) => {
    const { slug } = params
    console.log('[action enter] slug=%s', slug)
    const room = getRoomBySlug(slug)

    if (!room) throw redirect(303, '/')
    if (isRoomExpired(room, Date.now(), env)) {
      deleteRoom(slug)
      throw redirect(303, '/?expired=1')
    }

    const data = await request.formData()
    const password = String(data.get('room-episode-code') || '')
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
  },

  set_display_name: async ({ params, request, cookies }) => {
    const { slug } = params
    const room = getRoomBySlug(slug)
    if (!room) throw redirect(303, '/')
    if (isRoomExpired(room, Date.now(), env)) {
      deleteRoom(slug)
      throw redirect(303, '/?expired=1')
    }

    if (!isAuthenticatedForRoom(cookies, slug, room)) {
      return fail(401, { error: 'Not signed in to this room.', name: '' })
    }

    const data = await request.formData()
    const name = String(data.get('name') || '').trim().slice(0, 50)

    if (!name) {
      return fail(400, { error: 'Please enter your name.', name })
    }

    cookies.set(NAME_COOKIE(slug), name, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      secure: isSecure()
    })

    throw redirect(303, `/rec/${slug}`)
  }
}
