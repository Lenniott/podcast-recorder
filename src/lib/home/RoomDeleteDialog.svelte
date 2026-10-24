<script>
  import { browser } from "$app/environment";
  import { onDestroy } from "svelte";

  /** Heading, including the room name or the selected count. */
  export let title;
  /** First paragraph. The destroy list below it is the same for one room and for many. */
  export let intro;
  /** Form action, `?/delete_room` or `?/delete_rooms`. */
  export let action;
  /** Confirm button label. Cancel never posts. */
  export let confirmLabel;
  /** One hidden `slug` input per entry. An empty list cannot post. */
  export let slugs = [];
  export let titleId = "delete-room-title";
  export let onCancel = () => {};

  // Mounted only while the warning is open, so locking scroll here is the
  // open state. Escape and Cancel both call onCancel; neither submits.
  function setBodyScrollLocked(locked) {
    if (!browser) return;
    document.body.style.overflow = locked ? "hidden" : "";
  }

  setBodyScrollLocked(true);
  onDestroy(() => setBodyScrollLocked(false));

  function onKeydown(event) {
    if (event.key === "Escape") onCancel();
  }

  function focusCancel(el) {
    el.focus();
  }

  function blockEmpty(event) {
    if (slugs.length === 0) event.preventDefault();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
  <div class="card panel">
    <h2 id={titleId}>{title}</h2>
    <p class="lead">{intro}</p>
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

    <form method="POST" {action} on:submit={blockEmpty}>
      {#each slugs as slug (slug)}
        <input type="hidden" name="slug" value={slug} />
      {/each}
      <div class="actions">
        <button type="button" class="btn-secondary" use:focusCancel on:click={onCancel}>Cancel</button>
        <button type="submit" class="confirm">{confirmLabel}</button>
      </div>
    </form>
  </div>
</div>

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

  form {
    margin: 0;
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
