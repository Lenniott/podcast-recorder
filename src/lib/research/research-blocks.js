/**
 * Block schema — the structured-output alternative to a Custom Prompt's
 * default freeform reply (research-card.js). Proactive fix for the same
 * problem stripUnrenderedMarkup patches reactively there: a reply is always
 * rendered as real markup here, not text a reader has to parse themselves,
 * because the model was never given the option to emit `**bold**`/`*`
 * bullets/bracket citation stubs in the first place.
 *
 * Three block types, deliberately minimal (extend later if real usage shows
 * a gap, don't design more up front):
 *   { type: 'paragraph', text }       — a plain line of prose
 *   { type: 'list', items: [...] }    — an unordered list
 *   { type: 'stat', label, value }    — a short labeled callout
 *
 * response_format below uses OpenRouter/OpenAI's `strict: true` json_schema
 * mode — constrained decoding, not a request the model can decline. That
 * means no "validate then retry against the model" loop is needed the way
 * a naive JSON-in-the-prompt approach would require: the model cannot
 * produce a reply that fails this schema. Every block property is still
 * declared nullable and listed in `required` (strict mode requires every
 * declared property to be required) rather than using a `oneOf`/`anyOf`
 * discriminated union — broader provider/model compatibility than relying
 * on every possible upstream model supporting that keyword under strict
 * mode, at the cost of the model emitting a few nulls per block. Sanitizing
 * on the way back in (sanitizeBlock) doesn't trust that compliance blindly
 * anyway — same "app-side guard over model compliance" discipline
 * research-card.js already uses for citation stripping.
 *
 * This module owns the schema and the parse-back-in step only. Whether a
 * given Custom Prompt actually requests this format lives on the request
 * object itself (research-assistant.js's `outputFormat`), not here.
 */

const BLOCK_TYPES = ['paragraph', 'list', 'stat']

function blockItemSchema() {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: BLOCK_TYPES },
      text: { type: ['string', 'null'] },
      items: { type: ['array', 'null'], items: { type: 'string' } },
      label: { type: ['string', 'null'] },
      value: { type: ['string', 'null'] }
    },
    required: ['type', 'text', 'items', 'label', 'value'],
    additionalProperties: false
  }
}

/** The `response_format` to attach to an OpenRouter request that wants
 *  structured Block output instead of freeform text. */
export function blocksResponseSchema() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'research_blocks',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          blocks: { type: 'array', items: blockItemSchema() }
        },
        required: ['blocks'],
        additionalProperties: false
      }
    }
  }
}

/** Sanitizes one block from a parsed reply. Returns null for an
 *  unrecognized type or one whose required content is blank — the model
 *  signals "nothing here" the same way empty-mainTakeaway already does for
 *  freeform replies, just per-block instead of for the whole reply. */
function sanitizeBlock(raw) {
  const type = raw?.type
  if (type === 'paragraph') {
    const text = String(raw.text ?? '').trim()
    return text ? { type, text } : null
  }
  if (type === 'list') {
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
    return items.length ? { type, items } : null
  }
  if (type === 'stat') {
    const label = String(raw.label ?? '').trim()
    const value = String(raw.value ?? '').trim()
    return label && value ? { type, label, value } : null
  }
  return null
}

/**
 * Parses a model reply into a sanitized Block array, or null when there is
 * nothing to report — an empty/missing `blocks` array, every block sanitizing
 * away to nothing, or `raw` not being (or not containing) valid JSON at all.
 * Never throws: a malformed reply here is "nothing to report," not a crash.
 */
export function parseBlocks(raw) {
  if (raw == null) return null
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
  const list = Array.isArray(parsed?.blocks) ? parsed.blocks : null
  if (!list) return null
  const sanitized = list.map(sanitizeBlock).filter(Boolean)
  return sanitized.length ? sanitized : null
}

/**
 * Flattens a Block array to a plain-text approximation — for anything that
 * only knows how to read a flat string (the Eval Log's existing `card`
 * shape, a future export). This is a fallback rendering, not the canonical
 * one: a caller that can render Blocks natively (ticket 03) should always
 * prefer the Block array itself over this text.
 */
export function flattenBlocksToText(blocks) {
  if (!blocks?.length) return ''
  return blocks
    .map((block) => {
      if (block.type === 'paragraph') return block.text
      if (block.type === 'list') return block.items.map((item) => `• ${item}`).join('\n')
      if (block.type === 'stat') return `${block.label}: ${block.value}`
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}
