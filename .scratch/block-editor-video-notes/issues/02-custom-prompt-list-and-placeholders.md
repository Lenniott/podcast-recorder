# 02 — Custom Prompt list + expanded Placeholder set

**Read first:** `docs/adr/0008-...md` and `CONTEXT.md`'s **Custom Prompt** and **Placeholder** entries — both were rewritten during the design session and are the authoritative spec for this ticket. Don't re-derive the placeholder list or the scope decision from first principles; they're already settled there. In short: the single global Research Prompt becomes a deployment-wide *list* of named `{title, prompt text}` pairs (same site-password-gated scope as today — not per-room, not host-editable mid-show), and the Placeholder set grows from two (`{current_tab}`, `{transcript}`) to six.

**What to build:**
1. Replace the single-prompt editor on the Usage Dashboard / create-room page with a managed list: create, edit, and delete named Custom Prompts. Each needs a stable identifier (not just its title) — later tickets reference a specific Custom Prompt by id when triggering it from a highlight.
2. Extend the placeholder substitution engine so all six placeholders resolve: the existing `{current_tab}` and `{transcript}` (unchanged), plus four new ones — `{selection}`, `{video_title}`, `{current_time}`, `{latest_transcript}` (last ~700 words of the transcript, distinct from `{transcript}`'s "everything so far"). An unset placeholder (e.g. `{selection}` when nothing triggered this from a highlight) resolves to empty string — silent, not an error, matching the existing rule for placeholders.

This ticket does **not** wire anything to a highlight yet (that's ticket 05) — verify the list CRUD and placeholder substitution in isolation. `{selection}` in particular can only be meaningfully tested once ticket 05 exists; for this ticket, confirm it at least resolves to whatever value is passed in, and to empty string when nothing is.

**Where to look:** Today's single-prompt editor and save action, and the existing two-placeholder substitution function, are the direct ancestors of what this ticket generalizes — find them by searching for the existing `{current_tab}`/`{transcript}` placeholder handling and the create-room page's prompt-saving form. Whatever site-wide config storage backs the single Research Prompt today needs to become a small collection instead of one row/field.

**Blocked by:** None — can start immediately, independent of tickets 01/03/04 (this doesn't touch `RoomTabs.svelte` or the Notes surface at all).

**Hands off to the next ticket:** Ticket 05 needs two things from this ticket, named clearly in your commit/PR: (a) a way to list all configured Custom Prompts (id + title) so a selection popup can render one button per prompt, and (b) a way to resolve one specific Custom Prompt's saved template text by id when it's triggered. Ticket 05 should call these directly rather than re-deriving prompt storage.

**Status:** ready-for-agent

- [ ] Usage Dashboard can create, edit, and delete named Custom Prompts.
- [ ] All six Placeholders resolve correctly wherever prompt text is substituted; an unset one resolves to empty string.
- [ ] `{latest_transcript}` windows to the last ~700 words specifically — not the full transcript, and not some other arbitrary window.
- [ ] Any existing caller that read the old single-prompt shape directly is updated to the new list shape (or explicitly left alone if it's about to be deleted in ticket 07 — say which).
- [ ] Unit test coverage for placeholder substitution, covering all six placeholders including the "unset → empty string" case.
