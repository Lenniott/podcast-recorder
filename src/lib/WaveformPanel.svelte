<script>
  import { Clap } from "$lib/icons";
  import { METER_MIN, METER_TICKS, dbToMeterPct, formatMeterReadout, meterGradientCss } from "./meter.js";

  // Presentational extraction of the room page's old .waveform-wrap block.
  // The canvas element itself is bound back up to the parent (bind:canvasEl)
  // so the page's existing requestAnimationFrame draw loop / analyserNode
  // wiring keeps drawing into the same <canvas> node, untouched.
  export let canvasEl = null;
  export let meterPct = 0;
  export let peakPct = 0;
  export let dbLevel = METER_MIN;
  export let peakHoldDb = METER_MIN;
  export let isClipping = false;
  export let lastClapFrom = null;
  // Collapsed-sidebar mode: same live canvas + level bar, no labels/readout
  // — the point of collapsing is to still see *something* is happening.
  export let compact = false;

  const meterGradient = `linear-gradient(90deg, ${meterGradientCss()})`;
</script>

<div class="waveform-wrap" class:compact>
  <canvas bind:this={canvasEl}></canvas>

  <div class="db-meter-wrap">
    <div class="db-meter-track">
      <div
        class="db-meter-fill"
        style="--clip-right: {100 - meterPct}%; background: {meterGradient}"
      ></div>
      {#if peakHoldDb > METER_MIN}
        <div class="db-peak-hold" style="left: {peakPct}%"></div>
      {/if}
    </div>
    {#if !compact}
      <div class="db-labels">
        {#each METER_TICKS as db}
          <span style="left: {dbToMeterPct(db)}%">{db}</span>
        {/each}
      </div>
      <div class="db-readout">
        <span class="db-value">{formatMeterReadout(dbLevel)} dBFS</span>
        <span class="db-peak-label">pk: {formatMeterReadout(peakHoldDb)}</span>
        {#if isClipping}<span class="clip-badge">CLIP</span>{/if}
      </div>
    {/if}
  </div>

  {#if lastClapFrom && !compact}
    <div class="clap-flash"><Clap /> from {lastClapFrom}</div>
  {/if}
</div>

<style>
  .waveform-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  canvas {
    width: 100%;
    height: 40px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
  }

  .waveform-wrap.compact canvas {
    height: 28px;
  }

  .db-meter-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .db-meter-track {
    position: relative;
    height: 8px;
    border-radius: 999px;
    background: var(--border);
    overflow: hidden;
  }

  .db-meter-fill {
    position: absolute;
    inset: 0;
    /* Gradient is sized to the full -60…0 track; clip reveals only up to level. */
    clip-path: inset(0 var(--clip-right) 0 0);
  }

  .db-peak-hold {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    width: 2px;
    background: #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
  }

  .db-labels {
    position: relative;
    height: 12px;
    font-size: 9px;
    color: var(--muted);
  }
  .db-labels span {
    position: absolute;
    transform: translateX(-50%);
  }

  .db-readout {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .clip-badge {
    color: var(--danger-text);
    font-weight: 700;
  }

  .clap-flash {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(245, 158, 11, 0.9);
    color: #111;
    font-size: 11px;
    font-weight: 600;
  }
</style>
