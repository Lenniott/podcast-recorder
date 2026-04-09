import { fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { getRoomBySlug } from '$lib/server/db.js'
import { verifyPassword, makeSessionToken, verifySessionToken, verifyHostClaimToken } from '$lib/server/auth.js'

const COOKIE = (slug) => `pr_auth_${slug}`
const HOST_COOKIE = (slug) => `pr_host_${slug}`
const NAME_COOKIE = (slug) => `pr_name_${slug}`
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days
const WAV_MIME_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'])

// Only mark cookies secure when HTTPS is explicitly confirmed.
// Prevents silent cookie rejection during HTTP LAN / Docker testing.
function isSecure() {
  return env.HTTPS === 'true' || env.FORCE_HTTPS === 'true'
}

function parseMaxUploadMb() {
  const raw = Number.parseInt(String(env.MAX_UPLOAD_MB || ''), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 400
}

function isWav(file) {
  const name = String(file?.name || '').toLowerCase()
  return name.endsWith('.wav') || WAV_MIME_TYPES.has(String(file?.type || '').toLowerCase())
}

async function hasValidWavHeader(file) {
  const chunk = await file.slice(0, 12).arrayBuffer()
  const sig = new Uint8Array(chunk)
  if (sig.length < 12) return false
  const isRiff =
    sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46 // RIFF
  const isWave =
    sig[8] === 0x57 && sig[9] === 0x41 && sig[10] === 0x56 && sig[11] === 0x45 // WAVE
  return isRiff && isWave
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

  const token = cookies.get(COOKIE(slug))
  const authenticated = verifySessionToken(token, slug, room.password_hash, env.SECRET)
  const isHostClaim = verifyHostClaimToken(cookies.get(HOST_COOKIE(slug)), slug, room.password_hash, env.SECRET)
  console.log('[load /rec/%s] authenticated=%s', slug, authenticated)

  const n8nConfigured = !!env.N8N_WEBHOOK_URL
  const showUploadRoom = Number(room.show_upload) !== 0
  const uploadSectionEnabled = n8nConfigured && showUploadRoom

  return {
    slug,
    roomName: room.name,
    authenticated,
    participantName: cookies.get(NAME_COOKIE(slug)) || '',
    n8nWebhookConfigured: n8nConfigured,
    uploadSectionEnabled,
    isHostClaim,
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
  },

  set_display_name: async ({ params, request, cookies }) => {
    const { slug } = params
    const room = getRoomBySlug(slug)
    if (!room) throw redirect(303, '/')

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
  },

  upload_guest_audio: async ({ params, request, cookies }) => {
    const { slug } = params
    const room = getRoomBySlug(slug)
    if (!room) throw redirect(303, '/')

    if (!isAuthenticatedForRoom(cookies, slug, room)) {
      return fail(401, {
        upload: { ok: false, state: 'error', message: 'Not authorised for this room.' }
      })
    }

    const webhookUrl = String(env.N8N_WEBHOOK_URL || '').trim()
    if (!webhookUrl) {
      return fail(500, {
        upload: { ok: false, state: 'error', message: 'Upload is not configured on the server.' }
      })
    }

    const formData = await request.formData()
    const file = formData.get('audio_file')
    const clientId = String(formData.get('client_id') || '').trim()
    const participantName = String(cookies.get(NAME_COOKIE(slug)) || 'Guest').trim() || 'Guest'
    const isHostClaim = verifyHostClaimToken(cookies.get(HOST_COOKIE(slug)), slug, room.password_hash, env.SECRET)
    const role = isHostClaim ? 'host' : 'guest'
    if (isHostClaim) {
      return fail(403, {
        upload: {
          ok: false,
          state: 'error',
          message: 'Only the guest (second participant) can upload.'
        }
      })
    }

    if (!(file instanceof File)) {
      return fail(400, {
        upload: { ok: false, state: 'error', message: 'Please choose a WAV file to upload.' }
      })
    }
    if (!isWav(file)) {
      return fail(400, {
        upload: { ok: false, state: 'error', message: 'Only WAV files are supported.' }
      })
    }
    if (!(await hasValidWavHeader(file))) {
      return fail(400, {
        upload: {
          ok: false,
          state: 'error',
          message: 'Invalid WAV header. Please upload a genuine WAV recording.'
        }
      })
    }

    const maxUploadMb = parseMaxUploadMb()
    const maxBytes = maxUploadMb * 1024 * 1024
    if (file.size > maxBytes) {
      return fail(413, {
        upload: {
          ok: false,
          state: 'error',
          message: `File is too large. Limit is ${maxUploadMb} MB.`
        }
      })
    }

    const forwardForm = new FormData()
    forwardForm.set('audio_file', file, file.name)
    forwardForm.set('slug', slug)
    forwardForm.set('roomName', room.name)
    forwardForm.set('uploadedBy', participantName)
    forwardForm.set('role', role)
    forwardForm.set('timestamp', new Date().toISOString())
    forwardForm.set('clientId', clientId)

    const authUser = String(env.N8N_BASIC_AUTH_USER || '').trim()
    const authPass = String(env.N8N_BASIC_AUTH_PASS || '').trim()
    const headers = {}
    if (authUser || authPass) {
      headers.Authorization = `Basic ${Buffer.from(`${authUser}:${authPass}`, 'utf8').toString('base64')}`
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: forwardForm
      })

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        const n8nAuthRejection =
          /authorization data is wrong/i.test(errBody) || response.status === 401 || response.status === 403
        const authHint = n8nAuthRejection
          ? ' Webhook Basic Auth rejected this request — set N8N_BASIC_AUTH_USER and N8N_BASIC_AUTH_PASS to match the Webhook node’s Basic Auth in n8n (same as in Production URL).'
          : ''
        console.warn('[upload_guest_audio] failed slug=%s clientId=%s role=%s file=%s bytes=%d status=%d',
          slug, clientId, role, file.name, file.size, response.status)
        return fail(502, {
          upload: {
            ok: false,
            state: 'error',
            message: `Upload failed (${response.status}).${authHint}${authHint ? '' : ' Please try again in a moment.'}`
          }
        })
      }

      return {
        upload: {
          ok: true,
          state: 'success',
          message: 'Successfully sent to the Drive workflow.'
        }
      }
    } catch (err) {
      console.warn('[upload_guest_audio] network error slug=%s clientId=%s role=%s file=%s bytes=%d',
        slug, clientId, role, file.name, file.size)
      return fail(502, {
        upload: {
          ok: false,
          state: 'error',
          message: 'Could not reach upload service. Please try again in a moment.'
        }
      })
    }
  }
}
