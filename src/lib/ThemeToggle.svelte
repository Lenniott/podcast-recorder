<script>
  import { onMount } from "svelte";
  import { Moon, Monitor, Sun } from "$lib/icons";
  import { getMode, cycleMode } from "./theme.js";

  // 'system' is the default and matches the boot script in app.html, so
  // there's nothing to reconcile on mount in the common case; onMount below
  // still re-reads the real value in case a stored preference disagrees.
  let mode = "system";

  const NEXT = { system: "light", light: "dark", dark: "system" };
  const LABEL = { system: "System", light: "Light", dark: "Dark" };

  onMount(() => {
    mode = getMode();
  });

  $: title = `Theme: ${LABEL[mode]} (click for ${LABEL[NEXT[mode]]})`;
</script>

<button
  type="button"
  class="btn-ghost btn-icon theme-toggle"
  on:click={() => (mode = cycleMode())}
  {title}
  aria-label={title}
>
  {#if mode === "system"}
    <Monitor />
  {:else if mode === "light"}
    <Sun />
  {:else}
    <Moon />
  {/if}
</button>

<style>
  .theme-toggle {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 500;
  }
</style>
