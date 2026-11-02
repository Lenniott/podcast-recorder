<script>
  import { takeNumber } from './local-copy-store.js'

  // This room's takes kept in this browser, each with Save and Remove.
  let {
    takes = [], // [{ name, durationSeconds, endedEarly, url }]
    savedNames = new Set(),
    formatTime = (s) => String(s),
    onSave = () => {},
    onRemove = () => {}
  } = $props()
</script>

{#if takes.length}
  <div class="local-copies" data-testid="local-copy-list">
    <div class="local-copies-heading">Kept in this browser</div>
    <p class="local-copies-hint">Save each take, then remove it once the saved file opens.</p>
    <ul>
      {#each takes as take (take.name)}
        <li data-testid="local-copy-row" data-name={take.name} title={take.name}>
          <span class="take-label">Take {takeNumber(take.name) ?? '?'}</span>
          <span class="take-length">{formatTime(Math.round(take.durationSeconds))}</span>
          {#if take.endedEarly}<span class="ended-early">Ended early</span>{/if}
          {#if savedNames.has(take.name)}<span class="saved">Saved</span>{/if}
          <a class="save-link" href={take.url} download={take.name} onclick={() => onSave(take)}>Save</a>
          <button
            type="button"
            class="remove-btn"
            aria-label="Remove Take {takeNumber(take.name) ?? '?'} from browser"
            onclick={() => onRemove(take)}
          >Remove</button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .local-copies {
    margin-top: 12px;
    font-size: 12px;
  }

  .local-copies-heading {
    font-weight: 600;
    color: var(--text);
  }

  .local-copies-hint {
    color: var(--muted);
    margin: 2px 0 6px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  li {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .take-length,
  .saved {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .ended-early {
    color: var(--warn-text);
  }

  .save-link {
    margin-left: auto;
    font-weight: 600;
  }

  .remove-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--muted);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
