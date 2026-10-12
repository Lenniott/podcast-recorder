<script>
  import { browser } from "$app/environment";
  import { onDestroy } from "svelte";

  export let slug;
  export let roomName;

  // The opener only reveals the modal. The POST lives on the confirm
  // control, so one click on Delete cannot remove the room.
  let open = false;

  function setBodyScrollLocked(locked) {
    if (!browser) return;
    document.body.style.overflow = locked ? "hidden" : "";
  }

  $: setBodyScrollLocked(open);

  onDestroy(() => setBodyScrollLocked(false));

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
</script>

<svelte:window on:keydown={onKeydown} />

<div class="delete-room">
  <button type="button" class="btn-ghost btn-sm delete-open" on:click={() => (open = true)}>
    Delete
  </button>

  {#if open}
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="delete-room-title">
      <div class="card panel">
        <h2 id="delete-room-title">Delete {roomName}?</h2>
        <p class="lead">
          This cannot be undone. The room itself is removed, including its name, slug, and password.
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

        <form method="POST" action="?/delete_room">
          <input type="hidden" name="slug" value={slug} />
          <div class="actions">
            <button type="button" class="btn-secondary" use:focus on:click={close}>Cancel</button>
            <button type="submit" class="confirm">Delete room</button>
          </div>
        </form>
      </div>
    </div>
  {/if}
</div>

<style>
  .delete-open {
    color: var(--danger-text);
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
