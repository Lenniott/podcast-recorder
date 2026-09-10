import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  joinAsGuest,
  roomTabsReady,
  trackLiveSockets
} from './helpers.js'

/**
 * The Transcript as a personal facet of the right-hand panel (ADR-0008,
 * ticket 06) — was tests/playwright/transcript_tab.spec.js, when it was a
 * pill in the main tab strip and a room-shared view.
 *
 * Two things are being proved together, and they pull in opposite
 * directions on purpose: the Turns themselves are still room-shared,
 * ordered and replayed exactly as ADR-0002 requires, while *looking* at
 * them is not shared at all.
 */

/**
 * Drives a `transcript_line` message straight over the room's live
 * WebSocket, exactly as a real client would — no microphone, no mocking,
 * see helpers.js's trackLiveSockets/window.__prLiveSockets.
 */
async function sendTranscriptLine(page, { speaker, text }) {
  await page.evaluate(
    ({ speaker, text }) => {
      window.__prLiveSockets[0].send(JSON.stringify({ type: 'transcript_line', speaker, text }))
    },
    { speaker, text }
  )
}

const transcriptFacetButton = (page) => page.getByTestId('facet-transcript')
const annotationsFacetButton = (page) => page.getByTestId('facet-annotations')

test('Transcript: a panel facet, read-only, shared in order between peers', async ({ browser }) => {
  const host = await browser.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'transcript-test'
  const roomUrl = await createRoom(host, { name: `E2E Transcript ${Date.now()}`, password })

  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  // ── No Transcript pill in the main tab strip any more ───────────────
  await expect(host.locator('.tab-pill', { hasText: 'Transcript' })).toHaveCount(0)

  // ── It lives in the right-hand panel, alongside the Annotation feed ─
  await expect(transcriptFacetButton(host)).toBeVisible()
  await expect(annotationsFacetButton(host)).toBeVisible()

  // ── Opening it leaves the main stage (video + Notes) exactly where it
  //    was — this is a reference surface you dip into, not a place you sit
  await transcriptFacetButton(host).click()
  await expect(
    host.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })
  ).toBeVisible()
  await expect(host.getByText('No transcript yet')).toBeVisible()

  // ── A driven line is appended, speaker-labeled, and shared with the
  //    other peer in the same order ────────────────────────────────────
  await sendTranscriptLine(host, { speaker: 'Host', text: 'Welcome to the show.' })
  await sendTranscriptLine(host, { speaker: 'Guest', text: 'Thanks for having me.' })

  await expect(host.locator('.transcript-line')).toHaveCount(2)
  await expect(host.locator('.transcript-line').nth(0)).toContainText('Host')
  await expect(host.locator('.transcript-line').nth(0)).toContainText('Welcome to the show.')
  await expect(host.locator('.transcript-line').nth(1)).toContainText('Guest')
  await expect(host.locator('.transcript-line').nth(1)).toContainText('Thanks for having me.')

  // The guest's browser never sent anything — it must see the exact same
  // ordered, labeled lines purely from the server's broadcast, once they
  // open their own copy of the facet.
  await transcriptFacetButton(guest).click()
  await expect(guest.locator('.transcript-line')).toHaveCount(2)
  await expect(guest.locator('.transcript-line').nth(0)).toContainText('Welcome to the show.')
  await expect(guest.locator('.transcript-line').nth(1)).toContainText('Thanks for having me.')

  // ── A late joiner gets the full replay, in order ─────────────────────
  await guest.close() // free a slot — room is capped at 2 connections
  const late = await guestContext.newPage()
  await stubYouTubeApi(late)
  await late.goto(roomUrl)
  await roomTabsReady(late)

  await transcriptFacetButton(late).click()
  await expect(late.locator('.transcript-line')).toHaveCount(2)
  await expect(late.locator('.transcript-line').nth(0)).toContainText('Welcome to the show.')
  await expect(late.locator('.transcript-line').nth(1)).toContainText('Thanks for having me.')

  await late.close()
  await host.close()
  await guestContext.close()
})

test('which facet you are looking at is personal — a co-host opening the Transcript never moves your screen', async ({ browser }) => {
  // The inverse of what this file used to assert. Switching to the
  // Transcript was a room-shared tab_switch; ADR-0008 retired that
  // precisely so nobody's screen jumps because their co-host glanced at
  // something (see CONTEXT.md's **Transcript**).
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'transcript-local-facet'
  const roomUrl = await createRoom(host, { name: `E2E TranscriptFacet ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  // Both start on the Annotation feed.
  await expect(annotationsFacetButton(host)).toHaveAttribute('aria-pressed', 'true')
  await expect(annotationsFacetButton(guest)).toHaveAttribute('aria-pressed', 'true')

  await guest.getByTestId('facet-transcript').click()
  await expect(transcriptFacetButton(guest)).toHaveAttribute('aria-pressed', 'true')

  // The host's own panel is untouched, and stays untouched. Given a moment
  // for any (nonexistent) broadcast to land, the host is still on the
  // Annotation feed, and their main stage never moved either.
  await host.waitForTimeout(1000)
  await expect(annotationsFacetButton(host)).toHaveAttribute('aria-pressed', 'true')
  await expect(transcriptFacetButton(host)).toHaveAttribute('aria-pressed', 'false')
  await expect(host.locator('.tab-pill.active')).toContainText('Tab 1')
  await expect(
    host.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })
  ).toBeVisible()

  await guest.close()
  await host.close()
})

test('highlighting a Turn offers the same Comment popup Notes has, and files the Annotation against the Transcript', async ({ browser }) => {
  const host = await browser.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'transcript-highlight'
  const roomUrl = await createRoom(host, { name: `E2E TurnHighlight ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await transcriptFacetButton(host).click()
  await sendTranscriptLine(host, { speaker: 'Host', text: 'We recorded this in the summer.' })
  await expect(host.locator('.transcript-line')).toHaveCount(1)

  // Select the Turn's text — the same gesture Notes takes, on a different
  // registered surface.
  await host.evaluate(() => {
    const el = document.querySelector('.transcript-turn-text')
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })

  // The complete popup, identical to the one Notes text raises.
  // Two visible "Comment" controls share the popup: the action that opens
  // the form, and the form's submit. Same split as annotation_highlight.
  const popup = host.getByTestId('selection-popup')
  await expect(popup).toBeVisible()
  await popup.locator('[data-action-id="comment"]').click()
  await host.getByTestId('selection-comment-input').fill('check this date')
  await popup.locator('button[type="submit"]').click()

  // The feed lives on the Annotations facet; the Transcript facet only
  // draws the quote back onto the Turn. Flip to the feed to see the row —
  // filing a Comment does not move this browser's facet (ADR-0008).
  await annotationsFacetButton(host).click()
  await expect(host.getByTestId('annotation')).toHaveCount(1)
  await expect(host.getByTestId('annotation')).toContainText('We recorded this in the summer.')
  await expect(host.getByTestId('annotation')).toContainText('check this date')
  await expect(guest.getByTestId('annotation')).toHaveCount(1, { timeout: 15_000 })
  await expect(guest.getByTestId('annotation')).toContainText('check this date')

  // The quote is drawn back onto the Turn it came from.
  await transcriptFacetButton(host).click()
  await expect(host.locator('.transcript-line mark.turn-highlight')).toHaveCount(1)

  await guest.close()
  await host.close()
})
