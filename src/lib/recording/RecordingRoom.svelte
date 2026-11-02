<script>
  import RoomSidebar from "$lib/room/RoomSidebar.svelte";
  import RoomTabs from "$lib/room/RoomTabs.svelte";
  import ResearchPanel from "$lib/research/ResearchPanel.svelte";
  import RoomPresenceTable from "$lib/room/RoomPresenceTable.svelte";
  import ThemeToggle from "$lib/ThemeToggle.svelte";
  import { onMount } from "svelte";
  import { BookClosed, FileSearch02, User01 } from "$lib/icons";
  import { stayQuietCopy } from "$lib/recording/recording-check-share.js";
  import { MOBILE_ROOM_QUERY, MOBILE_VIEWS } from "$lib/room/mobile-layout.js";

  export let sidebarCollapsed = false;
  // Independent of sidebarCollapsed — mirrors RoomSidebar's own local
  // collapse toggle, but for the right-hand Research Assistant panel (see
  // ResearchPanel.svelte). Never synced to the room.
  export let researchCollapsed = false;
  export let roomTabs = null;
  export let researchPanel = null;
  // tabId -> string — RoomTabs.svelte's own true, complete, current copy,
  // two-way bound so it can be handed to ResearchPanel as a plain prop
  // (see RoomTabs.svelte's own comment on `export let tabTexts`).
  export let tabTexts = {};
  // tabId -> YouTube title — RoomTabs owns the player-local copy, bound
  // sideways into ResearchPanel so `{current_tab}` can bundle it. Nothing
  // above RecordingRoom needs this (unlike tabTexts).
  let tabVideoTitles = {};
  // The rendered Turn list inside ResearchPanel's Transcript facet, bound
  // up here and handed sideways to RoomTabs — which hosts the shared
  // selection popup and registers this element as a selection surface, so
  // highlighting a Turn offers the same Comment + Custom Prompt actions
  // Notes text does (ADR-0008, ticket 06). Same sideways-plumbing pattern
  // as tabVideoTitles above; nothing above this component needs it.
  let transcriptEl = null;
  // This browser's own speech-recognition status — passed through to the
  // panel's Transcript facet button, which is where the Transcript lives
  // since ticket 06. Per-browser, never synced to the room.
  export let transcriptionStatus = "stopped";
  // [{id, speaker, text, at}] — the room's live Transcript, owned by
  // +page.svelte (lifted there in ticket 06) and read by both children:
  // the panel renders the Turns, RoomTabs only needs them for a
  // highlight-fired Custom Prompt's `{transcript}` Placeholder.
  export let transcriptLines = [];
  // 'annotations' | 'transcript' — which panel facet this participant is
  // looking at. Local and personal, exactly like researchCollapsed above;
  // never sent over the room WS.
  export let researchFacet = "annotations";
  export let canvasEl;

  export let roomName = "";
  export let slug = "";
  export let isHostClaim = false;
  export let guestCanAskResearch = false;
  // [{id, title, usesSelection}] — every configured Custom Prompt. Passed to
  // both RoomTabs (the selection popup's one-button-per-prompt row,
  // ADR-0008 ticket 05 — only the usesSelection ones) and ResearchPanel
  // (a standalone panel button per prompt — only the ones that are NOT
  // usesSelection, since they have no highlight to run against).
  export let customPrompts = [];
  export let roomPassword = "";
  export let wsStatus = "disconnected";
  export let peers = [];
  export let clientId = null;
  export let copyLinkDone = false;
  export let onCopyLink = () => {};
  export let devices = [];
  export let selectedDeviceId = "";
  export let micPermission = "prompt";
  export let openingMic = false;
  export let audioInitError = "";
  export let micFallback = false;
  export let micFallbackName = "";
  export let gainValue = 1;
  export let gainDb = 0;
  export let onChangeMic = () => {};
  export let onGainInput = () => {};
  export let meterPct = 0;
  export let peakPct = 0;
  export let peakHoldDb = -60;
  export let isClipping = false;
  export let lastClapFrom = null;
  export let takeCountdownSec = 0;
  export let recordingState = "idle";
  export let roomRecording = false;
  export let canRecord = false;
  export let myPeerIsRecording = false;
  export let recordingSeconds = 0;
  export let bytesWritten = 0;
  export let checkPreviewByClientId = {};
  export let stayQuietRole = "";
  export let localCopies = [];
  export let onSaveLocalCopy = () => {};
  export let onRemoveLocalCopy = () => {};
  export let savedLocalCopyNames = new Set();
  export let hostRequestMode = null;
  export let onToggleRecording = () => {};
  export let onClap = () => {};
  export let formatTime = (s) => String(s);
  export let formatBytes = (b) => String(b);
  export let send = () => {};
  export let clockOffset = 0;

  // Narrow viewports get one region at a time behind a bottom nav instead
  // of three columns. Every region stays mounted either way (only hidden by
  // CSS), so the waveform canvas, a playing shared video and the research
  // feed never get torn down by switching views. Local UI only.
  let mobile = false;
  let mobileView = "tabs";
  let transcriptActivity = false;
  let desktopCollapse = null;

  function setMobile(next) {
    if (next === mobile) return;
    if (next) {
      desktopCollapse = { sidebar: sidebarCollapsed, research: researchCollapsed };
      sidebarCollapsed = true;
      researchCollapsed = false;
    } else if (desktopCollapse) {
      sidebarCollapsed = desktopCollapse.sidebar;
      researchCollapsed = desktopCollapse.research;
    }
    mobile = next;
  }

  onMount(() => {
    const query = window.matchMedia(MOBILE_ROOM_QUERY);
    setMobile(query.matches);
    const onChange = (e) => setMobile(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });

  function roomChrome(_node) {
    document.documentElement.dataset.roomChrome = "";
    return {
      destroy() {
        delete document.documentElement.dataset.roomChrome;
      },
    };
  }
</script>

<div
  class="room"
  class:sidebar-collapsed={sidebarCollapsed}
  class:research-collapsed={researchCollapsed}
  data-mobile-view={mobileView}
  use:roomChrome
>
  <RoomSidebar
    bind:collapsed={sidebarCollapsed}
    {mobile}
    {roomName}
    {slug}
    {isHostClaim}
    {roomPassword}
    {wsStatus}
    {peers}
    {copyLinkDone}
    {onCopyLink}
    {devices}
    bind:selectedDeviceId
    {micPermission}
    {openingMic}
    {audioInitError}
    {micFallback}
    {micFallbackName}
    bind:gainValue
    {gainDb}
    {onChangeMic}
    {onGainInput}
    bind:canvasEl
    {meterPct}
    {peakPct}
    {peakHoldDb}
    {isClipping}
    {lastClapFrom}
    {takeCountdownSec}
    {recordingState}
    {roomRecording}
    {canRecord}
    {myPeerIsRecording}
    {recordingSeconds}
    {bytesWritten}
    {hostRequestMode}
    {onToggleRecording}
    {onClap}
    {formatTime}
    {formatBytes}
    {localCopies}
    {onSaveLocalCopy}
    {onRemoveLocalCopy}
    {savedLocalCopyNames}
  />

  <main class="room-main">
    {#if mobile && stayQuietRole && mobileView !== "participants"}
      <p class="mobile-quiet-line" data-testid="mobile-quiet-line">
        {stayQuietCopy(stayQuietRole)}
      </p>
    {/if}
    <div class="room-main-tools">
      <RoomPresenceTable
        {peers}
        {clientId}
        {slug}
        {wsStatus}
        {isHostClaim}
        {bytesWritten}
        {formatBytes}
        {checkPreviewByClientId}
        {stayQuietRole}
        alwaysOpen={mobile}
      >
      <ThemeToggle floating={false} />
      </RoomPresenceTable>
    </div>

    <div class="room-main-tabs">
    <RoomTabs
      {send}
      {clockOffset}
      {transcriptLines}
      {transcriptEl}
      bind:this={roomTabs}
      bind:tabTexts
      bind:tabVideoTitles
      {customPrompts}
      canRunCustomPrompts={isHostClaim || guestCanAskResearch}
    />
    </div>
  </main>

  <ResearchPanel
    {send}
    {tabTexts}
    {tabVideoTitles}
    {isHostClaim}
    {guestCanAskResearch}
    {transcriptLines}
    {transcriptionStatus}
    {customPrompts}
    bind:facet={researchFacet}
    bind:turnsEl={transcriptEl}
    bind:collapsed={researchCollapsed}
    bind:transcriptActivity
    bind:this={researchPanel}
  />

  <nav class="mobile-nav" aria-label="Room sections">
    <div role="tablist" class="mobile-nav-list">
      {#each MOBILE_VIEWS as view (view.id)}
        <button
          type="button"
          role="tab"
          aria-selected={mobileView === view.id}
          data-testid="mobile-nav-{view.id}"
          on:click={() => (mobileView = view.id)}
        >
          <span class="mobile-nav-icon" aria-hidden="true">
            {#if view.id === "tabs"}<BookClosed />{:else if view.id === "research"}<FileSearch02 />{:else}<User01 />{/if}
            {#if view.id === "research" && transcriptActivity && mobileView !== "research"}
              <span class="mobile-nav-pulse" title="Transcript incoming…"></span>
            {/if}
          </span>
          {view.label}
        </button>
      {/each}
    </div>
  </nav>
</div>

<style>
  .room {
    height: 100vh;
    display: grid;
    grid-template-columns: 240px 1fr 280px;
    gap: 0px;
    margin: 0 auto;
    overflow: hidden;
  }

  .room.sidebar-collapsed {
    grid-template-columns: 72px 1fr 280px;
  }

  .room.research-collapsed {
    grid-template-columns: 240px 1fr 46px;
  }

  .room.sidebar-collapsed.research-collapsed {
    grid-template-columns: 72px 1fr 46px;
  }

  .room-main {
    min-width: 0;
    min-height: 0;
    padding: 20px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .room-main-tools {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;

  }

  .room-main-tabs {
    display: contents;
  }

  .mobile-nav,
  .mobile-quiet-line {
    display: none;
  }

  @media (max-width: 720px) {
    .room,
    .room.sidebar-collapsed,
    .room.research-collapsed,
    .room.sidebar-collapsed.research-collapsed {
      height: 100dvh;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
      grid-template-areas: "header" "content" "nav";
    }

    .room > :global(.room-sidebar) {
      grid-area: header;
    }
    .room-main,
    .room > :global(.research-panel) {
      grid-area: content;
    }
    .room-main {
      padding: 12px;
    }
    .room > :global(.research-panel) {
      border: none;
      padding: 12px;
    }
    .room > :global(.research-panel .collapse-toggle) {
      display: none;
    }

    .room[data-mobile-view="research"] .room-main,
    .room:not([data-mobile-view="research"]) > :global(.research-panel),
    .room[data-mobile-view="tabs"] .room-main-tools,
    .room[data-mobile-view="participants"] .room-main-tabs {
      display: none;
    }

    .mobile-quiet-line {
      display: block;
      margin: 0 0 10px;
      padding: 8px 12px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--warn) 12%, transparent);
      color: var(--warn-text);
      font-size: 13px;
    }

    .mobile-nav {
      grid-area: nav;
      display: block;
      border-top: 1px solid var(--border);
      background: var(--bg-elevated);
      padding: 6px 8px max(8px, env(safe-area-inset-bottom));
    }
    .mobile-nav-list {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
    }
    .mobile-nav button {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 8px 4px;
      border: 0;
      border-radius: 9px;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
    }
    .mobile-nav button[aria-selected="true"] {
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      color: var(--text);
      font-weight: 600;
    }
    .mobile-nav-icon {
      position: relative;
      display: inline-flex;
    }
    .mobile-nav-pulse {
      position: absolute;
      top: -2px;
      right: -6px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      animation: mobile-nav-pulse 1s ease-in-out infinite;
    }
  }

  @keyframes mobile-nav-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
</style>
