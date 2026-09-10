import { describe, it, expect } from 'vitest'
import {
  blocksResponseSchema,
  parseBlocks,
  flattenBlocksToText,
  sanitizeBlockList
} from '../../src/lib/research/research-blocks.js'

describe('blocksResponseSchema', () => {
  it('is a strict json_schema response_format naming the three block types', () => {
    const schema = blocksResponseSchema()
    expect(schema.type).toBe('json_schema')
    expect(schema.json_schema.name).toBe('research_blocks')
    expect(schema.json_schema.strict).toBe(true)

    const root = schema.json_schema.schema
    expect(root.type).toBe('object')
    expect(root.required).toEqual(['blocks'])
    expect(root.additionalProperties).toBe(false)

    const item = root.properties.blocks.items
    expect(item.properties.type.enum).toEqual(['paragraph', 'list', 'stat'])
    // Strict mode requires every declared property to be required — this is
    // why every field is nullable rather than a discriminated union (see the
    // file's own doc comment for the compatibility rationale).
    expect(item.required.sort()).toEqual(['items', 'label', 'text', 'type', 'value'])
    expect(item.additionalProperties).toBe(false)
  })
})

describe('parseBlocks', () => {
  it('parses a well-formed reply for each of the three block types', () => {
    const raw = JSON.stringify({
      blocks: [
        { type: 'paragraph', text: 'A verdict statement.', items: null, label: null, value: null },
        { type: 'list', text: null, items: ['fact one', 'fact two'], label: null, value: null },
        { type: 'stat', text: null, items: null, label: 'Win rate', value: '62%' }
      ]
    })

    expect(parseBlocks(raw)).toEqual([
      { type: 'paragraph', text: 'A verdict statement.' },
      { type: 'list', items: ['fact one', 'fact two'] },
      { type: 'stat', label: 'Win rate', value: '62%' }
    ])
  })

  it('accepts an already-parsed object, not only a JSON string', () => {
    expect(parseBlocks({ blocks: [{ type: 'paragraph', text: 'x', items: null, label: null, value: null }] }))
      .toEqual([{ type: 'paragraph', text: 'x' }])
  })

  // Empty means "nothing to report" — the same convention as an empty
  // mainTakeaway in research-card.js's normalizeEmptyCard.
  it('returns null for an empty blocks array', () => {
    expect(parseBlocks(JSON.stringify({ blocks: [] }))).toBe(null)
  })

  it('returns null when every block sanitizes away to nothing', () => {
    const raw = JSON.stringify({
      blocks: [
        { type: 'paragraph', text: '   ', items: null, label: null, value: null },
        { type: 'list', text: null, items: [], label: null, value: null },
        { type: 'stat', text: null, items: null, label: '', value: '' }
      ]
    })
    expect(parseBlocks(raw)).toBe(null)
  })

  it('drops only the blocks that sanitize away, keeping the rest', () => {
    const raw = JSON.stringify({
      blocks: [
        { type: 'paragraph', text: '', items: null, label: null, value: null },
        { type: 'paragraph', text: 'A real line.', items: null, label: null, value: null }
      ]
    })
    expect(parseBlocks(raw)).toEqual([{ type: 'paragraph', text: 'A real line.' }])
  })

  it('never throws — malformed input is treated as "nothing to report," not a crash', () => {
    expect(parseBlocks('not json at all')).toBe(null)
    expect(parseBlocks('{"blocks": "not an array"}')).toBe(null)
    expect(parseBlocks('{}')).toBe(null)
    expect(parseBlocks(null)).toBe(null)
    expect(parseBlocks(undefined)).toBe(null)
    expect(parseBlocks(42)).toBe(null)
  })

  it('drops a block whose type is unrecognized rather than crashing on it', () => {
    const raw = JSON.stringify({
      blocks: [
        { type: 'heading', text: 'not a real type', items: null, label: null, value: null },
        { type: 'paragraph', text: 'kept', items: null, label: null, value: null }
      ]
    })
    expect(parseBlocks(raw)).toEqual([{ type: 'paragraph', text: 'kept' }])
  })
})

// sanitizeBlockList (ticket 02) is the seam room-state-store.js's
// resolveAnnotation calls to re-validate a Block array on its way into room
// storage — a caller with an array already in hand, not a whole `{blocks}`
// reply. parseBlocks itself is built on top of it, so its own bounding
// behavior is covered above; what's worth testing directly here is the
// "array already in hand" entry point and the length bounds.
describe('sanitizeBlockList', () => {
  it('accepts a plain array, not only a {blocks: [...]} wrapper', () => {
    expect(sanitizeBlockList([{ type: 'paragraph', text: 'x', items: null, label: null, value: null }]))
      .toEqual([{ type: 'paragraph', text: 'x' }])
  })

  it('returns null for anything that is not an array', () => {
    expect(sanitizeBlockList(null)).toBe(null)
    expect(sanitizeBlockList(undefined)).toBe(null)
    expect(sanitizeBlockList('not an array')).toBe(null)
    expect(sanitizeBlockList({ blocks: [] })).toBe(null)
  })

  it('caps the number of blocks kept, rather than storing an unbounded array', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      type: 'paragraph',
      text: `line ${i}`,
      items: null,
      label: null,
      value: null
    }))
    const result = sanitizeBlockList(many)
    expect(result.length).toBe(20)
    expect(result[0].text).toBe('line 0')
  })

  it('caps each field length rather than storing an unbounded string', () => {
    const result = sanitizeBlockList([
      { type: 'paragraph', text: 'x'.repeat(10_000), items: null, label: null, value: null },
      { type: 'list', text: null, items: ['y'.repeat(1000)], label: null, value: null },
      { type: 'stat', text: null, items: null, label: 'z'.repeat(1000), value: 'w'.repeat(1000) }
    ])
    expect(result[0].text.length).toBeLessThan(10_000)
    expect(result[1].items[0].length).toBeLessThan(1000)
    expect(result[2].label.length).toBeLessThan(1000)
    expect(result[2].value.length).toBeLessThan(1000)
  })
})

describe('flattenBlocksToText', () => {
  it('renders a paragraph as its plain text', () => {
    expect(flattenBlocksToText([{ type: 'paragraph', text: 'Hello.' }])).toBe('Hello.')
  })

  it('renders a list as bullet lines', () => {
    expect(flattenBlocksToText([{ type: 'list', items: ['a', 'b'] }])).toBe('• a\n• b')
  })

  it('renders a stat as "label: value"', () => {
    expect(flattenBlocksToText([{ type: 'stat', label: 'Score', value: '9/10' }])).toBe('Score: 9/10')
  })

  it('joins multiple blocks with a blank line between them', () => {
    const blocks = [
      { type: 'paragraph', text: 'Intro.' },
      { type: 'list', items: ['one', 'two'] }
    ]
    expect(flattenBlocksToText(blocks)).toBe('Intro.\n\n• one\n• two')
  })

  it('is empty for an empty or missing block array', () => {
    expect(flattenBlocksToText([])).toBe('')
    expect(flattenBlocksToText(null)).toBe('')
    expect(flattenBlocksToText(undefined)).toBe('')
  })
})
