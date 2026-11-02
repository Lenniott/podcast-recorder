<script>
  // Asked once, on a real stop. Save is a link the person clicks, so the
  // download carries their own gesture; it never waits on the server copy.
  let {
    take = null, // { name, durationSeconds, endedEarly, url }
    uploading = false,
    percent = 0,
    formatTime = (s) => String(s),
    onSave = () => {},
    onLater = () => {}
  } = $props()
</script>

{#if take}
  <div class="save-overlay">
    <div class="save-card" role="dialog" aria-modal="true" aria-labelledby="save-title" data-testid="local-copy-save-prompt">
      <h2 id="save-title">Save your recording</h2>
      <p class="save-hint">
        This take is kept in this browser until you save it. Saving downloads the WAV to this device.
      </p>
      <p class="save-take">
        Length {formatTime(Math.round(take.durationSeconds))}
        {#if take.endedEarly}<span class="ended-early">Ended early</span>{/if}
      </p>
      {#if uploading}
        <p class="save-upload">The server copy is still uploading ({percent}%). You can save now.</p>
      {/if}
      <div class="save-actions">
        <button type="button" class="btn-ghost" onclick={onLater}>Later</button>
        <a class="btn-primary save-link" href={take.url} download={take.name} onclick={() => onSave(take)}>
          Save recording
        </a>
      </div>
    </div>
  </div>
{/if}

<style>
  .save-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .save-card {
    background: var(--bg-elevated, #18181b);
    border: 1px solid var(--border, #2a2a2e);
    border-radius: 14px;
    max-width: 420px;
    width: 100%;
    padding: 28px;
    text-align: center;
  }

  h2 {
    font-size: 17px;
    font-weight: 600;
    margin: 0 0 8px;
  }

  .save-hint,
  .save-upload {
    color: var(--muted, #a1a1aa);
    font-size: 13px;
    line-height: 1.5;
    margin: 0 0 12px;
  }

  .save-take {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 12px;
    display: flex;
    gap: 8px;
    justify-content: center;
    align-items: center;
  }

  .ended-early {
    color: var(--warn-text);
    font-size: 12px;
    font-weight: 500;
  }

  .save-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 20px;
  }

  .save-link {
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius);
    padding: 10px 18px;
    font-size: 14px;
  }

  .save-link:hover {
    text-decoration: none;
  }
</style>
