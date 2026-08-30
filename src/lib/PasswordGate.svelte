<script>
  import { enhance } from '$app/forms'
  import { noAutofill } from '$lib/actions.js'
  import { Lock } from '$lib/icons'

  export let roomName = ''
  export let formError = ''
  export let myName = ''
</script>

<main class="gate-wrap">
  <div class="card gate-card">
    <div class="gate-icon"><Lock size={36} /></div>
    <h2>{roomName}</h2>
    <p class="sub">Enter the room code to join.</p>

    {#if formError}
      <div class="error-banner">{formError}</div>
    {/if}

    <!-- Keep the username/password-shaped pair away from the real form so
      password managers do not classify Join as a login. -->
    <div class="autofill-trap" aria-hidden="true">
      <input type="text" tabindex="-1" autocomplete="username" />
      <input type="password" tabindex="-1" autocomplete="current-password" />
    </div>

    <form
      method="POST"
      action="?/enter"
      autocomplete="off"
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      data-protonpass-ignore="true"
      use:enhance
    >
      <div class="field">
        <label for="name">Your name</label>
        <input
          id="name"
          name="name"
          type="text"
          autocomplete="off"
          maxlength="50"
          bind:value={myName}
          required
          readonly
          use:noAutofill
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-protonpass-ignore="true"
          data-form-type="other"
        />
      </div>
      <div class="field">
        <label for="room-episode-code">Room code</label>
        <input
          id="room-episode-code"
          name="room-episode-code"
          type="text"
          autocomplete="off"
          spellcheck="false"
          required
          readonly
          use:noAutofill
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-protonpass-ignore="true"
          data-form-type="other"
        />
      </div>
      <button type="submit" class="btn-primary btn-block">Join Room</button>
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

  .autofill-trap {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
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
