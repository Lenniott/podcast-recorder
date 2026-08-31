import { describe, it, expect } from 'vitest'
import { detectResearchTrigger } from '../../src/lib/research-trigger.js'

describe('detectResearchTrigger', () => {
  it('detects "define" followed by a topic', () => {
    expect(detectResearchTrigger('define the Monroe Doctrine')).toEqual({ topic: 'the Monroe Doctrine' })
  })

  it('matches case-insensitively', () => {
    expect(detectResearchTrigger('DEFINE Federalism')).toEqual({ topic: 'Federalism' })
  })

  it('recognizes "let\'s look that up" as a trigger with no usable topic', () => {
    expect(detectResearchTrigger("let's look that up")).toEqual({ topic: null })
  })

  it('extracts the topic following "let\'s look up"', () => {
    expect(detectResearchTrigger("let's look up the Monroe Doctrine")).toEqual({ topic: 'the Monroe Doctrine' })
  })

  it('returns null when no Voice Trigger phrase is present', () => {
    expect(detectResearchTrigger('the weather has been nice lately')).toBeNull()
  })

  it('still fires on a bare "define" with no usable topic — a stray match degrades gracefully (ticket 06)', () => {
    expect(detectResearchTrigger("that's hard to define")).toEqual({ topic: null })
  })

  it('returns null for a nullish/empty utterance rather than throwing', () => {
    expect(detectResearchTrigger(undefined)).toBeNull()
    expect(detectResearchTrigger('')).toBeNull()
  })
})
