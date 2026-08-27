<script>
  // Presentational extraction of the room page's old .controls + .stats-bar
  // blocks. Recording state itself stays owned by the room page.
  export let recordingState = "idle"; // idle | recording | stopping
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

  $: recordTitle =
    recordingState === "recording" ? "Stop Recording" : "Start Recording";
</script>

{#if compact}
  <div class="record-controls-compact">
    <button
      type="button"
      class="btn-primary btn-icon"
      class:is-recording={recordingState === "recording"}
      on:click={onToggleRecording}
      disabled={!canRecord || micPermission === "denied"}
      title={recordTitle}
      aria-label={recordTitle}
    >
      {#if recordingState === "recording"}
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
      👏
    </button>
  </div>
{:else}
  <div class="record-controls">
    <div class="record-controls-top">
      <button
        type="button"
        class="btn-primary rec-btn"
        class:is-recording={recordingState === "recording"}
        on:click={onToggleRecording}
        disabled={!canRecord || micPermission === "denied"}
        title={micPermission === "denied" ? "Mic access required" : ""}
      >
        {#if recordingState === "idle"}
          <span class="rec-circle"></span> Start Recording
        {:else if recordingState === "recording"}
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
        title="Inject a 1kHz sync tone into both recordings"
      >
        👏 Clap
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
          Last recording: {formatBytes(bytesWritten)} saved to your disk
        </div>
      {/if}

      {#if myPeerIsRecording && recordingState === "idle"}
        <div class="stat warn-stat">⚠️ Guest is recording — are you?</div>
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

  .btn-icon.is-recording {
    animation: pulse-ring 1.2s infinite;
  }

  .stats-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
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

  .warn-stat {
    color: var(--warn-text);
  }
</style>
