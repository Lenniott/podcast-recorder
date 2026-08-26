import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hashPassword, makeSessionToken } from '../../src/lib/server/auth.js'
import db, { createRoom, _resetDb } from '../../src/lib/server/db.js'
import { getServerCopyFilePath } from '../../src/lib/server/server-copy-storage.js'

const SECRET = 'test-secret-do-not-use-in-prod'
const SLUG = 'roomslug01'
const ROOM_PASS = 'room-pass'
const CLIENT_ID = 'client123abc'

function makeCookies(seed = {}) {
  const jar = new Map(Object.entries(seed))
  return { get: (name) => jar.get(name) }
}

async function loadSessionRoute() {
  return import('../../src/routes/rec/[slug]/server-copy/session/+server.js')
}

async function loadChunksRoute() {
  return import('../../src/routes/rec/[slug]/server-copy/chunks/+server.js')
}

async function seedRoom({ createdAt } = {}) {
  const passwordHash = await hashPassword(ROOM_PASS)
  createRoom({ slug: SLUG, name: 'Test Episode', passwordHash })
  if (createdAt != null) {
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(createdAt, SLUG)
  }
  return passwordHash
}

async function authedCookies() {
  const passwordHash = await seedRoom()
  const token = makeSessionToken(SLUG, passwordHash, SECRET)
  return makeCookies({ [`pr_auth_${SLUG}`]: token })
}

function chunkUrl(offset) {
  return new URL(`http://localhost/rec/${SLUG}/server-copy/chunks?clientId=${CLIENT_ID}&offset=${offset}`)
}

let serverCopyDir

beforeEach(() => {
  serverCopyDir = join(
    tmpdir(),
    `podcast-recorder-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  process.env.DB_PATH = ':memory:'
  process.env.SECRET = SECRET
  process.env.SERVER_COPY_DIR = serverCopyDir
  process.env.ROOM_MAX_AGE_HOURS = '12'
  _resetDb()
})

afterEach(() => {
  if (serverCopyDir) rmSync(serverCopyDir, { recursive: true, force: true })
})

describe('POST /rec/[slug]/server-copy/session', () => {
  it('accepts a session for an active room with a valid cookie, reporting 0 bytes for a fresh participant', async () => {
    const { POST } = await loadSessionRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: CLIENT_ID }) }
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ accepted: true, bytesWritten: 0 })
  })

  it('rejects (410) a session request for an expired room — ties upload to room lifetime', async () => {
    await seedRoom({ createdAt: Date.now() - 13 * 60 * 60 * 1000 })
    const { POST } = await loadSessionRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies: makeCookies(),
      request: { json: async () => ({ clientId: CLIENT_ID }) }
    })

    expect(res.status).toBe(410)
    expect((await res.json()).accepted).toBe(false)
  })

  it('rejects (401) a session request without a valid room cookie', async () => {
    await seedRoom()
    const { POST } = await loadSessionRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies: makeCookies(),
      request: { json: async () => ({ clientId: CLIENT_ID }) }
    })

    expect(res.status).toBe(401)
  })

  it('rejects (400) an invalid clientId', async () => {
    const { POST } = await loadSessionRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: '../../evil' }) }
    })

    expect(res.status).toBe(400)
  })
})

describe('POST /rec/[slug]/server-copy/chunks', () => {
  it('appends a chunk at offset 0 and acknowledges the new byte offset', async () => {
    const { POST } = await loadChunksRoute()
    const cookies = await authedCookies()
    const body = new Uint8Array([1, 2, 3, 4]).buffer

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => body }
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bytesWritten: 4 })
    expect(readFileSync(getServerCopyFilePath(SLUG, CLIENT_ID))).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('appends a second chunk at the acknowledged offset, in order', async () => {
    const { POST } = await loadChunksRoute()
    const cookies = await authedCookies()

    await POST({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new Uint8Array([1, 2]).buffer }
    })
    const res2 = await POST({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(2),
      request: { arrayBuffer: async () => new Uint8Array([3, 4, 5]).buffer }
    })

    expect(await res2.json()).toEqual({ bytesWritten: 5 })
    expect(readFileSync(getServerCopyFilePath(SLUG, CLIENT_ID))).toEqual(Buffer.from([1, 2, 3, 4, 5]))
  })

  it('rejects (409) a chunk at the wrong offset and reports the true acknowledged offset — never corrupts the file', async () => {
    const { POST } = await loadChunksRoute()
    const cookies = await authedCookies()

    await POST({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new Uint8Array([1, 2]).buffer }
    })
    const res2 = await POST({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(0), // stale/duplicate offset
      request: { arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer }
    })

    expect(res2.status).toBe(409)
    expect((await res2.json()).bytesWritten).toBe(2)
    expect(readFileSync(getServerCopyFilePath(SLUG, CLIENT_ID))).toEqual(Buffer.from([1, 2]))
  })

  it('rejects (410) a chunk upload for an expired room and writes nothing', async () => {
    await seedRoom({ createdAt: Date.now() - 13 * 60 * 60 * 1000 })
    const { POST } = await loadChunksRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies: makeCookies(),
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new Uint8Array([1]).buffer }
    })

    expect(res.status).toBe(410)
  })

  it('rejects (401) a chunk upload without a valid room cookie', async () => {
    await seedRoom()
    const { POST } = await loadChunksRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies: makeCookies(),
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new Uint8Array([1]).buffer }
    })

    expect(res.status).toBe(401)
  })

  it('rejects (400) an invalid clientId', async () => {
    const { POST } = await loadChunksRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      url: new URL(`http://localhost/rec/${SLUG}/server-copy/chunks?clientId=..%2F..%2Fevil&offset=0`),
      request: { arrayBuffer: async () => new Uint8Array([1]).buffer }
    })

    expect(res.status).toBe(400)
  })

  it('rejects (400) a missing/invalid offset', async () => {
    const { POST } = await loadChunksRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      url: new URL(`http://localhost/rec/${SLUG}/server-copy/chunks?clientId=${CLIENT_ID}`),
      request: { arrayBuffer: async () => new Uint8Array([1]).buffer }
    })

    expect(res.status).toBe(400)
  })

  it('rejects (400) an empty body', async () => {
    const { POST } = await loadChunksRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new ArrayBuffer(0) }
    })

    expect(res.status).toBe(400)
  })
})
