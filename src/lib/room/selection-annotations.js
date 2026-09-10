/**
 * Highlight → Custom Prompt → Card Annotation, the decision half
 * (ADR-0008, ticket 05).
 *
 * ─── SURFACE-AGNOSTIC ON PURPOSE (read this before ticket 06) ───────────
 * Nothing in this module knows what a "Notes editor" is. A *surface* is any
 * `{ el, tabId }` pair — any DOM element whose text may be highlighted, and
 * the tab an Annotation made from it should be filed under. The quote comes
 * from the browser's own Selection (`selection.toString()`, via
 * selection-popup.js's `selectionText`), which is identical whether the
 * highlighted text sits in a contenteditable, a <p>, a <li> or a Transcript
 * Turn. So `{selection}` resolves the same way from any of them.
 *
 * Ticket 06 (highlight a Transcript Turn) therefore adds a *surface*, not a
 * code path: push `{ el: transcriptEl, tabId: … }` into the array the popup
 * host passes to `resolveSelectionSurface`, and the popup, the quote, the
 * Custom Prompt buttons and `annotation_ask` all work unchanged. The only
 * thing tied to a component today is where the popup is *hosted*
 * (RoomTabs.svelte) — if the Transcript ends up outside that component's
 * subtree, that host moves; the logic below does not.
 *
 * Pure: no DOM globals, no WS, no Svelte. The caller reads the live
 * Selection and does the sending — same split as selection-popup.js.
 */

/** Prefix that turns a Custom Prompt id into a popup action id. Namespaced
 *  so a prompt id can never collide with a built-in action id like
 *  "comment", no matter what the database generates. */
export const PROMPT_ACTION_PREFIX = 'prompt:'

/** The popup action id for one Custom Prompt. */
export function promptActionId(customPromptId) {
  return `${PROMPT_ACTION_PREFIX}${customPromptId}`
}

/** The Custom Prompt id behind a popup action id, or null if that action
 *  isn't a Custom Prompt at all (e.g. "comment"). */
export function parsePromptActionId(actionId) {
  const id = String(actionId ?? '')
  if (!id.startsWith(PROMPT_ACTION_PREFIX)) return null
  return id.slice(PROMPT_ACTION_PREFIX.length) || null
}

/**
 * One SelectionPopup action descriptor per configured Custom Prompt that
 * actually runs on a highlight — the `{id, label, title, disabled}` shape
 * SelectionPopup.svelte's header comment specifies (it never branches on an
 * id, so this is data, not markup).
 *
 * Only a prompt whose own template references `{selection}` (`usesSelection`
 * on the summary — see db.js's listCustomPromptSummaries) gets a button
 * here: one that doesn't has nothing to run against a highlight, so it has
 * no business appearing in a menu that only exists because something is
 * highlighted. That prompt instead gets a standalone button in the Research
 * panel — see research-panel.js's panelPromptButtons, the mirror image of
 * this function. A prompt is never offered in both places, and never in
 * neither: usesSelection is a plain boolean, not a judgment call either
 * function makes twice.
 *
 * Every *eligible* prompt gets a button, including when the viewer cannot
 * run it: without Guest Research Access the buttons render `disabled` with
 * an explanatory title rather than vanishing, so a guest can see the show's
 * prompts exist and why they can't fire one — the same reasoning behind
 * showing a gated participant the research panel at all.
 *
 * @param {{id:string,title:string,usesSelection?:boolean}[]} prompts — listCustomPromptSummaries()
 * @param {{canRun?:boolean, icon?:any}} options
 */
export function customPromptActions(prompts, { canRun = false, icon = null } = {}) {
  return (prompts || [])
    .filter((p) => p?.id && p.usesSelection && String(p?.title ?? '').trim())
    .map((p) => {
      const label = String(p.title).trim()
      return {
        id: promptActionId(p.id),
        label,
        icon,
        disabled: !canRun,
        title: canRun
          ? `Run “${label}” on the highlighted text`
          : 'Only the host can run a prompt in this room',
        ariaLabel: `Run ${label} on the highlighted text`
      }
    })
}

/**
 * Which registered surface (if any) the live selection is inside.
 *
 * Element containment, nothing else — so this works for a contenteditable,
 * a rendered Transcript, or anything a later ticket registers. Returns the
 * surface entry itself (so the caller gets its `tabId` too) or null when
 * the selection is elsewhere on the page, which is what "don't show the
 * popup" means.
 */
export function resolveSelectionSurface(surfaces, selection) {
  if (!selection || !selection.rangeCount) return null
  const node = selection.anchorNode
  if (!node) return null
  for (const surface of surfaces || []) {
    const el = surface?.el
    if (!el || !surface.tabId) continue
    if (node === el || el.contains?.(node) === true) return surface
  }
  return null
}

/**
 * The `annotation_ask` payload for one Custom Prompt fired from a highlight
 * (see ws-rooms.js's protocol comment for the wire contract).
 *
 * The context fields are Placeholder *ingredients* only — the server
 * resolves the prompt's template by id and keeps just the ones that
 * template actually references (see research-assistant.js's
 * buildCustomPromptRequest). This is deliberately the opposite of the old
 * single-Custom button, which always shipped the whole active tab: a prompt
 * written to reference only `{selection}` must never be handed the
 * surrounding Notes, because that is exactly the leak ADR-0008 was written
 * about (a whole lyric as grounding produced interpretation the hosts had
 * not aired yet).
 *
 * `quote` is the frozen excerpt captured when the highlight was made — it
 * becomes both the Annotation's permanent quote and `{selection}`'s value,
 * and is never re-derived from the DOM at send time.
 */
export function buildAnnotationAskPayload({
  id,
  tabId,
  customPromptId,
  quote,
  currentTab = '',
  transcript = '',
  videoTitle = ''
}) {
  if (!id || !tabId || !customPromptId) return null
  const excerpt = String(quote ?? '').trim()
  if (!excerpt) return null
  return {
    type: 'annotation_ask',
    tabId,
    id,
    kind: 'card',
    customPromptId,
    quote: excerpt,
    currentTab: String(currentTab ?? ''),
    transcript: String(transcript ?? ''),
    videoTitle: String(videoTitle ?? '').trim()
  }
}

/** Formats the room's Transcript lines the way `{transcript}` expects —
 *  the same "Speaker: text" join research-panel.js uses, kept here so a
 *  highlight-triggered prompt and the panel's own asks can't drift. */
export function formatTranscriptForPrompt(lines) {
  return (lines || []).map((line) => `${line.speaker}: ${line.text}`).join('\n')
}
