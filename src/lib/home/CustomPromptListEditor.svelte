<script>
  // Custom Prompt half of the Usage Dashboard (see CONTEXT.md) — the
  // totals/per-room breakdown is the other half, UsageDashboardStats.svelte,
  // composed alongside this by the page. Replaced the single-prompt
  // ResearchPromptEditor when ADR-0008 turned the one global Research Prompt
  // into a managed list.
  import { enhance } from "$app/forms";
  import {
    CUSTOM_PROMPT_TITLE_MAX_LENGTH,
    PLACEHOLDER_HELP,
  } from "$lib/home/custom-prompts.js";

  /** @type {{ id: string, title: string, prompt: string }[]} */
  export let customPrompts = [];
  export let promptError = "";
  /** Which prompt the error belongs to — '' means the new-prompt form. */
  export let promptErrorId = "";

  let saving = "";
  let editingId = "";

  // Draft text for the new-prompt form, preserved across a failed save so a
  // long template isn't lost to a rejected title.
  export let draftTitle = "";
  export let draftPrompt = "";

  let creating = promptErrorId === "new" && !!promptError;

  // A successful save's server action ends in `redirect(303, '/')`, which
  // `enhance`'s `update()` follows with a client-side data refresh rather
  // than remounting this component — so `editingId`/`creating`, being local
  // state that only ever gets SET (never read back from a prop), would
  // otherwise stay however the click that opened the form last left them,
  // forever. `result.type` is 'failure' only on a rejected save (see
  // +page.server.js's fail() calls) — anything else (redirect included)
  // means it went through, so that's when the caller's onDone fires and
  // the row drops back to view mode. On failure, deliberately do nothing:
  // the error banner needs the form to stay open to show it against.
  function submitting(id, onDone) {
    saving = id;
    return async ({ result, update }) => {
      await update();
      saving = "";
      if (result.type !== "failure" && onDone) onDone();
    };
  }
</script>

<div class="page-header">
  <h2>Custom Prompts</h2>
  <p class="sub">
    Each Custom Prompt is a saved instruction a participant can run against a
    highlighted excerpt. The title is its button label. Write Placeholders into
    the prompt text to pull in room context — an unset one resolves to nothing
    at all, so a prompt that names only {"{selection}"} sees only the highlight.
  </p>
  <ul class="placeholders">
    {#each PLACEHOLDER_HELP as placeholder (placeholder.name)}
      <li>
        <code>{"{" + placeholder.name + "}"}</code>
        <span>{placeholder.description}</span>
      </li>
    {/each}
  </ul>
</div>

{#if promptError && !promptErrorId}
  <div class="error-banner">{promptError}</div>
{/if}

<ul class="prompt-list">
  {#each customPrompts as customPrompt (customPrompt.id)}
    <li class="prompt-row" class:editing={editingId === customPrompt.id}>
      {#if promptError && promptErrorId === customPrompt.id}
        <div class="error-banner">{promptError}</div>
      {/if}

      {#if editingId === customPrompt.id}
        <form
          method="POST"
          action="?/update_custom_prompt"
          use:enhance={() => submitting(customPrompt.id, () => (editingId = ""))}
        >
          <input type="hidden" name="custom-prompt-id" value={customPrompt.id} />
          <div class="field">
            <label for={`title-${customPrompt.id}`}>Title</label>
            <input
              id={`title-${customPrompt.id}`}
              name="custom-prompt-title"
              type="text"
              class="prompt-title-input"
              maxlength={CUSTOM_PROMPT_TITLE_MAX_LENGTH}
              placeholder="Button label…"
              value={customPrompt.title}
            />
          </div>
          <textarea
            name="custom-prompt-text"
            class="prompt-input"
            rows="10"
            placeholder="Write the prompt here…">{customPrompt.prompt}</textarea
          >
          <div class="row-actions">
            <button type="submit" class="btn-primary" disabled={saving === customPrompt.id}>
              {saving === customPrompt.id ? "Saving…" : "Save prompt"}
            </button>
            <button type="button" class="btn-secondary" on:click={() => (editingId = "")}>
              Cancel
            </button>
          </div>
        </form>
      {:else}
        <div class="row-summary">
          <div class="row-text">
            <span class="row-title">{customPrompt.title}</span>
            <span class="row-preview">{customPrompt.prompt}</span>
          </div>
          <div class="row-actions">
            <button
              type="button"
              class="btn-secondary"
              on:click={() => (editingId = customPrompt.id)}
            >
              Edit
            </button>
            <form
              method="POST"
              action="?/delete_custom_prompt"
              use:enhance={() => submitting(customPrompt.id)}
            >
              <input type="hidden" name="custom-prompt-id" value={customPrompt.id} />
              <button
                type="submit"
                class="btn-ghost delete-button"
                disabled={saving === customPrompt.id}
              >
                Delete
              </button>
            </form>
          </div>
        </div>
      {/if}
    </li>
  {:else}
    <li class="empty">No Custom Prompts yet.</li>
  {/each}
</ul>

{#if creating}
  <div class="prompt-row new-prompt">
    {#if promptError && promptErrorId === "new"}
      <div class="error-banner">{promptError}</div>
    {/if}
    <form
      method="POST"
      action="?/create_custom_prompt"
      use:enhance={() => submitting("new", () => (creating = false))}
    >
      <div class="field">
        <label for="new-custom-prompt-title">Title</label>
        <input
          id="new-custom-prompt-title"
          name="custom-prompt-title"
          type="text"
          class="prompt-title-input"
          maxlength={CUSTOM_PROMPT_TITLE_MAX_LENGTH}
          placeholder="Button label…"
          value={draftTitle}
        />
      </div>
      <textarea
        name="custom-prompt-text"
        class="prompt-input"
        rows="10"
        placeholder="Write the prompt here…">{draftPrompt}</textarea
      >
      <div class="row-actions">
        <button type="submit" class="btn-primary" disabled={saving === "new"}>
          {saving === "new" ? "Saving…" : "Add Custom Prompt"}
        </button>
        <button type="button" class="btn-secondary" on:click={() => (creating = false)}>
          Cancel
        </button>
      </div>
    </form>
  </div>
{:else}
  <button type="button" class="btn-primary new-prompt-button" on:click={() => (creating = true)}>
    New Custom Prompt
  </button>
{/if}

<style>
  h2 {
    font-size: 14px;
    font-weight: 400;
    margin: 0 0 6px 0;
  }

  .sub {
    color: var(--muted);
    font-size: 14px;
  }

  .placeholders {
    list-style: none;
    margin: 10px 0 0 0;
    padding: 0;
    display: grid;
    gap: 4px;
    font-size: 13px;
    color: var(--muted);
  }

  .placeholders code {
    font-family: monospace;
    margin-right: 6px;
  }

  .prompt-list {
    list-style: none;
    margin: 16px 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }

  .prompt-row {
    border: 1px solid var(--border, rgba(148, 163, 184, 0.3));
    border-radius: var(--radius);
    padding: 12px 14px;
    box-sizing: border-box;
  }

  .empty {
    color: var(--muted);
    font-size: 14px;
    padding: 12px 0;
  }

  .row-summary {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .row-text {
    display: grid;
    gap: 4px;
    min-width: 0;
    flex: 1 1 240px;
  }

  .row-title {
    font-size: 14px;
  }

  .row-preview {
    color: var(--muted);
    font-family: monospace;
    font-size: 12px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .row-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .prompt-title-input {
    margin-bottom: 12px;
  }

  .prompt-input {
    width: 100%;
    font-family: monospace;
    font-size: 14px;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border, rgba(148, 163, 184, 0.3));
    resize: vertical;
    margin-bottom: 12px;
    box-sizing: border-box;
    min-height: 40vh;
    field-sizing: content;
  }

  .delete-button {
    color: var(--danger-text);
  }

  .new-prompt-button {
    width: 240px;
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
