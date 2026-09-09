<script>
  import { onMount, tick } from "svelte";
  import { Plus } from "$lib/icons";
  import TabVideoPlayer from "../TabVideoPlayer.svelte";
  import TranscriptTab from "./TranscriptTab.svelte";
  import { TRANSCRIPT_TAB_ID } from "./transcript-sync.js";
  import {
    readNotesText,
    selectionIsInside,
    planInboundNotesUpdate,
  } from "./notes-editor.js";
  import {
    getNotesTextSize,
    setNotesTextSize,
    SIZES as NOTES_TEXT_SIZES,
  } from "../notes-text-size.js";

  // (payload) => void — JSON-sends over the room WS. The room's single
  // WebSocket connection is owned by the page, not this component.
  export let send = () => {};
  export let clockOffset = 0;

  // This participant's own speech-recognition status — 'stopped' |
  // 'unsupported' | 'starting' | 'running' | 'retrying' (see
  // $lib/research/speech-recognition.js). Deliberately per-browser, never
  // room-shared: whether *you* are being transcribed is your own local
  // fact, same as your own mic selection. Shown as a small dot on the
  // Transcript pill so it's visible without switching to that tab — the
  // same "never let silence stand in for everything's fine" lesson
  // AGENTS.md already states for recording health.
  export let transcriptionStatus = "stopped";

  // Turn Action click → Research Assistant. Local pending lives here so
  // the Block can spin without a room-shared pending card.
  export let onTurnAction = async () => {};

  // turnId -> actionId[] — which Turn Actions have already run on which
  // Block, so their icons disable rather than firing the same question at
  // Research Assistant twice. Room-shared and owned by ResearchPanel (it's
  // derived from `entriesByTab`, replayed to every peer on join — see
  // ResearchPanel.svelte's `doneActionsByTurn` prop), so it survives a
  // refresh; RoomTabs only reads it, via RecordingRoom.svelte's plumbing.
  export let doneActionsByTurn = {};

  let pendingTurnId = null;
  let pendingActionId = null;

  async function handleTurnAction(actionId, turnId) {
    pendingTurnId = turnId;
    pendingActionId = actionId;
    try {
      await onTurnAction(actionId, turnId);
    } finally {
      pendingTurnId = null;
      pendingActionId = null;
    }
  }

  const TRANSCRIPTION_STATUS_LABEL = {
    stopped: "Not transcribing",
    unsupported: "Transcription isn't supported in this browser",
    starting: "Starting transcription…",
    running: "Transcribing your mic",
    retrying: "Transcription lost connection — retrying…",
  };

  const TEXT_DEBOUNCE_MS = 300;

  // ─── Shared room state, driven entirely by inbound WS messages ─────────
  let tabs = []; // [{id, title}], in server order — mirrors the room for everyone
  let activeTabId = null;
  // Flips true once the first tab_state WS message has been applied — the
  // real signal that this peer's shared room state is live, vs. inferring
  // readiness from a DOM element's rendered geometry (e2e tests wait on
  // this rather than racing the Notes surface's visibility).
  let wsReady = false;

  // Per-tab video/text is tracked for *every* tab, not just the active one,
  // because the server broadcasts tab_video/tab_text for whichever tab a
  // peer is acting on — a background tab someone else is loading a video
  // into must already be up to date by the time you switch to it.
  let tabVideos = {}; // tabId -> {videoId,playing,positionSec,positionAtMs} | null

  // tabId -> string. Exported (two-way bound up through RecordingRoom.svelte
  // to +page.svelte, same `bind:` pattern as selectedDeviceId/gainValue)
  // because this is the one place that holds
  // the true, complete, current value for every tab at all times — both
  // this browser's own just-typed (not-yet-broadcast) keystrokes AND every
  // peer's broadcast tab_text. ResearchPanel.svelte reads this directly as
  // a plain prop instead of keeping its own second listener on the
  // tab_text broadcast, which is deliberately asymmetric (excludes the
  // sender, so a typist's own Notes surface isn't clobbered by an echo of
  // its own keystrokes) — lossy for anyone who isn't RoomTabs itself.
  export let tabTexts = {}; // tabId -> string

  // ─── The Notes editing surface (contenteditable, see ADR-0008) ─────────
  // HOW TO GET AT THIS ELEMENT (ticket 03's selectionchange/mouseup
  // listeners + window.getSelection() work): three equivalent handles, all
  // pointing at the same element, pick whichever suits the caller —
  //   1. `bind:notesEl` on <RoomTabs> — this exported prop is the
  //      component's own `bind:this` target, so a parent binding it gets
  //      the live element (or null while the Transcript is showing, or
  //      before the first tab_state lands). Same pattern as tabTexts.
  //   2. `id="shared-notes-editor"` — a stable, unique document id.
  //   3. `[data-notes-editor]` — for querying without hardcoding the id.
  // It is a real HTMLElement, so getSelection()/getBoundingClientRect()
  // behave normally; `notesEl.contains(selection.anchorNode)` is the
  // "is this selection ours" test (selectionIsInside in notes-editor.js).
  export let notesEl = null;

  // Which tab's text the DOM currently holds, and which tab (if any) has
  // keystrokes still sitting in the outbound debounce. Both feed
  // planInboundNotesUpdate — see notes-editor.js for why.
  let notesDomTabId = null;
  let unsentTabId = null;

  // tabId -> YouTube title, filled from TabVideoPlayer's IFrame API once
  // getVideoData() returns one. Local to this browser (titles aren't on
  // tab_video). Bound up to ResearchPanel so `{current_tab}` can bundle it.
  export let tabVideoTitles = {};

  // The Transcript is a sibling piece of room content, not an entry in
  // `tabs` (see room-state-store.js and ADR-0002) — but "which pill the
  // room is looking at" is still one room-shared value: activeTabId can
  // hold either a real tab's id or the reserved TRANSCRIPT_TAB_ID, and
  // switching to either is broadcast to every peer via the same tab_switch/
  // tabs_state round trip (see room-state-store.js's switchTab). So
  // whether we're showing the Transcript is *derived* from activeTabId,
  // never tracked as separate local-only state.
  let transcriptLines = []; // [{id, speaker, text, at}], server (append) order
  $: viewingTranscript = activeTabId === TRANSCRIPT_TAB_ID;

  let videoPlayerRef = null; // the mounted TabVideoPlayer for activeTabId

  // Room-wide hold-to-talk duck (not per-tab — see applyDuck/resyncDuck).
  let talking = false; // true while *this* browser is holding Talk
  let roomTalking = false; // true while any peer (including us) is holding Talk

  // Room-shared "a transcript_line is probably about to land somewhere in
  // the room" signal (see ws-rooms.js's transcript_activity protocol doc) —
  // set via applyTranscriptActivity, same routing pattern as applyDuck.
  // Deliberately separate from transcriptionStatus above: that prop is
  // this browser's own recognizer health, this is "is anyone's speech
  // being processed right now," true even for a peer whose own browser
  // has no microphone or no Web Speech API support at all.
  let transcriptActivity = false;

  let textDebounceTimer = null;

  // Shared notes text size — a per-browser display preference (like theme),
  // never sent over the WS. See $lib/notes-text-size.js.
  let notesFontSize = 16;

  function setNotesFontSize(size) {
    notesFontSize = size;
    setNotesTextSize(size);
  }

  $: activeVideoPlaying = !!tabVideos[activeTabId]?.playing;

  // HMR / parent remount resets this component's lets to empty, but the WS
  // (owned by the page) may still be open — so we never get the join replay.
  // Ask the server for the room's current tabs/video/text on every mount.
  onMount(() => {
    send({ type: "tabs_sync" });
    notesFontSize = getNotesTextSize();
  });

  // ─── Inbound — called by the page's ws.onmessage, one method per type ──

  export async function applyTabsState(msg) {
    tabs = msg.tabs;
    activeTabId = msg.activeTabId;
    wsReady = true;
    // The active tab's player just (re)mounted (see {#key} below) — bring
    // it up to date with whatever we already know about that tab's video.
    await tick();
    pushActiveVideoToPlayer();
  }

  export function applyTabVideo(msg) {
    tabVideos = {
      ...tabVideos,
      [msg.tabId]: msg.videoId
        ? {
            videoId: msg.videoId,
            playing: msg.playing,
            positionSec: msg.positionSec,
            positionAtMs: msg.positionAtMs,
          }
        : null,
    };
    if (!msg.videoId && tabVideoTitles[msg.tabId]) {
      const next = { ...tabVideoTitles };
      delete next[msg.tabId];
      tabVideoTitles = next;
    }
    if (msg.tabId === activeTabId) videoPlayerRef?.applyState?.(msg);
  }

  function rememberVideoTitle(title) {
    if (!activeTabId || viewingTranscript) return;
    const t = String(title || "").trim();
    if (!t || tabVideoTitles[activeTabId] === t) return;
    tabVideoTitles = { ...tabVideoTitles, [activeTabId]: t };
  }

  export function applyTabText(msg) {
    tabTexts = { ...tabTexts, [msg.tabId]: msg.text };
  }

  export function applyTranscriptState(msg) {
    transcriptLines = msg.lines;
  }

  export function applyTranscriptLine(msg) {
    transcriptLines = [
      ...transcriptLines,
      { id: msg.id, speaker: msg.speaker, text: msg.text, at: msg.at },
    ];
  }

  export function applyDuck(msg) {
    roomTalking = !!msg.talking;
  }

  /** Re-announce a held Talk after a WS reconnect. */
  export function resyncDuck() {
    if (talking) send({ type: "yt_duck", talking: true });
  }

  export function applyTranscriptActivity(msg) {
    transcriptActivity = !!msg.active;
  }

  function pushActiveVideoToPlayer() {
    if (!videoPlayerRef || !activeTabId || viewingTranscript) return;
    const v = tabVideos[activeTabId];
    videoPlayerRef.applyState(
      v
        ? { tabId: activeTabId, ...v, triggerAtMs: Date.now() + clockOffset }
        : { tabId: activeTabId, videoId: "" },
    );
  }

  // ─── Outbound — tab structure ───────────────────────────────────────────

  function makeTabId() {
    return (
      "tab-" +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 6)
    );
  }

  function addTab() {
    send({ type: "tab_create", tabId: makeTabId() });
  }

  // Handles switching to a real tab OR to the Transcript — both go over the
  // wire as the same 'tab_switch' message (room-state-store.js's switchTab
  // accepts the reserved TRANSCRIPT_TAB_ID as a valid destination), so
  // "which pill the room is looking at" is one shared value, broadcast to
  // every peer exactly like switching to any real tab already was.
  function switchTab(tabId) {
    if (tabId === activeTabId) return;
    send({ type: "tab_switch", tabId });
  }

  function switchToTranscript() {
    switchTab(TRANSCRIPT_TAB_ID);
  }

  function closeTab(tabId, event) {
    event?.stopPropagation();
    send({ type: "tab_close", tabId });
  }

  // ─── Inbound — painting the shared text onto the Notes surface ──────────
  // The <textarea> this replaced had a `value={...}` binding, which only
  // touched the DOM when the bound value actually changed — so an unrelated
  // peer's broadcast landing mid-keystroke never disturbed a typist. A
  // contenteditable gets no such binding: assigning on every inbound
  // broadcast would fight the local cursor. planInboundNotesUpdate() is
  // that guard, made explicit and testable (see notes-editor.js).

  $: notesText =
    !viewingTranscript && activeTabId ? (tabTexts[activeTabId] ?? "") : "";
  // `notesEl` is listed so this re-runs the moment bind:this fills it in.
  $: syncNotesSurface(notesEl, activeTabId, notesText);

  function syncNotesSurface(el, tabId, text) {
    if (!el || !tabId) return;
    const tabChanged = tabId !== notesDomTabId;
    const { write, cancelUnsent } = planInboundNotesUpdate({
      domText: readNotesText(el),
      nextText: text,
      tabChanged,
      hasUnsentLocalEdit: unsentTabId === tabId,
      selectionInside: selectionIsInside(
        el,
        typeof window === "undefined" ? null : window.getSelection?.(),
      ),
    });
    if (write) el.textContent = text;
    if (cancelUnsent) {
      clearTimeout(textDebounceTimer);
      textDebounceTimer = null;
      unsentTabId = null;
    }
    notesDomTabId = tabId;
  }

  // ─── Outbound — shared text (last write wins) ───────────────────────────
  // Debounced so typing doesn't flood the socket. The server never echoes a
  // tab_text back to its sender, so this browser's own Notes surface is
  // never clobbered mid-keystroke; a concurrent edit from the *other* peer
  // can still overwrite unsent local keystrokes — an accepted trade-off for
  // a basic, no-save-state shared surface (no operational transform here).

  function onNotesInput(e) {
    const tabId = activeTabId;
    if (!tabId) return;
    const text = readNotesText(e.currentTarget);
    tabTexts = { ...tabTexts, [tabId]: text };
    notesDomTabId = tabId;
    unsentTabId = tabId;
    clearTimeout(textDebounceTimer);
    textDebounceTimer = setTimeout(() => {
      textDebounceTimer = null;
      if (unsentTabId === tabId) unsentTabId = null;
      send({ type: "tab_text", tabId, text });
      // We just made this the last write, so the model has to agree with
      // what we broadcast. Without this, a peer edit that landed mid-typing
      // (and was deliberately not painted over the caret) would linger in
      // `tabTexts` — the room would hold our text while ResearchPanel and a
      // later re-render still read theirs.
      tabTexts = { ...tabTexts, [tabId]: text };
    }, TEXT_DEBOUNCE_MS);
  }

  // A textarea only ever held plain text. A contenteditable would happily
  // swallow pasted HTML — fonts, colours, links — and then broadcast that
  // markup's rendered text while showing something else. Force plain text
  // so pasting looks exactly like it did before.
  function onNotesPaste(e) {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    // Deprecated, but the only cross-browser insert that keeps both the
    // caret and the native undo stack — and it fires `input`, so the
    // debounced send above runs as usual.
    const inserted = document.execCommand?.("insertText", false, text);
    if (inserted) return;
    // Fallback for a host without execCommand: splice the text in by hand,
    // then drive the same outbound path the input event would have.
    const sel = window.getSelection?.();
    const el = e.currentTarget;
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.textContent = readNotesText(el) + text;
    }
    onNotesInput({ currentTarget: el });
  }

  // ─── Outbound — hold-to-talk (room-wide, not per-tab) ───────────────────

  function startTalk(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (talking) return;
    talking = true;
    send({ type: "yt_duck", talking: true });
  }

  function endTalk() {
    if (!talking) return;
    talking = false;
    send({ type: "yt_duck", talking: false });
  }
</script>

<div class="room-tabs" data-ws-ready={wsReady}>
  <div class="tab-strip">
    {#each tabs as tab (tab.id)}
      <div class="tab-pill" class:active={tab.id === activeTabId}>
        <button
          type="button"
          class="tab-title"
          aria-label={tab.title}
          on:click={() => switchTab(tab.id)}
        >
          {tab.title}
        </button>
        {#if tabs.length > 1}
          <button
            type="button"
            class="btn-ghost btn-sm btn-icon tab-close"
            aria-label="Close {tab.title}"
            on:click={(e) => closeTab(tab.id, e)}
          >
            &times;
          </button>
        {/if}
      </div>
    {/each}
    <div class="tab-pill transcript-pill" class:active={viewingTranscript}>
      <button
        type="button"
        class="tab-title"
        aria-label="Transcript"
        on:click={switchToTranscript}
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
            title="Transcript incoming…"
            aria-label="Transcript incoming…"
          ></span>
        {/if}
      </button>
    </div>
    <button
      type="button"
      class="btn-ghost btn-icon"
      on:click={addTab}
      aria-label="Add tab"
      title="Add tab"><Plus /></button
    >
  </div>

  <div class="tab-content">
    {#if viewingTranscript}
      <TranscriptTab
        lines={transcriptLines}
        {pendingTurnId}
        {pendingActionId}
        {doneActionsByTurn}
        onTurnAction={handleTurnAction}
      />
    {:else if activeTabId}
      <div class="shared-notes">
        
        <div class="notes-toolbar-2">
          {#key activeTabId}
            <TabVideoPlayer
              tabId={activeTabId}
              {send}
              {clockOffset}
              {talking}
              {roomTalking}
              reportVideoTitle={rememberVideoTitle}
              bind:this={videoPlayerRef}
            >
              <svelte:fragment slot="controls-left">
                {#if activeVideoPlaying}
                  <button
                    type="button"
                    class="btn-secondary talk-btn"
                    class:is-active={talking}
                    aria-pressed={talking}
                    title="Hold to lower your local video volume"
                    on:pointerdown={startTalk}
                    on:pointerup={endTalk}
                    on:pointercancel={endTalk}
                    on:lostpointercapture={endTalk}
                    on:contextmenu|preventDefault
                  >
                    Talk
                  </button>
                {/if}
              </svelte:fragment>
            </TabVideoPlayer>
          {/key}
        </div>
        
        <div class="notes-toolbar-1">
          <span class="notes-toolbar-label">Text size</span>
          <div
            class="text-size-group"
            role="group"
            aria-label="Notes text size"
          >
            {#each NOTES_TEXT_SIZES as size (size)}
              <button
                type="button"
                class="btn-ghost btn-sm text-size-btn"
                class:is-active={notesFontSize === size}
                aria-pressed={notesFontSize === size}
                on:click={() => setNotesFontSize(size)}
              >
                {size}
              </button>
            {/each}
          </div>
        </div>


        <!-- The Notes editing surface. A contenteditable rather than a
             <textarea> (ADR-0008) so a later ticket can anchor a popup to
             an arbitrary highlighted span of it — see the `notesEl` block
             at the top of this file for how to get hold of the element.
             Its text is painted by syncNotesSurface(), never by a
             `value={...}`-style binding. -->
        <div
          id="shared-notes-editor"
          data-notes-editor
          class="shared-notes-editor"
          class:is-empty={notesText === ""}
          style="font-size: {notesFontSize}px"
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          aria-label="Shared notes — visible to everyone in the room…"
          aria-placeholder="Share notes between you and your guests…"
          data-placeholder="Share notes between you and your guests…"
          bind:this={notesEl}
          on:input={onNotesInput}
          on:paste={onNotesPaste}
        ></div>
      </div>
    {:else}
      <p class="tab-content-empty">Connecting…</p>
    {/if}
  </div>
</div>

<style>
  .room-tabs {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 750px;
    margin-right: auto;
    margin-left: auto;
  }

  .tab-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .notes-toolbar-1 {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tab-pill {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 2px 4px 12px;
    height: 30px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--muted);
    font-size: 13px;
  }
  .tab-pill.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .tab-pill.active .tab-close,
  .tab-pill.active .tab-close:hover {
    color: #fff;
    background: transparent;
  }

  .tab-title {
    background: none;
    border: none;
    padding: 0 12px 0 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    width: 100%;
    text-align: center;
  }

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
    0%, 100% { opacity: 0.35; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1.15); }
  }

  /* Nested inside the already-bordered .tab-pill — no second border. */
  .tab-close {
    border-color: transparent;
    opacity: 0.7;
    width: 24px;
    height: 24px;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }
  .tab-close:hover {
    opacity: 1;
  }

  .tab-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .tab-content-empty {
    color: var(--muted);
    font-size: 13px;
  }

  /* Press-and-hold control, not a click toggle — kept visually distinct
     from a plain secondary button via letter-spacing/uppercase, but same
     weight/size as Play so it doesn't compete with Start Recording. */
  .talk-btn {
    margin-right: auto;
    min-width: 88px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    user-select: none;
    touch-action: none;
  }

  .notes-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .notes-toolbar-label {
    font-size: 12px;
    color: var(--muted);
  }

  .text-size-group {
    display: flex;
    gap: 2px;
  }

  .text-size-btn {
    min-width: 30px;
    font-variant-numeric: tabular-nums;
  }
  .text-size-btn.is-active {
    background: var(--bg-elevated);
    border-color: var(--accent);
    color: var(--text);
  }

  .shared-notes {
    padding: 16px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font-family: inherit;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .shared-notes:focus-within {
    outline: none;
    border-color: var(--accent);
  }
  .shared-notes-editor {
    width: 100%;
    min-height: 80vh;
    font-size: 16px;
    line-height: 1.5;
    font-family: inherit;
    color: inherit;
    background: transparent;
    border: none;
    outline: none;
    cursor: text;
    /* A textarea wrapped long lines and honoured every newline the user
       typed; a plain block would collapse both. */
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .shared-notes-editor:focus-within {
    outline: none;
    border-color: var(--accent);
  }
  /* The `placeholder` attribute a textarea had. Driven by a class rather
     than :empty — a contenteditable the user has emptied usually still
     holds a stray <br>, which :empty would not match. */
  .shared-notes-editor.is-empty::before {
    content: attr(data-placeholder);
    color: var(--muted);
    pointer-events: none;
  }
</style>
