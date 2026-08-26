import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hashPassword, makeSessionToken, makeHostClaimToken } from '../../src/lib/server/auth.js'
import db, { createRoom, _resetDb } from '../../src/lib/server/db.js'
import { getServerCopyFilePath } from '../../src/lib/server/server-copy-storage.js'
import { buildWavHeader } from '../../src/lib/audio-utils.js'

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

async function loadFinalizeRoute() {
  return import('../../src/routes/rec/[slug]/server-copy/finalize/+server.js')
}

async function loadDownloadRoute() {
  return import('../../src/routes/rec/[slug]/server-copy/download/+server.js')
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

async function hostCookies() {
  const passwordHash = await seedRoom()
  const token = makeHostClaimToken(SLUG, passwordHash, SECRET)
  return makeCookies({ [`pr_host_${SLUG}`]: token })
}

function chunkUrl(offset) {
  return new URL(`http://localhost/rec/${SLUG}/server-copy/chunks?clientId=${CLIENT_ID}&offset=${offset}`)
}

function downloadUrl(clientId = CLIENT_ID) {
  return new URL(`http://localhost/rec/${SLUG}/server-copy/download?clientId=${clientId}`)
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

describe('POST /rec/[slug]/server-copy/finalize', () => {
  it('finalizes once the declared total matches the bytes already on disk, writing a valid WAV', async () => {
    const { POST: postChunk } = await loadChunksRoute()
    const cookies = await authedCookies()
    const pcm = new Uint8Array([1, 2, 3, 4]).buffer
    await postChunk({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => pcm }
    })

    const { POST: postFinalize } = await loadFinalizeRoute()
    const res = await postFinalize({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 4, sampleRate: 44100 }) }
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ finalized: true, bytesWritten: 4 })

    const wavPath = getServerCopyFilePath(SLUG, CLIENT_ID).replace(/\.pcm$/, '.wav')
    const wavBytes = readFileSync(wavPath)
    expect(wavBytes.subarray(0, 44)).toEqual(Buffer.from(buildWavHeader(4, 44100)))
    expect(wavBytes.subarray(44)).toEqual(Buffer.from(pcm))
  })

  it('rejects (409) finalizing before all declared bytes have actually arrived — never marks an incomplete copy complete', async () => {
    const { POST: postChunk } = await loadChunksRoute()
    const cookies = await authedCookies()
    await postChunk({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new Uint8Array([1, 2]).buffer }
    })

    const { POST: postFinalize } = await loadFinalizeRoute()
    const res = await postFinalize({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 999 }) }
    })

    expect(res.status).toBe(409)
    expect((await res.json()).finalized).toBe(false)
  })

  it('is idempotent when called again with the same already-finalized total', async () => {
    const { POST: postChunk } = await loadChunksRoute()
    const cookies = await authedCookies()
    await postChunk({
      params: { slug: SLUG },
      cookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new Uint8Array([1, 2]).buffer }
    })
    const { POST: postFinalize } = await loadFinalizeRoute()
    await postFinalize({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 2 }) }
    })

    const res2 = await postFinalize({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 2 }) }
    })

    expect(res2.status).toBe(200)
    expect(await res2.json()).toEqual({ finalized: true, bytesWritten: 2 })
  })

  it('rejects (410) finalizing for an expired room', async () => {
    await seedRoom({ createdAt: Date.now() - 13 * 60 * 60 * 1000 })
    const { POST } = await loadFinalizeRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies: makeCookies(),
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 0 }) }
    })

    expect(res.status).toBe(410)
  })

  it('rejects (401) finalizing without a valid room cookie', async () => {
    await seedRoom()
    const { POST } = await loadFinalizeRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies: makeCookies(),
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 0 }) }
    })

    expect(res.status).toBe(401)
  })

  it('rejects (400) an invalid clientId', async () => {
    const { POST } = await loadFinalizeRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: '../../evil', totalBytes: 0 }) }
    })

    expect(res.status).toBe(400)
  })

  it('rejects (400) a missing/invalid totalBytes', async () => {
    const { POST } = await loadFinalizeRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: CLIENT_ID }) }
    })

    expect(res.status).toBe(400)
  })
})

describe('GET /rec/[slug]/server-copy/download', () => {
  // Seeds the room at most once and returns its password hash, so tests
  // that need both a participant cookie (to finalize) and a separate
  // cookie (host or another guest) never re-seed the same slug twice.
  async function finalizeAsParticipant({
    pcm = new Uint8Array([1, 2, 3, 4]).buffer,
    sampleRate = 48000,
    passwordHash
  } = {}) {
    const hash = passwordHash ?? (await seedRoom())
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, hash, SECRET) })

    const { POST: postChunk } = await loadChunksRoute()
    await postChunk({
      params: { slug: SLUG },
      cookies: participantCookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => pcm }
    })
    const { POST: postFinalize } = await loadFinalizeRoute()
    await postFinalize({
      params: { slug: SLUG },
      cookies: participantCookies,
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: pcm.byteLength, sampleRate }) }
    })
    return hash
  }

  it('lets the host download a completed WAV whose bytes match the confirmed uploaded audio', async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]).buffer
    const passwordHash = await finalizeAsParticipant({ pcm, sampleRate: 44100 })

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadDownloadRoute()
    const res = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl() })

    expect(res.status).toBe(200)
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.subarray(0, 44)).toEqual(Buffer.from(buildWavHeader(4, 44100)))
    expect(body.subarray(44)).toEqual(Buffer.from(pcm))
  })

  it('rejects (404) a download for a participant that has not been finalized yet', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    const { POST: postChunk } = await loadChunksRoute()
    await postChunk({
      params: { slug: SLUG },
      cookies: participantCookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new Uint8Array([1, 2]).buffer }
    })

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadDownloadRoute()
    const res = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl() })

    expect(res.status).toBe(404)
  })

  it('rejects (403) a download from a non-host, even with a valid participant session', async () => {
    const passwordHash = await finalizeAsParticipant()
    const guestToken = makeSessionToken(SLUG, passwordHash, SECRET)

    const { GET } = await loadDownloadRoute()
    const res = await GET({
      params: { slug: SLUG },
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: guestToken }),
      url: downloadUrl()
    })

    expect(res.status).toBe(403)
  })

  it('rejects (410) a download for an expired room even though it was finalized while active', async () => {
    await finalizeAsParticipant()
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?')
      .run(Date.now() - 13 * 60 * 60 * 1000, SLUG)

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: 'irrelevant-room-is-checked-first' })
    const { GET } = await loadDownloadRoute()
    const res = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl() })

    expect(res.status).toBe(410)
  })

  it('rejects (400) an invalid clientId', async () => {
    const cookies = await hostCookies()
    const { GET } = await loadDownloadRoute()

    const res = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl('../../evil') })

    expect(res.status).toBe(400)
  })
})
