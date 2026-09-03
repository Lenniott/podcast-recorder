<script>
  import { Annotation, AnnotationPlus, ClipboardCheck } from "$lib/icons";

  /**
   * One unit of text in a tab surface (ADR-0005). On the Transcript Tab
   * each Block is a Turn. Notes stay a textarea this MVP; `editable` is
   * the seam for later contenteditable Blocks.
   */
  let {
    label = "",
    text = "",
    editable = false,
    actions = true,
    pendingActionId = null,
    onAction = (_actionId) => {},
  } = $props();

  const TURN_ACTIONS = [
    { id: "definition", label: "Definition", Icon: Annotation },
    { id: "facts", label: "Facts", Icon: ClipboardCheck },
    { id: "answer", label: "Answer", Icon: AnnotationPlus },
  ];

  let busy = $derived(!!pendingActionId);
</script>

<div class="text-block" class:is-pending={busy} class:is-editable={editable}>
  {#if label}
    <span class="text-block-label">{label}</span>
  {/if}
  <span class="text-block-text">{text}</span>
  {#if actions}
    <span class="text-block-actions" role="group" aria-label="Turn Actions">
      {#each TURN_ACTIONS as action (action.id)}
        <button
          type="button"
          class="text-block-action"
          class:is-busy={pendingActionId === action.id}
          aria-label={action.label}
          title={action.label}
          disabled={busy}
          onclick={(e) => {
            e.stopPropagation();
            onAction(action.id);
          }}
        >
          <action.Icon size="14" />
        </button>
      {/each}
    </span>
  {/if}
</div>

<style>
  .text-block {
    display: flex;
    gap: 8px;
    align-items: baseline;
    line-height: 1.5;
    position: relative;
    padding: 4px 6px;
    margin: 0 -6px;
    border-radius: 8px;
  }

  .text-block:hover,
  .text-block:focus-within {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .text-block-label {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--accent);
  }

  .text-block-text {
    white-space: pre-wrap;
    min-width: 0;
    flex: 1;
  }

  .text-block-actions {
    display: none;
    flex-shrink: 0;
    gap: 2px;
    align-items: center;
    margin-left: auto;
  }

  .text-block:hover .text-block-actions,
  .text-block:focus-within .text-block-actions,
  .text-block.is-pending .text-block-actions {
    display: inline-flex;
  }

  .text-block-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    cursor: pointer;
  }

  .text-block-action:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .text-block-action.is-busy {
    border-color: var(--accent);
    color: var(--accent);
  }

  .text-block-action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
