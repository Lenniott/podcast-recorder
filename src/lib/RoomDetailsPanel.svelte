<script>
  // Presentational extraction of the room page's old <header> block. All
  // state/handlers stay owned by the room page — this component just
  // renders them, so the audio/WS pipeline itself is untouched.
  export let roomName;
  export let slug;
  export let isHostClaim = false;
  export let roomPassword = null;
  export let myRole = null; // 'host' | 'guest' | null
  export let wsStatus = "disconnected"; // connected | connecting | disconnected
  export let peers = []; // [{ clientId, name, recording, role }]
  export let clientId = null;
  export let copyLinkDone = false;
  export let onCopyLink = () => {};
</script>

<div class="room-details">
  <div class="rd-name"><span class="rd-icon">🎙️</span> {roomName}</div>
  <div class="rd-slug-row">
    <span class="rd-slug">/rec/{slug}</span>
    <button type="button" class="btn-ghost btn-sm" on:click={onCopyLink}>
      {copyLinkDone ? "Copied!" : "Copy link"}
    </button>
  </div>

  {#if isHostClaim && roomPassword}
    <div class="rd-password-row">
      <span class="rd-password-label">Password:</span>
      <span class="rd-password-value">{roomPassword}</span>
    </div>
  {/if}

  {#if myRole}
    <div class="role-hint" aria-live="polite">
      <span class="role-hint-label">You are</span>
      <span
        class="role-chip role-chip-you"
        class:role-chip-host={myRole === "host"}
        class:role-chip-guest={myRole === "guest"}
      >
        {myRole === "host" ? "Host" : "Guest"}
      </span>
    </div>
  {/if}

  <div class="ws-pill" class:ws-ok={wsStatus === "connected"} class:ws-bad={wsStatus === "disconnected"}>
    <span
      class="dot"
      class:green={wsStatus === "connected"}
      class:yellow={wsStatus === "connecting"}
      class:grey={wsStatus === "disconnected"}
    ></span>
    {wsStatus}
  </div>

  <div class="presence">
    {#each peers as p (p.clientId)}
      <div class="peer" class:peer-you={p.clientId === clientId} title={p.name}>
        <span class="peer-name">{p.name}</span>
        <span
          class="role-tag"
          class:role-host={p.role === "host"}
          class:role-guest={p.role === "guest"}
          class:role-tag-you={p.clientId === clientId}
        >
          {p.role === "host" ? "Host" : "Guest"}
        </span>
        {#if p.recording}
          <span class="rec-dot"></span>
        {/if}
      </div>
    {/each}
    {#if peers.length === 0}
      <span class="muted-text">Waiting for guest…</span>
    {/if}
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

  .role-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }

  .role-chip {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .role-chip-host {
    background: rgba(245, 158, 11, 0.18);
    color: #fbbf24;
  }
  .role-chip-guest {
    background: rgba(148, 163, 184, 0.18);
    color: var(--muted);
  }

  .ws-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 11px;
    text-transform: capitalize;
    border: 1px solid var(--border);
    color: var(--muted);
    width: fit-content;
  }
  .ws-ok { color: #86efac; }
  .ws-bad { color: #fca5a5; }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted);
  }
  .dot.green { background: #22c55e; }
  .dot.yellow { background: #f59e0b; }
  .dot.grey { background: var(--muted); }

  .presence {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .peer {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .peer-you { color: var(--text); }

  .role-tag {
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
  }
  .role-host { background: rgba(245, 158, 11, 0.18); color: #fbbf24; }
  .role-guest { background: rgba(148, 163, 184, 0.18); color: var(--muted); }

  .rec-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ef4444;
  }

  .muted-text {
    font-size: 12px;
    color: var(--muted);
  }
</style>
