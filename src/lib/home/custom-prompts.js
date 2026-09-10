// Custom Prompts (see CONTEXT.md, ADR-0008) — shared shape rules for the
// deployment-wide list that replaced the single Research Prompt. Storage
// lives in db.js; this module holds only what the Usage Dashboard editor and
// the form action both need to agree on, so a browser-side maxlength and the
// server-side check that backstops a POST skipping it can't drift apart.

/** Capped so a title still fits the small button a prompt is triggered from. */
export const CUSTOM_PROMPT_TITLE_MAX_LENGTH = 40

/**
 * Validates one submitted Custom Prompt. Returns a user-facing message, or
 * '' when the pair is fine.
 */
export function validateCustomPrompt({ title, prompt }) {
  const cleanTitle = String(title ?? '').trim()
  if (!cleanTitle) return 'Title is required'
  if (cleanTitle.length > CUSTOM_PROMPT_TITLE_MAX_LENGTH) {
    return `Title too long (max ${CUSTOM_PROMPT_TITLE_MAX_LENGTH} chars)`
  }
  if (!String(prompt ?? '').trim()) return 'Prompt text is required'
  return ''
}

// Per-prompt output format (structured-research-output ticket 02, see
// research-blocks.js) — 'text' is today's freeform reply, unchanged; 'blocks'
// asks the model for typed, renderable containers instead. Shared by the
// editor (the toggle's allowed values) and db.js (normalizing whatever a row
// or a form submission actually contains) so the two can't drift on what a
// legal value is. An unrecognized value — an old row from before this field
// existed, a tampered form post — normalizes to 'text', never a crash: the
// same "unknown resolves to the safe default" rule Placeholders themselves
// already follow.
export const CUSTOM_PROMPT_OUTPUT_FORMATS = ['text', 'blocks']

export function normalizeOutputFormat(value) {
  return CUSTOM_PROMPT_OUTPUT_FORMATS.includes(value) ? value : 'text'
}

/**
 * The Placeholders a prompt author can write, with the one-line description
 * the editor shows. Kept in step with the substitution engine's own set by
 * a unit test rather than by hand — research-assistant.js is server-only
 * (it imports $env/dynamic/private), so this list can't just import it.
 */
export const PLACEHOLDER_HELP = [
  { name: 'selection', description: 'the excerpt that triggered this prompt' },
  { name: 'current_tab', description: "the video title (if loaded) then the tab's notes" },
  { name: 'video_title', description: 'the video title alone, without notes' },
  { name: 'transcript', description: 'the whole room Transcript so far' },
  { name: 'latest_transcript', description: 'the last ~700 words of the Transcript' },
  { name: 'current_time', description: 'wall-clock time when the prompt runs' }
]
