<script>
  import { Download02 } from "$lib/icons";

  export let slug;
  export let peers = [];
  export let onClose = () => {};

  let filesLoading = true;
  let filesError = "";
  let filesGroups = [];

  function peerName(id) {
    return peers.find((p) => p.clientId === id)?.name || id;
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

  async function loadFiles() {
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

  loadFiles();
</script>

<div class="files-overlay" data-testid="server-copy-files-modal">
  <div class="files-modal" role="dialog" aria-modal="true" aria-label="Server copy files">
    <div class="files-header">
      <div>
        <h2>Server Copy Files</h2>
        <p>Every recoverable server-side take for this room.</p>
      </div>
      <button type="button" class="btn-ghost btn-sm" on:click={onClose}>Close</button>
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
                    class="dl"
                    data-testid="server-copy-file-download"
                    href={entry.downloadUrl}
                    download
                    aria-label="Download"
                  >
                    <Download02 />
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

<style>
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

  .pill {
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
  }
  .pill-copy-progress {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent-text);
  }
  .pill-copy-complete {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent-text);
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

  :global(html[data-theme="dark"]) .pill-copy-progress,
  :global(html[data-theme="dark"]) .pill-copy-complete {
    background: color-mix(in srgb, var(--accent-text) 18%, transparent);
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
