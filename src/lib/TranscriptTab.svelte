<script>
  import TextBlock from "./TextBlock.svelte";

  // The one permanent, uncloseable Transcript Tab's content — read-only,
  // speaker-labeled Turns (each Turn is a TextBlock). There is no path
  // from this component onto tab_text; a hand-edit cannot originate here.
  export let lines = []; // [{id, speaker, text, at}], in server (append) order
  export let pendingTurnId = null;
  export let pendingActionId = null;
  export let onTurnAction = (_actionId, _turnId) => {};
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
          <TextBlock
            label={line.speaker}
            text={line.text}
            pendingActionId={pendingTurnId === line.id ? pendingActionId : null}
            onAction={(actionId) => onTurnAction(actionId, line.id)}
          />
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
    margin: 0;
    padding: 0;
  }
</style>
