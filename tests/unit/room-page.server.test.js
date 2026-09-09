import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import db, {
  createCustomPrompt,
  createRoom,
  getRoomBySlug,
  updateCustomPrompt,
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
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(createdAt, SLUG)
  }
  return passwordHash
}

function plantServerCopy() {
  const dir = getServerCopyRoomDir(SLUG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dummy.partial'), 'not audio')
  return dir
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

    it('deletes an expired room and its server copies, then redirects', async () => {
      await seedRoom({ createdAt: 1000 })
      const copyDir = plantServerCopy()
      const { load } = await loadPage()
      await expectRedirect(
        () => load({ params: { slug: SLUG }, cookies: makeCookies() }),
        303,
        '/?expired=1'
      )
      expect(getRoomBySlug(SLUG)).toBeNull()
      expect(existsSync(copyDir)).toBe(false)
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

    // The room's single Custom button runs the first Custom Prompt in the
    // list until ticket 05 lets a highlight pick one by id, and ticket 07
    // retires the button entirely.
    it('keeps Custom off until a usable Custom Prompt exists, then runs the first one', async () => {
      await seedRoom()
      const { load } = await loadPage()
      const empty = await load({ params: { slug: SLUG }, cookies: makeCookies() })
      expect(empty.customEnabled).toBe(false)
      expect(empty.customTitle).toBe('')

      const created = createCustomPrompt({ title: 'Interpret', prompt: 'Read {current_tab}.' })
      const configured = await load({ params: { slug: SLUG }, cookies: makeCookies() })
      expect(configured.customEnabled).toBe(true)
      expect(configured.customTitle).toBe('Interpret')

      updateCustomPrompt(created.id, { title: 'Interpret', prompt: '   ' })
      const blankTemplate = await load({ params: { slug: SLUG }, cookies: makeCookies() })
      expect(blankTemplate.customEnabled).toBe(false)
    })

    // ADR-0008, ticket 05: every configured Custom Prompt becomes its own
    // one-click button in the selection popup, so the page has to ship the
    // whole list — but only id + title.
    it('ships every configured Custom Prompt as id + title, never the template text', async () => {
      const passwordHash = await seedRoom()
      const { load } = await loadPage()
      const cookies = makeCookies({
        [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET)
      })

      expect((await load({ params: { slug: SLUG }, cookies })).customPrompts).toEqual([])

      createCustomPrompt({ title: 'Fact check', prompt: 'Fact-check {selection}.' })
      createCustomPrompt({ title: 'Define it', prompt: 'Define {selection}.' })

      const data = await load({ params: { slug: SLUG }, cookies })
      expect(data.customPrompts.map((p) => p.title)).toEqual(['Fact check', 'Define it'])
      expect(data.customPrompts.every((p) => typeof p.id === 'string' && p.id)).toBe(true)
      // The show's prompt wording stays on the server — the browser only
      // ever names a prompt by id (see ws-rooms.js's annotation_ask).
      expect(JSON.stringify(data.customPrompts)).not.toContain('Fact-check {selection}')
      expect(data.customPrompts.some((p) => 'prompt' in p)).toBe(false)
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

    it('expires the room and removes server copies', async () => {
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
        '/?expired=1'
      )
      expect(getRoomBySlug(SLUG)).toBeNull()
      expect(existsSync(copyDir)).toBe(false)
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

    it('redirects expired rooms to /?expired=1', async () => {
      await seedRoom({ createdAt: 1000 })
      const { actions } = await loadPage()
      await expectRedirect(
        () => actions.set_display_name({
          params: { slug: SLUG },
          request: formRequest({ name: 'Alex' }),
          cookies: makeCookies()
        }),
        303,
        '/?expired=1'
      )
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
