// Tiny theme switcher. The actual *initial* theme (before this module ever
// runs) is decided by the inline boot script in app.html, so there's no
// flash-of-wrong-theme on load — this only handles runtime toggling and
// keeps that boot script's choice persisted.
//
// Anything that reads theme colors in JS (e.g. canvas drawing) rather than
// pure CSS should listen for the 'themechange' window event fired by
// setTheme() below instead of polling.

const STORAGE_KEY = 'theme'

export function getTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  try { localStorage.setItem(STORAGE_KEY, theme) } catch {}
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }))
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}
