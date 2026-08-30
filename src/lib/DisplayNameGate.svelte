<script>
  import { enhance } from '$app/forms'
  import { noAutofill } from '$lib/actions.js'
  import { User } from '$lib/icons'

  export let roomName = ''
  export let formError = ''
  export let myName = ''

  function focus(el) {
    el.focus()
  }
</script>

<main class="gate-wrap">
  <div class="card gate-card">
    <div class="gate-icon"><User size={36} /></div>
    <h2>{roomName}</h2>
    <p class="sub">How should we show you to others in this room?</p>

    {#if formError}
      <div class="error-banner">{formError}</div>
    {/if}

    <form method="POST" action="?/set_display_name" use:enhance={() => {
      return async ({ update }) => { await update() }
    }}>
      <div class="field">
        <label for="display-name">Your name</label>
        <input
          id="display-name"
          name="name"
          type="text"
          autocomplete="off"
          maxlength="50"
          bind:value={myName}
          required
          readonly
          use:noAutofill
          use:focus
        />
      </div>
      <button type="submit" class="btn-primary btn-block">Continue</button>
    </form>
  </div>
</main>

<style>
  .gate-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .gate-card {
    max-width: 380px;
    width: 100%;
    text-align: center;
    position: relative;
  }

  .gate-icon {
    display: flex;
    justify-content: center;
    margin-bottom: 12px;
    color: var(--text);
  }

  h2 {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .sub {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 20px;
  }

  .error-banner {
    background: rgba(239, 68, 68, .12);
    border: 1px solid rgba(239, 68, 68, .3);
    border-radius: var(--radius);
    color: var(--danger-text);
    font-size: 13px;
    padding: 10px 14px;
    margin-bottom: 16px;
    text-align: left;
  }
</style>
