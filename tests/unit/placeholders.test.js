import { describe, it, expect } from 'vitest'
import {
  PLACEHOLDERS,
  PLACEHOLDER_NAMES,
  referencedPlaceholders,
  promptReferencesSelection
} from '../../src/lib/research/placeholders.js'

describe('PLACEHOLDERS / PLACEHOLDER_NAMES', () => {
  it('is exactly the six Placeholders CONTEXT.md documents', () => {
    expect([...PLACEHOLDER_NAMES].sort()).toEqual([
      'current_tab',
      'current_time',
      'latest_transcript',
      'selection',
      'transcript',
      'video_title'
    ])
    expect(Object.keys(PLACEHOLDERS).sort()).toEqual([...PLACEHOLDER_NAMES].sort())
  })
})

describe('referencedPlaceholders', () => {
  it('reports only the Placeholders a template actually writes', () => {
    expect([...referencedPlaceholders('Define {selection} using {transcript}.')].sort())
      .toEqual(['selection', 'transcript'])
  })

  it('ignores braces that are not Placeholders, so prose survives untouched', () => {
    expect([...referencedPlaceholders('Use {selection} but not {made_up} or {}.')])
      .toEqual(['selection'])
    expect([...referencedPlaceholders('')]).toEqual([])
    expect([...referencedPlaceholders(null)]).toEqual([])
  })

  it('counts a name used only inside {#if name} as referenced', () => {
    expect([...referencedPlaceholders('{#if transcript}there was some talk{/if}')])
      .toEqual(['transcript'])
  })
})

// promptReferencesSelection (the split behind panel buttons vs. the
// highlight popup — see db.js's listCustomPromptSummaries) is a thin wrapper
// over referencedPlaceholders, so its own coverage stays light: just the
// {selection}/{#if selection}/neither cases, plus the {#if} form staying
// consistent with a bare reference.
describe('promptReferencesSelection', () => {
  it('is true for a template that references {selection} directly', () => {
    expect(promptReferencesSelection('Explain {selection} in plain terms.')).toBe(true)
  })

  it('is true for a template that references {selection} only inside {#if}', () => {
    expect(promptReferencesSelection('{#if selection}About: {selection}{/if}')).toBe(true)
  })

  it('is false for a template that never references {selection}', () => {
    expect(promptReferencesSelection('Summarize {transcript} so far.')).toBe(false)
    expect(promptReferencesSelection('What time is it? {current_time}')).toBe(false)
    expect(promptReferencesSelection('')).toBe(false)
    expect(promptReferencesSelection(null)).toBe(false)
    expect(promptReferencesSelection(undefined)).toBe(false)
  })
})
