// Theme switcher with three modes: 'system' (default — follows the OS, and
// stays live if the OS preference changes while the page is open), 'light',
// and 'dark'. Only an explicit 'light'/'dark' choice is ever persisted;
// 'system' is represented by the *absence* of a stored preference, which is
// also exactly what the inline boot script in app.html checks for, so the
// two stay in sync without duplicating logic.
//
// Anything that reads theme colors in JS (e.g. canvas drawing) rather than
// pure CSS should listen for the 'themechange' window event fired below
// instead of polling — its detail is the resolved 'light'/'dark' value.

const STORAGE_KEY = 'theme'
const MODES = ['system', 'light', 'dark']
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

let listening = false

function systemTheme() {
  return media?.matches ? 'dark' : 'light'
}

/** The user's chosen mode: 'system' | 'light' | 'dark'. */
export function getMode() {
  const stored = (() => { try { return localStorage.getItem(STORAGE_KEY) } catch { return null } })()
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/** The theme actually applied right now: 'light' | 'dark'. */
export function getTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }))
}

export function setMode(mode) {
  try {
    if (mode === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
  } catch {}
  apply(mode === 'system' ? systemTheme() : mode)
  ensureSystemListener()
}

export function cycleMode() {
  const next = MODES[(MODES.indexOf(getMode()) + 1) % MODES.length]
  setMode(next)
  return next
}

// Keeps the page live-updating if the OS theme flips while mode === 'system'
// — including when the user never touches the toggle at all, since 'system'
// is the default. Guarded so it only ever attaches once per page.
function ensureSystemListener() {
  if (listening || !media) return
  listening = true
  media.addEventListener('change', () => {
    if (getMode() === 'system') apply(systemTheme())
  })
}

ensureSystemListener()
