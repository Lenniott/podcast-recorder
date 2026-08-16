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
</script>

<div class="record-controls">
  <button
    class="rec-btn"
    class:recording={recordingState === "recording"}
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
    class="clap-btn"
    on:click={onClap}
    disabled={wsStatus !== "connected"}
    title="Inject a 1kHz sync tone into both recordings"
  >
    👏 Clap
  </button>

  <div class="stats-bar">
    {#if recordingState === "recording"}
      <div class="stat recording-stat">
        <span class="stat-dot"></span>
        REC {formatTime(recordingSeconds)}
      </div>
      <div class="stat">{formatBytes(bytesWritten)} written</div>
    {:else if recordingState === "idle" && bytesWritten > 44}
      <div class="stat">Last recording: {formatBytes(bytesWritten)} saved to your disk</div>
    {/if}

    {#if myPeerIsRecording && recordingState === "idle"}
      <div class="stat warn-stat">⚠️ Guest is recording — are you?</div>
    {/if}
  </div>
</div>

<style>
  .record-controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 16px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .rec-btn {
    background: var(--accent);
    color: var(--text);
  }
  .rec-btn.recording {
    background: #ef4444;
    color: #fff;
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

  .clap-btn {
    background: var(--bg-elevated);
    color: var(--text);
  }

  .stats-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }

  .stat {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .recording-stat {
    color: #ef4444;
    font-weight: 600;
  }

  .stat-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ef4444;
    animation: pulse 1.2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .warn-stat {
    color: #fbbf24;
  }
</style>
