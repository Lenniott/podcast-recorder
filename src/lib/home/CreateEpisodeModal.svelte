<script>
  import { browser } from "$app/environment";
  import { onDestroy } from "svelte";
  import { X } from "$lib/icons";
  import CreateEpisodeForm from "./CreateEpisodeForm.svelte";

  export let open = false;
  export let form;
  export let onClose = () => {};

  function setBodyScrollLocked(locked) {
    if (!browser) return;
    document.body.style.overflow = locked ? "hidden" : "";
  }

  $: setBodyScrollLocked(open);

  onDestroy(() => setBodyScrollLocked(false));

  function handleKeydown(event) {
    if (!open) return;
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <div class="overlay">
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="create-episode-title">
      <button
        type="button"
        class="btn-ghost btn-icon close"
        aria-label="Close"
        on:click={onClose}
      >
        <X />
      </button>

      <CreateEpisodeForm {form} />

      <p class="footer-note">
        Share the room link and password with your guest.<br />
        Audio is recorded locally and uploaded for download afterwards.
      </p>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
    overscroll-behavior: contain;
  }

  .panel {
    position: relative;
    width: 100%;
    max-width: 420px;
  }

  .close {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 1;
  }

  .footer-note {
    margin-top: 16px;
    text-align: center;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.7;
  }
</style>
