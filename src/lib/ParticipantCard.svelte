<script>
  import { Download02 } from "$lib/icons";
  import {
    canShowServerCopyDownload,
    formatServerCopyLine,
  } from "./server-copy-status.js";
  import { clampMicLabel, participantPresence } from "./participant-display.js";

  export let peer;
  export let slug = "";
  export let wsStatus = "disconnected";
  export let isHostClaim = false;
  export let isSelf = false;

  $: copyStatus = peer.serverCopyState || "unavailable";
  $: presence = participantPresence(wsStatus);
  $: copyLine = formatServerCopyLine({
    state: copyStatus,
    percent: peer.serverCopyPercent ?? 0,
  });
  $: showDownload = canShowServerCopyDownload({
    isHost: isHostClaim,
    state: copyStatus,
    percent: peer.serverCopyPercent ?? 0,
  });

  function downloadHref() {
    const takeParam = peer.serverCopyTakeId
      ? `&takeId=${encodeURIComponent(peer.serverCopyTakeId)}`
      : "";
    return `/rec/${slug}/server-copy/download?clientId=${encodeURIComponent(peer.clientId)}${takeParam}`;
  }
</script>

<article
  class="peer"
  class:peer-you={isSelf}
  class:peer-compact={!isSelf}
  title={peer.name}
  data-recording={peer.recording ? "true" : undefined}
>
  <div class="who">
    <span class="peer-name">{peer.name}</span>
    <span
      class="pill"
      class:pill-host={peer.role === "host"}
      class:pill-guest={peer.role !== "host"}
    >
      {peer.role === "host" ? "Host" : "Guest"}
    </span>
    <span
      class="pill"
      class:pill-online={presence === "online"}
      class:pill-offline={presence === "offline"}
    >
      {presence === "online" ? "Online" : "Offline"}
    </span>
  </div>

  <div class="copy-row">
    <span
      class="copy-line"
      class:copy-failed={copyStatus === "failed"}
      class:pill-copy-progress={copyStatus === "in_progress"}
      class:pill-copy-complete={copyStatus === "complete"}
      data-testid="server-copy-line"
      data-copy-state={copyStatus}
      title="Server copy is just a convenience mirror of their local recording, not the recording itself. If it never completes, the local file is still safe on their device — ask them to send it another way."
    >
      {copyLine}
    </span>
    {#if showDownload}
      <a
        class="copy-download"
        data-testid="server-copy-download"
        href={downloadHref()}
        download
        title={copyStatus === "complete"
          ? `Download ${peer.name}'s completed server copy`
          : `Download ${peer.name}'s partial server copy through the last uploaded chunk`}
      >
        <Download02 />
        {copyStatus === "complete" ? "Download" : "Partial"}
      </a>
    {/if}
  </div>

  {#if !isSelf}
    <div
      class="mic-name"
      data-testid="peer-mic-label"
      title={peer.micLabel || undefined}
    >
      <span class="mic-k">Mic</span>
      <span class="mic-v">{peer.micLabel ? clampMicLabel(peer.micLabel) : "—"}</span>
    </div>
    {#if peer.recording}
      <div class="rec-line" data-testid="peer-recording">Recording</div>
    {:else}
      <div class="idle-line">Not recording</div>
    {/if}
  {/if}
</article>

<style>
  .peer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .peer-you {
    color: var(--text);
    border-bottom: none;
    padding-bottom: 0;
  }

  .who {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .peer-name {
    font-weight: 600;
    color: inherit;
  }

  .pill {
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
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

  .copy-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
  .copy-line {
    font-size: 11px;
    color: var(--muted);
  }
  .copy-failed {
    color: var(--warn-text);
  }
  .copy-download {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--accent-text);
    text-decoration: underline;
  }

  .mic-name,
  .idle-line {
    font-size: 11px;
    color: var(--muted);
  }
  .mic-name {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-wrap: anywhere;
  }
  .mic-v {
    font-weight: 600;
    color: var(--text);
  }
  .rec-line {
    font-size: 12px;
    font-weight: 600;
    color: var(--danger-text);
  }

  :global(html[data-theme="dark"]) .pill-host {
    background: color-mix(in srgb, var(--warn-text) 18%, transparent);
  }
  :global(html[data-theme="dark"]) .pill-guest,
  :global(html[data-theme="dark"]) .pill-offline {
    background: color-mix(in srgb, var(--text) 18%, transparent);
  }
  :global(html[data-theme="dark"]) .pill-online {
    background: color-mix(in srgb, var(--success-text) 18%, transparent);
  }
</style>
