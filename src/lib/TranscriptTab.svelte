<script>
  // The one permanent, uncloseable Transcript Tab's content — read-only,
  // speaker-labeled lines, in the order the server appended them (see
  // ADR-0002: append-only, never last-write-wins). This ticket does not
  // include real speech capture (ticket 03) — lines arrive over the room
  // WS from whatever produces a `transcript_line` message.
  //
  // Deliberately has no `send` prop and no editable control of any kind:
  // there is no UI path from this component back onto the wire, so a
  // hand-edit can never originate here even before room-state-store.js's
  // own refusal is reached.
  export let lines = []; // [{id, speaker, text, at}], in server (append) order
</script>

<div class="transcript-tab" aria-label="Transcript — read-only">
  {#if lines.length === 0}
    <p class="transcript-empty">
      No transcript yet — it will appear here as the conversation happens.
    </p>
  {:else}
    <ol class="transcript-lines">
      {#each lines as line (line.id)}
        <li class="transcript-line">
          <span class="transcript-speaker">{line.speaker}</span>
          <span class="transcript-text">{line.text}</span>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .transcript-tab {
    padding: 16px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    min-height: 80vh;
  }

  .transcript-empty {
    color: var(--muted);
    font-size: 13px;
  }

  .transcript-lines {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .transcript-line {
    display: flex;
    gap: 8px;
    align-items: baseline;
    line-height: 1.5;
  }

  .transcript-speaker {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--accent);
  }

  .transcript-text {
    white-space: pre-wrap;
  }
</style>
