<script>
  export let slug
  export let guestLocked = false
</script>

<div class="guest-lock-cell">
  <span class="guest-lock-state">{guestLocked ? "Guests locked" : "Open to guests"}</span>
  <form method="POST" action="?/unlock_room">
    <input type="hidden" name="slug" value={slug} />
    <button type="submit" class="btn-secondary btn-sm">Unlock</button>
  </form>
</div>

<style>
  .guest-lock-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .guest-lock-state {
    font-size: 13px;
    white-space: nowrap;
  }

  form {
    margin: 0;
  }
</style>
