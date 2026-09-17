/**
 * Friend room cap (friend-password-auth, ticket 03) — the single source of
 * truth for "is the Friend room cap full right now, and if so, which rooms
 * are active and how long until each frees up". Both the create action
 * (`+page.server.js`) and the Rooms-full view it renders work from this
 * function's result; neither re-derives the count or the expiry math for
 * itself — see the epic README's "deep modules, thin interface" note.
 *
 * At most `FRIEND_ROOM_CAP` Friend rooms may be active (non-expired) at
 * once, counted globally — there's no per-Friend identity to count
 * against (one shared `FRIEND_PASSWORD`, see the epic README). Host rooms
 * never count toward this and never appear in its result.
 *
 * Always re-reads `listRooms()` and re-checks `isRoomExpired` at call
 * time — never trusts a count taken earlier in the request/response
 * cycle. That closes the race ticket 03's TDD seam 3 calls out: a room
 * that expires between an earlier read and a create attempt must not
 * wrongly block that attempt.
 */
import { listRooms } from './db.js'
import { isRoomExpired, getFriendRoomMaxAgeMs } from './room-lifetime.js'

export const FRIEND_ROOM_CAP = 3

function activeFriendRooms(env, now) {
  return listRooms().filter((room) => !!room.friend_room && !isRoomExpired(room, now, env))
}

/**
 * `{ full, rooms }` — `rooms` is every currently-active Friend room,
 * soonest-to-expire first, each as `{ slug, name, expiresAt }`. `full` is
 * true once there are `FRIEND_ROOM_CAP` (3) or more of them.
 */
export function getFriendRoomCapStatus(env = process.env, now = Date.now()) {
  const rooms = activeFriendRooms(env, now)
    .map((room) => ({
      slug: room.slug,
      name: room.name,
      expiresAt: room.created_at + getFriendRoomMaxAgeMs(env)
    }))
    .sort((a, b) => a.expiresAt - b.expiresAt)

  return { full: rooms.length >= FRIEND_ROOM_CAP, rooms }
}
