import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import db, {
  _resetDb,
  createCustomPrompt,
  deleteCustomPrompt,
  getCustomPrompt,
  getCustomPromptTemplate,
  listCustomPromptSummaries,
  listCustomPrompts,
  updateCustomPrompt
} from '../../src/lib/server/db.js'
import {
  CUSTOM_PROMPT_OUTPUT_FORMATS,
  CUSTOM_PROMPT_TITLE_MAX_LENGTH,
  normalizeOutputFormat,
  validateCustomPrompt
} from '../../src/lib/home/custom-prompts.js'

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  _resetDb()
})

describe('Custom Prompt list CRUD', () => {
  it('starts empty', () => {
    expect(listCustomPrompts()).toEqual([])
    expect(listCustomPromptSummaries()).toEqual([])
  })

  it('creates a prompt with a stable id and reads it back', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'Read {selection}.' })

    expect(created.id).toBeTruthy()
    expect(getCustomPrompt(created.id)).toEqual({
      id: created.id,
      title: 'Interpret',
      prompt: 'Read {selection}.',
      outputFormat: 'text'
    })
  })

  it('gives each prompt a distinct id, even for identical titles', () => {
    const a = createCustomPrompt({ title: 'Same', prompt: 'one' })
    const b = createCustomPrompt({ title: 'Same', prompt: 'two' })
    expect(a.id).not.toBe(b.id)
    expect(getCustomPromptTemplate(a.id)).toBe('one')
    expect(getCustomPromptTemplate(b.id)).toBe('two')
  })

  it('lists prompts in creation order', () => {
    createCustomPrompt({ title: 'First', prompt: 'a' })
    createCustomPrompt({ title: 'Second', prompt: 'b' })
    createCustomPrompt({ title: 'Third', prompt: 'c' })
    expect(listCustomPrompts().map((p) => p.title)).toEqual(['First', 'Second', 'Third'])
  })

  it('trims a title on the way in but leaves prompt text exactly as written', () => {
    const created = createCustomPrompt({ title: '  Interpret  ', prompt: '  keep  my  spacing  ' })
    expect(getCustomPrompt(created.id)).toEqual({
      id: created.id,
      title: 'Interpret',
      prompt: '  keep  my  spacing  ',
      outputFormat: 'text'
    })
  })

  it('edits a prompt in place without changing its id — the thing a trigger holds', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'old text' })

    expect(updateCustomPrompt(created.id, { title: 'Renamed', prompt: 'new text' })).toBe(true)
    expect(getCustomPrompt(created.id)).toEqual({
      id: created.id,
      title: 'Renamed',
      prompt: 'new text',
      outputFormat: 'text'
    })
    expect(listCustomPrompts()).toHaveLength(1)
  })

  it('reports an edit to an unknown id rather than creating one', () => {
    expect(updateCustomPrompt('cp_nope', { title: 'x', prompt: 'y' })).toBe(false)
    expect(listCustomPrompts()).toEqual([])
  })

  it('deletes one prompt and leaves the rest alone', () => {
    const keep = createCustomPrompt({ title: 'Keep', prompt: 'a' })
    const drop = createCustomPrompt({ title: 'Drop', prompt: 'b' })

    expect(deleteCustomPrompt(drop.id)).toBe(true)
    expect(listCustomPrompts().map((p) => p.id)).toEqual([keep.id])
    expect(getCustomPrompt(drop.id)).toBeNull()
  })

  it('reports a delete of an unknown id as a no-op', () => {
    expect(deleteCustomPrompt('cp_nope')).toBe(false)
  })
})

// output_format (structured-research-output ticket 02, see
// research-blocks.js) — defaults to 'text' for zero migration risk on an
// existing deployment, and normalizes anything unrecognized to 'text' the
// same way an unknown Placeholder resolves to nothing rather than erroring.
describe('Custom Prompt output format', () => {
  it('defaults a newly created prompt to "text" when not specified', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'x' })
    expect(getCustomPrompt(created.id).outputFormat).toBe('text')
  })

  it('persists an explicit "blocks" format', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'x', outputFormat: 'blocks' })
    expect(getCustomPrompt(created.id).outputFormat).toBe('blocks')
    expect(listCustomPrompts()[0].outputFormat).toBe('blocks')
  })

  it('normalizes an unrecognized outputFormat to "text" rather than storing garbage', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'x', outputFormat: 'bogus' })
    expect(getCustomPrompt(created.id).outputFormat).toBe('text')
  })

  it('updateCustomPrompt can flip the format in either direction, in place', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'x', outputFormat: 'text' })

    expect(updateCustomPrompt(created.id, { title: 'Interpret', prompt: 'x', outputFormat: 'blocks' })).toBe(true)
    expect(getCustomPrompt(created.id).outputFormat).toBe('blocks')

    expect(updateCustomPrompt(created.id, { title: 'Interpret', prompt: 'x', outputFormat: 'text' })).toBe(true)
    expect(getCustomPrompt(created.id).outputFormat).toBe('text')
  })

  it('an update that omits outputFormat resets it to "text" — the form always sends a value, so this is not a real path, only a documented one', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'x', outputFormat: 'blocks' })
    updateCustomPrompt(created.id, { title: 'Interpret', prompt: 'x' })
    expect(getCustomPrompt(created.id).outputFormat).toBe('text')
  })
})

describe('normalizeOutputFormat', () => {
  it('passes through every recognized value unchanged', () => {
    for (const value of CUSTOM_PROMPT_OUTPUT_FORMATS) {
      expect(normalizeOutputFormat(value)).toBe(value)
    }
  })

  it('falls back to "text" for anything else, including missing/null/wrong-type values', () => {
    expect(normalizeOutputFormat('bogus')).toBe('text')
    expect(normalizeOutputFormat(undefined)).toBe('text')
    expect(normalizeOutputFormat(null)).toBe('text')
    expect(normalizeOutputFormat('')).toBe('text')
  })
})

describe('the seams ticket 05 triggers a Custom Prompt through', () => {
  it('listCustomPromptSummaries gives id + title + usesSelection, no template text', () => {
    createCustomPrompt({ title: 'Interpret', prompt: 'secret template' })
    createCustomPrompt({ title: 'Fact check', prompt: 'another template' })

    const summaries = listCustomPromptSummaries()
    expect(summaries.map((p) => p.title)).toEqual(['Interpret', 'Fact check'])
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual(['id', 'title', 'usesSelection'])
    }
  })

  // usesSelection (the panel-button-vs-popup split) is derived from the
  // template — never shipped itself, never a stand-in for the template text.
  it('usesSelection reflects whether the template references {selection}', () => {
    const selectionOne = createCustomPrompt({ title: 'Define', prompt: 'Define {selection}.' })
    const conditionalOne = createCustomPrompt({ title: 'Maybe', prompt: '{#if selection}About: {selection}{/if}' })
    const noSelection = createCustomPrompt({ title: 'Recap', prompt: 'Summarize {transcript} so far.' })

    const byId = Object.fromEntries(listCustomPromptSummaries().map((p) => [p.id, p]))
    expect(byId[selectionOne.id].usesSelection).toBe(true)
    expect(byId[conditionalOne.id].usesSelection).toBe(true)
    expect(byId[noSelection.id].usesSelection).toBe(false)
  })

  it('getCustomPromptTemplate resolves one prompt by id', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'Read {selection}.' })
    expect(getCustomPromptTemplate(created.id)).toBe('Read {selection}.')
  })

  it('getCustomPromptTemplate is empty for an unknown or missing id, never a throw', () => {
    expect(getCustomPromptTemplate('cp_nope')).toBe('')
    expect(getCustomPromptTemplate(undefined)).toBe('')
    expect(getCustomPromptTemplate(null)).toBe('')
  })
})

describe('validateCustomPrompt', () => {
  it('accepts a title and prompt that both have text', () => {
    expect(validateCustomPrompt({ title: 'Interpret', prompt: 'Read {selection}.' })).toBe('')
  })

  it('rejects a missing or whitespace-only title', () => {
    expect(validateCustomPrompt({ title: '', prompt: 'text' })).toBe('Title is required')
    expect(validateCustomPrompt({ title: '   ', prompt: 'text' })).toBe('Title is required')
  })

  it('rejects a missing or whitespace-only prompt', () => {
    expect(validateCustomPrompt({ title: 'Interpret', prompt: '' })).toBe('Prompt text is required')
    expect(validateCustomPrompt({ title: 'Interpret', prompt: '   ' })).toBe('Prompt text is required')
  })

  it('rejects an over-length title — the backstop for a POST skipping maxlength', () => {
    const title = 'x'.repeat(CUSTOM_PROMPT_TITLE_MAX_LENGTH + 1)
    expect(validateCustomPrompt({ title, prompt: 'text' })).toMatch(/Title too long/)
    expect(validateCustomPrompt({ title: 'x'.repeat(CUSTOM_PROMPT_TITLE_MAX_LENGTH), prompt: 'text' })).toBe('')
  })
})

// The single Research Prompt lived in two `settings` rows before ADR-0008.
// A deployment upgrading into this build must not silently lose it, so the
// migration needs a real file DB that survives a reopen.
describe('migrating the retired single Research Prompt', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'custom-prompts-'))
    process.env.DB_PATH = join(dir, 'rooms.db')
    _resetDb()
  })

  afterEach(() => {
    _resetDb()
    rmSync(dir, { recursive: true, force: true })
  })

  function seedLegacyPrompt(prompt, title) {
    const write = db.getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    write.run('research_prompt', prompt)
    write.run('research_prompt_title', title)
    _resetDb() // reopen so getDb() runs the migration over the seeded rows
  }

  it('moves an existing prompt into the list as one Custom Prompt', () => {
    listCustomPrompts() // opens the DB, so the settings table exists to seed
    seedLegacyPrompt('Read {current_tab}.', 'Interpret')

    expect(listCustomPrompts()).toMatchObject([{ title: 'Interpret', prompt: 'Read {current_tab}.' }])
    expect(listCustomPrompts()[0].id).toBeTruthy()
  })

  it('names an untitled prompt rather than migrating one that could never run', () => {
    listCustomPrompts()
    seedLegacyPrompt('Read {current_tab}.', '')
    expect(listCustomPrompts()).toMatchObject([{ title: 'Custom', prompt: 'Read {current_tab}.' }])
  })

  it('runs once — a prompt deleted after migrating does not come back', () => {
    listCustomPrompts()
    seedLegacyPrompt('Read {current_tab}.', 'Interpret')

    deleteCustomPrompt(listCustomPrompts()[0].id)
    _resetDb()
    expect(listCustomPrompts()).toEqual([])
  })

  it('does nothing when there was never a Research Prompt', () => {
    listCustomPrompts()
    _resetDb()
    expect(listCustomPrompts()).toEqual([])
  })
})
