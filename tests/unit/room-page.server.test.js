import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import db, {
  createCustomPrompt,
  createRoom,
  getGuestLastAccess,
  getRoomBySlug,
  _resetDb
} from '../../src/lib/server/db.js'
import {
  hashPassword,
  makeHostClaimToken,
  makeSessionToken
} from '../../src/lib/server/auth.js'
import { getServerCopyRoomDir } from '../../src/lib/server/server-copy-storage.js'

const SECRET = 'test-secret-do-not-use-in-prod'
const SLUG = 'roomslug01'
const ROOM_PASS = 'room-pass'

function makeCookies(seed = {}) {
  const jar = new Map(Object.entries(seed))
  return {
    get: (name) => {
      const stored = jar.get(name)
      if (stored && typeof stored === 'object' && 'value' in stored) return stored.value
      return stored
    },
    set: (name, value, options) => jar.set(name, { value, options }),
    jar
  }
}

function formRequest(entries) {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return { formData: async () => data }
}

async function expectRedirect(fn, status, location) {
  try {
    await fn()
    throw new Error('Expected redirect')
  } catch (err) {
    if (err.message === 'Expected redirect') throw err
    expect(err.status).toBe(status)
    expect(err.location).toBe(location)
    return err
  }
}

async function loadPage() {
  return import('../../src/routes/rec/[slug]/+page.server.js')
}

async function seedRoom({ createdAt } = {}) {
  const passwordHash = await hashPassword(ROOM_PASS)
  createRoom({
    slug: SLUG,
    name: 'Test Episode',
    passwordHash,
    passwordPlain: ROOM_PASS
  })
  if (createdAt != null) {
    db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?').run(createdAt, createdAt, SLUG)
  }
  return passwordHash
}

function plantServerCopy() {
  const dir = getServerCopyRoomDir(SLUG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dummy.partial'), 'not audio')
  return dir
}

function plantServerAudio() {
  const dir = getServerCopyRoomDir(SLUG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'guest1.wav'), Buffer.from([1, 2, 3, 4]))
  return dir
}

function plantWavBytes(name, byteSize) {
  const dir = getServerCopyRoomDir(SLUG)
  mkdirSync(dir, { recursive: true })
  const fd = openSync(join(dir, name), 'w')
  try {
    writeFileSync(fd, Buffer.alloc(Math.min(44, byteSize)))
    ftruncateSync(fd, byteSize)
  } finally {
    closeSync(fd)
  }
  return dir
}

const LONG_WAV_BYTES = 44 + 48000 * 2 * 601

async function seedLockedRoom() {
  const createdAt = 1_650_000_000_000
  const guestLockAt = Date.now() - 13 * 60 * 60 * 1000
  const passwordHash = await seedRoom()
  db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?')
    .run(createdAt, guestLockAt, SLUG)
  const copyDir = plantServerAudio()
  return { passwordHash, createdAt, guestLockAt, copyDir }
}

describe('rec/[slug]/+page.server', () => {
  let serverCopyDir

  beforeEach(() => {
    if (serverCopyDir) rmSync(serverCopyDir, { recursive: true, force: true })
    serverCopyDir = join(
      tmpdir(),
      `podcast-recorder-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    process.env.DB_PATH = ':memory:'
    process.env.SECRET = SECRET
    process.env.SERVER_COPY_DIR = serverCopyDir
    process.env.ROOM_MAX_AGE_HOURS = '12'
    process.env.GUEST_LOCK_HOURS = '12'
    process.env.GUEST_LOCK_RECORDING_MINUTES = '10'
    process.env.GUEST_LOCK_INACTIVITY_HOURS = '2'
    delete process.env.HTTPS
    delete process.env.FORCE_HTTPS
    _resetDb()
  })

  afterEach(() => {
    if (serverCopyDir) rmSync(serverCopyDir, { recursive: true, force: true })
  })

  describe('load', () => {
    it('redirects missing rooms to /?notfound=1', async () => {
      const { load } = await loadPage()
      await expectRedirect(
        () => load({ params: { slug: SLUG }, cookies: makeCookies() }),
        303,
        '/?notfound=1'
      )
    })

    it('loads an old room for an unauthenticated visitor without deleting it', async () => {
      await seedRoom({ createdAt: 1000 })
      const copyDir = plantServerCopy()
      const { load } = await loadPage()
      const data = await load({ params: { slug: SLUG }, cookies: makeCookies() })
      expect(data).toMatchObject({
        slug: SLUG,
        roomName: 'Test Episode',
        authenticated: false,
        createdAt: 1000
      })
      expect(getRoomBySlug(SLUG)).toMatchObject({ slug: SLUG, created_at: 1000 })
      expect(existsSync(copyDir)).toBe(true)
    })

    it('returns unauthenticated without a session cookie', async () => {
      await seedRoom()
      const { load } = await loadPage()
      const data = await load({ params: { slug: SLUG }, cookies: makeCookies() })
      expect(data).toMatchObject({
        slug: SLUG,
        roomName: 'Test Episode',
        authenticated: false,
        isHostClaim: false,
        participantName: '',
        roomPassword: null
      })
    })

    it('returns authenticated with a valid session cookie', async () => {
      const passwordHash = await seedRoom()
      const { load } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET),
        [`pr_name_${SLUG}`]: 'Alex'
      })
      const data = await load({ params: { slug: SLUG }, cookies })
      expect(data.authenticated).toBe(true)
      expect(data.participantName).toBe('Alex')
      expect(data.roomPassword).toBeNull()
    })

    it('exposes the room password only for a valid host claim', async () => {
      const passwordHash = await seedRoom()
      const { load } = await loadPage()
      const cookies = makeCookies({
        [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET)
      })
      const data = await load({ params: { slug: SLUG }, cookies })
      expect(data.isHostClaim).toBe(true)
      expect(data.roomPassword).toBe(ROOM_PASS)
    })

    it('rejects a forged/invalid host cookie — no host claim, no exposed password', async () => {
      await seedRoom()
      const { load } = await loadPage()
      const cookies = makeCookies({
        [`pr_host_${SLUG}`]: 'not-a-real-host-token'
      })
      const data = await load({ params: { slug: SLUG }, cookies })
      expect(data.isHostClaim).toBe(false)
      expect(data.roomPassword).toBeNull()
    })

    it('rejects a host-claim token minted for a different room', async () => {
      await seedRoom()
      const { load } = await loadPage()
      const cookies = makeCookies({
        // Valid-shaped token, but for a password hash that doesn't match this room.
        [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, '$2a$10$someotherroomshash', SECRET)
      })
      const data = await load({ params: { slug: SLUG }, cookies })
      expect(data.isHostClaim).toBe(false)
      expect(data.roomPassword).toBeNull()
    })

    // ADR-0008, ticket 05: every configured Custom Prompt becomes its own
    // one-click button in the selection popup, so the page has to ship the
    // whole list — but only id + title (+ usesSelection).
    it('ships every configured Custom Prompt as id + title + usesSelection, never the template text', async () => {
      const passwordHash = await seedRoom()
      const { load } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET)
      })

      expect((await load({ params: { slug: SLUG }, cookies })).customPrompts).toEqual([])

      createCustomPrompt({ title: 'Fact check', prompt: 'Fact-check {selection}.' })
      createCustomPrompt({ title: 'Daily recap', prompt: 'Summarize {transcript} so far.' })

      const data = await load({ params: { slug: SLUG }, cookies })
      expect(data.customPrompts.map((p) => p.title)).toEqual(['Fact check', 'Daily recap'])
      expect(data.customPrompts.every((p) => typeof p.id === 'string' && p.id)).toBe(true)
      // usesSelection is what the room's clients use to split a prompt
      // between the highlight popup and a standalone panel button.
      expect(data.customPrompts.map((p) => p.usesSelection)).toEqual([true, false])
      // The show's prompt wording stays on the server — the browser only
      // ever names a prompt by id (see ws-rooms.js's annotation_ask).
      expect(JSON.stringify(data.customPrompts)).not.toContain('Fact-check {selection}')
      expect(data.customPrompts.some((p) => 'prompt' in p)).toBe(false)
    })

    it('redirects a guest away from a time-locked room and keeps the row', async () => {
      const { createdAt, guestLockAt, copyDir } = await seedLockedRoom()
      const { load } = await loadPage()
      await expectRedirect(
        () => load({ params: { slug: SLUG }, cookies: makeCookies() }),
        303,
        '/?guestlocked=1'
      )
      expect(getRoomBySlug(SLUG)).toMatchObject({
        slug: SLUG,
        created_at: createdAt,
        guest_lock_at: guestLockAt
      })
      expect(existsSync(copyDir)).toBe(true)
    })

    it('loads a locked room for a host claim and does not delete it', async () => {
      const { passwordHash, createdAt, guestLockAt, copyDir } = await seedLockedRoom()
      const { load } = await loadPage()
      const cookies = makeCookies({
        [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET)
      })
      const data = await load({ params: { slug: SLUG }, cookies })
      expect(data).toMatchObject({
        slug: SLUG,
        roomName: 'Test Episode',
        isHostClaim: true,
        roomPassword: ROOM_PASS,
        createdAt
      })
      expect(getRoomBySlug(SLUG)).toMatchObject({
        slug: SLUG,
        created_at: createdAt,
        guest_lock_at: guestLockAt
      })
      expect(existsSync(copyDir)).toBe(true)
    })

    it('lets a guest load a room with server audio while the clock is still inside the window', async () => {
      await seedRoom()
      db.getDb().prepare('UPDATE rooms SET guest_lock_at = ? WHERE slug = ?')
        .run(Date.now() - 60 * 60 * 1000, SLUG)
      plantServerAudio()
      const { load } = await loadPage()
      const data = await load({ params: { slug: SLUG }, cookies: makeCookies() })
      expect(data.slug).toBe(SLUG)
      expect(data.isHostClaim).toBe(false)
      expect(getRoomBySlug(SLUG)?.slug).toBe(SLUG)
    })

    it('redirects an authenticated guest with a long copy and no last access', async () => {
      const passwordHash = await seedRoom()
      plantWavBytes('longguest01.wav', LONG_WAV_BYTES)
      const { load } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET),
        [`pr_client_${SLUG}`]: 'longguest01'
      })
      await expectRedirect(
        () => load({ params: { slug: SLUG }, cookies }),
        303,
        '/?guestlocked=1'
      )
      expect(getGuestLastAccess(SLUG, 'longguest01')).toBeNull()
      expect(getRoomBySlug(SLUG)?.slug).toBe(SLUG)
    })

    it('records last access when an authenticated guest with a client cookie loads', async () => {
      const passwordHash = await seedRoom()
      plantWavBytes('shortguest1.wav', 300)
      const { load } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET),
        [`pr_client_${SLUG}`]: 'shortguest1'
      })
      const data = await load({ params: { slug: SLUG }, cookies })
      expect(data.authenticated).toBe(true)
      expect(data.slug).toBe(SLUG)
      expect(getGuestLastAccess(SLUG, 'shortguest1')).toEqual(expect.any(Number))
    })

    it('ships no Custom Prompts to someone who has not passed the room password', async () => {
      await seedRoom()
      createCustomPrompt({ title: 'Fact check', prompt: 'Fact-check {selection}.' })
      const { load } = await loadPage()
      const data = await load({ params: { slug: SLUG }, cookies: makeCookies() })
      expect(data.authenticated).toBe(false)
      expect(data.customPrompts).toEqual([])
    })
  })

  describe('actions.enter', () => {
    it('redirects missing rooms to /', async () => {
      const { actions } = await loadPage()
      await expectRedirect(
        () => actions.enter({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex', 'room-episode-code': ROOM_PASS }),
          cookies: makeCookies()
        }),
        303,
        '/'
      )
    })

    it('lets someone enter an old room without deleting it', async () => {
      await seedRoom({ createdAt: 1000 })
      const copyDir = plantServerCopy()
      const { actions } = await loadPage()
      await expectRedirect(
        () => actions.enter({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex', 'room-episode-code': ROOM_PASS }),
          cookies: makeCookies()
        }),
        303,
        `/rec/${SLUG}`
      )
      expect(getRoomBySlug(SLUG)).toMatchObject({ slug: SLUG, created_at: 1000 })
      expect(existsSync(copyDir)).toBe(true)
    })

    it('requires a name', async () => {
      await seedRoom()
      const { actions } = await loadPage()
      const result = await actions.enter({
        params: { slug: SLUG },
        request: formRequest({ name: '  ', 'room-episode-code': ROOM_PASS }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 400,
        data: { error: 'Please enter your name.', values: { name: '' } }
      })
    })

    it('rejects the wrong password', async () => {
      await seedRoom()
      const { actions } = await loadPage()
      const result = await actions.enter({
        params: { slug: SLUG },
        request: formRequest({ name: 'Alex', 'room-episode-code': 'wrong' }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 403,
        data: { error: 'Wrong password. Try again.', values: { name: 'Alex' } }
      })
    })

    it('redirects enter as a guest on a locked room and does not set the session cookie', async () => {
      const { createdAt, guestLockAt, copyDir } = await seedLockedRoom()
      const { actions } = await loadPage()
      const cookies = makeCookies()
      await expectRedirect(
        () => actions.enter({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex', 'room-episode-code': ROOM_PASS }),
          cookies
        }),
        303,
        '/?guestlocked=1'
      )
      expect(cookies.jar.has(`pr_auth_${SLUG}`)).toBe(false)
      expect(cookies.jar.has(`pr_name_${SLUG}`)).toBe(false)
      expect(getRoomBySlug(SLUG)).toMatchObject({
        slug: SLUG,
        created_at: createdAt,
        guest_lock_at: guestLockAt
      })
      expect(existsSync(copyDir)).toBe(true)
    })

    it('redirects enter when that clientId has a long copy and no last access, without a session cookie', async () => {
      await seedRoom()
      plantWavBytes('longguest01.wav', LONG_WAV_BYTES)
      const { actions } = await loadPage()
      const cookies = makeCookies()
      await expectRedirect(
        () => actions.enter({
          params: { slug: SLUG },
          request: formRequest({
            name: 'Alex',
            'room-episode-code': ROOM_PASS,
            clientId: 'longguest01'
          }),
          cookies
        }),
        303,
        '/?guestlocked=1'
      )
      expect(cookies.jar.has(`pr_auth_${SLUG}`)).toBe(false)
      expect(cookies.jar.has(`pr_name_${SLUG}`)).toBe(false)
      expect(cookies.jar.has(`pr_client_${SLUG}`)).toBe(false)
      expect(getGuestLastAccess(SLUG, 'longguest01')).toBeNull()
      expect(getRoomBySlug(SLUG)?.slug).toBe(SLUG)
    })

    it('lets a guest enter when that clientId has a short copy and records access', async () => {
      await seedRoom()
      plantWavBytes('shortguest1.wav', 300)
      const { actions } = await loadPage()
      const cookies = makeCookies()
      await expectRedirect(
        () => actions.enter({
          params: { slug: SLUG },
          request: formRequest({
            name: 'Alex',
            'room-episode-code': ROOM_PASS,
            clientId: 'shortguest1'
          }),
          cookies
        }),
        303,
        `/rec/${SLUG}`
      )
      expect(cookies.jar.get(`pr_auth_${SLUG}`).value).toHaveLength(64)
      const client = cookies.jar.get(`pr_client_${SLUG}`)
      expect(client.value).toBe('shortguest1')
      expect(client.options).toMatchObject({
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
        secure: false
      })
      expect(getGuestLastAccess(SLUG, 'shortguest1')).toEqual(expect.any(Number))
    })

    it('lets a host claim enter when a clientId has a long copy and no last access', async () => {
      const passwordHash = await seedRoom()
      plantWavBytes('longguest01.wav', LONG_WAV_BYTES)
      const { actions } = await loadPage()
      const cookies = makeCookies({
        [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET)
      })
      await expectRedirect(
        () => actions.enter({
          params: { slug: SLUG },
          request: formRequest({
            name: 'Alex',
            'room-episode-code': ROOM_PASS,
            clientId: 'longguest01'
          }),
          cookies
        }),
        303,
        `/rec/${SLUG}`
      )
      expect(cookies.jar.get(`pr_auth_${SLUG}`).value).toHaveLength(64)
      expect(getRoomBySlug(SLUG)?.slug).toBe(SLUG)
    })

    it('lets a host claim enter a locked room', async () => {
      const { passwordHash, createdAt } = await seedLockedRoom()
      const { actions } = await loadPage()
      const cookies = makeCookies({
        [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET)
      })
      await expectRedirect(
        () => actions.enter({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex', 'room-episode-code': ROOM_PASS }),
          cookies
        }),
        303,
        `/rec/${SLUG}`
      )
      expect(cookies.jar.get(`pr_auth_${SLUG}`).value).toHaveLength(64)
      expect(getRoomBySlug(SLUG)).toMatchObject({ slug: SLUG, created_at: createdAt })
    })

    it('sets session and name cookies then redirects', async () => {
      process.env.HTTPS = 'true'
      await seedRoom()
      const { actions } = await loadPage()
      const cookies = makeCookies()
      await expectRedirect(
        () => actions.enter({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex', 'room-episode-code': ROOM_PASS }),
          cookies
        }),
        303,
        `/rec/${SLUG}`
      )
      const auth = cookies.jar.get(`pr_auth_${SLUG}`)
      const name = cookies.jar.get(`pr_name_${SLUG}`)
      expect(auth.value).toHaveLength(64)
      expect(auth.options).toMatchObject({
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
        secure: true
      })
      expect(name.value).toBe('Alex')
      expect(name.options).toMatchObject({
        httpOnly: false,
        secure: true
      })
    })
  })

  describe('actions.set_display_name', () => {
    it('redirects missing rooms to /', async () => {
      const { actions } = await loadPage()
      await expectRedirect(
        () => actions.set_display_name({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex' }),
          cookies: makeCookies()
        }),
        303,
        '/'
      )
    })

    it('sets a display name on an old room without deleting it', async () => {
      const passwordHash = await seedRoom({ createdAt: 1000 })
      const { actions } = await loadPage()
      const anon = await actions.set_display_name({
        params: { slug: SLUG },
        request: formRequest({ name: 'Alex' }),
        cookies: makeCookies()
      })
      expect(anon).toMatchObject({
        status: 401,
        data: { error: 'Not signed in to this room.', name: '' }
      })
      expect(getRoomBySlug(SLUG)).toMatchObject({ slug: SLUG, created_at: 1000 })

      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET)
      })
      await expectRedirect(
        () => actions.set_display_name({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex' }),
          cookies
        }),
        303,
        `/rec/${SLUG}`
      )
      expect(getRoomBySlug(SLUG)).toMatchObject({ slug: SLUG, created_at: 1000 })
      expect(cookies.jar.get(`pr_name_${SLUG}`).value).toBe('Alex')
    })

    it('redirects set_display_name for a guest on a locked room', async () => {
      const { passwordHash, createdAt } = await seedLockedRoom()
      const { actions } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET)
      })
      await expectRedirect(
        () => actions.set_display_name({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex' }),
          cookies
        }),
        303,
        '/?guestlocked=1'
      )
      expect(cookies.jar.has(`pr_name_${SLUG}`)).toBe(false)
      expect(getRoomBySlug(SLUG)).toMatchObject({ slug: SLUG, created_at: createdAt })
    })

    it('redirects set_display_name when the client cookie is inactivity-locked', async () => {
      const passwordHash = await seedRoom()
      plantWavBytes('longguest01.wav', LONG_WAV_BYTES)
      const { actions } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET),
        [`pr_client_${SLUG}`]: 'longguest01'
      })
      await expectRedirect(
        () => actions.set_display_name({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex' }),
          cookies
        }),
        303,
        '/?guestlocked=1'
      )
      expect(cookies.jar.has(`pr_name_${SLUG}`)).toBe(false)
      expect(getGuestLastAccess(SLUG, 'longguest01')).toBeNull()
      expect(getRoomBySlug(SLUG)?.slug).toBe(SLUG)
    })

    it('rejects unauthenticated requests', async () => {
      await seedRoom()
      const { actions } = await loadPage()
      const result = await actions.set_display_name({
        params: { slug: SLUG },
        request: formRequest({ name: 'Alex' }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 401,
        data: { error: 'Not signed in to this room.', name: '' }
      })
    })

    it('rejects an empty name', async () => {
      const passwordHash = await seedRoom()
      const { actions } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET)
      })
      const result = await actions.set_display_name({
        params: { slug: SLUG },
        request: formRequest({ name: '   ' }),
        cookies
      })
      expect(result).toMatchObject({
        status: 400,
        data: { error: 'Please enter your name.', name: '' }
      })
    })

    it('sets the name cookie and redirects when authenticated', async () => {
      const passwordHash = await seedRoom()
      const { actions } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET)
      })
      await expectRedirect(
        () => actions.set_display_name({
          params: { slug: SLUG },
          request: formRequest({ name: 'Jamie' }),
          cookies
        }),
        303,
        `/rec/${SLUG}`
      )
      const name = cookies.jar.get(`pr_name_${SLUG}`)
      expect(name.value).toBe('Jamie')
      expect(name.options).toMatchObject({
        httpOnly: false,
        sameSite: 'lax',
        path: '/'
      })
    })
  })
})
