import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hashPassword, makeSessionToken, makeHostClaimToken, makeServerCopyToken } from '../../src/lib/server/auth.js'
import db, { createRoom, _resetDb } from '../../src/lib/server/db.js'
import { getServerCopyFilePath, getServerCopyWavPath } from '../../src/lib/server/server-copy-storage.js'
import { buildWavHeader } from '../../src/lib/recording/audio-utils.js'

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

async function loadFilesRoute() {
  return import('../../src/routes/rec/[slug]/server-copy/files/+server.js')
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

// The clientId-scoped capability token (ticket 11) a real client only
// ever gets back from the WS room server's 'join' ack — minted here
// directly so route tests can drive a legitimate, same-owner request
// without spinning up a WS connection.
function serverCopyToken(clientId = CLIENT_ID) {
  return makeServerCopyToken(SLUG, clientId, SECRET)
}

function chunkUrl(offset, { clientId = CLIENT_ID, token = serverCopyToken(clientId), takeId } = {}) {
  const takeParam = takeId ? `&takeId=${takeId}` : ''
  return new URL(`http://localhost/rec/${SLUG}/server-copy/chunks?clientId=${clientId}&offset=${offset}&token=${token}${takeParam}`)
}

function downloadUrl(clientId = CLIENT_ID, { takeId } = {}) {
  const takeParam = takeId ? `&takeId=${takeId}` : ''
  return new URL(`http://localhost/rec/${SLUG}/server-copy/download?clientId=${clientId}${takeParam}`)
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
      request: { json: async () => ({ clientId: CLIENT_ID, token: serverCopyToken() }) }
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
      url: new URL(`http://localhost/rec/${SLUG}/server-copy/chunks?clientId=..%2F..%2Fevil&offset=0&token=irrelevant`),
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
      url: new URL(`http://localhost/rec/${SLUG}/server-copy/chunks?clientId=${CLIENT_ID}&token=${serverCopyToken()}`),
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
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 4, sampleRate: 44100, token: serverCopyToken() }) }
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
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 999, token: serverCopyToken() }) }
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
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 2, token: serverCopyToken() }) }
    })

    const res2 = await postFinalize({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: 2, token: serverCopyToken() }) }
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
      request: { json: async () => ({ clientId: CLIENT_ID, token: serverCopyToken() }) }
    })

    expect(res.status).toBe(400)
  })
})

describe('security: a same-room participant cannot act on another clientId (ticket 11)', () => {
  // The room's session cookie (pr_auth_<slug>) is identical for every
  // participant — it proves room membership, not which clientId the
  // caller owns. Before ticket 11, that was the *only* check these routes
  // did, so any participant holding the shared cookie could read/write/
  // finalize any other participant's server copy just by naming their
  // clientId. OWNER_CLIENT_ID is the legitimate owner's clientId; every
  // request below is made with only the shared room cookie (no token for
  // OWNER_CLIENT_ID), exactly as an intruding second participant would.
  const OWNER_CLIENT_ID = 'owner-client-1'

  it('rejects a session request for someone else\'s clientId using only the shared room cookie', async () => {
    const { POST } = await loadSessionRoute()
    const cookies = await authedCookies() // the one cookie every room participant holds

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: OWNER_CLIENT_ID }) }
    })

    expect(res.status).toBe(401)
    expect((await res.json()).accepted).toBe(false)
  })

  it('rejects a chunk upload for someone else\'s clientId using only the shared room cookie, and writes nothing', async () => {
    const { POST } = await loadChunksRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      url: new URL(`http://localhost/rec/${SLUG}/server-copy/chunks?clientId=${OWNER_CLIENT_ID}&offset=0`),
      request: { arrayBuffer: async () => new Uint8Array([9, 9, 9, 9]).buffer }
    })

    expect(res.status).toBe(401)
    expect(() => readFileSync(getServerCopyFilePath(SLUG, OWNER_CLIENT_ID))).toThrow()
  })

  it('rejects finalizing someone else\'s clientId using only the shared room cookie', async () => {
    const { POST } = await loadFinalizeRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: OWNER_CLIENT_ID, totalBytes: 0 }) }
    })

    expect(res.status).toBe(401)
    expect((await res.json()).finalized).toBe(false)
  })

  it('still rejects (401) even with a well-formed but forged/tampered token', async () => {
    const { POST } = await loadSessionRoute()
    const cookies = await authedCookies()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      request: { json: async () => ({ clientId: OWNER_CLIENT_ID, token: 'deadbeef'.repeat(8) }) }
    })

    expect(res.status).toBe(401)
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
      request: { json: async () => ({ clientId: CLIENT_ID, totalBytes: pcm.byteLength, sampleRate, token: serverCopyToken() }) }
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

  it('keeps separate takes from the same clientId in separate downloadable WAVs', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    const { POST: postSession } = await loadSessionRoute()
    const { POST: postChunk } = await loadChunksRoute()
    const { POST: postFinalize } = await loadFinalizeRoute()

    async function uploadTake(takeId, bytes) {
      await postSession({
        params: { slug: SLUG },
        cookies: participantCookies,
        request: { json: async () => ({ clientId: CLIENT_ID, token: serverCopyToken(), takeId, sampleRate: 48000 }) }
      })
      await postChunk({
        params: { slug: SLUG },
        cookies: participantCookies,
        url: chunkUrl(0, { takeId }),
        request: { arrayBuffer: async () => new Uint8Array(bytes).buffer }
      })
      await postFinalize({
        params: { slug: SLUG },
        cookies: participantCookies,
        request: { json: async () => ({ clientId: CLIENT_ID, token: serverCopyToken(), takeId, totalBytes: bytes.length, sampleRate: 48000 }) }
      })
    }

    await uploadTake('takeone', [1, 1, 1, 1])
    await uploadTake('taketwo', [2, 2])

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadDownloadRoute()
    const res1 = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl(CLIENT_ID, { takeId: 'takeone' }) })
    const res2 = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl(CLIENT_ID, { takeId: 'taketwo' }) })
    const first = Buffer.from(await res1.arrayBuffer())
    const second = Buffer.from(await res2.arrayBuffer())

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(first.subarray(44)).toEqual(Buffer.from([1, 1, 1, 1]))
    expect(second.subarray(44)).toEqual(Buffer.from([2, 2]))
  })

  it('falls back to the latest finalized take when a completed-copy download omits takeId', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    const takeId = 'takefallback'
    const { POST: postSession } = await loadSessionRoute()
    const { POST: postChunk } = await loadChunksRoute()
    const { POST: postFinalize } = await loadFinalizeRoute()

    await postSession({
      params: { slug: SLUG },
      cookies: participantCookies,
      request: { json: async () => ({ clientId: CLIENT_ID, token: serverCopyToken(), takeId, sampleRate: 48000 }) }
    })
    await postChunk({
      params: { slug: SLUG },
      cookies: participantCookies,
      url: chunkUrl(0, { takeId }),
      request: { arrayBuffer: async () => new Uint8Array([8, 9]).buffer }
    })
    await postFinalize({
      params: { slug: SLUG },
      cookies: participantCookies,
      request: { json: async () => ({ clientId: CLIENT_ID, token: serverCopyToken(), takeId, totalBytes: 2, sampleRate: 48000 }) }
    })

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadDownloadRoute()
    const res = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl(CLIENT_ID) })
    const body = Buffer.from(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(body.subarray(44)).toEqual(Buffer.from([8, 9]))
  })

  it('lets the host download a valid partial WAV for bytes uploaded before finalize', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    const { POST: postSession } = await loadSessionRoute()
    await postSession({
      params: { slug: SLUG },
      cookies: participantCookies,
      request: { json: async () => ({ clientId: CLIENT_ID, token: serverCopyToken(), sampleRate: 44100 }) }
    })
    const { POST: postChunk } = await loadChunksRoute()
    const pcm = new Uint8Array([1, 2]).buffer
    await postChunk({
      params: { slug: SLUG },
      cookies: participantCookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => pcm }
    })

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadDownloadRoute()
    const res = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl() })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('-partial.wav')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.subarray(0, 44)).toEqual(Buffer.from(buildWavHeader(2, 44100)))
    expect(body.subarray(44)).toEqual(Buffer.from(pcm))
  })

  it('falls back to the latest partial take when a partial download omits takeId', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    const takeId = 'partialfallback'
    const { POST: postSession } = await loadSessionRoute()
    const { POST: postChunk } = await loadChunksRoute()

    await postSession({
      params: { slug: SLUG },
      cookies: participantCookies,
      request: { json: async () => ({ clientId: CLIENT_ID, token: serverCopyToken(), takeId, sampleRate: 44100 }) }
    })
    await postChunk({
      params: { slug: SLUG },
      cookies: participantCookies,
      url: chunkUrl(0, { takeId }),
      request: { arrayBuffer: async () => new Uint8Array([7, 6, 5]).buffer }
    })

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadDownloadRoute()
    const res = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl(CLIENT_ID) })
    const body = Buffer.from(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('-partial.wav')
    expect(body.subarray(0, 44)).toEqual(Buffer.from(buildWavHeader(3, 44100)))
    expect(body.subarray(44)).toEqual(Buffer.from([7, 6, 5]))
  })

  it('lets the host download a continuous partial WAV for a copy interrupted mid-upload', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    const { POST: postChunk } = await loadChunksRoute()

    // A few chunks land, matching a real multi-chunk upload in progress...
    await postChunk({
      params: { slug: SLUG },
      cookies: participantCookies,
      url: chunkUrl(0),
      request: { arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
    })
    await postChunk({
      params: { slug: SLUG },
      cookies: participantCookies,
      url: chunkUrl(4),
      request: { arrayBuffer: async () => new Uint8Array([5, 6]).buffer }
    })
    // ...then the participant leaves/disconnects: no further chunks and no
    // finalize request ever arrive. Nothing more happens to this copy.

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadDownloadRoute()
    const res = await GET({ params: { slug: SLUG }, cookies, url: downloadUrl() })

    expect(res.status).toBe(200)
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.subarray(0, 44)).toEqual(Buffer.from(buildWavHeader(6, 48000)))
    expect(body.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))
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

describe('GET /rec/[slug]/server-copy/files', () => {
  async function uploadCopy({
    clientId = CLIENT_ID,
    takeId = 'takeone',
    bytes = [1, 2, 3, 4],
    finalize = true,
    sampleRate = 48000,
    participantCookies
  } = {}) {
    const { POST: postSession } = await loadSessionRoute()
    const { POST: postChunk } = await loadChunksRoute()
    await postSession({
      params: { slug: SLUG },
      cookies: participantCookies,
      request: { json: async () => ({ clientId, token: serverCopyToken(clientId), takeId, sampleRate }) }
    })
    await postChunk({
      params: { slug: SLUG },
      cookies: participantCookies,
      url: chunkUrl(0, { clientId, token: serverCopyToken(clientId), takeId }),
      request: { arrayBuffer: async () => new Uint8Array(bytes).buffer }
    })
    if (finalize) {
      const { POST: postFinalize } = await loadFinalizeRoute()
      await postFinalize({
        params: { slug: SLUG },
        cookies: participantCookies,
        request: { json: async () => ({ clientId, token: serverCopyToken(clientId), takeId, totalBytes: bytes.length, sampleRate }) }
      })
    }
  }

  it('returns every completed take for a participant, newest first, with pinned download URLs', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    await uploadCopy({ takeId: 'firsttake', bytes: [1], participantCookies })
    await uploadCopy({ takeId: 'secondtake', bytes: [2, 2], participantCookies })

    const older = new Date('2026-01-01T00:00:00.000Z')
    const newer = new Date('2026-01-02T00:00:00.000Z')
    utimesSync(getServerCopyWavPath(SLUG, CLIENT_ID, 'firsttake'), older, older)
    utimesSync(getServerCopyWavPath(SLUG, CLIENT_ID, 'secondtake'), newer, newer)

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadFilesRoute()
    const res = await GET({ params: { slug: SLUG }, cookies })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0].clientId).toBe(CLIENT_ID)
    expect(body.groups[0].entries.map((e) => e.takeId)).toEqual(['secondtake', 'firsttake'])
    expect(body.groups[0].entries.map((e) => e.status)).toEqual(['complete', 'complete'])
    expect(body.groups[0].entries[1].downloadUrl).toContain('takeId=firsttake')
  })

  it('returns partial takes as downloadable partial WAV entries', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    await uploadCopy({ takeId: 'partialtake', bytes: [7, 8, 9], finalize: false, sampleRate: 44100, participantCookies })

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadFilesRoute()
    const res = await GET({ params: { slug: SLUG }, cookies })
    const body = await res.json()
    const entry = body.groups[0].entries[0]

    expect(res.status).toBe(200)
    expect(entry).toMatchObject({
      clientId: CLIENT_ID,
      takeId: 'partialtake',
      status: 'partial',
      byteSize: 47,
      sampleRate: 44100
    })
    expect(entry.downloadUrl).toContain('takeId=partialtake')
  })

  it('groups host and guest files separately', async () => {
    const passwordHash = await seedRoom()
    const participantCookies = makeCookies({ [`pr_auth_${SLUG}`]: makeSessionToken(SLUG, passwordHash, SECRET) })
    await uploadCopy({ clientId: 'hostclient', takeId: 'hosttake', bytes: [1], participantCookies })
    await uploadCopy({ clientId: 'guestclient', takeId: 'guesttake', bytes: [2], participantCookies })

    const cookies = makeCookies({ [`pr_host_${SLUG}`]: makeHostClaimToken(SLUG, passwordHash, SECRET) })
    const { GET } = await loadFilesRoute()
    const res = await GET({ params: { slug: SLUG }, cookies })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.groups.map((g) => g.clientId).sort()).toEqual(['guestclient', 'hostclient'])
  })

  it('rejects a non-host even when they are an authenticated room participant', async () => {
    const passwordHash = await seedRoom()
    const participantToken = makeSessionToken(SLUG, passwordHash, SECRET)
    const { GET } = await loadFilesRoute()
    const res = await GET({
      params: { slug: SLUG },
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: participantToken })
    })

    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('not-host')
  })
})
