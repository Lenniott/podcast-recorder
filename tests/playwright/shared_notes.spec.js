import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('shared notes stay in the editing surface after typing', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E Notes ${Date.now()}`, password: 'notes' })

  const notes = page.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })
  await notes.fill('Here are some notes')
  // toHaveText, not toHaveValue: the Notes surface is a contenteditable
  // element now, not a <textarea> (ADR-0008) — it has no .value.
  await expect(notes).toHaveText('Here are some notes')
})
