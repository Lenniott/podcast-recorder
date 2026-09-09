/**
 * The unsent-Annotation outbox (ADR-0008, ticket 03).
 *
 * AGENTS.md's sync rule: any state that's true locally but not yet known to
 * the server must re-announce itself on every successful connect, via
 * `room.registerResync(fn)`. A submitted Comment is exactly that state for
 * the moment between "the person pressed Comment" and "the server echoed it
 * back" — and `createRoomConnection.send()` silently drops anything handed
 * to it while the socket is down (see room-connection.js), so a Comment
 * typed during a reconnect blip would otherwise vanish with no error and no
 * row in anyone's panel. That is the same shape of failure as the stuck
 * "Recording" pill AGENTS.md tells this story about, so it gets the same
 * fix rather than a hand-rolled one.
 *
 * Pure: no DOM, no timers, no WS — the caller supplies the send function.
 */

export function createAnnotationOutbox() {
  // id -> the exact annotation_create payload we tried to send. Keyed by the
  // client-generated Annotation id (makeAnnotationId), which is what the
  // server echoes back on annotation_entry — that echo is the only proof
  // the room actually has it.
  const pending = new Map()

  /** Records a create as unacknowledged. Call this alongside the send, not
   *  instead of it — an in-flight message is still pending until echoed. */
  function track(payload) {
    if (!payload?.id) return
    pending.set(payload.id, payload)
  }

  /** The server echoed this Annotation back: it is now room state, and
   *  re-sending it on the next reconnect would be pointless noise. */
  function acknowledge(id) {
    pending.delete(id)
  }

  /** Everything still unacknowledged, oldest first (Map keeps insertion
   *  order), so a burst of Comments replays in the order they were typed. */
  function unacknowledged() {
    return [...pending.values()]
  }

  /** Register this with room.registerResync(): re-sends every create the
   *  server hasn't confirmed. Safe to re-send — annotation_create is
   *  idempotent by id (see room-state-store.js's addAnnotation), so a
   *  message that DID land before the socket dropped is answered with the
   *  already-stored entry rather than a duplicate Comment. */
  function resync(send) {
    for (const payload of unacknowledged()) send(payload)
  }

  return { track, acknowledge, unacknowledged, resync }
}
