<script>
  // Shared dialog shell: dimmed overlay, card, and the action buttons at
  // the bottom. Callers own the content and decide what each button does.
  export let open = false;
  export let labelledBy = "";
  // Optional line above the buttons, e.g. "Sound good?"
  export let actionPrompt = "";
  // { label, onClick, primary?, icon? } — empty hides the footer.
  export let actions = [];
</script>

{#if open}
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby={labelledBy || undefined}
  >
    <div class="card">
      <slot />

      {#if actions.length}
        <div class="actions">
          {#if actionPrompt}
            <p class="action-prompt">{actionPrompt}</p>
          {/if}
          {#each actions as action}
            <button
              type="button"
              class={action.primary ? "btn-primary" : "btn-ghost"}
              on:click={action.onClick}
            >
              {#if action.icon}
                <svelte:component this={action.icon} />
              {/if}
              {action.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .card {
    position: relative;
    background: var(--bg-elevated, #18181b);
    border: 1px solid var(--border, #2a2a2e);
    border-radius: 14px;
    max-width: 440px;
    width: 100%;
    padding: 28px;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 20px;
    padding-top: 18px;
    border-top: 1px solid var(--border, #2a2a2e);
  }

  .action-prompt {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 2px;
  }

  .actions button {
    width: 100%;
    padding: 10px 16px;
  }
</style>
