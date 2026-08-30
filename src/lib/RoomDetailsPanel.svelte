<script>
  import { Clipboard, ClipboardCheck, Download02 } from "$lib/icons";
  import { canShowServerCopyDownload } from "./server-copy-status.js";

  // Presentational extraction of the room page's old <header> block. All
  // state/handlers stay owned by the room page — this component just
  // renders them, so the audio/WS pipeline itself is untouched.
  export let slug;
  export let isHostClaim = false;
  export let roomPassword = null;
  export let wsStatus = "disconnected"; // connected | connecting | disconnected
  export let peers = []; // [{ clientId, name, recording, role, serverCopyState, serverCopyPercent }]
  export let clientId = null;
  export let copyLinkDone = false;
  export let onCopyLink = () => {};

  let filesModalOpen = false;
  let filesLoading = false;
  let filesError = "";
  let filesGroups = [];

  const STATUS_LABEL = {
    online: "Online",
    recording: "Recording",
    offline: "Offline",
  };

  function peerStatus(p) {
    if (p.recording) return "recording";
    if (wsStatus !== "connected") return "offline";
    return "online";
  }

  // Server-copy upload is a convenience mirror of the local recording, not
  // the recording itself — kept as a visually separate pill so it's never
  // mistaken for "is this participant's audio safe" (that's `recording`).
  // See $lib/server-copy-status.js for how a peer's state/percent is derived.
  const SERVER_COPY_LABEL = {
    unavailable: "No server copy",
    in_progress: "Server copy",
    complete: "Server copy complete",
    failed: "Server copy failed",
  };

  function serverCopyStatus(p) {
    return p.serverCopyState || "unavailable";
  }

  function serverCopyDownloadLabel(state) {
    return state === "complete" ? "Download" : "Partial";
  }

  function serverCopyDownloadTitle(p, state) {
    return state === "complete"
      ? `Download ${p.name}'s completed server copy`
      : `Download ${p.name}'s partial server copy through the last uploaded chunk`;
  }

  function serverCopyDownloadHref(p) {
    const takeParam = p.serverCopyTakeId ? `&takeId=${encodeURIComponent(p.serverCopyTakeId)}` : "";
    return `/rec/${slug}/server-copy/download?clientId=${encodeURIComponent(p.clientId)}${takeParam}`;
  }

  function peerName(clientId) {
    return peers.find((p) => p.clientId === clientId)?.name || clientId;
  }

  function fileStatusLabel(status) {
    return status === "complete" ? "Complete" : "Partial";
  }

  function fileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  function fileTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function entriesForModal() {
    return filesGroups.map((group) => ({
      ...group,
      entries: group.entries.map((entry, index, all) => ({
        ...entry,
        label: `Take ${all.length - index}`,
      })),
    }));
  }

  async function openFilesModal() {
    filesModalOpen = true;
    filesLoading = true;
    filesError = "";
    try {
      const res = await fetch(`/rec/${slug}/server-copy/files`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not load files");
      filesGroups = Array.isArray(body.groups) ? body.groups : [];
    } catch (e) {
      filesGroups = [];
      filesError = e?.message || "Could not load files";
    } finally {
      filesLoading = false;
    }
  }

  function closeFilesModal() {
    filesModalOpen = false;
  }
</script>

<div class="room-details">
  <div class="rd-slug-row">
    <span class="rd-slug">/rec/{slug}</span>
    <button
      type="button"
      class="btn-ghost btn-sm btn-icon"
      on:click={onCopyLink}
      title={copyLinkDone ? "Copied" : "Copy link"}
      aria-label={copyLinkDone ? "Copied" : "Copy link"}
    >
      {#if copyLinkDone}
        <ClipboardCheck />
      {:else}
        <Clipboard />
      {/if}
    </button>
  </div>

  {#if isHostClaim && roomPassword}
    <div class="rd-password-row">
      <span class="rd-password-label">Password:</span>
      <span class="rd-password-value">{roomPassword}</span>
    </div>
  {/if}
  <div class="rd-slug-row">
    <div class="presence" aria-live="polite">
      {#each peers as p (p.clientId)}
        {@const status = peerStatus(p)}
        {@const copyStatus = serverCopyStatus(p)}
        <div
          class="peer"
          class:peer-you={p.clientId === clientId}
          title={p.name}
        >
          <span class="peer-name">{p.name}</span>
          <div class="peer-status-container">
            <span
              class="pill"
              class:pill-host={p.role === "host"}
              class:pill-guest={p.role !== "host"}
            >
              {p.role === "host" ? "Host" : "Guest"}
            </span>
            <span
              class="pill"
              class:pill-online={status === "online"}
              class:pill-recording={status === "recording"}
              class:pill-offline={status === "offline"}
            >
              {STATUS_LABEL[status]}
            </span>
            <span
              class="pill pill-server-copy"
              class:pill-copy-unavailable={copyStatus === "unavailable"}
              class:pill-copy-progress={copyStatus === "in_progress"}
              class:pill-copy-complete={copyStatus === "complete"}
              class:pill-copy-failed={copyStatus === "failed"}
              title="Server copy is just a convenience mirror of their local recording, not the recording itself. If it never completes, the local file is still safe on their device — ask them to send it another way."
            >
              {SERVER_COPY_LABEL[copyStatus]}{copyStatus === "in_progress" ? ` ${p.serverCopyPercent ?? 0}%` : ""}
            </span>
            {#if canShowServerCopyDownload({ isHost: isHostClaim, state: copyStatus, percent: p.serverCopyPercent ?? 0 })}
              <a
                class="pill pill-server-copy-download"
                data-testid="server-copy-download"
                href={serverCopyDownloadHref(p)}
                download
                title={serverCopyDownloadTitle(p, copyStatus)}
              >
                <Download02 />
                {serverCopyDownloadLabel(copyStatus)}
              </a>
            {/if}
            {#if isHostClaim}
              <button
                type="button"
                class="pill pill-server-copy-files"
                data-testid="server-copy-files"
                on:click={openFilesModal}
                title="Show every server-copy file for this room"
              >
                Files
              </button>
            {/if}
          </div>
        </div>
      {/each}
      {#if peers.length === 0}
        <span class="muted-text">Waiting for guest…</span>
      {/if}
    </div>
  </div>
</div>

{#if filesModalOpen}
  <div class="files-overlay" data-testid="server-copy-files-modal">
    <div class="files-modal" role="dialog" aria-modal="true" aria-label="Server copy files">
      <div class="files-header">
        <div>
          <h2>Server Copy Files</h2>
          <p>Every recoverable server-side take for this room.</p>
        </div>
        <button type="button" class="btn-ghost btn-sm" on:click={closeFilesModal}>Close</button>
      </div>

      {#if filesLoading}
        <div class="files-empty">Loading files…</div>
      {:else if filesError}
        <div class="files-empty">{filesError}</div>
      {:else if filesGroups.length === 0}
        <div class="files-empty">No server-copy files yet.</div>
      {:else}
        <div class="files-groups">
          {#each entriesForModal() as group (group.clientId)}
            <section class="files-group">
              <div class="files-group-title">
                <span>{peerName(group.clientId)}</span>
                <code>{group.clientId}</code>
              </div>
              <div class="files-list">
                {#each group.entries as entry (entry.takeId || "legacy")}
                  <div class="file-row">
                    <div class="file-main">
                      <span class="file-label">{entry.label}</span>
                      <span
                        class="pill"
                        class:pill-copy-complete={entry.status === "complete"}
                        class:pill-copy-progress={entry.status === "partial"}
                      >
                        {fileStatusLabel(entry.status)}
                      </span>
                    </div>
                    <div class="file-meta">
                      <span>{fileSize(entry.byteSize)}</span>
                      <span>{entry.sampleRate} Hz</span>
                      <span>{fileTime(entry.updatedAt)}</span>
                    </div>
                    <a
                      class="pill pill-server-copy-download"
                      data-testid="server-copy-file-download"
                      href={entry.downloadUrl}
                      download
                    >
                      <Download02 />
                      Download
                    </a>
                  </div>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .room-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rd-slug-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    min-height: 24px;
    position: relative;
    z-index: 1;
  }

  .rd-slug {
    font-size: 12px;
    color: var(--muted);
    font-family: monospace;
  }

  .rd-password-row {
    font-size: 12px;
    color: var(--muted);
  }
  .rd-password-value {
    font-family: monospace;
    color: var(--text);
  }

  .presence {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }

  .peer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .peer-status-container {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  .peer-you {
    color: var(--text);
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
  .pill-recording {
    /* --danger-text misses 4.5:1 on an 18% red wash in light; body
       text on that same wash still reads as recording via the tint. */
    background: color-mix(in srgb, var(--danger) 18%, transparent);
    color: var(--text);
  }
  .pill-offline {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: var(--muted);
  }

  /* Server-copy pills stay on the accent/warn tokens (not success/danger)
     so they never share a palette with Online / Recording. */
  .pill-copy-unavailable {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: var(--muted);
  }
  .pill-copy-progress {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent-text);
  }
  .pill-copy-complete {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent-text);
  }
  .pill-copy-failed {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn-text);
  }

  /* Host-only download control for a completed server copy — same pill
     footprint as the status pills beside it, just interactive. */
  .pill-server-copy-download {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--accent-text);
    text-decoration: none;
    cursor: pointer;
    border: 1px solid var(--muted);
  }
  .pill-server-copy-download:hover {
    background: color-mix(in srgb, var(--accent) 34%, transparent);
  }

  .pill-server-copy-files {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: var(--muted);
    cursor: pointer;
    border: 1px solid var(--muted);
  }
  .pill-server-copy-files:hover {
    background: color-mix(in srgb, var(--muted) 28%, transparent);
    color: var(--text);
  }

  :global(html[data-theme="dark"]) .pill-host {
    background: color-mix(in srgb, var(--warn-text) 18%, transparent);
  }
  :global(html[data-theme="dark"]) .pill-guest,
  :global(html[data-theme="dark"]) .pill-offline,
  :global(html[data-theme="dark"]) .pill-copy-unavailable,
  :global(html[data-theme="dark"]) .pill-server-copy-files {
    background: color-mix(in srgb, var(--text) 18%, transparent);
  }
  :global(html[data-theme="dark"]) .pill-online {
    background: color-mix(in srgb, var(--success-text) 18%, transparent);
  }
  :global(html[data-theme="dark"]) .pill-recording {
    background: color-mix(in srgb, var(--danger-text) 18%, transparent);
    color: var(--danger-text);
  }
  :global(html[data-theme="dark"]) .pill-copy-progress,
  :global(html[data-theme="dark"]) .pill-copy-complete,
  :global(html[data-theme="dark"]) .pill-server-copy-download {
    background: color-mix(in srgb, var(--accent-text) 18%, transparent);
  }
  :global(html[data-theme="dark"]) .pill-copy-failed {
    background: color-mix(in srgb, var(--warn-text) 18%, transparent);
  }
  :global(html[data-theme="dark"]) .pill-server-copy-download:hover {
    background: color-mix(in srgb, var(--accent-text) 28%, transparent);
  }
  :global(html[data-theme="dark"]) .pill-server-copy-files:hover {
    background: color-mix(in srgb, var(--text) 28%, transparent);
  }

  .muted-text {
    font-size: 12px;
    color: var(--muted);
  }

  .files-overlay {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px;
    background: rgba(0, 0, 0, 0.7);
  }

  .files-modal {
    width: min(720px, 100%);
    max-height: min(760px, calc(100vh - 36px));
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  }

  .files-header {
    position: sticky;
    top: 0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 16px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .files-header h2 {
    margin: 0;
    font-size: 17px;
    line-height: 1.25;
  }
  .files-header p {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .files-header :global(.btn-ghost) {
    border-color: var(--muted);
  }

  .files-empty {
    padding: 18px 16px;
    color: var(--muted);
    font-size: 13px;
  }

  .files-groups {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 16px 16px;
  }

  .files-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .files-group-title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    font-size: 13px;
    font-weight: 700;
  }
  .files-group-title code {
    overflow: hidden;
    max-width: 54%;
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
    text-overflow: ellipsis;
  }

  .files-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .file-row {
    display: grid;
    grid-template-columns: minmax(120px, 1fr) minmax(180px, auto) auto;
    align-items: center;
    gap: 12px;
    padding: 10px;
    border-top: 1px solid var(--border);
    font-size: 12px;
  }
  .file-row:first-child {
    border-top: none;
  }

  .file-main,
  .file-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .file-label {
    font-weight: 700;
  }
  .file-meta {
    justify-content: flex-end;
    color: var(--muted);
  }

  @media (max-width: 680px) {
    .file-row {
      grid-template-columns: 1fr;
      align-items: flex-start;
    }
    .file-meta {
      justify-content: flex-start;
    }
  }
</style>
