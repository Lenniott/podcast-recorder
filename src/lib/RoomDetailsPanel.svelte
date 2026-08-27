<script>
  import { canShowServerCopyDownload } from "./server-copy-status.js";

  // Presentational extraction of the room page's old <header> block. All
  // state/handlers stay owned by the room page — this component just
  // renders them, so the audio/WS pipeline itself is untouched.
  export let roomName;
  export let slug;
  export let isHostClaim = false;
  export let roomPassword = null;
  export let wsStatus = "disconnected"; // connected | connecting | disconnected
  export let peers = []; // [{ clientId, name, recording, role, serverCopyState, serverCopyPercent }]
  export let clientId = null;
  export let copyLinkDone = false;
  export let onCopyLink = () => {};

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
</script>

<div class="room-details">
  <div class="rd-slug-row">
    <div class="rd-name"><span class="rd-icon">🎙️</span> {roomName}</div>
    <span class="rd-slug">/rec/{slug}</span>
    <button type="button" class="btn-ghost btn-sm" on:click={onCopyLink}>
      {copyLinkDone ? "👍" : "📋"}
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
            {#if canShowServerCopyDownload({ isHost: isHostClaim, state: copyStatus })}
              <a
                class="pill pill-server-copy-download"
                data-testid="server-copy-download"
                href="/rec/{slug}/server-copy/download?clientId={encodeURIComponent(p.clientId)}"
                download
                title="Download {p.name}'s completed server copy"
              >
                ⬇ Download
              </a>
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

<style>
  .room-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rd-name {
    font-size: 15px;
    font-weight: 600;
  }

  .rd-slug-row {
    display: flex;
    align-items: center;
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
    background: rgba(245, 158, 11, 0.18);
    color: #fbbf24;
  }
  .pill-guest {
    background: rgba(148, 163, 184, 0.18);
    color: var(--muted);
  }
  .pill-online {
    background: rgba(34, 197, 94, 0.18);
    color: #86efac;
  }
  .pill-recording {
    background: rgba(239, 68, 68, 0.18);
    color: #fca5a5;
  }
  .pill-offline {
    background: rgba(148, 163, 184, 0.14);
    color: var(--muted);
  }

  /* Server-copy pills use blue/teal tones, never red/green — visually
     distinct from the recording pill's palette so the two are never
     confused for one status. */
  .pill-copy-unavailable {
    background: rgba(148, 163, 184, 0.14);
    color: var(--muted);
  }
  .pill-copy-progress {
    background: rgba(56, 189, 248, 0.18);
    color: #7dd3fc;
  }
  .pill-copy-complete {
    background: rgba(45, 212, 191, 0.18);
    color: #5eead4;
  }
  .pill-copy-failed {
    background: rgba(249, 115, 22, 0.18);
    color: #fdba74;
  }

  /* Host-only download control for a completed server copy — same pill
     footprint as the status pills beside it, just interactive. */
  .pill-server-copy-download {
    background: rgba(45, 212, 191, 0.28);
    color: #5eead4;
    text-decoration: none;
    cursor: pointer;
    border: none;
  }
  .pill-server-copy-download:hover {
    background: rgba(45, 212, 191, 0.4);
  }

  .muted-text {
    font-size: 12px;
    color: var(--muted);
  }
</style>
