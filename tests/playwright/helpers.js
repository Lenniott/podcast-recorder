/**
 * Stub the YouTube IFrame API so Watch Together can load without hitting youtube.com.
 * Must be installed before navigation (page.addInitScript).
 */
export async function stubYouTubeApi(page) {
  await page.addInitScript(() => {
    // File System Access API is required to pass the room's browser gate.
    if (!('showSaveFilePicker' in window)) {
      window.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async () => {},
          close: async () => {}
        })
      })
    }

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

export async function createRoom(page, { name, password, hostDisplayName = 'Host' }) {
  await page.goto('/')
  await page.locator('#name').fill(name)
  await page.locator('#password').fill(password)
  await Promise.all([
    page.waitForURL(/\/rec\//, { timeout: 15_000 }),
    page.getByRole('button', { name: /Create Room/i }).click()
  ])
  // The room's password/auth cookies are set by room creation, but the host
  // still has no display name yet — same "how should we show you" gate a
  // guest hits, just without the password field since they're already authed.
  await page.getByLabel('Your name').fill(hostDisplayName)
  await page.getByRole('button', { name: /Continue/i }).click()
  await roomTabsReady(page)
  return page.url()
}

export async function joinAsGuest(page, roomUrl, { name, password }) {
  await page.goto(roomUrl)
  // Host cookie from createRoom won't exist in a fresh context — expect password gate.
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /Join Room/i }).click()
  await roomTabsReady(page)
}

/**
 * Waits for the room's shared tab state to have arrived over the WS.
 * Generous timeout: on a cold `npm run dev` start, the WS proxy target
 * (server-ws-dev.js) can come up a beat after Vite's HTTP port starts
 * responding (the two are separate processes) — the room's own 3s
 * auto-reconnect needs a couple of cycles to land in that window.
 */
async function roomTabsReady(page) {
  await page.getByPlaceholder('Shared notes — visible to everyone in the room…').waitFor({ timeout: 30_000 })
}
