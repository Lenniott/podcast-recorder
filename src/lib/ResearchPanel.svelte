<script>
  import { ChevronLeft, ChevronRight, FileSearch02 } from "$lib/icons";
  import {
    applyResearchEntry as reduceResearchEntry,
    applyResearchState as reduceResearchState,
    visibleEntries,
    buildManualAskRequest,
    describeResearchError,
    makeResearchEntryId,
  } from "./research-panel.js";

  // (payload) => void — JSON-sends over the room's single WebSocket
  // connection, owned by the page (same contract as RoomTabs.svelte's send).
  export let send = () => {};
  export let slug = "";

  // Local, per-browser UI preference — never sent over the WS, mirrors
  // RoomSidebar.svelte's own `collapsed` (bound by the parent, e.g.
  // researchCollapsed in +page.svelte), independent of the left sidebar's
  // own collapsed state.
  export let collapsed = false;

  // Which tab the room is currently looking at — fed purely from the same
  // room-shared `tabs_state` broadcast RoomTabs.svelte already derives its
  // own view from (see applyTabsState below). Never tracked as a second,
  // independently-computed copy of "the active tab" that could drift from
  // RoomTabs' own activeTabId — both are fed by the identical wire message.
  let activeTabId = null;

  // tabId -> [{id, tabId, question, status, answer, citations, error, at}],
  // fed exclusively by research_entry/research_state broadcasts (see
  // $lib/research-panel.js) — never locally invented before the server has
  // recorded anything, so a pending card is always real, shared state.
  let entriesByTab = {};

  $: entries = visibleEntries(entriesByTab, activeTabId);

  let questionInput = "";

  // ─── Inbound — called by the page's ws.onmessage ────────────────────────

  export function applyTabsState(msg) {
    activeTabId = msg.activeTabId;
  }

  export function applyResearchEntry(msg) {
    entriesByTab = reduceResearchEntry(entriesByTab, msg);
  }

  export function applyResearchState(msg) {
    entriesByTab = reduceResearchState(entriesByTab, msg);
  }

  // ─── Outbound — manual ask (ticket 04; Quick Actions/Voice Trigger,
  //     tickets 05/06, will reuse the same research_ask/resolve/error
  //     mechanism) ────────────────────────────────────────────────────────

  function submitQuestion() {
    const question = questionInput.trim();
    if (!question) return;
    questionInput = "";

    const entryId = makeResearchEntryId();
    // Creates the pending entry as real, server-broadcast state immediately
    // — every peer (including this browser) learns about it only once the
    // server has actually recorded it, via the research_entry broadcast.
    send({ type: "research_ask", entryId, question });
    askResearchAssistant(entryId, question);
  }

  // The browser itself calls ticket 02's endpoint (not the WS server) — see
  // tests/playwright/helpers.js's mockResearchEndpoint, which fakes exactly
  // this fetch. Whatever happens — success, a non-2xx response, or a thrown
  // network error — this always ends by sending research_resolve or
  // research_error, so a request can never leave its entry stuck pending
  // with no explanation.
  async function askResearchAssistant(entryId, question) {
    let res;
    try {
      res = await fetch(`/rec/${slug}/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildManualAskRequest(question)),
      });
    } catch {
      send({ type: "research_error", entryId, message: describeResearchError(null) });
      return;
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      send({ type: "research_error", entryId, message: describeResearchError(body) });
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

<aside class="research-panel" class:collapsed data-testid="research-panel">
  <div class="research-panel-header">
    {#if !collapsed}
      <span class="research-panel-title">
        <span class="research-panel-title-icon"><FileSearch02 /></span>
        Research Assistant
      </span>
    {/if}
    <button
      type="button"
      class="btn-ghost btn-icon btn-sm collapse-toggle"
      on:click={() => (collapsed = !collapsed)}
      aria-label={collapsed ? "Expand Research Assistant" : "Collapse Research Assistant"}
      title={collapsed ? "Expand Research Assistant" : "Collapse Research Assistant"}
    >
      {#if collapsed}
        <ChevronLeft />
      {:else}
        <ChevronRight />
      {/if}
    </button>
  </div>

  {#if !collapsed}
    <form class="research-ask-form" on:submit|preventDefault={submitQuestion}>
      <input
        type="text"
        class="research-ask-input"
        aria-label="Ask the Research Assistant"
        placeholder="Ask a question…"
        bind:value={questionInput}
      />
      <button type="submit" class="btn-secondary btn-sm" disabled={!questionInput.trim()}>
        Ask
      </button>
    </form>

    <div class="research-entries">
      {#if entries.length === 0}
        <p class="research-empty">No research yet for this tab.</p>
      {:else}
        {#each entries as entry (entry.id)}
          <div class="research-entry" data-status={entry.status}>
            <p class="research-question">{entry.question}</p>
            {#if entry.status === "pending"}
              <p class="research-pending">Thinking…</p>
            {:else if entry.status === "answered"}
              <p class="research-answer">{entry.answer}</p>
              {#if entry.citations?.length}
                <ul class="research-citations">
                  {#each entry.citations as citation}
                    <li>
                      <a href={citation.url} target="_blank" rel="noopener noreferrer">
                        {citation.title || citation.url}
                      </a>
                    </li>
                  {/each}
                </ul>
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
    gap: 12px;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
    padding: 16px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .research-panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .research-panel.collapsed .research-panel-header {
    justify-content: center;
  }

  .research-panel-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 15px;
    font-weight: 600;
    margin-right: auto;
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
    gap: 6px;
  }

  .research-question {
    margin: 0;
    font-weight: 600;
    font-size: 13px;
  }

  .research-answer {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .research-pending {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    font-style: italic;
  }

  .research-error-text {
    margin: 0;
    font-size: 13px;
    color: var(--danger, #d33);
  }

  .research-citations {
    margin: 0;
    padding-left: 16px;
    font-size: 12px;
    color: var(--muted);
  }

  .research-citations a {
    color: var(--accent);
  }
</style>
