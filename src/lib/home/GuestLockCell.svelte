<script>
  import { Lock, Check } from "$lib/icons";
  export let guestLocked = false
</script>

<span class="guest-lock-state" class:locked={guestLocked}>
  {#if guestLocked}<Lock size={14} />{:else}<Check size={14} />{/if}
  {guestLocked ? "Guests locked" : "Open to guests"}
</span>

<style>
  .guest-lock-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .locked {
    color: var(--warn-text);
    border-color: var(--warn-text);
  }
</style>
