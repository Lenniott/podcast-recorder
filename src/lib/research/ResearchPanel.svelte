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
    deriveDoneActionsByTurn,
    dedupeCitationsByHost,
    buildManualAskRequest,
    buildTurnActionRequest,
    buildCustomRequest,
    applyTranscriptState as reduceTranscriptState,
    applyTranscriptLine as reduceTranscriptLine,
    activeNotesTabText,
    hasCustomText,
    describeResearchError,
    makeResearchEntryId,
  } from "./research-panel.js";
  import { parseResearchCard } from "./research-card.js";

  const TURN_ACTION_LABEL = {
    definition: "Definition",
    facts: "Facts",
    answer: "Answer",
  };

  // (payload) => void — JSON-sends over the room's single WebSocket
  // connection, owned by the page (same contract as RoomTabs.svelte's send).
  export let send = () => {};
  export let slug = "";

  // Local, per-browser UI preference — never sent over the WS, mirrors
  // RoomSidebar.svelte's own `collapsed` (bound by the parent, e.g.
  // researchCollapsed in +page.svelte), independent of the left sidebar's
  // own collapsed state.
  export let collapsed = false;

  // tabId -> string — RoomTabs.svelte's own true, complete, current copy
  // of every tab's text (both its own just-typed keystrokes AND every
  // peer's broadcast tab_text), two-way bound up through RecordingRoom to
  // +page.svelte's tabTexts and passed down here as a plain prop.
  //
  // Deliberately NOT a second copy fed by this component's own tab_text WS
  // listener: the tab_text broadcast (see ws-rooms.js) excludes the
  // sender's own connection, on purpose, so RoomTabs' own textarea isn't
  // clobbered by an echo of its own keystrokes mid-typing. RoomTabs itself
  // never needs the broadcast for its OWN edits (it already has them
  // locally) — but a second listener here reading only the broadcast would
  // be blind to exactly that case: a solo participant's own just-typed
  // notes would never arrive, and Quick Actions on their own active tab
  // would stay disabled/stale forever. Reading RoomTabs' own state
  // directly avoids the asymmetry entirely.
  export let tabTexts = {};
  export let isHostClaim = false;

  // Guest Research Access (see CONTEXT.md) — a per-room flag set at room
  // creation. Off by default. One gate for every Research Assistant
  // action: Ask, Turn Actions, and Custom/Interpret alike, no per-action
  // carve-out (see canCustom below, which layers customEnabled on top of
  // this same canAskResearch, not a separate host check).
  export let guestCanAskResearch = false;

  $: canAskResearch = isHostClaim || guestCanAskResearch;

  // Whether Custom is configured at all (Research Prompt + Title — see
  // CONTEXT.md). Set on the create-room page, not per-room. Custom stays
  // disabled (regardless of canAskResearch) until both are set.
  export let customEnabled = false;
  export let customTitle = "";

  let activeTabId = null;
  let entriesByTab = {};

  $: entries = visibleEntries(entriesByTab, activeTabId);

  // Read by RecordingRoom.svelte via bind:doneActionsByTurn and passed down
  // into RoomTabs — same "computed here, bound up, handed down as a plain
  // prop" pattern this file's own `tabTexts` prop follows in reverse (see
  // this file's `export let tabTexts` doc comment above).
  export let doneActionsByTurn = {};
  $: doneActionsByTurn = deriveDoneActionsByTurn(entriesByTab);

  let transcriptLines = [];

  $: customText = activeNotesTabText(tabTexts, activeTabId);
  $: canCustom = canAskResearch && customEnabled && hasCustomText(customText);

  let questionInput = "";
  let entriesEl;

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

  export function applyTranscriptState(msg) {
    transcriptLines = reduceTranscriptState(transcriptLines, msg);
  }

  export function applyTranscriptLine(msg) {
    transcriptLines = reduceTranscriptLine(transcriptLines, msg);
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
    // customText/transcriptLines ride along only as Placeholder ingredients
    // ({current_tab}/{transcript} — see CONTEXT.md) — substitution itself
    // happens server-side (research-assistant.js), never here.
    publishResearchResult(
      entryId,
      buildManualAskRequest(question, customText, transcriptLines),
    );
  }

  function runCustom() {
    if (!canAskResearch || !customEnabled) return;
    const request = buildCustomRequest(customText, transcriptLines);
    if (!request) return;
    const entryId = makeResearchEntryId();
    send({ type: "research_ask", entryId, question: customTitle });
    revealPanel();
    publishResearchResult(entryId, request);
  }

  export async function runTurnAction(actionId, turnId) {
    if (!canAskResearch) return; // same gate as ws-rooms.js's research_ask
    const request = buildTurnActionRequest(transcriptLines, turnId, actionId);
    if (!request) return;
    const entryId = makeResearchEntryId();
    // turnId/actionId ride along so every peer's `entriesByTab` can derive
    // "this Turn Action already ran" (see deriveDoneActionsByTurn) — a
    // manual ask/Custom never sets these, only Turn Actions do.
    send({
      type: "research_ask",
      entryId,
      question: TURN_ACTION_LABEL[actionId] || actionId,
      turnId,
      actionId,
    });
    revealPanel();
    const posted = await postResearch(request);
    if (!posted.ok) {
      send({
        type: "research_error",
        entryId,
        message: describeResearchError(posted.body),
      });
      return;
    }
    send({
      type: "research_resolve",
      entryId,
      answer: posted.body?.answer ?? "",
      citations: posted.body?.citations ?? [],
    });
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
    </button>
  </div>

  {#if !collapsed}
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

    {#if canAskResearch && customEnabled}
      <button
        type="button"
        class="btn-secondary btn-sm"
        disabled={!canCustom}
        title={canCustom
          ? "Run the Research Prompt against this tab's text and the transcript"
          : "Custom runs on notes-tab text (not the Transcript tab)"}
        on:click={runCustom}
      >
        {customTitle}
      </button>
    {/if}
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
                {#if card.outputType === "custom"}
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
