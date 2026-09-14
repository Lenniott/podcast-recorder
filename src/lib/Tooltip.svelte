<script>
  /**
   * Wraps a single trigger element (usually an icon button) and shows a
   * small text label on hover/focus. Pairs with `aria-label` on the
   * trigger for a11y — this is a *visible* hint, the aria-label is what
   * screen readers announce.
   *
   * Usage:
   *   <Tooltip label="Definition">
   *     <button aria-label="Definition">...</button>
   *   </Tooltip>
   */
  let { label = "", placement = "top", children } = $props();
</script>

<span class="tooltip-wrap" data-placement={placement}>
  {@render children?.()}
  {#if label}
    <span class="tooltip-bubble" role="tooltip">{label}</span>
  {/if}
</span>

<style>
  .tooltip-wrap {
    position: relative;
    display: inline-flex;
  }

  .tooltip-bubble {
    position: absolute;
    left: 50%;
    translate: -50% 0;
    padding: 3px 7px;
    border-radius: 5px;
    background: var(--text);
    color: var(--bg);
    font-size: 11px;
    font-weight: 500;
    line-height: 1.4;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.1s ease 0.35s;
    z-index: 50;
  }

  .tooltip-wrap[data-placement="top"] .tooltip-bubble {
    bottom: calc(100% + 6px);
  }

  .tooltip-wrap[data-placement="bottom"] .tooltip-bubble {
    top: calc(100% + 6px);
  }

  .tooltip-wrap:hover .tooltip-bubble,
  .tooltip-wrap:focus-within .tooltip-bubble {
    opacity: 1;
    visibility: visible;
  }
</style>
