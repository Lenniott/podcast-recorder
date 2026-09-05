<script>
  import { enhance } from "$app/forms";

  export let formError = "";

  function focus(el) {
    el.focus();
  }
</script>

<div class="card form-card">
  <h2>Private Instance</h2>
  <p class="sub">Enter the site password to continue.</p>

  {#if formError}
    <div class="error-banner">{formError}</div>
  {/if}

  <form method="POST" action="?/site_enter" use:enhance>
    <div class="field">
      <label for="site-pw">Site Password</label>
      <input
        id="site-pw"
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
</style>
