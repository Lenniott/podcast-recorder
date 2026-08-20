<script>
  import { onMount, tick } from "svelte";
  import TabVideoPlayer from "./TabVideoPlayer.svelte";

  // (payload) => void — JSON-sends over the room WS. The room's single
  // WebSocket connection is owned by the page, not this component.
  export let send = () => {};
  export let clockOffset = 0;

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
  let tabTexts = {}; // tabId -> string

  let videoPlayerRef = null; // the mounted TabVideoPlayer for activeTabId

  // Room-wide hold-to-talk duck (not per-tab — see applyDuck/resyncDuck).
  let talking = false; // true while *this* browser is holding Talk
  let roomTalking = false; // true while any peer (including us) is holding Talk

  let textDebounceTimer = null;

  $: activeVideoPlaying = !!tabVideos[activeTabId]?.playing;

  // HMR / parent remount resets this component's lets to empty, but the WS
  // (owned by the page) may still be open — so we never get the join replay.
  // Ask the server for the room's current tabs/video/text on every mount.
  onMount(() => {
    send({ type: "tabs_sync" });
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
      [msg.tabId]: msg.videoId ? { videoId: msg.videoId, playing: msg.playing, positionSec: msg.positionSec, positionAtMs: msg.positionAtMs } : null,
    };
    if (msg.tabId === activeTabId) videoPlayerRef?.applyState?.(msg);
  }

  export function applyTabText(msg) {
    tabTexts = { ...tabTexts, [msg.tabId]: msg.text };
  }

  export function applyDuck(msg) {
    roomTalking = !!msg.talking;
  }

  /** Re-announce a held Talk after a WS reconnect. */
  export function resyncDuck() {
    if (talking) send({ type: "yt_duck", talking: true });
  }

  function pushActiveVideoToPlayer() {
    if (!videoPlayerRef || !activeTabId) return;
    const v = tabVideos[activeTabId];
    videoPlayerRef.applyState(
      v
        ? { tabId: activeTabId, ...v, triggerAtMs: Date.now() + clockOffset }
        : { tabId: activeTabId, videoId: "" },
    );
  }

  // ─── Outbound — tab structure ───────────────────────────────────────────

  function makeTabId() {
    return "tab-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  }

  function addTab() {
    send({ type: "tab_create", tabId: makeTabId() });
  }

  function switchTab(tabId) {
    if (tabId === activeTabId) return;
    send({ type: "tab_switch", tabId });
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
    textDebounceTimer = setTimeout(() => send({ type: "tab_text", tabId, text }), TEXT_DEBOUNCE_MS);
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
        <button type="button" class="tab-title" aria-label={tab.title} on:click={() => switchTab(tab.id)}>
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
    <button type="button" class="btn-ghost btn-icon" on:click={addTab} aria-label="Add tab" title="Add tab">+</button>
  </div>

  <div class="tab-content">
    {#if activeTabId}
      {#key activeTabId}
        <TabVideoPlayer tabId={activeTabId} {send} {clockOffset} {talking} {roomTalking} bind:this={videoPlayerRef}>
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

      <textarea
        class="shared-textarea"
        placeholder="Shared notes — visible to everyone in the room…"
        value={tabTexts[activeTabId] ?? ""}
        on:input={onTextInput}
      ></textarea>
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
  }

  .tab-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
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
    color: var(--text);
    border-color: var(--accent);
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

  .shared-textarea {
    width: 100%;
    min-height: 80vh;
    field-sizing: content;
    resize: none;
    overflow: hidden;
    padding: 16px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    line-height: 1.5;
  }
  .shared-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
