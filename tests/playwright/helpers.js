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
        this._time = start || 0
        this._state = 1
      }
      cueVideoById(id, start) {
        this._time = start || 0
        this._state = 2
      }
      playVideo() {
        this._state = 1
      }
      pauseVideo() {
        this._state = 2
      }
      seekTo(t) {
        this._time = t
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

/** Waits for the room's shared tab state to have arrived over the WS. */
async function roomTabsReady(page) {
  await page.getByPlaceholder('Shared notes — visible to everyone in the room…').waitFor({ timeout: 15_000 })
}
