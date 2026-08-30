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
    <span class="rd-slug">/rec/{slug}</span>
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
      <span class="rd-password-label">Password:</span>
      <span class="rd-password-value">{roomPassword}</span>
    </div>
  {/if}
</div>

<style>
  .room-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rd-slug-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-height: 24px;
  }

  .rd-slug {
    font-size: 12px;
    color: var(--muted);
    font-family: monospace;
  }

  .rd-password-row {
    font-size: 12px;
    color: var(--muted);
  }
  .rd-password-value {
    font-family: monospace;
    color: var(--text);
  }
</style>
