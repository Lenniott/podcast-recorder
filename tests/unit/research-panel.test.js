import { describe, it, expect } from 'vitest'
import {
  applyResearchEntry,
  applyResearchState,
  visibleEntries,
  buildManualAskRequest,
  buildQuickActionRequest,
  describeResearchError,
  makeResearchEntryId
} from '../../src/lib/research-panel.js'

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
