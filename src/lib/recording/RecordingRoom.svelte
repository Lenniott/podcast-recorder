<script>
  import RoomSidebar from "$lib/room/RoomSidebar.svelte";
  import RoomTabs from "$lib/room/RoomTabs.svelte";
  import ResearchPanel from "$lib/research/ResearchPanel.svelte";
  import RoomPresenceTable from "$lib/room/RoomPresenceTable.svelte";
  import ThemeToggle from "$lib/ThemeToggle.svelte";

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
  // This browser's own speech-recognition status — passed straight through
  // to RoomTabs' status dot (see its own prop doc comment). Per-browser,
  // never synced to the room.
  export let transcriptionStatus = "stopped";
  export let canvasEl;

  export let roomName = "";
  export let slug = "";
  export let isHostClaim = false;
  export let guestCanAskResearch = false;
  export let roomPassword = "";
  export let wsStatus = "disconnected";
  export let peers = [];
  export let clientId = null;
  export let copyLinkDone = false;
  export let onCopyLink = () => {};
  export let devices = [];
  export let selectedDeviceId = "";
  export let micPermission = "prompt";
  export let audioInitError = "";
  export let micFallback = false;
  export let micFallbackName = "";
  export let gainValue = 1;
  export let gainDb = 0;
  export let onChangeMic = () => {};
  export let onGainInput = () => {};
  export let meterPct = 0;
  export let peakPct = 0;
  export let dbLevel = -60;
  export let peakHoldDb = -60;
  export let isClipping = false;
  export let lastClapFrom = null;
  export let recordingState = "idle";
  export let canRecord = false;
  export let myPeerIsRecording = false;
  export let recordingSeconds = 0;
  export let bytesWritten = 0;
  export let onToggleRecording = () => {};
  export let onClap = () => {};
  export let formatTime = (s) => String(s);
  export let formatBytes = (b) => String(b);
  export let send = () => {};
  export let clockOffset = 0;

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
  use:roomChrome
>
  <RoomSidebar
    bind:collapsed={sidebarCollapsed}
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
    {dbLevel}
    {peakHoldDb}
    {isClipping}
    {lastClapFrom}
    {recordingState}
    {canRecord}
    {myPeerIsRecording}
    {recordingSeconds}
    {bytesWritten}
    {onToggleRecording}
    {onClap}
    {formatTime}
    {formatBytes}
  />

  <main class="room-main">
    <div class="room-main-tools">
      <RoomPresenceTable
        {peers}
        {clientId}
        {slug}
        {wsStatus}
        {isHostClaim}
        {bytesWritten}
        {formatBytes}
      >
      <ThemeToggle floating={false} />
      </RoomPresenceTable>
    </div>

    <RoomTabs
      {send}
      {clockOffset}
      {transcriptionStatus}
      bind:this={roomTabs}
      bind:tabTexts
      onTurnAction={(actionId, turnId) => researchPanel?.runTurnAction?.(actionId, turnId)}
    />
  </main>

  <ResearchPanel
    {send}
    {slug}
    {tabTexts}
    {isHostClaim}
    {guestCanAskResearch}
    bind:collapsed={researchCollapsed}
    bind:this={researchPanel}
  />
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
    grid-template-columns: 240px 1fr 72px;
  }

  .room.sidebar-collapsed.research-collapsed {
    grid-template-columns: 72px 1fr 72px;
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

  @media (max-width: 720px) {
    .room,
    .room.sidebar-collapsed,
    .room.research-collapsed,
    .room.sidebar-collapsed.research-collapsed {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr auto;
    }
  }
</style>
