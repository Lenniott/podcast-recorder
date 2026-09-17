<script>
  // Friend room cap (friend-password-auth ticket 03) — shown instead of the
  // usual "create a new room" banner when a Friend session's create attempt
  // hit the cap (+page.server.js's create action, via
  // $lib/server/friend-room-cap.js). `rooms` arrives already in the single
  // source of truth's own soonest-first order — this component only
  // formats and displays it, never re-sorts or re-derives which rooms are
  // active.
  import { formatRemaining } from "./friend-rooms-full.js";

  export let rooms = [];
</script>

<div class="rooms-full">
  <div class="notice-banner notice-warn">
    Rooms full — up to 3 Friend rooms can be active at once. A new room can
    be created as soon as one of these expires.
  </div>
  <ul class="rooms-full-list">
    {#each rooms as room (room.slug)}
      <li>
        <span class="room-name">{room.name}</span>
        <span class="room-expires"
          >expires in {formatRemaining(room.expiresAt - Date.now())}</span
        >
      </li>
    {/each}
  </ul>
</div>

<style>
  .rooms-full {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .rooms-full-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rooms-full-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border: 1px solid var(--border, rgba(148, 163, 184, 0.2));
    border-radius: var(--radius);
    font-size: 13px;
  }

  .room-name {
    font-weight: 500;
    color: var(--text);
  }

  .room-expires {
    color: var(--muted);
    font-size: 12px;
    flex-shrink: 0;
  }
</style>
