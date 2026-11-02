<script>
  import { AlertTriangle, Clap } from "$lib/icons";
  import {
    REQUEST_START_LABEL,
    REQUEST_STOP_LABEL,
    WAITING_FOR_HOST_LABEL,
  } from "./synced-recording-session.js";

  // Presentational extraction of the room page's old .controls + .stats-bar
  // blocks. Recording state itself stays owned by the room page.
  export let recordingState = "idle"; // actual local capture
  export let roomRecording = false; // desired room state
  export let canRecord = false;
  export let micPermission = "prompt";
  export let wsStatus = "disconnected";
  export let myPeerIsRecording = false;
  export let recordingSeconds = 0;
  export let bytesWritten = 0;
  export let onToggleRecording = () => {};
  export let onClap = () => {};
  export let formatTime = (s) => String(s);
  export let formatBytes = (b) => String(b);
  // Collapsed-sidebar mode: same click handlers, icon-only buttons — Record/
  // Stop and Clap must stay reachable without expanding the sidebar.
  export let compact = false;
  // When the host is in the room, guest Start/Stop become a request instead
  // of a local write: 'request-start' | 'waiting-start' | 'request-stop' |
  // 'waiting-stop' | null.
  export let hostRequestMode = null;

  $: waitingForHost =
    hostRequestMode === "waiting-start" || hostRequestMode === "waiting-stop";

  $: controlState = recordingState === "stopping" ? "stopping" : roomRecording ? "recording" : "idle";

  $: recordTitle =
    hostRequestMode === "waiting-start" || hostRequestMode === "waiting-stop"
      ? WAITING_FOR_HOST_LABEL
      : hostRequestMode === "request-start"
        ? REQUEST_START_LABEL
        : hostRequestMode === "request-stop"
          ? REQUEST_STOP_LABEL
          : controlState === "stopping"
            ? "Finishing…"
          : controlState === "recording"
            ? "Stop Recording"
            : "Start Recording";

  $: recordDisabled =
    !canRecord || (micPermission === "denied" && !roomRecording) || waitingForHost;
</script>

{#if compact}
  <div class="record-controls-compact">
    <button
      type="button"
      class="btn-primary btn-icon"
      class:is-recording={recordingState === "recording" && !waitingForHost}
      class:is-waiting={waitingForHost}
      on:click={onToggleRecording}
      disabled={recordDisabled}
      title={recordTitle}
      aria-label={recordTitle}
      aria-busy={waitingForHost}
      data-testid="record-control"
      data-host-request={hostRequestMode || undefined}
    >
      {#if waitingForHost}
        <span class="wait-dots" aria-hidden="true"></span>
      {:else if controlState === "recording"}
        <span class="stop-square"></span>
      {:else}
        <span class="rec-circle"></span>
      {/if}
    </button>
    <button
      type="button"
      class="btn-ghost btn-icon"
      on:click={onClap}
      disabled={wsStatus !== "connected"}
      title="Clap — inject a 1kHz sync tone"
      aria-label="Clap"
    >
      <Clap />
    </button>
  </div>
{:else}
  <div class="record-controls">
    <div class="record-controls-top">
      <button
        type="button"
        class="btn-primary rec-btn"
        class:is-recording={recordingState === "recording" && !waitingForHost}
        class:is-waiting={waitingForHost}
        on:click={onToggleRecording}
        disabled={recordDisabled}
        title={micPermission === "denied" && !roomRecording ? "Mic access required" : recordTitle}
        aria-label={recordTitle}
        aria-busy={waitingForHost}
        data-testid="record-control"
        data-host-request={hostRequestMode || undefined}
      >
        {#if waitingForHost}
          {WAITING_FOR_HOST_LABEL}
        {:else if hostRequestMode === "request-start"}
          <span class="rec-circle"></span> {REQUEST_START_LABEL}
        {:else if hostRequestMode === "request-stop"}
          <span class="stop-square"></span> {REQUEST_STOP_LABEL}
        {:else if controlState === "idle"}
          <span class="rec-circle"></span> Start Recording
        {:else if controlState === "recording"}
          <span class="stop-square"></span> Stop Recording
        {:else}
          Finishing…
        {/if}
      </button>

      <button
        type="button"
        class="btn-ghost clap-btn"
        on:click={onClap}
        disabled={wsStatus !== "connected"}
        title="Adds a 1kHz sync tone marker to both recordings"
      >
        <Clap /> Sync Tone Marker
      </button>
    </div>
    <div class="stats-bar">
      {#if recordingState === "recording"}
        <div class="stat-row">
          <div class="stat recording-stat">
            <span class="stat-dot"></span>
            REC {formatTime(recordingSeconds)}
          </div>
          <div class="stat">{formatBytes(bytesWritten)}</div>
        </div>
      {:else if recordingState === "idle" && bytesWritten > 44}
        <div class="stat">
          Last recording: {formatBytes(bytesWritten)}
        </div>
      {/if}

      {#if myPeerIsRecording && recordingState === "idle"}
        <div class="stat warn-stat"><AlertTriangle /> Guest is recording</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .record-controls {
    display: flex;
    flex-direction: column;
  }

  .record-controls-top {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rec-btn,
  .clap-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 12px 16px;
  }

  .record-controls-compact {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .rec-circle {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: currentColor;
  }
  .stop-square {
    width: 10px;
    height: 10px;
    background: currentColor;
  }

  .wait-dots {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    animation: spin 0.8s linear infinite;
  }

  .btn-icon.is-recording,
  .rec-btn.is-recording {
    animation: pulse-ring 1.2s infinite;
  }

  .stats-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
    height: 32px;
  }

  .stat {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .stat-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .recording-stat {
    color: var(--danger-text);
    font-weight: 600;
  }

  .stat-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
    animation: pulse 1.2s infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  @keyframes pulse-ring {
    0%,
    100% {
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
    }
    50% {
      box-shadow: 0 0 0 4px rgba(239, 68, 68, 0);
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .warn-stat {
    color: var(--warn-text);
  }
</style>
