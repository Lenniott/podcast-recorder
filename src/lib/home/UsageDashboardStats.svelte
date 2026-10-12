<script>
  // Totals + per-room breakdown half of the Usage Dashboard (see
  // CONTEXT.md) — the Research Prompt editor is the other half,
  // CustomPromptListEditor.svelte, composed alongside this by the page.
  import {
    filterRooms,
    roomEnterPath,
    formatRoomCreatedAt,
  } from "$lib/home/room-table-filter.js";
  import GuestLockCell from "$lib/home/GuestLockCell.svelte";
  import DeleteRoomButton from "$lib/home/DeleteRoomButton.svelte";

  export let usageDashboard;

  // Client-side filter of the list already loaded with the page. Clearing
  // the box restores every room; it does not refetch.
  let roomQuery = "";
  $: visibleRooms = filterRooms(usageDashboard.rooms, roomQuery);

  function formatCost(cost) {
    return `$${Number(cost || 0).toFixed(4)}`;
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }
</script>

<div class="totals-row">
  <div class="total-tile">
    <span class="total-value">{usageDashboard.totals.calls}</span>
    <span class="total-label">Calls</span>
  </div>
  <div class="total-tile">
    <span class="total-value"
      >{usageDashboard.totals.tokens.toLocaleString()}</span
    >
    <span class="total-label">Tokens</span>
  </div>
  <div class="total-tile">
    <span class="total-value">{formatCost(usageDashboard.totals.cost)}</span>
    <span class="total-label">Cost</span>
  </div>
</div>

<label class="room-search">
  Search rooms
  <input type="text" bind:value={roomQuery} />
</label>

{#if usageDashboard.rooms.length === 0}
  <p class="sub">No rooms yet.</p>
{:else if visibleRooms.length === 0}
  <p class="sub">No rooms match.</p>
{:else}
  <div class="dashboard-table-wrap">
    <table class="dashboard-table">
      <thead>
        <tr>
          <th>Room</th>
          <th>Created</th>
          <th>Guests</th>
          <th>Calls</th>
          <th>Tokens</th>
          <th>Cost</th>
          <th>Recording</th>
          <th>Transcript</th>
          <th>Tabs</th>
          <th>Cards</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each visibleRooms as room (room.slug)}
          <tr>
            <td><a href={roomEnterPath(room.slug)}>{room.name}</a></td>
            <td>{formatRoomCreatedAt(room.createdAt)}</td>
            <td><GuestLockCell slug={room.slug} guestLocked={room.guestLocked} /></td>
            <td>{room.calls}</td>
            <td>{room.tokens.toLocaleString()}</td>
            <td>{formatCost(room.cost)}</td>
            <td>{formatDuration(room.recordingSeconds)}</td>
            <td>{room.transcriptWords.toLocaleString()} words</td>
            <td>{room.tabCount}</td>
            <td>{room.researchCardCount}</td>
            <td><DeleteRoomButton slug={room.slug} roomName={room.name} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .sub {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 24px;
  }

  .totals-row {
    display: flex;
    gap: 16px;
    margin-bottom: 20px;
  }

  .room-search {
    max-width: 320px;
    margin-bottom: 16px;
  }

  .total-tile {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 16px;
    border: 1px solid var(--border, rgba(148, 163, 184, 0.2));
    border-radius: var(--radius);
  }

  .total-value {
    font-size: 20px;
    font-weight: 700;
  }

  .total-label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dashboard-table-wrap {
    overflow-x: auto;
    margin-bottom: 12px;
  }

  .dashboard-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .dashboard-table th,
  .dashboard-table td {
    text-align: left;
    padding: 6px 10px;
    white-space: nowrap;
    border-bottom: 1px solid var(--border, rgba(148, 163, 184, 0.15));
  }

  .dashboard-table th {
    color: var(--muted);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.04em;
  }
</style>
