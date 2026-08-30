/**
 * Ping-burst estimator for the offset between this client's Date.now() and
 * the server's Date.now() (offset = serverTime - clientTime at the same
 * physical moment). Used to correct triggerAtMs (server time) into local time.
 */
export function createClockSync({ send }) {
  let offset = 0
  let samples = []
  let seq = 0
  const pending = new Map()

  function syncClock() {
    samples = []
    for (let i = 0; i < 3; i++) {
      const s = ++seq
      const sentAt = Date.now()
      pending.set(s, sentAt)
      send({ type: 'ping', seq: s, sentAt })
    }
  }

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
