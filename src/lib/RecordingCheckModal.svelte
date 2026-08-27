<script>
  // Sits over the room the instant recording actually starts. Recording is
  // already running for real — nothing here is a throwaway test take. It
  // asks you to read a line out loud, then plays back exactly what got
  // WRITTEN during that window (never the live mic) so a bad mic pick or a
  // broken write path is caught in the first few seconds, not after an hour.
  export let open = false;
  export let sentence = "";
  // () => Blob | null — parent builds it from confirmed-written chunks only.
  export let onListen = () => null;
  export let onConfirm = () => {};
  export let onReject = () => {};

  let audioEl;
  let previewUrl = null;
  let hasListened = false;
  let listenError = "";

  function handleListen() {
    listenError = "";
    const blob = onListen();
    if (!blob || blob.size <= 44) {
      // 44 bytes = an empty WAV header, nothing recorded yet
      listenError = "Nothing recorded yet — give it a second and try again.";
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    hasListened = true;
    // audioEl.src is bound reactively below; play once it updates
    queueMicrotask(() => audioEl?.play().catch(() => {}));
  }

  function handleConfirm() {
    cleanup();
    onConfirm();
  }

  function handleReject() {
    cleanup();
    onReject();
  }

  // handleConfirm/handleReject both call this before closing, so local
  // state (the object URL, the audio element) never leaks into the next
  // take's check.
  function cleanup() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    hasListened = false;
    listenError = "";
  }
</script>

{#if open}
  <div class="check-overlay" role="dialog" aria-modal="true" aria-labelledby="check-title">
    <div class="check-card">
      <div class="check-badge">● Recording</div>
      <h2 id="check-title">Quick check — is this actually being captured?</h2>
      <p class="check-hint">Read the line below out loud, then press Listen. What plays back is pulled from the file being written to disk right now — not your live mic — so if something's wrong with the recording itself, you'll hear it here.</p>

      <div class="check-sentence">"{sentence}"</div>

      <div class="check-actions">
        <button type="button" class="btn-secondary" on:click={handleListen}>
          ▶ Listen back
        </button>
        {#if hasListened}
          <audio bind:this={audioEl} src={previewUrl} controls></audio>
        {/if}
      </div>

      {#if listenError}
        <p class="check-error">{listenError}</p>
      {/if}

      {#if hasListened}
        <div class="check-verdict">
          <p class="check-verdict-q">Sound good?</p>
          <div class="check-verdict-actions">
            <button type="button" class="btn-primary" on:click={handleConfirm}>
              ✓ Sounds good — keep going
            </button>
            <button type="button" class="btn-ghost" on:click={handleReject}>
              ✗ Something's wrong — stop and fix it
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .check-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .check-card {
    background: var(--bg-elevated, #18181b);
    border: 1px solid var(--border, #2a2a2e);
    border-radius: 14px;
    max-width: 440px;
    width: 100%;
    padding: 28px;
  }

  .check-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--danger-text);
    font-weight: 600;
    font-size: 12px;
    margin-bottom: 12px;
  }

  h2 {
    font-size: 17px;
    font-weight: 600;
    margin: 0 0 8px;
  }

  .check-hint {
    color: var(--muted, #a1a1aa);
    font-size: 13px;
    line-height: 1.5;
    margin: 0 0 18px;
  }

  .check-sentence {
    font-size: 16px;
    font-style: italic;
    text-align: center;
    padding: 16px;
    border-radius: 10px;
    background: var(--bg, #0e0e10);
    border: 1px solid var(--border, #2a2a2e);
    margin-bottom: 18px;
  }

  .check-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: stretch;
  }

  .check-actions audio {
    width: 100%;
  }

  .check-error {
    color: var(--warn-text);
    font-size: 12px;
    margin: 10px 0 0;
  }

  .check-verdict {
    margin-top: 20px;
    padding-top: 18px;
    border-top: 1px solid var(--border, #2a2a2e);
  }

  .check-verdict-q {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 10px;
  }

  .check-verdict-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .check-verdict-actions button {
    width: 100%;
    padding: 10px 16px;
  }
</style>
