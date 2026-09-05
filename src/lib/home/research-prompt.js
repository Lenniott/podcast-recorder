// Research Prompt Title (see CONTEXT.md) — the Custom button's label in
// every room. Capped so it fits the panel's small button; the form action
// rejects over-limit POSTs that skip the input's maxlength.

export const RESEARCH_PROMPT_TITLE_MAX_LENGTH = 40

/** Custom is on only when both the Research Prompt and its Title are set. */
export function isCustomEnabled(prompt, title) {
  return String(prompt ?? '').trim() !== '' && String(title ?? '').trim() !== ''
}
