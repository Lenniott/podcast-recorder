<script>
  import { enhance } from '$app/forms'
  import { noAutofill } from '$lib/actions.js'
  export let data   // { siteAuthed, siteProtected }
  export let form

  let loading = false

  // bind:value (not a one-way value={...} expression) so a component
  // re-render — e.g. from dev-server HMR after editing an unrelated file —
  // can't silently wipe out whatever the user already typed. Still
  // repopulated after a failed submit, since `form` only changes then.
  let name = form?.name ?? ''
  $: if (form && form.name !== undefined && form.name !== name) name = form.name

  function focus(el) { el.focus() }
</script>

<svelte:head>
  <title>RecinPod Podcast Recorder</title>
</svelte:head>

<main>
  <div class="hero">
    <h1>Home Reccer</h1>
    <p class="tagline">Lossless local recording</p>
  </div>

  <!-- ── Site password gate ───────────────────────────────────────── -->
  {#if data.siteProtected && !data.siteAuthed}

  <div class="card form-card">
    <h2>Private Instance</h2>
    <p class="sub">Enter the site password to continue.</p>

    {#if form?.siteError}
      <div class="error-banner">{form.siteError}</div>
    {/if}

    <form method="POST" action="?/site_enter" use:enhance>
      <div class="field">
        <label for="site-pw">Site Password</label>
        <input id="site-pw" name="password" type="text" class="pw-mask" autocomplete="off" spellcheck="false" required use:focus />
      </div>
      <button type="submit" class="btn-primary btn-block">Unlock</button>
    </form>
  </div>

  <!-- ── Create episode form ──────────────────────────────────────── -->
  {:else}

  {#if data.expired}
    <div class="notice-banner notice-warn">That room has expired and is no longer available.</div>
  {:else if data.notFound}
    <div class="notice-banner notice-warn">Room not found — it may have been deleted.</div>
  {/if}

  <div class="card form-card">
    <h2>New Episode</h2>
    <p class="sub">Audio stays on your machine. We just keep you in sync.</p>

    {#if form?.error}
      <div class="error-banner">{form.error}</div>
    {/if}

    <form method="POST" action="?/create" use:enhance={() => {
      loading = true
      return async ({ update }) => { await update(); loading = false }
    }}>
      <div class="field">
        <label for="room-episode-name">Episode Name</label>
        <input
          id="room-episode-name"
          name="room-episode-name"
          type="text"
          placeholder="e.g. Ep 42 — The One About AI"
          autocomplete="nope"
          bind:value={name}
          maxlength="100"
          required
          readonly
          use:noAutofill
          use:focus
        />
      </div>

      <div class="field">
        <label for="room-episode-password">Room Password</label>
        <input
          id="room-episode-password"
          name="room-episode-password"
          type="text"
          class="pw-mask"
          placeholder="Share this with your guest"
          autocomplete="nope"
          spellcheck="false"
          minlength="4"
          required
        />
        <span class="hint">Your guest needs this to join. Not stored in plain text.</span>
      </div>

      <button type="submit" class="btn-primary btn-block" disabled={loading}>
        {loading ? 'Creating…' : 'Create Room & Get Link'}
      </button>
    </form>
  </div>

  <p class="footer-note">
    Rooms are permanent links. Share the URL + password with your guest.<br />
    Audio is recorded locally to <strong>your</strong> computer — nothing is uploaded.
  </p>

  {/if}
</main>

<style>
  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
  }

  .hero {
    text-align: left;
    margin-bottom: 32px;
  }


  h1 {
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -.02em;
    color: #fff;
  }

  .tagline {
    margin-top: 8px;
    color: var(--muted);
    font-size: 14px;
  }

  .form-card { width: 100%; max-width: 420px; }

  h2 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }

  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }

  .hint {
    display: block;
    font-size: 11px;
    color: var(--muted);
    margin-top: 5px;
  }

  .error-banner {
    background: rgba(239, 68, 68, .12);
    border: 1px solid rgba(239, 68, 68, .3);
    border-radius: var(--radius);
    color: #fca5a5;
    font-size: 13px;
    padding: 10px 14px;
    margin-bottom: 16px;
  }
  .notice-banner {
    font-size: 13px;
    padding: 10px 14px;
    border-radius: var(--radius);
    margin-bottom: 16px;
    text-align: center;
  }
  .notice-warn {
    background: rgba(250,204,21,.1);
    border: 1px solid rgba(250,204,21,.25);
    color: #fde047;
  }

  .footer-note {
    margin-top: 24px;
    text-align: center;
    font-size: 12px;
    color: var(--muted);
    max-width: 420px;
    line-height: 1.7;
  }

  .footer-note strong { color: var(--text); }
</style>
