<script>
  import { enhance } from '$app/forms'
  export let data   // { siteAuthed, siteProtected }
  export let form

  let loading = false

  function focus(el) { el.focus() }
</script>

<svelte:head>
  <title>Podpatch — Podcast Recorder</title>
</svelte:head>

<main>
  <div class="hero">
    <div class="logo">🎙️</div>
    <h1>Podpatch</h1>
    <p class="tagline">Lossless local recording. No cloud. No fuss.</p>
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
        <input id="site-pw" name="password" type="password" required use:focus />
      </div>
      <button type="submit" class="btn-primary">Unlock</button>
    </form>
  </div>

  <!-- ── Create episode form ──────────────────────────────────────── -->
  {:else}

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
        <label for="name">Episode Name</label>
        <input
          id="name"
          name="name"
          type="text"
          placeholder="e.g. Ep 42 — The One About AI"
          value={form?.name ?? ''}
          maxlength="100"
          required
          use:focus
        />
      </div>

      <div class="field">
        <label for="password">Room Password</label>
        <input
          id="password"
          name="password"
          type="password"
          placeholder="Share this with your guest"
          minlength="4"
          required
        />
        <span class="hint">Your guest needs this to join. Not stored in plain text.</span>
      </div>

      <button type="submit" class="btn-primary" disabled={loading}>
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
    text-align: center;
    margin-bottom: 32px;
  }

  .logo { font-size: 48px; margin-bottom: 12px; }

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
