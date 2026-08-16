<script>
  import { tick } from "svelte";
  import TabVideoPlayer from "./TabVideoPlayer.svelte";

  // (payload) => void — JSON-sends over the room WS. The room's single
  // WebSocket connection is owned by the page, not this component.
  export let send = () => {};
  export let clockOffset = 0;

  const TEXT_DEBOUNCE_MS = 300;

  // ─── Shared room state, driven entirely by inbound WS messages ─────────
  let tabs = []; // [{id, title}], in server order — mirrors the room for everyone
  let activeTabId = null;

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

  // ─── Inbound — called by the page's ws.onmessage, one method per type ──

  export async function applyTabsState(msg) {
    tabs = msg.tabs;
    activeTabId = msg.activeTabId;
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

  function autosize(node) {
    function resize() {
      node.style.height = "auto";
      node.style.height = `${node.scrollHeight}px`;
    }
    resize();
    return { update: resize };
  }

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

<div class="room-tabs">
  <div class="tab-strip">
    {#each tabs as tab (tab.id)}
      <div class="tab-pill" class:active={tab.id === activeTabId}>
        <button type="button" class="tab-title" aria-label={tab.title} on:click={() => switchTab(tab.id)}>
          {tab.title}
        </button>
        {#if tabs.length > 1}
          <button type="button" class="tab-close" aria-label="Close {tab.title}" on:click={(e) => closeTab(tab.id, e)}>
            &times;
          </button>
        {/if}
      </div>
    {/each}
    <button type="button" class="tab-add" on:click={addTab} aria-label="Add tab" title="Add tab">+</button>
  </div>

  <div class="tab-content">
    {#if activeTabId}
      {#key activeTabId}
        <TabVideoPlayer tabId={activeTabId} {send} {clockOffset} {talking} {roomTalking} bind:this={videoPlayerRef}>
          <svelte:fragment slot="controls-left">
            {#if activeVideoPlaying}
              <button
                type="button"
                class="talk-btn"
                class:active={talking}
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
        use:autosize
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
    gap: 4px;
    padding: 4px 6px 4px 14px;
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
    padding: 4px 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font-size: 12px;
    line-height: 1;
    opacity: 0.7;
    cursor: pointer;
  }
  .tab-close:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.15);
  }

  .tab-add {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    font-size: 16px;
    cursor: pointer;
  }
  .tab-add:hover {
    background: var(--border);
    color: var(--text);
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

  .talk-btn {
    margin-right: auto;
    min-width: 88px;
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    user-select: none;
    touch-action: none;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
  }
  .talk-btn:hover {
    background: var(--accent-dim);
  }
  .talk-btn.active {
    background: var(--warn);
    color: #111;
    box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.45);
  }

  .shared-textarea {
    width: 100%;
    min-height: 100vh;
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
