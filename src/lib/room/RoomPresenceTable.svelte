<script>
  import {
    formatServerCopyLine,
    canShowServerCopyDownload,
  } from "../server-copy/server-copy-status.js";
  import { participantPresence } from "./participant-display.js";
  import { ChevronDown, ChevronUp, Download02, Microphone02 } from "../icons";

  export let peers = [];
  export let clientId = null;
  export let slug = "";
  export let wsStatus = "disconnected";
  export let isHostClaim = false;
  export let bytesWritten = 0;
  export let formatBytes = (b) => String(b);

  let open = false;

  $: presence = participantPresence(wsStatus);
  $: others = peers.filter((p) => p.clientId !== clientId);
  $: other = others[0] || null;

  function copyLine(peer) {
    return formatServerCopyLine({
      state: peer.serverCopyState || "unavailable",
      percent: peer.serverCopyPercent ?? 0,
    });
  }

  function showDownload(peer) {
    return canShowServerCopyDownload({
      isHost: isHostClaim,
      state: peer.serverCopyState || "unavailable",
      percent: peer.serverCopyPercent ?? 0,
    });
  }

  function downloadHref(peer) {
    const takeParam = peer.serverCopyTakeId
      ? `&takeId=${encodeURIComponent(peer.serverCopyTakeId)}`
      : "";
    return `/rec/${slug}/server-copy/download?clientId=${encodeURIComponent(peer.clientId)}${takeParam}`;
  }
</script>

<section class="presence-table-wrap" class:is-collapsed={!open}>
  <div class="presence-table-wrap-inner">
    <button
      type="button"
      class="fold"
      data-testid="presence-fold"
      aria-expanded={open}
      aria-label={open
        ? "Hide participant details"
        : "Show participant details"}
      on:click={() => (open = !open)}
    >
      {#if other}
        {#if open}<ChevronUp />{:else}<ChevronDown />{/if}
        {#if !open}
          <span class="fold-names">{other.name}</span>
          <span
            class="pill"
            class:pill-online={presence === "online"}
            class:pill-offline={presence !== "online"}
          >
            {presence === "online" ? "Online" : "Offline"}
          </span>
          <span class="pill pill-mic" title={other.micLabel || ""}>
            <Microphone02 />
            {other.micLabel || "—"}
          </span>
          <span
            class="pill pill-recording"
            class:pill-not-recording={!other.recording}
            data-testid="peer-recording"
          >
          {#if other.recording}
            Recording
          {:else}
            Not recording
          {/if}
          </span>
        {:else}
          <span class="fold-names muted">Participant details</span>
        {/if}
      {:else}
        <span class="fold-names muted">Waiting for guest…</span>
      {/if}
      <!-- <span class="fold-hint">{open ? "Hide details" : "Show details"}</span> -->
    </button>
    <slot />
  </div>
  {#if open}
    <div class="table-scroll">
      <table class="presence-table">
        <colgroup>
          <col class="col-name" />
          <col class="col-type" />
          <col class="col-status" />
          <col class="col-mic" />
          <col class="col-size" />
          <col class="col-copy" />
          <col class="col-dl" />
        </colgroup>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th>mic</th>
            <th>size</th>
            <th>Server copy</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each peers as peer (peer.clientId)}
            {@const isSelf = peer.clientId === clientId}
            <tr
              data-testid="presence-row"
              data-recording={peer.recording ? "true" : undefined}
            >
              <td class="name">
                <span class="clamp">{peer.name}{isSelf ? " (you)" : ""}</span>
              </td>
              <td class="type">
                <span
                  class="pill"
                  class:pill-host={peer.role === "host"}
                  class:pill-guest={peer.role !== "host"}
                >
                  {peer.role === "host" ? "Host" : "Guest"}
                </span>
              </td>
              <td class="status">
                <span
                  class="pill"
                  class:pill-online={!peer.recording && presence === "online"}
                  class:pill-offline={!peer.recording && presence !== "online"}
                  class:pill-recording={peer.recording}
                  data-testid={!isSelf && peer.recording
                    ? "peer-recording"
                    : undefined}
                >
                  {peer.recording
                    ? "Recording"
                    : presence === "online"
                      ? "Online"
                      : "Offline"}
                </span>
              </td>
              <td class="mic" title={peer.micLabel || ""}>
                <span class="clamp">{peer.micLabel || "—"}</span>
              </td>
              <td class="size">
                {#if isSelf && bytesWritten > 0}
                  {formatBytes(bytesWritten)}
                {:else}
                  —
                {/if}
              </td>
              <td class="copy">
                <span
                  class="clamp"
                  data-testid="server-copy-line"
                  data-copy-state={peer.serverCopyState || "unavailable"}
                  title="Server copy is a convenience mirror of their local recording, not the recording itself."
                >{copyLine(peer)}</span>
              </td>
              <td class="dl-cell">
                {#if showDownload(peer)}
                  <a
                    class="dl"
                    href={downloadHref(peer)}
                    download
                    data-testid="server-copy-download"
                  >
                    <Download02 />
                  </a>
                {/if}
              </td>
            </tr>
          {/each}
          {#if others.length === 0}
            <tr>
              <td colspan="7" class="empty">Waiting for guest…</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .presence-table-wrap{
    width: 100%;
  }
  .presence-table-wrap-inner {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }
  .fold {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 8px;
    width: 100%;
    justify-content: flex-start;
    padding: 8px 12px;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    min-height: 40px;
  }
  .is-collapsed .fold {
    margin-bottom: 0;
  }
  .presence-table-wrap:not(.is-collapsed) .fold {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom: none;
  }
  .fold-names {
    font-weight: 600;
    flex: 0 1 auto;
    max-width: 28%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fold-names.muted {
    font-weight: 500;
    color: var(--muted);
    max-width: none;
    flex: 1;
  }
  .is-collapsed .table-scroll {
    display: none;
  }
  .presence-table-wrap:not(.is-collapsed) .table-scroll {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
  .table-scroll {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    margin-bottom: 16px;
  }
  .presence-table {
    width: 100%;
    min-width: 52rem;
    table-layout: fixed;
    border-collapse: collapse;
    font-size: 13px;
    line-height: 1.35;
  }
  /* Widths only on <col>; table-layout:fixed ignores cell content. */
  .col-name { width: 14%; }
  .col-type { width: 5.75rem; }
  .col-status { width: 6.75rem; }
  .col-mic { width: 32%; }
  .col-size { width: 5.5rem; }
  .col-copy { width: 9rem; }
  .col-dl { width: 2.75rem; }
  th,
  td {
    text-align: left;
    vertical-align: middle;
    padding: 12px 14px;
    overflow: hidden;
  }
  th {
    padding: 4px 12px;
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.04em;
    color: var(--muted);
    white-space: nowrap;
    border-bottom: 1px solid var(--border);
  }
  td {
    border-bottom: 1px solid var(--border);
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  .name {
    font-weight: 600;
  }
  .mic,
  .copy,
  .size {
    color: var(--muted);
  }
  .clamp {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .copy {
    font-size: 12px;
  }
  .dl-cell {
    padding-left: 8px;
    padding-right: 8px;
  }
  .dl {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    cursor: pointer;
  }
  .dl:hover {
    background: color-mix(in srgb, var(--text) 10%, transparent);
    color: var(--text);
  }
  .empty {
    color: var(--muted);
    font-style: italic;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .pill-host {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn-text);
  }
  .pill-guest {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: var(--muted);
  }
  .pill-online {
    background: color-mix(in srgb, var(--success) 12%, transparent);
    color: var(--success-text);
  }
  .pill-offline {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: var(--muted);
  }
  .pill-recording {
    background: color-mix(in srgb, var(--danger-text) 12%, transparent);
    color: var(--danger-text);
  }
  .pill-not-recording {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: color-mix(in srgb, var(--muted) 90%, transparent);
  }
  .pill-mic {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    color: var(--warn-text);
  }
</style>
