import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest } from './helpers.js'

test("guest text edits appear in the host's shared textarea", async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'guest-notes'
  const roomUrl = await createRoom(host, { name: `E2E GuestNotes ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await guest.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' }).fill('shared notes from guest')

  await expect(host.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })).toHaveValue(
    'shared notes from guest',
    { timeout: 15_000 }
  )

  await guest.close()
  await host.close()
})
