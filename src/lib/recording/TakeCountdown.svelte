<script>
  export let remaining = 0;
</script>

{#if remaining > 0}
  <div class="take-countdown" data-testid="take-countdown">{remaining}</div>
{/if}

<style>
  .take-countdown {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2.5rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--text);
    background: color-mix(in srgb, var(--surface) 70%, transparent);
    border-radius: 8px;
    pointer-events: none;
    z-index: 2;
  }
</style>
