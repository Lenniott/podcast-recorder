<script>
  import { turnHighlightSegments } from "$lib/room/turn-highlights.js";

  // The Transcript, rendered as a facet of the right-hand panel rather than
  // as a main-stage Tab (ADR-0008, ticket 06). Read-only, speaker-labeled
  // Turns in server (append) order — there is no path from this component
  // onto tab_text or transcript_line, so nothing typed here could ever
  // reach the room.
  //
  // Deliberately NOT a home for the old per-Turn hover-icon Turn Actions
  // (Definition/Facts/Answer): those are retired by ADR-0008 and deleted in
  // ticket 07. The action surface here is the shared selection popup —
  // highlight any Turn text and RoomTabs.svelte's popup offers Comment plus
  // every configured Custom Prompt, identically to Notes. That works
  // because this component's `turnsEl` is registered as a *selection
  // surface* (see selection-annotations.js's resolveSelectionSurface): one
  // more `{el, tabId}` entry, not a second code path.

  // [{id, speaker, text, at}], in server (append) order — lifted to
  // +page.svelte so the tab strip and this panel read one copy.
  export let lines = [];

  // The Transcript's own Annotations (annotationsByTab[TRANSCRIPT_TAB_ID]),
  // drawn back onto the Turns they were taken from.
  export let annotations = [];

  // bind:turnsEl — the element the popup host registers as a selection
  // surface. It is the whole Turn list rather than one element per Turn, so
  // a highlight that runs across two Turns still resolves to the
  // Transcript instead of falling off the end of the surface and silently
  // offering no popup at all.
  export let turnsEl = null;

  // A Turn is append-only and read-only once it lands (ADR-0002), so its
  // quote can never go stale — this is a straight lookup, not
  // notes-highlights.js's edit-survival re-match (see turn-highlights.js).
  $: turns = turnHighlightSegments(lines, annotations);
</script>

<div class="transcript-facet" data-testid="transcript-facet">
  {#if lines.length === 0}
    <p class="transcript-empty">
      No transcript yet — it will appear here as the conversation happens.
    </p>
  {:else}
    <!-- Iterated over `lines`, not over `turns`: turnHighlightSegments maps
         one-for-one over the lines it was given, so `turns[i]` is always
         this Turn's segments, and the speaker stays read from the Turn
         itself (that function is pure string work and knows nothing about
         speakers). -->
    <ol class="transcript-lines" bind:this={turnsEl} data-testid="transcript-turns">
      {#each lines as line, i (line.id)}
        <li class="transcript-line" data-turn-id={line.id}>
          <!-- The speaker label is part of the surface's DOM but never part
               of a quote: user-select:none keeps it out of
               selection.toString(), so dragging across two Turns cannot
               smuggle "Host"/"Guest" into the Annotation's frozen quote. -->
          <span class="transcript-turn-speaker">{line.speaker}</span>
          <p class="transcript-turn-text">{#each turns[i]?.segments ?? [] as segment, s (s)}{#if segment.ids.length}<mark
                  class="turn-highlight"
                  data-annotation-ids={segment.ids.join(" ")}>{segment.text}</mark
                >{:else}{segment.text}{/if}{/each}</p>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  /* Fills whatever the panel's flex column leaves it and scrolls inside
     that, rather than growing the panel — a long show must not push the
     facet toggle off the top of the panel. */
  .transcript-facet {
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  .transcript-empty {
    color: var(--muted);
    font-size: 13px;
    margin: 0;
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
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .transcript-turn-speaker {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    user-select: none;
  }

  .transcript-turn-text {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text);
    /* A Turn's text is the selectable surface — it must wrap and keep its
       own whitespace exactly as the Notes editor does, so a quote taken
       from it reads back character-for-character. */
    white-space: pre-wrap;
    overflow-wrap: break-word;
    cursor: text;
  }

  /* Unlike the Notes highlight layer, this is a real <mark> inside the
     rendered text — safe here precisely because a Turn is read-only. There
     is no caret to sit behind and no keystroke stream this markup could
     escape into, so the mirror-layer trick notes-highlights needs isn't
     required. */
  .turn-highlight {
    background: color-mix(in srgb, var(--accent) 26%, transparent);
    color: inherit;
    border-radius: 3px;
  }
</style>
