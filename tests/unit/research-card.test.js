import { describe, it, expect } from 'vitest'
import {
  MODE_RULES,
  MODES,
  matchesMode,
  parseResearchCard,
  serializeResearchCard,
  shouldSuppress,
  SUPPRESS_THRESHOLD
} from '../../src/lib/research/research-card.js'

function fieldText(fields) {
  return [
    fields.provenInTranscript != null ? `PROVEN IN TRANSCRIPT: ${fields.provenInTranscript}` : null,
    fields.ubiquitousKnowledge != null ? `UBIQUITOUS KNOWLEDGE: ${fields.ubiquitousKnowledge}` : null,
    fields.outputType != null ? `OUTPUT TYPE: ${fields.outputType}` : null,
    fields.mainTakeaway != null ? `MAIN TAKEAWAY: ${fields.mainTakeaway}` : null
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
        outputType: 'ask',
        mainTakeaway: 'The Berlin Wall fell in 1989.'
      })
    )
    expect(card).toEqual({
      provenInTranscript: 10,
      ubiquitousKnowledge: 20,
      outputType: 'ask',
      mainTakeaway: 'The Berlin Wall fell in 1989.'
    })
  })

  it('clips main takeaway to its word cap', () => {
    const card = parseResearchCard(
      fieldText({
        outputType: 'facts',
        mainTakeaway: Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')
      })
    )
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
    const card = parseResearchCard(fieldText({ outputType: '{mode}', mainTakeaway: 'y' }))
    expect(card.outputType).toBeNull()
  })

  it('treats a JSON reply with a blank mainTakeaway as no card — the forced-JSON "nothing to report" signal', () => {
    const card = parseResearchCard(JSON.stringify({ outputType: 'definition', mainTakeaway: '' }))
    expect(card).toBeNull()
  })

  it('strips a markdown citation the model wrote inline instead of using the separate citations mechanism', () => {
    const card = parseResearchCard(
      JSON.stringify({
        outputType: 'definition',
        mainTakeaway: 'Dulcet means pleasant-sounding [collinsdictionary.com](https://www.collinsdictionary.com/dulcet).'
      })
    )
    expect(card.mainTakeaway).toBe('Dulcet means pleasant-sounding.')
  })

  it('strips a bare URL the model wrote inline', () => {
    const card = parseResearchCard(
      JSON.stringify({
        outputType: 'definition',
        mainTakeaway: 'Source: https://www.collinsdictionary.com/dulcet says so.'
      })
    )
    expect(card.mainTakeaway).not.toContain('http')
  })

  it('a takeaway that is only a citation strips down to empty and the card becomes no card', () => {
    const card = parseResearchCard(
      JSON.stringify({ outputType: 'definition', mainTakeaway: '[collinsdictionary.com](https://www.collinsdictionary.com/dulcet)' })
    )
    expect(card).toBeNull()
  })
})

describe('serializeResearchCard', () => {
  it('produces the JSON shape parseResearchCard expects on the wire', () => {
    const card = {
      provenInTranscript: 0,
      ubiquitousKnowledge: 0,
      outputType: 'facts',
      mainTakeaway: 'The claim is false.'
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
      outputType: 'facts',
      mainTakeaway: 'Jack White and Meg White were married, not siblings, and kept it private for years.'
    }
    const wire = serializeResearchCard(card)
    expect(wire.startsWith('{')).toBe(true) // sanity: this really is the JSON path, not label text
    expect(parseResearchCard(wire)).toEqual(card)
  })

  it('never renders the raw JSON blob as the main takeaway', () => {
    const wire = serializeResearchCard({ outputType: 'ask', mainTakeaway: 'x' })
    const card = parseResearchCard(wire)
    expect(card.mainTakeaway).not.toContain('{')
    expect(card.mainTakeaway).not.toContain('provenInTranscript')
  })

  it('round-trips a suppressed/off-mode null card back to null, not a rendered blob', () => {
    expect(parseResearchCard(serializeResearchCard(null))).toBeNull()
  })

  it('does not clip Custom (Research Prompt) takeaways to the skim word cap', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const card = parseResearchCard(serializeResearchCard({ outputType: 'custom', mainTakeaway: long }))
    expect(card.mainTakeaway).toBe(long)
  })

  it('keeps line breaks in Custom and Ask takeaways', () => {
    const prose = 'PROFESSIONAL:\nCritics say grief.\n\nFANDOM:\nFans say regret.'
    for (const outputType of ['custom', 'ask']) {
      const card = parseResearchCard(serializeResearchCard({ outputType, mainTakeaway: prose }))
      expect(card.mainTakeaway).toBe(prose)
    }
  })

  it('collapses line breaks in a Turn Action takeaway to a single skim paragraph', () => {
    const card = parseResearchCard(
      JSON.stringify({ outputType: 'facts', mainTakeaway: 'Line one.\n\nLine two.' })
    )
    expect(card.mainTakeaway).toBe('Line one. Line two.')
  })
})

describe('shouldSuppress — score-threshold guard', () => {
  it('suppresses a null card', () => {
    expect(shouldSuppress(null)).toBe(true)
  })

  it('suppresses when already proven in the transcript above the threshold', () => {
    expect(shouldSuppress({ provenInTranscript: 95, ubiquitousKnowledge: 0 })).toBe(true)
  })

  it('suppresses when ubiquitous knowledge is above the threshold in definition mode only', () => {
    expect(shouldSuppress({ provenInTranscript: 0, ubiquitousKnowledge: 81 }, 'definition')).toBe(true)
    expect(shouldSuppress({ provenInTranscript: 0, ubiquitousKnowledge: 81 }, 'facts')).toBe(false)
    expect(shouldSuppress({ provenInTranscript: 0, ubiquitousKnowledge: 81 }, 'ask')).toBe(false)
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
    expect(matchesMode({ outputType: 'definition' }, 'definition')).toBe(true)
  })

  it('does not match a silently substituted mode (Bug 1)', () => {
    expect(matchesMode({ outputType: 'facts' }, 'ask')).toBe(false)
  })

  it('does not match a null card', () => {
    expect(matchesMode(null, 'ask')).toBe(false)
  })
})

describe('MODE_RULES / MODES — the open-ended mode registry', () => {
  it('MODE_RULES is only Turn Actions; Ask and Custom are card types, not prompts here', () => {
    expect(Object.keys(MODE_RULES)).toEqual(['definition', 'facts', 'answer'])
    expect(MODE_RULES.ask).toBeUndefined()
    expect(MODE_RULES.custom).toBeUndefined()
    expect(MODES).toEqual(['definition', 'facts', 'answer', 'custom', 'ask'])
  })

  it('every shared-system-prompt mode has a non-empty selection rule', () => {
    for (const mode of Object.keys(MODE_RULES)) {
      expect(typeof MODE_RULES[mode]).toBe('string')
      expect(MODE_RULES[mode].length).toBeGreaterThan(0)
    }
  })
})
