import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest } from './helpers.js'

// The Notes editing surface is a contenteditable element rather than a
// <textarea> (ADR-0008). These cover the two things that swap put at risk
// and that a plain "text syncs" spec would not catch.

const notesOf = (page) =>
  page.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('the text-size toolbar still sizes the Notes surface', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E NotesSize ${Date.now()}`, password: 'notes-size' })

  const notes = notesOf(page)
  await expect(notes).toHaveCSS('font-size', '16px') // the default

  const sizes = page.getByRole('group', { name: 'Notes text size' })
  await sizes.getByRole('button', { name: '20', exact: true }).click()
  await expect(notes).toHaveCSS('font-size', '20px')

  await sizes.getByRole('button', { name: '14', exact: true }).click()
  await expect(notes).toHaveCSS('font-size', '14px')
})

test("a peer's edit landing mid-keystroke never clobbers this browser's own typing", async ({
  browser
}) => {
  // The one real risk in the textarea → contenteditable swap. A textarea's
  // `value={...}` binding only touched the DOM when the value changed, so an
  // unrelated peer update mid-typing left the typist alone; a contenteditable
  // re-rendered on every inbound broadcast would fight the local cursor.
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'notes-race'
  const roomUrl = await createRoom(host, { name: `E2E NotesRace ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  const hostNotes = notesOf(host)
  await hostNotes.click()

  // Type slower than a keystroke but faster than the 300ms outbound debounce,
  // so the host has unsent keystrokes and a live caret for the whole window.
  const typing = host.keyboard.type('abcdef', { delay: 120 })
  // …and drop the guest's edit into the middle of it. The guest's own 300ms
  // debounce puts it on the wire around 450ms in, with the host still typing.
  await wait(150)
  await notesOf(guest).fill('GUEST WROTE THIS')
  await typing

  // Nothing spliced, replaced, or reordered: the caret never moved.
  await expect(hostNotes).toHaveText('abcdef', { timeout: 15_000 })
  // And the room converges on it — the host's screen isn't quietly holding a
  // value the room disagrees with.
  await expect(notesOf(guest)).toHaveText('abcdef', { timeout: 15_000 })

  await guest.close()
  await host.close()
})
