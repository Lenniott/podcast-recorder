<script>
  /**
   * The floating popup that appears next to a highlighted span of text
   * (ADR-0008, ticket 03). Presentational and content-agnostic on purpose:
   * it knows where to sit and how to lay out a row of actions, and nothing
   * about Annotations, Notes, Comments or the Research Assistant.
   *
   * ─── HOW TO ADD AN ACTION (ticket 05, and anything after it) ───────────
   * You do not touch this file. An action is data, not markup:
   *
   *   <SelectionPopup
   *     rect={selectionRect}
   *     actions={[
   *       { id: "comment", label: "Comment", icon: AnnotationPlus },
   *       ...customPrompts.map((p) => ({
   *            id: `prompt:${p.id}`, label: p.title, icon: Sparkles,
   *            disabled: !canRunPrompts, title: "Needs Research Access" }))
   *     ]}
   *     onAction={(id) => ...}
   *   >
   *     {#if openActionId === "comment"}<CommentComposer … />{/if}
   *   </SelectionPopup>
   *
   * Each entry is `{ id, label, icon?, title?, disabled?, ariaLabel? }`.
   * `onAction(id)` fires on click; the parent decides what that means —
   * ticket 03's Comment opens a composer in the slot below the row, while
   * ticket 05's Custom Prompts are expected to fire immediately and need no
   * slot content at all (ADR-0008: "every Custom Prompt fires immediately").
   * Both work because this component never branches on an action's id.
   *
   * The default slot renders under the action row, inside the same floating
   * card, and is where an action that needs follow-up UI (a text input, a
   * confirmation) puts it. Empty slot = a bare row of buttons.
   *
   * Positioning is `position: fixed` in viewport coordinates, so `rect`
   * should come straight from `selectionRect()` in selection-popup.js with
   * no scroll maths applied by the caller.
   */
  import { popupPosition } from "./selection-popup.js";

  /** Viewport rect of the highlight to anchor to, or null to hide. */
  export let rect = null;

  /** [{ id, label, icon?, title?, disabled?, ariaLabel? }] — see above. */
  export let actions = [];

  /** (actionId) => void */
  export let onAction = () => {};

  /** Which action's follow-up UI the parent is currently showing, if any.
   *  Used only to mark the button as pressed — this component never decides
   *  it, so an action that needs no follow-up UI can leave it null. */
  export let openActionId = null;

  export let ariaLabel = "Actions for the selected text";

  // Measured, not assumed: an action row's width depends on how many actions
  // the caller passed and how long their labels are, and the composer in the
  // slot changes the height the moment it opens. Measuring keeps the popup
  // correctly placed as ticket 05 adds buttons, with no hardcoded size to
  // fall out of date.
  let popupWidth = 0;
  let popupHeight = 0;

  // Viewport size, tracked so the clamp stays right across a window resize.
  let viewportWidth = 0;
  let viewportHeight = 0;

  $: measured = popupWidth > 0 && popupHeight > 0;
  $: position =
    rect && measured
      ? popupPosition(
          rect,
          { width: viewportWidth, height: viewportHeight },
          { width: popupWidth, height: popupHeight },
        )
      : null;
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />

{#if rect}
  <!-- Rendered (so it can be measured) but kept invisible for the single
       frame before its own size is known — otherwise every popup would
       visibly jump from a default position to its real one. -->
  <div
    class="selection-popup"
    data-testid="selection-popup"
    data-placement={position?.placement ?? "above"}
    role="dialog"
    aria-label={ariaLabel}
    style="top: {position?.top ?? 0}px; left: {position?.left ??
      0}px; visibility: {position ? 'visible' : 'hidden'}"
    bind:clientWidth={popupWidth}
    bind:clientHeight={popupHeight}
  >
    <!-- preventDefault on the ACTION ROW only (not the whole card): pressing
         an action button must not blur/collapse the very selection the
         action is about, but anything the slot renders — a text input, say —
         still has to be focusable normally. -->
    <div class="selection-popup-actions" on:mousedown|preventDefault role="presentation">
      {#each actions as action (action.id)}
        <button
          type="button"
          class="btn-secondary btn-sm selection-popup-action"
          data-action-id={action.id}
          disabled={action.disabled}
          title={action.title || action.label}
          aria-label={action.ariaLabel || action.label}
          aria-pressed={openActionId === action.id}
          on:click={() => onAction(action.id)}
        >
          {#if action.icon}
            <span class="selection-popup-action-icon">
              <svelte:component this={action.icon} />
            </span>
          {/if}
          <span>{action.label}</span>
        </button>
      {/each}
    </div>
    <slot />
  </div>
{/if}

<style>
  .selection-popup {
    position: fixed;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 6px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    max-width: min(360px, calc(100vw - 16px));
  }

  .selection-popup-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .selection-popup-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .selection-popup-action-icon {
    display: inline-flex;
    width: 14px;
    height: 14px;
  }
</style>
