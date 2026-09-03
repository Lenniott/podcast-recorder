<script>
  // Post-stop, this-participant-only blocking modal (ticket 07). Shown once
  // *this* participant's own local recording has fully stopped (the WAV is
  // already saved to disk) but their own server-copy convenience upload
  // hasn't finished uploading/finalizing yet. This is not the sidebar's
  // all-participants view (ticket 06) — it only ever watches the upload the
  // page just started for its own recording.
  //
  // Closing is entirely reactive: the parent derives `open` from live
  // upload state (see +page.svelte's showUploadWaitModal), so the instant
  // that state reaches "complete" this modal simply stops being open —
  // there is no explicit close() to call here.
  export let open = false;
  export let percent = 0;
</script>

{#if open}
  <div class="wait-overlay" role="dialog" aria-modal="true" aria-labelledby="wait-title">
    <div class="wait-card">
      <h2 id="wait-title">Finishing your server copy&hellip;</h2>
      <p class="wait-hint">
        Your recording is already saved on this device — that file is safe no
        matter what happens next. This is just the convenience copy still
        making its way to the server.
      </p>

      <div class="wait-progress" role="progressbar" aria-valuenow={percent} aria-valuemin="0" aria-valuemax="100">
        <div class="wait-progress-fill" style="width: {percent}%"></div>
      </div>
      <div class="wait-percent">{percent}%</div>

      <p class="wait-note">
        If you need to leave before this finishes, you can still send the
        local file to the host another way — leaving won't lose your
        recording.
      </p>
    </div>
  </div>
{/if}

<style>
  .wait-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .wait-card {
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

  .wait-hint {
    color: var(--muted, #a1a1aa);
    font-size: 13px;
    line-height: 1.5;
    margin: 0 0 20px;
  }

  .wait-progress {
    height: 8px;
    border-radius: 999px;
    background: var(--border, #2a2a2e);
    overflow: hidden;
  }

  .wait-progress-fill {
    height: 100%;
    background: #a855f7;
    transition: width 0.2s ease;
  }

  .wait-percent {
    font-size: 13px;
    font-weight: 600;
    margin-top: 8px;
  }

  .wait-note {
    color: var(--muted, #a1a1aa);
    font-size: 12px;
    line-height: 1.5;
    margin: 20px 0 0;
    padding-top: 16px;
    border-top: 1px solid var(--border, #2a2a2e);
  }
</style>
