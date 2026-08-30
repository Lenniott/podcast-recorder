<script>
  import { AlertTriangle } from "$lib/icons";

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

  const GAIN_DB_MIN = -12;
  const GAIN_DB_MAX = 12;
  const GAIN_MARKS = [
    { label: "-12", pct: 0 },
    { label: "-6", pct: 25 },
    { label: "0", pct: 50 },
    { label: "+6", pct: 75 },
    { label: "+12", pct: 100 },
  ];

  function onGainSlider(e) {
    const db = +e.currentTarget.value;
    gainValue = 10 ** (db / 20);
    onGainInput();
  }
</script>

<div class="mic-panel">
  <div class="field">
    <label for="mic-select">Mic</label>
    <select
      id="mic-select"
      bind:value={selectedDeviceId}
      on:change={onChangeMic}
      disabled={devices.length === 0}
    >
      {#if devices.length === 0}
        <option value="">No microphone found</option>
      {:else}
        {#each devices as d (d.deviceId)}
          <option value={d.deviceId}
            >{d.label || `Microphone ${d.deviceId.slice(0, 8)}`}</option
          >
        {/each}
      {/if}
    </select>

    {#if micPermission === "denied"}
      <p class="perm-warn">
        <AlertTriangle /> Mic access denied. Check browser permissions.
      </p>
    {/if}
    {#if audioInitError}
      <p class="muted-text">{audioInitError}</p>
    {/if}

    {#if micFallback}
      <p class="fallback-warn">
        <AlertTriangle /> Original mic disconnected — switched to
        <strong>{micFallbackName}</strong>. Recording continues. Reconnect your
        mic or pick a new one above.
      </p>
    {/if}
  </div>
  <div class="field">
    <label for="gain-slider"
      >Gain <span class="gain-db"
        >{gainDb > 0 ? "+" : ""}{gainDb.toFixed(1)} dB</span
      ></label
    >
    <div class="field-content">
      <input
        id="gain-slider"
        class="gain-slider"
        type="range"
        min={GAIN_DB_MIN}
        max={GAIN_DB_MAX}
        step="0.1"
        value={Number.isFinite(gainDb) ? gainDb : 0}
        on:input={onGainSlider}
      />
      <div class="gain-markers">
        {#each GAIN_MARKS as mark}
          <span style="left: {mark.pct}%">{mark.label}</span>
        {/each}
      </div>
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
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
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
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    color: var(--warn-text);
    margin: 0;
  }

  .muted-text {
    font-size: 12px;
    color: var(--muted);
    margin: 0;
  }

  .field {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    margin: 0;
  }

  .gain-db {
    font-size: 9px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .field-content {
    width: 100%;
  }

  .gain-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 6px;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: var(--border);
    accent-color: var(--accent-dim);
  }
  .gain-slider::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 999px;
    background: var(--border);
  }
  .gain-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    margin-top: -5px;
    border-radius: 50%;
    background: var(--accent-dim);
    border: 2px solid var(--text);
  }
  .gain-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent-dim);
    border: 2px solid var(--text);
  }

  .gain-markers {
    position: relative;
    height: 14px;
    margin-top: 4px;
    margin-left: 8px;
    margin-right: 8px;
    font-size: 10px;
    color: var(--muted);
  }
  .gain-markers span {
    position: absolute;
    transform: translateX(-50%);
    font-variant-numeric: tabular-nums;
  }
</style>
