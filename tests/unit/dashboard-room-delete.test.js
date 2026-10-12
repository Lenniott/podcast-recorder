import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createRoom,
  getResearchUsageTotals,
  getRoomBySlug,
  loadRoomContent,
  recordResearchUsage,
  saveRoomContent,
  _resetDb
} from '../../src/lib/server/db.js'
import { getServerCopyRoomDir } from '../../src/lib/server/server-copy-storage.js'
import { deleteDashboardRoom } from '../../src/lib/server/dashboard-room-delete.js'
import { getUsageDashboard } from '../../src/lib/server/usage-dashboard.js'

let serverCopyDir

beforeEach(() => {
  if (serverCopyDir) rmSync(serverCopyDir, { recursive: true, force: true })
  serverCopyDir = join(tmpdir(), `podcast-recorder-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  process.env.SERVER_COPY_DIR = serverCopyDir
  _resetDb()
})

const ROOM = {
  slug: 'dashdelete1',
  name: 'Dash Delete',
  passwordHash: '$2a$10$fakehash'
}

const OTHER = {
  slug: 'dashkeep01',
  name: 'Dash Keep',
  passwordHash: '$2a$10$fakehash'
}

const CONTENT = {
  tabs: { list: [{ id: 't1', title: 'Tab 1', video: null, text: 'notes' }], activeTabId: 't1' }
}

function plantServerCopy(slug) {
  const copyDir = getServerCopyRoomDir(slug)
  mkdirSync(copyDir, { recursive: true })
  writeFileSync(join(copyDir, 'dummy.complete'), 'not audio')
  return copyDir
}

describe('deleteDashboardRoom', () => {
  it('site-authed delete of a known slug removes the room, its server copy, and its content', () => {
    createRoom(ROOM)
    createRoom(OTHER)
    const copyDir = plantServerCopy(ROOM.slug)
    const otherDir = plantServerCopy(OTHER.slug)
    saveRoomContent(ROOM.slug, CONTENT)
    saveRoomContent(OTHER.slug, CONTENT)

    const result = deleteDashboardRoom({ slug: ROOM.slug, siteAuthed: true })

    expect(result).toEqual({ ok: true, status: 200 })
    expect(getRoomBySlug(ROOM.slug)).toBeNull()
    expect(existsSync(copyDir)).toBe(false)
    expect(loadRoomContent(ROOM.slug)).toBeNull()
    expect(getRoomBySlug(OTHER.slug)).toMatchObject({ slug: OTHER.slug, name: OTHER.name })
    expect(existsSync(otherDir)).toBe(true)
    expect(loadRoomContent(OTHER.slug)).toEqual(CONTENT)
  })

  it('unauthenticated delete leaves the room in place', () => {
    createRoom(ROOM)
    const copyDir = plantServerCopy(ROOM.slug)
    saveRoomContent(ROOM.slug, CONTENT)

    const result = deleteDashboardRoom({ slug: ROOM.slug, siteAuthed: false })

    expect(result).toEqual({ ok: false, status: 403 })
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug, name: ROOM.name })
    expect(existsSync(copyDir)).toBe(true)
    expect(loadRoomContent(ROOM.slug)).toEqual(CONTENT)
  })

  it('unknown or missing slug returns status 404 and does not throw', () => {
    createRoom(ROOM)
    const copyDir = plantServerCopy(ROOM.slug)

    expect(deleteDashboardRoom({ slug: 'no-such-room', siteAuthed: true })).toEqual({ ok: false, status: 404 })
    expect(deleteDashboardRoom({ slug: '../not-a-room', siteAuthed: true })).toEqual({ ok: false, status: 404 })
    expect(deleteDashboardRoom({ slug: '', siteAuthed: true })).toEqual({ ok: false, status: 404 })
    expect(deleteDashboardRoom({ slug: null, siteAuthed: true })).toEqual({ ok: false, status: 404 })
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug })
    expect(existsSync(copyDir)).toBe(true)
  })

  it('getUsageDashboard no longer lists the slug after delete, and research usage totals remain', () => {
    createRoom(ROOM)
    createRoom(OTHER)
    recordResearchUsage({ roomSlug: ROOM.slug, mode: 'ask', tokens: 7, cost: 1 })

    const result = deleteDashboardRoom({ slug: ROOM.slug, siteAuthed: true })

    expect(result).toEqual({ ok: true, status: 200 })
    const { rooms } = getUsageDashboard({})
    expect(rooms.some((room) => room.slug === ROOM.slug)).toBe(false)
    expect(rooms.some((room) => room.slug === OTHER.slug)).toBe(true)
    expect(getResearchUsageTotals()).toMatchObject({ calls: 1, tokens: 7, cost: 1 })
  })
})
