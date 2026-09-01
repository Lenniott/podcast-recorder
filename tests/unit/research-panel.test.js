import { describe, it, expect } from 'vitest'
import {
  applyResearchEntry,
  applyResearchState,
  visibleEntries,
  buildManualAskRequest,
  buildQuickActionRequest,
  applyTranscriptState,
  applyTranscriptLine,
  activeTabText,
  hasQuickActionText,
  recentTranscriptText,
  hasRecentTranscript,
  buildRecentTranscriptRequest,
  describeResearchError,
  makeResearchEntryId
} from '../../src/lib/research-panel.js'
import { TRANSCRIPT_TAB_ID } from '../../src/lib/transcript-sync.js'
import { MAX_TAB_TEXT_LEN } from '../../src/lib/tab-sync.js'

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
    expect(after.tabB).toEqual(before.tabB) // untouched
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

describe('visibleEntries', () => {
  it('returns only the active tab\'s entries, never another tab\'s', () => {
    const entriesByTab = {
      tabA: [{ id: 'e1', tabId: 'tabA' }],
      tabB: [{ id: 'e2', tabId: 'tabB' }]
    }
    expect(visibleEntries(entriesByTab, 'tabA')).toEqual(entriesByTab.tabA)
    expect(visibleEntries(entriesByTab, 'tabB')).toEqual(entriesByTab.tabB)
  })

  it('returns an empty array for a tab with no history yet', () => {
    expect(visibleEntries({}, 'tabC')).toEqual([])
    expect(visibleEntries({ tabA: [{ id: 'e1' }] }, 'tabC')).toEqual([])
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

describe('buildQuickActionRequest', () => {
  it.each([
    ['define', 'Define the term.'],
    ['keyFacts', 'Some facts here.'],
    ['factCheck', 'A claim to check.'],
    ['findExamples', 'A topic to exemplify.'],
    ['analyze', 'Some text to analyze.']
  ])('builds a quickAction request for %s using the active tab\'s full text', (actionId, text) => {
    expect(buildQuickActionRequest(actionId, text)).toEqual({ kind: 'quickAction', actionId, text })
  })

  it('trims surrounding whitespace from the tab text', () => {
    expect(buildQuickActionRequest('define', '  hello world  ')).toEqual({
      kind: 'quickAction',
      actionId: 'define',
      text: 'hello world'
    })
  })

  it('returns null for empty text — nothing to act on, never a request with empty text', () => {
    expect(buildQuickActionRequest('define', '')).toBeNull()
  })

  it('returns null for whitespace-only text — nothing to act on', () => {
    expect(buildQuickActionRequest('define', '   \n\t  ')).toBeNull()
  })

  it('returns null for a missing/unknown actionId', () => {
    expect(buildQuickActionRequest('notARealAction', 'some text')).toBeNull()
    expect(buildQuickActionRequest(undefined, 'some text')).toBeNull()
  })

  it('caps an overlong tab text at the endpoint\'s own max text length', () => {
    const huge = 'x'.repeat(21000)
    const result = buildQuickActionRequest('analyze', huge)
    expect(result.text).toBe(huge.slice(0, 20000))
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

describe('activeTabText', () => {
  it('returns an ordinary tab\'s own tab_text, never another tab\'s', () => {
    const tabTexts = { tabA: 'Tab A content', tabB: 'Tab B content' }
    expect(activeTabText(tabTexts, [], 'tabA')).toBe('Tab A content')
    expect(activeTabText(tabTexts, [], 'tabB')).toBe('Tab B content')
  })

  it('returns empty string for a tab with no text yet', () => {
    expect(activeTabText({}, [], 'tabA')).toBe('')
  })

  it('for the reserved Transcript tab id, joins the transcript lines-so-far into one block of text', () => {
    const lines = [
      { id: '1', speaker: 'Host', text: 'Welcome to the show.', at: 1 },
      { id: '2', speaker: 'Guest', text: 'Thanks for having me.', at: 2 }
    ]
    expect(activeTabText({ tabA: 'ignored' }, lines, TRANSCRIPT_TAB_ID)).toBe(
      'Host: Welcome to the show.\nGuest: Thanks for having me.'
    )
  })

  it('returns empty string for the Transcript tab when there are no lines yet', () => {
    expect(activeTabText({}, [], TRANSCRIPT_TAB_ID)).toBe('')
  })
})

describe('hasQuickActionText', () => {
  it('is true when there is non-whitespace text', () => {
    expect(hasQuickActionText('some notes')).toBe(true)
    expect(hasQuickActionText('  padded  ')).toBe(true)
  })

  it('is false for empty, whitespace-only, or missing text', () => {
    expect(hasQuickActionText('')).toBe(false)
    expect(hasQuickActionText('   \n\t  ')).toBe(false)
    expect(hasQuickActionText(null)).toBe(false)
    expect(hasQuickActionText(undefined)).toBe(false)
  })
})

describe('recentTranscriptText', () => {
  const NOW = 100_000

  it('joins only lines within the window, oldest first, in "Speaker: text" form', () => {
    const lines = [
      { id: '1', speaker: 'Host', text: 'Too old to count.', at: NOW - 700_000 },
      { id: '2', speaker: 'Guest', text: 'This is recent.', at: NOW - 5_000 },
      { id: '3', speaker: 'Host', text: 'So is this.', at: NOW - 1_000 }
    ]
    expect(recentTranscriptText(lines, 600_000, NOW)).toBe('Guest: This is recent.\nHost: So is this.')
  })

  it('returns an empty string when nothing falls in the window', () => {
    const lines = [{ id: '1', speaker: 'Host', text: 'Ancient history.', at: NOW - 700_000 }]
    expect(recentTranscriptText(lines, 600_000, NOW)).toBe('')
  })

  it('returns an empty string for an empty or missing transcript', () => {
    expect(recentTranscriptText([], 600_000, NOW)).toBe('')
    expect(recentTranscriptText(undefined, 600_000, NOW)).toBe('')
  })

  it('defaults to a 10-minute window when none is given', () => {
    const lines = [
      { id: '1', speaker: 'Host', text: 'Eleven minutes ago.', at: Date.now() - 11 * 60_000 },
      { id: '2', speaker: 'Host', text: 'Five minutes ago.', at: Date.now() - 5 * 60_000 }
    ]
    expect(recentTranscriptText(lines)).toBe('Host: Five minutes ago.')
  })
})

describe('hasRecentTranscript', () => {
  it('is true for non-whitespace text, false otherwise (same rule as hasQuickActionText)', () => {
    expect(hasRecentTranscript('Host: hello')).toBe(true)
    expect(hasRecentTranscript('')).toBe(false)
    expect(hasRecentTranscript('   ')).toBe(false)
    expect(hasRecentTranscript(null)).toBe(false)
  })
})

describe('buildRecentTranscriptRequest', () => {
  const NOW = 100_000

  it('builds a topic-less voice request with the recent window as context', () => {
    const lines = [{ id: '1', speaker: 'Host', text: 'Tariffs are back in the news.', at: NOW - 1_000 }]
    expect(buildRecentTranscriptRequest(lines, 600_000, NOW)).toEqual({
      kind: 'voice',
      query: null,
      context: 'Host: Tariffs are back in the news.',
      notes: ''
    })
  })

  it('returns null when there is nothing in the window — never a request sent with empty context', () => {
    expect(buildRecentTranscriptRequest([], 600_000, NOW)).toBeNull()
    const tooOld = [{ id: '1', speaker: 'Host', text: 'Ancient.', at: NOW - 700_000 }]
    expect(buildRecentTranscriptRequest(tooOld, 600_000, NOW)).toBeNull()
  })

  it('puts older lines in notes as Grounding and keeps the in-window lines as Focus', () => {
    const lines = [
      { id: '1', speaker: 'Ben', text: 'so Jack White', at: NOW - 700_000 },
      { id: '2', speaker: 'Ben', text: 'I think they did a cover of Jolene', at: NOW - 1_000 }
    ]
    expect(buildRecentTranscriptRequest(lines, 600_000, NOW)).toEqual({
      kind: 'voice',
      query: null,
      context: 'Ben: I think they did a cover of Jolene',
      notes: 'Ben: so Jack White'
    })
  })

  it('leaves notes empty when the whole transcript is in the window', () => {
    const lines = [
      { id: '1', speaker: 'Host', text: 'One.', at: NOW - 2_000 },
      { id: '2', speaker: 'Guest', text: 'Two.', at: NOW - 1_000 }
    ]
    expect(buildRecentTranscriptRequest(lines, 600_000, NOW)).toEqual({
      kind: 'voice',
      query: null,
      context: 'Host: One.\nGuest: Two.',
      notes: ''
    })
  })

  it('keeps all of Focus and drops the oldest Grounding when the pair would exceed the wire budget', () => {
    const recent = { id: 'r', speaker: 'Ben', text: 'I think they did a cover of Jolene', at: NOW - 1_000 }
    const focus = `Ben: ${recent.text}`
    const budgetForGrounding = MAX_TAB_TEXT_LEN - focus.length
    const oldKeep = { id: 'k', speaker: 'Ben', text: 'x'.repeat(80), at: NOW - 700_000 }
    const keepText = `Ben: ${oldKeep.text}`
    const dropText = 'Ben: ' + 'y'.repeat(budgetForGrounding) // one oversized old line, dropped whole
    const oldDrop = { id: 'd', speaker: 'Ben', text: dropText.slice('Ben: '.length), at: NOW - 800_000 }

    const result = buildRecentTranscriptRequest([oldDrop, oldKeep, recent], 600_000, NOW)
    expect(result.context).toBe(focus)
    expect(result.notes).toBe(keepText)
    expect(result.context.length + result.notes.length).toBeLessThanOrEqual(MAX_TAB_TEXT_LEN)
    expect(result.notes).not.toContain('y')
  })

  it('keeps the newest end of Focus and drops Grounding when Focus alone exceeds the wire budget', () => {
    const huge = 'z'.repeat(MAX_TAB_TEXT_LEN + 50)
    const lines = [
      { id: '1', speaker: 'Ben', text: 'earlier', at: NOW - 700_000 },
      { id: '2', speaker: 'Ben', text: huge, at: NOW - 1_000 }
    ]
    const result = buildRecentTranscriptRequest(lines, 600_000, NOW)
    expect(result.notes).toBe('')
    expect(result.context.length).toBe(MAX_TAB_TEXT_LEN)
    expect(result.context.endsWith('z'.repeat(20))).toBe(true)
    expect(result.context).not.toContain('earlier')
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
