import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getNotesTextSize, setNotesTextSize, SIZES } from '../../src/lib/notes-text-size.js'

function mockStorage(initial = {}) {
  const store = { ...initial }
  globalThis.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] }
  }
  return store
}

describe('notes text size', () => {
  let previousStorage

  beforeEach(() => {
    previousStorage = globalThis.localStorage
  })

  afterEach(() => {
    globalThis.localStorage = previousStorage
  })

  it('defaults to 16 when nothing is stored', () => {
    mockStorage()
    expect(getNotesTextSize()).toBe(16)
  })

  it('returns a stored size only when it is one of the allowed steps', () => {
    mockStorage({ notesTextSize: '18' })
    expect(getNotesTextSize()).toBe(18)
    expect(SIZES).toContain(18)
  })

  it('ignores junk or off-scale values instead of applying them', () => {
    mockStorage({ notesTextSize: '99' })
    expect(getNotesTextSize()).toBe(16)
    mockStorage({ notesTextSize: 'nope' })
    expect(getNotesTextSize()).toBe(16)
  })

  it('persists the chosen size for the next load', () => {
    const store = mockStorage()
    setNotesTextSize(20)
    expect(store.notesTextSize).toBe('20')
    expect(getNotesTextSize()).toBe(20)
  })

  it('falls back to the default when storage is unavailable', () => {
    globalThis.localStorage = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') }
    }
    expect(getNotesTextSize()).toBe(16)
    expect(() => setNotesTextSize(18)).not.toThrow()
  })
})
