import { test, expect } from '@playwright/test'

test('wrong site password shows an error', async ({ page }) => {
  await page.goto('/')
  const field = page.getByRole('textbox', { name: 'Site Password' })
  test.skip(!(await field.isVisible()), 'site gate is off')

  await field.fill('not-the-password')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByText('Wrong password.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible()
})
