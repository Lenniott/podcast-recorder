/**
 * Ticket 06 (ADR-0008) — the Transcript retires as a Tab and becomes a
 * personal facet of the right-hand panel.
 *
 * Two kinds of assertion live here, deliberately:
 *
 *  1. LOGIC. Highlighting a Turn goes through exactly the same
 *     surface-resolution and payload-building functions Notes text does
 *     (selection-annotations.js), and the panel's feed derivation
 *     (annotation-panel.js). Those are pure modules, so they are exercised
 *     for real, not described.
 *
 *  2. WIRING, read off the components' source. This repo has no
 *     component-mounting harness (vitest runs in `node` and .svelte files
 *     are excluded from coverage), so "the pill is gone" and "the facet
 *     toggle is never sent over the WS" are checked by reading the files.
 *     That is weaker than a rendered assertion, but it is not vacuous: each
 *     one below would fail loudly if someone re-added the pill or started
 *     broadcasting the facet, which are precisely the regressions this
 *     ticket must prevent.
 *
 * Nothing here touches fetch, the Research Assistant, or any network path —
 * a Custom Prompt fired from a highlight sends a WS message and the server
 * makes the call, so there is no client-side LLM request to mock.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  resolveSelectionSurface,
  buildAnnotationAskPayload,
  customPromptActions,
  formatTranscriptForPrompt
} from '../../src/lib/room/selection-annotations.js'
import {
  visibleAnnotations,
  visibleAnnotationsForRoom,
  applyAnnotationEntry
} from '../../src/lib/research/annotation-panel.js'
import { TRANSCRIPT_TAB_ID } from '../../src/lib/room/transcript-sync.js'

const src = (path) => readFileSync(fileURLToPath(new URL(`../../src/${path}`, import.meta.url)), 'utf8')

/**
 * Source with every comment removed. These files explain themselves at
 * length — including, necessarily, by *naming* the things ticket 06
 * retired ("there is no longer a viewingTranscript…") — so a
 * must-not-contain assertion run over the raw text would fail on the very
 * comment documenting the removal. Stripping comments first means these
 * assertions are about code, not prose.
 */
function code(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const ROOM_TABS = code(src('lib/room/RoomTabs.svelte'))
const RESEARCH_PANEL = code(src('lib/research/ResearchPanel.svelte'))
const TRANSCRIPT_FACET = code(src('lib/research/TranscriptFacet.svelte'))
const RECORDING_ROOM = code(src('lib/recording/RecordingRoom.svelte'))
const ROOM_PAGE = code(src('routes/rec/[slug]/+page.svelte'))

// ─────────────────────────────────────────────────────────────────────────
// The pill is gone, and viewing the Transcript is not a broadcast action
// ─────────────────────────────────────────────────────────────────────────

describe('the Transcript pill is gone from the main tab strip', () => {
  it('the tab strip renders no Transcript pill', () => {
    expect(ROOM_TABS).not.toMatch(/transcript-pill/)
    expect(ROOM_TABS).not.toMatch(/aria-label="Transcript"/)
  })

  it('RoomTabs no longer has a switchToTranscript action or a viewingTranscript view flag', () => {
    expect(ROOM_TABS).not.toMatch(/function switchToTranscript/)
    expect(ROOM_TABS).not.toMatch(/\$:\s*viewingTranscript\s*=/)
  })

  it('RoomTabs no longer renders the Transcript itself — the panel does', () => {
    expect(ROOM_TABS).not.toMatch(/<TranscriptTab/)
    expect(RESEARCH_PANEL).toMatch(/<TranscriptFacet/)
  })

  it('every tab_switch destination in RoomTabs comes from the server\'s own tabs list', () => {
    // The only two tab_switch call sites are switchTab(tab.id) from the
    // {#each tabs} loop. Neither can name the reserved id.
    const switches = ROOM_TABS.match(/switchTab\(([^)]*)\)/g) || []
    expect(switches.length).toBeGreaterThan(0)
    for (const call of switches) {
      expect(call).not.toMatch(/TRANSCRIPT_TAB_ID/)
    }
  })
})

describe('no client code path can tab_switch to the reserved Transcript id', () => {
  const CLIENT_FILES = {
    'RoomTabs.svelte': ROOM_TABS,
    'ResearchPanel.svelte': RESEARCH_PANEL,
    'TranscriptFacet.svelte': TRANSCRIPT_FACET,
    'RecordingRoom.svelte': RECORDING_ROOM,
    '+page.svelte': ROOM_PAGE
  }

  it('no client component sends a tab_switch naming TRANSCRIPT_TAB_ID', () => {
    for (const [name, source] of Object.entries(CLIENT_FILES)) {
      const sends = source.match(/type:\s*["']tab_switch["'][^}]*}/g) || []
      for (const send of sends) {
        expect(`${name}: ${send}`).not.toMatch(/TRANSCRIPT_TAB_ID|["']transcript["']/)
      }
    }
  })

  it('the reserved id still exists, and is still what a Turn Annotation is filed under', () => {
    // Preserved on purpose: retiring the *view* must not retire the
    // *storage key* (ticket 03's per-tab convention).
    expect(TRANSCRIPT_TAB_ID).toBe('transcript')
    expect(ROOM_TABS).toMatch(/tabId:\s*TRANSCRIPT_TAB_ID/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Two facets, and the choice is personal
// ─────────────────────────────────────────────────────────────────────────

describe('the panel has both facets, toggled per-browser', () => {
  it('offers a Transcript facet and an Annotation feed facet', () => {
    expect(RESEARCH_PANEL).toMatch(/data-testid="facet-transcript"/)
    expect(RESEARCH_PANEL).toMatch(/data-testid="facet-annotations"/)
  })

  it('the selected facet is a plain local variable, never sent over the room WS', () => {
    // Clicking a facet button only assigns; there is no send() anywhere in
    // either handler, and no facet_switch message type exists at all.
    expect(RESEARCH_PANEL).toMatch(/on:click=\{\(\) => \(facet = "transcript"\)\}/)
    expect(RESEARCH_PANEL).toMatch(/on:click=\{\(\) => \(facet = "annotations"\)\}/)
    expect(RESEARCH_PANEL).not.toMatch(/facet_switch/)
    expect(ROOM_PAGE).not.toMatch(/facet_switch/)
  })

  it('the facet lives beside the panel\'s existing local collapsed state, bound the same way', () => {
    // The existing per-browser pattern: a plain `let` on the page, bound
    // down through RecordingRoom. Matching it is the point — not inventing
    // a second mechanism.
    expect(ROOM_PAGE).toMatch(/let researchCollapsed = false/)
    expect(ROOM_PAGE).toMatch(/let researchFacet = 'annotations'/)
    expect(ROOM_PAGE).toMatch(/bind:researchFacet/)
    expect(RECORDING_ROOM).toMatch(/bind:facet=\{researchFacet\}/)
  })

  it('no inbound WS message can change which facet this browser shows', () => {
    // Every apply* entry point the page routes into the panel, checked
    // against assigning `facet`. A room message must never move a
    // participant's own view (that is the whole reason the Tab was retired).
    const applyBodies = RESEARCH_PANEL.match(/export function apply\w+\([\s\S]*?\n  \}/g) || []
    expect(applyBodies.length).toBeGreaterThan(0)
    for (const body of applyBodies) {
      expect(body).not.toMatch(/\bfacet\s*=/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Highlighting a Turn: the same popup, the same Annotation, anchored right
// ─────────────────────────────────────────────────────────────────────────

/** Stands in for a DOM element — `contains` is all surface resolution uses. */
function fakeEl(...owned) {
  return { contains: (node) => owned.includes(node) }
}
const fakeSelection = (anchorNode) => ({ rangeCount: 1, anchorNode })

describe('highlighting a Turn produces a correctly Transcript-anchored Annotation', () => {
  const turnNode = {}
  const notesNode = {}
  const notesEl = fakeEl(notesNode)
  const transcriptEl = fakeEl(turnNode)

  /** Exactly the array RoomTabs.svelte builds for `selectionSurfaces`. */
  const surfaces = (activeTabId = 'tab-1') => [
    { el: notesEl, tabId: activeTabId },
    { el: transcriptEl, tabId: TRANSCRIPT_TAB_ID }
  ]

  it('a selection inside the Turn list resolves to the Transcript surface', () => {
    const surface = resolveSelectionSurface(surfaces(), fakeSelection(turnNode))
    expect(surface.tabId).toBe(TRANSCRIPT_TAB_ID)
  })

  it('a selection in Notes still resolves to the active tab — registering a surface forked nothing', () => {
    const surface = resolveSelectionSurface(surfaces('tab-7'), fakeSelection(notesNode))
    expect(surface.tabId).toBe('tab-7')
  })

  it('a Custom Prompt fired from a Turn files its Card under the Transcript id', () => {
    const surface = resolveSelectionSurface(surfaces(), fakeSelection(turnNode))
    const payload = buildAnnotationAskPayload({
      id: 'ann-1',
      tabId: surface.tabId,
      customPromptId: 'cp_a',
      quote: 'Welcome to the show.',
      transcript: formatTranscriptForPrompt([{ speaker: 'Host', text: 'Welcome to the show.' }])
    })
    expect(payload.type).toBe('annotation_ask')
    expect(payload.tabId).toBe(TRANSCRIPT_TAB_ID)
    expect(payload.kind).toBe('card')
    expect(payload.quote).toBe('Welcome to the show.')
  })

  it('a Comment left on a Turn is the same annotation_create, under the Transcript id', () => {
    // The shape RoomTabs.svelte's submitComment builds, with the tabId the
    // resolved surface handed it.
    const surface = resolveSelectionSurface(surfaces(), fakeSelection(turnNode))
    const payload = {
      type: 'annotation_create',
      tabId: surface.tabId,
      id: 'ann-2',
      kind: 'comment',
      quote: 'Thanks for having me.',
      text: 'good line'
    }
    expect(payload.tabId).toBe(TRANSCRIPT_TAB_ID)
  })

  it('the popup a Turn raises carries the SAME actions Notes gets — Comment plus every Custom Prompt', () => {
    // customPromptActions is surface-blind: RoomTabs builds one
    // `selectionActions` list and both surfaces raise it unchanged.
    const prompts = [{ id: 'cp_a', title: 'Fact check' }, { id: 'cp_b', title: 'Define it' }]
    const actions = customPromptActions(prompts, { canRun: true })
    expect(actions.map((a) => a.label)).toEqual(['Fact check', 'Define it'])
    expect(ROOM_TABS).toMatch(/id: SELECTION_ACTION_COMMENT/)
    // One popup, one actions list, both surfaces — no Transcript-only branch.
    expect((ROOM_TABS.match(/<SelectionPopup/g) || []).length).toBe(1)
    expect((ROOM_TABS.match(/\$: selectionActions =/g) || []).length).toBe(1)
  })

  it('the Transcript surface is registered exactly like Notes, in one array', () => {
    expect(ROOM_TABS).toMatch(/\$: selectionSurfaces = \[/)
    expect(ROOM_TABS).toMatch(/\{ el: transcriptEl, tabId: TRANSCRIPT_TAB_ID \}/)
  })
})

describe('a Turn Annotation reaches the panel feed whichever Notes tab is active', () => {
  const comment = (id, tabId, at) => ({ id, tabId, kind: 'comment', quote: 'q', text: 't', author: 'Host', at })

  it('lists the active tab s Annotations and every Turn-anchored one together, newest first', () => {
    const byTab = {
      'tab-1': [comment('n1', 'tab-1', 10)],
      'tab-2': [comment('n2', 'tab-2', 20)],
      [TRANSCRIPT_TAB_ID]: [comment('turn1', TRANSCRIPT_TAB_ID, 30)]
    }
    expect(visibleAnnotationsForRoom(byTab, 'tab-1').map((a) => a.id)).toEqual(['turn1', 'n1'])
    // Switching Notes tabs swaps the Notes rows but never hides the Turn one.
    expect(visibleAnnotationsForRoom(byTab, 'tab-2').map((a) => a.id)).toEqual(['turn1', 'n2'])
  })

  it('would have hidden Turn Annotations entirely under the old per-tab-only rule', () => {
    // Regression guard: activeTabId can never be TRANSCRIPT_TAB_ID any
    // more, so scoping the feed to it alone (visibleAnnotations) shows
    // nothing for the Transcript. That is why the feed uses the merged
    // derivation instead.
    const byTab = { 'tab-1': [], [TRANSCRIPT_TAB_ID]: [comment('turn1', TRANSCRIPT_TAB_ID, 30)] }
    expect(visibleAnnotations(byTab, 'tab-1')).toEqual([])
    expect(visibleAnnotationsForRoom(byTab, 'tab-1').map((a) => a.id)).toEqual(['turn1'])
  })

  it('a live annotation_entry for a Turn lands in the feed through the normal reducer', () => {
    const entry = comment('turn1', TRANSCRIPT_TAB_ID, 5)
    const byTab = applyAnnotationEntry({}, { tabId: TRANSCRIPT_TAB_ID, entry })
    expect(visibleAnnotationsForRoom(byTab, 'tab-1').map((a) => a.id)).toEqual(['turn1'])
    // And the Transcript-only view the facet uses for drawing highlights.
    expect(visibleAnnotations(byTab, TRANSCRIPT_TAB_ID).map((a) => a.id)).toEqual(['turn1'])
  })

  it('still refuses to merge one Notes tab s Annotations into another', () => {
    const byTab = { 'tab-1': [comment('n1', 'tab-1', 10)], 'tab-2': [comment('n2', 'tab-2', 20)] }
    expect(visibleAnnotationsForRoom(byTab, 'tab-1').map((a) => a.id)).toEqual(['n1'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The Transcript Activity pulse, and the lifted transcript state
// ─────────────────────────────────────────────────────────────────────────

describe('the Transcript Activity pulse moved to the facet toggle', () => {
  it('is gone from the tab strip', () => {
    expect(ROOM_TABS).not.toMatch(/transcript-activity-pulse/)
    expect(ROOM_TABS).not.toMatch(/applyTranscriptActivity/)
  })

  it('renders on the button that opens the Transcript facet', () => {
    const facetButton = RESEARCH_PANEL.slice(
      RESEARCH_PANEL.indexOf('data-testid="facet-transcript"'),
      RESEARCH_PANEL.indexOf('</div>', RESEARCH_PANEL.indexOf('data-testid="facet-transcript"'))
    )
    expect(facetButton).toMatch(/transcript-activity-pulse/)
  })

  it('is still visible when the whole panel is collapsed, on the only control left', () => {
    // Otherwise the heads-up would be invisible to exactly the participant
    // it exists for — someone with the panel shut.
    expect(RESEARCH_PANEL).toMatch(/collapsed && transcriptActivity/)
  })

  it('is fed by the room-shared transcript_activity broadcast, routed to the panel', () => {
    expect(RESEARCH_PANEL).toMatch(/export function applyTranscriptActivity/)
    expect(ROOM_PAGE).toMatch(/transcript_activity['"]\)\s*researchPanel\?\.applyTranscriptActivity/)
  })

  it('keeps this browser s own recognizer status separate from the room s pulse', () => {
    // Two different facts, two different indicators — see CONTEXT.md's
    // **Transcript Activity**. Both now live on the same button.
    expect(RESEARCH_PANEL).toMatch(/transcription-status-dot/)
    expect(RESEARCH_PANEL).toMatch(/export let transcriptionStatus/)
    expect(ROOM_TABS).not.toMatch(/transcription-status-dot/)
  })
})

describe('the live transcript state is relocated, not rebuilt', () => {
  it('is owned by the common parent and handed to both children', () => {
    expect(ROOM_PAGE).toMatch(/let transcriptLines = \[\]/)
    expect(ROOM_PAGE).toMatch(/reduceTranscriptState\(transcriptLines, msg\)/)
    expect(ROOM_PAGE).toMatch(/reduceTranscriptLine\(transcriptLines, msg\)/)
    expect(RECORDING_ROOM).toMatch(/export let transcriptLines/)
  })

  it('uses the same append/replay reducers as before — delivery and ordering are untouched', () => {
    expect(ROOM_PAGE).toMatch(/applyTranscriptState as reduceTranscriptState/)
    expect(ROOM_PAGE).toMatch(/applyTranscriptLine as reduceTranscriptLine/)
  })

  it('leaves neither child holding its own second copy', () => {
    for (const source of [ROOM_TABS, RESEARCH_PANEL]) {
      expect(source).not.toMatch(/export function applyTranscriptState/)
      expect(source).not.toMatch(/export function applyTranscriptLine/)
      expect(source).toMatch(/export let transcriptLines/)
    }
  })

  it('does not wire the retired per-Turn hover actions into the new facet', () => {
    // Ticket 07 deletes that path; ticket 06 must not give it a new home.
    expect(TRANSCRIPT_FACET).not.toMatch(/onTurnAction|doneActionsByTurn|TextBlock/)
    expect(ROOM_TABS).not.toMatch(/onTurnAction|doneActionsByTurn/)
  })
})
