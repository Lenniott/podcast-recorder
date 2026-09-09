import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest } from './helpers.js'

/**
 * An Annotation's highlight is re-located from its frozen quote every time
 * the Notes text is drawn (ADR-0008, ticket 04). These cover what the pure
 * unit tests in tests/unit/notes-highlights.test.js can't: that the
 * highlight really is painted over the live contenteditable, follows edits
 * made around it, and *disappears* — rather than sliding somewhere wrong —
 * the moment the quoted phrase itself is edited away.
 */

const notesOf = (page) =>
  page.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })

const highlightsOf = (page) => page.locator('[data-testid="notes-highlight-layer"] mark')

/** Highlights `phrase` inside the Notes surface the way a person would,
 *  driving the same selectionchange the popup listens for. */
async function selectInNotes(page, phrase) {
  const found = await page.evaluate((needle) => {
    const el = document.querySelector('[data-notes-editor]')
    if (!el) return false
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(needle)
      if (index === -1) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    }
    return false
  }, phrase)
  expect(found).toBe(true)
}

/** The viewport rect of `phrase` as the *editable* text really renders it —
 *  what the highlight painted behind it has to line up with. */
async function rectOfPhraseInNotes(page, phrase) {
  return page.evaluate((needle) => {
    const el = document.querySelector('[data-notes-editor]')
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(needle)
      if (index === -1) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      const { top, left, width, height } = range.getBoundingClientRect()
      return { top, left, width, height }
    }
    return null
  }, phrase)
}

async function commentOnSelection(page, comment) {
  const popup = page.locator('[data-testid="selection-popup"]')
  await expect(popup).toBeVisible()
  await popup.locator('[data-action-id="comment"]').click()
  await page.locator('[data-testid="selection-comment-input"]').fill(comment)
  await popup.locator('button[type="submit"]').click()
}

test('a Comment highlights its quote, survives edits around it, and vanishes when the quote is edited away', async ({
  page
}) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E Highlight ${Date.now()}`, password: 'highlight-test' })

  const notes = notesOf(page)
  await notes.click()
  await page.keyboard.type('we talked about the moon landing today')

  await selectInNotes(page, 'the moon landing')
  await commentOnSelection(page, 'check the date on this')

  // The panel row lands, and the highlight is drawn over the quoted words.
  await expect(page.locator('.annotation-quote')).toHaveText('the moon landing')
  await expect(highlightsOf(page)).toHaveText(['the moon landing'])

  // ── Editing outside the quoted span leaves the highlight alone ────────
  await notes.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(', which we should fact-check')
  await expect(notes).toHaveText('we talked about the moon landing today, which we should fact-check')
  await expect(highlightsOf(page)).toHaveText(['the moon landing'])

  // ── Editing the quoted phrase itself removes the highlight entirely ───
  await selectInNotes(page, 'moon')
  await page.keyboard.type('mars')
  await expect(notes).toContainText('the mars landing')
  await expect(highlightsOf(page)).toHaveCount(0)

  // …and the Annotation is still listed, with the quote it was made
  // against — the panel never pretends the phrase is still in the text,
  // and never quietly rewrites what was said.
  await expect(page.locator('.annotation-quote')).toHaveText('the moon landing')

  // Typing the phrase back re-anchors it: the match is recomputed from the
  // frozen quote every render, so nothing had to be repaired to get here.
  await selectInNotes(page, 'mars')
  await page.keyboard.type('moon')
  await expect(highlightsOf(page)).toHaveText(['the moon landing'])
})

test('the highlight is drawn over the quoted words themselves, including on a later line', async ({
  page
}) => {
  // The highlights live in a mirror layer behind the contenteditable rather
  // than as markup inside it, so "the right characters" is not the same
  // claim as "the right place on screen". Line breaks are where a mirror
  // most plausibly drifts (a contenteditable stores them as <div>s, the
  // mirror renders them as newlines under white-space: pre-wrap), so the
  // quote here deliberately sits on the third line.
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E HighlightBox ${Date.now()}`, password: 'highlight-box' })

  const notes = notesOf(page)
  await notes.click()
  await page.keyboard.type('first line of notes')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second line, a bit longer than the first one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('we talked about the moon landing today')

  await selectInNotes(page, 'the moon landing')
  await commentOnSelection(page, 'check the date on this')
  await expect(highlightsOf(page)).toHaveText(['the moon landing'])

  const painted = await highlightsOf(page).first().boundingBox()
  const words = await rectOfPhraseInNotes(page, 'the moon landing')
  expect(Math.abs(painted.x - words.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(painted.width - words.width)).toBeLessThanOrEqual(1)
  // Vertically the mark's box is the line box, so it need only overlap the
  // text's own rect rather than match it exactly — but it must be *this*
  // line, not the one above or below.
  expect(painted.y).toBeLessThanOrEqual(words.top + 1)
  expect(painted.y + painted.height).toBeGreaterThanOrEqual(words.top + words.height - 1)
})

test("the other participant's edit takes the highlight away on both screens", async ({ browser }) => {
  // Notes text is shared and last-write-wins, so the person who made a
  // Comment is not the only one who can invalidate its anchor. This is the
  // inbound-paint path (a peer's tab_text landing on our surface), not the
  // local-keystroke one the first spec covers.
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'highlight-peer'
  const roomUrl = await createRoom(host, { name: `E2E HighlightPeer ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await notesOf(host).click()
  await host.keyboard.type('we talked about the moon landing today')
  await expect(notesOf(guest)).toHaveText('we talked about the moon landing today', { timeout: 15_000 })

  await selectInNotes(host, 'the moon landing')
  await commentOnSelection(host, 'check the date on this')
  await expect(highlightsOf(host)).toHaveText(['the moon landing'])
  // The guest sees it too — the Annotation is room state, not a local mark.
  await expect(highlightsOf(guest)).toHaveText(['the moon landing'], { timeout: 15_000 })

  // The guest rewrites the quoted phrase out of the text.
  await notesOf(guest).fill('we talked about something else entirely')

  await expect(highlightsOf(guest)).toHaveCount(0, { timeout: 15_000 })
  await expect(highlightsOf(host)).toHaveCount(0, { timeout: 15_000 })
  // Both panels still list the Comment against what was actually said.
  await expect(host.locator('.annotation-quote')).toHaveText('the moon landing')
  await expect(guest.locator('.annotation-quote')).toHaveText('the moon landing')

  await guest.close()
  await host.close()
})
