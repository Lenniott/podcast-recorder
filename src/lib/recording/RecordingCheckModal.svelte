<script>
  import { onDestroy } from "svelte";
  import { Check, Mic, Play, X } from "$lib/icons";
  import Model from "$lib/Model.svelte";
  import { stayQuietCopy } from "$lib/recording/recording-check-share.js";

  // Sits over the room the instant recording actually starts. Recording is
  // already running for real — nothing here is a throwaway test take. It
  // asks you to read a line out loud, then plays back exactly what got
  // WRITTEN during that window (never the live mic) so a bad mic pick or a
  // broken write path is caught in the first few seconds, not after an hour.
  export let open = false;
  export let sentence = "";
  export let micLabel = "";
  // () => Blob | null — parent builds it from confirmed-written chunks only.
  export let onListen = () => null;
  export let onIssue = () => {};
  export let onConfirm = () => {};
  export let onReject = () => {};
  export let onDismiss = () => {};
  export let retaking = false;
  // Whose Check Turn the other person is on — stay-quiet overlay instead of
  // this peer's own modal. Derived from sequence turn, never mic level.
  export let quietRole = "";

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
    cleanup();
    previewUrl = URL.createObjectURL(blob);
    const url = previewUrl;
    // Keep the element mounted and start directly in the click, without
    // waiting for a render to create it or install its source.
    audioEl.src = url;
    audioEl.play().catch(error => {
      // A dismissal or a newer Listen click can abort the old play request.
      if (previewUrl !== url) return;
      hasListened = false;
      listenError = "Could not play the listen-back. Try the audio player’s Play button or Listen back again.";
      onIssue({ code: 'check-playback-failed', severity: 'warning', destination: 'playback',
        message: 'Could not start microphone check playback.', error });
    });
  }

  function handlePlaying() {
    if (!previewUrl) return;
    hasListened = true;
    listenError = "";
  }

  function handleConfirm() {
    cleanup();
    onConfirm();
  }

  function handleDismiss() {
    cleanup();
    onDismiss();
  }

  function focusControl(node) {
    const previous = document.activeElement;
    node.focus();
    return { destroy() { if (previous?.isConnected) previous.focus(); } };
  }

  function handleKey(event) {
    if (event.key === 'Escape' && (open || quietRole || retaking)) {
      event.preventDefault();
      handleDismiss();
    }
  }

  $: if (!open) cleanup();

  function handleReject() {
    cleanup();
    onReject();
  }

  // Hidden until listen-back succeeds. Model draws the buttons; this
  // dialog only supplies the labels and what they do.
  $: checkActions = hasListened
    ? [
        { label: "Yes, continue", onClick: handleConfirm, primary: true, icon: Check },
        { label: "Something’s wrong", onClick: handleReject, icon: X },
      ]
    : [];

  // handleConfirm/handleReject both call this before closing, so local
  // state (the object URL, the audio element) never leaks into the next
  // take's check.
  function cleanup() {
    // Invalidate pending play promises before pausing/releasing the source.
    const url = previewUrl;
    previewUrl = null;
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    }
    if (url) URL.revokeObjectURL(url);
    hasListened = false;
    listenError = "";
  }

  onDestroy(cleanup);
</script>

<svelte:window on:keydown={handleKey} />

<Model
  {open}
  labelledBy="check-title"
  actionPrompt={hasListened ? "Sound good?" : ""}
  actions={checkActions}
>
  <button
    type="button"
    class="btn-ghost btn-icon check-close"
    aria-label="Skip microphone check"
    title="Skip check, recording keeps going"
    on:click={handleDismiss}
    use:focusControl
  >
    <X />
  </button>
  <div class="check-badge">● Recording</div>
  <h2 id="check-title">Test your microphone?</h2>
  <p class="check-mic" title={micLabel || undefined}>
    <Mic />
    <span>{micLabel || "Unknown microphone"}</span>
  </p>
  <p class="check-hint">Read this sentence out loud:</p>

  <div class="check-sentence">"{sentence}"</div>

  <div class="check-actions">
    <button type="button" class="btn-secondary" on:click={handleListen}>
      <Play /> Listen back
    </button>
    <audio bind:this={audioEl} hidden={!previewUrl} on:playing={handlePlaying} controls></audio>
  </div>

  {#if listenError}
    <p class="check-error">{listenError}</p>
  {/if}
</Model>

<Model open={!open && (!!quietRole || retaking)} labelledBy="check-wait-title">
  <div class="check-badge">● Recording</div>
  <h2 id="check-wait-title">{retaking ? 'Preparing a fresh check' : 'Stay quiet for a moment'}</h2>
  {#if quietRole}<p class="check-hint" data-testid="check-quiet">{stayQuietCopy(quietRole)}</p>{/if}
  <button type="button" class="btn-secondary" on:click={handleDismiss} use:focusControl>Back to room</button>
</Model>

<style>
  .check-close {
    position: absolute;
    top: 10px;
    right: 10px;
  }

  .check-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--danger-text);
    font-weight: 600;
    font-size: 12px;
    margin-bottom: 8px;
  }

  h2 {
    font-size: 17px;
    font-weight: 600;
    margin: 0 0 8px;
    padding-right: 28px;
  }

  .check-mic {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 32px;
    padding-right: 28px;
    color: var(--muted, #a1a1aa);
    font-size: 13px;
    min-width: 0;
  }
  .check-mic span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check-hint {
    color: var(--muted, #a1a1aa);
    font-size: 13px;
    line-height: 1.5;
    margin: 0 0 4px;
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
</style>
