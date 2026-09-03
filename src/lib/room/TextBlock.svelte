<script>
  import { Annotation, AnnotationPlus, ClipboardCheck } from "$lib/icons";
  import Tooltip from "$lib/Tooltip.svelte";

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
    doneActionIds = [],
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
  <div class="text-block-content">
    {#if label}
      <span class="text-block-label">{label}</span>
    {/if}
    <span class="text-block-text">{text}</span>
  </div>
  {#if actions}
    <span class="text-block-actions" role="group" aria-label="Turn Actions">
      {#each TURN_ACTIONS as action (action.id)}
        {@const done = doneActionIds.includes(action.id)}
        <Tooltip label={done ? `${action.label} (already run)` : action.label}>
          <button
            type="button"
            class="text-block-action"
            class:is-busy={pendingActionId === action.id}
            aria-label={action.label}
            disabled={busy || done}
            onclick={(e) => {
              e.stopPropagation();
              onAction(action.id);
            }}
          >
            <action.Icon size="14" />
          </button>
        </Tooltip>
      {/each}
    </span>
  {/if}
</div>

<style>
  .text-block {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: 1fr 78px; /* Fixed right column width for buttons to avoid movement */
    gap: 8px;
    line-height: 1.5;
    position: relative;
    padding: 4px;
    margin: 0 -4px;
    border-radius: 8px;
    align-items: start;
  }
  
  .text-block:hover,
  .text-block:focus-within {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .text-block-content {
    display: flex;
    width: 100%;
    gap: 8px;
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
    border-color: var(--accent-dim);
    color: var(--accent-dim);
  }

  .text-block-action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
