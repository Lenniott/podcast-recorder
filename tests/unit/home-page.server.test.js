import { createHmac } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import db, { getRoomBySlug, _resetDb } from '../../src/lib/server/db.js'
import * as roomsDb from '../../src/lib/server/db.js'

const SECRET = 'test-secret-do-not-use-in-prod'
const SITE_PASSWORD = 'gate-pass'

function siteToken(password = SITE_PASSWORD) {
  return createHmac('sha256', SECRET).update('site:' + password).digest('hex')
}

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
    if (typeof location === 'string') expect(err.location).toBe(location)
    else expect(err.location).toMatch(location)
    return err
  }
}

async function loadPage() {
  return import('../../src/routes/+page.server.js')
}

describe('+page.server', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:'
    process.env.SECRET = SECRET
    delete process.env.SITE_PASSWORD
    delete process.env.HTTPS
    delete process.env.FORCE_HTTPS
    _resetDb()
  })

  describe('load', () => {
    it('reports open access when SITE_PASSWORD is unset', async () => {
      const { load } = await loadPage()
      const cookies = makeCookies()
      const data = await load({ cookies, url: new URL('http://test/') })
      expect(data).toEqual({
        siteAuthed: true,
        siteProtected: false,
        notFound: false,
        expired: false,
        researchPrompt: '',
        researchPromptTitle: '',
        usageDashboard: { totals: { calls: 0, tokens: 0, cost: 0 }, rooms: [] }
      })
    })

    it('reports unauthenticated when the site cookie is missing', async () => {
      process.env.SITE_PASSWORD = SITE_PASSWORD
      const { load } = await loadPage()
      const data = await load({
        cookies: makeCookies(),
        url: new URL('http://test/')
      })
      expect(data.siteAuthed).toBe(false)
      expect(data.siteProtected).toBe(true)
    })

    it('maps ?notfound=1 and ?expired=1', async () => {
      const { load } = await loadPage()
      const cookies = makeCookies()
      const notFound = await load({
        cookies,
        url: new URL('http://test/?notfound=1')
      })
      const expired = await load({
        cookies,
        url: new URL('http://test/?expired=1')
      })
      expect(notFound.notFound).toBe(true)
      expect(expired.expired).toBe(true)
    })
  })

  describe('actions.site_enter', () => {
    it('rejects the wrong password', async () => {
      process.env.SITE_PASSWORD = SITE_PASSWORD
      const { actions } = await loadPage()
      const result = await actions.site_enter({
        request: formRequest({ password: 'nope' }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 403,
        data: { siteError: 'Wrong password.' }
      })
    })

    it('sets the site cookie and redirects on the correct password', async () => {
      process.env.SITE_PASSWORD = SITE_PASSWORD
      process.env.HTTPS = 'true'
      const { actions } = await loadPage()
      const cookies = makeCookies()
      const err = await expectRedirect(
        () => actions.site_enter({
          request: formRequest({ password: SITE_PASSWORD }),
          cookies
        }),
        303,
        '/'
      )
      expect(err.location).toBe('/')
      const stored = cookies.jar.get('pr_site_auth')
      expect(stored.value).toBe(siteToken())
      expect(stored.options).toMatchObject({
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 3,
        secure: true
      })
    })
  })

  describe('actions.create', () => {
    it('rejects create when the site is locked and there is no site cookie', async () => {
      process.env.SITE_PASSWORD = SITE_PASSWORD
      const { actions } = await loadPage()
      const result = await actions.create({
        request: formRequest({
          'room-episode-name': 'Ep',
          'room-episode-code': 'pass'
        }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 403,
        data: { siteError: 'Not authorised.' }
      })
    })

    it('requires an episode name', async () => {
      const { actions } = await loadPage()
      const result = await actions.create({
        request: formRequest({
          'room-episode-name': '  ',
          'room-episode-code': 'pass'
        }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 400,
        data: { error: 'Episode name is required' }
      })
    })

    it('rejects a name over 100 characters', async () => {
      const { actions } = await loadPage()
      const name = 'n'.repeat(101)
      const result = await actions.create({
        request: formRequest({
          'room-episode-name': name,
          'room-episode-code': 'pass'
        }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 400,
        data: { error: 'Name too long (max 100 chars)', name }
      })
    })

    it('requires a password', async () => {
      const { actions } = await loadPage()
      const result = await actions.create({
        request: formRequest({
          'room-episode-name': 'Ep',
          'room-episode-code': ''
        }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 400,
        data: { error: 'Password is required', name: 'Ep' }
      })
    })

    it('rejects a short password', async () => {
      const { actions } = await loadPage()
      const result = await actions.create({
        request: formRequest({
          'room-episode-name': 'Ep',
          'room-episode-code': 'abc'
        }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 400,
        data: { error: 'Password must be at least 4 characters', name: 'Ep', password: 'abc' }
      })
    })

    it('returns 500 when the DB insert fails', async () => {
      const spy = vi.spyOn(roomsDb, 'createRoom').mockImplementation(() => {
        throw new Error('disk full')
      })
      try {
        const { actions } = await loadPage()
        const result = await actions.create({
          request: formRequest({
            'room-episode-name': 'Ep',
            'room-episode-code': 'pass'
          }),
          cookies: makeCookies()
        })
        expect(result).toMatchObject({
          status: 500,
          data: { error: 'Could not create room. Check server logs.', name: 'Ep', password: '' }
        })
      } finally {
        spy.mockRestore()
      }
    })

    it('creates a room, sets auth cookies, and redirects', async () => {
      process.env.FORCE_HTTPS = 'true'
      const { actions } = await loadPage()
      const cookies = makeCookies()
      const err = await expectRedirect(
        () => actions.create({
          request: formRequest({
            'room-episode-name': 'Live Show',
            'room-episode-code': 'pass'
          }),
          cookies
        }),
        303,
        /^\/rec\/[abcdefghijkmnpqrstuvwxyz23456789]{10}$/
      )

      const rooms = db.getDb().prepare('SELECT * FROM rooms').all()
      expect(rooms).toHaveLength(1)
      const room = rooms[0]
      expect(room.name).toBe('Live Show')
      expect(room.password_plain).toBe('pass')
      expect(getRoomBySlug(room.slug)).toMatchObject({ slug: room.slug })
      expect(err.location).toBe(`/rec/${room.slug}`)

      const auth = cookies.jar.get(`pr_auth_${room.slug}`)
      const host = cookies.jar.get(`pr_host_${room.slug}`)
      expect(auth.value).toHaveLength(64)
      expect(host.value).toHaveLength(64)
      expect(auth.options).toMatchObject({
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
        secure: true
      })
      expect(host.options).toMatchObject({
        httpOnly: true,
        secure: true
      })
    })
  })

  describe('actions.save_research_prompt', () => {
    it('persists the Research Prompt and Title then redirects home', async () => {
      const { actions } = await loadPage()
      await expectRedirect(
        () => actions.save_research_prompt({
          request: formRequest({
            'research-prompt': 'Read {current_tab}.',
            'research-prompt-title': '  Interpret  '
          }),
          cookies: makeCookies()
        }),
        303,
        '/'
      )
      expect(roomsDb.getResearchPrompt()).toBe('Read {current_tab}.')
      expect(roomsDb.getResearchPromptTitle()).toBe('Interpret')
    })

    it('rejects a title over 40 characters without writing', async () => {
      roomsDb.setResearchPrompt('kept')
      roomsDb.setResearchPromptTitle('Interpret')
      const { actions } = await loadPage()
      const title = 't'.repeat(41)
      const result = await actions.save_research_prompt({
        request: formRequest({
          'research-prompt': 'new prompt',
          'research-prompt-title': title
        }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 400,
        data: {
          promptError: 'Title too long (max 40 chars)',
          researchPrompt: 'new prompt',
          researchPromptTitle: title
        }
      })
      expect(roomsDb.getResearchPrompt()).toBe('kept')
      expect(roomsDb.getResearchPromptTitle()).toBe('Interpret')
    })

    it('rejects save when the site is locked and there is no site cookie', async () => {
      process.env.SITE_PASSWORD = SITE_PASSWORD
      const { actions } = await loadPage()
      const result = await actions.save_research_prompt({
        request: formRequest({
          'research-prompt': 'nope',
          'research-prompt-title': 'Nope'
        }),
        cookies: makeCookies()
      })
      expect(result).toMatchObject({
        status: 403,
        data: { promptError: 'Not authorised.' }
      })
    })
  })
})
