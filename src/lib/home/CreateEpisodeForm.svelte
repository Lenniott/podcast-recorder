<script>
  import { enhance } from "$app/forms";
  import { noAutofill } from "$lib/actions.js";

  export let form;

  let loading = false;

  // bind:value (not a one-way value={...} expression) so a component
  // re-render — e.g. from dev-server HMR after editing an unrelated file —
  // can't silently wipe out whatever the user already typed. Still
  // repopulated after a failed submit, since `form` only changes then.
  let name = form?.name ?? "";
  $: if (form && form.name !== undefined && form.name !== name)
    name = form.name;
</script>

<div class="card form-card">
  <h2 id="create-episode-title">Create a new episode</h2>

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
        <input class="checkbox-input" type="checkbox" name="guest-ai-allowed" />
        Guest AI access
      </label>
    </div>

    <button type="submit" class="btn-primary btn-block" disabled={loading}>
      {loading ? "Creating…" : "Create Room & Get Link"}
    </button>
  </form>
</div>

<style>
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
    padding-right: 32px;
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

  .field-checkbox {
    margin-bottom: 20px;
  }

  .checkbox-input {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    border: 1px solid var(--border, rgba(148, 163, 184, 0.2));
    background-color: var(--background);
    cursor: pointer;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    cursor: pointer;
    margin: 0;
  }
</style>
