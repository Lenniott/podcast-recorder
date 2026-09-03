import { describe, it, expect, beforeEach } from 'vitest'
import { createRoom, _resetDb } from '../../src/lib/server/db.js'
import { getUsageDashboard, hideTestRoomsInDashboard } from '../../src/lib/server/usage-dashboard.js'

const SLUG_REAL = 'realroom01'
const SLUG_E2E = 'e2eroom01'

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  process.env.SERVER_COPY_DIR = ':memory:not-a-real-dir' // no files on disk — recordingSeconds stays 0
  _resetDb()
})

describe('hideTestRoomsInDashboard', () => {
  it('is off by default and for any unrecognized value', () => {
    expect(hideTestRoomsInDashboard({})).toBe(false)
    expect(hideTestRoomsInDashboard({ HIDE_TEST_ROOMS_IN_DASHBOARD: 'nope' })).toBe(false)
  })

  it('is on for 1/true/yes, case-insensitively', () => {
    expect(hideTestRoomsInDashboard({ HIDE_TEST_ROOMS_IN_DASHBOARD: '1' })).toBe(true)
    expect(hideTestRoomsInDashboard({ HIDE_TEST_ROOMS_IN_DASHBOARD: 'TRUE' })).toBe(true)
  })
})

describe('getUsageDashboard', () => {
  beforeEach(() => {
    createRoom({ slug: SLUG_REAL, name: 'A real episode', passwordHash: 'x' })
    createRoom({ slug: SLUG_E2E, name: 'E2E SomeSpec 12345', passwordHash: 'x' })
  })

  it('lists every room, e2e included, when the flag is off', () => {
    const { rooms } = getUsageDashboard({})
    expect(rooms.map((r) => r.slug).sort()).toEqual([SLUG_E2E, SLUG_REAL].sort())
  })

  it('excludes rooms named "E2E ..." from the per-room table when the flag is on', () => {
    const { rooms } = getUsageDashboard({ HIDE_TEST_ROOMS_IN_DASHBOARD: 'true' })
    expect(rooms.map((r) => r.slug)).toEqual([SLUG_REAL])
  })

  it('every room row carries the shape the dashboard renders, defaulting to zero with no usage yet', () => {
    const { rooms } = getUsageDashboard({})
    const real = rooms.find((r) => r.slug === SLUG_REAL)
    expect(real).toMatchObject({
      name: 'A real episode',
      calls: 0,
      tokens: 0,
      cost: 0,
      recordingSeconds: 0,
      transcriptWords: 0,
      tabCount: 1, // a fresh room always starts with one tab — see room-state-store.js
      researchCardCount: 0
    })
  })
})
