import { describe, it, expect } from 'vitest'
import {
  MODE_RULES,
  MODES,
  matchesMode,
  parseResearchCard,
  serializeResearchCard,
  shouldSuppress,
  SUPPRESS_THRESHOLD
} from '../../src/lib/research-card.js'

function fieldText(fields) {
  return [
    fields.provenInTranscript != null ? `PROVEN IN TRANSCRIPT: ${fields.provenInTranscript}` : null,
    fields.ubiquitousKnowledge != null ? `UBIQUITOUS KNOWLEDGE: ${fields.ubiquitousKnowledge}` : null,
    fields.outputType != null ? `OUTPUT TYPE: ${fields.outputType}` : null,
    fields.contextSummary != null ? `CONTEXT SUMMARY: ${fields.contextSummary}` : null,
    fields.mainTakeaway != null ? `MAIN TAKEAWAY: ${fields.mainTakeaway}` : null,
    fields.sources != null ? `SOURCES: ${fields.sources}` : null
  ]
    .filter((line) => line != null)
    .join('\n')
}

describe('parseResearchCard', () => {
  it('parses a well-formed labeled response', () => {
    const card = parseResearchCard(
      fieldText({
        provenInTranscript: 10,
        ubiquitousKnowledge: 20,
        outputType: 'research',
        contextSummary: 'when the wall came down',
        mainTakeaway: 'The Berlin Wall fell in 1989.',
        sources: 'Wikipedia'
      })
    )
    expect(card).toEqual({
      provenInTranscript: 10,
      ubiquitousKnowledge: 20,
      outputType: 'research',
      contextSummary: 'when the wall came down',
      mainTakeaway: 'The Berlin Wall fell in 1989.',
      sources: ['Wikipedia']
    })
  })

  it('drops an unknown source and caps at two known sources', () => {
    const card = parseResearchCard(
      fieldText({
        outputType: 'define',
        contextSummary: 'x',
        mainTakeaway: 'y',
        sources: 'Wikipedia, Reddit, SomeBlog'
      })
    )
    expect(card.sources).toEqual(['Wikipedia', 'Reddit'])
  })

  it('sources are limited to Wikipedia and Reddit only, from labeled text', () => {
    const card = parseResearchCard(
      fieldText({ outputType: 'research', contextSummary: 'x', mainTakeaway: 'y', sources: 'Twitter, YouTube' })
    )
    expect(card.sources).toEqual([])
  })

  it('sources are limited to Wikipedia and Reddit only, from a JSON (wire) source array', () => {
    const card = parseResearchCard(
      JSON.stringify({ outputType: 'research', mainTakeaway: 'y', sources: ['Twitter', 'Wikipedia', 'Reddit', 'Blog'] })
    )
    expect(card.sources).toEqual(['Wikipedia', 'Reddit'])
  })

  it('clips context summary and main takeaway to their word caps', () => {
    const card = parseResearchCard(
      fieldText({
        outputType: 'research',
        contextSummary: Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '),
        mainTakeaway: Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')
      })
    )
    expect(card.contextSummary.split(/\s+/)).toHaveLength(12)
    expect(card.mainTakeaway.split(/\s+/)).toHaveLength(35)
  })

  it('returns null for an empty response — the model was told to output nothing', () => {
    expect(parseResearchCard('')).toBeNull()
    expect(parseResearchCard(null)).toBeNull()
  })

  it('treats leftover prose with no recognized labels as the main takeaway, same as old mocked/plain answers', () => {
    const card = parseResearchCard('Sorry, I have nothing to add here.')
    expect(card.mainTakeaway).toBe('Sorry, I have nothing to add here.')
    expect(card.outputType).toBeNull()
  })

  it('an unknown OUTPUT TYPE value parses as null, never a placeholder echo', () => {
    const card = parseResearchCard(fieldText({ outputType: '{mode}', contextSummary: 'x', mainTakeaway: 'y' }))
    expect(card.outputType).toBeNull()
  })
})

describe('serializeResearchCard', () => {
  it('produces the JSON shape parseResearchCard expects on the wire', () => {
    const card = {
      provenInTranscript: 0,
      ubiquitousKnowledge: 0,
      outputType: 'factCheck',
      contextSummary: 'a claim',
      mainTakeaway: 'The claim is false.',
      sources: []
    }
    expect(JSON.parse(serializeResearchCard(card))).toEqual(card)
  })

  it('serializes null as the literal JSON null', () => {
    expect(serializeResearchCard(null)).toBe('null')
  })
})

// This is the exact path a real research_resolve broadcast takes:
// askResearchAssistant sanitizes + serializes server-side, the value goes
// out over the wire as `entry.answer`, and ResearchPanel.svelte calls
// parseResearchCard on THAT string to render it — never on the model's
// raw response directly. A round trip that only checked JSON.parse (not
// parseResearchCard) missed a real bug: parseResearchCard didn't attempt
// JSON.parse at all, so the client-side call fell through to the
// leftover-prose fallback and rendered the raw JSON blob as the takeaway.
describe('parseResearchCard(serializeResearchCard(...)) — the actual server-to-client round trip', () => {
  it('round-trips a full card back to itself through the wire string', () => {
    const card = {
      provenInTranscript: 0,
      ubiquitousKnowledge: 0,
      outputType: 'factCheck',
      contextSummary: 'Jack White married Meg White; they presented as siblings.',
      mainTakeaway: 'Jack White and Meg White were married, not siblings, and kept it private for years.',
      sources: ['Wikipedia']
    }
    const wire = serializeResearchCard(card)
    expect(wire.startsWith('{')).toBe(true) // sanity: this really is the JSON path, not label text
    expect(parseResearchCard(wire)).toEqual(card)
  })

  it('never renders the raw JSON blob as the main takeaway', () => {
    const wire = serializeResearchCard({ outputType: 'research', mainTakeaway: 'x' })
    const card = parseResearchCard(wire)
    expect(card.mainTakeaway).not.toContain('{')
    expect(card.mainTakeaway).not.toContain('provenInTranscript')
  })

  it('round-trips a suppressed/off-mode null card back to null, not a rendered blob', () => {
    expect(parseResearchCard(serializeResearchCard(null))).toBeNull()
  })
})

describe('shouldSuppress — score-threshold guard', () => {
  it('suppresses a null card', () => {
    expect(shouldSuppress(null)).toBe(true)
  })

  it('suppresses when already proven in the transcript above the threshold', () => {
    expect(shouldSuppress({ provenInTranscript: 95, ubiquitousKnowledge: 0 })).toBe(true)
  })

  it('suppresses when ubiquitous knowledge is above the threshold', () => {
    expect(shouldSuppress({ provenInTranscript: 0, ubiquitousKnowledge: 81 })).toBe(true)
  })

  it('does not suppress right at the threshold', () => {
    expect(shouldSuppress({ provenInTranscript: SUPPRESS_THRESHOLD, ubiquitousKnowledge: SUPPRESS_THRESHOLD })).toBe(false)
  })

  it('does not suppress a genuinely new, obscure claim', () => {
    expect(shouldSuppress({ provenInTranscript: 0, ubiquitousKnowledge: 10 })).toBe(false)
  })
})

describe('matchesMode — mode-match guard', () => {
  it('matches when OUTPUT TYPE equals the requested mode', () => {
    expect(matchesMode({ outputType: 'define' }, 'define')).toBe(true)
  })

  it('does not match a silently substituted mode (Bug 1)', () => {
    expect(matchesMode({ outputType: 'factCheck' }, 'research')).toBe(false)
  })

  it('does not match a null card', () => {
    expect(matchesMode(null, 'research')).toBe(false)
  })
})

describe('MODE_RULES / MODES — the open-ended mode registry', () => {
  it('MODES is exactly the MODE_RULES keys, so adding a mode means adding one entry', () => {
    expect(MODES).toEqual(Object.keys(MODE_RULES))
  })

  it('every mode has a non-empty selection rule', () => {
    for (const mode of MODES) {
      expect(typeof MODE_RULES[mode]).toBe('string')
      expect(MODE_RULES[mode].length).toBeGreaterThan(0)
    }
  })
})
