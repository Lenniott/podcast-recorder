<script>
  import { enhance } from "$app/forms";
  import { noAutofill } from "$lib/actions.js";
  export let data; // { siteAuthed, siteProtected }
  export let form;

  let loading = false;
  let promptSaving = false;

  function formatCost(cost) {
    return `$${Number(cost || 0).toFixed(4)}`;
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  // bind:value (not a one-way value={...} expression) so a component
  // re-render — e.g. from dev-server HMR after editing an unrelated file —
  // can't silently wipe out whatever the user already typed. Still
  // repopulated after a failed submit, since `form` only changes then.
  let name = form?.name ?? "";
  $: if (form && form.name !== undefined && form.name !== name)
    name = form.name;

  function focus(el) {
    el.focus();
  }
</script>

<svelte:head>
  <title>RecinPod Podcast Recorder</title>
</svelte:head>

<main>
  <div class="hero">
    <h1>Home Reccer</h1>
    <p class="tagline">Podcast recording helper</p>
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

    <!-- ── Create episode form ──────────────────────────────────────── -->
  {:else}
    {#if data.expired}
      <div class="notice-banner notice-warn">
        That room has expired and is no longer available.
      </div>
    {:else if data.notFound}
      <div class="notice-banner notice-warn">
        Room not found — it may have been deleted.
      </div>
    {/if}

    <div class="card form-card">
      <h2>Create a new episode</h2>

      {#if form?.error}
        <div class="error-banner">{form.error}</div>
      {/if}

      <!-- Extensions attach to the first username/password-shaped pair on the
         page. Keep that pair off-screen and *outside* the real form so Chrome
         doesn't treat Create as a login. Real fields stay type=text, unmasked. -->
      <div class="autofill-trap" aria-hidden="true">
        <input type="text" tabindex="-1" autocomplete="username" />
        <input type="password" tabindex="-1" autocomplete="current-password" />
      </div>

      <form
        method="POST"
        action="?/create"
        autocomplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-protonpass-ignore="true"
        use:enhance={() => {
          loading = true;
          return async ({ update }) => {
            await update();
            loading = false;
          };
        }}
      >
        <div class="field">
          <label for="room-episode-name">Episode Name</label>
          <input
            id="room-episode-name"
            name="room-episode-name"
            type="text"
            placeholder="e.g. Ep 42 — The One About AI"
            autocomplete="off"
            bind:value={name}
            maxlength="100"
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
            placeholder="Share this with your guest"
            autocomplete="off"
            spellcheck="false"
            minlength="4"
            required
            readonly
            use:noAutofill
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            data-protonpass-ignore="true"
            data-form-type="other"
          />
          <span class="hint"
            >Your guest needs this to join. Not stored in plain text.</span
          >
        </div>

        <div class="field field-checkbox">
          <label class="checkbox-label">
            <input type="checkbox" name="guest-ai-allowed" />
            Let your guest use the Research Assistant too
          </label>
          <span class="hint"
            >Off by default — only you can Ask, run Turn Actions, or run
            Interpret. Set once, here; not editable from inside the room.</span
          >
        </div>

        <button type="submit" class="btn-primary btn-block" disabled={loading}>
          {loading ? "Creating…" : "Create Room & Get Link"}
        </button>
      </form>
    </div>

    <p class="footer-note">
      Share the room link and password with your guest.<br />
      Audio is recorded locally and uploaded for download afterwards.
    </p>

    <!-- ── Usage Dashboard (see CONTEXT.md) ─────────────────────────── -->
    <div class="card dashboard-card">
      <h2>Usage Dashboard</h2>

      <div class="totals-row">
        <div class="total-tile">
          <span class="total-value">{data.usageDashboard.totals.calls}</span>
          <span class="total-label">Calls</span>
        </div>
        <div class="total-tile">
          <span class="total-value"
            >{data.usageDashboard.totals.tokens.toLocaleString()}</span
          >
          <span class="total-label">Tokens</span>
        </div>
        <div class="total-tile">
          <span class="total-value"
            >{formatCost(data.usageDashboard.totals.cost)}</span
          >
          <span class="total-label">Cost</span>
        </div>
      </div>

      {#if data.usageDashboard.rooms.length}
        <div class="dashboard-table-wrap">
          <table class="dashboard-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Calls</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Recording</th>
                <th>Transcript</th>
                <th>Tabs</th>
                <th>Cards</th>
              </tr>
            </thead>
            <tbody>
              {#each data.usageDashboard.rooms as room (room.slug)}
                <tr>
                  <td>{room.name}</td>
                  <td>{room.calls}</td>
                  <td>{room.tokens.toLocaleString()}</td>
                  <td>{formatCost(room.cost)}</td>
                  <td>{formatDuration(room.recordingSeconds)}</td>
                  <td>{room.transcriptWords.toLocaleString()} words</td>
                  <td>{room.tabCount}</td>
                  <td>{room.researchCardCount}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="sub">No rooms yet.</p>
      {/if}

      <h3>Research Prompt</h3>
      <p class="sub">
        The instruction Custom/Interpret sends, written using {"{current_tab}"}
        and {"{transcript}"} for whatever live content it wants. Empty disables
        Custom in every room.
      </p>
      <form
        method="POST"
        action="?/save_research_prompt"
        use:enhance={() => {
          promptSaving = true;
          return async ({ update }) => {
            await update();
            promptSaving = false;
          };
        }}
      >
        <textarea
          name="research-prompt"
          class="research-prompt-input"
          rows="10"
          placeholder="Write the Research Prompt here…">{data.researchPrompt}</textarea
        >
        <button
          type="submit"
          class="btn-primary btn-block"
          disabled={promptSaving}
        >
          {promptSaving ? "Saving…" : "Save Research Prompt"}
        </button>
      </form>
    </div>
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

  h1 {
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .tagline {
    margin-top: 8px;
    color: var(--muted);
    font-size: 14px;
  }

  .form-card {
    width: 100%;
    max-width: 420px;
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

  .hint {
    display: block;
    font-size: 11px;
    color: var(--muted);
    margin-top: 5px;
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
  .notice-banner {
    font-size: 13px;
    padding: 10px 14px;
    border-radius: var(--radius);
    margin-bottom: 16px;
    text-align: center;
  }
  .notice-warn {
    background: rgba(250, 204, 21, 0.1);
    border: 1px solid rgba(250, 204, 21, 0.25);
    color: var(--warn-text);
  }

  .footer-note {
    margin-top: 24px;
    text-align: center;
    font-size: 12px;
    color: var(--muted);
    max-width: 420px;
    line-height: 1.7;
  }

  .field-checkbox {
    margin-bottom: 20px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 500;
  }

  .dashboard-card {
    width: 100%;
    max-width: 720px;
    margin-top: 24px;
  }

  .dashboard-card h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 24px 0 6px;
  }

  .totals-row {
    display: flex;
    gap: 16px;
    margin-bottom: 20px;
  }

  .total-tile {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 16px;
    border: 1px solid var(--border, rgba(148, 163, 184, 0.2));
    border-radius: var(--radius);
  }

  .total-value {
    font-size: 20px;
    font-weight: 700;
  }

  .total-label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dashboard-table-wrap {
    overflow-x: auto;
    margin-bottom: 12px;
  }

  .dashboard-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .dashboard-table th,
  .dashboard-table td {
    text-align: left;
    padding: 6px 10px;
    white-space: nowrap;
    border-bottom: 1px solid var(--border, rgba(148, 163, 184, 0.15));
  }

  .dashboard-table th {
    color: var(--muted);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.04em;
  }

  .research-prompt-input {
    width: 100%;
    font-family: inherit;
    font-size: 13px;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border, rgba(148, 163, 184, 0.3));
    resize: vertical;
    margin-bottom: 12px;
    box-sizing: border-box;
  }
</style>
