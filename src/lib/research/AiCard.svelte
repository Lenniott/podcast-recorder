<script>
  import { ChevronDown, ChevronUp, XClose } from "$lib/icons";
  import BlockList from "./BlockList.svelte";
  import { parseResearchCard } from "./research-card.js";
  import { dedupeCitationsByHost } from "./research-panel.js";

  // One display module for every Research Assistant result. `row.type`
  // describes its storage/anchor shape; it does not choose a second visual
  // language. The parent retains ownership of the matching remove command.
  export let row;
  export let canRemove = true;
  export let onRemove = () => {};

  let citationsExpanded = false;

  $: anchored = row?.type === "annotation";
  $: status = row?.status || "answered";
  $: parsedCard = !anchored && status === "answered"
    ? parseResearchCard(row?.answer)
    : null;
  $: citations = dedupeCitationsByHost(row?.citations);
</script>

<article
  class="ai-card"
  class:annotation={anchored}
  class:annotation-card={anchored}
  class:research-entry={!anchored}
  data-ai-card="true"
  data-kind={anchored ? row.kind : undefined}
  data-status={status}
  data-testid={anchored ? "annotation" : undefined}
>
  <div class="ai-card-header" class:research-entry-header={!anchored}>
    {#if anchored}
      <blockquote class="annotation-quote">{row.quote}</blockquote>
    {:else}
      <p class="research-question">{row.question}</p>
    {/if}

    {#if canRemove}
      <button
        type="button"
        class="btn-ghost btn-icon btn-sm research-remove"
        aria-label={anchored ? "Remove this annotation" : "Remove this research card"}
        title={anchored ? "Remove this annotation" : "Remove this research card"}
        on:click={onRemove}
      ><XClose /></button>
    {/if}
  </div>

  {#if anchored && row.participantContext}
    <p class="annotation-participant-context" aria-label="Participant context">
      {row.participantContext}
    </p>
  {/if}

  {#if status === "pending"}
    <p
      class="ai-card-pending"
      class:annotation-pending={anchored}
      class:research-pending={!anchored}
      aria-live="polite"
    >
      {anchored ? `Running ${row.author}…` : "Looking this up…"}
    </p>
  {:else if status === "errored"}
    <p
      class="ai-card-error"
      class:annotation-error-text={anchored}
      class:research-error-text={!anchored}
    >{row.error}</p>
  {:else if row.blocks?.length}
    <BlockList blocks={row.blocks} />
  {:else if anchored}
    <p class="annotation-text">{row.text}</p>
  {:else if parsedCard}
    {#if parsedCard.outputType === "custom" || parsedCard.outputType === "ask"}
      <div class="research-interpretation">{parsedCard.mainTakeaway}</div>
    {:else}
      <div class="research-card">
        <p class="research-answer">{parsedCard.mainTakeaway}</p>
      </div>
    {/if}
  {/if}

  <p class="ai-card-author">
    <span class="ai-card-badge annotation-badge" data-testid="ai-card-badge">AI</span>
    {anchored ? row.author : "Research Assistant"}
  </p>

  {#if citations.length}
    <div class="research-citations-container">
      <button
        type="button"
        class="research-citations-toggle"
        aria-label={citationsExpanded ? "Hide citations" : "Show citations"}
        title={citationsExpanded ? "Hide citations" : "Show citations"}
        aria-expanded={citationsExpanded}
        on:click={() => (citationsExpanded = !citationsExpanded)}
      >
        <span class="research-citations-title">Citations</span>
        {#if citationsExpanded}<ChevronUp />{:else}<ChevronDown />{/if}
      </button>
      {#if citationsExpanded}
        <ul class="research-citations">
          {#each citations as citation (citation.host)}
            <li>
              <a href={citation.url} target="_blank" rel="noopener noreferrer">
                {citation.host}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</article>

<style>
  .ai-card {
    width: 100%;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 6%, var(--bg-elevated));
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-wrap: anywhere;
  }

  .ai-card[data-status="pending"] {
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-elevated));
  }

  .ai-card-header {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }

  .annotation-quote,
  .research-question {
    min-width: 0;
    flex: 1;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .annotation-quote {
    padding-left: 8px;
    border-left: 2px solid var(--accent);
    font-style: italic;
  }

  .research-question {
    font-weight: 600;
  }

  .research-remove {
    flex-shrink: 0;
    color: var(--muted);
  }

  .annotation-participant-context {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    color: var(--text);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .annotation-text,
  .research-interpretation,
  .research-answer {
    margin: 0;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .annotation-text {
    font-size: 13px;
  }

  .research-interpretation {
    font-size: 14px;
    line-height: 1.45;
  }

  .research-card {
    margin: 0;
    padding: 0;
  }

  .research-answer {
    font-size: 14px;
    line-height: 1.35;
  }

  .ai-card-pending,
  .ai-card-error {
    margin: 0;
    font-size: 13px;
  }

  .ai-card-pending {
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ai-card-pending::before {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--accent);
    animation: ai-card-pulse 1s ease-in-out infinite;
  }

  .ai-card-error {
    color: var(--danger, #d33);
  }

  @keyframes ai-card-pulse {
    0%, 100% { opacity: 0.35; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1); }
  }

  .ai-card-author {
    margin: 0;
    color: var(--muted);
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ai-card-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 5px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .research-citations-container {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .research-citations-toggle {
    width: 100%;
    margin: 0;
    padding: 4px 6px;
    border: none;
    background: none;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 11px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .research-citations-toggle:hover {
    border-radius: 2px;
    background: var(--bg-elevated);
  }

  .research-citations {
    margin: 0;
    padding: 4px 6px;
    border-radius: 2px;
    background: var(--bg-elevated);
    color: var(--muted);
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
  }

  .research-citations a {
    color: var(--text);
  }
</style>
