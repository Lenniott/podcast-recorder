<script>
  import { browser } from "$app/environment";
  import { onDestroy } from "svelte";

  /** Slugs the host has selected. Empty disables both actions. */
  export let slugs = [];

  // The opener only reveals the modal. The POST lives on the confirm
  // control, so one click on Delete selected cannot remove the rooms.
  let open = false;

  $: empty = slugs.length === 0;

  function setBodyScrollLocked(locked) {
    if (!browser) return;
    document.body.style.overflow = locked ? "hidden" : "";
  }

  $: setBodyScrollLocked(open);

  onDestroy(() => setBodyScrollLocked(false));

  function openModal() {
    if (empty) return;
    open = true;
  }

  function close() {
    open = false;
  }

  function onKeydown(event) {
    if (!open) return;
    if (event.key === "Escape") close();
  }

  function focus(el) {
    el.focus();
  }

  /** A disabled control can still sit in a form. An empty set must not post. */
  function blockEmpty(event) {
    if (empty) event.preventDefault();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="bulk-bar">
  <form method="POST" action="?/unlock_rooms" on:submit={blockEmpty}>
    {#each slugs as slug (slug)}
      <input type="hidden" name="slug" value={slug} />
    {/each}
    <button type="submit" class="btn-secondary btn-sm" disabled={empty}>Unlock selected</button>
  </form>

  <button
    type="button"
    class="btn-ghost btn-sm delete-open"
    disabled={empty}
    on:click={openModal}
  >
    Delete selected
  </button>
</div>

{#if open}
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="delete-selected-title">
    <div class="card panel">
      <h2 id="delete-selected-title">Delete {slugs.length} selected rooms?</h2>
      <p class="lead">
        Every selected room will be fully removed. This cannot be undone — all {slugs.length}
        selected {slugs.length === 1 ? "room" : "rooms"}, including name, slug, and password.
      </p>
      <p class="lead">This deletes:</p>
      <ul>
        <li>server audio</li>
        <li>Research Assistant entries</li>
        <li>tab content</li>
        <li>transcript</li>
        <li>annotations</li>
      </ul>
      <p class="kept">
        Files already saved on a device stay there — local recordings on each person's computer are not deleted.
      </p>

      <form method="POST" action="?/delete_rooms" on:submit={blockEmpty}>
        {#each slugs as slug (slug)}
          <input type="hidden" name="slug" value={slug} />
        {/each}
        <div class="actions">
          <button type="button" class="btn-secondary" use:focus on:click={close}>Cancel</button>
          <button type="submit" class="confirm">Delete selected rooms</button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .bulk-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  form {
    margin: 0;
  }

  .delete-open {
    color: var(--danger-text);
  }

  .delete-open:disabled {
    color: var(--muted);
  }

  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .panel {
    width: 100%;
    max-width: 440px;
  }

  h2 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 10px;
    overflow-wrap: anywhere;
  }

  .lead {
    font-size: 14px;
    line-height: 1.5;
    margin-bottom: 8px;
  }

  ul {
    margin: 0 0 12px;
    padding-left: 18px;
    font-size: 14px;
    line-height: 1.6;
  }

  .kept {
    font-size: 14px;
    line-height: 1.5;
    color: var(--muted);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }

  .confirm {
    background: var(--danger);
    color: #fff;
    font-weight: 600;
  }

  .confirm:hover:not(:disabled) {
    background: #dc2626;
  }
</style>
