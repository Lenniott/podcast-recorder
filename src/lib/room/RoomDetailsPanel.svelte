<script>
  import { Clipboard, ClipboardCheck } from "$lib/icons";

  export let slug;
  export let isHostClaim = false;
  export let roomPassword = null;
  export let copyLinkDone = false;
  export let onCopyLink = () => {};
</script>

<div class="room-details">
  <div class="rd-slug-row">
    <div class="rd-slug-value">
      <div class="rd-value-label">Link:</div>
      <span class="rd-slug">/rec/{slug}</span>
    </div>
    <button
      type="button"
      class="btn-ghost btn-sm btn-icon"
      on:click={onCopyLink}
      title={copyLinkDone ? "Copied" : "Copy link"}
      aria-label={copyLinkDone ? "Copied" : "Copy link"}
    >
      {#if copyLinkDone}
        <ClipboardCheck />
      {:else}
        <Clipboard />
      {/if}
    </button>
  </div>

  {#if isHostClaim && roomPassword}
    <div class="rd-password-row">
      <span class="rd-value-label">Password:</span>
      <span class="rd-password-value">{roomPassword}</span>
    </div>
  {/if}
</div>

<style>
  .room-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  .rd-slug-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    min-height: 24px;
  }

  .rd-slug {
    font-size: 12px;
    color: var(--muted);
    font-family: monospace;
  }
  .rd-value-label {
    font-size: 12px;
    color: var(--muted);
  }

  .rd-slug-value {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rd-password-row {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-height: 24px;
  }
  .rd-password-value {
    font-family: monospace;
    color: var(--text);
  }
</style>
