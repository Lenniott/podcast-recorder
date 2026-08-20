<script>
  // Presentational extraction of the room page's old .mic-bar block. Device
  // enumeration, permission requests, and the audio graph itself stay owned
  // by the room page (rec/[slug]/+page.svelte) — this is markup only.
  export let devices = []; // MediaDeviceInfo[]
  export let selectedDeviceId = "";
  export let micPermission = "prompt"; // prompt | granted | denied
  export let audioInitError = "";
  export let micFallback = false;
  export let micFallbackName = "";
  export let gainValue = 1.0; // linear multiplier
  export let gainDb = 0;
  export let onChangeMic = () => {};
  export let onGainInput = () => {};
</script>

<div class="mic-panel">
  <div class="field">
  <label for="mic-select">Microphone</label>
  <select id="mic-select" bind:value={selectedDeviceId} on:change={onChangeMic} disabled={devices.length === 0}>
    {#if devices.length === 0}
      <option value="">No microphone found</option>
    {:else}
      {#each devices as d (d.deviceId)}
        <option value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 8)}`}</option>
      {/each}
    {/if}
  </select>

  {#if micPermission === "denied"}
    <p class="perm-warn">⚠️ Mic access denied. Check browser permissions.</p>
  {/if}
  {#if audioInitError}
    <p class="muted-text">{audioInitError}</p>
  {/if}

  {#if micFallback}
    <p class="fallback-warn">
      ⚠️ Original mic disconnected — switched to <strong>{micFallbackName}</strong>.
      Recording continues. Reconnect your mic or pick a new one above.
    </p>
  {/if}
  </div>
  <div class="gain-row">
    <label for="gain-slider">
      Input Gain
      <span class="gain-db">{gainDb > 0 ? "+" : ""}{gainDb.toFixed(1)} dB</span>
    </label>
    <input
      id="gain-slider"
      type="range"
      min="0.25"
      max="4"
      step="0.05"
      bind:value={gainValue}
      on:input={onGainInput}
    />
    <div class="gain-markers">
      <span>-12</span><span>-6</span><span>0</span><span>+6</span><span>+12</span>
    </div>
  </div>
</div>

<style>
  .mic-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  label {
    font-size: 12px;
    color: var(--muted);
  }

  select {
    width: 100%;
    height: 35px;
    padding: 0px 4px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 13px;
  }

  .perm-warn,
  .fallback-warn {
    font-size: 12px;
    color: #fbbf24;
    margin: 0;
  }

  .muted-text {
    font-size: 12px;
    color: var(--muted);
    margin: 0;
  }

  .gain-row {
    margin-top: 4px;
  }

  .gain-db {
    font-variant-numeric: tabular-nums;
    color: var(--text);
    margin-left: 6px;
  }

  .gain-row input[type="range"] {
    width: 100%;
    accent-color: var(--accent-dim);
  }

  .gain-markers {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
  }
</style>
