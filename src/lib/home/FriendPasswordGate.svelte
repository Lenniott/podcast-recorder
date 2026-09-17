<script>
  // Friend login (friend-password-auth, ticket 02) — a second, separate
  // login on the same entry page SitePasswordGate.svelte gates, posting to
  // its own ?/friend_enter action and cookie. Only ever shown when
  // FRIEND_PASSWORD is configured (see +page.svelte's `data.friendProtected`).
  import { enhance } from "$app/forms";

  export let formError = "";

  function focus(el) {
    el.focus();
  }
</script>

<div class="card form-card center-card">
  <h2>Friend Access</h2>
  <p class="sub">Enter the Friend password to create a room.</p>

  {#if formError}
    <div class="error-banner">{formError}</div>
  {/if}

  <form method="POST" action="?/friend_enter" use:enhance>
    <div class="field">
      <label for="friend-pw">Friend Password</label>
      <input
        id="friend-pw"
        name="password"
        type="text"
        class="pw-mask"
        autocomplete="off"
        spellcheck="false"
        required
        use:focus
      />
    </div>
    <button type="submit" class="btn-primary btn-block">Unlock</button>
  </form>
</div>

<style>
  .form-card {
    width: 100%;
    max-width: 420px;
    position: relative;
  }

  h2 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 24px;
  }

  .sub {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 24px;
  }

  .error-banner {
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: var(--radius);
    color: var(--danger-text);
    font-size: 13px;
    padding: 10px 14px;
    margin-bottom: 16px;
  }
  .center-card {
    margin-top: auto;
    margin-bottom: auto;
    margin-left: auto;
    margin-right: auto;
  }
</style>
