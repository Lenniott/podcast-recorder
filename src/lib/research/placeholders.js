/**
 * The Placeholder name → request-field key map, and which Placeholders a
 * given template text actually references (see CONTEXT.md's **Placeholder**
 * and ADR-0008's "only carry what's referenced" rule).
 *
 * Pure and dependency-free (no `$env`, no Node builtins, no other project
 * module) so it can be imported from wherever a Placeholder name needs to be
 * recognized — `research-assistant.js` (server-only: resolves values into a
 * real request) and `db.js` (server: needs to know whether a stored
 * template references `{selection}`, but must never import
 * research-assistant.js — that module imports `recordResearchUsage` from
 * `db.js` itself, so the reverse import would be a cycle). Split out for
 * that reason alone; `research-assistant.js` re-exports `PLACEHOLDER_NAMES`
 * so existing importers of it are unaffected.
 */

// A placeholder with no value supplied (e.g. `{transcript}` before any
// transcript exists, or `{selection}` when the prompt wasn't triggered from
// a highlight) resolves to '' — silently, not an error: the prompt's own
// author is what decides whether that's worth noting. Text that isn't a
// known placeholder is left exactly as written, so prose containing braces
// survives untouched.
export const PLACEHOLDERS = {
  current_tab: 'currentTab',
  transcript: 'transcript',
  selection: 'selection',
  video_title: 'videoTitle',
  current_time: 'currentTime',
  latest_transcript: 'latestTranscript'
}

/** The Placeholder names a prompt author can write, for UI/docs to list. */
export const PLACEHOLDER_NAMES = Object.keys(PLACEHOLDERS)

/**
 * The Placeholder names a template actually writes (unknown `{words}` are
 * ignored, exactly as applyPlaceholders leaves them alone). Counts a name
 * used only inside a `{#if name}` condition (see research-assistant.js's
 * resolveConditionalBlocks) as referenced too — evaluating that condition
 * needs the ingredient just as much as interpolating `{name}` does, and
 * skipping it here would mean buildCustomPromptRequest silently withholds
 * the one value the condition needs to ever come out true.
 */
export function referencedPlaceholders(template) {
  const text = String(template || '')
  const names = new Set()
  for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
    if (PLACEHOLDERS[name]) names.add(name)
  }
  for (const [, name] of text.matchAll(/\{#if\s+(\w+)\}/g)) {
    if (PLACEHOLDERS[name]) names.add(name)
  }
  return names
}

/**
 * Whether a Custom Prompt's own template references `{selection}` — the
 * one fact that decides where a prompt's button appears (see
 * `db.js`'s `listCustomPromptSummaries`): a prompt that references it can
 * only ever mean something run against a highlighted excerpt, so it belongs
 * in the highlight popup and nowhere else; a prompt that doesn't has no
 * excerpt to run against, so it belongs in the panel as a standalone
 * button instead. Built on referencedPlaceholders rather than a separate
 * regex so the two can never disagree about what counts as "references
 * `{selection}`" (a bare `{selection}` and one used only inside
 * `{#if selection}` both count, identically).
 */
export function promptReferencesSelection(template) {
  return referencedPlaceholders(template).has('selection')
}
