<script>
  import { ChevronLeft, ChevronRight } from "$lib/icons";
  import RoomDetailsPanel from "./RoomDetailsPanel.svelte";
  import MicPanel from "./MicPanel.svelte";
  import WaveformPanel from "./WaveformPanel.svelte";
  import RecordControls from "./RecordControls.svelte";
  import { Mic } from "$lib/icons";

  // Composes the four sidebar panels in the sketch's order: room details,
  // mic selection, waveform, then record/clap. Purely a forwarding wrapper —
  // no state of its own beyond the collapse toggle — so the room page has
  // one component to wire up instead of four.

  // Collapse is local UI state, not shared over the room WS — collapsing
  // your own sidebar shouldn't affect the other peer's view. Bindable so
  // the page can react to it (resizing the waveform canvas — see
  // rec/[slug]/+page.svelte).
  export let collapsed = false;

  // Room details
  export let roomName;
  export let slug;
  export let isHostClaim = false;
  export let roomPassword = null;
  export let wsStatus = "disconnected";
  export let peers = [];
  export let clientId = null;
  export let copyLinkDone = false;
  export let onCopyLink = () => {};

  // Mic
  export let devices = [];
  export let selectedDeviceId = "";
  export let micPermission = "prompt";
  export let audioInitError = "";
  export let micFallback = false;
  export let micFallbackName = "";
  export let gainValue = 1.0;
  export let gainDb = 0;
  export let onChangeMic = () => {};
  export let onGainInput = () => {};

  // Waveform
  export let canvasEl = null;
  export let meterPct = 0;
  export let peakPct = 0;
  export let dbLevel;
  export let peakHoldDb;
  export let isClipping = false;
  export let lastClapFrom = null;

  // Record / clap
  export let recordingState = "idle";
  export let canRecord = false;
  export let myPeerIsRecording = false;
  export let recordingSeconds = 0;
  export let bytesWritten = 0;
  export let onToggleRecording = () => {};
  export let onClap = () => {};
  export let formatTime = (s) => String(s);
  export let formatBytes = (b) => String(b);
</script>

<aside class="room-sidebar" class:collapsed>
  <div class="room-sidebar-header">
    {#if !collapsed}
      <div class="room-sidebar-header-name">
        <span class="room-sidebar-header-icon"><Mic /></span>
        {roomName}
      </div>
    {/if}
    <button
      type="button"
      class="btn-ghost btn-icon btn-sm collapse-toggle"
      on:click={() => (collapsed = !collapsed)}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {#if collapsed}
        <ChevronRight />
      {:else}
        <ChevronLeft />
      {/if}
    </button>
  </div>
  {#if !collapsed}
    <section class="sidebar-section">
      <RoomDetailsPanel
        {roomName}
        {slug}
        {isHostClaim}
        {roomPassword}
        {wsStatus}
        {peers}
        {clientId}
        {copyLinkDone}
        {onCopyLink}
      />
    </section>

    <section class="sidebar-section">
      <MicPanel
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
      />
    </section>
  {/if}

  <section class="sidebar-section">
    <WaveformPanel
      bind:canvasEl
      {meterPct}
      {peakPct}
      {dbLevel}
      {peakHoldDb}
      {isClipping}
      {lastClapFrom}
      compact={collapsed}
    />
  </section>

  <section class="sidebar-section">
    <RecordControls
      {recordingState}
      {canRecord}
      {micPermission}
      {wsStatus}
      {myPeerIsRecording}
      {recordingSeconds}
      {bytesWritten}
      {onToggleRecording}
      {onClap}
      {formatTime}
      {formatBytes}
      compact={collapsed}
    />
  </section>
</aside>

<style>
  .room-sidebar {
    display: flex;
    flex-direction: column;
    gap: 16px;
    position: sticky;
    top: 20px;
    max-height: calc(100vh - 40px);
    overflow-y: auto;
    padding: 8px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
  }
  .room-sidebar-header {
    display: flex;
    align-items: center;
  }

  .room-sidebar-header-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 15px;
    font-weight: 600;
  }
  .room-sidebar-header-icon {
    display: inline-flex;
    color: var(--muted);
  }

  .collapse-toggle {
    margin-left: auto;
    align-self: flex-end;
  }
  .room-sidebar.collapsed .collapse-toggle {
    align-self: center;
  }
</style>
