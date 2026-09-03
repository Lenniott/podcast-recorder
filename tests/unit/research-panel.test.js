import { describe, it, expect } from 'vitest'
import {
  applyResearchEntry,
  applyResearchState,
  applyResearchRemove,
  visibleEntries,
  buildManualAskRequest,
  buildTurnActionRequest,
  buildCustomRequest,
  applyTranscriptState,
  applyTranscriptLine,
  activeNotesTabText,
  hasCustomText,
  isSkimVisibleEntry,
  describeResearchError,
  makeResearchEntryId,
  deriveDoneActionsByTurn,
  dedupeCitationsByHost
} from '../../src/lib/research/research-panel.js'
import { TRANSCRIPT_TAB_ID } from '../../src/lib/room/transcript-sync.js'

describe('makeResearchEntryId', () => {
  it('returns a unique-looking, non-empty string each time', () => {
    const a = makeResearchEntryId()
    const b = makeResearchEntryId()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })
})

describe('applyResearchEntry', () => {
  it('adds a brand-new entry under its tab', () => {
    const entry = { id: 'e1', tabId: 'tabA', question: 'Q', status: 'pending' }
    const result = applyResearchEntry({}, { tabId: 'tabA', entry })
    expect(result).toEqual({ tabA: [entry] })
  })

  it('updates an existing entry in place (pending -> answered) without touching other tabs', () => {
    const pending = { id: 'e1', tabId: 'tabA', question: 'Q', status: 'pending' }
    const answered = { ...pending, status: 'answered', answer: 'A' }
    const before = { tabA: [pending], tabB: [{ id: 'e2', tabId: 'tabB', question: 'Other', status: 'pending' }] }

    const after = applyResearchEntry(before, { tabId: 'tabA', entry: answered })

    expect(after.tabA).toEqual([answered])
    expect(after.tabB).toEqual(before.tabB)
  })

  it('never mutates the entriesByTab object passed in', () => {
    const before = { tabA: [{ id: 'e1', tabId: 'tabA', status: 'pending' }] }
    const snapshot = JSON.parse(JSON.stringify(before))
    applyResearchEntry(before, { tabId: 'tabA', entry: { id: 'e1', tabId: 'tabA', status: 'answered' } })
    expect(before).toEqual(snapshot)
  })
})

describe('applyResearchState', () => {
  it('replaces one tab\'s full history on replay, leaving other tabs untouched', () => {
    const entries = [{ id: 'e1', tabId: 'tabA', question: 'Q1', status: 'answered' }]
    const before = { tabB: [{ id: 'e2', tabId: 'tabB', status: 'pending' }] }
    const after = applyResearchState(before, { tabId: 'tabA', entries })
    expect(after.tabA).toEqual(entries)
    expect(after.tabB).toEqual(before.tabB)
  })
})

describe('applyResearchRemove', () => {
  it('drops the matching entry from its tab, leaving other entries and other tabs untouched', () => {
    const before = {
      tabA: [
        { id: 'e1', tabId: 'tabA', question: 'Q1', status: 'pending' },
        { id: 'e2', tabId: 'tabA', question: 'Q2', status: 'pending' }
      ],
      tabB: [{ id: 'e3', tabId: 'tabB', question: 'Q3', status: 'pending' }]
    }
    const after = applyResearchRemove(before, { tabId: 'tabA', entryId: 'e1' })
    expect(after.tabA).toEqual([before.tabA[1]])
    expect(after.tabB).toEqual(before.tabB)
  })

  it('is a no-op for a tab with no entries yet', () => {
    const before = { tabA: [{ id: 'e1', tabId: 'tabA', status: 'pending' }] }
    const after = applyResearchRemove(before, { tabId: 'tabB', entryId: 'e1' })
    expect(after).toBe(before)
  })

  it('never mutates the entriesByTab object passed in', () => {
    const before = { tabA: [{ id: 'e1', tabId: 'tabA', status: 'pending' }] }
    const snapshot = JSON.parse(JSON.stringify(before))
    applyResearchRemove(before, { tabId: 'tabA', entryId: 'e1' })
    expect(before).toEqual(snapshot)
  })
})

describe('visibleEntries', () => {
  it('returns only the active tab\'s entries, never another tab\'s', () => {
    const entriesByTab = {
      tabA: [{ id: 'e1', tabId: 'tabA', status: 'pending' }],
      tabB: [{ id: 'e2', tabId: 'tabB', status: 'pending' }]
    }
    expect(visibleEntries(entriesByTab, 'tabA')).toEqual(entriesByTab.tabA)
    expect(visibleEntries(entriesByTab, 'tabB')).toEqual(entriesByTab.tabB)
  })

  it('returns an empty array for a tab with no history yet', () => {
    expect(visibleEntries({}, 'tabC')).toEqual([])
    expect(visibleEntries({ tabA: [{ id: 'e1', status: 'pending' }] }, 'tabC')).toEqual([])
  })

  it('hides an answered entry with no Research Card (empty lookup)', () => {
    const entriesByTab = {
      tabA: [
        { id: 'e1', tabId: 'tabA', status: 'answered', answer: 'null' },
        { id: 'e2', tabId: 'tabA', status: 'pending', question: 'Q' }
      ]
    }
    expect(visibleEntries(entriesByTab, 'tabA')).toEqual([entriesByTab.tabA[1]])
  })

  it('puts newer entries first so the latest lookup is at the top', () => {
    const older = { id: 'e1', tabId: 'tabA', status: 'pending', at: 100 }
    const newer = { id: 'e2', tabId: 'tabA', status: 'pending', at: 200 }
    expect(visibleEntries({ tabA: [older, newer] }, 'tabA')).toEqual([newer, older])
  })
})

describe('isSkimVisibleEntry', () => {
  it('shows pending and errored entries', () => {
    expect(isSkimVisibleEntry({ status: 'pending' })).toBe(true)
    expect(isSkimVisibleEntry({ status: 'errored', error: 'x' })).toBe(true)
  })
})

describe('buildManualAskRequest', () => {
  it('reuses the voice request shape with the typed question as query, no extra context/notes', () => {
    expect(buildManualAskRequest('What is a haiku?')).toEqual({
      kind: 'voice',
      query: 'What is a haiku?',
      context: '',
      notes: ''
    })
  })

  it('trims whitespace and caps an overlong question', () => {
    const huge = 'x'.repeat(1000)
    const result = buildManualAskRequest(`  ${huge}  `)
    expect(result.query).toBe(huge.slice(0, 500))
  })
})

describe('applyTranscriptState/applyTranscriptLine', () => {
  it('applyTranscriptState replaces the full lines-so-far on replay', () => {
    const lines = [{ id: '1', speaker: 'Host', text: 'Hi', at: 1 }]
    expect(applyTranscriptState([], { lines })).toEqual(lines)
  })

  it('applyTranscriptLine appends one line without touching earlier ones', () => {
    const before = [{ id: '1', speaker: 'Host', text: 'Hi', at: 1 }]
    const after = applyTranscriptLine(before, { id: '2', speaker: 'Guest', text: 'Hey', at: 2 })
    expect(after).toEqual([...before, { id: '2', speaker: 'Guest', text: 'Hey', at: 2 }])
    expect(after).not.toBe(before)
  })
})

describe('buildTurnActionRequest', () => {
  const lines = [
    { id: 't1', speaker: 'Host', text: 'I only watch TV shows in the summer.', at: 1 },
    { id: 't2', speaker: 'Guest', text: 'Sometimes I like to watch things on TV and then other times I don\'t.', at: 2 },
    { id: 't3', speaker: 'Host', text: 'jesus laid in a manager', at: 3 },
    { id: 't4', speaker: 'Guest', text: 'wait what', at: 4 }
  ]

  it('uses the Focus Turn as focus and two before plus one after as Grounding', () => {
    expect(buildTurnActionRequest(lines, 't3', 'facts')).toEqual({
      kind: 'turnAction',
      actionId: 'facts',
      focus: 'Host: jesus laid in a manager',
      grounding:
        "Host: I only watch TV shows in the summer.\nGuest: Sometimes I like to watch things on TV and then other times I don't.\nGuest: wait what"
    })
  })

  it('omits after-Grounding when the Focus Turn is last', () => {
    const result = buildTurnActionRequest(lines, 't4', 'definition')
    expect(result.focus).toBe('Guest: wait what')
    expect(result.grounding).toBe(
      "Guest: Sometimes I like to watch things on TV and then other times I don't.\nHost: jesus laid in a manager"
    )
  })

  it('returns null for an unknown action or missing Turn', () => {
    expect(buildTurnActionRequest(lines, 't3', 'bogus')).toBeNull()
    expect(buildTurnActionRequest(lines, 'missing', 'facts')).toBeNull()
  })
})

describe('activeNotesTabText / Custom', () => {
  it('returns an ordinary tab\'s own tab_text, never another tab\'s', () => {
    const tabTexts = { tabA: 'Tab A content', tabB: 'Tab B content' }
    expect(activeNotesTabText(tabTexts, 'tabA')).toBe('Tab A content')
    expect(activeNotesTabText(tabTexts, 'tabB')).toBe('Tab B content')
  })

  it('returns empty string for the Transcript tab — Custom does not run on Turns', () => {
    expect(activeNotesTabText({ [TRANSCRIPT_TAB_ID]: 'nope', tabA: 'notes' }, TRANSCRIPT_TAB_ID)).toBe('')
  })

  it('buildCustomRequest uses the notes text as lyrics and the Transcript as Stage 2', () => {
    expect(buildCustomRequest('  hello  ')).toEqual({ kind: 'custom', text: 'hello', transcript: '' })
    expect(buildCustomRequest('lyrics', [{ speaker: 'Host', text: 'this is about grief' }])).toEqual({
      kind: 'custom',
      text: 'lyrics',
      transcript: 'Host: this is about grief'
    })
    expect(buildCustomRequest('')).toBeNull()
  })

  it('hasCustomText is true only for non-whitespace', () => {
    expect(hasCustomText('notes')).toBe(true)
    expect(hasCustomText('   ')).toBe(false)
  })
})

describe('describeResearchError', () => {
  it('maps a known error code to a short, user-visible explanation', () => {
    expect(describeResearchError({ error: 'TIMEOUT' })).toMatch(/took too long/i)
    expect(describeResearchError({ error: 'UPSTREAM_ERROR' })).toMatch(/could not be reached/i)
    expect(describeResearchError({ error: 'unauthorized' })).toMatch(/rejoin/i)
  })

  it('falls back to a generic explanation for an unknown or missing error code', () => {
    expect(describeResearchError({ error: 'SOMETHING_NEW' })).toMatch(/something went wrong/i)
    expect(describeResearchError(null)).toMatch(/something went wrong/i)
    expect(describeResearchError(undefined)).toMatch(/something went wrong/i)
  })
})

describe('dedupeCitationsByHost', () => {
  it('collapses citations to one per bare host, dropping the www. prefix', () => {
    const result = dedupeCitationsByHost([
      { url: 'https://en.wikipedia.org/wiki/The_White_Stripes', title: 'The White Stripes — Wikipedia' },
      { url: 'https://www.rollingstone.com/music/x', title: 'Rolling Stone' }
    ])
    expect(result).toEqual([
      { url: 'https://en.wikipedia.org/wiki/The_White_Stripes', host: 'en.wikipedia.org' },
      { url: 'https://www.rollingstone.com/music/x', host: 'rollingstone.com' }
    ])
  })

  it('keeps only the first citation for a repeated host', () => {
    const result = dedupeCitationsByHost([
      { url: 'https://en.wikipedia.org/wiki/Jack_White', title: 'Jack White' },
      { url: 'https://en.wikipedia.org/wiki/Meg_White', title: 'Meg White' }
    ])
    expect(result).toEqual([{ url: 'https://en.wikipedia.org/wiki/Jack_White', host: 'en.wikipedia.org' }])
  })

  it('skips a citation with an unparseable/missing url rather than throwing', () => {
    expect(dedupeCitationsByHost([{ url: 'not-a-url' }, { url: null }])).toEqual([])
  })

  it('handles a missing/empty citations list', () => {
    expect(dedupeCitationsByHost(undefined)).toEqual([])
    expect(dedupeCitationsByHost([])).toEqual([])
  })
})

describe('deriveDoneActionsByTurn', () => {
  it('groups turn-action entries by turnId, ignoring manual/custom asks with no turnId', () => {
    const entriesByTab = {
      transcript: [
        { id: 'e1', turnId: 't1', actionId: 'definition' },
        { id: 'e2', turnId: 't1', actionId: 'facts' },
        { id: 'e3', question: 'a manual question' } // no turnId/actionId
      ],
      notesTab: [{ id: 'e4', turnId: 't2', actionId: 'answer' }]
    }
    expect(deriveDoneActionsByTurn(entriesByTab)).toEqual({
      t1: ['definition', 'facts'],
      t2: ['answer']
    })
  })

  it('returns an empty object for no entries anywhere', () => {
    expect(deriveDoneActionsByTurn({})).toEqual({})
  })
})
