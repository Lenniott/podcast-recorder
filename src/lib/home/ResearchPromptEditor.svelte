<script>
  // Research Prompt half of the Usage Dashboard (see CONTEXT.md) — the
  // totals/per-room breakdown is the other half, UsageDashboardStats.svelte,
  // composed alongside this by the page.
  import { enhance } from "$app/forms";
  import { RESEARCH_PROMPT_TITLE_MAX_LENGTH } from "$lib/home/research-prompt.js";

  export let researchPrompt = "";
  export let researchPromptTitle = "";
  export let promptError = "";

  let promptSaving = false;
</script>
<div class="page-header">
  <h2>Research Prompt</h2>
  <p class="sub">
    The title is the Custom button's label in every room. Use the {"{current_tab}"}
    and {"{transcript}"} Placeholders to add room-specific context to the prompt.
    {"{current_tab}"} is the video title (if one is loaded) then the tab notes.
    Custom stays off until both title and prompt have text.
  </p>
</div>
{#if promptError}
  <div class="error-banner">{promptError}</div>
{/if}
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
  <div class="field">
    <label for="research-prompt-title">Title</label>
    <input
      id="research-prompt-title"
      name="research-prompt-title"
      type="text"
      class="research-prompt-title-input"
      maxlength={RESEARCH_PROMPT_TITLE_MAX_LENGTH}
      placeholder="Button label in the room…"
      value={researchPromptTitle}
    />
  </div>
  <textarea
    name="research-prompt"
    class="research-prompt-input"
    rows="10"
    placeholder="Write the Research Prompt here…">{researchPrompt}</textarea
  >
  <button type="submit" class="btn-primary btn-block save-prompt" disabled={promptSaving}>
    {promptSaving ? "Saving…" : "Save Research Prompt"}
  </button>
</form>

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

  .research-prompt-title-input {
    margin-bottom: 12px;
  }

  .research-prompt-input {
    width: 100%;
    font-family: monospace;
    font-size: 14px;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border, rgba(148, 163, 184, 0.3));
    resize: none;
    margin-bottom: 12px;
    box-sizing: border-box;
    min-height: 68vh;
    field-sizing: content;
  }
  .save-prompt {
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
