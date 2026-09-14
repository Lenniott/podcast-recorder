import { describe, it, expect } from 'vitest'
import {
  applyResearchEntry,
  applyResearchState,
  applyResearchRemove,
  visibleEntries,
  panelFeed,
  applyTranscriptState,
  applyTranscriptLine,
  activeNotesTabText,
  activeTabVideoTitle,
  formatCurrentTabContext,
  isSkimVisibleEntry,
  makeResearchEntryId,
  dedupeCitationsByHost,
  panelPromptButtons
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

describe('panelFeed', () => {
  it('projects one newest-first feed from active-tab research, active-tab Annotations, and room-wide Transcript Annotations', () => {
    const activeTabId = 'tab-1'
    const annotationsByTab = {
      'tab-1': [{ id: 'same', tabId: 'tab-1', kind: 'comment', quote: 'notes', text: 'note', at: 20 }],
      'tab-2': [{ id: 'hidden', tabId: 'tab-2', kind: 'comment', quote: 'other', text: 'other', at: 99 }],
      transcript: [{ id: 'turn', tabId: 'transcript', kind: 'comment', quote: 'turn', text: 'note', at: 30 }]
    }
    const entriesByTab = {
      'tab-1': [{ id: 'same', tabId: 'tab-1', question: 'Ask?', status: 'pending', at: 10 }],
      'tab-2': [{ id: 'hidden-research', tabId: 'tab-2', question: 'No', status: 'pending', at: 100 }]
    }

    expect(panelFeed({ annotationsByTab, entriesByTab, activeTabId }).map(({ type, key, id }) => ({ type, key, id }))).toEqual([
      { type: 'annotation', key: 'annotation:turn', id: 'turn' },
      { type: 'annotation', key: 'annotation:same', id: 'same' },
      { type: 'research', key: 'research:same', id: 'same' }
    ])
  })

  it('breaks timestamp ties by composite key so projection order is deterministic', () => {
    const rows = panelFeed({
      annotationsByTab: { 'tab-1': [{ id: 'z', tabId: 'tab-1', kind: 'comment', quote: 'q', text: 'n', at: 5 }] },
      entriesByTab: { 'tab-1': [{ id: 'a', tabId: 'tab-1', question: 'Ask?', status: 'pending', at: 5 }] },
      activeTabId: 'tab-1'
    })
    expect(rows.map((row) => row.key)).toEqual(['annotation:z', 'research:a'])
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

describe('activeNotesTabText', () => {
  it('returns an ordinary tab\'s own tab_text, never another tab\'s', () => {
    const tabTexts = { tabA: 'Tab A content', tabB: 'Tab B content' }
    expect(activeNotesTabText(tabTexts, 'tabA')).toBe('Tab A content')
    expect(activeNotesTabText(tabTexts, 'tabB')).toBe('Tab B content')
  })

  it('returns empty string for the Transcript tab — a Custom Prompt anchored to a Turn is a separate Annotation path, not this one', () => {
    expect(activeNotesTabText({ [TRANSCRIPT_TAB_ID]: 'nope', tabA: 'notes' }, TRANSCRIPT_TAB_ID)).toBe('')
  })
})

describe('formatCurrentTabContext / video title', () => {
  it('is notes-only when there is no video title', () => {
    expect(formatCurrentTabContext('the lyrics', '')).toBe('the lyrics')
    expect(formatCurrentTabContext('the lyrics')).toBe('the lyrics')
  })

  it('puts Video: title first, then notes, when a title is available', () => {
    expect(formatCurrentTabContext('the lyrics', 'Never Gonna Give You Up')).toBe(
      'Video: Never Gonna Give You Up\n\nthe lyrics'
    )
  })

  it('is title-only when notes are empty', () => {
    expect(formatCurrentTabContext('', 'Never Gonna Give You Up')).toBe('Video: Never Gonna Give You Up')
    expect(formatCurrentTabContext('   ', 'Never Gonna Give You Up')).toBe('Video: Never Gonna Give You Up')
  })

  it('ignores a whitespace-only title', () => {
    expect(formatCurrentTabContext('the lyrics', '   ')).toBe('the lyrics')
  })

  it('activeTabVideoTitle is the active notes tab\'s title, never the Transcript tab', () => {
    const titles = { tabA: 'Song A', tabB: 'Song B', [TRANSCRIPT_TAB_ID]: 'nope' }
    expect(activeTabVideoTitle(titles, 'tabA')).toBe('Song A')
    expect(activeTabVideoTitle(titles, 'tabB')).toBe('Song B')
    expect(activeTabVideoTitle(titles, TRANSCRIPT_TAB_ID)).toBe('')
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

// panelPromptButtons — the mirror image of selection-annotations.js's
// customPromptActions: a Custom Prompt that does NOT reference {selection}
// has nothing to run against a highlight, so it gets a standalone button
// here instead of a popup entry. See selection-annotations.test.js's own
// "excludes a prompt that does not reference {selection}" for the popup's
// half of this split.
describe('panelPromptButtons', () => {
  const PROMPTS = [
    { id: 'cp_recap', title: 'Daily recap', usesSelection: false },
    { id: 'cp_fact', title: 'Fact check', usesSelection: true },
    { id: 'cp_time', title: 'What time is it', usesSelection: false }
  ]

  it('includes only prompts that do not reference {selection}, in configured order', () => {
    const buttons = panelPromptButtons(PROMPTS, { canRun: true })
    expect(buttons.map((b) => b.id)).toEqual(['cp_recap', 'cp_time'])
    expect(buttons.map((b) => b.label)).toEqual(['Daily recap', 'What time is it'])
  })

  it('every button is enabled and unexplained when canRun is true', () => {
    const buttons = panelPromptButtons(PROMPTS, { canRun: true })
    expect(buttons.every((b) => b.disabled === false)).toBe(true)
  })

  it('lists eligible prompts disabled, with an explanation, when canRun is false — never hidden', () => {
    const buttons = panelPromptButtons(PROMPTS, { canRun: false })
    expect(buttons).toHaveLength(2)
    expect(buttons.every((b) => b.disabled === true)).toBe(true)
    expect(buttons[0].title).toMatch(/host/i)
  })

  it('skips a prompt with no usable title', () => {
    expect(panelPromptButtons([{ id: 'cp_a', title: '   ', usesSelection: false }], { canRun: true })).toEqual([])
  })

  it('a prompt with usesSelection missing entirely is excluded, not assumed panel-eligible', () => {
    expect(panelPromptButtons([{ id: 'cp_a', title: 'No flag' }], { canRun: true })).toEqual([])
  })

  it('handles a missing/empty prompt list', () => {
    expect(panelPromptButtons(undefined, { canRun: true })).toEqual([])
    expect(panelPromptButtons([], { canRun: true })).toEqual([])
  })
})
