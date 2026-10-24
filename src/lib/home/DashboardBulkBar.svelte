<script>
  import RoomDeleteDialog from "./RoomDeleteDialog.svelte";

  /** Slugs the host has selected. Empty disables both actions. */
  export let slugs = [];

  // The opener only reveals the dialog. The POST lives on its confirm
  // control, so one click on Delete selected cannot remove the rooms.
  let open = false;

  $: empty = slugs.length === 0;
  $: roomWord = slugs.length === 1 ? "room" : "rooms";

  function openDialog() {
    if (empty) return;
    open = true;
  }

  /** A disabled control can still sit in a form. An empty set must not post. */
  function blockEmpty(event) {
    if (empty) event.preventDefault();
  }
</script>

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
    on:click={openDialog}
  >
    Delete selected
  </button>
</div>

{#if open}
  <RoomDeleteDialog
    title="Delete {slugs.length} selected rooms?"
    intro="Every selected room will be fully removed. This cannot be undone — all {slugs.length} selected {roomWord}, including name, slug, and password."
    action="?/delete_rooms"
    confirmLabel="Delete selected rooms"
    {slugs}
    titleId="delete-selected-title"
    onCancel={() => (open = false)}
  />
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
</style>
