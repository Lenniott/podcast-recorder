<script>
  import { ChevronLeft, ChevronRight, Download02, Mic } from "$lib/icons";
  import RoomDetailsPanel from "./RoomDetailsPanel.svelte";
  import MicPanel from "../recording/MicPanel.svelte";
  import WaveformPanel from "../recording/WaveformPanel.svelte";
  import RecordControls from "../recording/RecordControls.svelte";
  import ServerCopyFilesModal from "../server-copy/ServerCopyFilesModal.svelte";

  export let collapsed = false;

  export let roomName;
  export let slug;
  export let isHostClaim = false;
  export let roomPassword = null;
  export let wsStatus = "disconnected";
  export let peers = [];
  export let copyLinkDone = false;
  export let onCopyLink = () => {};

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

  export let canvasEl = null;
  export let meterPct = 0;
  export let peakPct = 0;
  export let dbLevel;
  export let peakHoldDb;
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

  let filesModalOpen = false;
</script>

<aside class="room-sidebar" class:collapsed>
  <div class="room-sidebar-header">
    {#if !collapsed}
      <div class="room-sidebar-header-name">
        <span class="room-sidebar-header-icon"><Mic /></span>
        {roomName}
      </div>
    {/if}
    <div class="header-actions">
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
  </div>

  <div class="record-controls-container">
    {#if !collapsed}
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

    <section class="sidebar-section room-visualization">
      <WaveformPanel
        bind:canvasEl
        {meterPct}
        {peakPct}
        {dbLevel}
        {peakHoldDb}
        {isClipping}
        {lastClapFrom}
        compact={collapsed}
        live
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
  </div>
  {#if !collapsed}
    <section class="sidebar-section">
      {#if !collapsed && isHostClaim}
        <div class="file-download-container">
          <span class="file-download-label">Episode audio:</span>
          <button
            type="button"
            class="btn-ghost btn-icon btn-sm"
            data-testid="server-copy-files"
            title="Show every server-copy file for this room"
            aria-label="Server copy files"
            on:click={() => (filesModalOpen = true)}
          >
            <Download02 />
          </button>
        </div>
      {/if}
      <RoomDetailsPanel
        {slug}
        {isHostClaim}
        {roomPassword}
        {copyLinkDone}
        {onCopyLink}
      />
    </section>
  {/if}
</aside>

{#if filesModalOpen}
  <ServerCopyFilesModal
    {slug}
    {peers}
    onClose={() => (filesModalOpen = false)}
  />
{/if}

<style>
  .room-sidebar {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
    padding: 16px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
  }
  .room-sidebar-header {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
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

  .header-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .header-actions :global(.btn-ghost) {
    border-color: var(--muted);
  }
  .room-sidebar.collapsed .header-actions {
    margin-left: 0;
    width: 100%;
    justify-content: center;
  }

  .record-controls-container {
    margin-top: 16px;
    margin-bottom: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .file-download-container {
    display: flex;
    width: 100%;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .file-download-label {
    font-size: 12px;
    font-weight: 400;
    color: var(--muted);
  }
</style>
