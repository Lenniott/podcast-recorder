import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function installBrowser({ stored = null, prefersDark = false } = {}) {
  const store = new Map()
  if (stored != null) store.set('theme', stored)

  const changeListeners = []
  const media = {
    matches: prefersDark,
    addEventListener(_type, fn) { changeListeners.push(fn) }
  }

  const attrs = {}
  const dispatched = []

  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) }
  }
  globalThis.document = {
    documentElement: {
      getAttribute: (k) => attrs[k] ?? null,
      setAttribute: (k, v) => { attrs[k] = v }
    }
  }
  globalThis.window = {
    matchMedia: () => media,
    dispatchEvent: (event) => { dispatched.push(event) }
  }
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init = {}) {
        this.type = type
        this.detail = init.detail
      }
    }
  }

  return { store, media, changeListeners, attrs, dispatched }
}

describe('theme', () => {
  let previous

  beforeEach(() => {
    previous = {
      window: globalThis.window,
      document: globalThis.document,
      localStorage: globalThis.localStorage
    }
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.localStorage = previous.localStorage
  })

  async function load() {
    return import('../../src/lib/theme.js')
  }

  it('treats missing storage as system mode, and follows the OS', async () => {
    const env = installBrowser({ prefersDark: true })
    const { getMode, getTheme, setMode } = await load()
    expect(getMode()).toBe('system')
    setMode('system')
    expect(env.attrs['data-theme']).toBe('dark')
    expect(getTheme()).toBe('dark')
    setMode('light')
    expect(getTheme()).toBe('light')
  })

  it('only treats an explicit light/dark store as a pin — junk is system', async () => {
    installBrowser({ stored: 'sepia' })
    const { getMode } = await load()
    expect(getMode()).toBe('system')
  })

  it('persists light/dark and clears storage when returning to system', async () => {
    const env = installBrowser({ prefersDark: false })
    const { setMode, getMode } = await load()
    setMode('dark')
    expect(env.store.get('theme')).toBe('dark')
    expect(env.attrs['data-theme']).toBe('dark')
    expect(getMode()).toBe('dark')
    setMode('system')
    expect(env.store.has('theme')).toBe(false)
    expect(env.attrs['data-theme']).toBe('light')
  })

  it('cycles system → light → dark → system', async () => {
    installBrowser()
    const { cycleMode, getMode } = await load()
    expect(cycleMode()).toBe('light')
    expect(getMode()).toBe('light')
    expect(cycleMode()).toBe('dark')
    expect(cycleMode()).toBe('system')
  })

  it('live-updates when the OS flips only while mode is system', async () => {
    const env = installBrowser({ prefersDark: false })
    const { setMode } = await load()
    expect(env.changeListeners).toHaveLength(1)

    env.media.matches = true
    env.changeListeners[0]()
    expect(env.attrs['data-theme']).toBe('dark')

    setMode('light')
    env.media.matches = true
    env.changeListeners[0]()
    expect(env.attrs['data-theme']).toBe('light')

    setMode('system')
    env.media.matches = true
    env.changeListeners[0]()
    expect(env.attrs['data-theme']).toBe('dark')
  })

  it('attaches the OS listener only once', async () => {
    const env = installBrowser()
    const { setMode } = await load()
    setMode('dark')
    setMode('system')
    expect(env.changeListeners).toHaveLength(1)
  })

  it('does not throw when storage is unavailable', async () => {
    const env = installBrowser()
    globalThis.localStorage = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
      removeItem() { throw new Error('denied') }
    }
    const { getMode, setMode } = await load()
    expect(getMode()).toBe('system')
    expect(() => setMode('dark')).not.toThrow()
    expect(env.attrs['data-theme']).toBe('dark')
  })

  it('announces the resolved theme so canvas readers do not poll', async () => {
    const env = installBrowser({ prefersDark: true })
    const { setMode } = await load()
    setMode('light')
    expect(env.dispatched.at(-1)).toMatchObject({ type: 'themechange', detail: 'light' })
  })

  it('loads without a window (SSR / Node) and still reports system mode', async () => {
    delete globalThis.window
    globalThis.localStorage = {
      getItem: () => null,
      setItem() {},
      removeItem() {}
    }
    const { getMode } = await load()
    expect(getMode()).toBe('system')
  })
})
