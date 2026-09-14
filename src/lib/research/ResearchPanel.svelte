<script>
  import { tick } from "svelte";
  import {
    ChevronLeft,
    ChevronRight,
    FileSearch02,
    XClose,
  } from "$lib/icons";
  import {
    applyResearchEntry as reduceResearchEntry,
    applyResearchState as reduceResearchState,
    applyResearchRemove as reduceResearchRemove,
    panelFeed,
    activeNotesTabText,
    activeTabVideoTitle,
    makeResearchEntryId,
    panelPromptButtons,
  } from "./research-panel.js";
  import {
    applyAnnotationEntry as reduceAnnotationEntry,
    applyAnnotationState as reduceAnnotationState,
    applyAnnotationError as reduceAnnotationError,
    applyAnnotationRemove as reduceAnnotationRemove,
    visibleAnnotations,
    isCardAnnotation,
  } from "./annotation-panel.js";
  import { formatTranscriptForPrompt } from "$lib/room/selection-annotations.js";
  import TranscriptFacet from "./TranscriptFacet.svelte";
  import AiCard from "./AiCard.svelte";
  import { TRANSCRIPT_TAB_ID } from "$lib/room/transcript-sync.js";

  // (payload) => void — JSON-sends over the room's single WebSocket
  // connection, owned by the page (same contract as RoomTabs.svelte's send).
  export let send = () => {};

  // Local, per-browser UI preference — never sent over the WS, mirrors
  // RoomSidebar.svelte's own `collapsed` (bound by the parent, e.g.
  // researchCollapsed in +page.svelte), independent of the left sidebar's
  // own collapsed state.
  export let collapsed = false;

  // ─── Which facet this participant is looking at (ADR-0008, ticket 06) ──
  //
  // 'annotations' | 'transcript'. PERSONAL AND LOCAL TO THIS BROWSER, in
  // exactly the same way (and by exactly the same mechanism) as `collapsed`
  // above: a plain variable in +page.svelte, bound down through
  // RecordingRoom, never touched by `send` and never derived from a WS
  // message. That is the whole point of the Transcript ceasing to be a Tab
  // — it used to be room-shared `activeTabId`, so one participant glancing
  // at it moved everybody else's main stage. Nobody's screen should change
  // because their co-host looked something up (see CONTEXT.md's
  // **Transcript**).
  //
  // If you are ever tempted to sync this: don't. There is no facet_switch
  // message, and adding one would re-introduce the exact behaviour ADR-0008
  // retired.
  export let facet = "annotations";

  // [{id, speaker, text, at}] in server (append) order — the room's live
  // Transcript, lifted to +page.svelte (ticket 06) so the tab strip's
  // `{transcript}` placeholder and this panel's facet read one copy rather
  // than each keeping their own listener. Delivery/ordering is unchanged
  // (transcript_state/transcript_line, ADR-0002); only the owner moved.
  export let transcriptLines = [];

  // bind:turnsEl — the rendered Turn list, handed up so RoomTabs.svelte can
  // register it as a selection surface (see TranscriptFacet.svelte). Flows
  // sideways between the two components via RecordingRoom, the same way
  // tabTexts/tabVideoTitles already do.
  export let turnsEl = null;

  // This participant's own speech-recognition status — 'stopped' |
  // 'unsupported' | 'starting' | 'running' | 'retrying'. Per-browser, never
  // room-shared: whether *you* are being transcribed is your own local
  // fact. It moved here from the retired Transcript pill (ticket 06)
  // because this button is now the only place a participant goes to think
  // about the Transcript, and AGENTS.md's rule applies — a silently-dead
  // recognizer must stay visible, never indistinguishable from "fine".
  export let transcriptionStatus = "stopped";

  const TRANSCRIPTION_STATUS_LABEL = {
    stopped: "Not transcribing",
    unsupported: "Transcription isn't supported in this browser",
    starting: "Starting transcription…",
    running: "Transcribing your mic",
    retrying: "Transcription lost connection — retrying…",
  };

  // Room-shared "a transcript_line is probably about to land somewhere in
  // the room" pulse (see ws-rooms.js's transcript_activity protocol doc).
  // Moved off the retired Transcript pill onto the facet's own button
  // (ticket 06) so a participant still gets the heads-up without having the
  // facet open. Deliberately separate from transcriptionStatus above: that
  // is this browser's recognizer health, this is "someone in the room is
  // being processed right now", true even for a peer with no microphone.
  let transcriptActivity = false;

  // tabId -> string — RoomTabs.svelte's own true, complete, current copy
  // of every tab's text (both its own just-typed keystrokes AND every
  // peer's broadcast tab_text), two-way bound up through RecordingRoom to
  // +page.svelte's tabTexts and passed down here as a plain prop.
  //
  // Deliberately NOT a second copy fed by this component's own tab_text WS
  // listener: the tab_text broadcast (see ws-rooms.js) excludes the
  // sender's own connection, on purpose, so RoomTabs' own Notes surface isn't
  // clobbered by an echo of its own keystrokes mid-typing. RoomTabs itself
  // never needs the broadcast for its OWN edits (it already has them
  // locally) — but a second listener here reading only the broadcast would
  // be blind to exactly that case: a solo participant's own just-typed
  // notes would never arrive, and Quick Actions on their own active tab
  // would stay disabled/stale forever. Reading RoomTabs' own state
  // directly avoids the asymmetry entirely.
  export let tabTexts = {};
  // tabId -> YouTube title from RoomTabs' player (not room-shared).
  export let tabVideoTitles = {};
  export let isHostClaim = false;

  // Guest Research Access (see CONTEXT.md) — a per-room flag set at room
  // creation. Off by default. One gate for every Research Assistant
  // action: Ask and every Custom Prompt alike, no per-action carve-out.
  export let guestCanAskResearch = false;

  $: canAskResearch = isHostClaim || guestCanAskResearch;

  // [{id, title, usesSelection}] — every configured Custom Prompt (see
  // RecordingRoom.svelte's own doc comment). Only the ones that do NOT
  // reference {selection} get a button here — the ones that do belong only
  // in the highlight popup (RoomTabs.svelte's selectionActions), since they
  // have no excerpt to run against without one. See panelPromptButtons.
  export let customPrompts = [];
  $: panelPrompts = panelPromptButtons(customPrompts, { canRun: canAskResearch });

  let activeTabId = null;
  let entriesByTab = {};

  // Storage remains split: Annotations have frozen anchors while research
  // entries do not. panelFeed is the one tested display projection.
  let annotationsByTab = {};
  $: feed = panelFeed({ annotationsByTab, entriesByTab, activeTabId });
  // Just the Transcript's, for drawing highlights back onto the Turns.
  $: turnAnnotations = visibleAnnotations(annotationsByTab, TRANSCRIPT_TAB_ID);

  $: notesText = activeNotesTabText(tabTexts, activeTabId);
  $: videoTitle = activeTabVideoTitle(tabVideoTitles, activeTabId);

  let questionInput = "";
  let feedEl;

  function revealPanel() {
    collapsed = false;
    tick().then(() => {
      if (feedEl) feedEl.scrollTop = 0;
    });
  }

  // ─── Inbound — called by the page's ws.onmessage ────────────────────────

  export function applyTabsState(msg) {
    activeTabId = msg.activeTabId;
  }

  /** The room-shared "something's coming" pulse (ticket 06 moved this here
   *  from the retired Transcript pill — see ws-rooms.js's
   *  transcript_activity). Routed by the page, same pattern as applyDuck.
   *
   *  transcript_state/transcript_line are deliberately NOT handled here any
   *  more: the lines themselves are lifted to +page.svelte and arrive as
   *  the `transcriptLines` prop, so the tab strip and this panel can never
   *  disagree about what the Transcript says. */
  export function applyTranscriptActivity(msg) {
    transcriptActivity = !!msg.active;
  }

  export function applyResearchEntry(msg) {
    entriesByTab = reduceResearchEntry(entriesByTab, msg);
    tick().then(() => {
      if (feedEl) feedEl.scrollTop = 0;
    });
  }

  export function applyResearchState(msg) {
    entriesByTab = reduceResearchState(entriesByTab, msg);
  }

  export function applyResearchRemove(msg) {
    entriesByTab = reduceResearchRemove(entriesByTab, msg);
  }

  /** One Annotation added anywhere in the room (see ws-rooms.js's
   *  annotation_entry). Reveals the panel the same way a new research card
   *  would — a Comment a co-host just left is exactly the sort of thing a
   *  collapsed panel would hide at the moment it matters. */
  export function applyAnnotationEntry(msg) {
    annotationsByTab = reduceAnnotationEntry(annotationsByTab, msg);
    tick().then(() => {
      if (feedEl) feedEl.scrollTop = 0;
    });
  }

  /** One tab's full Annotation list, replayed on join/resync — this is what
   *  makes rejoining a room show the Annotations that were already there. */
  export function applyAnnotationState(msg) {
    annotationsByTab = reduceAnnotationState(annotationsByTab, msg);
  }

  /** A Card's Research Assistant lookup failed (ticket 05) — the row moves
   *  from pending to a visible reason rather than spinning forever. */
  export function applyAnnotationError(msg) {
    annotationsByTab = reduceAnnotationError(annotationsByTab, msg);
  }

  export function applyAnnotationRemove(msg) {
    annotationsByTab = reduceAnnotationRemove(annotationsByTab, msg);
  }

  function removeEntry(entryId) {
    if (!canAskResearch) return; // same gate as ws-rooms.js's research_remove
    send({ type: "research_remove", entryId });
  }

  function removeAnnotation(annotationId) {
    send({ type: "annotation_remove", annotationId });
  }

  // ─── Outbound — a panel-button Custom Prompt (structured-research-output
  //     panel-buttons feature) — fully server-resolved, like annotation_ask
  //     and typed research_ask. There is no template to keep off the wire
  //     here beyond what annotation_ask already keeps off it, so this reuses
  //     "resolve by id, server-side" discipline rather than the HTTP-POST
  //     one. Result lands as a research entry (ws-rooms.js's
  //     runResearchEntryAsk), rendered in the same mixed feed below. ──────

  function runPanelPrompt(customPromptId) {
    if (!canAskResearch) return; // same gate as ws-rooms.js's research_prompt_ask
    const entryId = makeResearchEntryId();
    send({
      type: "research_prompt_ask",
      entryId,
      customPromptId,
      // Placeholder ingredients only — the server keeps just what this
      // prompt's own template references and drops the rest (same
      // reasoning as buildAnnotationAskPayload's payload).
      currentTab: notesText,
      transcript: formatTranscriptForPrompt(transcriptLines),
      videoTitle,
    });
    revealPanel();
  }

  // ─── Outbound — typed Ask, resolved entirely by the WS server. ────────

  function submitQuestion() {
    if (!canAskResearch) return; // same gate as ws-rooms.js's research_ask
    const question = questionInput.trim();
    if (!question) return;
    questionInput = "";

    const entryId = makeResearchEntryId();
    send({
      type: "research_ask",
      entryId,
      question,
      currentTab: notesText,
      transcript: formatTranscriptForPrompt(transcriptLines),
      videoTitle,
    });
    revealPanel();
  }
</script>

<aside class="research-panel" class:collapsed={collapsed} class:research-panel-collapsed={collapsed} data-testid="research-panel">
  <div class="research-panel-header">
    {#if !collapsed}
      <span class="research-panel-title">
        <span class="research-panel-title-icon"><FileSearch02 /></span>
        Research Assistant
      </span>
    {/if}
    <button
      type="button"
      class="btn-ghost btn-icon collapse-toggle"
      on:click={() => (collapsed = !collapsed)}
      aria-label={collapsed
        ? "Expand Research Assistant"
        : "Collapse Research Assistant"}
      title={collapsed
        ? "Expand Research Assistant"
        : "Collapse Research Assistant"}
    >
      {#if collapsed}
        <FileSearch02 />
      {:else}
        <ChevronRight />
      {/if}
      <!-- A collapsed panel hides the facet buttons entirely, so the pulse
           rides the only control left. Without this, "new Turns are
           arriving" would be invisible to anyone with the panel shut —
           which is exactly the participant the heads-up is for. -->
      {#if collapsed && transcriptActivity}
        <span
          class="transcript-activity-pulse"
          data-testid="transcript-activity-pulse"
          title="Transcript incoming…"
          aria-label="Transcript incoming…"
        ></span>
      {/if}
    </button>
  </div>

  {#if !collapsed}
    <!-- Transcript vs. the Annotation feed. PERSONAL AND LOCAL — clicking
         either sends nothing over the WS (see `facet`'s doc comment). -->
    <div class="facet-toggle" role="group" aria-label="Panel view">
      <button
        type="button"
        class="btn-ghost btn-sm facet-btn"
        class:is-active={facet === "annotations"}
        aria-pressed={facet === "annotations"}
        data-testid="facet-annotations"
        on:click={() => (facet = "annotations")}
      >
        Annotations
      </button>
      <button
        type="button"
        class="btn-ghost btn-sm facet-btn"
        class:is-active={facet === "transcript"}
        aria-pressed={facet === "transcript"}
        data-testid="facet-transcript"
        on:click={() => (facet = "transcript")}
      >
        Transcript
        {#if transcriptionStatus !== "stopped"}
          <span
            class="transcription-status-dot"
            data-status={transcriptionStatus}
            title={TRANSCRIPTION_STATUS_LABEL[transcriptionStatus]}
            aria-label={TRANSCRIPTION_STATUS_LABEL[transcriptionStatus]}
          ></span>
        {/if}
        {#if transcriptActivity}
          <span
            class="transcript-activity-pulse"
            data-testid="transcript-activity-pulse"
            title="Transcript incoming…"
            aria-label="Transcript incoming…"
          ></span>
        {/if}
      </button>
    </div>
  {/if}

  {#if !collapsed && facet === "transcript"}
    <TranscriptFacet
      lines={transcriptLines}
      annotations={turnAnnotations}
      bind:turnsEl
    />
  {/if}

  {#if !collapsed && facet === "annotations"}
    <!-- Panel-button Custom Prompts (structured-research-output feature) —
         every configured prompt that does NOT reference {selection}, one
         button each, always shown (disabled + explained without Guest
         Research Access, same philosophy as the highlight popup's own
         Custom Prompt buttons — see selection-annotations.js). -->
    {#if panelPrompts.length}
      <div class="panel-prompt-row" role="group" aria-label="Custom Prompts">
        {#each panelPrompts as prompt (prompt.id)}
          <button
            type="button"
            class="btn-secondary btn-sm panel-prompt-btn"
            disabled={prompt.disabled}
            title={prompt.title}
            on:click={() => runPanelPrompt(prompt.id)}
          >
            {prompt.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if canAskResearch}
      <form class="research-ask-form" on:submit|preventDefault={submitQuestion}>
        <input
          type="text"
          class="research-ask-input"
          aria-label="Ask the Research Assistant"
          placeholder="Ask a question…"
          bind:value={questionInput}
        />
        <button
          type="submit"
          class="btn-secondary btn-sm"
          disabled={!questionInput.trim()}
        >
          Ask
        </button>
      </form>
    {/if}

    <!-- One visual feed over two stores. Annotations retain frozen quotes;
         Ask/panel-prompt research entries retain their tab-scoped question. -->
    <div class="panel-feed" data-testid="panel-feed" bind:this={feedEl}>
      {#if feed.length === 0}
        <p class="research-empty">
          Ask a question, run a prompt, or highlight text to annotate it.
        </p>
      {:else}
        {#each feed as row (row.key)}
          {#if row.type === "annotation" && !isCardAnnotation(row)}
            <article
              class="annotation"
              data-kind={row.kind}
              data-status="answered"
              data-testid="annotation"
            >
              <div class="feed-row-header">
                <blockquote class="annotation-quote">{row.quote}</blockquote>
                <button
                  type="button"
                  class="btn-ghost btn-icon btn-sm research-remove"
                  aria-label="Remove this annotation"
                  title="Remove this annotation"
                  on:click={() => removeAnnotation(row.id)}
                ><XClose /></button>
              </div>
              <p class="annotation-text">{row.text}</p>
              <p class="annotation-author">
                {row.author}
              </p>
            </article>
          {:else}
            <AiCard
              {row}
              canRemove={row.type === "annotation" || canAskResearch}
              onRemove={() => row.type === "annotation"
                ? removeAnnotation(row.id)
                : removeEntry(row.id)}
            />
          {/if}
        {/each}
      {/if}
    </div>
  {/if}
</aside>

<style>
  .research-panel {
    display: flex;
    flex-direction: column;
    justify-content: start;
    align-items: start;
    gap: 12px;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
    padding: 20px 16px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .research-panel-collapsed {
    border: none;
    background: none;
    padding: 20px 0;
    margin: 0;
  }

  .research-panel-header {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: start;
    gap: 6px;
    flex-shrink: 0;
  }

  .research-panel-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 400;
    margin-right: auto;
    width: 100%;
  }

  .research-panel-title-icon {
    display: inline-flex;
    color: var(--muted);
  }

  /* Transcript vs. Annotation feed. A per-browser view switch, so it reads
     as a segmented control rather than as anything that could look
     room-shared — no accent fill like the old .tab-pill.active had. */
  .facet-toggle {
    display: flex;
    gap: 2px;
    width: 100%;
    flex-shrink: 0;
  }

  .facet-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
  }

  .facet-btn.is-active {
    background: var(--bg-elevated);
    border-color: var(--accent);
    color: var(--text);
  }

  /* This browser's own recognizer health — moved here with the Transcript
     itself (ticket 06). */
  .transcription-status-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-left: 5px;
    border-radius: 50%;
    vertical-align: middle;
    background: var(--muted);
  }
  .transcription-status-dot[data-status="running"] {
    background: var(--success);
  }
  .transcription-status-dot[data-status="starting"] {
    background: var(--warn);
  }
  .transcription-status-dot[data-status="retrying"] {
    background: var(--danger);
    box-shadow: 0 0 4px var(--danger);
  }

  /* Room-shared "something's coming" signal — deliberately a different hue
     and a pulse (not a solid fill) from transcription-status-dot above, so
     "my mic's recognizer is healthy" and "someone's speech is being
     processed right now" never read as the same fact at a glance. */
  .transcript-activity-pulse {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-left: 5px;
    border-radius: 50%;
    vertical-align: middle;
    background: var(--accent);
    animation: transcript-activity-pulse 1s ease-in-out infinite;
  }
  @keyframes transcript-activity-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.85);
    }
    50% {
      opacity: 1;
      transform: scale(1.15);
    }
  }

  /* One button per panel-eligible Custom Prompt — wraps rather than
     scrolling, since a host is expected to configure a handful of these,
     not a long list. */
  .panel-prompt-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    width: 100%;
  }

  .panel-prompt-btn {
    flex: 0 0 auto;
  }

  .research-ask-form {
    display: flex;
    gap: 8px;
  }

  .research-ask-input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
  }

  .research-ask-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .panel-feed {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    gap: 10px;
    width: 100%;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }

  .feed-row-header {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }

  .research-remove {
    flex-shrink: 0;
    color: var(--muted);
  }

  .annotation {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .annotation-quote {
    margin: 0;
    padding-left: 8px;
    border-left: 2px solid var(--accent);
    color: var(--muted);
    font-size: 12px;
    font-style: italic;
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }

  .annotation-text {
    margin: 0;
    font-size: 13px;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .annotation-author {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .research-empty {
    color: var(--muted);
    font-size: 13px;
  }
</style>
