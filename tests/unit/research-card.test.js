import { describe, it, expect } from 'vitest'
import { MODES, parseResearchCard, serializeResearchCard } from '../../src/lib/research/research-card.js'

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

  // ADR-0008/ticket 07 retired the fixed Turn Action modes and, with them,
  // the 35-word skim cap that only applied to their structured cards —
  // every mode is freeform now, so a long takeaway survives whole.
  it('does not clip a long takeaway — every mode is freeform now', () => {
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')
    const card = parseResearchCard(fieldText({ outputType: 'ask', mainTakeaway: long }))
    expect(card.mainTakeaway).toBe(long)
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

  // 'definition'/'facts'/'answer' are retired mode names (ADR-0008) — no
  // longer in MODES, so they parse the same as any other unrecognized value.
  it('a retired Turn Action mode name is no longer a recognized OUTPUT TYPE', () => {
    const card = parseResearchCard(fieldText({ outputType: 'definition', mainTakeaway: 'y' }))
    expect(card.outputType).toBeNull()
  })

  it('treats a JSON reply with a blank mainTakeaway as no card — the forced-JSON "nothing to report" signal', () => {
    const card = parseResearchCard(JSON.stringify({ outputType: 'ask', mainTakeaway: '' }))
    expect(card).toBeNull()
  })

  it('strips a markdown citation the model wrote inline instead of using the separate citations mechanism', () => {
    const card = parseResearchCard(
      JSON.stringify({
        outputType: 'ask',
        mainTakeaway: 'Dulcet means pleasant-sounding [collinsdictionary.com](https://www.collinsdictionary.com/dulcet).'
      })
    )
    expect(card.mainTakeaway).toBe('Dulcet means pleasant-sounding.')
  })

  it('strips a bare URL the model wrote inline', () => {
    const card = parseResearchCard(
      JSON.stringify({
        outputType: 'ask',
        mainTakeaway: 'Source: https://www.collinsdictionary.com/dulcet says so.'
      })
    )
    expect(card.mainTakeaway).not.toContain('http')
  })

  it('a takeaway that is only a citation strips down to empty and the card becomes no card', () => {
    const card = parseResearchCard(
      JSON.stringify({ outputType: 'ask', mainTakeaway: '[collinsdictionary.com](https://www.collinsdictionary.com/dulcet)' })
    )
    expect(card).toBeNull()
  })

  // A Custom Prompt's reply is always rendered as plain text (see
  // ResearchPanel.svelte) — none of these ever become real HTML, so raw
  // markdown syntax always shows up as literal asterisks/hashes to a
  // reader, no matter what the prompt asked for. These are real failures a
  // live Custom Prompt run turned up.
  it('strips **bold** and __bold__ markers, keeping the wrapped text', () => {
    const card = parseResearchCard(
      JSON.stringify({ outputType: 'ask', mainTakeaway: '**Verdict**\nThe claim is __false__.' })
    )
    expect(card.mainTakeaway).toBe('Verdict\nThe claim is false.')
  })

  it('strips a bracket-only citation stub (a bare domain, not a real [label](url) link)', () => {
    const card = parseResearchCard(
      JSON.stringify({ outputType: 'ask', mainTakeaway: 'Reproductive messages rose in 2009 [pmc.ncbi.nlm.nih.gov].' })
    )
    expect(card.mainTakeaway).toBe('Reproductive messages rose in 2009.')
  })

  it('does not touch a bracket that is not a bare-domain stub', () => {
    const card = parseResearchCard(JSON.stringify({ outputType: 'ask', mainTakeaway: 'She said [laughs] it was fine.' }))
    expect(card.mainTakeaway).toBe('She said [laughs] it was fine.')
  })

  it('converts a markdown list marker to a real bullet character', () => {
    const card = parseResearchCard(
      JSON.stringify({ outputType: 'ask', mainTakeaway: 'Key facts:\n*   First point.\n-   Second point.' })
    )
    expect(card.mainTakeaway).toBe('Key facts:\n• First point.\n• Second point.')
  })

  it('strips a markdown heading marker, keeping the heading text on its own line', () => {
    const card = parseResearchCard(JSON.stringify({ outputType: 'ask', mainTakeaway: '## Conclusion\nIt is false.' }))
    expect(card.mainTakeaway).toBe('Conclusion\nIt is false.')
  })

  // The exact shape of a real Custom Prompt reply that prompted this fix
  // (ADR-0008 follow-up) — bold headers, a bulleted list, and bracket-only
  // citation stubs all in one reply, none of which the panel can render.
  it('cleans up a realistic markdown-heavy reply end to end', () => {
    const raw = [
      '**Verdict**',
      'The statement is **false**. Not every song is about sex.',
      '',
      '**Key Facts**',
      '*   **Most popular songs** often have sexual themes.',
      '*   **In 2009**, 92% of top songs had reproductive messages [pmc.ncbi.nlm.nih.gov].',
      '',
      '**Conclusion**',
      'Sex is a common topic in popular music.'
    ].join('\n')
    const card = parseResearchCard(JSON.stringify({ outputType: 'custom', mainTakeaway: raw }))
    expect(card.mainTakeaway).toBe(
      [
        'Verdict',
        'The statement is false. Not every song is about sex.',
        '',
        'Key Facts',
        '• Most popular songs often have sexual themes.',
        '• In 2009, 92% of top songs had reproductive messages.',
        '',
        'Conclusion',
        'Sex is a common topic in popular music.'
      ].join('\n')
    )
  })
})

describe('serializeResearchCard', () => {
  it('produces the JSON shape parseResearchCard expects on the wire', () => {
    const card = {
      provenInTranscript: 0,
      ubiquitousKnowledge: 0,
      outputType: 'custom',
      mainTakeaway: 'The claim is false.'
    }
    expect(JSON.parse(serializeResearchCard(card))).toEqual(card)
  })

  it('serializes null as the literal JSON null', () => {
    expect(serializeResearchCard(null)).toBe('null')
  })
})

// This is the exact path a real research_resolve/annotation_entry broadcast
// takes: askResearchAssistant sanitizes + serializes server-side, the value
// goes out over the wire as the entry/Card's answer, and the panel calls
// parseResearchCard on THAT string to render it — never on the model's raw
// response directly. A round trip that only checked JSON.parse (not
// parseResearchCard) missed a real bug: parseResearchCard didn't attempt
// JSON.parse at all, so the client-side call fell through to the
// leftover-prose fallback and rendered the raw JSON blob as the takeaway.
describe('parseResearchCard(serializeResearchCard(...)) — the actual server-to-client round trip', () => {
  it('round-trips a full card back to itself through the wire string', () => {
    const card = {
      provenInTranscript: 0,
      ubiquitousKnowledge: 0,
      outputType: 'custom',
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

  it('does not clip a Custom Prompt takeaway to any skim word cap', () => {
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
})

describe('MODES — the outputType allowlist', () => {
  // ADR-0008/ticket 07: Definition/Facts/Answer are retired along with the
  // MODE_RULES/shouldSuppress/matchesMode guards that only ever policed
  // them. Every remaining mode is freeform, authored by a person (Ask) or
  // a Custom Prompt.
  it('is only the two freeform modes', () => {
    expect(MODES).toEqual(['custom', 'ask'])
  })
})
