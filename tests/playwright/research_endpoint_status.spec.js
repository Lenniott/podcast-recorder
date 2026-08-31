import { test, expect } from '@playwright/test'
import { createRoom, stubYouTubeApi } from './helpers.js'

/**
 * Exercises POST /rec/[slug]/research directly (no UI yet — tickets 04-06
 * build that), for every status code this e2e environment can produce for
 * real without a paid OpenRouter key: 401/410/400 (auth/room/validation),
 * and 500 "not configured" (OPENROUTER_API_KEY is deliberately left blank
 * for the e2e server — see playwright.config.js).
 *
 * 200 (success), 502 (upstream error), and 504 (timeout) all depend on
 * controlling what OpenRouter itself returns, which isn't available here —
 * those get tested at the UI layer instead, once it exists, via
 * `mockResearchEndpoint()` (helpers.js), which fakes the same route inside
 * the browser with `page.route()` rather than hitting it for real.
 *
 * 429 (rate limit) isn't route-specific — this endpoint inherits the same
 * global per-IP POST limiter every other route already gets
 * (hooks.server.js), which is already unit-tested generically
 * (tests/unit/hooks.server.test.js). Deliberately not re-proven here: this
 * suite runs with MAX_POSTS_PER_MIN raised to 200 precisely so normal e2e
 * traffic doesn't trip it, and hammering it in one spec would risk 429s
 * leaking into whatever POST request (room creation, etc.) another spec
 * makes in the same rolling minute.
 */

test('rejects an unauthenticated request with 410 for an unknown room', async ({ request }) => {
  const res = await request.post('/rec/no-such-room-slug/research', {
    data: { kind: 'quickAction', actionId: 'define', text: 'hello' }
  })
  expect(res.status()).toBe(410)
})

test('rejects a request with no session cookie with 401 for a real room', async ({ browser, request }) => {
  const setup = await browser.newPage()
  await stubYouTubeApi(setup)
  const roomUrl = await createRoom(setup, { name: `E2E ResearchAuth ${Date.now()}`, password: 'research-401' })
  const slug = new URL(roomUrl).pathname.split('/').pop()
  await setup.close()

  // The bare `request` fixture has its own cookie jar, isolated from any
  // page/context — exactly "no session" for this room.
  const res = await request.post(`/rec/${slug}/research`, {
    data: { kind: 'quickAction', actionId: 'define', text: 'hello' }
  })
  expect(res.status()).toBe(401)
})

test('rejects a malformed body with 400 for an authenticated participant', async ({ browser }) => {
  const page = await browser.newPage()
  await stubYouTubeApi(page)
  const roomUrl = await createRoom(page, { name: `E2E ResearchBadBody ${Date.now()}`, password: 'research-400' })
  const slug = new URL(roomUrl).pathname.split('/').pop()

  // page.request shares this page's real cookie jar (the room's session
  // cookie createRoom just obtained) — a real authenticated call.
  const res = await page.request.post(`/rec/${slug}/research`, {
    data: { kind: 'not-a-real-kind' }
  })
  expect(res.status()).toBe(400)

  await page.close()
})

test('returns 500 "not configured" for a valid request when no API key is set', async ({ browser }) => {
  const page = await browser.newPage()
  await stubYouTubeApi(page)
  const roomUrl = await createRoom(page, { name: `E2E ResearchNoKey ${Date.now()}`, password: 'research-500' })
  const slug = new URL(roomUrl).pathname.split('/').pop()

  const res = await page.request.post(`/rec/${slug}/research`, {
    data: { kind: 'quickAction', actionId: 'define', text: 'a valid request with nowhere to actually go' }
  })
  expect(res.status()).toBe(500)
  const body = await res.json()
  expect(body.error).toBe('NOT_CONFIGURED')

  await page.close()
})
