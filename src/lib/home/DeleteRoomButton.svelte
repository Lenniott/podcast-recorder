<script>
  import RoomDeleteDialog from "./RoomDeleteDialog.svelte";

  export let slug;
  export let roomName;

  // The opener only reveals the dialog. The POST lives on its confirm
  // control, so one click on Delete cannot remove the room.
  let open = false;
</script>

<div class="delete-room">
  <button type="button" class="btn-ghost btn-sm delete-open" on:click={() => (open = true)}>
    Delete
  </button>

  {#if open}
    <RoomDeleteDialog
      title="Delete {roomName}?"
      intro="This cannot be undone. The room itself is removed, including its name, slug, and password."
      action="?/delete_room"
      confirmLabel="Delete room"
      slugs={[slug]}
      titleId="delete-room-title"
      onCancel={() => (open = false)}
    />
  {/if}
</div>

<style>
  .delete-open {
    color: var(--danger-text);
  }
</style>
