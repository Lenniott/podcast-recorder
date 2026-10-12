import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import db, {
  createRoom,
  getResearchUsageTotals,
  getRoomBySlug,
  recordResearchUsage,
  _resetDb
} from '../../src/lib/server/db.js'
import { getServerCopyRoomDir } from '../../src/lib/server/server-copy-storage.js'
import { getUsageDashboard } from '../../src/lib/server/usage-dashboard.js'
import { deleteRooms, unlockRooms } from '../../src/lib/server/dashboard-room-batch.js'

const CREATED_AT = 1_600_000_000_000
const LOCKED_AT = 1_700_000_000_000
const NOW = 1_800_000_000_000

let serverCopyDir

beforeEach(() => {
  if (serverCopyDir) rmSync(serverCopyDir, { recursive: true, force: true })
  serverCopyDir = join(tmpdir(), `podcast-recorder-batch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  process.env.SERVER_COPY_DIR = serverCopyDir
  process.env.DB_PATH = ':memory:'
  _resetDb()
})

function seed(slug, name) {
  createRoom({ slug, name, passwordHash: 'hash-value', passwordPlain: 'pw' })
  db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?')
    .run(CREATED_AT, LOCKED_AT, slug)
}

function plantServerCopy(slug) {
  const copyDir = getServerCopyRoomDir(slug)
  mkdirSync(copyDir, { recursive: true })
  writeFileSync(join(copyDir, 'hostbulk.wav'), Buffer.alloc(320))
  return copyDir
}

describe('unlockRooms', () => {
  it('moves guest_lock_at for each known room, leaves created_at, and skips an unknown slug', () => {
    seed('bulkulock1', 'One')
    seed('bulkulock2', 'Two')

    const result = unlockRooms(['bulkulock1', 'no-such-room', 'bulkulock2'], NOW)

    expect(result).toEqual({
      unlocked: ['bulkulock1', 'bulkulock2'],
      skipped: ['no-such-room']
    })
    for (const slug of ['bulkulock1', 'bulkulock2']) {
      expect(getRoomBySlug(slug)).toMatchObject({
        created_at: CREATED_AT,
        guest_lock_at: NOW
      })
    }
    expect(getRoomBySlug('no-such-room')).toBeNull()
  })

  it('unlocks nothing when the slug list is empty', () => {
    seed('bulkulock1', 'One')
    expect(unlockRooms([], NOW)).toEqual({ unlocked: [], skipped: [] })
    expect(getRoomBySlug('bulkulock1')).toMatchObject({
      created_at: CREATED_AT,
      guest_lock_at: LOCKED_AT
    })
  })
})

describe('deleteRooms', () => {
  it('removes the selected rooms from the room row and the dashboard, and deletes a planted server copy', () => {
    seed('bulkdel01', 'Drop One')
    seed('bulkdel02', 'Drop Two')
    seed('bulkkeep01', 'Keep')
    const copyDir = plantServerCopy('bulkdel01')
    const keepDir = plantServerCopy('bulkkeep01')
    recordResearchUsage({ roomSlug: 'bulkdel01', mode: 'ask', tokens: 7, cost: 1 })

    const result = deleteRooms({
      slugs: ['bulkdel01', 'bulkdel02'],
      siteAuthed: true
    })

    expect(result).toEqual({
      ok: true,
      status: 200,
      deleted: ['bulkdel01', 'bulkdel02'],
      skipped: []
    })
    expect(getRoomBySlug('bulkdel01')).toBeNull()
    expect(getRoomBySlug('bulkdel02')).toBeNull()
    expect(getRoomBySlug('bulkkeep01')).toMatchObject({ slug: 'bulkkeep01', name: 'Keep' })
    expect(existsSync(copyDir)).toBe(false)
    expect(existsSync(keepDir)).toBe(true)
    const slugs = getUsageDashboard({}).rooms.map((room) => room.slug)
    expect(slugs).not.toContain('bulkdel01')
    expect(slugs).not.toContain('bulkdel02')
    expect(slugs).toContain('bulkkeep01')
    expect(getResearchUsageTotals()).toMatchObject({ calls: 1, tokens: 7, cost: 1 })
  })

  it('deletes nothing when siteAuthed is false', () => {
    seed('bulkdel01', 'Drop One')
    seed('bulkdel02', 'Drop Two')
    const copyDir = plantServerCopy('bulkdel01')
    const slugs = ['bulkdel01', 'bulkdel02']

    const result = deleteRooms({ slugs, siteAuthed: false })

    expect(result).toEqual({ ok: false, status: 403, deleted: [], skipped: slugs })
    expect(getRoomBySlug('bulkdel01')).toMatchObject({ name: 'Drop One', guest_lock_at: LOCKED_AT })
    expect(getRoomBySlug('bulkdel02')).toMatchObject({ name: 'Drop Two' })
    expect(existsSync(copyDir)).toBe(true)
    expect(getUsageDashboard({}).rooms.map((room) => room.slug)).toEqual(
      expect.arrayContaining(['bulkdel01', 'bulkdel02'])
    )
  })

  it('skips unknown slugs and still deletes the known ones', () => {
    seed('bulkdel01', 'Drop One')
    seed('bulkkeep01', 'Keep')
    const copyDir = plantServerCopy('bulkdel01')

    const result = deleteRooms({
      slugs: ['no-such-room', 'bulkdel01', 'also-missing'],
      siteAuthed: true
    })

    expect(result).toEqual({
      ok: true,
      status: 200,
      deleted: ['bulkdel01'],
      skipped: ['no-such-room', 'also-missing']
    })
    expect(getRoomBySlug('bulkdel01')).toBeNull()
    expect(existsSync(copyDir)).toBe(false)
    expect(getRoomBySlug('bulkkeep01')).toMatchObject({ name: 'Keep' })
    expect(getUsageDashboard({}).rooms.map((room) => room.slug)).toEqual(['bulkkeep01'])
  })

  it('deletes nothing when the slug list is empty', () => {
    seed('bulkkeep01', 'Keep')
    const copyDir = plantServerCopy('bulkkeep01')

    expect(deleteRooms({ slugs: [], siteAuthed: true })).toEqual({
      ok: true,
      status: 200,
      deleted: [],
      skipped: []
    })
    expect(getRoomBySlug('bulkkeep01')).toMatchObject({ name: 'Keep', guest_lock_at: LOCKED_AT })
    expect(existsSync(copyDir)).toBe(true)
  })
})
