import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('shared notes stay in the textarea after typing', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E Notes ${Date.now()}`, password: 'notes' })

  const notes = page.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })
  await notes.fill('Here are some notes')
  await expect(notes).toHaveValue('Here are some notes')
})
