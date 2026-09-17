import { fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import {
  createRoom,
  getRoomBySlug,
  listCustomPrompts,
  createCustomPrompt,
  updateCustomPrompt,
  deleteCustomPrompt
} from '$lib/server/db.js'
import { validateCustomPrompt, normalizeOutputFormat } from '$lib/home/custom-prompts.js'
import { getUsageDashboard } from '$lib/server/usage-dashboard.js'
import { hashPassword, generateSlug, makeSessionToken, makeHostClaimToken, makePasswordToken, verifyPasswordToken } from '$lib/server/auth.js'
import { resolveRole, SITE_COOKIE, FRIEND_COOKIE } from '$lib/server/role.js'

const ROOM_COOKIE = (slug) => `pr_auth_${slug}`
const HOST_COOKIE = (slug) => `pr_host_${slug}`

// Cookie is only marked secure if we're explicitly told HTTPS is in use.
// Avoids cookie being silently rejected during HTTP-only LAN/Docker testing.
function isSecure() {
  return env.HTTPS === 'true' || env.FORCE_HTTPS === 'true'
}

async function readCustomPromptForm(request) {
  const data = await request.formData()
  return {
    id: String(data.get('custom-prompt-id') || '').trim(),
    title: String(data.get('custom-prompt-title') || '').trim(),
    prompt: String(data.get('custom-prompt-text') || ''),
    // normalizeOutputFormat backstops a tampered/missing field the same way
    // it backstops an old DB row — never trust a form post's value blindly.
    outputFormat: normalizeOutputFormat(data.get('custom-prompt-output-format'))
  }
}

export async function load({ cookies, url }) {
  // role.js is the single source of truth for "what role does this request
  // have" — 'host', 'friend', or null. `siteAuthed` keeps its original
  // meaning (a Host session) so nothing about Host behavior/shape changes;
  // `role`/`friendProtected` are new, additive fields the template uses to
  // show a Friend the create-room page without the dashboard.
  const role = resolveRole(cookies, env)
  const siteAuthed = role === 'host'
  console.log('[load /] siteProtected=%s siteAuthed=%s role=%s', !!env.SITE_PASSWORD, siteAuthed, role)
  return {
    siteAuthed,
    siteProtected: !!env.SITE_PASSWORD,
    friendProtected: !!env.FRIEND_PASSWORD,
    role,
    notFound: url.searchParams.has('notfound'),
    expired: url.searchParams.has('expired'),
    // Usage Dashboard (see CONTEXT.md) and Custom Prompts are deployment-wide
    // Host-only config — gated on role === 'host', never reachable by a
    // Friend session (same failure mode as no session at all). Only
    // computed once past that gate: it's a handful of DB/filesystem reads
    // per room and has no reason to run for an unauthenticated/Friend hit.
    customPrompts: siteAuthed ? listCustomPrompts() : [],
    usageDashboard: siteAuthed ? getUsageDashboard(env) : null
  }
}

export const actions = {
  site_enter: async ({ request, cookies }) => {
    console.log('[action site_enter] called')
    const data     = await request.formData()
    const password = String(data.get('password') || '').trim()

    const provided = makePasswordToken('site', password, env.SECRET)
    if (!verifyPasswordToken('site', env.SITE_PASSWORD, provided, env.SECRET)) {
      return fail(403, { siteError: 'Wrong password.' })
    }

    console.log('[action site_enter] correct — setting cookie (secure=%s)', isSecure())
    cookies.set(SITE_COOKIE, makePasswordToken('site', env.SITE_PASSWORD, env.SECRET), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 3,
      secure: isSecure()
    })

    throw redirect(303, '/')
  },

  // Friend login (friend-password-auth, ticket 02) — a second, weaker,
  // separate-cookie login on this same entry page, gated by its own
  // FRIEND_PASSWORD. Unlike site_enter above, an unset FRIEND_PASSWORD
  // means this action can never succeed (see role.js) rather than being
  // open access — there is deliberately no way to become a Friend until an
  // operator opts in.
  friend_enter: async ({ request, cookies }) => {
    console.log('[action friend_enter] called')
    const data     = await request.formData()
    const password = String(data.get('password') || '').trim()

    if (!env.FRIEND_PASSWORD) {
      return fail(403, { friendError: 'Friend login is not enabled.' })
    }

    const provided = makePasswordToken('friend', password, env.SECRET)
    if (!verifyPasswordToken('friend', env.FRIEND_PASSWORD, provided, env.SECRET)) {
      return fail(403, { friendError: 'Wrong password.' })
    }

    console.log('[action friend_enter] correct — setting cookie (secure=%s)', isSecure())
    cookies.set(FRIEND_COOKIE, makePasswordToken('friend', env.FRIEND_PASSWORD, env.SECRET), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 3,
      secure: isSecure()
    })

    throw redirect(303, '/')
  },

  // Custom Prompt CRUD (see CONTEXT.md) — deployment-wide, gated to Host
  // sessions only (role.js), exactly like the single Research Prompt these
  // three replaced. A Friend session gets the same "Not authorised." outcome
  // as no session at all — this config isn't per-room or reachable from
  // inside a room either: a Host can't edit these mid-show (ADR-0008).
  create_custom_prompt: async ({ request, cookies }) => {
    if (resolveRole(cookies, env) !== 'host') return fail(403, { promptError: 'Not authorised.', promptErrorId: 'new' })
    const { title, prompt, outputFormat } = await readCustomPromptForm(request)
    const promptError = validateCustomPrompt({ title, prompt })
    if (promptError) {
      // Hand the draft back so a rejected title doesn't discard the template.
      return fail(400, { promptError, promptErrorId: 'new', draftTitle: title, draftPrompt: prompt, draftOutputFormat: outputFormat })
    }
    createCustomPrompt({ title, prompt, outputFormat })
    throw redirect(303, '/')
  },

  update_custom_prompt: async ({ request, cookies }) => {
    if (resolveRole(cookies, env) !== 'host') return fail(403, { promptError: 'Not authorised.' })
    const { id, title, prompt, outputFormat } = await readCustomPromptForm(request)
    if (!id) return fail(400, { promptError: 'Unknown Custom Prompt.' })
    const promptError = validateCustomPrompt({ title, prompt })
    if (promptError) return fail(400, { promptError, promptErrorId: id })
    if (!updateCustomPrompt(id, { title, prompt, outputFormat })) {
      return fail(404, { promptError: 'That Custom Prompt no longer exists.', promptErrorId: id })
    }
    throw redirect(303, '/')
  },

  delete_custom_prompt: async ({ request, cookies }) => {
    if (resolveRole(cookies, env) !== 'host') return fail(403, { promptError: 'Not authorised.' })
    const { id } = await readCustomPromptForm(request)
    if (!id) return fail(400, { promptError: 'Unknown Custom Prompt.' })
    deleteCustomPrompt(id)
    throw redirect(303, '/')
  },

  create: async ({ request, cookies }) => {
    console.log('[action create] called')

    // Either role may create a room — a Friend reaches this exact same
    // action a Host does. Everything that differs (AI, the friend_room
    // flag) is decided below from `role`, never from anything posted.
    const role = resolveRole(cookies, env)
    if (!role) {
      console.log('[action create] not authorised (no role)')
      return fail(403, { siteError: 'Not authorised.' })
    }
    const friendRoom = role === 'friend'

    const data            = await request.formData()
    const name            = String(data.get('room-episode-name') || '').trim()
    const password        = String(data.get('room-episode-code') || '').trim()
    // A Friend room's AI is unconditionally off — the server decides this
    // from `role`, ignoring whatever a posted `guest-ai-allowed` field says
    // (tampering with the form cannot turn it on; see TDD seam 2). The
    // field is only ever read at all for a Host session.
    const guestAiAllowed  = friendRoom ? false : data.get('guest-ai-allowed') === 'on'

    console.log('[action create] name=%s passwordLen=%d guestAiAllowed=%s friendRoom=%s', name, password.length, guestAiAllowed, friendRoom)

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
      createRoom({ slug, name, passwordHash, passwordPlain: password, guestAiAllowed, friendRoom })
      const roomToken = makeSessionToken(slug, passwordHash, env.SECRET)
      const hostToken = makeHostClaimToken(slug, passwordHash, env.SECRET)
      cookies.set(ROOM_COOKIE(slug), roomToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
        secure: isSecure()
      })
      cookies.set(HOST_COOKIE(slug), hostToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
        secure: isSecure()
      })
      console.log('[action create] room created slug=%s', slug)
    } catch (err) {
      console.error('[action create] DB error:', err)
      return fail(500, { error: 'Could not create room. Check server logs.', name, password: '' })
    }

    throw redirect(303, `/rec/${slug}`)
  }
}
