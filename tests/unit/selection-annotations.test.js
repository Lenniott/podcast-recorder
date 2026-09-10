import { describe, it, expect } from 'vitest'
import {
  PROMPT_ACTION_PREFIX,
  promptActionId,
  parsePromptActionId,
  customPromptActions,
  resolveSelectionSurface,
  buildAnnotationAskPayload,
  formatTranscriptForPrompt
} from '../../src/lib/room/selection-annotations.js'

// Every fixture here references {selection} — these tests are about the
// popup's own behavior once a prompt is eligible for it. The usesSelection
// split itself (which prompts even reach this function) has its own
// dedicated describe block below.
const PROMPTS = [
  { id: 'cp_a', title: 'Fact check', usesSelection: true },
  { id: 'cp_b', title: 'Define it', usesSelection: true },
  { id: 'cp_c', title: 'Give me a follow-up question', usesSelection: true }
]

describe('customPromptActions — one popup button per configured Custom Prompt', () => {
  it('renders every configured prompt as its own action, in the configured order', () => {
    const actions = customPromptActions(PROMPTS, { canRun: true })
    expect(actions).toHaveLength(3)
    expect(actions.map((a) => a.label)).toEqual(['Fact check', 'Define it', 'Give me a follow-up question'])
    expect(actions.every((a) => a.disabled === false)).toBe(true)
  })

  it('gives each action an id that round-trips back to its prompt id', () => {
    for (const action of customPromptActions(PROMPTS, { canRun: true })) {
      expect(action.id.startsWith(PROMPT_ACTION_PREFIX)).toBe(true)
    }
    expect(parsePromptActionId(promptActionId('cp_a'))).toBe('cp_a')
  })

  it("never collides with a built-in action id — 'comment' is not a prompt", () => {
    expect(parsePromptActionId('comment')).toBe(null)
    // Even a prompt whose id is literally "comment" stays namespaced.
    const [action] = customPromptActions([{ id: 'comment', title: 'Comment-ish', usesSelection: true }], { canRun: true })
    expect(action.id).not.toBe('comment')
    expect(parsePromptActionId(action.id)).toBe('comment')
  })

  it('still lists every eligible prompt without Research Access, but disabled and explained', () => {
    const actions = customPromptActions(PROMPTS, { canRun: false })
    expect(actions).toHaveLength(3)
    expect(actions.every((a) => a.disabled === true)).toBe(true)
    expect(actions[0].title).toMatch(/host/i)
  })

  it('skips a prompt with no usable title — there is no button to render', () => {
    expect(customPromptActions([{ id: 'cp_a', title: '   ', usesSelection: true }, { title: 'no id', usesSelection: true }], { canRun: true })).toEqual([])
    expect(customPromptActions(null, { canRun: true })).toEqual([])
  })

  // The split itself (structured-research-output panel-buttons feature) —
  // a prompt whose template never references {selection} has nothing to
  // run against a highlight, so it never gets a button here at all,
  // regardless of title/canRun. It gets a panel button instead — see
  // research-panel.js's panelPromptButtons.
  it('excludes a prompt that does not reference {selection} — it belongs in the panel, not the popup', () => {
    const mixed = [
      { id: 'cp_a', title: 'Fact check', usesSelection: true },
      { id: 'cp_z', title: 'Daily recap', usesSelection: false }
    ]
    expect(customPromptActions(mixed, { canRun: true }).map((a) => a.label)).toEqual(['Fact check'])
  })

  it('a prompt with usesSelection missing entirely (an old/unexpected shape) is excluded, not assumed eligible', () => {
    expect(customPromptActions([{ id: 'cp_a', title: 'No flag' }], { canRun: true })).toEqual([])
  })
})

// A stand-in for a DOM element: `contains` is the only thing surface
// resolution uses, which is exactly the point — nothing here knows or cares
// whether the element is a contenteditable, a <p> or a Transcript Turn.
function fakeEl(...owned) {
  const el = { contains: (node) => owned.includes(node) }
  return el
}

function fakeSelection(anchorNode) {
  return { rangeCount: 1, anchorNode }
}

describe('resolveSelectionSurface — surface-agnostic (ticket 06 registers, it does not fork)', () => {
  it('finds the surface containing the selection and reports its tabId', () => {
    const node = {}
    const notes = fakeEl(node)
    const transcript = fakeEl()
    const surfaces = [
      { el: notes, tabId: 'tab-1' },
      { el: transcript, tabId: 'transcript' }
    ]
    expect(resolveSelectionSurface(surfaces, fakeSelection(node))).toBe(surfaces[0])
  })

  it('resolves a selection in a second, later-registered surface identically', () => {
    const turnNode = {}
    const surfaces = [
      { el: fakeEl(), tabId: 'tab-1' },
      { el: fakeEl(turnNode), tabId: 'transcript' }
    ]
    // This is precisely what ticket 06 needs: adding an entry, not a branch.
    expect(resolveSelectionSurface(surfaces, fakeSelection(turnNode)).tabId).toBe('transcript')
  })

  it('matches a selection anchored on the surface element itself', () => {
    const el = fakeEl()
    expect(resolveSelectionSurface([{ el, tabId: 'tab-1' }], fakeSelection(el)).tabId).toBe('tab-1')
  })

  it('returns null for a selection elsewhere on the page, a collapsed one, or no surfaces', () => {
    const surfaces = [{ el: fakeEl(), tabId: 'tab-1' }]
    expect(resolveSelectionSurface(surfaces, fakeSelection({}))).toBe(null)
    expect(resolveSelectionSurface(surfaces, { rangeCount: 0, anchorNode: {} })).toBe(null)
    expect(resolveSelectionSurface(surfaces, null)).toBe(null)
    expect(resolveSelectionSurface([], fakeSelection({}))).toBe(null)
    expect(resolveSelectionSurface(null, fakeSelection({}))).toBe(null)
  })

  it('ignores a surface with no element or no tab, rather than filing an Annotation nowhere', () => {
    const node = {}
    const surfaces = [{ el: null, tabId: 'tab-1' }, { el: fakeEl(node), tabId: '' }]
    expect(resolveSelectionSurface(surfaces, fakeSelection(node))).toBe(null)
  })
})

describe('buildAnnotationAskPayload', () => {
  const base = {
    id: 'ann-1',
    tabId: 'tab-1',
    customPromptId: 'cp_a',
    quote: '  the moon landing  ',
    currentTab: 'all the notes',
    transcript: 'Host: hello',
    videoTitle: ' Episode 12 '
  }

  it('is a card ask carrying the trimmed excerpt as the quote', () => {
    expect(buildAnnotationAskPayload(base)).toEqual({
      type: 'annotation_ask',
      tabId: 'tab-1',
      id: 'ann-1',
      kind: 'card',
      customPromptId: 'cp_a',
      quote: 'the moon landing',
      currentTab: 'all the notes',
      transcript: 'Host: hello',
      videoTitle: 'Episode 12'
    })
  })

  it('carries no typed follow-up of any kind — a Custom Prompt fires as it stands', () => {
    const payload = buildAnnotationAskPayload(base)
    expect(payload).not.toHaveProperty('question')
    expect(payload).not.toHaveProperty('text')
  })

  it('refuses to build an ask with nothing highlighted, no tab, or no prompt', () => {
    expect(buildAnnotationAskPayload({ ...base, quote: '   ' })).toBe(null)
    expect(buildAnnotationAskPayload({ ...base, quote: undefined })).toBe(null)
    expect(buildAnnotationAskPayload({ ...base, tabId: null })).toBe(null)
    expect(buildAnnotationAskPayload({ ...base, customPromptId: '' })).toBe(null)
    expect(buildAnnotationAskPayload({ ...base, id: '' })).toBe(null)
  })

  it('defaults missing context to empty strings rather than undefined on the wire', () => {
    const payload = buildAnnotationAskPayload({ id: 'a', tabId: 't', customPromptId: 'p', quote: 'q' })
    expect(payload).toMatchObject({ currentTab: '', transcript: '', videoTitle: '' })
  })
})

describe('formatTranscriptForPrompt', () => {
  it('joins Turns the same "Speaker: text" way the panel already does', () => {
    expect(formatTranscriptForPrompt([
      { speaker: 'Host', text: 'hello' },
      { speaker: 'Guest', text: 'hi' }
    ])).toBe('Host: hello\nGuest: hi')
    expect(formatTranscriptForPrompt(null)).toBe('')
  })
})
