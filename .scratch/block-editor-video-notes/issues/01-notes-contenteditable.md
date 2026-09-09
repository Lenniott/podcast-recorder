# 01 — Notes editing surface becomes contenteditable

**Read first:** `docs/adr/0008-selection-anchored-annotations-and-user-authored-prompts.md` (why this whole feature exists) and `CONTEXT.md`'s **Block** entry (explains that Notes was long expected to eventually need this exact swap, and why it does *not* mean Notes becomes an array of Blocks — it stays one continuous freeform text surface).

**What to build:** The Notes editing surface (the shared, room-wide freeform text area a host/guest types lyrics or notes into) moves from a plain `<textarea>` to a `contenteditable` element, with **zero user-visible behavior change**. Same debounced last-write-wins sync to every other participant, same text-size controls, same placeholder copy, same accessibility label. This ticket adds no new feature — it is the prefactor every later ticket in this line needs, because a `<textarea>` gives the browser no way to anchor a floating popup to an arbitrary highlighted span inside it, and `contenteditable` does.

**Where to look:** The existing Notes surface (and its text-size toolbar) lives in `RoomTabs.svelte` — find the shared-textarea markup and its outbound debounce/sync handler (keys off the textarea's `.value`) and inbound apply-from-broadcast path (a plain `value={...}` binding). Reproduce the same debounce timing and last-write-wins semantics on `contenteditable`, reading `textContent`/`innerText` instead of `.value`. The one real risk: a plain textarea's `value` binding in Svelte only touches the DOM when the bound value actually changes, so a participant's own in-progress typing is never disturbed by an *unrelated* peer update landing mid-keystroke — a naive `contenteditable` re-render on every inbound broadcast will fight the local cursor. Make sure whatever inbound-apply logic you write doesn't clobber the DOM while this browser's own selection/cursor is inside the element.

**Blocked by:** None — can start immediately.

**Hands off to the next ticket:** Ticket 03 needs to attach a `selectionchange`/`mouseup` listener to this same element and read `window.getSelection()` against it, then position a floating popup near the selection. Document (in your commit/PR) how the contenteditable element is exposed for that — a `bind:this` reference, an id, whatever pattern you use — so ticket 03 doesn't have to rediscover it.

**Status:** ready-for-agent

- [ ] Typing in Notes syncs to other participants within the same debounce window as before.
- [ ] Rejoining/reconnecting still replays the tab's current text correctly (the existing `tabs_sync` path is unaffected).
- [ ] The text-size toolbar still applies to the contenteditable content.
- [ ] A participant's own typing is never interrupted or cursor-jumped by an incoming peer edit.
- [ ] Existing tests covering Notes text sync pass; any test that specifically assumed a `<textarea>` element is updated, not deleted, unless it's now meaningless.
