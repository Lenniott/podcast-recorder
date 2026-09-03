<script>
  import { onMount, tick } from "svelte";
  import { Plus } from "$lib/icons";
  import TabVideoPlayer from "../TabVideoPlayer.svelte";
  import TranscriptTab from "./TranscriptTab.svelte";
  import { TRANSCRIPT_TAB_ID } from "./transcript-sync.js";
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
  // this rather than racing the textarea's visibility).
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
  // sender, so a typist's own textarea isn't clobbered by an echo of its
  // own keystrokes) — lossy for anyone who isn't RoomTabs itself.
  export let tabTexts = {}; // tabId -> string

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
    if (msg.tabId === activeTabId) videoPlayerRef?.applyState?.(msg);
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

  // ─── Outbound — shared text (last write wins) ───────────────────────────
  // Debounced so typing doesn't flood the socket. The server never echoes a
  // tab_text back to its sender, so this browser's own textarea is never
  // clobbered mid-keystroke; a concurrent edit from the *other* peer can
  // still overwrite unsent local keystrokes — an accepted trade-off for a
  // basic, no-save-state shared textarea (no operational transform here).

  function onTextInput(e) {
    const text = e.currentTarget.value;
    tabTexts = { ...tabTexts, [activeTabId]: text };
    clearTimeout(textDebounceTimer);
    const tabId = activeTabId;
    textDebounceTimer = setTimeout(
      () => send({ type: "tab_text", tabId, text }),
      TEXT_DEBOUNCE_MS,
    );
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
      <div class="shared-textarea">
        
        <div class="notes-toolbar-2">
          {#key activeTabId}
            <TabVideoPlayer
              tabId={activeTabId}
              {send}
              {clockOffset}
              {talking}
              {roomTalking}
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


        <textarea
          class="shared-textarea-textarea"
          style="font-size: {notesFontSize}px"
          aria-label="Shared notes — visible to everyone in the room…"
          placeholder="Share notes between you and your guests…"
          value={tabTexts[activeTabId] ?? ""}
          on:input={onTextInput}
        ></textarea>
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

  .shared-textarea {
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

  .shared-textarea:focus-within {
    outline: none;
    border-color: var(--accent);
  }
  .shared-textarea-textarea {
    width: 100%;
    min-height: 80vh;
    field-sizing: content;
    resize: none;
    overflow: hidden;
    font-size: 16px;
    line-height: 1.5;
    font-family: inherit;
    color: inherit;
    background: transparent;
    border: none;
    outline: none;
  }
  .shared-textarea-textarea:focus-within {
    outline: none;
    border-color: var(--accent);
  }
</style>
