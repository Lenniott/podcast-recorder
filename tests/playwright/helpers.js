import { expect } from '@playwright/test'

/**
 * Keep a handle on live WebSockets so a test can close the room socket
 * without waiting for the Vite proxy to idle-timeout it.
 */
export async function trackLiveSockets(page) {
  await page.addInitScript(() => {
    const NativeWS = window.WebSocket
    window.WebSocket = class extends NativeWS {
      constructor(...args) {
        super(...args)
        window.__prLiveSockets = window.__prLiveSockets || []
        window.__prLiveSockets.push(this)
        this.addEventListener('close', () => {
          window.__prLiveSockets = (window.__prLiveSockets || []).filter((s) => s !== this)
        })
      }
    }
  })
}

export async function closeLiveSockets(page) {
  await page.evaluate(() => {
    for (const ws of window.__prLiveSockets || []) {
      try { ws.close() } catch {}
    }
  })
}

/**
 * Stub the YouTube IFrame API so Watch Together can load without hitting youtube.com.
 * Must be installed before navigation (page.addInitScript).
 */
export async function stubYouTubeApi(page) {
  await page.addInitScript(() => {
    // Always stub — Chromium now ships File System Access, and a real picker
    // would abort startRecording() (AbortError) so the record button never flips.
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async () => {},
        close: async () => {}
      })
    })

    class FakePlayer {
      constructor(_el, opts) {
        this._opts = opts
        this._time = 0
        this._duration = 120
        this._volume = 100
        this._muted = false
        this._state = 2 // paused
        queueMicrotask(() => opts.events?.onReady?.({ target: this }))
      }
      getVolume() {
        return this._volume
      }
      isMuted() {
        return this._muted
      }
      setVolume(v) {
        this._volume = v
        window.__ytVolume = v
      }
      mute() {
        this._muted = true
      }
      unMute() {
        this._muted = false
      }
      loadVideoById(id, start) {
        // Simulate a real YouTube iframe's buffering lag: getCurrentTime()
        // doesn't actually reach `start` until the seek settles a moment
        // later. Reading it synchronously right after load — which is
        // exactly what a just-joined/just-loaded player's Play button click
        // would do — must NOT be trusted for the shared position (see
        // TabVideoPlayer#togglePlay).
        this._time = 0
        this._state = 1
        window.__ytPosition = this._time
        window.__ytState = 'playing'
        clearTimeout(this._loadCatchupTimer)
        this._loadCatchupTimer = setTimeout(() => {
          this._time = start || 0
          window.__ytPosition = this._time
        }, 2000)
      }
      cueVideoById(id, start) {
        this._time = start || 0
        this._state = 2
        window.__ytPosition = this._time
        window.__ytState = 'paused'
      }
      playVideo() {
        this._state = 1
        window.__ytState = 'playing'
      }
      pauseVideo() {
        this._state = 2
        window.__ytState = 'paused'
      }
      seekTo(t) {
        this._time = t
        window.__ytPosition = this._time
      }
      getCurrentTime() {
        return this._time
      }
      getDuration() {
        return this._duration
      }
      getPlayerState() {
        return this._state
      }
      destroy() {}
    }

    window.YT = {
      Player: FakePlayer,
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }
    }
  })
}

/**
 * noAutofill keeps inputs readonly until focus. Playwright's fill() checks
 * "editable" *before* focusing, so a plain fill() deadlocks on a still-locked
 * field. Click first (click doesn't need editable), wait until the action has
 * unlocked, then fill. Waiting for editable also means Svelte has hydrated —
 * a fill that landed on SSR HTML would get wiped by bind:value='' and submit
 * as "Episode name is required".
 */
export async function fillField(locator, value) {
  await locator.click()
  await expect(locator).toBeEditable()
  await locator.fill(value)
  await expect(locator).toHaveValue(value)
}

/**
 * Home is behind SITE_PASSWORD when .env has one; Playwright's own webServer
 * blanks that var so the gate is off. Handle both: unlock if the field is there.
 */
export async function unlockIfNeeded(page) {
  const site = page.getByRole('textbox', { name: 'Site Password' })
  const episode = page.locator('#room-episode-name')
  await expect(site.or(episode)).toBeVisible({ timeout: 15_000 })
  if (await site.isVisible()) {
    const pw = process.env.SITE_PASSWORD
    if (!pw) throw new Error('SITE_PASSWORD is not set but the site gate is showing')
    await site.fill(pw)
    await page.getByRole('button', { name: 'Unlock' }).click()
    const blocked = page.getByText(/Too many requests/i)
    await expect(episode.or(blocked)).toBeVisible({ timeout: 15_000 })
    if (await blocked.isVisible()) {
      throw new Error(
        'Site unlock hit the rate limiter. Stop `npm run dev` so Playwright can start its own server, or wait a minute and re-run.'
      )
    }
  }
}

export async function createRoom(page, { name, password, hostDisplayName = 'Host' }) {
  await page.goto('/')
  await unlockIfNeeded(page)
  await fillField(page.locator('#room-episode-name'), name)
  await fillField(page.locator('#room-episode-code'), password)
  // Generous timeout: if the form's click lands before use:enhance has
  // hydrated, the browser falls back to a real full-page POST + redirect +
  // GET of /rec/[slug] — on a cold `npm run dev` worker that route's (now
  // much larger, post-tabs-redesign) client bundle can take a while to
  // compile on its first hit, occasionally pushing well past 15s.
  await Promise.all([
    page.waitForURL(/\/rec\//, { timeout: 30_000 }),
    page.getByRole('button', { name: /Create Room/i }).click()
  ])
  // The room's password/auth cookies are set by room creation, but the host
  // still has no display name yet — same "how should we show you" gate a
  // guest hits, just without the password field since they're already authed.
  await fillField(page.getByLabel('Your name'), hostDisplayName)
  await page.getByRole('button', { name: /Continue/i }).click()
  await roomTabsReady(page)
  return page.url()
}

export async function joinAsGuest(page, roomUrl, { name, password }) {
  await page.goto(roomUrl)
  // Host cookie from createRoom won't exist in a fresh context — expect password gate.
  await fillField(page.getByLabel('Your name'), name)
  await fillField(page.locator('#room-episode-code'), password)
  await page.getByRole('button', { name: /Join Room/i }).click()
  await roomTabsReady(page)
}

const SAMPLE_YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

export async function loadVideo(page, url = SAMPLE_YOUTUBE_URL) {
  await page.getByPlaceholder('Paste a YouTube link or video id').fill(url)
  await page.getByRole('button', { name: 'Watch' }).click()
  await expect(page.getByRole('button', { name: /Play|Pause/ })).toBeVisible()
}

/**
 * Waits for the room's shared tab state to have arrived over the WS.
 * Generous timeout: on a cold `npm run dev` start, the WS proxy target
 * (server-ws-dev.js) can come up a beat after Vite's HTTP port starts
 * responding (the two are separate processes) — the room's own 3s
 * auto-reconnect needs a couple of cycles to land in that window.
 */
async function roomTabsReady(page) {
  // Wait on RoomTabs' own `data-ws-ready` flag (set the instant the first
  // tab_state WS message is applied) rather than the shared textarea's
  // rendered visibility — the textarea can be attached-but-not-yet-laid-out
  // for a beat after the WS state lands, which made this a flaky race,
  // especially under a cold `npm run dev` worker still compiling the bundle.
  await page.locator('.room-tabs[data-ws-ready="true"]').waitFor({ timeout: 30_000 })
}
