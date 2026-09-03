import { describe, it, expect } from 'vitest'
import { detectResearchTrigger } from '../../src/lib/research/research-trigger.js'

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

  it('recognizes "let\'s look this up" as a no-topic trigger', () => {
    expect(detectResearchTrigger("let's look this up")).toEqual({ topic: null })
  })

  it('recognizes "look that up" as a no-topic trigger', () => {
    expect(detectResearchTrigger('look that up')).toEqual({ topic: null })
  })

  it('recognizes "look this up" as a no-topic trigger', () => {
    expect(detectResearchTrigger('look this up')).toEqual({ topic: null })
  })

  it('recognizes "let\'s google that" as a no-topic trigger', () => {
    expect(detectResearchTrigger("let's google that")).toEqual({ topic: null })
  })

  it('recognizes "let\'s google this" as a no-topic trigger', () => {
    expect(detectResearchTrigger("let's google this")).toEqual({ topic: null })
  })

  it('recognizes "google that" as a no-topic trigger', () => {
    expect(detectResearchTrigger('google that')).toEqual({ topic: null })
  })

  it('recognizes "google this" as a no-topic trigger', () => {
    expect(detectResearchTrigger('google this')).toEqual({ topic: null })
  })

  it('recognizes "let\'s search that" as a no-topic trigger', () => {
    expect(detectResearchTrigger("let's search that")).toEqual({ topic: null })
  })

  it('recognizes "search for that" as a no-topic trigger', () => {
    expect(detectResearchTrigger('search for that')).toEqual({ topic: null })
  })

  it('extracts the topic following bare "look up"', () => {
    expect(detectResearchTrigger('look up the Monroe Doctrine')).toEqual({ topic: 'the Monroe Doctrine' })
  })

  it('extracts the topic following "let\'s search for"', () => {
    expect(detectResearchTrigger("let's search for the Monroe Doctrine")).toEqual({ topic: 'the Monroe Doctrine' })
  })

  it('resolves "let\'s search for that" as the no-topic idiom, not a topic-taking match with topic "that"', () => {
    expect(detectResearchTrigger("let's search for that")).toEqual({ topic: null })
  })

  it('extracts the topic following "can you look up"', () => {
    expect(detectResearchTrigger('can you look up the Monroe Doctrine')).toEqual({ topic: 'the Monroe Doctrine' })
  })

  it('extracts the topic following "can we look up"', () => {
    expect(detectResearchTrigger('can we look up the Monroe Doctrine')).toEqual({ topic: 'the Monroe Doctrine' })
  })

  it('extracts the topic following "what\'s the definition of"', () => {
    expect(detectResearchTrigger("what's the definition of federalism")).toEqual({ topic: 'federalism' })
  })

  it('extracts the topic following "what is the definition of"', () => {
    expect(detectResearchTrigger('what is the definition of federalism')).toEqual({ topic: 'federalism' })
  })
})
