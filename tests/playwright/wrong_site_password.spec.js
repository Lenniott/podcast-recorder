import { test, expect } from '@playwright/test'

test('wrong site password shows an error', async ({ page }) => {
  await page.goto('/')
  // Scoped to this form specifically — when FRIEND_PASSWORD is also set,
  // the Friend Password form renders its own "Unlock" button alongside
  // this one, so an unscoped getByRole('button', { name: 'Unlock' }) is
  // ambiguous (Playwright strict mode).
  const form = page.locator('form').filter({ hasText: 'Site Password' })
  const field = form.getByRole('textbox', { name: 'Site Password' })
  test.skip(!(await field.isVisible()), 'site gate is off')

  await field.fill('not-the-password')
  await form.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByText('Wrong password.')).toBeVisible()
  await expect(form.getByRole('button', { name: 'Unlock' })).toBeVisible()
})
