<script>
  /**
   * Renders a Card's or research entry's structured Block array (see
   * research-blocks.js) as real markup — a `paragraph` per <p>, a `list` as
   * a real <ul><li>, a `stat` as a small labeled callout — instead of the
   * text a reader would otherwise have to parse themselves
   * (structured-research-output ticket 03).
   *
   * Shared by ResearchPanel.svelte's Annotation list AND research-entries
   * list — both surfaces show the exact same three block types, so one
   * component is used rather than duplicating this markup twice. The
   * caller decides WHETHER to render this at all (`annotation.blocks` /
   * `entry.blocks` present and non-empty) versus the plain-text fallback —
   * this component always has something to draw once it's mounted, since
   * `sanitizeBlockList` (room-state-store.js) never stores an empty array,
   * only `null`.
   */
  let { blocks = [] } = $props();
</script>

<div class="block-list" data-testid="block-list">
  {#each blocks as block, i (i)}
    {#if block.type === "paragraph"}
      <p class="block-paragraph" data-testid="block-paragraph">{block.text}</p>
    {:else if block.type === "list"}
      <ul class="block-list-items" data-testid="block-list-items">
        {#each block.items as item, j (j)}
          <li data-testid="block-list-item">{item}</li>
        {/each}
      </ul>
    {:else if block.type === "stat"}
      <div class="block-stat" data-testid="block-stat">
        <span class="block-stat-label" data-testid="block-stat-label"
          >{block.label}</span
        >
        <span class="block-stat-value" data-testid="block-stat-value"
          >{block.value}</span
        >
      </div>
    {/if}
  {/each}
</div>

<style>
  .block-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }

  .block-paragraph {
    margin: 0;
    font-size: inherit;
    line-height: 1.4;
    white-space: pre-wrap;
  }

  .block-list-items {
    margin: 0;
    padding-left: 18px;
    font-size: inherit;
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* A "stat" gets the same accent-tinted, distinct-from-plain-text
     treatment .annotation-card already gives a Card relative to a plain
     Comment — a small labeled callout, not a whole new visual language. */
  .block-stat {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    align-self: flex-start;
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-elevated));
  }

  .block-stat-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .block-stat-value {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
  }
</style>
