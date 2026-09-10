<script>
  import { tick } from "svelte";
  import {
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    ChevronDown,
    FileSearch02,
    XClose,
  } from "$lib/icons";
  import {
    applyResearchEntry as reduceResearchEntry,
    applyResearchState as reduceResearchState,
    applyResearchRemove as reduceResearchRemove,
    visibleEntries,
    dedupeCitationsByHost,
    buildManualAskRequest,
    activeNotesTabText,
    activeTabVideoTitle,
    describeResearchError,
    makeResearchEntryId,
  } from "./research-panel.js";
  import { parseResearchCard } from "./research-card.js";
  import {
    applyAnnotationEntry as reduceAnnotationEntry,
    applyAnnotationState as reduceAnnotationState,
    applyAnnotationError as reduceAnnotationError,
    visibleAnnotations,
    visibleAnnotationsForRoom,
    isCardAnnotation,
    annotationStatus,
  } from "./annotation-panel.js";
  import TranscriptFacet from "./TranscriptFacet.svelte";
  import { TRANSCRIPT_TAB_ID } from "$lib/room/transcript-sync.js";

  // (payload) => void — JSON-sends over the room's single WebSocket
  // connection, owned by the page (same contract as RoomTabs.svelte's send).
  export let send = () => {};
  export let slug = "";

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

  let activeTabId = null;
  let entriesByTab = {};

  $: entries = visibleEntries(entriesByTab, activeTabId);

  // Annotations (ADR-0008, ticket 03) — a parallel per-tab collection to
  // entriesByTab above, fed by its own annotation_entry/annotation_state
  // broadcasts. Deliberately a separate list rather than rows mixed into
  // `entries`: a research entry has a pending/answered/errored lifecycle
  // and a question, an Annotation has neither — it is written once and is
  // then a permanent record of a quote plus a note.
  let annotationsByTab = {};
  // The feed lists the active Notes tab's Annotations AND every
  // Turn-anchored one, together, newest first — see
  // visibleAnnotationsForRoom for why the Transcript's are the one
  // cross-tab case (ticket 06). Before this, Turn Annotations were filed
  // under a tabId that `activeTabId` could hold; now it never can, so
  // scoping the feed to activeTabId alone would hide them entirely.
  $: annotations = visibleAnnotationsForRoom(annotationsByTab, activeTabId);
  // Just the Transcript's, for drawing highlights back onto the Turns.
  $: turnAnnotations = visibleAnnotations(annotationsByTab, TRANSCRIPT_TAB_ID);

  $: notesText = activeNotesTabText(tabTexts, activeTabId);
  $: videoTitle = activeTabVideoTitle(tabVideoTitles, activeTabId);

  let questionInput = "";
  let entriesEl;
  let annotationsEl;

  // entry.id -> boolean. One `showCitations` shared across every research
  // card would toggle citations on ALL of them at once when clicked on any
  // one card — keyed per-entry so each card's disclosure is independent.
  let expandedCitations = {};

  function toggleCitations(entryId) {
    // Reassign (not mutate) so Svelte 4's `$:`/markup reactivity notices —
    // `expandedCitations[entryId] = ...` in place wouldn't trigger a rerender.
    expandedCitations = {
      ...expandedCitations,
      [entryId]: !expandedCitations[entryId],
    };
  }

  function revealPanel() {
    collapsed = false;
    tick().then(() => {
      if (entriesEl) entriesEl.scrollTop = 0;
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
      if (entriesEl) entriesEl.scrollTop = 0;
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
      if (annotationsEl) annotationsEl.scrollTop = 0;
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

  function removeEntry(entryId) {
    if (!canAskResearch) return; // same gate as ws-rooms.js's research_remove
    send({ type: "research_remove", entryId });
  }

  // ─── Outbound — manual ask (ticket 04; Quick Actions/Voice Trigger,
  //     tickets 05/06, will reuse the same research_ask/resolve/error
  //     mechanism) ────────────────────────────────────────────────────────

  function submitQuestion() {
    if (!canAskResearch) return; // same gate as ws-rooms.js's research_ask
    const question = questionInput.trim();
    if (!question) return;
    questionInput = "";

    const entryId = makeResearchEntryId();
    send({ type: "research_ask", entryId, question });
    revealPanel();
    // notes/video title/transcriptLines ride along only as Placeholder
    // ingredients ({current_tab}/{transcript} — see CONTEXT.md) —
    // substitution itself happens server-side (research-assistant.js).
    publishResearchResult(
      entryId,
      buildManualAskRequest(question, notesText, transcriptLines, videoTitle),
    );
  }

  async function postResearch(requestBody) {
    let res;
    try {
      res = await fetch(`/rec/${slug}/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch {
      return { ok: false, body: null };
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, body };
  }

  async function publishResearchResult(entryId, requestBody) {
    const { ok, body } = await postResearch(requestBody);
    if (!ok) {
      send({
        type: "research_error",
        entryId,
        message: describeResearchError(body),
      });
      return;
    }
    send({
      type: "research_resolve",
      entryId,
      answer: body?.answer ?? "",
      citations: body?.citations ?? [],
    });
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

    <!-- Annotations (ADR-0008, tickets 03 and 05) — the active tab's,
         newest first. Comments (human) and Cards (a Custom Prompt's answer)
         share ONE list on purpose: they are the same concept, both anchored
         to a frozen quote, and separating them would make a reader check two
         places for what was said about one highlight. Reading is not gated
         by canAskResearch — the gate is on *spending* a Research Assistant
         call (see ws-rooms.js's annotation_ask), not on seeing the result. -->
    <section class="annotation-list" data-testid="annotation-list">
      <h3 class="annotation-list-title">Annotations</h3>
      <div class="annotation-entries" bind:this={annotationsEl}>
        {#if annotations.length === 0}
          <p class="research-empty">
            Highlight text in the notes — or a Transcript Turn — to comment
            on it or run a prompt.
          </p>
        {:else}
          {#each annotations as annotation (annotation.id)}
            {@const isCard = isCardAnnotation(annotation)}
            {@const status = annotationStatus(annotation)}
            <article
              class="annotation"
              class:annotation-card={isCard}
              data-kind={annotation.kind}
              data-status={status}
              data-testid="annotation"
            >
              <!-- The frozen quote — exactly the text that was highlighted
                   when this Annotation was made, never recomputed from the
                   notes as they stand now. -->
              <blockquote class="annotation-quote">
                {annotation.quote}
              </blockquote>
              {#if status === "pending"}
                <p class="annotation-pending" aria-live="polite">
                  Running {annotation.author}…
                </p>
              {:else if status === "errored"}
                <p class="annotation-error-text">{annotation.error}</p>
              {:else}
                <p class="annotation-text">{annotation.text}</p>
              {/if}
              <!-- Who said it. A Card names the prompt that produced it and
                   is badged as AI, so a reader skimming the list is never
                   left guessing whether a person or the assistant wrote a
                   given row. -->
              <p class="annotation-author">
                {#if isCard}
                  <span class="annotation-badge" data-testid="annotation-badge"
                    >AI</span
                  >
                {/if}
                {annotation.author}
              </p>
              {#if isCard && annotation.citations?.length}
                <ul class="annotation-citations">
                  {#each dedupeCitationsByHost(annotation.citations) as citation (citation.host)}
                    <li>
                      <a
                        href={citation.url}
                        target="_blank"
                        rel="noopener noreferrer">{citation.host}</a
                      >
                    </li>
                  {/each}
                </ul>
              {/if}
            </article>
          {/each}
        {/if}
      </div>
    </section>

    <div class="research-entries" bind:this={entriesEl}>
      {#if entries.length === 0}
        <p class="research-empty">No research yet for this tab.</p>
      {:else}
        {#each entries as entry (entry.id)}
          <div class="research-entry" data-status={entry.status}>
            <div class="research-entry-header">
              <p class="research-question">{entry.question}</p>
              {#if canAskResearch}
                <button
                  type="button"
                  class="btn-ghost btn-icon btn-sm research-remove"
                  aria-label="Remove this research card"
                  title="Remove this research card"
                  on:click={() => removeEntry(entry.id)}
                >
                  <XClose />
                </button>
              {/if}
            </div>
            {#if entry.status === "pending"}
              <p class="research-pending" aria-live="polite">
                Looking this up…
              </p>
            {:else if entry.status === "answered"}
              {@const card = parseResearchCard(entry.answer)}
              {#if card}
                {#if card.outputType === "custom" || card.outputType === "ask"}
                  <div class="research-interpretation">{card.mainTakeaway}</div>
                {:else}
                  <div class="research-card">
                    <p class="research-answer">{card.mainTakeaway}</p>
                  </div>
                {/if}
              {/if}
              {#if entry.citations?.length}
                <div class="research-citations-container">
                  <button
                    class="research-citations-toggle"
                    aria-label="Show citations"
                    title="Show citations"
                    on:click={() => toggleCitations(entry.id)}
                  >
                    <span class="research-citations-title">Citations</span>
                    {#if expandedCitations[entry.id]}
                      <ChevronUp />
                    {:else}
                      <ChevronDown />
                    {/if}
                  </button>
                  {#if expandedCitations[entry.id]}
                    <ul class="research-citations">
                      {#each dedupeCitationsByHost(entry.citations) as citation (citation.host)}
                        <li>
                          <a
                            href={citation.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {citation.host}
                          </a>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {/if}
            {:else if entry.status === "errored"}
              <p class="research-error-text">{entry.error}</p>
            {/if}
          </div>
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

  .research-entries {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
  }

  /* Annotations sit above the research entries and get their own bounded
     scroll area, so a long Comment history can't push the research cards —
     the thing you glance at mid-conversation — off the bottom of the panel. */
  .annotation-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    min-height: 0;
    flex: 0 1 auto;
    max-height: 45%;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }

  .annotation-list-title {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .annotation-entries {
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
  }

  .annotation {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .annotation-quote {
    margin: 0;
    padding-left: 8px;
    border-left: 2px solid var(--accent);
    color: var(--muted);
    font-size: 12px;
    font-style: italic;
  }

  .annotation-text {
    margin: 0;
    font-size: 13px;
    color: var(--text);
    white-space: pre-wrap;
  }

  .annotation-author {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* A Card is the assistant talking, not a co-host — the accent edge and
     the badge together make that readable at a glance in a mixed list,
     rather than relying on the author name alone (a prompt title like
     "Fact check" reads a lot like a person's note otherwise). */
  .annotation-card {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, var(--bg-elevated));
  }

  .annotation-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 5px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .annotation-pending {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .annotation-pending::before {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--accent);
    animation: research-pulse 1s ease-in-out infinite;
  }

  .annotation-error-text {
    margin: 0;
    font-size: 13px;
    color: var(--danger, #d33);
  }

  .annotation-citations {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 11px;
  }

  .annotation-citations a {
    color: var(--muted);
  }

  .research-empty {
    color: var(--muted);
    font-size: 13px;
  }

  .research-entry {
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
  }

  .research-entry-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .research-question {
    margin: 0;
    font-weight: 600;
    font-size: 12px;
    margin-right: auto;
    color: var(--muted);
  }

  .research-remove {
    flex-shrink: 0;
    color: var(--muted);
  }

  .research-answer {
    margin: 0;
    font-size: 14px;
    font-weight: 400;
    line-height: 1.35;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }

  .research-interpretation {
    margin: 0;
    font-size: 14px;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .research-card {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    font-weight: 400;
  }

  .research-entry[data-status="pending"] {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--bg));
  }

  .research-pending {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .research-pending::before {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--accent);
    animation: research-pulse 1s ease-in-out infinite;
  }

  @keyframes research-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.85);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }

  .research-error-text {
    margin: 0;
    font-size: 13px;
    color: var(--danger, #d33);
  }

  .research-citations-container {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .research-citations {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--muted);
    padding: 4px 6px;
    background: var(--bg-elevated);
    border-radius: 2px;
  }

  .research-citations a {
    color: var(--text);
  }

  .research-citations-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
    cursor: pointer;
    width: 100%;
    border: none;
    background: none;
    padding: 0;
    margin: 0;
    text-align: left;
    cursor: pointer;
    padding: 4px 6px;
  }

  .research-citations-toggle:hover {
    background: var(--bg-elevated);
    border-radius: 2px;
  }
</style>
