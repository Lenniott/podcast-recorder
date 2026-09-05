<script>
  import SitePasswordGate from "$lib/home/SitePasswordGate.svelte";
  import CreateEpisodeModal from "$lib/home/CreateEpisodeModal.svelte";
  import UsageDashboardStats from "$lib/home/UsageDashboardStats.svelte";
  import ResearchPromptEditor from "$lib/home/ResearchPromptEditor.svelte";
  import { HomeRecorLogo, Plus } from "$lib/icons";
  import { shouldOpenCreateEpisodeModal } from "$lib/home/create-episode-modal.js";

  export let data; // { siteAuthed, siteProtected }
  export let form;
  let openTab = "dashboard";

  let createOpen = shouldOpenCreateEpisodeModal(form);
</script>

<svelte:head>
  <title>Home Recor - Podcast Recorder</title>
</svelte:head>

<main>
  <!-- ── Site password gate ───────────────────────────────────────── -->
  {#if data.siteProtected && !data.siteAuthed}
    <div class="hero">
      <div class="logo-container">
        <HomeRecorLogo size={48} viewBox="0 0 48 48" />
        <div class="logo-text">
          <h1>Home Recor</h1>
          <p class="tagline">Podcast recording helper</p>
        </div>
      </div>
    </div>
    <SitePasswordGate formError={form?.siteError} />
  {:else}
    <div class="main-content">
      <!-- ── Usage Dashboard (see CONTEXT.md) — stats + Research Prompt
         editor are one conceptual section, so they share this card even
         though each half is its own component. ─────────────────────── -->
      <div class="dashboard-card">
        <div class="page-header">
          <div class="logo-container">
            <HomeRecorLogo size={24} />
            <h1>Home Recor</h1>
          </div>
          <div class="page-tabs">
            {#if openTab === "dashboard"}
              <button
                class="btn-secondary btn-sm new-room"
                on:click={() => (openTab = "prompt")}
              >
                Prompt
              </button>
            {:else if openTab === "prompt"}
              <button
                class="btn-secondary btn-sm new-room"
                on:click={() => (openTab = "dashboard")}
              >
                Dashboard
              </button>
            {/if}
            <button
              type="button"
              class="btn-primary btn-sm new-room"
              on:click={() => (createOpen = true)}
            >
              <Plus />
              New room
            </button>
          </div>
        </div>
        {#if data.expired}
          <div class="notice-banner notice-warn">
            That room has expired and is no longer available.
          </div>
        {:else if data.notFound}
          <div class="notice-banner notice-warn">
            Room not found — it may have been deleted.
          </div>
        {/if}
        <div class="page-content">
          {#if data.usageDashboard && openTab === "dashboard"}
            <UsageDashboardStats usageDashboard={data.usageDashboard} />
          {:else if openTab === "prompt"}
            <div class="page-prompt">
              <ResearchPromptEditor
                researchPrompt={form?.researchPrompt ?? data.researchPrompt}
                researchPromptTitle={form?.researchPromptTitle ?? data.researchPromptTitle}
                promptError={form?.promptError}
              />
            </div>
          {:else}
            <div class="notice-banner notice-warn">
              create a new room to get started
            </div>
          {/if}
        </div>
      </div>

      <CreateEpisodeModal
        open={createOpen}
        {form}
        onClose={() => (createOpen = false)}
      />
    </div>
  {/if}
</main>

<style>
  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 20px;
  }
  .main-content {
    width: 100%;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 0 40px 16px 0px;
  }

  .logo-container {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .new-room {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .hero {
    text-align: center;
    margin-bottom: 32px;
  }

  .hero h1 {
    font-size: 24px;
    font-weight: 400;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .hero .tagline {
    color: var(--muted);
    font-size: 14px;
  }

  h1 {
    font-size: 16px;
    font-weight: 400;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .page-tabs {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .notice-banner {
    font-size: 13px;
    padding: 10px 14px;
    border-radius: var(--radius);
    margin-bottom: 16px;
    text-align: center;
  }
  .notice-warn {
    background: rgba(250, 204, 21, 0.1);
    border: 1px solid rgba(250, 204, 21, 0.25);
    color: var(--warn-text);
  }

  .page-content {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 16px;
    min-height: 80vh;
  }

  .page-prompt {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
</style>
