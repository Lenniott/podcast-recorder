/**
 * Ping-burst estimator for the offset between this client's Date.now() and
 * the server's Date.now() (offset = serverTime - clientTime at the same
 * physical moment). Used to correct triggerAtMs (server time) into local
 * time for both clap tone injection and Watch Together playback.
 *
 * `send` is injected so this is testable without a real socket — the page
 * passes `room.send`.
 */
export function createClockSync({ send }) {
  let offset = 0
  let samples = []
  let seq = 0
  const pending = new Map() // seq → sentAt (client time)

  /** Ping burst → mean RTT/2 estimate of offset (clap + Watch Together). */
  function syncClock() {
    samples = []
    for (let i = 0; i < 3; i++) {
      const s = ++seq
      const sentAt = Date.now()
      pending.set(s, sentAt)
      send({ type: 'ping', seq: s, sentAt })
    }
  }

  /** Feed every incoming `{ type: 'pong', ... }` message here. */
  function handlePong(msg) {
    const sentAt = pending.get(msg.seq)
    if (sentAt === undefined) return
    pending.delete(msg.seq)
    samples.push(msg.serverReceivedAt - (sentAt + Date.now()) / 2)
    if (samples.length >= 3) {
      offset = samples.reduce((a, b) => a + b) / samples.length
    }
  }

  return {
    syncClock,
    handlePong,
    get offset() { return offset }
  }
}
