<script>
  import { onMount } from "svelte";
  import { getTheme, toggleTheme } from "./theme.js";

  // Matches the boot script's default in app.html so there's nothing to
  // reconcile on mount in the common case; onMount below still re-reads
  // the real attribute in case a stored preference disagrees.
  let theme = "dark";

  onMount(() => {
    theme = getTheme();
    const onChange = (e) => { theme = e.detail; };
    window.addEventListener("themechange", onChange);
    return () => window.removeEventListener("themechange", onChange);
  });
</script>

<button
  type="button"
  class="btn-ghost btn-icon theme-toggle"
  on:click={() => (theme = toggleTheme())}
  title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
  aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
>
  {theme === "dark" ? "☀️" : "🌙"}
</button>

<style>
  .theme-toggle {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 500;
  }
</style>
